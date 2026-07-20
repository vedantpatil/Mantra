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

export class Effector {
  constructor(
    private readonly secrets: SecretProvider,
    private readonly confirmer: Confirmer,
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
    void secret; // handed to the side-effect impl below, never to an agent.

    // TODO(P1+): perform the real side effect (git push / ssh deploy / migration / rm)
    // with idempotency keys (ADR-10). Stubbed so the control path is exercised now.
    return Ok({ kind: action.kind, detail: `executed ${action.kind} for ${action.projectId}` });
  }
}
