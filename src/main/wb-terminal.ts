/**
 * Workbench terminal — multi-pty per panel.
 *
 * The plain TerminalManager keys ptys by webContents id, which is fine when
 * one renderer = one terminal. The Code workbench Terminal slot can host many
 * terminals as tabs in the same renderer, so we key by an explicit terminal
 * id supplied by the renderer instead.
 *
 * IPC shape (all under the `wb-term:` namespace):
 *   wb-term:spawn(termId, cwd, cols, rows)  – fire-and-forget, replies via :data
 *   wb-term:write(termId, data)             – user keystrokes / paste
 *   wb-term:resize(termId, cols, rows)      – xterm resize
 *   wb-term:kill(termId)                    – tab closed / slot disposed
 *   wb-term:data:<termId>   (main → renderer)
 *   wb-term:exit:<termId>   (main → renderer, on pty exit)
 *
 * The pty inherits the user's login shell with `-il` so PATH / aliases work.
 */

import * as pty from "node-pty";
import { ipcMain, type WebContents } from "electron";
import os from "os";
import fs from "fs";
import { execFile } from "child_process";
import { followWorkingDirectory, getWorkingDirectory } from "./working-directory.js";

interface Running { proc: pty.IPty; wc: WebContents }

const ptys = new Map<string, Running>();
function key(wcId: number, termId: string): string { return `${wcId}:${termId}`; }

/**
 * Spawn the user's login shell in a pty — THE spawn used by every terminal
 * surface (the local workbench slot below, and the web-relay ptys in
 * relay-pty.ts). One place so shell choice / `-il` / env inheritance never
 * drift between the local and relayed paths.
 */
export function spawnShellPty(opts: { cwd?: string; cols?: number; rows?: number; light?: boolean }): pty.IPty {
  const shell = process.env.SHELL || (os.platform() === "win32" ? "powershell.exe" : "/bin/zsh");
  const shellArgs = os.platform() === "win32" ? [] : ["-il"];
  // COLORFGBG is the classic light/dark hint TUIs read ("fg;bg" in ANSI
  // indices) — CLIs that auto-detect the background pick the right variant.
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (opts.light !== undefined) env.COLORFGBG = opts.light ? "0;15" : "15;0";
  return pty.spawn(shell, shellArgs, {
    name: "xterm-256color",
    cols: opts.cols || 80,
    rows: opts.rows || 24,
    cwd: opts.cwd && opts.cwd.length > 0 ? opts.cwd : os.homedir(),
    env,
  });
}

function spawnPty(wc: WebContents, termId: string, cwd: string, cols: number, rows: number, light?: boolean): void {
  const proc = spawnShellPty({ cwd, cols, rows, light });
  proc.onData((data) => {
    if (wc.isDestroyed()) return;
    wc.send(`wb-term:data:${termId}`, data);
  });
  proc.onExit(({ exitCode }) => {
    if (!wc.isDestroyed()) wc.send(`wb-term:exit:${termId}`, exitCode);
    const gone = key(wc.id, termId);
    ptys.delete(gone);
    shellCwd.delete(gone);
    if (activeKey === gone) activeKey = null;
  });
  const k = key(wc.id, termId);
  ptys.set(k, { proc, wc });
  // Baseline for the cwd-follow poll: the folder this shell STARTED in
  // (realpath'd — lsof reports resolved paths, /tmp vs /private/tmp).
  try { shellCwd.set(k, fs.realpathSync(cwd && cwd.length > 0 ? cwd : os.homedir())); } catch { /* gone dir */ }
}

// ── Terminal cwd drives the workbench folder (his order, 2026-09-10) ─────────
// Whatever folder the ACTIVE terminal's shell cd's into becomes the working
// directory, so the other dev tools (Files / Editor / Diff / Plan) re-key to
// it. The shell pid's cwd is polled — no dependence on the shell emitting
// OSC 7 — and only a CHANGE from the terminal's own baseline pushes, so a
// terminal merely opening in its configured folder never stomps the workdir.
let activeKey: string | null = null;
const shellCwd = new Map<string, string>();

function readShellCwd(pid: number, cb: (dir: string | null) => void): void {
  if (os.platform() === "linux") {
    fs.readlink(`/proc/${pid}/cwd`, (err, p) => cb(err ? null : String(p)));
    return;
  }
  if (os.platform() !== "darwin") { cb(null); return; }
  execFile("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeout: 4000 }, (err, out) => {
    if (err) { cb(null); return; }
    const line = String(out).split("\n").find((l) => l.startsWith("n"));
    cb(line ? line.slice(1) : null);
  });
}

function pollActiveCwd(): void {
  if (!activeKey) return;
  const k = activeKey;
  const r = ptys.get(k);
  if (!r) { activeKey = null; return; }
  readShellCwd(r.proc.pid, (dir) => {
    if (!dir || ptys.get(k) !== r) return;
    const prev = shellCwd.get(k);
    shellCwd.set(k, dir);
    if (prev === undefined || dir === prev) return;
    try { if (dir !== getWorkingDirectory()) followWorkingDirectory(dir); }
    catch (err) { console.warn("[wb-term] cwd follow failed:", err instanceof Error ? err.message : err); }
  });
}

export function registerWorkbenchTerminalIpc(): void {
  setInterval(pollActiveCwd, 3000);
  ipcMain.on("wb-term:spawn", (e, termId: string, cwd: string, cols: number, rows: number, light?: boolean) => {
    if (!termId) return;
    const k = key(e.sender.id, termId);
    if (ptys.has(k)) return;
    spawnPty(e.sender, termId, cwd, cols, rows, light);
  });
  ipcMain.on("wb-term:write", (e, termId: string, data: string) => {
    const k = key(e.sender.id, termId);
    if (ptys.has(k)) activeKey = k;   // the terminal being TYPED IN leads
    ptys.get(k)?.proc.write(data);
  });
  ipcMain.on("wb-term:resize", (e, termId: string, cols: number, rows: number) => {
    const r = ptys.get(key(e.sender.id, termId));
    if (r) {
      try { r.proc.resize(cols, rows); } catch { /* xterm sends 0 occasionally on init */ }
    }
  });
  ipcMain.on("wb-term:kill", (e, termId: string) => {
    const k = key(e.sender.id, termId);
    const r = ptys.get(k);
    if (r) {
      try { r.proc.kill(); } catch { /* already dead */ }
      ptys.delete(k);
      shellCwd.delete(k);
      if (activeKey === k) activeKey = null;
    }
  });
}
