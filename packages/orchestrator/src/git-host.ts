import { execFileSync } from "node:child_process";
import type { ActionIntent, SideEffects } from "./effector.js";
import type { CiStatus, GitHost, PullRequest } from "./ship.js";

/**
 * Live drivers for the ship pipeline (P4). Kept apart from the deterministic `runShip` core
 * so the pipeline stays unit-testable with fakes while these do the real `gh`/`git` work.
 * Nothing here runs in the offline smoke suite — it needs a GitHub remote + the `gh` CLI.
 */

function git(repoPath: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}
function gh(repoPath: string, args: readonly string[]): string {
  return execFileSync("gh", args, { cwd: repoPath, encoding: "utf8" }).trim();
}

/** GitHost backed by the `gh` CLI. Assumes the branch is already pushed (the Effector does that). */
export class GhGitHost implements GitHost {
  constructor(private readonly repoPath: string) {}

  openPr(opts: { branch: string; base: string; title: string; body: string }): Promise<PullRequest> {
    // Idempotent-ish: if a PR already exists for the branch, reuse it instead of erroring.
    const existing = this.findPr(opts.branch);
    if (existing) return Promise.resolve(existing);
    const url = gh(this.repoPath, [
      "pr", "create", "--head", opts.branch, "--base", opts.base,
      "--title", opts.title, "--body", opts.body || opts.title,
    ]).split("\n").pop() ?? "";
    const number = Number(url.split("/").pop());
    if (!Number.isFinite(number)) throw new Error(`could not parse PR number from '${url}'`);
    return Promise.resolve({ number, url });
  }

  ciStatus(pr: PullRequest): Promise<CiStatus> {
    const raw = gh(this.repoPath, ["pr", "view", String(pr.number), "--json", "statusCheckRollup"]);
    const checks: Array<{ state?: string; conclusion?: string; status?: string }> =
      JSON.parse(raw).statusCheckRollup ?? [];
    if (checks.length === 0) return Promise.resolve("success"); // no CI configured → nothing gating
    const norm = (c: { state?: string; conclusion?: string; status?: string }): string =>
      (c.conclusion || c.state || c.status || "").toUpperCase();
    const states = checks.map(norm);
    if (states.some((s) => ["FAILURE", "CANCELLED", "TIMED_OUT", "ERROR", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(s)))
      return Promise.resolve("failure");
    if (states.some((s) => ["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "EXPECTED", ""].includes(s)))
      return Promise.resolve("pending");
    return Promise.resolve("success");
  }

  merge(pr: PullRequest): Promise<void> {
    gh(this.repoPath, ["pr", "merge", String(pr.number), "--squash", "--delete-branch"]);
    return Promise.resolve();
  }

  private findPr(branch: string): PullRequest | undefined {
    try {
      const raw = gh(this.repoPath, ["pr", "list", "--head", branch, "--state", "open", "--json", "number,url"]);
      const [pr] = JSON.parse(raw) as PullRequest[];
      return pr;
    } catch {
      return undefined;
    }
  }
}

/**
 * Real side effects for the operator-driven Effector during a ship: actually push the branch,
 * and actually run the project's deploy command. Wired only in the ship path — agent runs keep
 * the stub. The deploy command comes from `deployCmd` in the action args (from project config);
 * any resolved secret is exposed to it as `$DEPLOY_SECRET`, never logged or returned.
 */
export function liveShipEffects(): SideEffects {
  return {
    gitPush: async (action: ActionIntent) => {
      const { repoPath, branch } = action.args;
      git(repoPath, ["push", "-u", "origin", branch]);
      return `pushed ${branch} → origin`;
    },
    sshDeploy: async (action: ActionIntent, secret?: string) => {
      const { repoPath, env, deployCmd } = action.args;
      if (!deployCmd) throw new Error(`no deploy command configured for env '${env}'`);
      execFileSync("sh", ["-c", deployCmd], {
        cwd: repoPath,
        stdio: "pipe",
        env: { ...process.env, ...(secret ? { DEPLOY_SECRET: secret } : {}) },
      });
      return `deployed to ${env}`;
    },
  };
}
