import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type Agent,
  type Decision,
  type DecisionId,
  type GlobalSettings,
  type Project,
  type ProjectId,
  type RegistryWriter,
  type Result,
  type Role,
  Err,
  Ok,
  SCHEMA_VERSION,
  agentId,
  decisionId,
  projectId,
  secretRef,
} from "@mantra/core";

/**
 * SQLite-backed registry (ADR-6). The Overseer is the sole holder of this writer;
 * WAL mode plus a single writer avoids the multi-process contention that a shared
 * SQLite file otherwise invites. Every row's schema is versioned via `meta`.
 *
 * Uses Node's built-in `node:sqlite` — no native build step, no external dependency.
 */
export class SqliteRegistry implements RegistryWriter {
  private readonly db: DatabaseSync;

  /** @param path e.g. `~/.mantra/registry.db` (`:memory:` for tests). */
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
        port_lo INTEGER NOT NULL, port_hi INTEGER NOT NULL,
        web_port INTEGER NOT NULL, api_port INTEGER NOT NULL,
        daily_budget REAL NOT NULL, stage TEXT NOT NULL, crew_template TEXT NOT NULL,
        api_key_ref TEXT, dual_graph_enabled INTEGER NOT NULL, schema_version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agents(
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL,
        session_id TEXT, status TEXT NOT NULL, tokens_today INTEGER NOT NULL, spend_today REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS decisions(
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL,
        summary TEXT NOT NULL, risk TEXT NOT NULL, options TEXT NOT NULL, status TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS agents_by_project ON agents(project_id);
      CREATE INDEX IF NOT EXISTS decisions_by_status ON decisions(status);
    `);
    const found = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    if (!found) {
      this.db.prepare("INSERT INTO meta(key, value) VALUES('schema_version', ?)").run(String(SCHEMA_VERSION));
    } else if (Number(found.value) !== SCHEMA_VERSION) {
      throw new Error(`registry schema v${found.value} != code v${SCHEMA_VERSION}; migration required`);
    }
  }

  /** Seed or replace the fleet-wide defaults. Must be called once before getGlobal(). */
  setGlobal(global: GlobalSettings): void {
    this.db
      .prepare("INSERT INTO meta(key, value) VALUES('global', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(global));
  }

  async getGlobal(): Promise<GlobalSettings> {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'global'").get();
    if (!row) throw new Error("global settings not initialized — call setGlobal() first");
    return JSON.parse(String(row.value)) as GlobalSettings;
  }

  async listProjects(): Promise<readonly Project[]> {
    return this.db.prepare("SELECT * FROM projects").all().map(rowToProject);
  }

  async getProject(id: ProjectId): Promise<Project | undefined> {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    return row ? rowToProject(row) : undefined;
  }

  async listAgents(id: ProjectId): Promise<readonly Agent[]> {
    return this.db.prepare("SELECT * FROM agents WHERE project_id = ?").all(id).map(rowToAgent);
  }

  async listOpenDecisions(): Promise<readonly Decision[]> {
    return this.db.prepare("SELECT * FROM decisions WHERE status = 'open'").all().map(rowToDecision);
  }

  async putProject(p: Project): Promise<Result<Project>> {
    try {
      this.db
        .prepare(
          `INSERT INTO projects(id,name,path,port_lo,port_hi,web_port,api_port,daily_budget,stage,crew_template,api_key_ref,dual_graph_enabled,schema_version)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET name=excluded.name, path=excluded.path, port_lo=excluded.port_lo,
             port_hi=excluded.port_hi, web_port=excluded.web_port, api_port=excluded.api_port,
             daily_budget=excluded.daily_budget, stage=excluded.stage, crew_template=excluded.crew_template,
             api_key_ref=excluded.api_key_ref, dual_graph_enabled=excluded.dual_graph_enabled, schema_version=excluded.schema_version`,
        )
        .run(
          p.id, p.name, p.path, p.portRange[0], p.portRange[1], p.webPort, p.apiPort,
          p.dailyBudget, p.stage, p.crewTemplate, p.apiKeyRef ?? null, p.dualGraph.enabled ? 1 : 0, p.schemaVersion,
        );
      return Ok(p);
    } catch (e) {
      return Err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async putAgent(a: Agent): Promise<Result<Agent>> {
    try {
      this.db
        .prepare(
          `INSERT INTO agents(id,project_id,role,model,session_id,status,tokens_today,spend_today)
           VALUES(?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, role=excluded.role, model=excluded.model,
             session_id=excluded.session_id, status=excluded.status, tokens_today=excluded.tokens_today, spend_today=excluded.spend_today`,
        )
        .run(a.id, a.projectId, a.role, a.model, a.sessionId ?? null, a.status, a.tokensToday, a.spendToday);
      return Ok(a);
    } catch (e) {
      return Err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async putDecision(d: Decision): Promise<Result<Decision>> {
    try {
      this.db
        .prepare(
          `INSERT INTO decisions(id,project_id,type,title,summary,risk,options,status)
           VALUES(?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, type=excluded.type, title=excluded.title,
             summary=excluded.summary, risk=excluded.risk, options=excluded.options, status=excluded.status`,
        )
        .run(d.id, d.projectId, d.type, d.title, d.summary, d.risk, JSON.stringify(d.options), d.status);
      return Ok(d);
    } catch (e) {
      return Err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async resolveDecision(id: DecisionId): Promise<Result<void>> {
    const info = this.db.prepare("UPDATE decisions SET status = 'resolved' WHERE id = ?").run(id);
    return info.changes === 0n ? Err(new Error(`no decision ${id}`)) : Ok(undefined);
  }

  close(): void {
    this.db.close();
  }
}

type Row = Record<string, unknown>;

function rowToProject(r: Row): Project {
  return {
    id: projectId(String(r.id)),
    name: String(r.name),
    path: String(r.path),
    portRange: [Number(r.port_lo), Number(r.port_hi)],
    webPort: Number(r.web_port),
    apiPort: Number(r.api_port),
    dailyBudget: Number(r.daily_budget),
    stage: String(r.stage) as Project["stage"],
    crewTemplate: String(r.crew_template),
    apiKeyRef: r.api_key_ref == null ? undefined : secretRef(String(r.api_key_ref)),
    dualGraph: { enabled: Number(r.dual_graph_enabled) === 1 },
    schemaVersion: Number(r.schema_version),
  };
}

function rowToAgent(r: Row): Agent {
  return {
    id: agentId(String(r.id)),
    projectId: projectId(String(r.project_id)),
    role: String(r.role) as Role,
    model: String(r.model),
    sessionId: r.session_id == null ? undefined : String(r.session_id),
    status: String(r.status) as Agent["status"],
    tokensToday: Number(r.tokens_today),
    spendToday: Number(r.spend_today),
  };
}

function rowToDecision(r: Row): Decision {
  return {
    id: decisionId(String(r.id)),
    projectId: projectId(String(r.project_id)),
    type: String(r.type),
    title: String(r.title),
    summary: String(r.summary),
    risk: String(r.risk) as Decision["risk"],
    options: JSON.parse(String(r.options)) as string[],
    status: String(r.status) as Decision["status"],
  };
}
