/** Branded string IDs so a ProjectId can never be passed where an AgentId is expected. */
export type Brand<B extends string> = string & { readonly __brand: B };

export type ProjectId = Brand<"ProjectId">;
export type AgentId = Brand<"AgentId">;
export type TaskId = Brand<"TaskId">;
export type DecisionId = Brand<"DecisionId">;
/** A reference to a secret in the vault — NEVER the secret value itself (ADR-3). */
export type SecretRef = Brand<"SecretRef">;

export const projectId = (s: string): ProjectId => s as ProjectId;
export const agentId = (s: string): AgentId => s as AgentId;
export const taskId = (s: string): TaskId => s as TaskId;
export const decisionId = (s: string): DecisionId => s as DecisionId;
export const secretRef = (s: string): SecretRef => s as SecretRef;
