import type { AgentId, ProjectId } from "./ids.js";

/**
 * The structured intent contract (ADR-7). Voice AND console both resolve natural
 * language to this SAME typed shape via constrained tool-use, then feed one router.
 */
export type IntentVerb =
  | "create"
  | "plan"
  | "approve"
  | "requestChanges"
  | "ship"
  | "deploy"
  | "pause"
  | "resume"
  | "reassign"
  | "message"
  | "status"
  | "queue"
  | "budget"
  | "logs"
  | "confirm"
  | "hold";

export type IntentSource = "voice" | "console";

export interface Intent {
  readonly verb: IntentVerb;
  readonly projectId?: ProjectId;
  readonly agentId?: AgentId;
  readonly args: Readonly<Record<string, string>>;
  /** false ⇒ requires an explicit target preview + confirm before execution. */
  readonly reversible: boolean;
  readonly source: IntentSource;
  /** The original utterance or typed text, kept for the audit trail. */
  readonly raw: string;
}

/** Verbs whose effects cannot be undone — always require target confirmation. */
export const IRREVERSIBLE_VERBS: ReadonlySet<IntentVerb> = new Set([
  "ship",
  "deploy",
]);

export function isIrreversible(intent: Intent): boolean {
  return !intent.reversible || IRREVERSIBLE_VERBS.has(intent.verb);
}

/** A misrouted destructive command is catastrophic — never execute one silently. */
export function requiresTargetConfirm(intent: Intent): boolean {
  return isIrreversible(intent);
}
