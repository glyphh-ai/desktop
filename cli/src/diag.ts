/**
 * diag.ts — THE STARTUP LOG. A full-screen TUI that fails early shows a blank
 * terminal and nothing else (his report, 2026-09-21: "just hangs, nothing is
 * shown"). Every boot appends what happened, in order, to
 * ~/.glyphh/logs/glyphh-cli.log — argv, the folder, which env the desktop
 * passed, whether a key is set, the first frame painted, each turn — and an uncaught
 * error leaves the screen, prints itself and lands here too. Best-effort:
 * a read-only home never breaks the TUI.
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GLYPHH_HOME } from "./local.js";

const LOG_MAX_BYTES = 512 * 1024;

function logFile(): string {
  return join(GLYPHH_HOME, "logs", "glyphh-cli.log");
}

/** One line: ISO time, pid, event, JSON detail. */
export function diag(event: string, detail: Record<string, unknown> = {}): void {
  try {
    const file = logFile();
    mkdirSync(join(file, ".."), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} ${process.pid} ${event} ${JSON.stringify(detail)}\n`);
  } catch {
    /* best-effort */
  }
}

/** Trim the log when it grows past the cap (keeps the tail). */
export function trimLog(): void {
  try {
    const file = logFile();
    if (statSync(file).size <= LOG_MAX_BYTES) return;
    const text = readFileSync(file, "utf-8");
    writeFileSync(file, text.slice(-LOG_MAX_BYTES / 2));
  } catch {
    /* none yet, or unreadable */
  }
}

export function logPath(): string {
  return logFile();
}
