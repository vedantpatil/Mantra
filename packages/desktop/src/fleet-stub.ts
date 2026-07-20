import type { FleetSnapshot } from "./shared.js";

/**
 * Illustrative fleet snapshot mirroring the design mockup, served over IPC until the
 * shell is wired to a live Overseer + `SqliteRegistry`. TODO(P2): source from registry.
 */
export const FLEET: FleetSnapshot = {
  agents: 11,
  needYou: 2,
  spendToday: 18.4,
  budget: 30,
  projects: [
    {
      id: "careerflint", name: "CareerFlint", health: "ok", port: 3000, stage: "review", stageIndex: 3,
      agents: [
        { role: "Manager", badge: "M", task: "funnel change decomposed → 4 tasks", status: "run" },
        { role: "Developer", badge: "D", task: "diff ready · tests 10/10", status: "gate" },
      ],
    },
    {
      id: "northwind", name: "Northwind", health: "busy", port: 3100, stage: "build", stageIndex: 2,
      agents: [
        { role: "Marketer", badge: "K", task: "drafting 4 ad variants + landing copy", status: "run" },
        { role: "Developer", badge: "D", task: "wiring checkout", status: "run" },
      ],
    },
    {
      id: "helios", name: "Helios API", health: "blk", port: 3200, stage: "blocked", stageIndex: 2, blocked: true,
      agents: [
        { role: "Developer", badge: "D", task: "migration conflict — escalated to you", status: "block" },
      ],
    },
    {
      id: "datapipe", name: "Data Pipe", health: "ok", port: 3300, stage: "operate", stageIndex: 5,
      agents: [
        { role: "Ops", badge: "O", task: "live · watching nightly run · all green", status: "run" },
      ],
    },
  ],
  decisions: [
    {
      id: "helios-migration", project: "Helios API", critical: true,
      title: "Migration wants to drop users.legacy_id",
      summary: "Dev paused — irreversible. Approve, skip column, or inspect?",
      actions: ["Skip col", "Inspect", "Approve"],
    },
    {
      id: "careerflint-deploy", project: "CareerFlint", critical: false,
      title: "Deploy funnel change to production",
      summary: "Diff approved · tests 10/10 · DevOps staged.",
      actions: ["Hold", "Deploy"],
    },
  ],
};
