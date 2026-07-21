import { basename } from "node:path";
import { projectId, secretRef } from "@mantra/core";
import { AgentExecutor } from "./agent-executor.js";
import { AgentPlanner } from "./agent-planner.js";
import { type CrewEvent, Coordinator, type Planner } from "./coordinator.js";
import type { Confirmer } from "./effector.js";
import { loadProjectConfig } from "./project-config.js";
import { type AuthMode, type RunEvent, isGitRepo } from "./run-task.js";
import { envRef } from "./secrets-env.js";
import { defaultSecretProvider } from "./vault.js";
import { FileTaskLog } from "./task-log.js";
import { Supervisor } from "./supervisor.js";
import { InProcessBus } from "./bus.js";

/**
 * Live crew run (P2): decompose a goal, then drive the tasks through the crew to the
 * review gate. Assembles a Supervisor (persisting its task log under `.mantra/state/`
 * so the crew is resumable), a Coordinator, and an AgentExecutor over `runAgentTask`.
 * Both the CLI and desktop drive this — same coordination, same safety, every surface.
 */
export interface RunCrewOptions {
  readonly repoPath: string;
  readonly goal: string;
  readonly model: string;
  readonly budgetUsd: number;
  readonly noPush?: boolean;
  readonly noGraph?: boolean;
  /** Auth strategy; defaults to "apiKey" for backward compatibility (CLI). */
  readonly authMode?: AuthMode;
  readonly confirmer: Confirmer;
  readonly planner?: Planner;
  readonly onCrewEvent?: (event: CrewEvent) => void;
  readonly onRunEvent?: (title: string, event: RunEvent) => void;
}

export interface RunCrewResult {
  readonly ok: boolean;
  readonly reviewTitles: readonly string[];
  readonly failedTitles: readonly string[];
  readonly error?: string;
}

export async function runCrew(opts: RunCrewOptions): Promise<RunCrewResult> {
  if (!isGitRepo(opts.repoPath)) {
    return { ok: false, reviewTitles: [], failedTitles: [], error: `${opts.repoPath} is not a git repository` };
  }
  const name = basename(opts.repoPath);
  const config = loadProjectConfig(opts.repoPath, name);
  // Subscription mode needs no key; only validate one when we're actually going to inject it.
  if (opts.authMode !== "subscription") {
    const apiKeyRef = config.apiKeyRef ? secretRef(config.apiKeyRef) : envRef("ANTHROPIC_API_KEY");
    try {
      await defaultSecretProvider().resolve(apiKeyRef);
    } catch {
      return { ok: false, reviewTitles: [], failedTitles: [], error: "ANTHROPIC_API_KEY is not set" };
    }
  }

  const sink = new FileTaskLog(opts.repoPath); // resumable crew state under .mantra/state/
  const supervisor = new Supervisor(projectId(name), new InProcessBus(), () => Date.now(), sink);
  supervisor.hydrate(sink.replay()); // resume any prior crew run for this repo
  supervisor.reconcile();

  const executor = new AgentExecutor({
    repoPath: opts.repoPath,
    model: opts.model,
    budgetUsd: opts.budgetUsd,
    confirmer: opts.confirmer,
    noPush: opts.noPush ?? true,
    noGraph: opts.noGraph ?? false,
    authMode: opts.authMode,
    onRunEvent: (task, e) => opts.onRunEvent?.(task.title, e),
  });

  const planner =
    opts.planner ??
    new AgentPlanner({
      repoPath: opts.repoPath,
      model: opts.model,
      budgetUsd: opts.budgetUsd,
      confirmer: opts.confirmer,
      noGraph: opts.noGraph,
      authMode: opts.authMode,
      onRunEvent: (e) => opts.onRunEvent?.("Manager planning", e),
    });
  const coordinator = new Coordinator(supervisor, planner, executor, { onEvent: opts.onCrewEvent });

  try {
    const result = await coordinator.runGoal(opts.goal, "operator");
    return {
      ok: true,
      reviewTitles: result.review.map((t) => t.title),
      failedTitles: result.failed.map((t) => t.title),
    };
  } catch (e) {
    return { ok: false, reviewTitles: [], failedTitles: [], error: e instanceof Error ? e.message : String(e) };
  }
}
