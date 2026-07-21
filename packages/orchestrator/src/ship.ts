import { basename } from "node:path";
import { type Role, type SecretRef, agentId as makeAgentId, projectId as makeProjectId } from "@mantra/core";
import type { Effector } from "./effector.js";

/**
 * The ship pipeline (P4): promote a reviewed branch → open PR → gate on CI → auto-merge on
 * green → optional guarded deploy. The gates are DETERMINISTIC CODE, not agent judgment:
 *  - a PR is merged only when CI is green (ADR-8: CI-over-agent gates) — the pipeline can
 *    never merge a red or still-pending PR;
 *  - push + deploy are irreversible, so they route through the Effector (permission matrix +
 *    human confirm, ADR-2/3): deploy is always confirmed, and a declined confirm aborts.
 * The GitHost (PR/CI/merge) and Effector are injected, so the whole pipeline is exercised
 * offline with fakes and driven live by `gh` (see git-host.ts).
 */

export type CiStatus = "pending" | "success" | "failure";

export interface PullRequest {
  readonly number: number;
  readonly url: string;
}

/** The GitHub side of a ship. Injected so the pipeline is testable without a network. */
export interface GitHost {
  openPr(opts: { branch: string; base: string; title: string; body: string }): Promise<PullRequest>;
  ciStatus(pr: PullRequest): Promise<CiStatus>;
  merge(pr: PullRequest): Promise<void>;
}

export type ShipStage = "push" | "pr" | "ci" | "merge" | "deploy" | "done";

export type ShipEvent =
  | { readonly type: "pushed"; readonly branch: string }
  | { readonly type: "pr-opened"; readonly number: number; readonly url: string }
  | { readonly type: "ci"; readonly status: CiStatus; readonly attempt: number }
  | { readonly type: "merged"; readonly number: number }
  | { readonly type: "deployed"; readonly env: string; readonly detail: string }
  | { readonly type: "aborted"; readonly stage: ShipStage; readonly reason: string };

export interface DeploySpec {
  readonly env: string;
  /** Reference (never a value) to any secret the deploy needs — resolved inside the Effector. */
  readonly secretRef?: SecretRef;
  /** Extra args passed to the live sshDeploy effector (e.g. the deploy command). */
  readonly args?: Readonly<Record<string, string>>;
}

export interface ShipOptions {
  readonly repoPath: string;
  readonly branch: string;
  readonly base?: string;
  readonly title: string;
  readonly body?: string;
  /** Role whose grants gate push/deploy (default devops: push allow, deploy confirm). */
  readonly role?: Role;
  readonly host: GitHost;
  readonly effector: Effector;
  /** If set, deploy after a green merge — always behind the confirm gate. */
  readonly deploy?: DeploySpec;
  /** Auto-merge on green (default true). When false, the pipeline stops at a green PR. */
  readonly autoMerge?: boolean;
  /** CI polling: check every intervalMs up to maxAttempts (default 500ms × 40 ≈ 20s). */
  readonly ci?: { readonly intervalMs?: number; readonly maxAttempts?: number };
  readonly onEvent?: (event: ShipEvent) => void;
}

export interface ShipResult {
  readonly ok: boolean;
  /** Furthest stage reached. `done` means the whole requested pipeline completed. */
  readonly stage: ShipStage;
  readonly merged: boolean;
  readonly deployed: boolean;
  readonly pr?: PullRequest;
  readonly reason?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runShip(opts: ShipOptions): Promise<ShipResult> {
  const emit = (e: ShipEvent): void => opts.onEvent?.(e);
  const base = opts.base ?? "main";
  const role: Role = opts.role ?? "devops";
  const autoMerge = opts.autoMerge ?? true;
  const intervalMs = opts.ci?.intervalMs ?? 500;
  const maxAttempts = opts.ci?.maxAttempts ?? 40;
  const pid = makeProjectId(basename(opts.repoPath));
  const aid = makeAgentId(`ship-${Date.now()}`);
  const abort = (stage: ShipStage, reason: string): ShipResult => {
    emit({ type: "aborted", stage, reason });
    return { ok: false, stage, merged: false, deployed: false, reason };
  };

  // 1. push the branch — irreversible, so through the Effector (permission matrix + confirm).
  const pushed = await opts.effector.execute({
    kind: "gitPush", projectId: pid, agentId: aid, role,
    args: { repoPath: opts.repoPath, branch: opts.branch, base },
  });
  if (!pushed.ok) return abort("push", pushed.error.message);
  emit({ type: "pushed", branch: opts.branch });

  // 2. open the PR.
  let pr: PullRequest;
  try {
    pr = await opts.host.openPr({ branch: opts.branch, base, title: opts.title, body: opts.body ?? "" });
  } catch (e) {
    return abort("pr", e instanceof Error ? e.message : String(e));
  }
  emit({ type: "pr-opened", number: pr.number, url: pr.url });

  // 3. CI gate — poll until green/red or we give up. The pipeline NEVER merges a non-green PR.
  let status: CiStatus = "pending";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      status = await opts.host.ciStatus(pr);
    } catch (e) {
      return { ...abort("ci", e instanceof Error ? e.message : String(e)), pr };
    }
    emit({ type: "ci", status, attempt });
    if (status !== "pending") break;
    if (attempt < maxAttempts) await sleep(intervalMs);
  }
  if (status === "failure") return { ...abort("ci", "CI failed — not merging"), pr };
  if (status !== "success") return { ...abort("ci", `CI still pending after ${maxAttempts} checks`), pr };

  // 4. merge — reached only on green (the gate). Optionally left for a manual merge.
  if (!autoMerge) {
    return { ok: true, stage: "merge", merged: false, deployed: false, pr };
  }
  try {
    await opts.host.merge(pr);
  } catch (e) {
    return { ...abort("merge", e instanceof Error ? e.message : String(e)), pr };
  }
  emit({ type: "merged", number: pr.number });

  // 5. deploy — optional, always behind the confirm gate (deploy is irreversible).
  if (opts.deploy) {
    const deployed = await opts.effector.execute({
      kind: "sshDeploy", projectId: pid, agentId: aid, role,
      args: { repoPath: opts.repoPath, env: opts.deploy.env, ...(opts.deploy.args ?? {}) },
      ...(opts.deploy.secretRef ? { secretRef: opts.deploy.secretRef } : {}),
    });
    if (!deployed.ok) return { ...abort("deploy", deployed.error.message), pr, merged: true };
    emit({ type: "deployed", env: opts.deploy.env, detail: deployed.value.detail });
    return { ok: true, stage: "done", merged: true, deployed: true, pr };
  }

  return { ok: true, stage: "done", merged: true, deployed: false, pr };
}
