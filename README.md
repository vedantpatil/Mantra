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
  (wraps the Claude Agent SDK — stubbed), Effector, CircuitBreaker, Router, WorktreeManager, Bus.

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

**Next:** the Electron shell (fleet view + push-to-talk + command console); then prototype
P2 Manager→Dev→QA delegation over the persisted task queue.
