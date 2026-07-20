import {
  type AgentId,
  type ProjectId,
  type TaskEvent,
  type TaskId,
  type TaskProjection,
  isLeaseExpired,
  reduceTask,
} from "@mantra/core";
import type { Bus } from "./bus.js";

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
  ) {}

  private apply(event: TaskEvent): TaskProjection {
    this.log.push(event);
    const next = reduceTask(this.tasks.get(event.taskId), event);
    this.tasks.set(event.taskId, next);
    void this.bus.publish(`task.${this.projectId}`, event);
    return next;
  }

  createTask(id: TaskId, title: string, createdBy: string): TaskProjection {
    return this.apply({
      type: "created",
      taskId: id,
      projectId: this.projectId,
      title,
      createdBy,
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

  complete(id: TaskId): void {
    this.apply({ type: "completed", taskId: id, at: this.now() });
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
