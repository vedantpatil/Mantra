import type { Role, TaskProjection } from "@mantra/core";
import type { ExecOutcome, TaskExecutor } from "./coordinator.js";
import type { Confirmer } from "./effector.js";
import { type AuthMode, type RunEvent, runAgentTask } from "./run-task.js";

/**
 * Live crew executor: each task is run by a real specialist agent (its assignee role) in
 * an isolated worktree, via the same `runAgentTask` pipeline the CLI and desktop use. The
 * Coordinator stays deterministic; only the per-task work is delegated to an agent.
 */
export interface AgentExecutorConfig {
  readonly repoPath: string;
  readonly model: string;
  readonly budgetUsd: number;
  readonly confirmer: Confirmer;
  readonly noPush?: boolean;
  readonly noGraph?: boolean;
  readonly authMode?: AuthMode;
  readonly onRunEvent?: (task: TaskProjection, event: RunEvent) => void;
}

export class AgentExecutor implements TaskExecutor {
  constructor(private readonly config: AgentExecutorConfig) {}

  async execute(task: TaskProjection): Promise<ExecOutcome> {
    const role: Role = task.assigneeRole ?? "developer";
    const result = await runAgentTask({
      repoPath: this.config.repoPath,
      task: task.title,
      role,
      model: this.config.model,
      budgetUsd: this.config.budgetUsd,
      noPush: this.config.noPush ?? true,
      noGraph: this.config.noGraph ?? false,
      authMode: this.config.authMode,
      keepWorktree: true, // keep each task's worktree for the review gate
      confirmer: this.config.confirmer,
      onEvent: (e) => this.config.onRunEvent?.(task, e),
    });
    return {
      ok: result.ok && result.stopReason === "completed",
      note: result.ok ? `${result.stopReason} · $${result.costUsd.toFixed(4)}${result.diffStat ? ` · ${result.diffStat.split("\n").pop()}` : ""}` : (result.error ?? "failed"),
    };
  }
}
