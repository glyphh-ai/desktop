/**
 * watch-web.mjs — auto-rebuild the web (platform) bundle on every source save.
 *
 * serve.mjs serves dist/renderer FRESH on every request (Cache-Control: no-store),
 * so once dist is rebuilt the ONLY thing needed to see a change is a browser reload
 * — no platform restart. This watcher removes the manual `npm run build:web` step:
 * edit → it rebuilds (debounced) → reload the browser.
 *
 * NOTE: this does NOT cover edits to serve.mjs itself — that's the platform server's
 * own code, which Node can't hot-reload; bounce the :3002 process for those (rare).
 */
import { watch } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = ["src/renderer", "web/src"];

let building = false;
let queued = false;
let timer = null;

function build() {
  if (building) { queued = true; return; }
  building = true; queued = false;
  const started = Date.now();
  const p = spawn("npm", ["run", "build:web"], { cwd: root, stdio: "inherit" });
  p.on("exit", (code) => {
    building = false;
    const ms = Date.now() - started;
    console.log(`\n[watch-web] rebuilt in ${ms}ms (exit ${code}) — hard-reload the browser (Cmd+Shift+R)\n`);
    if (queued) build();
  });
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(build, 250);   // debounce bursts of saves
}

for (const d of DIRS) {
  try {
    watch(join(root, d), { recursive: true }, (_evt, file) => {
      if (!file) return;
      if (/\.map$/.test(file)) return;           // ignore sourcemaps
      schedule();
    });
    console.log(`[watch-web] watching ${d}`);
  } catch (e) {
    console.warn(`[watch-web] cannot watch ${d}: ${e.message}`);
  }
}
console.log("[watch-web] rebuilding on change — just reload the browser to see it.");
build();   // one build up front so dist is current
