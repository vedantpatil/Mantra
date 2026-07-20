import { type Role, type TaskProjection, agentId, taskId } from "@mantra/core";
import type { Supervisor } from "./supervisor.js";

/**
 * P2 crew coordination (FR-9/10, ADR-5/8). The Supervisor owns the task state machine;
 * the Coordinator is a deterministic scheduler over it. The Manager's decomposition is
 * DATA (a task list) the Coordinator enqueues — no LLM directly commands another LLM.
 *
 * Handoffs happen through the queue (state transitions), never blocking waits, so the
 * crew cannot deadlock. Each scheduler step either advances a task to review/failed or
 * requeues it with attempts+1; a maxAttempts cap guarantees termination (no doom-loops).
 * Human approval is out-of-band: finished work lands in `review` and stays there until a
 * human approves it (ADR-8) — the Coordinator never self-approves.
 */

/** One unit of a decomposed goal, assigned to a crew role. */
export interface PlannedTask {
  readonly title: string;
  readonly role: Role;
}

/** Turns a goal into an ordered task list (the Manager's job). */
export interface Planner {
  decompose(goal: string): Promise<readonly PlannedTask[]>;
}

export interface ExecOutcome {
  readonly ok: boolean;
  readonly note: string;
}

/** Does the actual work for a task (a specialist agent in its worktree). */
export interface TaskExecutor {
  execute(task: TaskProjection): Promise<ExecOutcome>;
}

/** QA gate: verifies a developer task before it reaches human review. */
export interface Verifier {
  verify(task: TaskProjection): Promise<{ readonly pass: boolean; readonly note: string }>;
}

export type CrewEvent =
  | { readonly type: "planned"; readonly count: number }
  | { readonly type: "executed"; readonly title: string; readonly ok: boolean; readonly note: string }
  | { readonly type: "verified"; readonly title: string; readonly pass: boolean; readonly note: string }
  | { readonly type: "review"; readonly title: string }
  | { readonly type: "requeued"; readonly title: string; readonly attempt: number }
  | { readonly type: "failed"; readonly title: string; readonly reason: string };

export interface CoordinatorOptions {
  /** Doom-loop cap: a task requeued this many times is failed and escalated (default 2). */
  readonly maxAttempts?: number;
  /** Optional QA gate applied to developer tasks before review. */
  readonly verify?: Verifier;
  readonly onEvent?: (event: CrewEvent) => void;
}

export interface CrewResult {
  readonly review: readonly TaskProjection[];
  readonly failed: readonly TaskProjection[];
}

export class Coordinator {
  private readonly maxAttempts: number;

  constructor(
    private readonly supervisor: Supervisor,
    private readonly planner: Planner,
    private readonly executor: TaskExecutor,
    private readonly opts: CoordinatorOptions = {},
  ) {
    this.maxAttempts = opts.maxAttempts ?? 2;
  }

  private emit(event: CrewEvent): void {
    this.opts.onEvent?.(event);
  }

  /** Decompose a goal, enqueue the tasks, and drive them through the crew to the review gate. */
  async runGoal(goal: string, createdBy: string): Promise<CrewResult> {
    const planned = await this.planner.decompose(goal);
    this.emit({ type: "planned", count: planned.length });
    let seq = 0;
    for (const p of planned) {
      this.supervisor.createTask(taskId(`t-${Date.now()}-${seq++}`), p.title, createdBy, p.role);
    }
    await this.schedule();
    return {
      review: this.supervisor.tasksInState("review"),
      failed: this.supervisor.tasksInState("failed"),
    };
  }

  /** Pull-and-run scheduler. Provably terminates: every iteration removes a task from the
   *  queue (to review/failed) or requeues it with attempts+1, bounded by maxAttempts. */
  private async schedule(): Promise<void> {
    for (let task = this.supervisor.nextQueued(); task; task = this.supervisor.nextQueued()) {
      if (task.attempts >= this.maxAttempts) {
        this.supervisor.fail(task.id, `exceeded ${this.maxAttempts} attempts`);
        this.emit({ type: "failed", title: task.title, reason: "max attempts" });
        continue;
      }

      const role: Role = task.assigneeRole ?? "developer";
      this.supervisor.lease(task.id, agentId(`${role}-worker`));
      this.supervisor.progress(task.id, "executing");

      const outcome = await this.executor.execute(task);
      this.emit({ type: "executed", title: task.title, ok: outcome.ok, note: outcome.note });
      if (!outcome.ok) {
        this.supervisor.requeue(task.id);
        this.emit({ type: "requeued", title: task.title, attempt: task.attempts + 1 });
        continue;
      }

      if (this.opts.verify && role === "developer") {
        const v = await this.opts.verify.verify(task);
        this.emit({ type: "verified", title: task.title, pass: v.pass, note: v.note });
        if (!v.pass) {
          this.supervisor.requeue(task.id);
          this.emit({ type: "requeued", title: task.title, attempt: task.attempts + 1 });
          continue;
        }
      }

      this.supervisor.toReview(task.id);
      this.emit({ type: "review", title: task.title });
    }
  }
}

/**
 * Default decomposition when no Manager agent is wired: one Developer task for the goal
 * plus a QA task. Real projects use an agent-backed Planner (Manager decomposition).
 */
export class HeuristicPlanner implements Planner {
  async decompose(goal: string): Promise<readonly PlannedTask[]> {
    return [
      { title: `Implement: ${goal}`, role: "developer" },
      { title: `Verify: ${goal}`, role: "qa" },
    ];
  }
}
