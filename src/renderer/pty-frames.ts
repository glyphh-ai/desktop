/**
 * pty-frames.ts — the JSON frame codec of the WORKER PTY socket
 * (`WS /api/harness/pty/:ptyId?token=…`, help/harness-api.ts), shared by the
 * web Terminal panel (remote-terminal.ts) and its unit test
 * (web/test/pty-frames.test.js). Pure: no DOM, no socket.
 *
 * The wire is `glyphh.terminal/v2`. Frames, one JSON object per message:
 *   both ways
 *     { type: "data",   data: <base64 of the raw bytes> }   keystrokes → worker; output → page
 *     { type: "resize", cols, rows }                         page → worker
 *     { type: "close" }                                      page → worker (dispose); worker → page
 *     { type: "ping" } / { type: "pong" }                    keep-alive, either side (a ping is answered with a pong)
 *   worker → page only
 *     { type: "ready" }                                      the shell (or `command`) is up
 *     { type: "exit",  code? }                               the program ended
 *     { type: "error", error }                               the worker's own failure text
 * Anything else is dropped by decode (null) so a newer server cannot break an
 * older page, and a corrupt message never throws into the stream. Base64 is
 * handled here (bytesToB64/b64ToBytes) so the terminal hooks stay byte-shaped.
 */

export const PTY_WIRE = "glyphh.terminal/v2";

export type PtyFrame =
  | { type: "data"; data: string }            // base64 bytes
  | { type: "resize"; cols: number; rows: number }
  | { type: "close" }
  | { type: "ping" }
  | { type: "pong" }
  | { type: "ready" }
  | { type: "exit"; code?: number }
  | { type: "error"; error: string };

export function encodePtyFrame(frame: PtyFrame): string {
  return JSON.stringify(frame);
}

/** Base64 ↔ raw bytes (browser atob/btoa; no Buffer in the renderer). */
export function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A keystroke string → the data frame (UTF-8, base64). */
export function dataFrame(text: string): string { return encodePtyFrame({ type: "data", data: bytesToB64(new TextEncoder().encode(text)) }); }
export function resizeFrame(cols: number, rows: number): string { return encodePtyFrame({ type: "resize", cols, rows }); }
export function closeFrame(): string { return encodePtyFrame({ type: "close" }); }
export function pingFrame(): string { return encodePtyFrame({ type: "ping" }); }
export function pongFrame(): string { return encodePtyFrame({ type: "pong" }); }

/** Decode one socket message; null for anything that is not a known frame.
 *  A data frame's `data` stays base64 here — `b64ToBytes` turns it into the
 *  bytes xterm writes. */
export function decodePtyFrame(raw: unknown): PtyFrame | null {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try { v = JSON.parse(raw); } catch { return null; }
  }
  if (!v || typeof v !== "object") return null;
  const f = v as { type?: unknown; data?: unknown; cols?: unknown; rows?: unknown; code?: unknown; error?: unknown };
  switch (f.type) {
    case "data":
      return typeof f.data === "string" ? { type: "data", data: f.data } : null;
    case "resize": {
      const cols = Number(f.cols), rows = Number(f.rows);
      return Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0 ? { type: "resize", cols, rows } : null;
    }
    case "close": return { type: "close" };
    case "ping": return { type: "ping" };
    case "pong": return { type: "pong" };
    case "ready": return { type: "ready" };
    case "exit": return typeof f.code === "number" ? { type: "exit", code: f.code } : { type: "exit" };
    case "error": return { type: "error", error: typeof f.error === "string" ? f.error : "the worker reported an error" };
    default:
      return null;
  }
}

/** The body of `POST /api/harness/pty` — what the worker needs to open a shell:
 *  its size, an optional working folder inside the workspace, an optional
 *  program to start instead of the login shell (ONE program name — `claude`,
 *  `codex` — the CLI agent window), and the session `scope` (the thread id
 *  whose workspace the shell runs in; absent → the caller's default). */
export interface PtyOpenBody { cols: number; rows: number; cwd?: string; command?: string; scope?: string }
export function ptyOpenBody(opts: { cols: number; rows: number; cwd?: string; command?: string; scope?: string }): PtyOpenBody {
  return {
    cols: Math.max(1, Math.floor(opts.cols)),
    rows: Math.max(1, Math.floor(opts.rows)),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.command ? { command: opts.command } : {}),
    ...(opts.scope ? { scope: opts.scope } : {}),
  };
}

/** `command` is ONE program name on the wire. A composed line (`cd 'x' && claude
 *  --continue`) can't ride it, so the program goes in `command` and the rest
 *  of the line is typed after `ready` — see remote-terminal.ts. */
export function splitProgram(line: string): { program: string; rest: string } {
  const t = String(line || "").trim();
  if (!t) return { program: "", rest: "" };
  // ONE BARE PROGRAM NAME starts directly (`claude`, `codex`). Anything with
  // arguments — flags, a prompt, a leading `cd '…' &&` — is a SHELL line: the
  // pty opens the login shell and the whole line is typed after `ready`.
  // (Starting the program and typing its flags afterwards fed `--continue`
  // into the running CLI's prompt — the resume/prompt opens never worked.)
  if (/^[A-Za-z0-9_.-]+$/.test(t)) return { program: t, rest: "" };
  return { program: "", rest: t };
}
