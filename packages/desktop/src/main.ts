import { app, BrowserWindow, ipcMain, type WebContents } from "electron";
import { join } from "node:path";
import { type RunEvent, runAgentTask } from "@mantra/orchestrator";
import type { AgentEvent, IntentSource, RunRequest } from "./shared.js";
import { routeIntent } from "./intent.js";
import { FLEET } from "./fleet-stub.js";
import { loadProjects, resolveTarget } from "./projects.js";

/**
 * Electron main process — the trusted host. Owns the run pipeline and exposes only a
 * narrow, typed IPC surface to the sandboxed renderer (contextIsolation on). Runs stream
 * live AgentEvents to the renderer via webContents.send — this is what lets the operator
 * drive a real agent from the command console instead of a terminal.
 */

/** Irreversible ops are auto-denied from the UI for now (a Decisions-queue confirm dialog is next). */
const denyConfirmer = { confirm: async () => false };

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

  const result = await runAgentTask({
    repoPath, task: req.task,
    role: "developer", model: "claude-haiku-4-5", budgetUsd: 1,
    dryRun: req.dryRun, noPush: true, keepWorktree: req.dryRun ? false : true,
    confirmer: denyConfirmer,
    onEvent,
  });

  if (!result.ok) {
    send({ kind: "error", message: result.error ?? "run failed" });
    return;
  }
  send({ kind: "done", costUsd: result.costUsd, stopReason: result.tripped ?? result.stopReason, diffStat: result.diffStat, worktreePath: result.worktreePath });
}

void app.whenReady().then(() => {
  ipcMain.handle("fleet:get", () => FLEET);
  ipcMain.handle("projects:list", () => loadProjects());
  ipcMain.handle("intent:submit", (_e, payload: { raw: string; source: IntentSource }) =>
    routeIntent(payload.raw, payload.source),
  );
  ipcMain.handle("task:run", (event, req: RunRequest) => {
    void startRun(req, event.sender); // fire-and-forget; progress streams via agent:event
    return { ok: true, message: `running: ${req.task}${req.dryRun ? " (dry-run)" : ""}` };
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
