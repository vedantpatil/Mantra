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
**Next:** wire `@anthropic-ai/claude-agent-sdk` into `AgentRunner` with PreToolUse enforcement,
persist the task log to `.mantra/state/`, and build the Electron shell (fleet view + push-to-talk
+ command console). No agent is wired to real tools yet.
