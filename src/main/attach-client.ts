/**
 * attach-client — the desktop's OUTBOUND connection to the cloud.
 *
 * The machine opens one authenticated WebSocket to yo-server's /ws/attach and
 * keeps it alive. The cloud (the server-side agent, the platform) dispatches
 * request frames down it; we execute each on-machine via the shared handler
 * registry (dispatchRelayMethod — the same table the loopback local-MCP server
 * uses) and reply. Nothing dials IN: this side initiates, authenticates with
 * the signed-in user's own token, and reconnects with backoff. Sign-out closes
 * it. See server docs/attach-protocol.md.
 */

import WebSocket from "ws";
import { app } from "electron";
import { hostname } from "node:os";
import { SERVER_URL } from "./glyphh-client.js";
import { getAuthToken, isAuthenticated } from "./auth.js";
import { dispatchRelayMethod, listRelayMethods } from "./relay-client.js";

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoff = 1000;
const MAX_BACKOFF = 30_000;
let stopped = true;

/**
 * Listeners run when the attach socket goes DOWN (drop or explicit stop).
 * Machine-side resources that only exist to serve the relay (the web-terminal
 * ptys in relay-pty.ts) register here so a dead socket never leaves orphaned
 * processes behind. Listener errors are swallowed — teardown must not cascade.
 */
const downListeners = new Set<() => void>();
export function onAttachDown(cb: () => void): void { downListeners.add(cb); }
function notifyAttachDown(): void {
  for (const cb of downListeners) { try { cb(); } catch { /* teardown must not cascade */ } }
}

function wsUrl(): string {
  const base = SERVER_URL.replace(/^http/, "ws").replace(/\/$/, "");
  return `${base}/ws/attach`;
}

function scheduleReconnect(): void {
  if (stopped || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, backoff);
  backoff = Math.min(backoff * 2, MAX_BACKOFF);
}

function connect(): void {
  if (stopped || ws) return;
  const token = getAuthToken();
  if (!token) { scheduleReconnect(); return; }

  // The token can't ride an Authorization header on every WS client the same
  // way; ws supports it, and the server also accepts ?token= as a fallback.
  const socket = new WebSocket(wsUrl(), { headers: { Authorization: `Bearer ${token}` } });
  ws = socket;

  socket.on("open", () => {
    backoff = 1000;
    socket.send(JSON.stringify({
      t: "hello",
      app: "glyphh-desktop",
      version: app.getVersion(),
      name: hostname(),
      capabilities: listRelayMethods(),
    }));
  });

  socket.on("message", (raw) => {
    let frame: { t?: string; id?: string; method?: string; params?: unknown };
    try { frame = JSON.parse(String(raw)); } catch { return; }
    if (frame.t === "ping") { try { socket.send(JSON.stringify({ t: "pong" })); } catch { /* noop */ } return; }
    if (frame.t !== "req" || typeof frame.id !== "string" || typeof frame.method !== "string") return;
    const { id, method, params } = frame;
    // Execute on-machine via the shared registry; frame the reply.
    void (async () => {
      try {
        const result = await dispatchRelayMethod(method, params ?? {});
        socket.send(JSON.stringify({ t: "res", id, ok: true, result }));
      } catch (err) {
        socket.send(JSON.stringify({ t: "res", id, ok: false, error: err instanceof Error ? err.message : String(err) }));
      }
    })();
  });

  const drop = (): void => {
    if (ws === socket) { ws = null; notifyAttachDown(); }
    scheduleReconnect();
  };
  socket.on("close", drop);
  socket.on("error", () => { try { socket.close(); } catch { /* noop */ } drop(); });
}

/** Start (or restart) the attach connection — call on sign-in / boot. */
export function startAttach(): void {
  if (!isAuthenticated()) return;
  stopped = false;
  backoff = 1000;
  if (!ws) connect();
}

/** Tear down the attach connection — call on sign-out / quit. */
export function stopAttach(): void {
  stopped = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { try { ws.close(); } catch { /* noop */ } ws = null; notifyAttachDown(); }
}

/** True when the outbound socket is open. */
export function isAttached(): boolean {
  return ws?.readyState === WebSocket.OPEN;
}

/**
 * Push an UNSOLICITED frame up the attach socket (the panel screencast + WebRTC
 * signaling stream).
 *
 * The base attach protocol is strict request/response (server → `req`, machine
 * → `res`). A screencast is the opposite shape: the machine originates a stream
 * of frames with no request to correlate to. This frame kind —
 * `{ t:"push", channel, data }` — is the one the server fans out to web clients
 * subscribed to that channel (the panelId). Returns false when the socket isn't
 * open so the caller can drop the frame instead of buffering unboundedly.
 */
export function pushToAttach(channel: string, data: unknown): boolean {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify({ t: "push", channel, data }));
    return true;
  } catch {
    return false;
  }
}
