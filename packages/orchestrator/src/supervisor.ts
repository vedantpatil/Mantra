import {
  type AgentId,
  type ProjectId,
  type Role,
  type TaskEvent,
  type TaskId,
  type TaskProjection,
  type TaskState,
  isLeaseExpired,
  reduceTask,
} from "@mantra/core";
import type { Bus } from "./bus.js";
import type { TaskEventSink } from "./task-log.js";

/** Default task lease duration — a crashed agent's task requeues after this (ADR-5). */
const LEASE_MS = 5 * 60_000;

/**
 * One Supervisor per project (Tier-1). Owns this project's append-only task log and
 * its projections, leases work to agents, and — critically — reconciles on restart:
 * any task whose lease has expired is requeued so no work is silently orphaned.
 *
 * MVP keeps the log in memory; it persists to the repo's `.mantra/state/` in P1+.
 */
export class Supervisor {
  private readonly log: TaskEvent[] = [];
  private readonly tasks = new Map<TaskId, TaskProjection>();

  constructor(
    readonly projectId: ProjectId,
    private readonly bus: Bus,
    private readonly now: () => number = () => Date.now(),
    /** Optional durable log; when present, every applied event is persisted (ADR-5). */
    private readonly sink?: TaskEventSink,
  ) {}

  /** Rebuild in-memory state from a replayed log — no publish, no re-persist. */
  hydrate(events: readonly TaskEvent[]): void {
    for (const event of events) {
      this.log.push(event);
      this.tasks.set(event.taskId, reduceTask(this.tasks.get(event.taskId), event));
    }
  }

  private apply(event: TaskEvent): TaskProjection {
    this.log.push(event);
    const next = reduceTask(this.tasks.get(event.taskId), event);
    this.tasks.set(event.taskId, next);
    this.sink?.append(event);
    void this.bus.publish(`task.${this.projectId}`, event);
    return next;
  }

  createTask(id: TaskId, title: string, createdBy: string, role?: Role): TaskProjection {
    return this.apply({
      type: "created",
      taskId: id,
      projectId: this.projectId,
      title,
      createdBy,
      ...(role ? { role } : {}),
      at: this.now(),
    });
  }

  /** An agent claims a queued task; returns false if it is not claimable. */
  lease(id: TaskId, agentId: AgentId): boolean {
    const task = this.tasks.get(id);
    if (!task || task.state !== "queued") return false;
    this.apply({ type: "leased", taskId: id, agentId, expiresAt: this.now() + LEASE_MS, at: this.now() });
    return true;
  }

  /** Record that work is underway (leased → doing). */
  progress(id: TaskId, note: string): void {
    this.apply({ type: "progress", taskId: id, note, at: this.now() });
  }

  /** Hand a finished task to the human review gate (→ review). */
  toReview(id: TaskId): void {
    this.apply({ type: "movedToReview", taskId: id, at: this.now() });
  }

  /** Approve at the review gate (review → done) — the human's call (FR-14). */
  approve(id: TaskId): void {
    this.apply({ type: "completed", taskId: id, at: this.now() });
  }

  complete(id: TaskId): void {
    this.apply({ type: "completed", taskId: id, at: this.now() });
  }

  fail(id: TaskId, reason: string): void {
    this.apply({ type: "failed", taskId: id, reason, at: this.now() });
  }

  /** Send a task back to the queue (e.g. QA rejected it); bumps the attempt count. */
  requeue(id: TaskId): void {
    this.apply({ type: "requeued", taskId: id, at: this.now() });
  }

  /** The oldest queued task, optionally filtered to a role — the scheduler's pull point. */
  nextQueued(role?: Role): TaskProjection | undefined {
    let best: TaskProjection | undefined;
    for (const t of this.tasks.values()) {
      if (t.state !== "queued") continue;
      if (role && t.assigneeRole !== role) continue;
      if (!best || t.updatedAt < best.updatedAt) best = t;
    }
    return best;
  }

  tasksInState(state: TaskState): readonly TaskProjection[] {
    return [...this.tasks.values()].filter((t) => t.state === state);
  }

  /** Restart reconciliation (ADR-5): requeue every task whose lease has expired. */
  reconcile(): readonly TaskId[] {
    const requeued: TaskId[] = [];
    for (const task of this.tasks.values()) {
      if (isLeaseExpired(task, this.now())) {
        this.apply({ type: "leaseExpired", taskId: task.id, at: this.now() });
        requeued.push(task.id);
      }
    }
    return requeued;
  }

  snapshot(): readonly TaskProjection[] {
    return [...this.tasks.values()];
  }
}
