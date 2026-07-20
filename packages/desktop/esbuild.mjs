import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, "dist");
mkdirSync(out, { recursive: true });

const common = { bundle: true, sourcemap: true, logLevel: "info" };

// Main process = ESM (.mjs) so it can `import` the ESM-only Agent SDK as a real, external
// file (the SDK uses import.meta.url to find its own subprocess assets, so it must NOT be
// bundled). Our own @mantra/* packages ARE bundled in, so packaging only needs the SDK.
await build({
  ...common,
  entryPoints: [join(root, "src/main.ts")],
  outfile: join(out, "main.mjs"),
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["electron", "@anthropic-ai/claude-agent-sdk"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});

// Preload = CJS (electron loads it in a special context); it imports only electron.
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
