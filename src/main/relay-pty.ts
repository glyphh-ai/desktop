/**
 * relay-pty.ts — remote terminals for the WEB client, over the attach relay.
 *
 * A Terminal panel opened on app-web has no local machine, so its shell runs
 * HERE, on the user's attached desktop: the server relays `pty.open/input/
 * resize/close` requests down the attach socket (the web side of that is the
 * `/ws/panel` allowlist in yo-server's attach domain — panel.* + exactly these
 * four methods, nothing else), and output streams back up as
 * `{t:"push", channel:<ptyId>, data:{type:"data", bytes:<base64 utf-8>}}`.
 *
 * The spawn itself is the SAME login-shell pty the local workbench terminal
 * uses (spawnShellPty in wb-terminal.ts) — one spawn path, two transports.
 *
 * Fidelity: node-pty delivers complete UTF-8 strings, and we base64 the bytes
 * of whole coalesced strings — a multibyte sequence can never straddle two
 * pushes. Output is batched per ~16ms so a `yarn build` firehose doesn't turn
 * into thousands of tiny relay frames.
 *
 * Lifecycle: every relay pty dies with its cause — pty.close from the web,
 * process exit (pushed up as {type:"exit"}), or the attach socket dropping
 * (onAttachDown → killAll; no orphaned shells when the desktop goes offline).
 * The server additionally closes a web socket's ptys when the BROWSER goes
 * away. Concurrency is capped (MAX_RELAY_PTYS) with a clear error.
 *
 * SECURITY — a pty is arbitrary shell on this machine. It is reachable only
 * via the owner-scoped relay (the server dispatches solely to the signed-in
 * user's own machine, and the web socket rides the same principal check).
 * There is currently NO machine-side "terminals disabled" capability flag to
 * honor (the attach hello advertises the method table itself, so simply not
 * installing this module removes the capability); a user-facing toggle that
 * gates installRelayPty is the follow-up seam.
 */

import { randomUUID } from "node:crypto";
import type * as pty from "node-pty";
import { spawnShellPty } from "./wb-terminal.js";
import { registerRelayHandler } from "./relay-client.js";
import { pushLocal as pushToAttach } from "./relay-client.js";
import { getWorkingDirectory } from "./working-directory.js";

interface RelayPty {
  proc: pty.IPty;
  /** Output coalesced since the last flush (complete UTF-8 strings). */
  buf: string[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** Guards double-kill (close → exit races). */
  closed: boolean;
}

/** Live relay ptys, keyed by ptyId — THE desktop-side registry for web terminals. */
const ptys = new Map<string, RelayPty>();

/** Concurrent relay-shell cap — a browser bug must not fork-bomb the desktop. */
const MAX_RELAY_PTYS = 8;
/** Output coalescing window. */
const FLUSH_MS = 16;

function flush(ptyId: string, entry: RelayPty): void {
  if (entry.flushTimer) { clearTimeout(entry.flushTimer); entry.flushTimer = null; }
  if (entry.buf.length === 0) return;
  const chunk = entry.buf.join("");
  entry.buf.length = 0;
  // Base64 the UTF-8 bytes of a WHOLE string — never a split multibyte
  // sequence on the wire. Dropped when the attach socket is down (the socket
  // dropping also kills the pty via onAttachDown, so nothing buffers forever).
  pushToAttach(ptyId, { type: "data", bytes: Buffer.from(chunk, "utf8").toString("base64") });
}

function scheduleFlush(ptyId: string, entry: RelayPty): void {
  if (entry.flushTimer) return;
  entry.flushTimer = setTimeout(() => { entry.flushTimer = null; flush(ptyId, entry); }, FLUSH_MS);
}

function closePty(ptyId: string, entry: RelayPty): void {
  if (entry.closed) return;
  entry.closed = true;
  if (entry.flushTimer) { clearTimeout(entry.flushTimer); entry.flushTimer = null; }
  entry.buf.length = 0;
  try { entry.proc.kill(); } catch { /* already dead */ }
  ptys.delete(ptyId);
}

/** Kill every relay pty — the attach socket dropped or the app is quitting. */
export function killAllRelayPtys(): void {
  for (const [ptyId, entry] of [...ptys]) closePty(ptyId, entry);
}

/** Register the pty relay methods + the socket-down sweep. Call once at boot. */
export function installRelayPty(): void {
  // THE PURGE: no transport to drop — cleanup is app-quit's (main.ts kills all).

  registerRelayHandler("pty.open", async (params) => {
    const p = params as { cols?: number; rows?: number; cwd?: string } | null;
    if (ptys.size >= MAX_RELAY_PTYS) {
      throw new Error(`relay pty limit reached (${MAX_RELAY_PTYS}) — close a web terminal first`);
    }
    const ptyId = `pty-${randomUUID()}`;
    // The web client may know a working folder (a layout's folder); otherwise
    // the machine's last-used working folder, which itself falls back to $HOME.
    const cwd = (typeof p?.cwd === "string" && p.cwd.length > 0) ? p.cwd : getWorkingDirectory();
    const proc = spawnShellPty({ cwd, cols: Number(p?.cols) || 80, rows: Number(p?.rows) || 24 });
    const entry: RelayPty = { proc, buf: [], flushTimer: null, closed: false };
    ptys.set(ptyId, entry);
    proc.onData((data) => {
      if (entry.closed) return;
      entry.buf.push(data);
      scheduleFlush(ptyId, entry);
    });
    proc.onExit(({ exitCode }) => {
      // Drain what the shell said on its way out, then announce the exit.
      flush(ptyId, entry);
      closePty(ptyId, entry);
      pushToAttach(ptyId, { type: "exit", code: exitCode });
    });
    return { ptyId };
  });

  registerRelayHandler("pty.input", async (params) => {
    const p = params as { ptyId?: string; data?: string } | null;
    const entry = ptys.get(String(p?.ptyId ?? ""));
    if (!entry) throw new Error(`unknown pty: ${String(p?.ptyId ?? "")}`);
    if (typeof p?.data !== "string") throw new Error("pty.input requires { ptyId, data }");
    entry.proc.write(p.data);
    return { ok: true };
  });

  registerRelayHandler("pty.resize", async (params) => {
    const p = params as { ptyId?: string; cols?: number; rows?: number } | null;
    const entry = ptys.get(String(p?.ptyId ?? ""));
    if (!entry) throw new Error(`unknown pty: ${String(p?.ptyId ?? "")}`);
    const cols = Number(p?.cols), rows = Number(p?.rows);
    if (cols > 0 && rows > 0) {
      try { entry.proc.resize(cols, rows); } catch { /* xterm sends 0 occasionally on init */ }
    }
    return { ok: true };
  });

  // Idempotent — the server sweeps a dead web socket's ptys best-effort, and
  // the pty may already have exited on its own.
  registerRelayHandler("pty.close", async (params) => {
    const p = params as { ptyId?: string } | null;
    const entry = ptys.get(String(p?.ptyId ?? ""));
    if (!entry) return { closed: false };
    closePty(String(p?.ptyId), entry);
    return { closed: true };
  });
}
