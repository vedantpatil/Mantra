import { type Capability, type Grant, type Role, resolveGrant } from "@mantra/core";

/**
 * Maps a Claude Agent SDK tool call to a Mantra capability, then to a grant via
 * the permission matrix (ADR-4). This is the deterministic core of enforcement —
 * pure and unit-tested — that the AgentRunner's `canUseTool` callback wraps.
 */

const READ_TOOLS = new Set(["Read", "Glob", "Grep", "NotebookRead", "WebFetch", "WebSearch"]);
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Bash command patterns that escalate to an irreversible capability. */
const BASH_PATTERNS: readonly [RegExp, Capability][] = [
  [/\brm\s+(-[a-z]*f|-[a-z]*r|--force|--recursive)/i, "fsDelete"],
  [/\b(ssh|scp|rsync)\b/i, "sshDeploy"],
  [/\bdocker\s+(compose\s+)?(up|run|deploy)\b/i, "sshDeploy"],
  [/\b(drop|truncate)\s+(table|database|schema)\b/i, "dbMutate"],
  [/\b(psql|mysql|mongo)\b.*\b(drop|delete|update)\b/i, "dbMutate"],
  [/\bgit\s+push\b/i, "gitPush"],
];

/** Classify a Bash command; defaults to `editCode` (a shell can mutate the workspace). */
export function capabilityForBash(command: string): Capability {
  for (const [pattern, cap] of BASH_PATTERNS) {
    if (pattern.test(command)) return cap;
  }
  return "editCode";
}

/** Map any tool call to the capability it needs. Unknown tools are treated as writes (conservative). */
export function capabilityForTool(toolName: string, input: Record<string, unknown>): Capability {
  if (READ_TOOLS.has(toolName)) return "read";
  if (EDIT_TOOLS.has(toolName)) return "editCode";
  if (toolName === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    return capabilityForBash(command);
  }
  return "editCode";
}

export interface ToolDecision {
  readonly capability: Capability;
  readonly grant: Grant;
}

/** The full decision for one tool call by one role. */
export function decideTool(
  role: Role,
  toolName: string,
  input: Record<string, unknown>,
): ToolDecision {
  const capability = capabilityForTool(toolName, input);
  return { capability, grant: resolveGrant(role, capability) };
}
