#!/usr/bin/env node
/**
 * check-renderer-emit.mjs — the renderer's JS landed where the app loads it.
 *
 * THE INCIDENT (2026-09-17): one renderer file imported `src/shared/*`. tsc
 * infers its rootDir from the common ancestor of its inputs, so the root moved
 * from `src/renderer` to `src`, and every renderer module emitted to
 * `dist/renderer/renderer/**` — a directory `home.html` never loads. The build
 * exited 0 for hours while the app ran the last good bundle, so every renderer
 * change looked like it did nothing, and I blamed his build instead of mine.
 *
 * Two checks, both cheap, run right after tsc:
 *   1. no nested `dist/renderer/renderer` (the rootDir moved)
 *   2. every `src/renderer/**\/*.ts` in the project has a `.js` beside the page
 *      that is NOT older than its source (nothing silently skipped emit)
 */

import fs from "fs";
import path from "path";

const root = path.resolve(import.meta.dirname, "..");
const SRC = path.join(root, "src", "renderer");
const OUT = path.join(root, "dist", "renderer");

const die = (lines) => {
  console.error(`\n✗ renderer emit check failed\n\n${lines.join("\n")}\n`);
  process.exit(1);
};

// 1 — the tell-tale nested tree.
const nested = path.join(OUT, "renderer");
if (fs.existsSync(nested)) {
  die([
    `  ${path.relative(root, nested)} exists, so tsc's rootDir moved off src/renderer.`,
    "  Cause: a renderer file imports something OUTSIDE src/renderer (usually src/shared/*).",
    "  Nothing loads that directory: the app keeps running the previous build.",
    "  Fix: keep renderer imports inside src/renderer (put shared pure helpers in src/renderer/help/,",
    "  or have main normalize the data and hand it over IPC), then delete dist/renderer/renderer.",
  ]);
}

// 2 — every source file THIS PROJECT compiles has output at least as new as
// itself. The rest of src/renderer is bundled by esbuild (code-workbench, the
// wb-* panels, skill-flow) and has no business here, so the tsconfig's own
// include list is the authority rather than a guess about the directory.
const raw = fs.readFileSync(path.join(SRC, "tsconfig.json"), "utf8");
// Parse it as the JSON it is. A comment stripper here ate the "/**/" inside
// the "help/**/*.ts" glob and silently reduced the checked set to 7 files;
// only fall back to stripping WHOLE-LINE comments, which cannot touch a glob.
let tsconfig;
try { tsconfig = JSON.parse(raw); }
catch { tsconfig = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")); }
const include = tsconfig.include ?? [];
const sources = [];
for (const entry of include) {
  if (entry.endsWith(".ts") && !entry.includes("*")) {
    const f = path.join(SRC, entry);
    if (fs.existsSync(f)) sources.push(f);
    continue;
  }
  // The only glob shape the project uses: <dir>/**/*.ts
  const dir = path.join(SRC, entry.replace(/\/\*\*\/\*\.tsx?$/, ""));
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && /\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) sources.push(full);
    }
  };
  walk(dir);
}

const missing = [];
const stale = [];
for (const file of sources) {
  const out = path.join(OUT, path.relative(SRC, file)).replace(/\.tsx?$/, ".js");
  if (!fs.existsSync(out)) { missing.push([file, out]); continue; }
  if (fs.statSync(out).mtimeMs + 1000 < fs.statSync(file).mtimeMs) stale.push([file, out]);
}

if (missing.length || stale.length) {
  die([
    ...missing.map(([s, o]) => `  MISSING  ${path.relative(root, o)}  (from ${path.relative(root, s)})`),
    ...stale.map(([s, o]) => `  STALE    ${path.relative(root, o)}  is older than ${path.relative(root, s)}`),
    "",
    "  tsc did not emit these where home.html loads them. Check the renderer tsconfig's",
    "  inputs: one import outside src/renderer moves the whole output tree.",
  ]);
}

console.log(`✓ renderer emit: ${sources.length} modules, all current under dist/renderer`);
