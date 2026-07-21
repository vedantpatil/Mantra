import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The audit trail (P5). An append-only, structured record of everything the control plane
 * did that a human might later need to account for: ops escalations/resolutions, effector
 * actions, ship merges/deploys, review decisions. Kept separate from the task event log
 * (which is per-task state) — this is the cross-cutting "who/what/when" ledger (FR-24).
 */
export interface AuditEvent {
  readonly at: number;
  /** Dotted kind, e.g. `ops.escalated`, `ops.resolved`, `effector.gitPush`, `ship.merged`. */
  readonly kind: string;
  readonly project?: string;
  /** Structured payload — must never contain secret VALUES, only refs/summaries. */
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface AuditSink {
  record(event: AuditEvent): void;
  entries(): readonly AuditEvent[];
}

/** Append-only audit ledger at `<repo>/.mantra/state/audit.jsonl` — one JSON event per line. */
export class FileAuditLog implements AuditSink {
  private readonly file: string;

  constructor(repoPath: string) {
    const dir = join(repoPath, ".mantra", "state");
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "audit.jsonl");
  }

  record(event: AuditEvent): void {
    appendFileSync(this.file, `${JSON.stringify(event)}\n`);
  }

  entries(): readonly AuditEvent[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as AuditEvent);
  }
}

/** In-memory audit sink for tests and dry runs. */
export class MemoryAuditLog implements AuditSink {
  private readonly log: AuditEvent[] = [];
  record(event: AuditEvent): void {
    this.log.push(event);
  }
  entries(): readonly AuditEvent[] {
    return this.log;
  }
}
