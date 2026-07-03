/**
 * TerminalManager — manages pseudo-terminal processes.
 *
 * Each terminal panel gets its own pty process. Data flows:
 * xterm.js (renderer) <-> IPC <-> node-pty (main)
 *
 * Shell functions yo/sup/dip are injected on spawn so commands
 * typed in the terminal route through the Electron command handler.
 */

import * as pty from "node-pty";
import { ipcMain, WebContents } from "electron";
import os from "os";
import { getShellPath } from "./shell-path";

/** Marker wrapping command output from injected shell functions */
const CMD_MARKER_START = "\x1b]7770;";
const CMD_MARKER_END = "\x07";

export type TerminalCommandHandler = (cmd: string, wc: WebContents) => void;

/** Config for spawning a code-terminal (named Claude Code agent panel). */
export interface AgentSpawnConfig {
  name: string;          // agent name (e.g. "ui")
  role: string;          // free-text role label (e.g. "frontend")
  cwd: string;           // resolved absolute path
  command: string;       // e.g. "claude"
  args: string[];        // extra CLI args
  workspace: string;     // workspace slug
}

export class TerminalManager {
  private processes = new Map<number, pty.IPty>();
  private pendingSpawns = new Map<number, (...args: any[]) => void>();
  private onCommand: TerminalCommandHandler | null = null;

  /** Set handler for yo/sup/dip commands typed in the terminal. */
  setCommandHandler(handler: TerminalCommandHandler): void {
    this.onCommand = handler;
  }

  /** Register IPC handlers for terminal communication. */
  init(): void {
    ipcMain.on("terminal:write", (e, data: string) => {
      this.processes.get(e.sender.id)?.write(data);
    });
    ipcMain.on("terminal:resize", (e, cols: number, rows: number) => {
      const proc = this.processes.get(e.sender.id);
      if (proc) {
        try { proc.resize(cols, rows); } catch { /* ignore invalid sizes */ }
      }
    });
  }

  /** Spawn a new pty process and wire it to a webContents. */
  spawn(wc: WebContents): void {
    this.kill(wc.id);

    const shell = process.env.SHELL || (os.platform() === "win32" ? "powershell.exe" : "/bin/zsh");
    // -i ensures .zshrc/.bashrc loads (where Homebrew + most PATH tweaks live);
    // -l ensures .zprofile loads. Both are needed on macOS launched from GUI.
    const shellArgs = os.platform() === "win32" ? [] : ["-il"];
    const proc = pty.spawn(shell, shellArgs, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: os.homedir(),
      env: process.env as Record<string, string>,
    });

    // Buffer for detecting split markers across chunks
    let outBuf = "";

    proc.onData((data) => {
      if (wc.isDestroyed()) return;

      outBuf += data;

      // Process all complete markers in the buffer
      while (true) {
        const start = outBuf.indexOf(CMD_MARKER_START);
        if (start === -1) break;
        const end = outBuf.indexOf(CMD_MARKER_END, start + CMD_MARKER_START.length);
        if (end === -1) break; // incomplete marker — wait for more data

        // Send everything before the marker to the terminal
        const before = outBuf.slice(0, start);
        if (before) wc.send("terminal:data", before);

        // Extract and route the command
        const cmdStr = outBuf.slice(start + CMD_MARKER_START.length, end).trim();
        if (cmdStr) this.onCommand?.(cmdStr, wc);

        // Continue after marker (skip trailing newline if present)
        outBuf = outBuf.slice(end + CMD_MARKER_END.length);
        if (outBuf.startsWith("\r\n")) outBuf = outBuf.slice(2);
        else if (outBuf.startsWith("\n")) outBuf = outBuf.slice(1);
      }

      // Flush buffer if no partial marker is pending
      if (!outBuf.includes("\x1b]7770")) {
        if (outBuf) wc.send("terminal:data", outBuf);
        outBuf = "";
      }
    });

    proc.onExit(({ exitCode }) => {
      if (!wc.isDestroyed()) wc.send("terminal:exit", exitCode);
      this.processes.delete(wc.id);
    });

    this.processes.set(wc.id, proc);

    // Inject shell functions after prompt appears, then clear the noise
    setTimeout(() => {
      proc.write(
        `yo()  { printf '\\033]7770;yo %s\\007' "$*"; };` +
        `sup() { printf '\\033]7770;sup %s\\007' "$*"; };` +
        `dip() { printf '\\033]7770;dip %s\\007' "$*"; };` +
        `drip(){ printf '\\033]7770;drip %s\\007' "$*"; };` +
        `clear\r`,
      );
    }, 400);
  }

  /**
   * Spawn a code-terminal pty: a named agent running an LLM CLI (default `claude`).
   * Differs from spawn() in three ways: cwd is workspace-rooted, command is the
   * agent CLI directly (not a user shell), and env carries YO_AGENT_NAME so
   * the agent can identify itself via the project CLAUDE.md dispatcher.
   *
   * Auto-restarts on exit so the agent persists across `/clear` and crashes.
   * Slash commands are handled by the agent CLI itself, so we do NOT inject
   * the yo/sup/dip shell-function marker scheme used by regular terminals.
   */
  spawnAgent(wc: WebContents, config: AgentSpawnConfig): void {
    this.kill(wc.id);

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PATH: getShellPath(),
      YO_AGENT_NAME: config.name,
      YO_AGENT_ROLE: config.role,
      YO_WORKSPACE: config.workspace,
    };

    const doSpawn = (cols: number, rows: number) => {
      if (wc.isDestroyed()) return;
      const proc = pty.spawn(config.command, config.args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd: config.cwd,
        env,
      });

      proc.onData((data) => {
        if (wc.isDestroyed()) return;
        wc.send("terminal:data", data);
      });

      proc.onExit(({ exitCode }) => {
        if (wc.isDestroyed()) return;
        wc.send("terminal:data", `\r\n[agent "${config.name}" exited with code ${exitCode}; respawning…]\r\n`);
        this.processes.delete(wc.id);
        setTimeout(() => {
          if (!wc.isDestroyed()) this.spawnAgent(wc, config);
        }, 500);
      });

      this.processes.set(wc.id, proc);
    };

    // Wait for the renderer to report its actual size before spawning so the
    // PTY starts at the correct dimensions (avoids garbled text in split views).
    if (this.pendingSpawns.has(wc.id)) {
      ipcMain.removeListener("terminal:resize", this.pendingSpawns.get(wc.id)!);
      this.pendingSpawns.delete(wc.id);
    }
    const onFirstResize = (_e: Electron.IpcMainEvent, cols: number, rows: number) => {
      if (_e.sender.id !== wc.id) return;
      ipcMain.removeListener("terminal:resize", onFirstResize);
      this.pendingSpawns.delete(wc.id);
      doSpawn(cols || 80, rows || 24);
    };
    this.pendingSpawns.set(wc.id, onFirstResize);
    ipcMain.on("terminal:resize", onFirstResize);
  }

  /** Kill a pty process by webContents id. */
  kill(wcId: number): void {
    const proc = this.processes.get(wcId);
    if (proc) {
      proc.kill();
      this.processes.delete(wcId);
    }
  }

  /** Kill all pty processes (app shutdown). */
  killAll(): void {
    for (const [, proc] of this.processes) proc.kill();
    this.processes.clear();
  }
}
