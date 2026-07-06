// Bundle the host-provided UI libraries for Glyphh apps into
// dist/renderer/app-libs/. At runtime the host copies these to
// ~/.glyphh/custom-apps/_libs/ so any installed app can load them with a relative
// <script src="../_libs/<name>.js"> — no vendoring, no network, versioned
// with Glyphh. Run: `node scripts/build-app-libs.mjs`.

import { build } from "esbuild";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "dist", "renderer", "app-libs");

const LIBS = [
  { entry: "chart-entry.js", out: "chart.js" },   // → window.Chart
  { entry: "three-entry.js", out: "three.js" },   // → window.THREE
  { entry: "flow-entry.jsx", out: "flow.js" },    // → window.GlyphhFlow
];

for (const lib of LIBS) {
  await build({
    entryPoints: [join(ROOT, "scripts", "app-libs", lib.entry)],
    outfile: join(OUT, lib.out),
    bundle: true,
    minify: true,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    loader: { ".css": "text" },
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "warning",
  });
  console.log(`bundled app-libs/${lib.out}`);
}
