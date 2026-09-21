/**
 * bridge-tui-launch — main's side of the Bridge Mode TUI (bridge-tui.ts): the
 * shell line the terminal overlay runs, and the Finish handshake. The TUI is a
 * plain-node script beside the app (asarUnpack), fed an input file and read
 * through an output file it writes on Finish, which tells every renderer
 * "bridge-finished" (the overlay closes; a forced org's window closes with it).
 */
import fs from "node:fs";
import path from "node:path";
import { app, webContents } from "electron";
import { userScopedPath } from "./app-paths.js";

const dir = (): string => userScopedPath("bridge-tui");
const inFile = (): string => path.join(dir(), "input.json");
const outFile = (): string => path.join(dir(), "output.json");
let watching = false;

const q = (s: string): string => (process.platform === "win32" ? `'${s.replace(/'/g, "''")}'` : `"${s.replace(/"/g, '\\"')}"`);

export interface BridgeTui { url: string; forced: boolean }

export async function composeBridgeTuiCommand(bridge: BridgeTui): Promise<{ ok: boolean; command?: string; error?: string }> {
  try {
    fs.mkdirSync(dir(), { recursive: true });
    const input = { version: app.getVersion(), platform: process.platform, bridge };
    fs.writeFileSync(inFile(), JSON.stringify(input), "utf-8");
    try { fs.rmSync(outFile(), { force: true }); } catch { /* none */ }
    watchOutput();
    // Packaged: the TUI is unpacked beside the asar (electron-builder asarUnpack),
    // since a node process outside the app cannot read from inside the archive.
    const tui = path.join(__dirname.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`), "bridge-tui.js");
    // The TUI runs until it finishes: a crash brings it straight back.
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
    let parsed: { done?: boolean; bridge?: boolean } = {};
    try { parsed = JSON.parse(raw) as typeof parsed; } catch { return; }
    if (!parsed.done) return;
    fs.unwatchFile(file, tick);
    watching = false;
    try { fs.rmSync(file, { force: true }); } catch { /* fine */ }
    // Claude is installed and signed in: every renderer, the home view included.
    for (const wc of webContents.getAllWebContents()) { if (!wc.isDestroyed()) wc.send("bridge-finished"); }
  };
  // Never a persistent handle: it kept the main process alive after the last
  // window closed (his report, 2026-09-20: "the app doesn't exit properly").
  fs.watchFile(file, { interval: 1000, persistent: false }, tick);
}
