import { resolveGrant, taskId, agentId, projectId } from "@mantra/core";
import { CircuitBreaker, InProcessBus, Supervisor } from "@mantra/orchestrator";

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

console.log("\nAll smoke checks passed ✓");
