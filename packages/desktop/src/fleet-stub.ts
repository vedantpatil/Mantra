import type { ActiveRun, FleetAgent, FleetProject, FleetSnapshot, OpsIncident, ReviewItem } from "./shared.js";
import { loadProjects } from "./projects.js";

/**
 * Builds the fleet view from the operator's real registered projects
 * (`~/.mantra/projects.json`) plus live run + review + Ops-incident state. Precedence:
 * a project with a critical open incident shows `blk` (blocked); else `busy` while a run
 * executes; else `review` if tasks await the gate; else `ready`. All three inputs are
 * streamed from main as they change (fleet-changed / incidents-changed).
 */
export function buildFleet(
  reviews: readonly ReviewItem[],
  activeRuns: readonly ActiveRun[] = [],
  incidents: readonly OpsIncident[] = [],
): FleetSnapshot {
  const projects: FleetProject[] = loadProjects().map((p) => {
    const running = activeRuns.filter((r) => r.repoPath === p.repoPath);
    const inReview = reviews.filter((r) => r.repoPath === p.repoPath).length;
    const openIncidents = incidents.filter((i) => i.repoPath === p.repoPath);
    const critical = openIncidents.some((i) => i.severity === "critical");

    const AGENT_OF = {
      crew: { role: "Crew", badge: "C" },
      ship: { role: "Ship", badge: "S" },
      run: { role: "Dev", badge: "D" },
    } as const;
    const runningAgents: FleetAgent[] = running.map((r) => ({ ...AGENT_OF[r.kind], task: r.task, status: "run" }));
    const reviewAgent: FleetAgent[] =
      inReview > 0 ? [{ role: "Crew", badge: "M", task: `${inReview} task(s) awaiting your review`, status: "gate" }] : [];
    const incidentAgents: FleetAgent[] = openIncidents.map((i) => ({
      role: "Ops", badge: "O", task: `${i.probe}: ${i.note ?? i.severity}`, status: i.severity === "critical" ? "block" : "gate",
    }));

    const isRunning = running.length > 0;
    return {
      id: p.id,
      name: p.name,
      health: critical ? "blk" : isRunning || inReview > 0 ? "busy" : "ok",
      port: 0,
      blocked: critical,
      stage: critical ? "incident" : isRunning ? running[0].kind : inReview > 0 ? "review" : "ready",
      // lifecycle bar: incident flags the current dot, ship near the end (4), other runs (2), gate (3), idle (0).
      stageIndex: critical ? 5 : isRunning ? (running[0].kind === "ship" ? 4 : 2) : inReview > 0 ? 3 : 0,
      agents: [...incidentAgents, ...runningAgents, ...reviewAgent],
    };
  });

  return {
    projects,
    decisions: [],
    agents: activeRuns.length,
    needYou: reviews.length + incidents.length,
    spendToday: 0,
    budget: 10,
  };
}
