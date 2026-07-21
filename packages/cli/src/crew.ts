import { resolve } from "node:path";
import { type CrewEvent, type RunEvent, runCrew } from "@mantra/orchestrator";
import { DenyConfirmer, StdinConfirmer } from "./confirmers.js";

export interface CrewFlags {
  readonly model: string;
  readonly budget: number;
  readonly noPush: boolean;
  readonly noGraph: boolean;
  readonly dryRun: boolean;
}

/** Terminal renderer over the shared crew pipeline. The desktop console renders the same events. */
export async function crewCommand(repoArg: string, goal: string, flags: CrewFlags): Promise<number> {
  const repoPath = resolve(repoArg);

  const onCrewEvent = (e: CrewEvent): void => {
    const text =
      e.type === "planned" ? `\n▸ Manager decomposed the goal into ${e.count} tasks`
      : e.type === "executed" ? `  · ${e.title} — ${e.ok ? "done" : "failed"} (${e.note})`
      : e.type === "verified" ? `  · QA ${e.pass ? "passed" : "rejected"}: ${e.title}`
      : e.type === "requeued" ? `  ↻ requeued (attempt ${e.attempt}): ${e.title}`
      : e.type === "review" ? `  ✓ ready for your review: ${e.title}`
      : `  ✗ failed: ${e.title} — ${e.reason}`;
    console.log(text);
  };

  const onRunEvent = (title: string, e: RunEvent): void => {
    switch (e.type) {
      case "warn": console.warn(`    ⚠ [${title}] ${e.message}`); break;
      case "effector": console.log(`    [effector · ${title}] ${JSON.stringify(e.detail)}`); break;
      case "activity": process.stdout.write("·"); break;
    }
  };

  console.log(`\n▸ crew goal: ${goal}\n`);
  const result = await runCrew({
    repoPath, goal,
    model: flags.model, budgetUsd: flags.budget,
    noPush: flags.noPush, noGraph: flags.noGraph,
    confirmer: flags.dryRun ? new DenyConfirmer() : new StdinConfirmer(),
    onCrewEvent, onRunEvent,
  });

  if (!result.ok) {
    console.error(`\n✗ ${result.error}`);
    return 1;
  }
  console.log(
    `\n▸ crew done · ${result.reviewTitles.length} in review, ${result.failedTitles.length} failed.`,
  );
  if (result.reviewTitles.length) {
    console.log(`\n▸ awaiting your review:\n${result.reviewTitles.map((t) => `  ✓ ${t}`).join("\n")}`);
  }
  if (result.failedTitles.length) {
    console.log(`\n▸ failed (escalated):\n${result.failedTitles.map((t) => `  ✗ ${t}`).join("\n")}`);
  }
  console.log("\n▸ approve/reject diffs in the desktop Decisions queue (crew state persisted under .mantra/state/).");
  return 0;
}
