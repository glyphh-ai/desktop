/**
 * relay-client — persistent WebSocket to yo-server's /ws/relay endpoint.
 *
 * Authenticates with the user's existing JWT (the one from platform login —
 * same token serverPostAuthed uses). No separate client-side token to manage:
 * if you're signed in, the WS knows who you are. Once the socket is up, the
 * server can forward MCP-style requests from external callers (Claude code,
 * etc.) holding an EXTERNAL token scoped to the same user.
 *
 * Wire protocol (JSON frames):
 *   server → client: { type:"request", reqId, method, params }
 *   client → server: { type:"response", reqId, ok, result?, error? }
 *                    { type:"ping" }  (heartbeat — optional, server also pings)
 *
 * The relay is the ONLY MCP surface, so there is no opt-in preference: the
 * client connects automatically whenever the account is eligible (signed in,
 * active heartbeat, paid tier — hasMcpAccess). Reconnect uses exponential
 * backoff capped at 30s so a flapping server doesn't burn the user's CPU or
 * trip the rate limiter.
 */

import { WebSocket } from "ws";
import { getAuthToken, isAuthenticated, hasMcpAccess } from "./auth.js";
import { getPreference } from "./preferences.js";
import { handleStreamFrame, abortAllStreams } from "./app-proxy-stream.js";

const AUTH_SERVER = process.env.YO_AUTH_SERVER || "https://api.glyphh.ai";

/** Build the WS URL from the HTTP API base — https → wss, http → ws. */
function relayUrl(): string {
  const base = AUTH_SERVER.replace(/\/+$/, "");
  return base.replace(/^http/i, (m) => (m.toLowerCase() === "https" ? "wss" : "ws")) + "/ws/relay";
}

type Handler = (params: unknown) => Promise<unknown> | unknown;

const handlers = new Map<string, Handler>();

/** Register a handler for a relay method (idempotent — last write wins). */
export function registerRelayHandler(method: string, handler: Handler): void {
  handlers.set(method, handler);
}

let socket: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let backoffMs = 1_000;                            // grows on each failed attempt
let started = false;

function relayEnabled(): boolean {
  // User-controlled opt-in (default on) gated by eligibility. The toggle lets
  // a user who prefers the local MCP server — or no cloud at all — turn the
  // cloud relay off without affecting the local server. "Disabled" in Settings
  // now means the toggle is off, not that the account is ineligible.
  if (getPreference<boolean>("relayEnabled", true) === false) return false;
  return hasMcpAccess();
}

async function dispatch(method: string, params: unknown): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const handler = handlers.get(method);
  if (!handler) return { ok: false, error: `unknown method: ${method}` };
  try {
    const result = await handler(params);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Invoke a registered relay handler directly, bypassing the WebSocket. The
 * local MCP server uses this so it shares ONE handler registry with the cloud
 * relay — every panels / rpa / apps tool behaves identically whether the call
 * arrives over the cloud WS or the local 127.0.0.1 server. Throws on an
 * unknown method or a handler error.
 */
export async function dispatchRelayMethod(method: string, params: unknown): Promise<unknown> {
  const out = await dispatch(method, params);
  if (!out.ok) throw new Error(out.error);
  return out.result;
}

function scheduleReconnect(reason: string): void {
  if (reconnectTimer) return;
  console.log(`[relay] reconnect in ${Math.round(backoffMs / 1000)}s — ${reason}`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    backoffMs = Math.min(30_000, backoffMs * 2);
    connect();
  }, backoffMs);
}

function connect(): void {
  if (!relayEnabled()) return;
  if (!isAuthenticated()) return;                  // wait until the user is signed in
  const token = getAuthToken();
  if (!token) return;

  const url = relayUrl();
  let ws: WebSocket;
  try {
    ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch (err) {
    scheduleReconnect(`connect threw: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  socket = ws;

  ws.on("open", () => {
    console.log(`[relay] connected to ${url}`);
    backoffMs = 1_000;                             // reset on successful connect
  });

  ws.on("message", async (raw) => {
    let frame: { type?: string; reqId?: string; method?: string; params?: unknown };
    try { frame = JSON.parse(raw.toString()); }
    catch { return; }

    // HTTP app-proxy stream frames (see app-proxy-stream.ts) — a public
    // request to <slug>.glyphh.app streaming through this client.
    if (typeof frame.type === "string" && frame.type.startsWith("stream_") && typeof frame.reqId === "string") {
      handleStreamFrame(frame, (out) => {
        try { ws.send(JSON.stringify(out)); } catch { /* socket closed mid-stream */ }
      });
      return;
    }

    if (frame.type !== "request" || typeof frame.reqId !== "string" || typeof frame.method !== "string") return;
    const out = await dispatch(frame.method, frame.params);
    const responseFrame = { type: "response", reqId: frame.reqId, ...out };
    try { ws.send(JSON.stringify(responseFrame)); } catch { /* socket closed mid-handle */ }
  });

  ws.on("close", (code, reasonBuf) => {
    socket = null;
    abortAllStreams();               // don't leave local app requests dangling
    const reason = reasonBuf ? reasonBuf.toString() : "";
    if (code === 1000 && reason === "replaced") {
      // A newer connection from the same user took over — don't reconnect.
      console.log("[relay] socket replaced by another connection");
      return;
    }
    scheduleReconnect(`closed (${code}${reason ? ` ${reason}` : ""})`);
  });

  ws.on("error", (err) => {
    console.log(`[relay] error: ${err instanceof Error ? err.message : String(err)}`);
    // close handler will schedule the reconnect
  });
}

/** Start the relay loop. Safe to call multiple times — only the first runs. */
export function initRelayClient(): void {
  if (started) return;
  started = true;

  // Built-in smoke-test handler — server's relay_ping tool routes to this.
  registerRelayHandler("relay.ping", (params) => {
    const message = (params as { message?: string } | null | undefined)?.message ?? "ping";
    return { echoed: message, at: new Date().toISOString() };
  });

  connect();
}

/** Force a reconnect — call this after the user changes the token in settings. */
export function reconnectRelay(): void {
  if (socket) {
    try { socket.close(1000, "token-changed"); } catch { /* ignore */ }
    socket = null;
  }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  backoffMs = 1_000;
  connect();
}

/** Snapshot of the relay's current state — for the Settings status indicator. */
export function getRelayStatus(): { enabled: boolean; signedIn: boolean; state: "off" | "connecting" | "connected" | "disconnected" } {
  const enabled = relayEnabled();
  const signedIn = isAuthenticated();
  let state: "off" | "connecting" | "connected" | "disconnected" = "off";
  if (!enabled || !signedIn) state = "off";
  else if (socket && socket.readyState === WebSocket.OPEN) state = "connected";
  else if (socket && socket.readyState === WebSocket.CONNECTING) state = "connecting";
  else state = "disconnected";
  return { enabled, signedIn, state };
}
