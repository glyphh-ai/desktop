// Assemble the split HTML entrypoints (index.html, home.html) from their source
// templates + section partials.
//
// Large HTML files are split for maintainability: a *.template.html holds the
// shell with `<!--#include sections/NAME.html -->` markers, and each section
// lives in src/renderer/sections/NAME.html. This inlines the partials into a
// single document at build time so the runtime is byte-for-byte what it was
// before the split (section JS binds by element id at boot, so a single
// assembled document is required).
//
// Run by `build:renderer` after tsc + the static copies.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src", "renderer");
const OUT = join(ROOT, "dist", "renderer");

// template file (under src/renderer) → output file (under dist/renderer)
const TARGETS = [
  ["index.template.html", "index.html"],
  ["home.template.html", "home.html"],
];

mkdirSync(OUT, { recursive: true });

for (const [templateName, outName] of TARGETS) {
  const template = readFileSync(join(SRC, templateName), "utf8");
  const assembled = template.replace(
    /^[ \t]*<!--#include (.+?) -->[ \t]*$/gm,
    (_match, rel) => readFileSync(join(SRC, rel.trim()), "utf8").replace(/\n$/, ""),
  );
  if (/<!--#include /.test(assembled)) {
    throw new Error(`assemble-home: unresolved #include marker(s) remain in ${outName}`);
  }
  writeFileSync(join(OUT, outName), assembled);
  console.log(`assembled dist/renderer/${outName}`);
}
