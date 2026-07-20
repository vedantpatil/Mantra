import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { type Capability, type Role, agentId, projectId, secretRef, taskId } from "@mantra/core";
import { AgentRunner, type AgentSpec } from "./agent-runner.js";
import { CircuitBreaker, type Pricing } from "./breaker.js";
import type { Confirmer } from "./effector.js";
import { InProcessBus } from "./bus.js";
import { EnvSecretProvider, envRef } from "./secrets-env.js";
import { loadProjectConfig, resolveDualGraph } from "./project-config.js";
import { WorktreeManager } from "./worktree.js";

/**
 * The single execution path for "run one agent on one task in an isolated worktree."
 * Both the CLI and the desktop shell call this — voice/console/CLI all converge here,
 * so behavior and safety are identical regardless of surface (the "one intent router"
 * principle applied to execution). It emits structured events instead of printing, so
 * callers render them however they like (terminal, IPC → UI activity feed).
 */
export type RunEvent =
  | { readonly type: "info"; readonly message: string }
  | { readonly type: "started"; readonly role: Role }
  | { readonly type: "activity" }
  | { readonly type: "effector"; readonly detail: unknown }
  | { readonly type: "warn"; readonly message: string };

export interface RunTaskOptions {
  readonly repoPath: string;
  readonly task: string;
  readonly role: Role;
  readonly model: string;
  readonly budgetUsd: number;
  /** Read-only: deny all writes; the confirmer should also auto-deny. */
  readonly dryRun?: boolean;
  readonly noPush?: boolean;
  readonly noGraph?: boolean;
  readonly keepWorktree?: boolean;
  readonly confirmer: Confirmer;
  readonly onEvent?: (event: RunEvent) => void;
}

export interface RunTaskResult {
  readonly ok: boolean;
  readonly sessionId: string;
  readonly costUsd: number;
  readonly stopReason: "completed" | "breaker" | "error";
  readonly tripped?: string;
  readonly diffStat: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly finalText: string;
  readonly error?: string;
}

const PRICING: Readonly<Record<string, Pricing>> = {
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
};
const pricingFor = (model: string): Pricing => PRICING[model] ?? { inputPerMTok: 3, outputPerMTok: 15 };
const WRITE_CAPS: readonly Capability[] = ["editCode", "editTests", "gitPush", "sshDeploy", "dbMutate", "fsDelete"];

export function isGitRepo(path: string): boolean {
  try {
    execFileSync("git", ["-C", path, "rev-parse", "--is-inside-work-tree"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export async function runAgentTask(opts: RunTaskOptions): Promise<RunTaskResult> {
  const emit = (e: RunEvent): void => opts.onEvent?.(e);
  const name = basename(opts.repoPath);
  const pid = projectId(name);
  const empty = { sessionId: "", costUsd: 0, diffStat: "", worktreePath: "", branch: "", finalText: "" };

  if (!isGitRepo(opts.repoPath)) {
    return { ...empty, ok: false, stopReason: "error", error: `${opts.repoPath} is not a git repository` };
  }

  const config = loadProjectConfig(opts.repoPath, name);
  const apiKeyRef = config.apiKeyRef ? secretRef(config.apiKeyRef) : envRef("ANTHROPIC_API_KEY");
  const secrets = new EnvSecretProvider();
  try {
    await secrets.resolve(apiKeyRef);
  } catch {
    return { ...empty, ok: false, stopReason: "error", error: "ANTHROPIC_API_KEY is not set" };
  }

  const denyCapabilities: Capability[] = [];
  if (opts.dryRun) denyCapabilities.push(...WRITE_CAPS);
  else if (opts.noPush) denyCapabilities.push("gitPush");

  const dualGraph = resolveDualGraph(config, opts.repoPath, opts.noGraph ?? false);
  if (!dualGraph && !opts.noGraph && config.dualGraph.enabled) {
    emit({ type: "warn", message: "dual-graph command not found — running without it (more tokens)" });
  }
  const budget = Math.min(opts.budgetUsd, config.dailyBudget || opts.budgetUsd);

  const bus = new InProcessBus();
  bus.subscribe(`agent.${pid}.started`, () => emit({ type: "started", role: opts.role }));
  bus.subscribe(`agent.${pid}.activity`, () => emit({ type: "activity" }));
  bus.subscribe(`agent.${pid}.effector`, (m) => emit({ type: "effector", detail: m.payload }));

  const worktrees = new WorktreeManager(opts.repoPath);
  const tid = taskId(`run-${Date.now()}`);
  const wt = await worktrees.create(tid);
  emit({ type: "info", message: `worktree ${wt.path} (${wt.branch}) · model ${opts.model} · budget $${budget} · dual-graph ${dualGraph ? "on" : "off"}${denyCapabilities.length ? ` · denied ${denyCapabilities.join(",")}` : ""}` });

  let tripped: string | undefined;
  const breaker = new CircuitBreaker({
    capUsd: budget,
    pricing: pricingFor(opts.model),
    onTrip: (reason, detail) => (tripped = `${reason}: ${detail}`),
  });

  const runner = new AgentRunner({ bus, secrets, confirmer: opts.confirmer });
  const spec: AgentSpec = {
    id: agentId(`${tid}-${opts.role}`),
    projectId: pid,
    role: opts.role,
    model: opts.model,
    worktreePath: wt.path,
    apiKeyRef,
    denyCapabilities,
    ...(dualGraph ? { dualGraph } : {}),
  };

  try {
    const result = await runner.run(spec, opts.task, breaker);
    const diffStat = execFileSync("git", ["-C", wt.path, "--no-pager", "diff", "--stat"], { encoding: "utf8" }).trim();
    return {
      ok: true, sessionId: result.sessionId, costUsd: result.costUsd, stopReason: result.stopReason,
      tripped, diffStat, worktreePath: wt.path, branch: wt.branch, finalText: result.finalText,
    };
  } catch (e) {
    return {
      ...empty, ok: false, stopReason: "error", worktreePath: wt.path, branch: wt.branch,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    if (!opts.keepWorktree) await worktrees.remove(tid).catch(() => {});
  }
}
