import { type SecretRef, secretRef } from "@mantra/core";
import type { SecretProvider } from "./effector.js";

/**
 * Env-backed secret provider (ADR-3). SecretRefs are `env://VAR_NAME`; the value is
 * read from the process environment inside the trusted boundary and never logged.
 * The vault-backed provider (P5) implements the same interface.
 */
export class EnvSecretProvider implements SecretProvider {
  async resolve(ref: SecretRef): Promise<string> {
    const s = String(ref);
    if (!s.startsWith("env://")) throw new Error(`EnvSecretProvider only handles env:// refs, got ${s}`);
    const name = s.slice("env://".length);
    const value = process.env[name];
    if (!value) throw new Error(`secret ${name} not set in environment`);
    return value;
  }
}

/** Convenience: the ref for an environment variable. */
export const envRef = (name: string): SecretRef => secretRef(`env://${name}`);
