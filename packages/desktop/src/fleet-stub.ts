import type { ActiveRun, FleetAgent, FleetProject, FleetSnapshot, ReviewItem } from "./shared.js";
import { loadProjects } from "./projects.js";

/**
 * Builds the fleet view from the operator's real registered projects
 * (`~/.mantra/projects.json`) plus live run + review state. A project with an active
 * run shows as `busy` with its running agent(s); otherwise `review` if tasks await the
 * gate, else `ready`. `activeRuns` is streamed from main as runs start/finish.
 */
export function buildFleet(reviews: readonly ReviewItem[], activeRuns: readonly ActiveRun[] = []): FleetSnapshot {
  const projects: FleetProject[] = loadProjects().map((p) => {
    const running = activeRuns.filter((r) => r.repoPath === p.repoPath);
    const inReview = reviews.filter((r) => r.repoPath === p.repoPath).length;

    const runningAgents: FleetAgent[] = running.map((r) =>
      r.kind === "crew"
        ? { role: "Crew", badge: "C", task: r.task, status: "run" }
        : { role: "Dev", badge: "D", task: r.task, status: "run" },
    );
    const reviewAgent: FleetAgent[] =
      inReview > 0 ? [{ role: "Crew", badge: "M", task: `${inReview} task(s) awaiting your review`, status: "gate" }] : [];

    const isRunning = running.length > 0;
    return {
      id: p.id,
      name: p.name,
      health: isRunning || inReview > 0 ? "busy" : "ok",
      port: 0,
      stage: isRunning ? (running[0].kind === "crew" ? "crew" : "running") : inReview > 0 ? "review" : "ready",
      // lifecycle bar: running mid-flight (2), at the gate (3), idle (0).
      stageIndex: isRunning ? 2 : inReview > 0 ? 3 : 0,
      agents: [...runningAgents, ...reviewAgent],
    };
  });

  return {
    projects,
    decisions: [],
    agents: activeRuns.length,
    needYou: reviews.length,
    spendToday: 0,
    budget: 10,
  };
}
