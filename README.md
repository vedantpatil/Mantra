# Mantra

Voice + console control plane over a **fleet of Claude Code agent crews**, run by one operator.
See [`REQUIREMENTS.md`](REQUIREMENTS.md) for the full spec and [`REQUIREMENTS.md#13`](REQUIREMENTS.md) §13 for the load-bearing architecture decisions (ADRs).

## Why the code is shaped this way

Mantra hands LLM agents real, destructive power (edit code, `git push`, `ssh`, `rm`) across many
repos at once. The skeleton is organized around the invariants that keep that safe under
concurrency and failure — **safety is enforced by deterministic code, never by prompts.**

| Concern | ADR | Where in code |
|---|---|---|
| Concurrent edits can't corrupt a repo | ADR-1 | `orchestrator/worktree.ts` — one git worktree per task |
| Agents emit intents; a trusted executor acts | ADR-2 | `orchestrator/effector.ts` |
| Secrets never enter agent context | ADR-3 | `effector.ts` (`SecretProvider` resolves inside the boundary) |
| Permissions / budgets are middleware | ADR-4 | `core/permissions.ts`, `orchestrator/breaker.ts` |
| Crash-safe, resumable work | ADR-5 | `core/task.ts`, `orchestrator/supervisor.ts` (event log + TTL leases) |
| Sole-writer registry, versioned schema | ADR-6 | `core/registry.ts` |
| Structured intent + target-confirm | ADR-7 | `core/intent.ts`, `orchestrator/router.ts` |
| Bus behind one interface | ADR-9 | `orchestrator/bus.ts` |
| Enforcement wired into the live agent | ADR-2/3/4 | `orchestrator/agent-runner.ts` (`canUseTool`), `orchestrator/tool-permissions.ts` |
| Sole-writer SQLite registry (WAL, versioned) | ADR-6 | `orchestrator/registry-sqlite.ts` |
| Durable append-only task log, crash-safe | ADR-5 | `orchestrator/task-log.ts`, `orchestrator/supervisor.ts` (`hydrate`) |

## Packages

- **`@mantra/core`** — pure domain model, zero runtime deps: IDs, `Result`, permission matrix,
  intent contract, event-sourced task state machine, registry types.
- **`@mantra/orchestrator`** — the running brain: Overseer (sole registry writer, supervises
  supervisors), per-project Supervisor (task log + leases + reconciliation), AgentRunner
  (wraps the Claude Agent SDK), Effector, CircuitBreaker, Router, WorktreeManager, Bus,
  SqliteRegistry, FileTaskLog.
- **`@mantra/desktop`** — the Electron shell (P1 UI): fleet view + Decisions queue + a working
  **command console** (dual to voice) and a push-to-talk affordance. The fleet view reflects
  **live agent status** — a project shows `busy` with its running agent(s) while a `run`/`crew`/`ship`
  executes (main streams a `fleet-changed` event as runs start/finish), `review` when tasks await
  the gate, else `ready` — and `blk` (blocked) when an **Ops incident** is open. Each review card
  offers **Reject / Ship / Approve**: **Ship** runs the P4 pipeline on the project's current branch
  (push → PR → CI gate → auto-merge on green), with push + deploy behind the in-app confirm dialog.
  A background **Ops loop** polls each project's configured `monitors`, triages via `OpsMonitor`, and
  surfaces escalations in an **Incidents rail** (`incidents-changed` push); an **Audit trail** feed
  shows the cross-cutting ledger (ops escalations/resolutions, ship merges/deploys, review decisions)
  read from `.mantra/state/audit.jsonl`. Main process is the trusted host (contextIsolation on, a
  narrow typed IPC surface); the React renderer is sandboxed. Built with esbuild.
  Run: `npm --prefix packages/desktop run build && npm --prefix packages/desktop start`.
- **`@mantra/cli`** — `mantra run <repo> "<task>"`: the assembled spine for a single live agent.
  Loads `.mantra/config.json`, resolves the API key from env (ADR-3), creates a per-task git
  worktree (ADR-1), attaches the **dual-graph context MCP** with a retrieve-before-explore
  contract (FR-13a/ADR-11), runs the agent under the permission matrix + circuit breaker, then
  leaves the diff for review. Flags: `--role --model --budget --no-push --no-graph --dry-run --keep`.
  `mantra crew <repo> "<goal>"` drives the full P2 crew instead: the Manager decomposes the goal,
  Dev/QA execute each task to the human review gate, state persists under `.mantra/state/` (so it's
  resumable), and the run is always push-denied. Same `runCrew()` pipeline the desktop console uses.
  `mantra ship <repo> "<title>"` runs the **P4 ship pipeline** (`runShip()`): push → open PR →
  **gate on CI** → auto-merge **only on green** (ADR-8: CI, not the agent, decides) → optional
  `--deploy <env>` behind the confirm gate (deploy is always human-confirmed, ADR-2). Push + deploy
  route through the trusted Effector (permission matrix + `gh`/`git` drivers); the gate logic is
  deterministic and proven offline with fakes. Flags: `--base --branch --deploy --deploy-cmd --no-merge`.
  `mantra ops <repo>` runs the **P5 Ops agent** (`OpsMonitor`): polls the project's configured
  `monitors` (health URLs), then **triages deterministically** — a signal must stay bad for a
  debounce threshold before it escalates (a single blip never pages), one open incident per probe
  (natural cooldown), a warn→critical severity change re-escalates, and recovery auto-resolves.
  Ops never auto-remediates anything irreversible — it *escalates* to the operator (human-gated,
  ADR-2). Every transition is written to the append-only **audit trail** (`.mantra/state/audit.jsonl`,
  FR-24). Flags: `--once --interval <sec>`.
  `mantra vault <set|get|list|rm>` manages the **P5 secrets vault** (`FileVault`): secrets are sealed
  at rest with **AES-256-GCM** under a key derived (scrypt) from `MANTRA_VAULT_KEY` — the passphrase
  never touches disk, GCM's auth tag makes a wrong key or a tampered file fail loudly, and `set` reads
  the value from stdin (never argv, so it stays out of shell history). Reference a stored secret as
  `vault://<key>` anywhere a ref is expected (`apiKeyRef`, a deploy `secretRef`); the default
  `CompositeSecretProvider` routes `env://` → env and `vault://` → the vault, a drop-in for the old
  env-only provider (ADR-3).

## Install as a Mac app

```bash
npm install && npm run dist        # produces packages/desktop/release/Mantra-<ver>-arm64.dmg
```

Open the `.dmg`, drag **Mantra** to Applications, right-click → **Open** once (the build is
unsigned unless you supply an Apple Developer ID). Full walkthrough: [`OPEN_AND_TEST.md`](OPEN_AND_TEST.md).
The app is Electron (ESM main) + a React renderer; the Agent SDK is kept external and unpacked
from the asar so its subprocess assets resolve. A custom icon is generated by `scripts/gen-icon.mjs`.

## Run from the app (primary surface)

The operator drives Mantra from the desktop shell, not the terminal. Register projects in
`~/.mantra/projects.json`:

```json
{ "projects": [ { "id": "website", "name": "VPSTech Website", "repoPath": "/abs/path/to/repo" } ] }
```

Then launch the app and, in the command console (or by voice), type:

```
run website: summarize the stack and main entry points     # one agent, read-only (dry-run)
run! website: fix the typo in the footer                    # one agent, allow edits
crew website: add a contact form                            # a crew: Manager → Dev/QA → your review
```

A **crew** run decomposes the goal into tasks and drives them through the Supervisor's
resumable task queue (Manager decomposes → Developer implements → QA verifies → human
review). The Manager is a real agent that inspects the repo (read-only, dual-graph-backed)
and emits a structured task list; if its output doesn't parse, a heuristic decomposition
keeps the crew moving. Coordination is deterministic and deadlock-free: handoffs go through
the queue, never blocking waits; a per-task attempt cap prevents doom-loops; finished work
lands in `review` and waits for your approval — no agent self-approves. The crew's state
persists to `.mantra/state/`, so an interrupted crew resumes exactly where it stopped.

Review-gate tasks appear in the app's **Awaiting your review** panel with Approve / Reject.
Approve marks the task done; Reject sends it back to the queue for another pass. Both persist
to the task log, so your decision survives a restart.

Activity streams live into the console; the run is worktree-isolated, budget-capped, push-denied,
and dual-graph-backed. Launch:

```bash
export ANTHROPIC_API_KEY=sk-...
npm run build && npm --prefix packages/desktop start
```

## Run from the CLI (same engine, for scripting/CI)

The `@mantra/cli` calls the exact same pipeline as the app — useful for scripting or headless runs.

```bash
git clone <your-repo> ~/mantra-test/website      # a throwaway clone, never your working copy
export ANTHROPIC_API_KEY=sk-...
npm run build
# read-only first — proves retrieval + zero writes:
node packages/cli/dist/cli.js run ~/mantra-test/website "summarize the stack and main entry points" --dry-run
# then a tiny reversible edit, push denied, cheap model, $1 cap, keep the diff:
node packages/cli/dist/cli.js run ~/mantra-test/website "add a one-line comment to the top of README" \
  --model claude-haiku-4-5 --budget 1 --no-push --keep
```

A/B the dual-graph token savings by running the same task with and without `--no-graph` and
comparing the printed `cost $…`.

The dual-graph MCP command is auto-discovered (no config needed for the standard install):
explicit `dualGraph.command` in config → `MANTRA_DUAL_GRAPH_COMMAND` env →
`~/.dual-graph/venv/bin/mcp-graph-server` → `mcp-graph-server` on PATH. The per-repo
`DG_DATA_DIR`/`DUAL_GRAPH_PROJECT_ROOT` env is derived automatically from the repo path.

## Develop

```bash
npm install
npm run typecheck   # tsc -b across the workspace
node scripts/smoke.mjs   # exercises breaker trip, lease reconciliation, permission matrix
```

## Status

P1 spine — core domain + orchestrator control paths scaffolded and smoke-verified.
`AgentRunner` is wired to `@anthropic-ai/claude-agent-sdk`: each agent is a real Claude Code
session (cwd = its worktree), with the permission matrix + circuit breaker enforced in the
`canUseTool` callback and irreversible tool calls rewritten into `Effector` actions (ADR-2/3/4).
The API key is resolved inside the trusted boundary and injected via the agent process env,
never the prompt. A live end-to-end run needs `ANTHROPIC_API_KEY`; typecheck + `scripts/smoke.mjs`
(which covers the deterministic decision core in `tool-permissions.ts`) run offline.

Persistence is in: `SqliteRegistry` (Node's built-in `node:sqlite`, WAL, sole-writer, schema-versioned)
implements `RegistryWriter`; `FileTaskLog` persists each project's task events to
`.mantra/state/tasks.jsonl` and `Supervisor.hydrate()` rebuilds exact state on restart.

The Electron shell (`@mantra/desktop`) is scaffolded and building (fleet, Decisions queue,
command console, voice toggle/PTT — intent + fleet are stubs with a clear seam to the Overseer).
The `@mantra/cli` harness assembles the spine end-to-end for a single live agent, dual-graph
included. Everything is verified offline (`npm run typecheck`; `node scripts/smoke.mjs` — 27
checks); the one thing the sandbox can't do is spawn the live Claude Code session — that's the
first `mantra run` you'll do on a throwaway repo.

**Next:** connect the shell's IPC to a live in-process Overseer + `SqliteRegistry`; wire `mantra
run` events into the desktop activity feed; then prototype P2 Manager→Dev→QA delegation.
