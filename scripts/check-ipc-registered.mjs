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

// ── Duplicate channels ────────────────────────────────────────────────────
// ipcMain.handle() THROWS on a second registration for the same channel —
// at boot, mid-registrar, killing every handler registered after it in that
// file. That shipped once: a doubled "usage-series" block aborted
// registerHomeIpc and took local-mcp-status (and friends) down with it,
// while the build stayed green. Registration channels must be unique.
const channelFiles = new Map();
const dupes = [];
for (const file of files) {
  const src = readFileSync(join(MAIN_DIR, file), "utf8");
  for (const m of src.matchAll(/ipcMain\.handle\(\s*["'`]([^"'`]+)["'`]/g)) {
    const ch = m[1];
    if (channelFiles.has(ch)) dupes.push({ ch, files: [channelFiles.get(ch), file] });
    else channelFiles.set(ch, file);
  }
  // agent-stubs registers its ENVELOPE/EMPTY_LIST arrays via loops — those
  // channels never appear as handle("…") literals, which is exactly how the
  // loop-set-role-default double-registration killed boot (2026-09-10).
  for (const arr of src.matchAll(/const (?:ENVELOPE|EMPTY_LIST)[^=]*=\s*\[([^\]]+)\]/g)) {
    for (const cm of arr[1].matchAll(/"([^"]+)"/g)) {
      const ch = cm[1];
      if (channelFiles.has(ch)) dupes.push({ ch, files: [channelFiles.get(ch), file] });
      else channelFiles.set(ch, file);
    }
  }
}
if (dupes.length) {
  console.error("\n✗ IPC channel registered more than once:\n");
  for (const { ch, files: fs } of dupes) {
    console.error(`    "${ch}"  — ${fs[0]}${fs[0] === fs[1] ? " (twice)" : ` and ${fs[1]}`}`);
  }
  console.error(
    "\n  ipcMain.handle() throws on the second registration AT BOOT, aborting\n" +
    "  the rest of that registrar — every handler after it silently vanishes.\n",
  );
  process.exit(1);
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

console.log(`✓ ${registrars.size} IPC registrars, all called · ${channelFiles.size} channels, all unique`);
