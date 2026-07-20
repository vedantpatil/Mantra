import { contextBridge, ipcRenderer } from "electron";
import type { FleetSnapshot, IntentAck, IntentSource } from "./shared.js";

/** Exposes only the typed `MantraBridge` on `window.mantra` — no raw ipcRenderer, no Node. */
contextBridge.exposeInMainWorld("mantra", {
  submitIntent: (raw: string, source: IntentSource): Promise<IntentAck> =>
    ipcRenderer.invoke("intent:submit", { raw, source }),
  getFleet: (): Promise<FleetSnapshot> => ipcRenderer.invoke("fleet:get"),
});
