import type { AgentId, DecisionId, ProjectId, SecretRef } from "./ids.js";
import type { Role } from "./permissions.js";
import type { Result } from "./result.js";

/** Current registry/config schema version — every persisted record carries it (ADR-6). */
export const SCHEMA_VERSION = 1 as const;

export type LifecycleStage =
  | "create"
  | "plan"
  | "build"
  | "review"
  | "ship"
  | "deploy"
  | "operate";

/** Fleet-wide defaults, owned by the Overseer. */
export interface GlobalSettings {
  readonly defaultApiKeyRef: SecretRef;
  readonly globalDailyBudget: number;
  readonly schemaVersion: number;
}

export interface Project {
  readonly id: ProjectId;
  readonly name: string;
  readonly path: string;
  readonly portRange: readonly [number, number];
  readonly webPort: number;
  readonly apiPort: number;
  readonly dailyBudget: number;
  readonly stage: LifecycleStage;
  readonly crewTemplate: string;
  /** Per-project API key override; when absent, the global default applies (FR-25a). */
  readonly apiKeyRef?: SecretRef;
  readonly dualGraph: { readonly enabled: boolean };
  readonly schemaVersion: number;
}

export type AgentStatus = "idle" | "running" | "waiting" | "blocked" | "stopped";

export interface Agent {
  readonly id: AgentId;
  readonly projectId: ProjectId;
  readonly role: Role;
  readonly model: string;
  readonly sessionId?: string;
  readonly status: AgentStatus;
  readonly tokensToday: number;
  readonly spendToday: number;
}

export interface Decision {
  readonly id: DecisionId;
  readonly projectId: ProjectId;
  readonly type: string;
  readonly title: string;
  readonly summary: string;
  readonly risk: "low" | "medium" | "high";
  readonly options: readonly string[];
  readonly status: "open" | "resolved";
}

/** Resolve the effective API key for a project: override → global default (FR-25a, ADR-3). */
export function resolveApiKeyRef(project: Project, global: GlobalSettings): SecretRef {
  return project.apiKeyRef ?? global.defaultApiKeyRef;
}

/** Read side — every process may hold this. */
export interface RegistryReader {
  getGlobal(): Promise<GlobalSettings>;
  listProjects(): Promise<readonly Project[]>;
  getProject(id: ProjectId): Promise<Project | undefined>;
  listAgents(projectId: ProjectId): Promise<readonly Agent[]>;
  listOpenDecisions(): Promise<readonly Decision[]>;
}

/** Write side — ONLY the Overseer holds this (ADR-6: sole writer). */
export interface RegistryWriter extends RegistryReader {
  putProject(project: Project): Promise<Result<Project>>;
  putAgent(agent: Agent): Promise<Result<Agent>>;
  putDecision(decision: Decision): Promise<Result<Decision>>;
  resolveDecision(id: DecisionId): Promise<Result<void>>;
}
