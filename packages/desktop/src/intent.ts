import type { IntentAck, IntentSource } from "./shared.js";

/**
 * Client-side stand-in for the Overseer's intent router (ADR-7). Voice and console
 * both arrive here as raw text and resolve to the same acks — one router, one path.
 * TODO(P2): replace with a real bridge to `@mantra/orchestrator` Router → Overseer.
 */
export function routeIntent(raw: string, source: IntentSource): IntentAck {
  const text = raw.trim();
  if (!text) return { ok: false, message: "empty command" };

  const isSlash = text.startsWith("/");
  const [head, ...rest] = text.replace(/^\//, "").split(/\s+/);
  const verb = (head ?? "").toLowerCase();
  const arg = rest.join(" ");
  const tag = source === "voice" ? "🎙" : "⌨";

  switch (verb) {
    case "deploy":
      return { ok: true, message: `⚠ deploy guard clear — confirm production deploy of ${arg || "<project>"}: type y or /confirm` };
    case "confirm":
    case "y":
      return { ok: true, message: "→ ssh · docker compose up --build … ✓ health /api/health 200 · deployed · tagged v1.4.2" };
    case "approve":
      return { ok: true, message: `✓ approved ${arg || "<diff>"} · opening PR · CI running · auto-merge on green` };
    case "queue":
    case "decisions":
      return { ok: true, message: "2 decisions open · 1 critical (Helios migration drops users.legacy_id) · 1 (CareerFlint deploy)" };
    case "status":
      return { ok: true, message: "4 projects · 11 agents · 2 need you · spend $18.40 / $30" };
    case "pause":
      return { ok: true, message: `⏸ paused ${arg || "<agent>"}` };
    case "message":
      return { ok: true, message: `→ delivered to ${arg || "<agent>"}` };
    case "help":
      return { ok: true, message: "commands: /deploy /approve /queue /status /pause /message · or type/speak plain intent" };
    default:
      return isSlash
        ? { ok: false, message: `unknown command /${verb} — try /help` }
        : { ok: true, message: `${tag} routed intent: “${text}” (natural-language target resolution pending Overseer wiring)` };
  }
}
