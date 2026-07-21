import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type AuthMode = "subscription" | "apiKey";
export interface AuthHealth {
  readonly ok: boolean;
  readonly status: string;
}

interface GlobalConfig {
  anthropicApiKey?: string;
  githubToken?: string;
  authMode?: AuthMode;
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

/**
 * GitHub token for `gh` (used by the ship pipeline). `gh` honours `GH_TOKEN`, so storing a PAT
 * from the UI and exporting it makes Ship work without a terminal `gh auth login`. A shell
 * `GH_TOKEN`/`GITHUB_TOKEN` still wins.
 */
export function loadGithubTokenIntoEnv(): void {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return;
  const token = readConfig().githubToken;
  if (token) process.env.GH_TOKEN = token;
}

export function saveGithubToken(token: string): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...readConfig(), githubToken: token }, null, 2)}\n`, { mode: 0o600 });
  process.env.GH_TOKEN = token; // gh picks this up immediately
}

export function githubStatus(): { set: boolean; masked?: string } {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || readConfig().githubToken;
  if (!token) return { set: false };
  return { set: true, masked: token.length > 8 ? `${token.slice(0, 4)}…${token.slice(-4)}` : "set" };
}

/**
 * How runs authenticate. Default is "subscription" — an operator with a Claude Pro/Max plan
 * can run without any API credit, since the Claude Code CLI falls back to its OAuth login.
 * "apiKey" bills the Anthropic API wallet (a separate balance from the claude.ai subscription).
 */
export function getAuthMode(): AuthMode {
  return readConfig().authMode === "apiKey" ? "apiKey" : "subscription";
}

export function saveAuthMode(mode: AuthMode): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...readConfig(), authMode: mode }, null, 2)}\n`, { mode: 0o600 });
}

/** Resolve a `claude` executable — prefer a Homebrew/local install, else rely on PATH. */
function resolveClaudeBin(): string {
  for (const p of ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"]) {
    if (existsSync(p)) return p;
  }
  return "claude";
}

/** Validate the chosen auth mode against the real service so Setup can show a truthful status. */
export async function checkAuth(mode: AuthMode): Promise<AuthHealth> {
  return mode === "apiKey" ? checkApiKey() : checkSubscription();
}

async function checkApiKey(): Promise<AuthHealth> {
  const key = process.env.ANTHROPIC_API_KEY || readConfig().anthropicApiKey;
  if (!key) return { ok: false, status: "no API key set" };
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
    });
    if (res.ok) return { ok: true, status: "✓ API key valid — credits available" };
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    const msg = body.error?.message ?? `HTTP ${res.status}`;
    if (/credit balance/i.test(msg)) return { ok: false, status: "valid key, but no API credit — top up at console.anthropic.com" };
    if (res.status === 401) return { ok: false, status: "invalid API key" };
    return { ok: false, status: msg };
  } catch (e) {
    return { ok: false, status: `check failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Run a tiny prompt through the CLI with no API key, so a pass proves the OAuth session works. */
function checkSubscription(): Promise<AuthHealth> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; // force the CLI onto its stored subscription credentials
    execFile(resolveClaudeBin(), ["-p", "ok", "--model", "claude-haiku-4-5"], { env, timeout: 30000 }, (err, stdout) => {
      if (!err && stdout.trim()) return resolve({ ok: true, status: "✓ subscription active (Claude Pro/Max)" });
      const hint = err && "code" in err && err.code === "ENOENT" ? "claude CLI not found" : "not logged in — run `claude login` in a terminal";
      resolve({ ok: false, status: hint });
    });
  });
}
