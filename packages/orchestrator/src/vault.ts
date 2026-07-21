import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type SecretRef, secretRef } from "@mantra/core";
import { EnvSecretProvider } from "./secrets-env.js";
import type { SecretProvider } from "./effector.js";

/**
 * The secrets vault (P5) — encrypted-at-rest storage that replaces bare env vars as the
 * durable secret store (ADR-3). Values are sealed with AES-256-GCM under a key derived
 * (scrypt) from a passphrase that lives only in `MANTRA_VAULT_KEY`, never on disk. GCM's
 * auth tag means a tampered file or a wrong passphrase fails loudly instead of returning
 * garbage. Like every SecretProvider, values are resolved inside the trusted boundary and
 * never logged, returned to an agent, or written to the audit trail.
 */

interface SealedEntry {
  readonly salt: string; // hex — per-entry scrypt salt
  readonly iv: string; // hex — per-entry GCM nonce
  readonly tag: string; // hex — GCM auth tag
  readonly ct: string; // hex — ciphertext
}
interface VaultFile {
  readonly version: number;
  readonly entries: Record<string, SealedEntry>;
}

const VERSION = 1;
const KEY_LEN = 32;

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN, { N: 16384, r: 8, p: 1 });
}

export class FileVault {
  private readonly file: string;

  constructor(
    file: string = join(homedir(), ".mantra", "vault.json"),
    /** Passphrase source; resolved lazily so key-only ops (list/has) never require it. */
    private readonly passphrase: () => string | undefined = () => process.env.MANTRA_VAULT_KEY,
  ) {
    this.file = file;
  }

  private load(): VaultFile {
    if (!existsSync(this.file)) return { version: VERSION, entries: {} };
    const parsed = JSON.parse(readFileSync(this.file, "utf8")) as VaultFile;
    if (parsed.version !== VERSION) throw new Error(`vault version ${parsed.version} != ${VERSION}`);
    return parsed;
  }

  private save(data: VaultFile): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  }

  private secret(): string {
    const p = this.passphrase();
    if (!p) throw new Error("MANTRA_VAULT_KEY is not set — cannot unlock the vault");
    return p;
  }

  /** Encrypt `value` under `key` and persist it (overwrites any existing entry). */
  set(key: string, value: string): void {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", deriveKey(this.secret(), salt), iv);
    const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const data = this.load();
    this.save({
      version: VERSION,
      entries: { ...data.entries, [key]: { salt: salt.toString("hex"), iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ct: ct.toString("hex") } },
    });
  }

  /** Decrypt and return `key`; throws if absent, tampered, or the passphrase is wrong. */
  get(key: string): string {
    const entry = this.load().entries[key];
    if (!entry) throw new Error(`secret '${key}' is not in the vault`);
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(this.secret(), Buffer.from(entry.salt, "hex")), Buffer.from(entry.iv, "hex"));
    decipher.setAuthTag(Buffer.from(entry.tag, "hex"));
    try {
      return Buffer.concat([decipher.update(Buffer.from(entry.ct, "hex")), decipher.final()]).toString("utf8");
    } catch {
      throw new Error(`could not decrypt '${key}' — wrong MANTRA_VAULT_KEY or the vault was tampered with`);
    }
  }

  has(key: string): boolean {
    return key in this.load().entries;
  }

  /** Key NAMES only — never values. Safe to print. */
  list(): readonly string[] {
    return Object.keys(this.load().entries).sort();
  }

  delete(key: string): boolean {
    const data = this.load();
    if (!(key in data.entries)) return false;
    const { [key]: _removed, ...rest } = data.entries;
    this.save({ version: VERSION, entries: rest });
    return true;
  }

  /** Verify the passphrase can unlock an existing entry (round-trips one decrypt). */
  verify(): boolean {
    const keys = this.list();
    if (keys.length === 0) return true; // nothing to check against yet
    try {
      this.get(keys[0]);
      return true;
    } catch {
      return false;
    }
  }
}

/** Resolves `vault://KEY` refs. Constructs the FileVault lazily so env-only runs never touch it. */
export class VaultSecretProvider implements SecretProvider {
  private vault?: FileVault;
  constructor(private readonly make: () => FileVault = () => new FileVault()) {}

  async resolve(ref: SecretRef): Promise<string> {
    const s = String(ref);
    if (!s.startsWith("vault://")) throw new Error(`VaultSecretProvider only handles vault:// refs, got ${s}`);
    this.vault ??= this.make();
    return this.vault.get(s.slice("vault://".length));
  }
}

/**
 * Routes a SecretRef to the provider for its scheme: `env://` → env, `vault://` → vault.
 * This is the default provider everywhere, so existing env refs keep working while new
 * `vault://` refs resolve from the encrypted store — a drop-in for bare EnvSecretProvider.
 */
export class CompositeSecretProvider implements SecretProvider {
  constructor(
    private readonly env: SecretProvider = new EnvSecretProvider(),
    private readonly vault: SecretProvider = new VaultSecretProvider(),
  ) {}

  async resolve(ref: SecretRef): Promise<string> {
    const s = String(ref);
    if (s.startsWith("vault://")) return this.vault.resolve(ref);
    if (s.startsWith("env://")) return this.env.resolve(ref);
    throw new Error(`unknown secret scheme in '${s}' (expected env:// or vault://)`);
  }
}

/** The default secret provider — env + vault, routed by scheme. */
export const defaultSecretProvider = (): SecretProvider => new CompositeSecretProvider();

/** Convenience: the ref for a vault-stored secret. */
export const vaultRef = (key: string): SecretRef => secretRef(`vault://${key}`);

/** Constant-time string compare (for passphrase checks that shouldn't leak timing). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
