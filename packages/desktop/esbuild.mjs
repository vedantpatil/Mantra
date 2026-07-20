import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, "dist");
mkdirSync(out, { recursive: true });

const common = { bundle: true, sourcemap: true, logLevel: "info" };

// Electron main + preload run in Node/Electron — CJS, electron stays external.
await build({
  ...common,
  entryPoints: [join(root, "src/main.ts")],
  outfile: join(out, "main.cjs"),
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["electron"],
});
await build({
  ...common,
  entryPoints: [join(root, "src/preload.ts")],
  outfile: join(out, "preload.cjs"),
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["electron"],
});

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
