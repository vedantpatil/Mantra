import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { ProjectRef } from "./shared.js";

const projectsPath = (): string => join(homedir(), ".mantra", "projects.json");

/**
 * The operator's project list, read from `~/.mantra/projects.json`:
 *   { "projects": [ { "id": "website", "name": "VPSTech Website", "repoPath": "/abs/path" } ] }
 * A lightweight stand-in for the full registry until the shell talks to a live Overseer.
 */
export function loadProjects(): ProjectRef[] {
  const path = projectsPath();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { projects?: ProjectRef[] };
    return parsed.projects ?? [];
  } catch {
    return [];
  }
}

function saveProjects(projects: readonly ProjectRef[]): void {
  const path = projectsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ projects }, null, 2)}\n`);
}

/** Add a project from the UI; derives a unique id from the name. Returns the updated list. */
export function addProject(name: string, repoPath: string): ProjectRef[] {
  const projects = loadProjects();
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  let id = base;
  for (let i = 2; projects.some((p) => p.id === id); i++) id = `${base}-${i}`;
  saveProjects([...projects, { id, name: name.trim(), repoPath }]);
  return loadProjects();
}

/** Remove a project by id from the UI. Returns the updated list. */
export function removeProject(id: string): ProjectRef[] {
  saveProjects(loadProjects().filter((p) => p.id !== id));
  return loadProjects();
}

/** Resolve a run target (project id/name or an absolute path) to a repo path. */
export function resolveTarget(target: string, projects: readonly ProjectRef[]): string | undefined {
  if (isAbsolute(target) && existsSync(target)) return target;
  const t = target.trim().toLowerCase();
  const hit = projects.find((p) => p.id.toLowerCase() === t || p.name.toLowerCase() === t);
  return hit?.repoPath;
}
