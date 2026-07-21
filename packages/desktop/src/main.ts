import { app, BrowserWindow, ipcMain, type WebContents } from "electron";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { projectId, taskId as makeTaskId } from "@mantra/core";
import {
  type Confirmer, type CrewEvent, Effector, EnvSecretProvider, FileTaskLog, GhGitHost, InProcessBus,
  type RunEvent, type ShipEvent, Supervisor, isGitRepo, liveShipEffects, runAgentTask, runCrew, runShip,
} from "@mantra/orchestrator";
import type { ActiveRun, AgentEvent, IntentSource, ReviewItem, RunRequest, ShipRequest } from "./shared.js";
import { routeIntent } from "./intent.js";
import { buildFleet } from "./fleet-stub.js";
import { loadApiKeyIntoEnv } from "./config.js";
import { loadProjects, resolveTarget } from "./projects.js";

loadApiKeyIntoEnv(); // make the API key available to Finder-launched (double-clicked) app

/**
 * Electron main process — the trusted host. Owns the run pipeline and exposes only a
 * narrow, typed IPC surface to the sandboxed renderer (contextIsolation on). Runs stream
 * live AgentEvents to the renderer via webContents.send — this is what lets the operator
 * drive a real agent from the command console instead of a terminal.
 */

/** Pending irreversible-op confirmations, keyed by request id, awaiting the operator's answer. */
const pendingConfirms = new Map<string, (approved: boolean) => void>();

/** Runs currently executing, keyed by a unique run id — this is what makes a project show live. */
const activeRuns = new Map<string, ActiveRun>();

/** Tell every window the fleet changed so it re-pulls getFleet (a run started or finished). */
function broadcastFleetChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.webContents.isDestroyed()) w.webContents.send("agent:event", { kind: "fleet-changed" } satisfies AgentEvent);
  }
}

/** Mark a run live and return a disposer that clears it — call the disposer in a finally. */
function beginRun(run: ActiveRun): () => void {
  const id = randomUUID();
  activeRuns.set(id, run);
  broadcastFleetChanged();
  return () => {
    activeRuns.delete(id);
    broadcastFleetChanged();
  };
}

/** A Confirmer that surfaces irreversible ops to the operator as an in-app dialog (ADR-2). */
function makeUiConfirmer(wc: WebContents): Confirmer {
  return {
    confirm: (action) =>
      new Promise<boolean>((resolve) => {
        if (wc.isDestroyed()) return resolve(false);
        const id = randomUUID();
        pendingConfirms.set(id, resolve);
        wc.send("confirm:request", { id, kind: action.kind, project: String(action.projectId), command: action.args.command ?? "" });
      }),
  };
}

/** Hydrate a project's Supervisor from its persisted task log (read + resolve reviews). */
function supervisorFor(repoPath: string): Supervisor {
  const sink = new FileTaskLog(repoPath);
  const sup = new Supervisor(projectId(basename(repoPath)), new InProcessBus(), () => Date.now(), sink);
  sup.hydrate(sink.replay());
  return sup;
}

/** Collect review-gate tasks across all registered projects (FR-2 / FR-14). */
function listReviews(): ReviewItem[] {
  const items: ReviewItem[] = [];
  for (const p of loadProjects()) {
    for (const t of supervisorFor(p.repoPath).tasksInState("review")) {
      items.push({ id: t.id, title: t.title, project: p.name, repoPath: p.repoPath });
    }
  }
  return items;
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280, height: 840, minWidth: 960, minHeight: 640,
    backgroundColor: "#0B0C11", titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: join(app.getAppPath(), "dist", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  void win.loadFile(join(app.getAppPath(), "dist", "index.html"));
}

async function startRun(req: RunRequest, wc: WebContents): Promise<void> {
  const send = (e: AgentEvent): void => {
    if (!wc.isDestroyed()) wc.send("agent:event", e);
  };
  const repoPath = resolveTarget(req.target, loadProjects());
  if (!repoPath) {
    send({ kind: "error", message: `unknown project or path: "${req.target}". Add it to ~/.mantra/projects.json or pass an absolute path.` });
    return;
  }

  const onEvent = (e: RunEvent): void => {
    switch (e.type) {
      case "info": send({ kind: "line", text: `▸ ${e.message}` }); break;
      case "warn": send({ kind: "line", text: `⚠ ${e.message}` }); break;
      case "started": send({ kind: "line", text: `▸ ${e.role} started (isolated worktree)` }); break;
      case "activity": send({ kind: "line", text: "· working…" }); break;
      case "effector": send({ kind: "line", text: `[effector] ${JSON.stringify(e.detail)}` }); break;
    }
  };

  const endRun = beginRun({ repoPath, kind: "run", task: req.task, startedAt: Date.now() });
  try {
    const result = await runAgentTask({
      repoPath, task: req.task,
      role: "developer", model: "claude-haiku-4-5", budgetUsd: 1,
      dryRun: req.dryRun, noPush: true, keepWorktree: req.dryRun ? false : true,
      confirmer: makeUiConfirmer(wc),
      onEvent,
    });

    if (!result.ok) {
      send({ kind: "error", message: result.error ?? "run failed" });
      return;
    }
    send({ kind: "done", costUsd: result.costUsd, stopReason: result.tripped ?? result.stopReason, diffStat: result.diffStat, worktreePath: result.worktreePath });
  } finally {
    endRun();
  }
}

async function startCrew(req: RunRequest, wc: WebContents): Promise<void> {
  const send = (e: AgentEvent): void => {
    if (!wc.isDestroyed()) wc.send("agent:event", e);
  };
  const repoPath = resolveTarget(req.target, loadProjects());
  if (!repoPath) {
    send({ kind: "error", message: `unknown project or path: "${req.target}".` });
    return;
  }
  const onCrewEvent = (e: CrewEvent): void => {
    const text =
      e.type === "planned" ? `▸ Manager decomposed the goal into ${e.count} tasks`
      : e.type === "executed" ? `  · ${e.title} — ${e.ok ? "done" : "failed"} (${e.note})`
      : e.type === "verified" ? `  · QA ${e.pass ? "passed" : "rejected"}: ${e.title}`
      : e.type === "requeued" ? `  ↻ requeued (attempt ${e.attempt}): ${e.title}`
      : e.type === "review" ? `  ✓ ready for your review: ${e.title}`
      : `  ✗ failed: ${e.title} — ${e.reason}`;
    send({ kind: "line", text });
  };

  const endRun = beginRun({ repoPath, kind: "crew", task: req.task, startedAt: Date.now() });
  try {
    const result = await runCrew({
      repoPath, goal: req.task,
      model: "claude-haiku-4-5", budgetUsd: 2, noPush: true,
      confirmer: makeUiConfirmer(wc),
      onCrewEvent,
    });
    if (!result.ok) {
      send({ kind: "error", message: result.error ?? "crew run failed" });
      return;
    }
    send({ kind: "line", text: `▸ crew done · ${result.reviewTitles.length} in review, ${result.failedTitles.length} failed. Approve in the Decisions queue.` });
    send({ kind: "reviews-changed" });
  } finally {
    endRun();
  }
}

async function startShip(req: ShipRequest, wc: WebContents): Promise<void> {
  const send = (e: AgentEvent): void => {
    if (!wc.isDestroyed()) wc.send("agent:event", e);
  };
  if (!isGitRepo(req.repoPath)) {
    send({ kind: "error", message: `${req.repoPath} is not a git repository` });
    return;
  }
  let branch = "";
  try {
    branch = execFileSync("git", ["-C", req.repoPath, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  } catch { /* handled below */ }
  if (!branch || branch === "HEAD") {
    send({ kind: "error", message: "could not determine the branch to ship (detached HEAD?)" });
    return;
  }

  const onEvent = (e: ShipEvent): void => {
    const text =
      e.type === "pushed" ? `▸ pushed ${e.branch} → origin`
      : e.type === "pr-opened" ? `▸ PR #${e.number} opened · ${e.url}`
      : e.type === "ci" ? `  · CI ${e.status} (check ${e.attempt})`
      : e.type === "merged" ? `  ✓ merged PR #${e.number} (CI green)`
      : e.type === "deployed" ? `  ✓ ${e.detail}`
      : `  ✗ aborted at ${e.stage}: ${e.reason}`;
    send({ kind: "line", text });
  };

  // Push + deploy route through the Effector (permission matrix + the in-app confirm dialog).
  const effector = new Effector(new EnvSecretProvider(), makeUiConfirmer(wc), liveShipEffects());
  const endRun = beginRun({ repoPath: req.repoPath, kind: "ship", task: req.title, startedAt: Date.now() });
  try {
    send({ kind: "line", text: `▸ shipping ${branch} · "${req.title}"` });
    const result = await runShip({
      repoPath: req.repoPath, branch, title: req.title,
      host: new GhGitHost(req.repoPath),
      effector,
      ...(req.deploy ? { deploy: { env: req.deploy } } : {}),
      onEvent,
    });
    if (!result.ok) {
      send({ kind: "error", message: `ship stopped at ${result.stage}${result.reason ? ` — ${result.reason}` : ""}` });
      return;
    }
    send({ kind: "line", text: `▸ ship ${result.stage === "done" ? "complete" : `stopped at ${result.stage}`} · ${result.merged ? "merged" : "not merged"}${result.deployed ? " · deployed" : ""}` });
  } finally {
    endRun();
  }
}

void app.whenReady().then(() => {
  ipcMain.handle("fleet:get", () => buildFleet(listReviews(), [...activeRuns.values()]));
  ipcMain.handle("projects:list", () => loadProjects());
  ipcMain.handle("intent:submit", (_e, payload: { raw: string; source: IntentSource }) =>
    routeIntent(payload.raw, payload.source),
  );
  ipcMain.handle("task:run", (event, req: RunRequest) => {
    void startRun(req, event.sender); // fire-and-forget; progress streams via agent:event
    return { ok: true, message: `running: ${req.task}${req.dryRun ? " (dry-run)" : ""}` };
  });
  ipcMain.handle("crew:run", (event, req: RunRequest) => {
    void startCrew(req, event.sender);
    return { ok: true, message: `crew on: ${req.task}` };
  });
  ipcMain.handle("ship:run", (event, req: ShipRequest) => {
    void startShip(req, event.sender);
    return { ok: true, message: `shipping: ${req.title}` };
  });
  ipcMain.on("confirm:response", (_e, id: string, approved: boolean) => {
    const resolve = pendingConfirms.get(id);
    if (resolve) { pendingConfirms.delete(id); resolve(approved); }
  });
  ipcMain.handle("reviews:list", () => listReviews());
  ipcMain.handle("review:resolve", (_e, repoPath: string, id: string, approve: boolean) => {
    const sup = supervisorFor(repoPath);
    if (approve) sup.approve(makeTaskId(id));
    else sup.requeue(makeTaskId(id));
    return { ok: true, message: approve ? "approved" : "sent back for changes" };
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Boot smoke test: verify the full stack initializes without a display — main, preload,
  // window, and the React renderer loading + calling IPC — then exit with a pass/fail code.
  if (process.env.MANTRA_SMOKE === "1") {
    const win = BrowserWindow.getAllWindows()[0];
    let rendererErrors = 0;
    win?.webContents.on("console-message", (_e, level, message) => {
      if (level >= 3) { rendererErrors++; console.log(`[renderer error] ${message}`); }
    });
    win?.webContents.on("did-finish-load", () => console.log("[mantra] renderer loaded"));
    win?.webContents.on("did-fail-load", (_e, code, desc) => { rendererErrors++; console.log(`[renderer fail] ${code} ${desc}`); });
    setTimeout(() => {
      console.log(`[mantra] boot ${rendererErrors === 0 ? "ok" : "FAILED"} — main, preload, window, renderer initialized (${rendererErrors} renderer errors)`);
      app.exit(rendererErrors === 0 ? 0 : 1);
    }, 2500);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
