import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface GlobalConfig {
  anthropicApiKey?: string;
  [k: string]: unknown;
}

const configPath = (): string => join(homedir(), ".mantra", "config.json");

function readConfig(): GlobalConfig {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as GlobalConfig;
  } catch {
    return {};
  }
}

/**
 * A GUI app launched from Finder does NOT inherit the shell environment, so
 * ANTHROPIC_API_KEY set in a terminal isn't visible. To let the operator run live
 * from a double-clicked app, we read the key from `~/.mantra/config.json`
 * ({ "anthropicApiKey": "sk-..." }) and populate the env if it isn't already set.
 * A shell-exported key still wins. Local single-user storage — fine for the MVP.
 */
export function loadApiKeyIntoEnv(): void {
  if (process.env.ANTHROPIC_API_KEY) return;
  const key = readConfig().anthropicApiKey;
  if (key) process.env.ANTHROPIC_API_KEY = key;
}

/** Persist the API key to config.json (preserving other fields) and apply it immediately. */
export function saveApiKey(key: string): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...readConfig(), anthropicApiKey: key }, null, 2)}\n`, { mode: 0o600 });
  process.env.ANTHROPIC_API_KEY = key; // live now, no restart needed
}

/** Whether a key is available (shell env wins, else config), plus a masked hint for the UI. */
export function apiKeyStatus(): { set: boolean; source: "env" | "config" | "none"; masked?: string } {
  const envKey = process.env.ANTHROPIC_API_KEY;
  const cfgKey = readConfig().anthropicApiKey;
  const key = envKey || cfgKey;
  if (!key) return { set: false, source: "none" };
  const masked = key.length > 8 ? `${key.slice(0, 6)}…${key.slice(-4)}` : "set";
  return { set: true, source: envKey ? "env" : "config", masked };
}
