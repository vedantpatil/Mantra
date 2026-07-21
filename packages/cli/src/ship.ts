import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  Effector, GhGitHost, type ShipEvent, defaultSecretProvider, isGitRepo, liveShipEffects, runShip,
} from "@mantra/orchestrator";
import { DenyConfirmer, StdinConfirmer } from "./confirmers.js";

export interface ShipFlags {
  readonly base: string;
  readonly branch?: string;
  readonly deploy?: string;
  readonly deployCmd?: string;
  readonly noMerge: boolean;
  readonly dryRun: boolean;
}

/** Terminal renderer over the ship pipeline: push → PR → CI gate → auto-merge → guarded deploy. */
export async function shipCommand(repoArg: string, title: string, flags: ShipFlags): Promise<number> {
  const repoPath = resolve(repoArg);
  if (!isGitRepo(repoPath)) {
    console.error(`\n✗ ${repoPath} is not a git repository`);
    return 1;
  }
  const branch = flags.branch ?? currentBranch(repoPath);
  if (!branch || branch === "HEAD") {
    console.error("\n✗ could not determine the branch to ship (detached HEAD?) — pass --branch <name>");
    return 1;
  }

  // Deploy + push route through the Effector (permission matrix + confirm); dry-run auto-denies.
  const effector = new Effector(
    defaultSecretProvider(),
    flags.dryRun ? new DenyConfirmer() : new StdinConfirmer(),
    liveShipEffects(),
  );

  const onEvent = (e: ShipEvent): void => {
    switch (e.type) {
      case "pushed": console.log(`▸ pushed ${e.branch} → origin`); break;
      case "pr-opened": console.log(`▸ PR #${e.number} opened · ${e.url}`); break;
      case "ci": process.stdout.write(e.status === "pending" ? "·" : `\n▸ CI ${e.status} (check ${e.attempt})`); break;
      case "merged": console.log(`\n▸ merged PR #${e.number} (CI green)`); break;
      case "deployed": console.log(`▸ ${e.detail}`); break;
      case "aborted": console.error(`\n✗ aborted at ${e.stage}: ${e.reason}`); break;
    }
  };

  console.log(`\n▸ shipping ${branch} → ${flags.base} · "${title}"\n`);
  const result = await runShip({
    repoPath, branch, base: flags.base, title,
    host: new GhGitHost(repoPath),
    effector,
    autoMerge: !flags.noMerge,
    ...(flags.deploy ? { deploy: { env: flags.deploy, args: flags.deployCmd ? { deployCmd: flags.deployCmd } : {} } } : {}),
    onEvent,
  });

  if (!result.ok) return 1;
  const pr = result.pr ? `PR #${result.pr.number}` : "PR";
  console.log(
    `\n▸ ship ${result.stage === "done" ? "complete" : `stopped at ${result.stage}`} · ${pr} · ` +
    `${result.merged ? "merged" : "not merged"}${result.deployed ? " · deployed" : ""}`,
  );
  return 0;
}

function currentBranch(repoPath: string): string {
  try {
    return execFileSync("git", ["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}
