#!/usr/bin/env node
import { parseArgs } from "node:util";
import type { Role } from "@mantra/core";
import { runCommand, type RunFlags } from "./run.js";

const ROLES: readonly Role[] = ["manager", "developer", "qa", "devops", "marketer", "ops"];

const USAGE = `mantra — voice/console control plane over Claude Code agent crews

Usage:
  mantra run <repo-path> "<task>" [options]

Options:
  --role <role>     crew role (default: developer) — ${ROLES.join(" | ")}
  --model <id>      Claude model (default: claude-sonnet-5)
  --budget <usd>    circuit-breaker spend cap for this run (default: 2)
  --no-push         deny git push (recommended for first tests)
  --no-graph        disable the dual-graph context MCP (for A/B token comparison)
  --dry-run         read-only: deny all writes and never confirm irreversible ops
  --keep            keep the task worktree after the run (to inspect the diff)
  -h, --help        show this help

First live test: clone a throwaway repo, then e.g.
  mantra run ~/mantra-test/website "summarize the stack and list the main entry points" --dry-run
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      role: { type: "string", default: "developer" },
      model: { type: "string", default: "claude-sonnet-5" },
      budget: { type: "string", default: "2" },
      "no-push": { type: "boolean", default: false },
      "no-graph": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      keep: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const [command, repo, task] = positionals;
  if (values.help || command !== "run") {
    console.log(USAGE);
    return values.help ? 0 : command ? 1 : 0;
  }
  if (!repo || !task) {
    console.error("✗ usage: mantra run <repo-path> \"<task>\"\n");
    console.log(USAGE);
    return 1;
  }
  if (!ROLES.includes(values.role as Role)) {
    console.error(`✗ unknown role '${values.role}'. One of: ${ROLES.join(", ")}`);
    return 1;
  }
  const budget = Number(values.budget);
  if (!Number.isFinite(budget) || budget <= 0) {
    console.error(`✗ --budget must be a positive number, got '${values.budget}'`);
    return 1;
  }

  const flags: RunFlags = {
    role: values.role as Role,
    model: values.model as string,
    budget,
    noPush: values["no-push"] as boolean,
    noGraph: values["no-graph"] as boolean,
    dryRun: values["dry-run"] as boolean,
    keep: values.keep as boolean,
  };
  return runCommand(repo, task, flags);
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
