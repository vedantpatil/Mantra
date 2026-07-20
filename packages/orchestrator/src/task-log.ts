import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskEvent } from "@mantra/core";

/** Something the Supervisor can append task events to (ADR-5). */
export interface TaskEventSink {
  append(event: TaskEvent): void;
}

/**
 * Append-only persistence for a project's task event log at
 * `<repo>/.mantra/state/tasks.jsonl` (ADR-5, ADR-6: repo-local, supervisor-owned).
 * One JSON event per line — the log is the source of truth; projections are folds
 * over `replay()`, so a restart reconstructs exact task state.
 */
export class FileTaskLog implements TaskEventSink {
  private readonly file: string;

  constructor(repoPath: string) {
    const dir = join(repoPath, ".mantra", "state");
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "tasks.jsonl");
  }

  append(event: TaskEvent): void {
    appendFileSync(this.file, `${JSON.stringify(event)}\n`);
  }

  replay(): readonly TaskEvent[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as TaskEvent);
  }
}
