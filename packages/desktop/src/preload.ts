import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { AgentEvent, AuditEntry, ConfirmRequest, FleetSnapshot, IntentAck, IntentSource, OpsIncident, ProjectRef, ReviewItem, RunRequest, ShipRequest } from "./shared.js";

/** Exposes only the typed `MantraBridge` on `window.mantra` — no raw ipcRenderer, no Node. */
contextBridge.exposeInMainWorld("mantra", {
  submitIntent: (raw: string, source: IntentSource): Promise<IntentAck> =>
    ipcRenderer.invoke("intent:submit", { raw, source }),
  getFleet: (): Promise<FleetSnapshot> => ipcRenderer.invoke("fleet:get"),
  listProjects: (): Promise<readonly ProjectRef[]> => ipcRenderer.invoke("projects:list"),
  runTask: (req: RunRequest): Promise<IntentAck> => ipcRenderer.invoke("task:run", req),
  runCrew: (req: RunRequest): Promise<IntentAck> => ipcRenderer.invoke("crew:run", req),
  shipReview: (req: ShipRequest): Promise<IntentAck> => ipcRenderer.invoke("ship:run", req),
  listReviews: (): Promise<readonly ReviewItem[]> => ipcRenderer.invoke("reviews:list"),
  resolveReview: (repoPath: string, taskId: string, approve: boolean): Promise<IntentAck> =>
    ipcRenderer.invoke("review:resolve", repoPath, taskId, approve),
  listIncidents: (): Promise<readonly OpsIncident[]> => ipcRenderer.invoke("ops:list"),
  listAudit: (limit?: number): Promise<readonly AuditEntry[]> => ipcRenderer.invoke("audit:list", limit),
  normalizeVoice: (text: string): Promise<string> => ipcRenderer.invoke("voice:normalize", text),
  onAgentEvent: (cb: (event: AgentEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: AgentEvent): void => cb(payload);
    ipcRenderer.on("agent:event", listener);
    return () => ipcRenderer.removeListener("agent:event", listener);
  },
  onConfirmRequest: (cb: (req: ConfirmRequest) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: ConfirmRequest): void => cb(payload);
    ipcRenderer.on("confirm:request", listener);
    return () => ipcRenderer.removeListener("confirm:request", listener);
  },
  respondConfirm: (id: string, approved: boolean): void => ipcRenderer.send("confirm:response", id, approved),
});
