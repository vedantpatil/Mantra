import {
  type AgentId,
  type Capability,
  type ProjectId,
  type Result,
  type Role,
  type SecretRef,
  Err,
  Ok,
  resolveGrant,
} from "@mantra/core";

/**
 * The trusted Effector (ADR-2, ADR-3). Agents NEVER run ssh/deploy/rm/db/push
 * directly — they emit an ActionIntent, and this system-side executor performs it
 * behind the permission matrix + human gate. Secret VALUES live only here; they are
 * never returned to, or serialized for, an agent.
 */
export type ActionKind = "gitPush" | "sshDeploy" | "dbMutate" | "fsDelete";

const CAPABILITY_OF: Readonly<Record<ActionKind, Capability>> = {
  gitPush: "gitPush",
  sshDeploy: "sshDeploy",
  dbMutate: "dbMutate",
  fsDelete: "fsDelete",
};

export interface ActionIntent {
  readonly kind: ActionKind;
  readonly projectId: ProjectId;
  readonly agentId: AgentId;
  readonly role: Role;
  readonly args: Readonly<Record<string, string>>;
  /** Which secret the action needs — a reference only (ADR-3). */
  readonly secretRef?: SecretRef;
}

/** Resolves a SecretRef to a real value inside the trusted boundary only. */
export interface SecretProvider {
  resolve(ref: SecretRef): Promise<string>;
}

/** Surfaces an irreversible action to the human and awaits their decision. */
export interface Confirmer {
  confirm(action: ActionIntent): Promise<boolean>;
}

export interface EffectorResult {
  readonly kind: ActionKind;
  readonly detail: string;
}

/**
 * Performs the real side effect for an action kind, INSIDE the trusted boundary and only
 * after the permission + human gates have passed. Receives the resolved secret value (if any);
 * that value must never be returned to or serialized for an agent. Returns a short detail line.
 */
export type SideEffect = (action: ActionIntent, secret?: string) => Promise<string>;
export type SideEffects = Partial<Record<ActionKind, SideEffect>>;

export class Effector {
  constructor(
    private readonly secrets: SecretProvider,
    private readonly confirmer: Confirmer,
    /** Real executors per action kind. Kinds without one are gated-then-stubbed (the control
     * path runs, no side effect) — this is intentional for agent-driven runs, which never
     * really push/deploy. The operator-driven Shipper wires live effects (see git-host.ts). */
    private readonly effects: SideEffects = {},
  ) {}

  async execute(action: ActionIntent): Promise<Result<EffectorResult>> {
    const grant = resolveGrant(action.role, CAPABILITY_OF[action.kind]);
    if (grant === "deny") {
      return Err(new Error(`role ${action.role} may not ${action.kind}`));
    }
    if (grant === "confirm") {
      const approved = await this.confirmer.confirm(action);
      if (!approved) return Err(new Error(`human declined ${action.kind}`));
    }

    // Secret value is resolved HERE and never leaves this scope.
    const secret = action.secretRef ? await this.secrets.resolve(action.secretRef) : undefined;

    const perform = this.effects[action.kind];
    try {
      const detail = perform
        ? await perform(action, secret)
        : `executed ${action.kind} for ${action.projectId}`; // no live effector wired → stub
      return Ok({ kind: action.kind, detail });
    } catch (e) {
      return Err(e instanceof Error ? e : new Error(String(e)));
    }
  }
}
