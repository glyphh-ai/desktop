/**
 * check-ipc-registered.mjs — fail the build when an IPC registrar is never called.
 *
 * The desktop wires its main process by hand: each module exports a
 * `register*Ipc()` and main.ts calls it. Nothing enforces the second half, so a
 * rename or a file move can drop a call site and the compiler stays silent —
 * the module still compiles, still exports, and simply never runs.
 *
 * That happened: the William → Glyphh port renamed `registerWilliamIpc` to
 * `registerGlyphhIpc` and lost its call in main.ts. The whole agent surface —
 * sessions, context, runs — went unregistered, and the only symptom was a
 * composer that spun forever, because the renderer's invoke had no handler to
 * answer it. A typecheck cannot catch this. This can.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MAIN_DIR = "src/main";
const files = readdirSync(MAIN_DIR).filter((f) => f.endsWith(".ts"));

/** Every `export function register…Ipc()` in the main process, with its file. */
const registrars = new Map();
for (const file of files) {
  const src = readFileSync(join(MAIN_DIR, file), "utf8");
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+(register\w*Ipc)\s*\(/g)) {
    registrars.set(m[1], file);
  }
}

// A registrar counts as wired if ANY main-process file calls it — registrars
// legitimately nest (registerGlyphhIpc calls registerGlyphhContextIpc).
const orphans = [];
for (const [name, file] of registrars) {
  const called = files.some((f) => {
    const src = readFileSync(join(MAIN_DIR, f), "utf8");
    return new RegExp(`(?<!function\\s)\\b${name}\\s*\\(`).test(src.replace(/export\s+function\s+\w+\s*\(/g, ""));
  });
  if (!called) orphans.push({ name, file });
}

if (orphans.length) {
  console.error("\n✗ IPC registrar defined but never called:\n");
  for (const { name, file } of orphans) {
    console.error(`    ${name}()  — ${MAIN_DIR}/${file}`);
  }
  console.error(
    "\n  Its handlers will not exist at runtime. The renderer's invoke() will\n" +
    "  reject with \"No handler registered\", which usually shows up as a UI\n" +
    "  that hangs rather than an error. Call it from main.ts.\n",
  );
  process.exit(1);
}

console.log(`✓ ${registrars.size} IPC registrars, all called`);
