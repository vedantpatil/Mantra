# Mantra — Requirements & Design

> Enterprise control plane for running a **fleet of Claude Code projects**, each staffed by a **crew of specialist agents**, driven by **voice or a terminal command console**, operated by **one person**.

Status: `draft v1` · Owner: Vedant · Last updated: 2026-07-20

---

## 1. Problem & Goal

One operator runs several software projects at once. Doing the work isn't the bottleneck — **human attention is**. Mantra lets a single person create, build, ship, deploy, and support many projects by supervising **autonomous agent crews** and being interrupted only for the few decisions a human must actually make.

**North-star:** the operator spends their time approving *forks* (merge / deploy / DB change / spend), not doing or babysitting the work.

### Non-goals (v1)
- Not a multi-tenant SaaS. Single-user, runs on the operator's own machine/server.
- Not a general chat UI. It's a control plane over Claude Code, not a replacement for it.
- No fine-tuning / custom model training. Uses hosted Claude models via the Agent SDK.
- No web-scale RBAC/SSO in v1 (single owner; per-agent scoping only).

---

## 2. Core Concepts

| Term | Meaning |
|---|---|
| **Overseer** | Tier-0 master orchestrator. One, always-on. Owns global registry, routes voice, enforces global budget, health-monitors & restarts project supervisors. |
| **Project Supervisor** | Tier-1. One per project. Spawned inside the repo; manages that project's crew, ports, budget, permissions. Config lives in the repo's `.mantra/`. |
| **Agent (crew member)** | Tier-2. A Claude Code / Agent SDK session with a role, model tier, tool set, and permission scope. Roles: Manager, Developer, QA, DevOps, Marketer, (Ops — future). |
| **Decision** | A gate that requires the human: approve diff, confirm deploy, approve DB change, approve hotfix, budget override. Surfaced in one cross-project **Decisions queue**. |
| **Registry** | System-owned config store: project list, port allocations, budgets, secret refs, audit log. |

### Agent hierarchy
```
Overseer (Tier 0, always-on)
 ├─ Supervisor: CareerFlint ── Manager · Developer · QA · DevOps
 ├─ Supervisor: Northwind  ── Manager · Marketer · Developer · QA
 └─ Supervisor: Helios API ── Manager · Developer
```
Scope never leaks: an agent can only act inside its own project.

---

## 3. Personas & Key UX Principle

**Persona:** solo founder/operator running 3–8 projects. Technical, time-poor, cost-conscious.

**Principle — protect attention.** Autonomy is the default; a hard gate exists *only* at irreversible forks. Every surface is ranked by "what needs a human," highest-risk first. The Decisions queue is the operator's primary inbox.

**Principle — dual input, one intent model.** Voice is the primary, ambient control surface, but every operation is *equally* reachable through a **terminal command console** (typed text + `/commands`). Neither is a second-class fallback: voice for hands-free/ambient flow, the console for precise syntax, noisy environments, accessibility, scripting, and debugging. Both feed the *same* intent router and produce the *same* actions and audit entries — there is no capability that exists in one modality but not the other.

---

## 4. Lifecycle (the product spine)

Every project moves through 7 stages. **Bold = agent acts autonomously; "You" = human gate.**

| # | Stage | Who | Human gate? |
|---|---|---|---|
| 1 | Create | You + **Overseer** (detect stack, assign ports, budget, crew) | setup only |
| 2 | Plan | **Manager** decomposes goal → tasks | no |
| 3 | Build | **Developer** writes · **QA** checks | no |
| 4 | Review | **You** approve the diff | **yes** |
| 5 | Ship · git | **Developer** → PR + CI, auto-merge on green | no |
| 6 | Deploy · server | **DevOps** (deploy guard) | **yes** (confirm) |
| 7 | Operate | **Ops** watches, triages, drafts fix, escalates | **yes** (approve hotfix) |

---

## 5. Functional Requirements

### 5.1 Master control (Overseer)
- FR-1 Fleet view: all projects, live agent status, per-project lifecycle stage.
- FR-2 **Decisions queue**: cross-project inbox of open human gates with inline actions (Approve / Skip / Inspect / Deploy / Hold). Voice: "what needs me?" reads it aloud.
- FR-3 Global monitor: daily spend vs budget, host CPU/RAM, agent count.
- FR-4 Auto-restart any crashed supervisor/agent (self-healing supervisor pattern).

### 5.2 Project view
- FR-5 **Interactive mind-map**: root = goal, branches = crew, leaves = tasks (state-colored).
- FR-6 **Inspector**: click a node → model, token spend, permissions, live action log, controls (Message / Pause / Reassign).
- FR-7 Task board (Backlog / Doing / Review / Done) with per-task assignee.
- FR-8 Live activity feed of agent actions.

### 5.3 Agents & orchestration
- FR-9 Manager agent decomposes a goal into tasks and delegates to specialists.
- FR-10 Agents hand work off via a shared per-project task queue.
- FR-11 Each agent = one Agent SDK session with role system-prompt, model tier, tool allow-list, cwd = project dir, resumable by session id.
- FR-12 Agents escalate blockers to the human rather than guessing.

### 5.4 Lifecycle actions
- FR-13 Create project: from existing repo or blank; detect stack; auto-assign conflict-free port range; set budget; pick crew template; write `.mantra/`.
- FR-13a **Auto-provision the dual-graph context package** (local MCP context-retrieval server) into every new project's `.mantra/`, enabled by default. Agents call it before file exploration so they read *recommended* files/symbols instead of grepping broadly — directly cutting Claude Code token spend. Scans the repo on create, refreshes incrementally on edits, and stores its graph + context under `.mantra/` (never secrets). Operator can disable per project.
- FR-14 Review gate: show diff + QA verdict + Manager risk summary; Approve / Request changes.
- FR-15 Ship: open PR, run CI (lint/typecheck/tests/build), auto-merge on green.
- FR-16 Deploy: **deploy guard** (block if a batch/daily job is running) → one confirm → ssh/docker deploy → health check → notify + tag. Rollback plan available.
- FR-17 Operate (future): Ops agent monitors uptime/latency/errors/logs; on incident triages, root-causes, drafts hotfix, escalates as a SEV with one-tap approve.

### 5.5 Voice input
- FR-18 Wake word ("Hey Mantra") + push-to-talk (⌥Space).
- FR-19 Speech→text; route command to the right project/agent by intent.
- FR-20 Voice is **intent**, not literal syntax — the target agent resolves specifics.
- FR-21 Spoken confirmations for gates ("approve it", "deploy CareerFlint").
- FR-21a Voice and the command console (5.7) share **one intent router** — every voiced action has an identical typed equivalent, and vice versa.

### 5.6 Governance & config (system-owned)
- FR-22 Registry: projects, port allocations, budgets, secret refs, audit log.
- FR-23 Per-role permission matrix with per-project override (e.g. Marketer can't touch code; only DevOps deploys, with confirm).
- FR-24 Per-agent + per-project **spend caps**; **circuit breaker** kills any agent that loops past budget.
- FR-25 Secrets stored as vault references, never values.
- FR-25a **Claude Code / Anthropic API key is scope-configurable**: a **generic (global)** key in the registry is the default for the whole fleet, with an optional **per-project override** in that repo's `.mantra/` (e.g. a project billed to a different account/org). Resolution is project → global; agents inherit their project's effective key. Stored as vault references (per FR-25), never raw values; changing the key never requires editing agent config.
- FR-26 Full audit log: every agent action (who / what / when).

---

### 5.7 Command console (terminal UI)
A toggleable terminal-style console — the typed peer of voice. Openable any time (global hotkey, e.g. ⌘K / ` `` `), dockable in the shell or detachable as a floating pane. Not a raw shell into the host; it's a command surface over the same Overseer intent router.
- FR-27 **Text command bar**: type any operation in natural language (same intent parsing as voice) *or* as an explicit `/command`. Autocomplete, history (↑/↓), and fuzzy search over commands.
- FR-28 **`/commands` for every operation**, e.g. `/create <repo>`, `/plan <project>`, `/approve <decision>`, `/deploy <project>`, `/pause <agent>`, `/message <agent> "<text>"`, `/queue` (Decisions), `/budget`, `/logs <agent>`, `/status`. Every human gate and lifecycle action has a slash command.
- FR-29 **Target scoping**: commands can be scoped to a project/agent by prefix or current context (`@CareerFlint /deploy`); ambiguous targets prompt for disambiguation inline.
- FR-30 **Streamed textual output**: agent activity feed, action logs, and confirmations render inline in the console (readable transcript), so the console doubles as a text mirror of what voice reads aloud.
- FR-31 **Gate confirmations by keystroke**: irreversible ops surface an inline confirm in the console (typed `y`/`/confirm`), equivalent to the spoken confirmation in FR-21.
- FR-32 Console and voice are **interchangeable mid-flow**: start by voice, finish by typing (or the reverse); shared session context and one unified audit trail regardless of modality.

## 6. Permission Model (default matrix)

| Role | Read | Edit code | git push | ssh deploy | DB / rm | Spend cap |
|---|---|---|---|---|---|---|
| Manager | ✓ | — | — | — | — | $10/day |
| Developer | ✓ | ✓ | ✓ | — | — | $8/day |
| QA | ✓ | tests only | — | — | — | $4/day |
| DevOps | ✓ | — | ✓ | confirm | confirm | $3/day |
| Marketer | docs only | — | — | — | — | $3/day |

Irreversible ops (`ssh deploy`, `rm`, DB drop) are **always** human-confirmed regardless of role.

---

## 7. Architecture

```
┌─────────────────────────────────────────────┐
│  Desktop shell (UI)   — fleet, mind-map, queue │
│  Voice layer          — wake word + STT        │
│  Command console      — text bar + /commands   │
│      ↓ both feed one intent router ↓           │
├─────────────────────────────────────────────┤
│  Overseer (orchestrator process)               │
│   • registry (SQLite)  • voice router          │
│   • budget/breaker     • health supervisor     │
├─────────────────────────────────────────────┤
│  Project Supervisor × N  (one per repo)        │
│   • crew manager  • task queue  • .mantra/    │
├─────────────────────────────────────────────┤
│  Agents × M  →  Claude Agent SDK (headless)    │
│   claude -p, stream-json, resumable sessions   │
└─────────────────────────────────────────────┘
```

- **Claude integration:** each agent is a headless Claude Code session via the **Claude Agent SDK** (TypeScript). Per-agent: system prompt (role), model, allowed tools, `cwd`, permission mode, MCP servers, hooks. Sessions are resumable by id.
- **Coordination:** Manager writes tasks to a per-project queue; specialists claim/complete; state persisted so a crash resumes cleanly.
- **Self-healing:** Overseer supervises supervisors; supervisors supervise agents. Crash → restart with resumed session. (Same pattern as the operator's existing enrichment supervisor.)

### 7.1 Recommended tech stack (revisit before phase 3)
- **Shell/UI:** Electron + TypeScript + React for MVP speed (one language end-to-end; Agent SDK is TS-native). Migration target: Tauri if footprint matters at scale.
- **Orchestrator:** Node/TypeScript, `@anthropic-ai/claude-agent-sdk`.
- **Store:** SQLite (`~/.mantra/registry.db`) for registry/audit; per-project state in `.mantra/`.
- **Voice:** Porcupine (wake word) + `whisper.cpp` local STT (0-cost, private); cloud Whisper fallback.
- **Context/token saver:** each project ships a **dual-graph MCP** (local context-retrieval server) in `.mantra/`; agents retrieve recommended files/symbols instead of broad grep/exploration, cutting tokens per task.
- **API key:** resolved per-agent as project override → global default (see FR-25a), stored as a vault reference.
- **Cost control:** cheaper roles (QA/DevOps/Marketer) on Sonnet/Haiku; Manager/Developer on Opus where it pays off.

---

## 8. Data Model (sketch)

```
Global   { defaultApiKeyRef, globalDailyBudget, ... }  /* registry-level fleet defaults */
Project { id, name, path, portRange, webPort, apiPort, dailyBudget, stage, crewTemplate, apiKeyRef?, dualGraph:{enabled} }
Agent   { id, projectId, role, model, sessionId, status, tokensToday, spendToday, permissions }
Task    { id, projectId, title, assigneeAgentId, state, priority, createdBy }
Decision{ id, projectId, type, title, summary, risk, options[], status }
Audit   { id, ts, projectId, agentId, action, target, result }
Secret  { id, projectId, key, ref /* vault reference, never value */ }
```

`.mantra/` (per repo): `config.json` (crew, ports, budget, permissions, optional `apiKeyRef`), `state/` (task queue, session ids), `graph/` (dual-graph context store), never secrets.

---

## 9. MVP Phasing

| Phase | Scope | Rough effort |
|---|---|---|
| **P1 — Spine** | Overseer + registry + 1 project + single agent (Developer) + push-to-talk + **command console (text bar + core `/commands`)** + activity feed | ~1.5 wks |
| **P2 — Crew** | Manager→Developer→QA delegation, task queue, task board, review gate | ~3 wks |
| **P3 — Fleet** | Multi-project master view, Decisions queue, budget + circuit breaker, mind-map | ~3 wks |
| **P4 — Lifecycle** | Create wizard, ship (PR/CI), deploy (guard+confirm+health), DevOps + Marketer roles, permission matrix | ~3 wks |
| **P5 — Ops & hardening** | Ops agent (monitor→triage→escalate), wake word, secrets vault, audit, crash recovery | ~3 wks |

**Highest risk = P2 coordination** (delegation without deadlock, resumable shared state). Prototype this first.

---

## 10. Success Criteria
- Operator runs ≥3 projects concurrently and touches only the Decisions queue.
- A voiced goal ("ship the funnel change and deploy") completes end-to-end with exactly the intended human gates — no more, no fewer.
- No agent ever performs an irreversible op without a human confirm.
- Circuit breaker halts any runaway loop before it exceeds the project budget.

---

## 11. Open Decisions
- [ ] Shell: **Electron (recommended for MVP)** vs Tauri vs native Swift. → default Electron; revisit at P3.
- [ ] Where the Overseer + agents run: operator's Mac (dev) vs a dedicated server (always-on prod). → design for both; MVP on Mac.
- [x] ~~Inter-agent messaging transport~~ → **resolved (ADR-9):** `Bus` interface, in-process for MVP, swappable to NATS/Redis.
- [ ] Model tier defaults per role (cost vs quality) — tune empirically in P2.
- [ ] Dual-graph MCP: bundle Mantra's own binary vs. assume host-installed (decide at P4 Create wizard).
- [x] ~~Concurrent-edit / workspace strategy~~ → **resolved (ADR-1):** git worktree per task.
- [x] ~~How privileged ops & secrets are handled safely~~ → **resolved (ADR-2, ADR-3):** trusted Effector; secrets never in agent context.

---

## 12. Reused hard-won rules (bake into behavior)
- **Deploy guard:** never deploy while a batch/daily job runs (prevents orphaned running jobs).
- **Confirm before critical work:** recon + plan, then stop and ask for irreversible ops.
- **Circuit breaker on doom-loops:** cap requeues/runtime; kill and escalate instead of looping.
- **Test locally, then deploy, then re-verify live.**

---

## 13. Architecture Decisions & Risk Controls (ADRs)

> These are the load-bearing decisions that keep a fleet of LLM agents with destructive power *correct and safe under concurrency and failure*. They are non-negotiable invariants, not preferences. **Guiding axiom: never trust an LLM to police itself — safety, permissions, and budgets are enforced by deterministic code, and the human gate + objective CI are the real safety net.**

**ADR-1 · Workspace isolation: one git worktree per task.**
Decision: each task runs in its own `git worktree` on a task branch under `.mantra/worktrees/<taskId>`; agents never share a working directory. The review gate merges the task branch into an integration branch; ship opens the PR from there.
Why: Developer + QA + others editing `cwd = repo` concurrently corrupt files and git state — the single most likely disaster.
Consequence: agent `cwd` = its worktree; disk cost is cheap; merge conflicts surface at the review gate where a human already looks.

**ADR-2 · Privileged actions go through a trusted Effector; agents emit intents, not commands.**
Decision: agents cannot run `ssh`/deploy/`rm`/DB/`git push` directly. They emit a typed *action intent*; a system-side **Effector** (holds credentials, enforces the permission matrix + human gates) performs it and returns a result.
Why: separates *deciding* (LLM, fallible) from *doing* (trusted code) so an agent can never directly execute an irreversible op.
Consequence: the permission matrix (§6) is enforced at the Effector, deterministically — not by prompt instructions.

**ADR-3 · Secrets never enter agent context.**
Decision: secret *values* are injected as env vars into the Effector process only. Agent prompts/tools receive vault *references* (§FR-25), never values. No secret is ever serialized into a prompt, log, or transcript.
Why: an agent is an LLM that can be induced to exfiltrate; the only safe secret is one it never sees.
Consequence: audit logs and transcripts are safe to persist and replay.

**ADR-4 · Enforcement is middleware, not prompting.**
Decision: permissions, per-agent/project spend caps, the circuit breaker, and "irreversible ops always confirm" are implemented as Agent SDK `PreToolUse` hooks + a metering proxy that wraps every model/tool call. Prompts *describe* the rules; middleware *enforces* them.
Why: prompt-level rules fail under hallucination/jailbreak; a runaway loop or a rogue tool call must be stopped by code.
Consequence: the breaker counts tokens→$ per call and kills a session at cap; repeated identical actions (loop detection) also trip it.

**ADR-5 · Event-sourced task state with TTL leases.**
Decision: tasks live as an append-only event log; current state (queued → leased → doing → review → done/failed) is a projection. An agent must hold a **lease** (TTL) to work a task; a crash lets the lease expire and the task auto-requeues on supervisor restart.
Why: "resumable sessions" alone doesn't define recovery; leases + event log give crash-safety, no double-execution, and audit for free.
Consequence: resumability, the activity feed, and the audit log are all views over one log.

**ADR-6 · Registry ownership & schema versioning.**
Decision: the **Overseer is the sole writer** of `~/.mantra/registry.db` (SQLite WAL); supervisors own only their repo-local `.mantra/state`. Every `.mantra/config.json` and DB schema carries a `schemaVersion` with forward migrations from v1.
Why: multiple processes writing one SQLite file causes contention/corruption; unversioned config breaks on upgrade.
Consequence: clean process boundaries; safe upgrades.

**ADR-7 · Structured intent contract with mandatory target-confirm.**
Decision: voice/console NL resolves — via constrained tool-use (fixed JSON schema) — to a typed `Intent { verb, projectId, agentId?, args, reversible }`. Any `reversible=false` intent (deploy, push, DB, rm, spend override) requires an explicit **target preview + confirm** before execution.
Why: a misrouted destructive command from a fuzzy channel is catastrophic; the router must never guess a prod target silently.
Consequence: one router, one audit trail (voice + console); disambiguation is a first-class step, not an afterthought.

**ADR-8 · Objective gates outrank agent opinion.**
Decision: merge/ship is gated by **CI (lint, typecheck, tests, build)** as the oracle; the QA *agent* advises but cannot authorize a merge. No self-merge without green CI + the human review gate.
Why: an agent verifying an agent can be jointly wrong; deterministic checks + a human are the real net.
Consequence: QA's value is triage/context, not final authority.

**ADR-9 · Process & messaging model, self-healing.**
Decision: supervisors are OS child processes supervised by the Overseer; inter-agent messaging goes through a `Bus` interface — **in-process for MVP**, swappable to NATS/Redis later without touching call sites. Overseer supervises supervisors, supervisors supervise agents; crash → restart with resumed lease (ADR-5).
Why: resolves the open messaging-transport question without over-building; keeps the self-healing pattern concrete.
Consequence: fleet survives individual crashes; transport can scale later behind one interface.

**ADR-10 · Model-API resilience & idempotent effects.**
Decision: all model calls go through one client with backoff + rate-limit (429) handling; the fleet exposes a **`degraded`** state when the API is throttled/down (surfaced in the Decisions queue, not silent). External effects (deploy, push, PR create) carry idempotency keys so a crash-retry never double-executes.
Why: 429s and outages are normal; silent failure or double-deploy are not acceptable.
Consequence: graceful degradation instead of a stuck or duplicating fleet.

**ADR-11 · Context economy is mandatory, not optional.**
Decision: the dual-graph MCP (FR-13a) is provisioned per project and agents follow a **retrieve-before-explore** contract (query the graph for recommended files/symbols before broad grep). Per-agent token metering (ADR-4) feeds the breaker.
Why: broad exploration is the main avoidable token cost across a fleet of agents.
Consequence: predictable, lower per-task spend; token usage is observable per agent.
