import type { Role } from "@mantra/core";
import { HeuristicPlanner, type PlannedTask, type Planner } from "./coordinator.js";
import type { Confirmer } from "./effector.js";
import { type AuthMode, type RunEvent, runAgentTask } from "./run-task.js";

/**
 * Real Manager decomposition (FR-9): runs a Manager agent read-only in the repo (with the
 * dual-graph so it can inspect the codebase cheaply) and asks it to emit a JSON task list.
 * Parsing is defensive and falls back to the HeuristicPlanner if the output is unusable —
 * the crew never stalls because a decomposition didn't parse.
 */
export interface AgentPlannerConfig {
  readonly repoPath: string;
  readonly model: string;
  readonly budgetUsd: number;
  readonly confirmer: Confirmer;
  readonly noGraph?: boolean;
  readonly authMode?: AuthMode;
  readonly onRunEvent?: (event: RunEvent) => void;
}

const KNOWN_ROLES: ReadonlySet<Role> = new Set(["manager", "developer", "qa", "devops", "marketer", "ops"]);

const PLANNING_PROMPT = (goal: string): string =>
  [
    "You are decomposing a goal into a short, ordered list of concrete tasks for a software crew.",
    "Inspect the repo as needed (read-only), then output ONLY a JSON array — no prose before or after.",
    'Each item: {"title": "<imperative task>", "role": "developer" | "qa" | "devops"}.',
    "Keep it to 2–5 tasks. Put implementation tasks (developer) before their verification (qa).",
    "",
    `Goal: ${goal}`,
  ].join("\n");

/** Extract and validate a task list from arbitrary model output. Returns [] if unusable. */
export function parseTaskList(text: string): PlannedTask[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const tasks: PlannedTask[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const title = (item as { title?: unknown }).title;
    if (typeof title !== "string" || !title.trim()) continue;
    const roleRaw = String((item as { role?: unknown }).role ?? "developer").toLowerCase();
    const role: Role = KNOWN_ROLES.has(roleRaw as Role) ? (roleRaw as Role) : "developer";
    tasks.push({ title: title.trim(), role });
  }
  return tasks;
}

export class AgentPlanner implements Planner {
  private readonly fallback = new HeuristicPlanner();

  constructor(private readonly config: AgentPlannerConfig) {}

  async decompose(goal: string): Promise<readonly PlannedTask[]> {
    const result = await runAgentTask({
      repoPath: this.config.repoPath,
      task: PLANNING_PROMPT(goal),
      role: "manager",
      model: this.config.model,
      budgetUsd: this.config.budgetUsd,
      dryRun: true, // planning is strictly read-only
      noGraph: this.config.noGraph ?? false,
      authMode: this.config.authMode,
      confirmer: this.config.confirmer,
      onEvent: this.config.onRunEvent,
    });
    if (!result.ok) return this.fallback.decompose(goal);
    const tasks = parseTaskList(result.finalText);
    return tasks.length > 0 ? tasks : this.fallback.decompose(goal);
  }
}
