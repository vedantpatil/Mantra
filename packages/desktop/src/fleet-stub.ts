import type { FleetProject, FleetSnapshot, ReviewItem } from "./shared.js";
import { loadProjects } from "./projects.js";

/**
 * Builds the fleet view from the operator's real registered projects
 * (`~/.mantra/projects.json`) plus live review state. Until live agent status is
 * streamed from a running Overseer, registered projects show as `ready`.
 */
export function buildFleet(reviews: readonly ReviewItem[]): FleetSnapshot {
  const projects: FleetProject[] = loadProjects().map((p) => {
    const inReview = reviews.filter((r) => r.repoPath === p.repoPath).length;
    return {
      id: p.id,
      name: p.name,
      health: inReview > 0 ? "busy" : "ok",
      port: 0,
      stage: inReview > 0 ? "review" : "ready",
      stageIndex: inReview > 0 ? 3 : 0,
      agents: inReview > 0 ? [{ role: "Crew", badge: "M", task: `${inReview} task(s) awaiting your review`, status: "gate" }] : [],
    };
  });

  return {
    projects,
    decisions: [],
    agents: 0,
    needYou: reviews.length,
    spendToday: 0,
    budget: 10,
  };
}
