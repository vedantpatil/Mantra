import { createInterface } from "node:readline";
import { FileVault } from "@mantra/orchestrator";

/**
 * Terminal surface for the secrets vault. Secret VALUES are read from stdin (never argv, so
 * they don't land in shell history) and the vault is unlocked with `MANTRA_VAULT_KEY`.
 * Store a ref as `vault://<key>` in .mantra/config.json (apiKeyRef) or a deploy secretRef.
 */
export async function vaultCommand(sub: string | undefined, key: string | undefined): Promise<number> {
  const vault = new FileVault();

  switch (sub) {
    case "list": {
      const keys = vault.list();
      console.log(keys.length ? keys.map((k) => `  ${k}  →  vault://${k}`).join("\n") : "  (vault is empty)");
      return 0;
    }
    case "set": {
      if (!key) return usage("set <key>");
      if (!process.env.MANTRA_VAULT_KEY) return noPass();
      const value = await readSecret(`Enter secret for '${key}' (input hidden on paste): `);
      if (!value) { console.error("✗ empty secret — nothing stored"); return 1; }
      vault.set(key, value);
      console.log(`✓ stored vault://${key} (encrypted). Reference it as "vault://${key}".`);
      return 0;
    }
    case "get": {
      if (!key) return usage("get <key>");
      if (!process.env.MANTRA_VAULT_KEY) return noPass();
      try {
        process.stdout.write(`${vault.get(key)}\n`);
        return 0;
      } catch (e) {
        console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }
    case "rm": {
      if (!key) return usage("rm <key>");
      console.log(vault.delete(key) ? `✓ removed vault://${key}` : `✗ '${key}' was not in the vault`);
      return 0;
    }
    default:
      return usage("<set|get|list|rm> [key]");
  }
}

function usage(form: string): number {
  console.error(`✗ usage: mantra vault ${form}\n\nUnlock with MANTRA_VAULT_KEY. Examples:\n` +
    `  echo -n "sk-ant-..." | mantra vault set ANTHROPIC_API_KEY\n` +
    `  mantra vault list\n  mantra vault get ANTHROPIC_API_KEY`);
  return 1;
}
function noPass(): number {
  console.error("✗ MANTRA_VAULT_KEY is not set — export a passphrase to unlock the vault.");
  return 1;
}

/** Read a secret from stdin: piped data if present, else a single interactive line. */
function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return new Promise((resolve) => {
      let buf = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (d) => (buf += d));
      process.stdin.on("end", () => resolve(buf.replace(/\r?\n$/, "")));
    });
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => rl.question(prompt, (answer) => { rl.close(); resolve(answer.trim()); }));
}
