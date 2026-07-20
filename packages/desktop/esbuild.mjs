import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, "dist");
mkdirSync(out, { recursive: true });

const common = { bundle: true, sourcemap: true, logLevel: "info" };

// Electron main + preload run in Node/Electron — CJS. Externalize all node_modules
// (electron, @mantra/orchestrator, the Agent SDK) so they're required at runtime.
const nodeSide = { ...common, platform: "node", format: "cjs", target: "node20", packages: "external" };
await build({ ...nodeSide, entryPoints: [join(root, "src/main.ts")], outfile: join(out, "main.cjs") });
await build({ ...nodeSide, entryPoints: [join(root, "src/preload.ts")], outfile: join(out, "preload.cjs") });

// Renderer bundles React + CSS for the sandboxed browser context.
await build({
  ...common,
  entryPoints: [join(root, "src/renderer/main.tsx")],
  outfile: join(out, "renderer.js"),
  platform: "browser",
  format: "iife",
  target: "es2022",
  jsx: "automatic",
  loader: { ".css": "css" },
});

copyFileSync(join(root, "src/renderer/index.html"), join(out, "index.html"));
console.log("desktop build ok →", out);
