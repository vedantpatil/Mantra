import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGrant, taskId, agentId, projectId, decisionId, secretRef } from "@mantra/core";
import { CircuitBreaker, InProcessBus, Supervisor, decideTool, capabilityForBash, SqliteRegistry, FileTaskLog, EnvSecretProvider, envRef, defaultProjectConfig, resolveDualGraph, Coordinator, HeuristicPlanner, parseTaskList, Effector, runShip, OpsMonitor, MemoryAuditLog } from "@mantra/orchestrator";

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

// 9. P2 crew coordination (FR-9/10, ADR-5/8) — the highest-risk piece
const plan = (tasks) => ({ decompose: async () => tasks });
const exec = (fn) => ({ execute: async (t) => fn(t) });
const verifier = (fn) => ({ verify: async (t) => fn(t) });
const newSup = (sink) => new Supervisor(projectId("crew"), new InProcessBus(), () => Date.now(), sink);

// 9a. happy path: dev task executes, QA passes → review
{
  const sup = newSup();
  const c = new Coordinator(sup, plan([{ title: "impl", role: "developer" }]), exec(() => ({ ok: true, note: "done" })), { verify: verifier(() => ({ pass: true, note: "ok" })) });
  const r = await c.runGoal("add form", "manager");
  assert(r.review.length === 1 && r.failed.length === 0 && r.review[0].state === "review", "crew: dev+QA pass → review");
}

// 9b. QA rejects once, then passes → requeue then review (attempts tracked)
{
  const sup = newSup();
  let vc = 0;
  const c = new Coordinator(sup, plan([{ title: "impl", role: "developer" }]), exec(() => ({ ok: true, note: "done" })), { verify: verifier(() => ({ pass: ++vc > 1, note: "v" })) });
  const r = await c.runGoal("add form", "manager");
  assert(r.review.length === 1 && r.review[0].attempts === 1, "crew: QA reject→requeue→pass→review (1 attempt)");
}

// 9c. doom-loop cap: executor always fails → task fails after maxAttempts (termination proof)
{
  const sup = newSup();
  const c = new Coordinator(sup, plan([{ title: "bad", role: "developer" }]), exec(() => ({ ok: false, note: "boom" })), { maxAttempts: 2 });
  const r = await c.runGoal("break", "manager");
  assert(r.failed.length === 1 && r.review.length === 0 && r.failed[0].state === "failed", "crew: doom-loop capped → failed (terminates)");
}

// 9d. resumability: the event log fully reconstructs coordination state
{
  const repo2 = mkdtempSync(join(tmpdir(), "mantra-crew-"));
  try {
    const sink = new FileTaskLog(repo2);
    const sup = newSup(sink);
    const c = new Coordinator(sup, plan([{ title: "impl", role: "developer" }, { title: "qa", role: "qa" }]), exec(() => ({ ok: true, note: "done" })));
    await c.runGoal("ship", "manager");
    const restored = newSup();
    restored.hydrate(new FileTaskLog(repo2).replay());
    assert(restored.tasksInState("review").length === 2, "crew: state fully restored from event log after restart");
  } finally {
    rmSync(repo2, { recursive: true, force: true });
  }
}

// 9e. heuristic planner default (Manager-less) → dev + qa tasks
{
  const tasks = await new HeuristicPlanner().decompose("add a contact form");
  assert(tasks.length === 2 && tasks[0].role === "developer" && tasks[1].role === "qa", "heuristic planner → developer + qa");
}

// 9f. review-gate resolve round-trip (FR-14, ADR-8): approve persists across restart
{
  const repo3 = mkdtempSync(join(tmpdir(), "mantra-rev-"));
  try {
    const s1 = newSup(new FileTaskLog(repo3));
    const c = new Coordinator(s1, plan([{ title: "impl", role: "developer" }]), exec(() => ({ ok: true, note: "ok" })));
    await c.runGoal("x", "manager");
    // main.ts approve path: hydrate a fresh supervisor (with sink), approve the review task.
    const s2 = newSup(new FileTaskLog(repo3));
    s2.hydrate(new FileTaskLog(repo3).replay());
    const rev = s2.tasksInState("review")[0];
    assert(rev !== undefined, "review task present after crew");
    s2.approve(rev.id);
    // a third hydrate must see it done — the approval was persisted.
    const s3 = newSup();
    s3.hydrate(new FileTaskLog(repo3).replay());
    assert(s3.tasksInState("done").length === 1 && s3.tasksInState("review").length === 0, "approve persists across restart → done");
  } finally {
    rmSync(repo3, { recursive: true, force: true });
  }
}

// 10. Manager decomposition parsing (FR-9) — defensive against real model output
{
  const good = parseTaskList('Here is the plan:\n[{"title":"Add form","role":"developer"},{"title":"Test form","role":"qa"}]\nDone.');
  assert(good.length === 2 && good[0].role === "developer" && good[1].role === "qa", "planner parses prose-wrapped JSON");
  const badRole = parseTaskList('[{"title":"x","role":"wizard"}]');
  assert(badRole.length === 1 && badRole[0].role === "developer", "unknown role → developer");
  assert(parseTaskList("no json here").length === 0, "no JSON → empty (triggers fallback)");
  assert(parseTaskList("[not valid json").length === 0, "malformed JSON → empty");
  assert(parseTaskList('[{"role":"qa"}]').length === 0, "item without title dropped");
}

// 11. Ship pipeline gates (P4) — deterministic core proven with a fake GitHost + confirmer.
{
  // A scripted GitHost: ciStatus walks a given sequence; the last value repeats.
  const fakeHost = (ciSeq) => {
    let i = 0, merged = false;
    return {
      merged: () => merged,
      openPr: async () => ({ number: 7, url: "https://example/pr/7" }),
      ciStatus: async () => ciSeq[Math.min(i++, ciSeq.length - 1)],
      merge: async () => { merged = true; },
    };
  };
  const confirmer = (ok) => ({ confirm: async () => ok });
  const effector = (ok) => new Effector(new EnvSecretProvider(), confirmer(ok));
  const fast = { intervalMs: 0, maxAttempts: 4 };
  const baseOpts = { repoPath: "/tmp/x", branch: "feat", title: "t", role: "devops" };

  // green after one pending → merges.
  {
    const host = fakeHost(["pending", "success"]);
    const r = await runShip({ ...baseOpts, host, effector: effector(true), ci: fast });
    assert(r.ok && r.stage === "done" && r.merged && host.merged(), "ship: CI green → auto-merged");
  }
  // red CI → never merges (the gate).
  {
    const host = fakeHost(["pending", "failure"]);
    const r = await runShip({ ...baseOpts, host, effector: effector(true), ci: fast });
    assert(!r.ok && r.stage === "ci" && !r.merged && !host.merged(), "ship: CI red → NOT merged (gate holds)");
  }
  // stays pending → gives up without merging.
  {
    const host = fakeHost(["pending"]);
    const r = await runShip({ ...baseOpts, host, effector: effector(true), ci: fast });
    assert(!r.ok && r.stage === "ci" && !host.merged(), "ship: CI never green → gives up, no merge");
  }
  // autoMerge false + green → stops at a green PR, unmerged but ok.
  {
    const host = fakeHost(["success"]);
    const r = await runShip({ ...baseOpts, host, effector: effector(true), autoMerge: false, ci: fast });
    assert(r.ok && r.stage === "merge" && !r.merged && !host.merged(), "ship: --no-merge → green PR left for manual merge");
  }
  // deploy requested + confirm APPROVED → deploys after merge.
  {
    const host = fakeHost(["success"]);
    const r = await runShip({ ...baseOpts, host, effector: effector(true), deploy: { env: "staging" }, ci: fast });
    assert(r.ok && r.stage === "done" && r.merged && r.deployed, "ship: deploy confirmed → merged + deployed");
  }
  // deploy requested + confirm DECLINED → merged but deploy aborted (human gate, ADR-2).
  {
    const host = fakeHost(["success"]);
    const r = await runShip({ ...baseOpts, host, effector: effector(false), deploy: { env: "staging" }, ci: fast });
    assert(!r.ok && r.stage === "deploy" && r.merged && !r.deployed, "ship: deploy declined → merged, NOT deployed");
  }
  // role without gitPush grant → aborts at push before any PR (permission matrix, ADR-4).
  {
    const host = fakeHost(["success"]);
    const r = await runShip({ ...baseOpts, role: "marketer", host, effector: effector(true), ci: fast });
    assert(!r.ok && r.stage === "push" && !host.merged(), "ship: role denied gitPush → aborts at push");
  }
}

// 12. Ops agent triage (P5) — deterministic monitor→triage→escalate, proven with scripted probes.
{
  // A probe that walks a scripted list of statuses; the last value repeats.
  const scriptProbe = (name, statuses) => {
    let i = 0;
    return { name, check: async () => ({ status: statuses[Math.min(i++, statuses.length - 1)] }) };
  };
  // Run N ticks, collecting every event; returns the flat event list.
  const drive = async (mon, ticks) => {
    const all = [];
    for (let k = 0; k < ticks; k++) all.push(...(await mon.tick()));
    return all;
  };
  const count = (evs, type) => evs.filter((e) => e.type === type).length;

  // single blip → never escalates (debounce).
  {
    const mon = new OpsMonitor({ probes: [scriptProbe("web", ["critical", "ok", "ok"])] });
    const evs = await drive(mon, 3);
    assert(count(evs, "escalated") === 0 && mon.incidents().length === 0, "ops: single blip → no escalation (debounce)");
  }
  // two consecutive criticals → escalate once; further criticals suppressed (cooldown).
  {
    const mon = new OpsMonitor({ probes: [scriptProbe("web", ["critical", "critical", "critical", "critical"])] });
    const evs = await drive(mon, 4);
    assert(count(evs, "escalated") === 1 && mon.incidents().length === 1, "ops: sustained critical → escalate once, then suppress");
  }
  // recovery → the open incident resolves and clears.
  {
    const mon = new OpsMonitor({ probes: [scriptProbe("web", ["critical", "critical", "ok"])] });
    const evs = await drive(mon, 3);
    assert(count(evs, "escalated") === 1 && count(evs, "resolved") === 1 && mon.incidents().length === 0, "ops: recovery → incident resolved");
  }
  // warn debounces at 3 (not 2).
  {
    const mon = new OpsMonitor({ probes: [scriptProbe("web", ["warn", "warn", "warn"])] });
    const evs = await drive(mon, 3);
    assert(count(evs, "escalated") === 1 && mon.incidents()[0].severity === "warn", "ops: warn escalates at threshold 3");
  }
  // severity upgrade → warn incident re-escalates as critical.
  {
    const mon = new OpsMonitor({ probes: [scriptProbe("web", ["warn", "warn", "warn", "critical", "critical"])] });
    const evs = await drive(mon, 5);
    const ups = evs.filter((e) => e.type === "escalated" && e.upgraded);
    assert(count(evs, "escalated") === 2 && ups.length === 1 && mon.incidents()[0].severity === "critical", "ops: warn→critical upgrade re-escalates");
  }
  // escalation + resolution are written to the audit trail (FR-24).
  {
    const audit = new MemoryAuditLog();
    const mon = new OpsMonitor({ probes: [scriptProbe("web", ["critical", "critical", "ok"])], audit, project: "web" });
    await drive(mon, 3);
    const kinds = audit.entries().map((e) => e.kind);
    assert(kinds.includes("ops.escalated") && kinds.includes("ops.resolved"), "ops: escalation + resolution audited");
  }
  // a throwing probe is itself treated as critical.
  {
    const throwing = { name: "db", check: async () => { throw new Error("no route to host"); } };
    const mon = new OpsMonitor({ probes: [throwing] });
    const evs = await drive(mon, 2);
    assert(count(evs, "probe-error") === 2 && count(evs, "escalated") === 1, "ops: probe error → critical → escalates");
  }
}

console.log("\nAll smoke checks passed ✓");
