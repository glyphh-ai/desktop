/**
 * Desktop test harness runner — boots the REAL renderer (dist/renderer/
 * home.html) in a real Electron window against stub-preload's fake IPC and
 * executes the specs inside it.
 *
 *   npm run test:harness            all specs
 *   npm run test:harness -- gmail   only specs whose name matches "gmail"
 *
 * Each spec runs via webContents.executeJavaScript; `fresh: true` reboots
 * the page first so groups start deterministic. Exit code 1 on any failure.
 * The window stays hidden (backgroundThrottling off keeps rAF alive — the
 * echo wall and card entrances depend on it).
 */

import { app, BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { HELPERS, SPECS } from "./specs.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const homeHtml = path.join(here, "..", "..", "dist", "renderer", "home.html");
const preload = path.join(here, "stub-preload.cjs");
const filter = (process.argv[2] || "").toLowerCase();

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

async function boot(win, seed) {
  await win.loadFile(homeHtml, seed ? { query: { chats: JSON.stringify(seed) } } : undefined);
  // home boots async (prefs, sessions, sections) — give it a beat
  await new Promise((r) => setTimeout(r, 800));
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: {
      preload,
      contextIsolation: false,
      nodeIntegration: false,
      webviewTag: true,
      backgroundThrottling: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  const specs = SPECS.filter((s) => !filter || s.name.toLowerCase().includes(filter));
  let failed = 0;
  await boot(win);

  for (const spec of specs) {
    if (spec.fresh) await boot(win, spec.seed);
    let result;
    try {
      result = await win.webContents.executeJavaScript(
        `(async () => { try { ${HELPERS}\n${spec.body} } catch (err) { return { pass: false, detail: "threw: " + (err && err.message) }; } })()`,
        true,
      );
    } catch (err) {
      result = { pass: false, detail: `harness error: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (result?.pass) {
      console.log(`${green("✓")} ${spec.name}`);
    } else {
      failed++;
      console.log(`${red("✗")} ${spec.name}`);
      if (result?.detail) console.log(dim(`    ${result.detail}`));
    }
  }

  console.log(failed ? red(`\n${failed}/${specs.length} failed`) : green(`\n${specs.length} passed`));
  app.exit(failed ? 1 : 0);
});
