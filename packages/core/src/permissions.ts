/**
 * Permission matrix (REQUIREMENTS §6) — enforced as CODE, never as a prompt (ADR-4).
 * `confirm` = the capability is allowed only behind an explicit human confirmation.
 * Irreversible capabilities are ALWAYS confirmed regardless of role.
 */
export type Role = "manager" | "developer" | "qa" | "devops" | "marketer" | "ops";

export type Capability =
  | "read"
  | "editCode"
  | "editTests"
  | "gitPush"
  | "sshDeploy"
  | "dbMutate"
  | "fsDelete";

export type Grant = "allow" | "deny" | "confirm";

/** Capabilities that touch the outside world irreversibly — human-confirmed no matter what. */
export const IRREVERSIBLE: ReadonlySet<Capability> = new Set([
  "sshDeploy",
  "dbMutate",
  "fsDelete",
]);

/** Default per-role grants. `read` omitted entries default to "deny". */
export const DEFAULT_MATRIX: Readonly<Record<Role, Partial<Record<Capability, Grant>>>> = {
  manager: { read: "allow" },
  developer: { read: "allow", editCode: "allow", editTests: "allow", gitPush: "allow" },
  qa: { read: "allow", editTests: "allow" },
  devops: { read: "allow", gitPush: "allow", sshDeploy: "confirm", dbMutate: "confirm" },
  marketer: { read: "allow" },
  ops: { read: "allow", sshDeploy: "confirm", dbMutate: "confirm" },
};

/**
 * Resolve the effective grant for a (role, capability). Irreversible caps can never
 * resolve to a bare "allow" — the strongest they get is "confirm".
 */
export function resolveGrant(
  role: Role,
  cap: Capability,
  matrix: Record<Role, Partial<Record<Capability, Grant>>> = DEFAULT_MATRIX,
): Grant {
  const base = matrix[role]?.[cap] ?? "deny";
  if (base === "deny") return "deny";
  if (IRREVERSIBLE.has(cap)) return "confirm";
  return base;
}
