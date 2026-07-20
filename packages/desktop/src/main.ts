import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import type { IntentSource } from "./shared.js";
import { routeIntent } from "./intent.js";
import { FLEET } from "./fleet-stub.js";

/**
 * Electron main process — the trusted host. It owns the (future) Overseer and exposes
 * only a narrow, typed IPC surface to the sandboxed renderer (contextIsolation on,
 * nodeIntegration off). The renderer can submit intents and read fleet state; nothing
 * else. This is the security boundary between the UI and the orchestrator.
 */
function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0B0C11",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: join(app.getAppPath(), "dist", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  void win.loadFile(join(app.getAppPath(), "dist", "index.html"));
}

void app.whenReady().then(() => {
  ipcMain.handle("fleet:get", () => FLEET);
  ipcMain.handle("intent:submit", (_event, payload: { raw: string; source: IntentSource }) =>
    routeIntent(payload.raw, payload.source),
  );

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
