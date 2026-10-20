/**
 * remote-terminal.ts — the WEB Terminal panel's pty. Two transports, picked
 * by the session's locus (his order, 2026-10-04):
 *
 *   WORKER (the default on web): a shell on the session's CLOUD WORKER through
 *     the server's front door — `POST /api/harness/pty {cwd?, cols, rows,
 *     command?, scope?}` → `{ptyId, wsPath, wire:"glyphh.terminal/v2"}`, then
 *     one WebSocket per terminal at `wss://<api>/api/harness/pty/<ptyId>?token=
 *     <session token>` carrying JSON frames: `data` (base64 bytes), `resize`,
 *     `close`, `ping`/`pong` both ways (a ping is answered with a pong);
 *     `ready`, `exit {code?}`, `error {error}` from the worker (pty-frames.ts
 *     is the codec). `DELETE /api/harness/pty/<id>`
 *     closes it. `command` is ONE program name (`claude`, `codex`) the pty
 *     starts instead of the login shell — the CLI agent window on web; the
 *     rest of a composed line is typed after `ready`. The worker's workspace
 *     is the cwd; `scope` names the session whose workspace it is.
 *
 *   DESKTOP (a machine-bound session): a shell on the user's ATTACHED DESKTOP
 *     over the panel relay — `pty.open`, output pushes (`{type:"data",
 *     bytes:<base64 utf-8>}` on the ptyId channel), `pty.input`/`pty.resize`,
 *     `pty.close` on dispose. One SHARED relay socket serves every desktop
 *     terminal on the page (refcounted). Same envelope as the streamed panel
 *     (relay-socket.ts).
 *
 * On desktop a Terminal slot drives node-pty over local `wb-term:*` IPC; this
 * module is the web's drop-in for it. Failure is typed (RemotePtyError.state
 * maps onto the panel state cards) so the workbench shows an honest card —
 * desktop not connected, no worker available (503/412), signed out — instead
 * of a dead black rectangle.
 */

import { connectRelaySocket, relaySdk, type RelaySocket } from "./relay-socket.js";
import { harnessRequest, harnessToken, harnessWsUrl, HarnessHttpError } from "./help/harness-api.js";
import { decodePtyFrame, dataFrame, resizeFrame, closeFrame, pingFrame, pongFrame, b64ToBytes, ptyOpenBody, splitProgram, PTY_WIRE } from "./pty-frames.js";

export type RemotePtyFailure = "desktop-offline" | "worker-unavailable" | "signed-out" | "failed";
export type RemotePtyTarget = "worker" | "desktop";

export class RemotePtyError extends Error {
  readonly state: RemotePtyFailure;
  constructor(state: RemotePtyFailure, message?: string) {
    super(message ?? state);
    this.state = state;
  }
}

export interface RemotePtyHooks {
  /** Raw UTF-8 output bytes — hand straight to xterm's write(Uint8Array). */
  onData(bytes: Uint8Array): void;
  /** The far shell exited (the pty is already gone; no need to dispose). */
  onExit(code: number): void;
  /** The relay socket dropped mid-session — the shell is being killed on the
   *  desktop (attach teardown); show the disconnected state. */
  onDrop(): void;
  /** The WORKER reported its own failure (`{type:"error", error}`) — show it
   *  in the panel state. The socket may still be open. */
  onError?(error: string): void;
}

export interface RemotePtyHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Close the far shell + release the shared socket. Idempotent. */
  dispose(): void;
  /** True when the far side STARTED `command` itself (the worker pty does);
   *  false when the caller still has to type it in after the shell boots
   *  (the desktop relay opens a plain shell). */
  readonly startedCommand: boolean;
}

// ── the shared, refcounted relay socket ──────────────────────────────────────

let shared: { sock: RelaySocket; refs: number } | null = null;
let connecting: Promise<RelaySocket> | null = null;

async function ensureSocket(token: string): Promise<RelaySocket> {
  if (shared?.sock.isOpen()) return shared.sock;
  if (!connecting) {
    connecting = connectRelaySocket(token)
      .then((sock) => {
        shared = { sock, refs: 0 };
        sock.onClose(() => { if (shared?.sock === sock) shared = null; });
        return sock;
      })
      .finally(() => { connecting = null; });
  }
  return connecting;
}

function retain(sock: RelaySocket): void {
  if (shared?.sock === sock) shared.refs++;
}

function release(sock: RelaySocket): void {
  if (shared?.sock !== sock) return;
  shared.refs--;
  if (shared.refs <= 0) {
    // Last terminal gone — give the trailing pty.close a moment to flush.
    const s = shared;
    shared = null;
    setTimeout(() => { try { s.sock.close(); } catch { /* noop */ } }, 100);
  }
}

export interface RemotePtyOpenOpts {
  cols: number;
  rows: number;
  /** A folder to start in — inside the worker's workspace, or on the machine. */
  cwd?: string;
  /** A line to start instead of the login shell (the CLI agent window). On
   *  the worker its first word is the pty's `command` (one program name);
   *  the rest is typed after `ready`. */
  command?: string;
  /** The session whose workspace the WORKER shell runs in (the thread id). */
  scope?: string;
  /** Which far side runs the shell. Default: the worker. */
  target?: RemotePtyTarget;
}

/**
 * Open a shell on the far side. Throws RemotePtyError with an honest state
 * when it can't: "signed-out" (no SDK/token), "worker-unavailable" (the
 * server answered 503/412 — no worker for this session right now),
 * "desktop-offline" (no machine attached — checked BEFORE opening any
 * socket), "failed" (the far side refused, e.g. the desktop's concurrent-pty
 * cap, or the socket never opened).
 */
export async function openRemotePty(opts: RemotePtyOpenOpts, hooks: RemotePtyHooks): Promise<RemotePtyHandle> {
  return (opts.target ?? "worker") === "worker" ? openWorkerPty(opts, hooks) : openDesktopPty(opts, hooks);
}

// ── the worker pty (one socket per terminal, JSON frames) ───────────────────

async function openWorkerPty(opts: RemotePtyOpenOpts, hooks: RemotePtyHooks): Promise<RemotePtyHandle> {
  const token = await harnessToken();
  if (!token) throw new RemotePtyError("signed-out");

  // ONE program name rides `command`; a composed line's remainder (flags, a
  // prompt) is typed once the worker says `ready`. A line that starts with
  // `cd` has no program for the wire: the shell opens and the whole line is typed.
  const { program, rest } = splitProgram(opts.command || "");
  const typeAfterReady = rest;

  let ptyId: string;
  let wsPath: string;
  try {
    const r = await harnessRequest<{ ptyId?: string; wsPath?: string; wire?: string }>("POST", "/pty", ptyOpenBody({
      cols: opts.cols, rows: opts.rows,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(program ? { command: program } : {}),
      ...(opts.scope ? { scope: opts.scope } : {}),
    }));
    if (!r || typeof r.ptyId !== "string" || !r.ptyId) throw new Error("POST /api/harness/pty returned no ptyId");
    // The wire's MAJOR must match: a v3 worker would speak frames this page
    // can't decode, and a dead rectangle is exactly what this module exists to prevent.
    if (typeof r.wire === "string" && r.wire && majorOf(r.wire) !== majorOf(PTY_WIRE)) {
      throw new Error(`terminal wire mismatch: worker speaks ${r.wire}, this page ${PTY_WIRE}`);
    }
    ptyId = r.ptyId;
    // The server names the socket path; the documented default stands in.
    wsPath = typeof r.wsPath === "string" && r.wsPath ? r.wsPath : `/pty/${encodeURIComponent(ptyId)}`;
  } catch (err) {
    if (err instanceof HarnessHttpError) {
      if (err.httpStatus === 401 || err.httpStatus === 403) throw new RemotePtyError("signed-out", err.message);
      if (err.httpStatus === 503 || err.httpStatus === 412) throw new RemotePtyError("worker-unavailable", err.message);
    }
    throw new RemotePtyError("failed", err instanceof Error ? err.message : String(err));
  }
  // A server wsPath may be absolute under /api/harness or the bare pty path.
  const rel = wsPath.replace(/^\/api\/harness(?=\/)/, "");
  const url = harnessWsUrl(rel, token);

  const sock = await new Promise<WebSocket>((resolve, reject) => {
    let ws: WebSocket;
    try { ws = new WebSocket(url); }
    catch (err) { reject(new RemotePtyError("failed", err instanceof Error ? err.message : String(err))); return; }
    const onOpen = (): void => { cleanup(); resolve(ws); };
    const onFail = (): void => { cleanup(); reject(new RemotePtyError("failed", "the worker's terminal socket did not open")); };
    const cleanup = (): void => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onFail);
      ws.removeEventListener("close", onFail);
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onFail);
    ws.addEventListener("close", onFail);
  }).catch((err: unknown) => {
    // The pty exists server-side but we can't reach it: close it, don't leak it.
    void harnessRequest<void>("DELETE", `/pty/${encodeURIComponent(ptyId)}`).catch(() => {});
    throw err;
  });

  let done = false;
  let ready = false;
  const open = (): boolean => sock.readyState === WebSocket.OPEN;
  const typeLine = (line: string): void => { if (line && open()) sock.send(dataFrame(`${line}\r`)); };
  const finish = (sendClose: boolean): void => {
    if (done) return;
    done = true;
    clearInterval(keepAlive);
    if (sendClose) {
      try { if (open()) sock.send(closeFrame()); } catch { /* closing anyway */ }
      // Belt to the frame's suspenders: the server's own close route.
      void harnessRequest<void>("DELETE", `/pty/${encodeURIComponent(ptyId)}`).catch(() => {});
    }
    try { sock.close(); } catch { /* already closed */ }
  };
  // The server pings too; answering in kind keeps idle terminals alive
  // through proxies that drop quiet sockets.
  const keepAlive = setInterval(() => { try { if (open()) sock.send(pingFrame()); } catch { /* */ } }, 25_000);
  sock.addEventListener("message", (ev) => {
    const f = decodePtyFrame(typeof ev.data === "string" ? ev.data : "");
    if (!f) return;
    switch (f.type) {
      case "data":
        try { hooks.onData(b64ToBytes(f.data)); } catch { /* corrupt frame — drop it, the stream continues */ }
        return;
      case "ready":
        if (ready) return;
        ready = true;
        // The composed line's remainder (or a whole `cd … && …` line).
        if (typeAfterReady) setTimeout(() => typeLine(typeAfterReady), 150);
        return;
      case "exit":
        finish(false); // the far pty is already gone
        hooks.onExit(typeof f.code === "number" ? f.code : 0);
        return;
      case "close":
        finish(false);
        hooks.onExit(0);
        return;
      case "error":
        // The worker's own failure text → the panel state card.
        hooks.onError?.(f.error);
        return;
      case "ping":
        try { if (open()) sock.send(pongFrame()); } catch { /* */ }
        return;
      case "pong":
      case "resize":
        return;
    }
  });
  sock.addEventListener("close", () => {
    if (done) return;
    finish(false); // socket gone — nothing to send close on
    hooks.onDrop();
  });

  return {
    write: (data) => { if (!done && open()) sock.send(dataFrame(data)); },
    resize: (cols, rows) => { if (!done && cols > 0 && rows > 0 && open()) sock.send(resizeFrame(cols, rows)); },
    dispose: () => finish(true),
    // Started by the worker (program) and/or typed here after ready: either
    // way the caller has nothing left to type.
    startedCommand: !!opts.command,
  };
}

function majorOf(wire: string): string {
  const m = /\/v(\d+)/.exec(wire);
  return m ? m[1]! : wire;
}

// ── the desktop pty (the shared relay socket) ───────────────────────────────

async function openDesktopPty(opts: RemotePtyOpenOpts, hooks: RemotePtyHooks): Promise<RemotePtyHandle> {
  const client = relaySdk();
  if (!client) throw new RemotePtyError("signed-out");

  // Honest offline state: check attach BEFORE opening a socket (same order as
  // the streamed panel).
  let attached = false;
  let granted: string[] = [];
  try {
    const st = await client.attach.status();
    attached = st.attached;
    granted = (st.machines ?? []).flatMap((m) => (m as { folders?: unknown }).folders).filter((f): f is string => typeof f === "string" && !!f);
  } catch { attached = false; }
  if (!attached) throw new RemotePtyError("desktop-offline");

  // THE SHELL STARTS INSIDE A GRANTED FOLDER (the server checks `cwd` before
  // the desktop fills a default): the session's own folder when it has one,
  // else the first folder the desktop granted. A status that names no grant
  // (an older server) sends none and lets the far side answer.
  const cwd = opts.cwd || granted[0] || "";

  const token = await client.token().catch(() => null);
  if (!token) throw new RemotePtyError("signed-out");

  let sock: RelaySocket;
  try { sock = await ensureSocket(token); }
  catch (err) { throw new RemotePtyError("failed", err instanceof Error ? err.message : String(err)); }

  let ptyId: string;
  try {
    const r = (await sock.call("pty.open", {
      cols: opts.cols,
      rows: opts.rows,
      ...(cwd ? { cwd } : {}),
    })) as { ptyId?: string } | null;
    if (!r || typeof r.ptyId !== "string") throw new Error("pty.open returned no ptyId");
    ptyId = r.ptyId;
  } catch (err) {
    throw new RemotePtyError("failed", err instanceof Error ? err.message : String(err));
  }
  retain(sock);

  let done = false;
  // Initialized before wiring: onClose fires SYNCHRONOUSLY when the socket is
  // already closed, which would hit finish() before the consts existed.
  let offPush: () => void = () => {};
  let offClose: () => void = () => {};
  const finish = (sendClose: boolean): void => {
    if (done) return;
    done = true;
    offPush();
    offClose();
    if (sendClose) sock.send("pty.close", { ptyId });
    release(sock);
  };

  offPush = sock.onPush(ptyId, (_channel, data) => {
    const d = data as { type?: string; bytes?: string; code?: number } | null;
    if (!d) return;
    if (d.type === "data" && typeof d.bytes === "string") {
      try { hooks.onData(b64ToBytes(d.bytes)); } catch { /* corrupt frame — drop it, the stream continues */ }
    } else if (d.type === "exit") {
      finish(false); // the far pty is already gone
      hooks.onExit(typeof d.code === "number" ? d.code : 0);
    }
  });
  offClose = sock.onClose(() => {
    if (done) return;
    finish(false); // socket gone — nothing to send close on
    hooks.onDrop();
  });

  return {
    write: (data) => { if (!done) sock.send("pty.input", { ptyId, data }); },
    resize: (cols, rows) => { if (!done && cols > 0 && rows > 0) sock.send("pty.resize", { ptyId, cols, rows }); },
    dispose: () => finish(true),
    // The desktop opens a plain shell; the caller types the command after boot.
    startedCommand: false,
  };
}
