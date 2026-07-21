import type { AuditSink } from "./audit.js";

/**
 * The Ops agent (P5): monitor → triage → escalate. A DETERMINISTIC engine over injected
 * probes — the enforcement (when to escalate, when to resolve) is code, not model judgment,
 * so it's provable and never flaps. Ops never auto-remediates anything irreversible; on a
 * confirmed incident it *escalates* to the operator (a human-gated decision, ADR-2). Each
 * state transition is written to the audit trail.
 *
 * Triage rules:
 *  - Debounce: a probe must return the same-or-worse bad severity `threshold(severity)` times
 *    in a row before it escalates — a single blip never pages anyone.
 *  - One open incident per probe (natural cooldown): it won't re-escalate while open …
 *  - … except a severity UPGRADE (warn incident → critical) escalates again.
 *  - Recovery: the first `ok` reading closes an open incident (resolved) and resets the streak.
 */

export type Severity = "ok" | "warn" | "critical";

export interface Reading {
  readonly status: Severity;
  readonly note?: string;
}

/** A monitored signal. Injected so the engine is testable without a network. */
export interface Probe {
  readonly name: string;
  check(): Promise<Reading>;
}

export interface Incident {
  readonly probe: string;
  readonly severity: Severity; // "warn" | "critical" for an open incident
  readonly openedAt: number;
  readonly note?: string;
}

export type OpsEvent =
  | { readonly type: "reading"; readonly probe: string; readonly status: Severity; readonly note?: string }
  | { readonly type: "escalated"; readonly probe: string; readonly severity: Severity; readonly note?: string; readonly upgraded: boolean }
  | { readonly type: "resolved"; readonly probe: string; readonly wasSeverity: Severity }
  | { readonly type: "probe-error"; readonly probe: string; readonly error: string };

export interface OpsOptions {
  readonly probes: readonly Probe[];
  readonly audit?: AuditSink;
  readonly project?: string;
  readonly now?: () => number;
  /** Consecutive bad readings required to escalate, per severity (default warn:3, critical:2). */
  readonly thresholds?: { readonly warn?: number; readonly critical?: number };
  readonly onEvent?: (event: OpsEvent) => void;
  /** Called once per escalation — the operator surface (create a Decision, notify, …). */
  readonly onEscalate?: (incident: Incident) => void;
}

const RANK: Readonly<Record<Severity, number>> = { ok: 0, warn: 1, critical: 2 };

interface ProbeState {
  streak: number;
  worst: Severity; // worst severity seen in the current bad streak
  incident?: Incident;
}

export class OpsMonitor {
  private readonly state = new Map<string, ProbeState>();
  private readonly warnAt: number;
  private readonly critAt: number;

  constructor(private readonly opts: OpsOptions) {
    this.warnAt = opts.thresholds?.warn ?? 3;
    this.critAt = opts.thresholds?.critical ?? 2;
    for (const p of opts.probes) this.state.set(p.name, { streak: 0, worst: "ok" });
  }

  private now(): number {
    return (this.opts.now ?? (() => Date.now()))();
  }
  private thresholdFor(sev: Severity): number {
    return sev === "critical" ? this.critAt : this.warnAt;
  }
  private emit(e: OpsEvent): void {
    this.opts.onEvent?.(e);
  }
  private audit(kind: string, detail: Record<string, unknown>): void {
    this.opts.audit?.record({ at: this.now(), kind, ...(this.opts.project ? { project: this.opts.project } : {}), detail });
  }

  /** Run every probe once, update triage state, and escalate/resolve deterministically. */
  async tick(): Promise<readonly OpsEvent[]> {
    const events: OpsEvent[] = [];
    const push = (e: OpsEvent): void => { events.push(e); this.emit(e); };

    for (const probe of this.opts.probes) {
      const st = this.state.get(probe.name) ?? { streak: 0, worst: "ok" as Severity };
      this.state.set(probe.name, st);

      let reading: Reading;
      try {
        reading = await probe.check();
      } catch (e) {
        // A probe that can't even run is itself a critical signal.
        reading = { status: "critical", note: `probe error: ${e instanceof Error ? e.message : String(e)}` };
        push({ type: "probe-error", probe: probe.name, error: reading.note ?? "" });
      }
      push({ type: "reading", probe: probe.name, status: reading.status, note: reading.note });

      if (reading.status === "ok") {
        // Recovery: close any open incident, reset the streak.
        if (st.incident) {
          const was = st.incident.severity;
          st.incident = undefined;
          this.audit("ops.resolved", { probe: probe.name, wasSeverity: was });
          push({ type: "resolved", probe: probe.name, wasSeverity: was });
        }
        st.streak = 0;
        st.worst = "ok";
        continue;
      }

      // Bad reading — extend the streak and remember the worst severity in it.
      st.streak += 1;
      if (RANK[reading.status] > RANK[st.worst]) st.worst = reading.status;

      const ready = st.streak >= this.thresholdFor(st.worst);
      if (!ready) continue;

      const upgrade = st.incident !== undefined && RANK[st.worst] > RANK[st.incident.severity];
      if (st.incident === undefined || upgrade) {
        const incident: Incident = {
          probe: probe.name, severity: st.worst, openedAt: this.now(), ...(reading.note ? { note: reading.note } : {}),
        };
        st.incident = incident;
        this.audit("ops.escalated", { probe: probe.name, severity: st.worst, upgraded: upgrade, note: reading.note });
        this.opts.onEscalate?.(incident);
        push({ type: "escalated", probe: probe.name, severity: st.worst, note: reading.note, upgraded: upgrade });
      }
      // else: incident already open at >= this severity → suppressed (cooldown).
    }
    return events;
  }

  /** Currently open incidents (one per unhealthy probe). */
  incidents(): readonly Incident[] {
    return [...this.state.values()].map((s) => s.incident).filter((i): i is Incident => i !== undefined);
  }
}

/** A live health probe over HTTP: 2xx ⇒ ok, other/timeout ⇒ critical. Used by the CLI `ops` loop. */
export function httpProbe(name: string, url: string, timeoutMs = 5000): Probe {
  return {
    name,
    async check(): Promise<Reading> {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: ctl.signal });
        if (res.ok) return { status: "ok", note: `${res.status} ${url}` };
        return { status: res.status >= 500 ? "critical" : "warn", note: `${res.status} ${url}` };
      } catch (e) {
        return { status: "critical", note: `unreachable: ${e instanceof Error ? e.message : String(e)}` };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
