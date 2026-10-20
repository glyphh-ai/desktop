/**
 * runtime/attach.ts — the ATTACH HOST (Node-only): the machine's outbound
 * connection to the cloud, generalized from the desktop's attach-client so ANY
 * host can offer machine capabilities — the desktop app, and the CLI on
 * machines without one.
 *
 * The host opens one authenticated WebSocket to the server's /ws/attach and
 * keeps it alive with backoff. The cloud dispatches `req` frames down it; the
 * host executes each via its HANDLER TABLE and replies. Nothing dials in: this
 * side initiates, authenticates with the signed-in user's own token (as a
 * query parameter — Node's native WebSocket cannot set upgrade headers), and
 * sign-out stops it.
 *
 * REMOTE CONTROL (2026-09-30): a host attaches only while its member has remote
 * control on, and names the FOLDERS it grants in every hello; the server keeps
 * remote turns and browsing inside them. An org whose admin turned remote
 * control off refuses the socket with 4403 — the host stops for good and says
 * why (`onRefused`) instead of retrying forever.
 */

import type { Client } from "../client.js";

export type AttachHandler = (params: unknown) => Promise<unknown>;

export interface AttachHostOptions {
  /** The SDK client — supplies the server url is derived from and the token. */
  client: Client;
  /** The server base url (http/https) the socket attaches to. */
  server: string;
  /** Host identity sent in the hello frame (e.g. "glyphh-cli"). */
  app: string;
  version?: string;
  /** A human name for the machine (hostname); the console's Connected Devices shows it. */
  name?: string;
  /** The capability table: method name → executor. Sent as `capabilities`.
   *  A function is read on every hello, so a host that registers handlers
   *  after the socket opened can `refreshHello()` and advertise them. */
  handlers: Record<string, AttachHandler> | (() => Record<string, AttachHandler>);
  /** Injected for tests; defaults to the global WebSocket. */
  WebSocketImpl?: typeof WebSocket;
  /** Called when the socket drops, so a host can tear down what rode it (ptys, watchers). */
  onDown?: () => void;
  /** The folders this machine grants remote control (absolute paths). Read on
   *  every hello, so a changed grant is re-sent with `refreshHello()`. */
  folders?: () => string[];
  /** The server refused this host for good (4403: the org turned remote control
   *  off). The host has stopped; `reason` is the server's words. */
  onRefused?: (reason: string) => void;
}

export interface AttachHost {
  /** True while the outbound socket is open. */
  attached(): boolean;
  /** Send an unsolicited frame up the socket: run frames, pty output, panel
   *  frames. Dropped (returns false) while the socket is down. */
  push(channel: string, data: unknown): boolean;
  /** Re-advertise the capability table. Auth can open the socket before a
   *  host has registered every handler; the first hello then lists a partial
   *  table and the server refuses the missing methods until told otherwise. */
  refreshHello(): void;
  /** Tear down (sign-out / quit). Idempotent. */
  stop(): void;
}

const MAX_BACKOFF = 30_000;

/**
 * Start the attach host. Resolves immediately — connection and reconnection
 * run in the background (backoff-capped) for the life of the host.
 */
export function startAttachHost(opts: AttachHostOptions): AttachHost {
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoff = 1000;
  let stopped = false;

  const table = (): Record<string, AttachHandler> => (typeof opts.handlers === "function" ? opts.handlers() : opts.handlers);
  const hello = (socket: WebSocket): void => {
    socket.send(JSON.stringify({
      t: "hello", app: opts.app, version: opts.version ?? "0", ...(opts.name ? { name: opts.name } : {}),
      capabilities: Object.keys(table()), ...(opts.folders ? { folders: opts.folders() } : {}),
    }));
  };

  const wsUrl = async (): Promise<string> => {
    const base = opts.server.replace(/^http/, "ws").replace(/\/+$/, "");
    const token = await opts.client.token();
    return `${base}/ws/attach?token=${encodeURIComponent(token)}`;
  };

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
  };

  const connect = async (): Promise<void> => {
    if (stopped || ws) return;
    let url: string;
    try {
      url = await wsUrl();
    } catch {
      scheduleReconnect(); // signed out / token unavailable — retry later
      return;
    }
    const socket = new (opts.WebSocketImpl ?? WebSocket)(url);
    ws = socket;

    socket.addEventListener("open", () => {
      backoff = 1000;
      hello(socket);
    });

    socket.addEventListener("message", (ev: MessageEvent) => {
      let frame: { t?: string; id?: string; method?: string; params?: unknown };
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (frame.t === "ping") {
        try {
          socket.send(JSON.stringify({ t: "pong" }));
        } catch {
          /* noop */
        }
        return;
      }
      if (frame.t !== "req" || typeof frame.id !== "string" || typeof frame.method !== "string") return;
      const { id, method, params } = frame;
      const handler = table()[method];
      void (async () => {
        try {
          if (!handler) throw new Error(`unknown method: ${method}`);
          const result = await handler(params ?? {});
          socket.send(JSON.stringify({ t: "res", id, ok: true, result }));
        } catch (err) {
          socket.send(JSON.stringify({ t: "res", id, ok: false, error: err instanceof Error ? err.message : String(err) }));
        }
      })();
    });

    const drop = (): void => {
      if (ws === socket) ws = null;
      try { opts.onDown?.(); } catch { /* a listener's failure is its own */ }
      scheduleReconnect();
    };
    socket.addEventListener("close", (ev: CloseEvent) => {
      if (ev.code === 4403) {
        stopped = true;
        if (ws === socket) ws = null;
        try { opts.onDown?.(); } catch { /* a listener's failure is its own */ }
        try { opts.onRefused?.(ev.reason || "remote control is off for your organization"); } catch { /* the host's own */ }
        return;
      }
      drop();
    });
    socket.addEventListener("error", () => {
      try {
        socket.close();
      } catch {
        /* noop */
      }
      drop();
    });
  };

  void connect();

  const open = (): boolean => !!ws && ws.readyState === 1;
  return {
    attached: open,
    push: (channel, data) => {
      if (!ws || !open()) return false;
      try { ws.send(JSON.stringify({ t: "push", channel, data })); return true; } catch { return false; }
    },
    refreshHello: () => { if (ws && open()) { try { hello(ws); } catch { /* the reconnect will say hello again */ } } },
    stop: () => {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        try {
          ws.close();
        } catch {
          /* noop */
        }
        ws = null;
      }
    },
  };
}
