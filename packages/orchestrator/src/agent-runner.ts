import type { AgentId, ProjectId, Role, SecretRef } from "@mantra/core";
import type { Bus } from "./bus.js";
import type { CircuitBreaker } from "./breaker.js";

/**
 * Wraps one Claude Agent SDK session (FR-11). Each agent = a headless Claude Code
 * session with a role system-prompt, model tier, tool allow-list, cwd = its own
 * worktree (ADR-1), resumable by session id.
 *
 * Enforcement is wired here as SDK PreToolUse hooks (ADR-4): every tool call is
 * checked against the permission matrix and metered through the CircuitBreaker,
 * and privileged tool calls are rewritten into ActionIntents for the Effector
 * (ADR-2) rather than executed by the agent directly.
 */
export interface AgentSpec {
  readonly id: AgentId;
  readonly projectId: ProjectId;
  readonly role: Role;
  readonly model: string;
  readonly worktreePath: string;
  readonly apiKeyRef: SecretRef;
}

export interface AgentRunnerDeps {
  readonly bus: Bus;
  readonly breaker: CircuitBreaker;
}

export interface AgentSession {
  readonly id: AgentId;
  send(text: string): Promise<void>;
  stop(): Promise<void>;
}

export class AgentRunner {
  constructor(private readonly deps: AgentRunnerDeps) {}

  /**
   * TODO(P1): integrate `@anthropic-ai/claude-agent-sdk`.
   *   - system prompt from the role, model = spec.model, cwd = spec.worktreePath
   *   - resolve API key via spec.apiKeyRef inside the trusted boundary (never in prompt)
   *   - PreToolUse hook → permission matrix + breaker.noteAction()/record()
   *   - map privileged tools → Effector.execute()
   */
  async start(spec: AgentSpec): Promise<AgentSession> {
    const { bus } = this.deps;
    await bus.publish(`agent.${spec.projectId}.started`, { agentId: spec.id, role: spec.role });
    return {
      id: spec.id,
      async send(text: string): Promise<void> {
        await bus.publish(`agent.${spec.projectId}.message`, { agentId: spec.id, text });
      },
      async stop(): Promise<void> {
        await bus.publish(`agent.${spec.projectId}.stopped`, { agentId: spec.id });
      },
    };
  }
}
