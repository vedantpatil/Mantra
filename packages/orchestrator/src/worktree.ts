import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import type { TaskId } from "@mantra/core";

const run = promisify(execFile);

/**
 * One git worktree per task (ADR-1). Developer/QA/etc. never share a working
 * directory, so concurrent edits cannot corrupt each other. The review gate merges
 * the task branch; ship opens the PR from the integration branch.
 */
export interface Worktree {
  readonly taskId: TaskId;
  readonly branch: string;
  readonly path: string;
}

export class WorktreeManager {
  constructor(private readonly repoPath: string) {}

  private pathFor(id: TaskId): string {
    return join(this.repoPath, ".mantra", "worktrees", id);
  }

  private branchFor(id: TaskId): string {
    return `mantra/task/${id}`;
  }

  async create(id: TaskId, baseRef = "HEAD"): Promise<Worktree> {
    const path = this.pathFor(id);
    const branch = this.branchFor(id);
    await run("git", ["-C", this.repoPath, "worktree", "add", "-b", branch, path, baseRef]);
    return { taskId: id, branch, path };
  }

  async remove(id: TaskId): Promise<void> {
    await run("git", ["-C", this.repoPath, "worktree", "remove", "--force", this.pathFor(id)]);
  }

  async list(): Promise<string> {
    const { stdout } = await run("git", ["-C", this.repoPath, "worktree", "list", "--porcelain"]);
    return stdout;
  }
}
