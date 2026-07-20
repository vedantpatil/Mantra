import { createInterface } from "node:readline/promises";
import type { ActionIntent, Confirmer } from "@mantra/orchestrator";

/**
 * Interactive human gate (FR-21 / ADR-2): irreversible actions pause for a typed y/N
 * on the terminal — the CLI stand-in for the Decisions queue.
 */
export class StdinConfirmer implements Confirmer {
  async confirm(action: ActionIntent): Promise<boolean> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const cmd = action.args.command ? ` (${action.args.command})` : "";
      const answer = await rl.question(`\n⚠ irreversible: ${action.kind} on ${action.projectId}${cmd} — approve? [y/N] `);
      return answer.trim().toLowerCase() === "y";
    } finally {
      rl.close();
    }
  }
}

/** Never approves — used by --dry-run so nothing irreversible can slip through. */
export class DenyConfirmer implements Confirmer {
  async confirm(): Promise<boolean> {
    return false;
  }
}
