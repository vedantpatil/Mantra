import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SCHEMA_VERSION } from "@mantra/core";
import type { DualGraphConfig } from "./agent-runner.js";

/**
 * Per-repo Mantra config, persisted at `<repo>/.mantra/config.json` (REQUIREMENTS §8).
 * Holds crew/ports/budget/permissions and the optional per-project API-key override
 * (FR-25a) and dual-graph settings (FR-13a). Never holds secret values — only refs.
 */
export interface ProjectConfig {
  readonly schemaVersion: number;
  readonly name: string;
  readonly crewTemplate: string;
  readonly ports: { readonly web: number; readonly api: number; readonly range: readonly [number, number] };
  readonly dailyBudget: number;
  /** `env://VAR` or `vault://...`; when absent, the fleet-global default applies (FR-25a). */
  readonly apiKeyRef?: string;
  readonly dualGraph: {
    readonly enabled: boolean;
    /** Command that launches the local dual-graph MCP (stdio). Absent ⇒ assume none available. */
    readonly command?: string;
    readonly args?: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
  };
}

export function defaultProjectConfig(name: string): ProjectConfig {
  return {
    schemaVersion: SCHEMA_VERSION,
    name,
    crewTemplate: "solo-developer",
    ports: { web: 3000, api: 8000, range: [3000, 3099] },
    dailyBudget: 2,
    dualGraph: { enabled: true },
  };
}

const configPath = (repoPath: string): string => join(repoPath, ".mantra", "config.json");

/** Load `.mantra/config.json`, or return a default if absent. */
export function loadProjectConfig(repoPath: string, name: string): ProjectConfig {
  const path = configPath(repoPath);
  if (!existsSync(path)) return defaultProjectConfig(name);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ProjectConfig;
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`.mantra/config.json schema v${parsed.schemaVersion} != code v${SCHEMA_VERSION}; migration required`);
  }
  return parsed;
}

/** Write `.mantra/config.json`, creating the directory. */
export function saveProjectConfig(repoPath: string, config: ProjectConfig): void {
  const path = configPath(repoPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Locate the dual-graph MCP command without hardcoding a machine path (FR-13a):
 *   1. explicit project config, 2. MANTRA_DUAL_GRAPH_COMMAND env,
 *   3. the conventional install at ~/.dual-graph/venv/bin/mcp-graph-server,
 *   4. `mcp-graph-server` if it's on PATH.
 * Returns undefined when none is found (the run proceeds without a graph).
 */
export function discoverDualGraphCommand(configCommand?: string): string | undefined {
  if (configCommand) return configCommand;
  if (process.env.MANTRA_DUAL_GRAPH_COMMAND) return process.env.MANTRA_DUAL_GRAPH_COMMAND;
  const conventional = join(homedir(), ".dual-graph", "venv", "bin", "mcp-graph-server");
  if (existsSync(conventional)) return conventional;
  return undefined; // may still be on PATH — caller can fall back to the bare name
}

/**
 * Resolve the AgentRunner dual-graph config, auto-deriving the per-repo env
 * (DG_DATA_DIR, DUAL_GRAPH_PROJECT_ROOT) so pointing at any repo just works.
 */
export function resolveDualGraph(
  config: ProjectConfig,
  repoPath: string,
  disabled: boolean,
): DualGraphConfig | undefined {
  if (disabled || !config.dualGraph.enabled) return undefined;
  const command = discoverDualGraphCommand(config.dualGraph.command);
  if (!command) return undefined;
  return {
    command,
    args: config.dualGraph.args ?? ["--stdio"],
    env: {
      DG_DATA_DIR: join(repoPath, ".dual-graph"),
      DUAL_GRAPH_PROJECT_ROOT: repoPath,
      ...config.dualGraph.env,
    },
  };
}
