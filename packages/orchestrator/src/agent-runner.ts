import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, Options, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { AgentId, ProjectId, Role, SecretRef } from "@mantra/core";
import type { Bus } from "./bus.js";
import type { CircuitBreaker } from "./breaker.js";
import { type ActionKind, type Confirmer, Effector, type SecretProvider } from "./effector.js";
import { decideTool } from "./tool-permissions.js";

/**
 * Wraps one Claude Agent SDK session (FR-11): a headless Claude Code session with a
 * role system prompt, model tier, cwd = its own worktree (ADR-1), resumable by
 * session id. Enforcement is deterministic middleware, not prompting (ADR-4):
 *   - `canUseTool` checks every tool call against the permission matrix + breaker
 *   - privileged (irreversible) tool calls are rewritten into Effector actions (ADR-2)
 *   - the API key is resolved inside the trusted boundary and injected into the agent
 *     process env, never into the prompt (ADR-3)
 */
export interface AgentSpec {
  readonly id: AgentId;
  readonly projectId: ProjectId;
  readonly role: Role;
  readonly model: string;
  readonly worktreePath: string;
  readonly apiKeyRef: SecretRef;
  /** Resume a prior Claude Code session instead of starting fresh. */
  readonly resumeSessionId?: string;
}

export interface AgentRunnerDeps {
  readonly bus: Bus;
  readonly secrets: SecretProvider;
  readonly confirmer: Confirmer;
}

export interface AgentRunResult {
  readonly sessionId: string;
  readonly costUsd: number;
  readonly stopReason: "completed" | "breaker" | "error";
}

const ROLE_PROMPTS: Readonly<Record<Role, string>> = {
  manager: "You are the Manager. Decompose the goal into tasks and delegate; do not edit code yourself.",
  developer: "You are the Developer. Implement the assigned task in this worktree and keep tests green.",
  qa: "You are QA. Verify the change and write/adjust tests only; do not modify product code.",
  devops: "You are DevOps. Prepare and stage deploys; never run an irreversible op without confirmation.",
  marketer: "You are the Marketer. Work on docs and copy only; you have no code access.",
  ops: "You are Ops. Monitor, triage, and draft fixes; escalate incidents rather than auto-deploying.",
};

/** Only irreversible capabilities are routed to the Effector (grant resolves to `confirm`). */
const CAPABILITY_TO_ACTION: Partial<Record<string, ActionKind>> = {
  gitPush: "gitPush",
  sshDeploy: "sshDeploy",
  dbMutate: "dbMutate",
  fsDelete: "fsDelete",
};

export class AgentRunner {
  private readonly effector: Effector;

  constructor(private readonly deps: AgentRunnerDeps) {
    this.effector = new Effector(deps.secrets, deps.confirmer);
  }

  private buildCanUseTool(spec: AgentSpec, breaker: CircuitBreaker, abort: AbortController): CanUseTool {
    const { bus } = this.deps;
    const effector = this.effector;
    return async (toolName, input): Promise<PermissionResult> => {
      // Loop / budget middleware — trips deterministically, aborts the run.
      if (!breaker.noteAction(`${toolName}`) || breaker.isTripped) {
        abort.abort();
        return { behavior: "deny", message: "circuit breaker tripped", interrupt: true };
      }

      const { capability, grant } = decideTool(spec.role, toolName, input);
      if (grant === "deny") {
        return { behavior: "deny", message: `role ${spec.role} may not perform ${capability}` };
      }
      if (grant === "allow") {
        return { behavior: "allow" };
      }

      // grant === "confirm": an irreversible op. The agent never executes it directly —
      // hand it to the trusted Effector (human gate + secret injection + side effect), then
      // deny the agent's own tool call so the action happens exactly once (ADR-2).
      const kind = CAPABILITY_TO_ACTION[capability];
      if (!kind) return { behavior: "deny", message: `no effector for ${capability}` };
      const result = await effector.execute({
        kind,
        projectId: spec.projectId,
        agentId: spec.id,
        role: spec.role,
        args: { command: typeof input.command === "string" ? input.command : "" },
      });
      await bus.publish(`agent.${spec.projectId}.effector`, { agentId: spec.id, kind, ok: result.ok });
      return result.ok
        ? { behavior: "deny", message: `performed via Effector: ${result.value.detail}` }
        : { behavior: "deny", message: `denied: ${result.error.message}` };
    };
  }

  /**
   * Run the agent to completion on `prompt`. Resolves the API key inside the trusted
   * boundary, meters usage through the breaker, and streams activity to the bus.
   */
  async run(spec: AgentSpec, prompt: string, breaker: CircuitBreaker): Promise<AgentRunResult> {
    const { bus, secrets } = this.deps;
    const apiKey = await secrets.resolve(spec.apiKeyRef); // ADR-3: stays out of the prompt
    const abort = new AbortController();

    const options: Options = {
      model: spec.model,
      cwd: spec.worktreePath,
      systemPrompt: ROLE_PROMPTS[spec.role],
      permissionMode: "default",
      canUseTool: this.buildCanUseTool(spec, breaker, abort),
      env: { ...process.env, ANTHROPIC_API_KEY: apiKey },
      abortController: abort,
      ...(spec.resumeSessionId ? { resume: spec.resumeSessionId } : {}),
    };

    let sessionId = spec.resumeSessionId ?? "";
    let costUsd = 0;
    await bus.publish(`agent.${spec.projectId}.started`, { agentId: spec.id, role: spec.role });

    for await (const message of query({ prompt, options })) {
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
      } else if (message.type === "assistant") {
        await bus.publish(`agent.${spec.projectId}.activity`, { agentId: spec.id });
      } else if (message.type === "result") {
        sessionId = message.session_id;
        if (message.subtype === "success") {
          costUsd = message.total_cost_usd;
          breaker.record({
            inputTokens: message.usage.input_tokens,
            outputTokens: message.usage.output_tokens,
          });
        }
      }
    }

    const stopReason: AgentRunResult["stopReason"] = breaker.isTripped ? "breaker" : "completed";
    await bus.publish(`agent.${spec.projectId}.done`, { agentId: spec.id, sessionId, costUsd, stopReason });
    return { sessionId, costUsd, stopReason };
  }
}
