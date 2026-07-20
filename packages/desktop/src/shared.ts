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

/** The safe surface exposed to the renderer via contextBridge. */
export interface MantraBridge {
  submitIntent(raw: string, source: IntentSource): Promise<IntentAck>;
  getFleet(): Promise<FleetSnapshot>;
}

declare global {
  interface Window {
    readonly mantra: MantraBridge;
  }
}
