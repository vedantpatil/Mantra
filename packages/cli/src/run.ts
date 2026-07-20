import { resolve } from "node:path";
import type { Role } from "@mantra/core";
import { type RunEvent, runAgentTask } from "@mantra/orchestrator";
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

/** Terminal renderer over the shared run pipeline. The desktop shell renders the same events. */
export async function runCommand(repoArg: string, task: string, flags: RunFlags): Promise<number> {
  const repoPath = resolve(repoArg);

  const onEvent = (e: RunEvent): void => {
    switch (e.type) {
      case "info": console.log(`▸ ${e.message}`); break;
      case "warn": console.warn(`⚠ ${e.message}`); break;
      case "started": console.log(`▸ ${e.role} started (cwd = worktree)`); break;
      case "activity": process.stdout.write("·"); break;
      case "effector": console.log(`\n[effector] ${JSON.stringify(e.detail)}`); break;
    }
  };

  console.log(`\n▸ task: ${task}\n`);
  const result = await runAgentTask({
    repoPath, task,
    role: flags.role, model: flags.model, budgetUsd: flags.budget,
    dryRun: flags.dryRun, noPush: flags.noPush, noGraph: flags.noGraph, keepWorktree: flags.keep,
    confirmer: flags.dryRun ? new DenyConfirmer() : new StdinConfirmer(),
    onEvent,
  });

  if (!result.ok) {
    console.error(`\n✗ ${result.error}`);
    return 1;
  }
  console.log(`\n\n▸ done · session ${result.sessionId || "(none)"} · cost $${result.costUsd.toFixed(4)} · ${result.stopReason}`);
  if (result.tripped) console.log(`⚠ circuit breaker tripped — ${result.tripped}`);
  console.log(result.diffStat ? `\n▸ changes:\n${result.diffStat}` : "\n▸ no file changes.");
  if (flags.keep) console.log(`\n▸ worktree kept at ${result.worktreePath} · review: git -C ${result.worktreePath} diff`);
  else console.log("\n▸ worktree removed (use --keep to inspect).");
  return 0;
}
