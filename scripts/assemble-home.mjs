// Assemble dist/renderer/home.html from the source template + section partials.
//
// home.html is split for maintainability: src/renderer/home.template.html holds
// the shell (head, nav, modals) with `<!--#include sections/NAME.html -->`
// markers, and each dashboard section lives in src/renderer/sections/NAME.html.
// This inlines the partials into a single home.html at build time so the
// runtime is byte-for-byte what it was before the split (the section JS binds
// by element id at boot, so a single assembled document is required).
//
// Run by `build:renderer` after tsc + the static copies.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src", "renderer");
const OUT = join(ROOT, "dist", "renderer");

const template = readFileSync(join(SRC, "home.template.html"), "utf8");

const assembled = template.replace(
  /^[ \t]*<!--#include (.+?) -->[ \t]*$/gm,
  (_match, rel) => readFileSync(join(SRC, rel.trim()), "utf8").replace(/\n$/, ""),
);

if (/<!--#include /.test(assembled)) {
  throw new Error("assemble-home: unresolved #include marker(s) remain");
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "home.html"), assembled);
console.log("assembled dist/renderer/home.html");
