/**
 * remote-terminal.ts — the WEB Terminal panel's pty, running on the user's
 * ATTACHED DESKTOP over the panel relay.
 *
 * On desktop a Terminal slot drives node-pty over local `wb-term:*` IPC. On
 * web there is no machine, so this module is the drop-in transport: it opens
 * a shell ON the desktop via the relay's `pty.open`, pipes output pushes
 * (`{type:"data", bytes:<base64 utf-8>}` on the ptyId channel) back to xterm,
 * and sends keystrokes/resizes as `pty.input`/`pty.resize`. `dispose()` sends
 * `pty.close`. The server additionally sweeps our ptys if this page dies
 * without closing, and the desktop kills them if its attach socket drops —
 * no orphaned shells from any direction.
 *
 * One SHARED relay socket serves every terminal on the page (refcounted;
 * closed when the last pty goes) — unlike the streamed panel, which owns a
 * socket per panel, a workbench full of terminal tabs shouldn't hold N
 * sockets. Same envelope, same helper (relay-socket.ts).
 *
 * Failure is typed (RemotePtyError.state maps onto the panel state cards) so
 * the workbench can show the SAME honest "desktop not connected" card the
 * streamed panel shows, instead of a dead black rectangle.
 */

import { connectRelaySocket, relaySdk, type RelaySocket } from "./relay-socket.js";

export type RemotePtyFailure = "desktop-offline" | "signed-out" | "failed";

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
}

export interface RemotePtyHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Close the far shell + release the shared socket. Idempotent. */
  dispose(): void;
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

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Open a shell on the attached desktop. Throws RemotePtyError with an honest
 * state when it can't: "signed-out" (no SDK/token), "desktop-offline" (no
 * machine attached — checked BEFORE opening any socket), "failed" (relay or
 * far side refused, e.g. the desktop's concurrent-pty cap).
 */
export async function openRemotePty(
  opts: { cols: number; rows: number; cwd?: string },
  hooks: RemotePtyHooks,
): Promise<RemotePtyHandle> {
  const client = relaySdk();
  if (!client) throw new RemotePtyError("signed-out");

  // Honest offline state: check attach BEFORE opening a socket (same order as
  // the streamed panel).
  let attached = false;
  try { attached = (await client.attach.status()).attached; } catch { attached = false; }
  if (!attached) throw new RemotePtyError("desktop-offline");

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
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
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
  };
}
