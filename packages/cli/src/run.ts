import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";
import {
  type Capability,
  type Role,
  agentId,
  projectId,
  secretRef,
  taskId as makeTaskId,
} from "@mantra/core";
import {
  AgentRunner,
  type AgentSpec,
  CircuitBreaker,
  EnvSecretProvider,
  InProcessBus,
  type Pricing,
  WorktreeManager,
  envRef,
  loadProjectConfig,
  resolveDualGraph,
} from "@mantra/orchestrator";
import { DenyConfirmer, StdinConfirmer } from "./confirmers.js";

export interface RunFlags {
  readonly role: Role;
  readonly model: string;
  readonly budget: number;
  readonly noPush: boolean;
  readonly noGraph: boolean;
  readonly dryRun: boolean;
  readonly keep: boolean;
}

/** Rough USD/MTok by model for the breaker; unknown models fall back to Sonnet-ish rates. */
const PRICING: Readonly<Record<string, Pricing>> = {
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
};
const pricingFor = (model: string): Pricing => PRICING[model] ?? { inputPerMTok: 3, outputPerMTok: 15 };

const WRITE_CAPS: readonly Capability[] = ["editCode", "editTests", "gitPush", "sshDeploy", "dbMutate", "fsDelete"];

function isGitRepo(path: string): boolean {
  try {
    execFileSync("git", ["-C", path, "rev-parse", "--is-inside-work-tree"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export async function runCommand(repoArg: string, task: string, flags: RunFlags): Promise<number> {
  const repoPath = resolve(repoArg);
  const name = basename(repoPath);

  if (!isGitRepo(repoPath)) {
    console.error(`✗ ${repoPath} is not a git repository. Clone a throwaway copy first.`);
    return 1;
  }

  const config = loadProjectConfig(repoPath, name);
  const apiKeyRef = config.apiKeyRef ? secretRef(config.apiKeyRef) : envRef("ANTHROPIC_API_KEY");
  const secrets = new EnvSecretProvider();
  try {
    await secrets.resolve(apiKeyRef); // fail fast if the key isn't set
  } catch {
    console.error("✗ ANTHROPIC_API_KEY is not set. Export it (or set apiKeyRef in .mantra/config.json).");
    return 1;
  }

  // Extra lockdown beyond the role matrix (safe first tests).
  const denyCapabilities: Capability[] = [];
  if (flags.dryRun) denyCapabilities.push(...WRITE_CAPS);
  else if (flags.noPush) denyCapabilities.push("gitPush");

  const dualGraph = resolveDualGraph(config, repoPath, flags.noGraph);
  if (!dualGraph && !flags.noGraph && config.dualGraph.enabled) {
    console.warn(
      "⚠ dual-graph command not found — running without it (agents will grep, costing more tokens).\n" +
      "  Set MANTRA_DUAL_GRAPH_COMMAND, or dualGraph.command in .mantra/config.json,\n" +
      "  or install to ~/.dual-graph/venv/bin/mcp-graph-server.",
    );
  }
  const budget = Math.min(flags.budget, config.dailyBudget || flags.budget);

  const bus = new InProcessBus();
  const pid = projectId(name);
  bus.subscribe(`agent.${pid}.started`, () => console.log(`▸ ${flags.role} started (cwd = worktree)`));
  bus.subscribe(`agent.${pid}.activity`, () => {
    process.stdout.write("·");
  });
  bus.subscribe(`agent.${pid}.effector`, (m) => console.log(`\n[effector] ${JSON.stringify(m.payload)}`));

  const worktrees = new WorktreeManager(repoPath);
  const tid = makeTaskId(`cli-${Date.now()}`);
  const wt = await worktrees.create(tid);
  console.log(`▸ worktree: ${wt.path} (branch ${wt.branch})`);
  console.log(`▸ model ${flags.model} · budget cap $${budget} · dual-graph ${dualGraph ? "on" : "off"}` +
    (denyCapabilities.length ? ` · denied: ${denyCapabilities.join(",")}` : ""));

  let tripped: string | undefined;
  const breaker = new CircuitBreaker({
    capUsd: budget,
    pricing: pricingFor(flags.model),
    onTrip: (reason, detail) => (tripped = `${reason}: ${detail}`),
  });

  const runner = new AgentRunner({
    bus,
    secrets,
    confirmer: flags.dryRun ? new DenyConfirmer() : new StdinConfirmer(),
  });

  const spec: AgentSpec = {
    id: agentId(`${tid}-${flags.role}`),
    projectId: pid,
    role: flags.role,
    model: flags.model,
    worktreePath: wt.path,
    apiKeyRef,
    denyCapabilities,
    ...(dualGraph ? { dualGraph } : {}),
  };

  console.log(`\n▸ task: ${task}\n`);
  let exitCode = 0;
  try {
    const result = await runner.run(spec, task, breaker);
    console.log(`\n\n▸ done · session ${result.sessionId || "(none)"} · cost $${result.costUsd.toFixed(4)} · ${result.stopReason}`);
    if (tripped) console.log(`⚠ circuit breaker tripped — ${tripped}`);

    // Show the diff the agent produced, for human review (the review gate).
    const diff = execFileSync("git", ["-C", wt.path, "--no-pager", "diff", "--stat"], { encoding: "utf8" });
    console.log(diff.trim() ? `\n▸ changes in worktree:\n${diff}` : "\n▸ no file changes.");
    console.log(`\nReview: git -C ${wt.path} diff`);
  } catch (e) {
    console.error(`\n✗ run failed: ${e instanceof Error ? e.message : String(e)}`);
    exitCode = 1;
  } finally {
    if (flags.keep) {
      console.log(`\n▸ worktree kept at ${wt.path} (remove: git -C ${repoPath} worktree remove --force ${wt.path})`);
    } else {
      await worktrees.remove(tid).catch(() => {});
      console.log("\n▸ worktree removed (use --keep to inspect changes).");
    }
  }
  return exitCode;
}
