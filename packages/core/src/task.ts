import type { AgentId, ProjectId, TaskId } from "./ids.js";
import type { Role } from "./permissions.js";

/**
 * Event-sourced tasks with TTL leases (ADR-5). The append-only event log is the
 * source of truth; `TaskProjection` is a fold over it. An agent must hold a live
 * lease to work a task; a crashed agent's lease expires and the task auto-requeues.
 */
export type TaskState =
  | "queued"
  | "leased"
  | "doing"
  | "review"
  | "done"
  | "failed";

export interface Lease {
  readonly agentId: AgentId;
  readonly expiresAt: number; // epoch ms
}

export type TaskEvent =
  | { type: "created"; taskId: TaskId; projectId: ProjectId; title: string; createdBy: string; role?: Role; at: number }
  | { type: "leased"; taskId: TaskId; agentId: AgentId; expiresAt: number; at: number }
  | { type: "progress"; taskId: TaskId; note: string; at: number }
  | { type: "movedToReview"; taskId: TaskId; at: number }
  | { type: "completed"; taskId: TaskId; at: number }
  | { type: "failed"; taskId: TaskId; reason: string; at: number }
  | { type: "leaseExpired"; taskId: TaskId; at: number }
  | { type: "requeued"; taskId: TaskId; at: number };

export interface TaskProjection {
  readonly id: TaskId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly state: TaskState;
  readonly lease?: Lease;
  readonly createdBy: string;
  /** Which crew role this task is assigned to (delegation). */
  readonly assigneeRole?: Role;
  /** Number of times requeued — the coordinator caps this to prevent doom-loops (ADR-4). */
  readonly attempts: number;
  readonly updatedAt: number;
}

/** Fold one event into the running projection. Unknown transitions are ignored (log stays authoritative). */
export function reduceTask(prev: TaskProjection | undefined, ev: TaskEvent): TaskProjection {
  if (ev.type === "created") {
    return {
      id: ev.taskId,
      projectId: ev.projectId,
      title: ev.title,
      state: "queued",
      createdBy: ev.createdBy,
      assigneeRole: ev.role,
      attempts: 0,
      updatedAt: ev.at,
    };
  }
  if (!prev) throw new Error(`event ${ev.type} for unknown task ${ev.taskId}`);
  const base = { ...prev, updatedAt: ev.at };
  switch (ev.type) {
    case "leased":
      return { ...base, state: "leased", lease: { agentId: ev.agentId, expiresAt: ev.expiresAt } };
    case "progress":
      return { ...base, state: "doing" };
    case "movedToReview":
      return { ...base, state: "review" };
    case "completed":
      return { ...base, state: "done", lease: undefined };
    case "failed":
      return { ...base, state: "failed", lease: undefined };
    case "leaseExpired":
      return { ...base, state: "queued", lease: undefined };
    case "requeued":
      return { ...base, state: "queued", lease: undefined, attempts: prev.attempts + 1 };
  }
}

export function replayTask(events: readonly TaskEvent[]): TaskProjection {
  let proj: TaskProjection | undefined;
  for (const ev of events) proj = reduceTask(proj, ev);
  if (!proj) throw new Error("empty event stream");
  return proj;
}

/** Reconciliation on supervisor restart: which leased/doing tasks have gone stale. */
export function isLeaseExpired(task: TaskProjection, now: number): boolean {
  return task.lease !== undefined && task.lease.expiresAt <= now;
}
