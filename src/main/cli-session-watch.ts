/**
 * cli-session-watch.ts — THE OTHER HALF OF THE SYNC: the CLIs' own stores.
 *
 * agent-ipc.ts watches Glyphh's own agent-sessions.json. A turn typed in
 * Claude's or Codex's own CLI lands in THAT CLI's store —
 * ~/.claude/projects/*.jsonl, ~/.codex/sessions/** and the rest — and without
 * this nothing in the app would learn it happened: a session worked on
 * outside the app would stay frozen at whatever snapshot adoption took.
 *
 * This watches the five stores the session listers know (cli-sessions.ts)
 * and broadcasts ONE debounced `cli-sessions-changed` to every renderer. It never reads a transcript and never decides anything: the
 * renderer re-reads the list and reconciles the open chat.
 *
 * Never a persistent handle — like the sessions-file watcher, main must not be
 * held alive after the last window closes.
 */

import { watch, statSync, type FSWatcher } from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { webContents } from "electron";
import { listCliSessions } from "./cli-sessions.js";

/** The five CLI stores, by the roots their session listers read. */
const ROOTS = (): string[] => [
  path.join(homedir(), ".claude", "projects"),
  path.join(homedir(), ".codex", "sessions"),
  path.join(homedir(), ".gemini", "tmp"),
  path.join(homedir(), ".copilot", "session-state"),
  path.join(homedir(), ".cursor", "chats"),
];

const watchers: FSWatcher[] = [];
let poll: ReturnType<typeof setInterval> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

/** One coalesced announcement — a CLI writes its transcript a line at a time,
 *  and a turn can be dozens of writes. */
function announce(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    for (const wc of webContents.getAllWebContents()) {
      if (!wc.isDestroyed()) wc.send("cli-sessions-changed");
    }
  }, 400);
}

/** A transcript write, or directory noise? Only the files the listers read
 *  matter; anything else (locks, tmp, the CLI's own scratch) is skipped. */
function isSessionFile(name: string): boolean {
  const f = name.replace(/\\/g, "/");
  return f.endsWith(".jsonl") || f.endsWith("store.db") || f.endsWith("meta.json");
}

/**
 * Start watching. Idempotent — agent-ipc.ts calls it beside the place it arms
 * the sessions-file watcher, which happens on every sessions load.
 */
export function startCliSessionWatch(): void {
  if (started) return;
  started = true;
  let watched = 0;
  for (const root of ROOTS()) {
    try {
      // The stores nest (claude by project, codex by date, cursor by
      // workspace) — recursive or nothing.
      const w = watch(root, { recursive: true, persistent: false }, (_ev, filename) => {
        if (filename && !isSessionFile(String(filename))) return;
        announce();
      });
      w.on("error", () => { /* store removed mid-run — the poll backstop covers it */ });
      watchers.push(w);
      watched++;
    } catch {
      // No store yet (that CLI was never run here), or recursive watch is
      // unsupported on this platform. Either way the poll below covers it.
    }
  }
  // THE BACKSTOP: recursive fs.watch is not supported everywhere, and a store
  // created AFTER boot has no watcher at all. A cheap mtime poll of the same
  // list the rail reads catches both without ever reading a transcript.
  let seen = "";
  poll = setInterval(() => {
    let sig = "";
    try { sig = listCliSessions(40).map((s) => `${s.id}:${s.mtime}`).join("|"); } catch { return; }
    if (sig === seen) return;
    const first = seen === "";
    seen = sig;
    if (!first) announce();   // the first read is the baseline, not a change
  }, 3000);
  if (poll.unref) poll.unref();
  console.warn("[cli-session-watch] started", JSON.stringify({ watched, roots: ROOTS().length }));
}

/** Release every handle (app quit / test teardown). */
export function stopCliSessionWatch(): void {
  for (const w of watchers) { try { w.close(); } catch { /* already gone */ } }
  watchers.length = 0;
  if (poll) { clearInterval(poll); poll = null; }
  if (timer) { clearTimeout(timer); timer = null; }
  started = false;
}

/** The store's newest mtime — exported for tests and for a cheap freshness
 *  check without pulling the whole list. */
export function cliStoresMtime(): number {
  let newest = 0;
  for (const root of ROOTS()) {
    try { newest = Math.max(newest, statSync(root).mtimeMs); } catch { /* no store */ }
  }
  return newest;
}
