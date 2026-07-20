# Open Mantra & test VPSTech from the UI

Everything below happens **in the app** — no terminal after the one-time build.

## 1. Build the installer (one time)

```bash
cd ~/Projects/Mantra
npm install
npm run dist          # builds the app + produces the .dmg
```

The installer lands at:

```
packages/desktop/release/Mantra-0.0.1-arm64.dmg
```

> The `.dmg` is **unsigned** (no Apple Developer cert was available at build time), so on
> first launch macOS Gatekeeper will warn. Open it once with **right-click → Open** (or
> System Settings → Privacy & Security → "Open Anyway"). After that it launches normally.

## 2. Install & open

1. Double-click the `.dmg`, drag **Mantra** to Applications.
2. Right-click **Mantra** → **Open** (first time only).
3. The Mantra window opens: fleet view on the left, Decisions/Review rail on the right,
   command console along the bottom.

## 3. One-time setup for live runs

- **API key**: Mantra reads `ANTHROPIC_API_KEY` from the environment. Launch it from a
  terminal that has the key exported, so the packaged app inherits it:
  ```bash
  export ANTHROPIC_API_KEY=sk-...
  open -a Mantra
  ```
  (Or add the key to your shell profile / a launch agent so `open -a Mantra` always has it.)
- **Projects**: `~/.mantra/projects.json` already maps `website → VPSTech/Website`. VPSTech
  appears as a card in the fleet. To add more, edit that file.
- **Dual-graph**: auto-discovered at `~/.dual-graph/venv/bin/mcp-graph-server` and scoped to
  the repo automatically — nothing to configure.

## 4. Test VPSTech — entirely from the console

Type these in the command console (bottom of the window):

```
run website: summarize the stack and the main entry points
```
Read-only (dry-run). Proves retrieval + the dual-graph, makes no changes. Activity streams
into the console; cost prints at the end.

```
crew website: add a short "About" section to the homepage
```
A full crew: the **Manager** inspects the repo and decomposes the goal, **Developer** and
**QA** run in isolated git worktrees, and finished work appears in **"Awaiting your review"**
on the right. Click **Approve** (accept) or **Reject** (send back for another pass).

```
run! website: fix the typo in the footer
```
Single agent allowed to edit. If it ever attempts an irreversible op (push / rm / deploy),
an **in-app confirm dialog** pops up — Approve or Deny.

## Safety, by default

- Every run is **git-worktree-isolated** — your real checkout is never touched.
- **git push is denied**, budget is **capped** (the circuit breaker halts runaways), and the
  cheap **Haiku** model is used unless changed.
- **Irreversible ops** (deploy/rm/DB) always require your in-app confirmation.
- **You approve every diff** at the review gate — nothing merges on its own.

## If a live run misbehaves in the packaged app

The packaged app boots and the UI works; live agent execution depends on the Agent SDK
spawning a subprocess. If a crew fails to start *only* in the installed app (but the UI is
fine), run the identical engine from source as a fallback:

```bash
cd ~/Projects/Mantra && npm run build && npm --prefix packages/desktop start
```

This opens the same app from source (guaranteed module resolution) — same console, same
commands.
