/**
 * cli-setup — main's side of the CLI Installer (his order, 2026-09-19).
 * Writes the TUI's input (this org's loops, its models, the defaults, the
 * version), hands the renderer the command that runs it in a terminal panel,
 * and applies what the TUI wrote on Finish: the default loop and mode land as
 * preferences here; the loop's model goes back through the renderer's own
 * loop save, so the row is written the one way it always is.
 */
import fs from "node:fs";
import path from "node:path";
import { app, ipcMain, BrowserWindow } from "electron";
import { userScopedPath } from "./app-paths.js";
import { getPreference, setPreference } from "./stores/preferences-db.js";
import { listCliAgents } from "./cli-agents.js";
import { getClient } from "./glyphh-client.js";

const dir = (): string => userScopedPath("cli-setup");
const inFile = (): string => path.join(dir(), "input.json");
const outFile = (): string => path.join(dir(), "output.json");
let watching = false;

const q = (s: string): string => (process.platform === "win32" ? `'${s.replace(/'/g, "''")}'` : `"${s.replace(/"/g, '\\"')}"`);

async function models(): Promise<Array<{ id: string; name: string }>> {
  try {
    const rows = await getClient().models.available() as Array<{ id?: string; name: string; modality?: string }>;
    return rows.filter((m) => !m.modality || m.modality === "chat").map((m) => ({ id: m.name, name: m.name }));
  } catch { return []; }
}

export async function cliSetupCommand(): Promise<{ ok: boolean; command?: string; error?: string }> {
  try {
    fs.mkdirSync(dir(), { recursive: true });
    const loops = listCliAgents().map((a) => ({ id: a.id, name: a.name, cli: a.cli, model: a.model || "" }));
    const input = {
      version: app.getVersion(), platform: process.platform, loops, models: await models(),
      defaults: { loop: getPreference<string>("glyphhLoop", ""), view: getPreference<string>("defaultLoopView", "glyphh") },
    };
    fs.writeFileSync(inFile(), JSON.stringify(input), "utf-8");
    try { fs.rmSync(outFile(), { force: true }); } catch { /* none */ }
    watchOutput();
    const tui = path.join(__dirname, "cli-setup-tui.js");
    const command = process.platform === "win32"
      ? `$env:ELECTRON_RUN_AS_NODE=1; & ${q(process.execPath)} ${q(tui)} ${q(inFile())} ${q(outFile())}`
      : `ELECTRON_RUN_AS_NODE=1 ${q(process.execPath)} ${q(tui)} ${q(inFile())} ${q(outFile())}`;
    return { ok: true, command };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The TUI writes output.json on Finish; poll for it while a run is live. */
function watchOutput(): void {
  if (watching) return;
  watching = true;
  const file = outFile();
  const tick = (): void => {
    let raw = "";
    try { raw = fs.readFileSync(file, "utf-8"); } catch { return; }
    let parsed: { done?: boolean; loop?: string; model?: string; view?: string } = {};
    try { parsed = JSON.parse(raw) as typeof parsed; } catch { return; }
    if (!parsed.done) return;
    fs.unwatchFile(file, tick);
    watching = false;
    try { fs.rmSync(file, { force: true }); } catch { /* fine */ }
    if (parsed.loop) setPreference("glyphhLoop", parsed.loop);
    if (parsed.view === "glyphh" || parsed.view === "cli") setPreference("defaultLoopView", parsed.view);
    setPreference("cliSetupDoneAt", new Date().toISOString());
    for (const w of BrowserWindow.getAllWindows()) { if (!w.isDestroyed()) w.webContents.send("cli-setup-done", { loop: parsed.loop || "", model: parsed.model || "", view: parsed.view || "" }); }
  };
  fs.watchFile(file, { interval: 1000 }, tick);
  // Nothing landed in twenty minutes: stop polling; the next open re-arms.
  setTimeout(() => { if (watching) { fs.unwatchFile(file, tick); watching = false; } }, 20 * 60_000);
}

export function registerCliSetupIpc(): void {
  ipcMain.handle("cli-setup-command", () => cliSetupCommand());
}
