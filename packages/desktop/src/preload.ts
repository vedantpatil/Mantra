import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { AgentEvent, FleetSnapshot, IntentAck, IntentSource, ProjectRef, RunRequest } from "./shared.js";

/** Exposes only the typed `MantraBridge` on `window.mantra` — no raw ipcRenderer, no Node. */
contextBridge.exposeInMainWorld("mantra", {
  submitIntent: (raw: string, source: IntentSource): Promise<IntentAck> =>
    ipcRenderer.invoke("intent:submit", { raw, source }),
  getFleet: (): Promise<FleetSnapshot> => ipcRenderer.invoke("fleet:get"),
  listProjects: (): Promise<readonly ProjectRef[]> => ipcRenderer.invoke("projects:list"),
  runTask: (req: RunRequest): Promise<IntentAck> => ipcRenderer.invoke("task:run", req),
  runCrew: (req: RunRequest): Promise<IntentAck> => ipcRenderer.invoke("crew:run", req),
  onAgentEvent: (cb: (event: AgentEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: AgentEvent): void => cb(payload);
    ipcRenderer.on("agent:event", listener);
    return () => ipcRenderer.removeListener("agent:event", listener);
  },
});
