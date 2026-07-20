import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGrant, taskId, agentId, projectId, decisionId, secretRef } from "@mantra/core";
import { CircuitBreaker, InProcessBus, Supervisor, decideTool, capabilityForBash, SqliteRegistry, FileTaskLog, EnvSecretProvider, envRef, defaultProjectConfig, resolveDualGraph } from "@mantra/orchestrator";

const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } else console.log("ok  ", msg); };

// 1. permission matrix (ADR-4 / §6)
assert(resolveGrant("developer", "editCode") === "allow", "developer may edit code");
assert(resolveGrant("developer", "fsDelete") === "deny", "developer may NOT rm");
assert(resolveGrant("devops", "sshDeploy") === "confirm", "devops deploy needs confirm");
assert(resolveGrant("marketer", "editCode") === "deny", "marketer may NOT edit code");

// 2. circuit breaker (ADR-4)
let tripped = null;
const b = new CircuitBreaker({ capUsd: 1, pricing: { inputPerMTok: 15, outputPerMTok: 75 }, onTrip: (r) => (tripped = r) });
b.record({ inputTokens: 100_000, outputTokens: 100_000 }); // ~$9 > $1 cap
assert(b.isTripped && tripped === "budget", "breaker trips on budget");
const b2 = new CircuitBreaker({ capUsd: 100, pricing: { inputPerMTok: 1, outputPerMTok: 1 }, loopThreshold: 3, onTrip: (r) => (tripped = r) });
b2.noteAction("x"); b2.noteAction("x"); b2.noteAction("x");
assert(b2.isTripped && tripped === "loop", "breaker trips on doom-loop");

// 3. lease reconciliation (ADR-5)
let clock = 1000;
const sup = new Supervisor(projectId("p1"), new InProcessBus(), () => clock);
const t = taskId("t1");
sup.createTask(t, "wire checkout", "manager");
assert(sup.snapshot()[0].state === "queued", "task starts queued");
sup.lease(t, agentId("dev1"));
assert(sup.snapshot()[0].state === "leased", "task leased");
clock += 10 * 60_000; // advance past lease TTL — simulate agent crash
const requeued = sup.reconcile();
assert(requeued.length === 1 && sup.snapshot()[0].state === "queued", "crashed task auto-requeued");

// 4. tool → capability → grant decisions (ADR-4, drives AgentRunner canUseTool)
assert(decideTool("developer", "Read", {}).grant === "allow", "developer Read allowed");
assert(decideTool("marketer", "Write", {}).grant === "deny", "marketer Write denied");
assert(capabilityForBash("rm -rf build") === "fsDelete", "rm -rf classified fsDelete");
assert(decideTool("developer", "Bash", { command: "rm -rf build" }).grant === "deny", "developer rm denied outright (no grant)");
assert(decideTool("devops", "Bash", { command: "ssh host 'docker compose up'" }).grant === "confirm", "devops ssh deploy needs confirm");
assert(decideTool("developer", "Bash", { command: "npm test" }).capability === "editCode", "generic bash → editCode");

// 5. SQLite registry round-trip (ADR-6)
const reg = new SqliteRegistry(":memory:");
reg.setGlobal({ defaultApiKeyRef: secretRef("vault://global"), globalDailyBudget: 30, schemaVersion: 1 });
assert((await reg.getGlobal()).globalDailyBudget === 30, "registry global persisted");
await reg.putProject({
  id: projectId("p1"), name: "CareerFlint", path: "/tmp/cf", portRange: [3000, 3099],
  webPort: 3000, apiPort: 8000, dailyBudget: 8, stage: "build", crewTemplate: "saas",
  dualGraph: { enabled: true }, schemaVersion: 1,
});
const got = await reg.getProject(projectId("p1"));
assert(got?.name === "CareerFlint" && got.portRange[1] === 3099 && got.dualGraph.enabled === true, "project round-trips through SQLite");
await reg.putDecision({ id: decisionId("d1"), projectId: projectId("p1"), type: "deploy", title: "Deploy", summary: "x", risk: "high", options: ["hold", "deploy"], status: "open" });
assert((await reg.listOpenDecisions()).length === 1, "open decision listed");
await reg.resolveDecision(decisionId("d1"));
assert((await reg.listOpenDecisions()).length === 0, "decision resolved");
reg.close();

// 6. task log persists to .mantra/state and survives a restart (ADR-5)
const repo = mkdtempSync(join(tmpdir(), "mantra-"));
try {
  let clock2 = 1000;
  const persisted = new Supervisor(projectId("p1"), new InProcessBus(), () => clock2, new FileTaskLog(repo));
  const tk = taskId("t9");
  persisted.createTask(tk, "persisted task", "manager");
  persisted.lease(tk, agentId("dev1"));
  // Simulate a process restart: replay the on-disk log into a fresh supervisor.
  const events = new FileTaskLog(repo).replay();
  assert(events.length === 2, "two events persisted to tasks.jsonl");
  const restored = new Supervisor(projectId("p1"), new InProcessBus(), () => clock2);
  restored.hydrate(events);
  assert(restored.snapshot()[0].state === "leased", "task state restored from disk after restart");
} finally {
  rmSync(repo, { recursive: true, force: true });
}

// 7. env secret provider (ADR-3)
process.env.MANTRA_TEST_KEY = "sk-test-123";
const sp = new EnvSecretProvider();
assert((await sp.resolve(envRef("MANTRA_TEST_KEY"))) === "sk-test-123", "env secret resolves");
let rejected = false;
try { await sp.resolve("vault://x"); } catch { rejected = true; }
assert(rejected, "non-env ref rejected");

// 8. project config + dual-graph resolution (FR-13a / ADR-11)
const cfg = defaultProjectConfig("website");
assert(cfg.dualGraph.enabled === true && cfg.dailyBudget === 2, "default config sane");
const cfgWithCmd = { ...cfg, dualGraph: { enabled: true, command: "dual-graph-mcp" } };
const dg = resolveDualGraph(cfgWithCmd, "/repo/x", false);
assert(dg?.command === "dual-graph-mcp", "dual-graph resolves explicit command");
assert(dg?.args?.[0] === "--stdio", "dual-graph default args --stdio");
assert(dg?.env?.DG_DATA_DIR === "/repo/x/.dual-graph" && dg?.env?.DUAL_GRAPH_PROJECT_ROOT === "/repo/x", "per-repo env auto-derived");
assert(resolveDualGraph(cfgWithCmd, "/repo/x", true) === undefined, "--no-graph disables dual-graph");
assert(resolveDualGraph({ ...cfg, dualGraph: { enabled: false } }, "/repo/x", false) === undefined, "disabled config → no dual-graph");

console.log("\nAll smoke checks passed ✓");
