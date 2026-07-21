#!/usr/bin/env node
import { parseArgs } from "node:util";
import type { Role } from "@mantra/core";
import { crewCommand, type CrewFlags } from "./crew.js";
import { runCommand, type RunFlags } from "./run.js";
import { shipCommand, type ShipFlags } from "./ship.js";

const ROLES: readonly Role[] = ["manager", "developer", "qa", "devops", "marketer", "ops"];

const USAGE = `mantra — voice/console control plane over Claude Code agent crews

Usage:
  mantra run  <repo-path> "<task>"  [options]   run a single agent task
  mantra crew <repo-path> "<goal>"  [options]   decompose a goal + drive the crew to review
  mantra ship <repo-path> "<title>" [options]   push → PR → CI gate → auto-merge → guarded deploy

Options:
  --role <role>     (run only) crew role (default: developer) — ${ROLES.join(" | ")}
  --model <id>      Claude model (default: claude-sonnet-5)
  --budget <usd>    circuit-breaker spend cap per task (default: 2)
  --no-push         (run only) deny git push — crew is always push-denied
  --no-graph        disable the dual-graph context MCP (for A/B token comparison)
  --dry-run         read-only: deny all writes and never confirm irreversible ops
  --keep            (run only) keep the task worktree after the run (to inspect the diff)
  --base <branch>   (ship only) PR base branch (default: main)
  --branch <name>   (ship only) branch to ship (default: the repo's current branch)
  --deploy <env>    (ship only) deploy after a green merge — always confirmed
  --deploy-cmd <c>  (ship only) shell command the deploy runs (in the repo)
  --no-merge        (ship only) stop at a green PR instead of auto-merging
  -h, --help        show this help

First live tests (clone a throwaway repo first):
  mantra run  ~/mantra-test/website "summarize the stack and list the main entry points" --dry-run
  mantra crew ~/mantra-test/website "add a health-check endpoint" --model claude-haiku-4-5
  mantra ship ~/mantra-test/website "Add health-check endpoint" --deploy staging --deploy-cmd "./deploy.sh"
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
      base: { type: "string", default: "main" },
      branch: { type: "string" },
      deploy: { type: "string" },
      "deploy-cmd": { type: "string" },
      "no-merge": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const [command, repo, task] = positionals;
  const KNOWN = new Set(["run", "crew", "ship"]);
  if (values.help || !KNOWN.has(command)) {
    console.log(USAGE);
    return values.help ? 0 : command ? 1 : 0;
  }
  if (!repo || !task) {
    const noun = command === "crew" ? "goal" : command === "ship" ? "title" : "task";
    console.error(`✗ usage: mantra ${command} <repo-path> "<${noun}>"\n`);
    console.log(USAGE);
    return 1;
  }

  if (command === "ship") {
    const flags: ShipFlags = {
      base: values.base as string,
      branch: values.branch as string | undefined,
      deploy: values.deploy as string | undefined,
      deployCmd: values["deploy-cmd"] as string | undefined,
      noMerge: values["no-merge"] as boolean,
      dryRun: values["dry-run"] as boolean,
    };
    return shipCommand(repo, task, flags);
  }

  const budget = Number(values.budget);
  if (!Number.isFinite(budget) || budget <= 0) {
    console.error(`✗ --budget must be a positive number, got '${values.budget}'`);
    return 1;
  }

  if (command === "crew") {
    const flags: CrewFlags = {
      model: values.model as string,
      budget,
      noPush: true, // crew is always push-denied (matches desktop + first-test safety posture)
      noGraph: values["no-graph"] as boolean,
      dryRun: values["dry-run"] as boolean,
    };
    return crewCommand(repo, task, flags);
  }

  if (!ROLES.includes(values.role as Role)) {
    console.error(`✗ unknown role '${values.role}'. One of: ${ROLES.join(", ")}`);
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
