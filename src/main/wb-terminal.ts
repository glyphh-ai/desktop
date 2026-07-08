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

interface Running { proc: pty.IPty; wc: WebContents }

const ptys = new Map<string, Running>();
function key(wcId: number, termId: string): string { return `${wcId}:${termId}`; }

function spawnPty(wc: WebContents, termId: string, cwd: string, cols: number, rows: number): void {
  const shell = process.env.SHELL || (os.platform() === "win32" ? "powershell.exe" : "/bin/zsh");
  const shellArgs = os.platform() === "win32" ? [] : ["-il"];
  const proc = pty.spawn(shell, shellArgs, {
    name: "xterm-256color",
    cols: cols || 80,
    rows: rows || 24,
    cwd: cwd && cwd.length > 0 ? cwd : os.homedir(),
    env: process.env as Record<string, string>,
  });
  proc.onData((data) => {
    if (wc.isDestroyed()) return;
    wc.send(`wb-term:data:${termId}`, data);
  });
  proc.onExit(({ exitCode }) => {
    if (!wc.isDestroyed()) wc.send(`wb-term:exit:${termId}`, exitCode);
    ptys.delete(key(wc.id, termId));
  });
  ptys.set(key(wc.id, termId), { proc, wc });
}

export function registerWorkbenchTerminalIpc(): void {
  ipcMain.on("wb-term:spawn", (e, termId: string, cwd: string, cols: number, rows: number) => {
    if (!termId) return;
    const k = key(e.sender.id, termId);
    if (ptys.has(k)) return;
    spawnPty(e.sender, termId, cwd, cols, rows);
  });
  ipcMain.on("wb-term:write", (e, termId: string, data: string) => {
    ptys.get(key(e.sender.id, termId))?.proc.write(data);
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
    }
  });
}
