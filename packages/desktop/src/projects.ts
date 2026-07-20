import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ProjectRef } from "./shared.js";

/**
 * The operator's project list, read from `~/.mantra/projects.json`:
 *   { "projects": [ { "id": "website", "name": "VPSTech Website", "repoPath": "/abs/path" } ] }
 * A lightweight stand-in for the full registry until the shell talks to a live Overseer.
 */
export function loadProjects(): ProjectRef[] {
  const path = join(homedir(), ".mantra", "projects.json");
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { projects?: ProjectRef[] };
    return parsed.projects ?? [];
  } catch {
    return [];
  }
}

/** Resolve a run target (project id/name or an absolute path) to a repo path. */
export function resolveTarget(target: string, projects: readonly ProjectRef[]): string | undefined {
  if (isAbsolute(target) && existsSync(target)) return target;
  const t = target.trim().toLowerCase();
  const hit = projects.find((p) => p.id.toLowerCase() === t || p.name.toLowerCase() === t);
  return hit?.repoPath;
}
