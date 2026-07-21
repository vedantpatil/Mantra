import { basename, resolve } from "node:path";
import {
  FileAuditLog, type OpsEvent, OpsMonitor, type Probe, httpProbe, loadProjectConfig,
} from "@mantra/orchestrator";

export interface OpsFlags {
  readonly once: boolean;
  readonly intervalSec: number;
}

/** Terminal renderer for the Ops agent: poll the project's monitors, triage, escalate to the operator. */
export async function opsCommand(repoArg: string, flags: OpsFlags): Promise<number> {
  const repoPath = resolve(repoArg);
  const name = basename(repoPath);
  const config = loadProjectConfig(repoPath, name);
  const monitors = config.monitors ?? [];
  if (monitors.length === 0) {
    console.error(`\n✗ no monitors configured for ${name}. Add a "monitors" array to .mantra/config.json, e.g.\n` +
      `  "monitors": [{ "name": "web", "url": "https://example.com/health" }]`);
    return 1;
  }

  const probes: Probe[] = monitors.map((m) => httpProbe(m.name, m.url));
  const onEvent = (e: OpsEvent): void => {
    switch (e.type) {
      case "reading": if (e.status !== "ok") console.log(`  · ${e.probe}: ${e.status}${e.note ? ` (${e.note})` : ""}`); break;
      case "escalated": console.log(`\n🚨 ESCALATE ${e.probe} — ${e.severity}${e.upgraded ? " (upgraded)" : ""}${e.note ? `: ${e.note}` : ""}`); break;
      case "resolved": console.log(`\n✓ resolved ${e.probe} (was ${e.wasSeverity})`); break;
      case "probe-error": console.warn(`  ⚠ ${e.probe} probe error: ${e.error}`); break;
    }
  };

  const monitor = new OpsMonitor({
    probes,
    audit: new FileAuditLog(repoPath),
    project: name,
    onEvent,
    onEscalate: (inc) => console.log(`   → surfaced to operator: ${inc.probe} ${inc.severity} (human-gated remediation)`),
  });

  console.log(`\n▸ ops watching ${probes.length} monitor(s) on ${name}: ${monitors.map((m) => m.name).join(", ")}`);
  if (flags.once) {
    await monitor.tick();
    const open = monitor.incidents();
    console.log(`\n▸ ${open.length ? `${open.length} open incident(s)` : "all healthy"}. Audit → .mantra/state/audit.jsonl`);
    return open.length ? 2 : 0;
  }

  console.log(`▸ polling every ${flags.intervalSec}s — Ctrl-C to stop.\n`);
  for (;;) {
    await monitor.tick();
    await new Promise((r) => setTimeout(r, flags.intervalSec * 1000));
  }
}
