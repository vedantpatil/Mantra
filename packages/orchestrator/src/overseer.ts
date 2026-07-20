import type { Project, ProjectId, RegistryWriter } from "@mantra/core";
import type { Bus } from "./bus.js";
import { Supervisor } from "./supervisor.js";

/**
 * Tier-0 Overseer. One, always-on. Sole writer of the registry (ADR-6), owner of the
 * bus, and supervisor-of-supervisors: it spawns one Supervisor per project and, on
 * start, reconciles each so no crash leaves orphaned work.
 */
export class Overseer {
  private readonly supervisors = new Map<ProjectId, Supervisor>();

  constructor(
    private readonly registry: RegistryWriter,
    private readonly bus: Bus,
  ) {}

  async start(): Promise<void> {
    const projects = await this.registry.listProjects();
    for (const project of projects) this.attach(project);
    for (const sup of this.supervisors.values()) sup.reconcile();
    await this.bus.publish("overseer.started", { projects: projects.length });
  }

  private attach(project: Project): Supervisor {
    const sup = new Supervisor(project.id, this.bus);
    this.supervisors.set(project.id, sup);
    return sup;
  }

  supervisor(projectId: ProjectId): Supervisor | undefined {
    return this.supervisors.get(projectId);
  }
}
