import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A GUI app launched from Finder does NOT inherit the shell environment, so
 * ANTHROPIC_API_KEY set in a terminal isn't visible. To let the operator run live
 * from a double-clicked app, we read the key from `~/.mantra/config.json`
 * ({ "anthropicApiKey": "sk-..." }) and populate the env if it isn't already set.
 * A shell-exported key still wins. Local single-user storage — fine for the MVP.
 */
export function loadApiKeyIntoEnv(): void {
  if (process.env.ANTHROPIC_API_KEY) return;
  const path = join(homedir(), ".mantra", "config.json");
  if (!existsSync(path)) return;
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8")) as { anthropicApiKey?: string };
    if (cfg.anthropicApiKey) process.env.ANTHROPIC_API_KEY = cfg.anthropicApiKey;
  } catch {
    /* ignore malformed config */
  }
}
