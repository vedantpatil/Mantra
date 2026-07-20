/**
 * IPC contract shared across the Electron main process, the preload bridge, and the
 * React renderer. Keep this free of `electron`/`react` imports so all three can use it.
 */
export type IntentSource = "voice" | "console";

/** The router's reply to a submitted intent (ADR-7). Stubbed in main until wired to the Overseer. */
export interface IntentAck {
  readonly ok: boolean;
  readonly message: string;
}

export type AgentStatus = "run" | "gate" | "block" | "idle";
export type Health = "ok" | "busy" | "blk" | "idle";

export interface FleetAgent {
  readonly role: string;
  readonly badge: string;
  readonly task: string;
  readonly status: AgentStatus;
}

export interface FleetProject {
  readonly id: string;
  readonly name: string;
  readonly health: Health;
  readonly port: number;
  readonly stage: string;
  /** 0–5 index into the 6-dot lifecycle bar. */
  readonly stageIndex: number;
  readonly blocked?: boolean;
  readonly agents: readonly FleetAgent[];
}

export interface Decision {
  readonly id: string;
  readonly project: string;
  readonly title: string;
  readonly summary: string;
  readonly critical: boolean;
  readonly actions: readonly string[];
}

export interface FleetSnapshot {
  readonly projects: readonly FleetProject[];
  readonly decisions: readonly Decision[];
  readonly agents: number;
  readonly needYou: number;
  readonly spendToday: number;
  readonly budget: number;
}

/** A project the operator can run tasks against (from ~/.mantra/projects.json). */
export interface ProjectRef {
  readonly id: string;
  readonly name: string;
  readonly repoPath: string;
}

export interface RunRequest {
  readonly target: string; // project id/name, or an absolute repo path
  readonly task: string;
  readonly dryRun: boolean;
}

/** An irreversible op an agent wants to perform, surfaced to the operator for confirmation (FR-21/ADR-2). */
export interface ConfirmRequest {
  readonly id: string;
  readonly kind: string;
  readonly project: string;
  readonly command: string;
}

/** A task at the human review gate, awaiting Approve/Reject (FR-14). */
export interface ReviewItem {
  readonly id: string;
  readonly title: string;
  readonly project: string;
  readonly repoPath: string;
}

/** Streamed from main → renderer during a run; the console renders these live. */
export type AgentEvent =
  | { readonly kind: "line"; readonly text: string }
  | { readonly kind: "done"; readonly costUsd: number; readonly stopReason: string; readonly diffStat: string; readonly worktreePath: string }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "reviews-changed" };

/** The safe surface exposed to the renderer via contextBridge. */
export interface MantraBridge {
  submitIntent(raw: string, source: IntentSource): Promise<IntentAck>;
  getFleet(): Promise<FleetSnapshot>;
  listProjects(): Promise<readonly ProjectRef[]>;
  /** Kicks off a single-agent run; progress streams via onAgentEvent. */
  runTask(req: RunRequest): Promise<IntentAck>;
  /** Kicks off a crew run (Manager decomposes → Dev/QA → review); streams via onAgentEvent. */
  runCrew(req: RunRequest): Promise<IntentAck>;
  /** Tasks awaiting human review across all projects (the review gate). */
  listReviews(): Promise<readonly ReviewItem[]>;
  /** Approve (→ done) or reject (→ requeue) a review task; persists to the task log. */
  resolveReview(repoPath: string, taskId: string, approve: boolean): Promise<IntentAck>;
  /** Subscribe to live run events; returns an unsubscribe function. */
  onAgentEvent(cb: (event: AgentEvent) => void): () => void;
  /** Subscribe to irreversible-op confirmation requests; returns an unsubscribe function. */
  onConfirmRequest(cb: (req: ConfirmRequest) => void): () => void;
  /** Answer a pending confirmation request. */
  respondConfirm(id: string, approved: boolean): void;
}

declare global {
  interface Window {
    readonly mantra: MantraBridge;
  }
}
