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
import { app, ipcMain, webContents } from "electron";
import { userScopedPath } from "./app-paths.js";
import { getPreference, setPreference } from "./stores/preferences-db.js";
import { listCliAgents, ensureOrgLoops } from "./cli-agents.js";
import { getClient } from "./glyphh-client.js";
import { listLoopModels } from "./loop-models.js";

const dir = (): string => userScopedPath("cli-setup");
const inFile = (): string => path.join(dir(), "input.json");
const outFile = (): string => path.join(dir(), "output.json");
let watching = false;

const q = (s: string): string => (process.platform === "win32" ? `'${s.replace(/'/g, "''")}'` : `"${s.replace(/"/g, '\\"')}"`);

/** The SAME list the loop's picker shows (loop-models): the org's list with
 *  the gateway on, the login's own list otherwise — so a Codex on a ChatGPT
 *  login is never offered a catalog name it cannot run (his report,
 *  2026-09-20). One row per loop vendor, deduped by id. */
async function models(loops: Array<{ id: string; cli: string }>): Promise<Array<{ id: string; name: string; provider: string }>> {
  const out = new Map<string, { id: string; name: string; provider: string }>();
  for (const loop of loops) {
    try {
      const r = await listLoopModels(loop.id);
      for (const m of r.models) {
        if (m.providerSlug === "auto") continue;
        const key = `${m.providerSlug}:${m.id}`;
        if (!out.has(key)) out.set(key, { id: m.id, name: m.name, provider: m.providerSlug });
      }
    } catch { /* that loop offers nothing */ }
  }
  return [...out.values()];
}

export async function cliSetupCommand(): Promise<{ ok: boolean; command?: string; error?: string }> {
  try {
    fs.mkdirSync(dir(), { recursive: true });
    // The org's answer, fresh (his order, 2026-09-20): with the gateway on the
    // roster is only the loops the org enabled, and the installer offers only
    // those CLIs; the org's CLI-mode switch decides whether "CLI" can be the
    // default view at all.
    await ensureOrgLoops(true).catch(() => undefined);
    const gates = await getClient().plans.gates().catch(() => null) as { gatewayAllowed?: boolean; cliAllowed?: boolean } | null;
    const loops = listCliAgents().map((a) => ({ id: a.id, name: a.name, cli: a.cli, model: a.model || "" }));
    const gateway = !!gates?.gatewayAllowed;
    const clis = gateway ? [...new Set(loops.map((l) => l.cli))] : null;
    const cliAllowed = gates?.cliAllowed !== false;
    const input = {
      version: app.getVersion(), platform: process.platform, loops, models: await models(loops), clis, cliAllowed, gateway,
      defaults: { loop: getPreference<string>("glyphhLoop", ""), view: getPreference<string>("defaultLoopView", "glyphh") },
    };
    fs.writeFileSync(inFile(), JSON.stringify(input), "utf-8");
    try { fs.rmSync(outFile(), { force: true }); } catch { /* none */ }
    watchOutput();
    // Packaged: the TUI is unpacked beside the asar (electron-builder asarUnpack),
    // since a node process outside the app cannot read from inside the archive.
    const tui = path.join(__dirname.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`), "cli-setup-tui.js");
    // The installer runs until it finishes: a crash brings it straight back.
    const command = process.platform === "win32"
      ? `$env:ELECTRON_RUN_AS_NODE=1; do { & ${q(process.execPath)} ${q(tui)} ${q(inFile())} ${q(outFile())} } until ($LASTEXITCODE -eq 0)`
      : `clear; until ELECTRON_RUN_AS_NODE=1 ${q(process.execPath)} ${q(tui)} ${q(inFile())} ${q(outFile())}; do sleep 1; done`;
    return { ok: true, command };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The TUI writes output.json on Finish; poll for it while a run is live. */
function watchOutput(): void {
  const file = outFile();
  if (watching) fs.unwatchFile(file);
  watching = true;
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
    // Every renderer, the home view included: the workbench lives there, not in the window.
    for (const wc of webContents.getAllWebContents()) { if (!wc.isDestroyed()) wc.send("cli-setup-done", { loop: parsed.loop || "", model: parsed.model || "", view: parsed.view || "" }); }
  };
  // Never a persistent handle: it kept the main process alive after the last
  // window closed (his report, 2026-09-20: "the app doesn't exit properly").
  fs.watchFile(file, { interval: 1000, persistent: false }, tick);
}

export function registerCliSetupIpc(): void {
  ipcMain.handle("cli-setup-command", () => cliSetupCommand());
}
