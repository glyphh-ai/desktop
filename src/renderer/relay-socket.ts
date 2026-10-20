/**
 * relay-socket.ts — THE web client for yo-server's `/ws/panel` relay socket.
 *
 * One protocol, one place: the authenticated `?token=` upgrade, the
 * `{t:"req",id,method,params}` / `{t:"res",id,ok,result|error}` envelope, and
 * the `{t:"push",channel,data}` fan-out the server forwards from the user's
 * attached desktop. Both web consumers ride this — the streamed panel
 * (panel-stream.ts, one socket per panel) and the remote terminal
 * (remote-terminal.ts, one shared socket for all terminals) — so neither
 * re-implements the envelope and both stay inside the server's allowlist
 * (`panel.*` + the four `pty.*` methods; nothing else is relayable from web).
 */

// ── the SDK handle the web bridge exposes (window.glyphhSdk) ─────────────────

export interface SdkAttachStatus { attached: boolean; machines?: unknown[] }
export interface SdkClient {
  token(): Promise<string | null>;
  attach: { status(): Promise<SdkAttachStatus> };
}

/** The raw @glyphh/sdk handle, or null off-web / pre-boot. */
export function relaySdk(): SdkClient | null {
  return (window as unknown as { glyphhSdk?: SdkClient }).glyphhSdk ?? null;
}

/** The API origin the web target boots against (bridge stamps it before us). */
export function relayApiUrl(): string {
  const w = window as unknown as { __GLYPHH_API_URL__?: string };
  return (w.__GLYPHH_API_URL__ || "https://api.glyphh.ai").replace(/\/$/, "");
}

/** ws(s):// URL for /ws/panel, derived from the API origin. */
export function relayWsUrl(token: string): string {
  const base = relayApiUrl().replace(/^http/, "ws");
  return `${base}/ws/panel?token=${encodeURIComponent(token)}`;
}

/** Why the socket closed. `code` is the WebSocket close code; a server-side
 *  refusal names its reason. 0 when this side closed it. */
export interface RelayClose { code: number; reason: string }
/** The server's code when the attached desktop detached mid-socket. */
export const MACHINE_DETACHED = 4410;
export const machineDetached = (info: RelayClose | undefined): boolean => info?.code === MACHINE_DETACHED;

// ── the envelope client ──────────────────────────────────────────────────────

const RPC_TIMEOUT_MS = 15_000;

export interface RelaySocket {
  /** Request/response — resolves the far `result`, rejects on error/timeout. */
  /** `timeoutMs` for a call that legitimately takes long (a cloud browser's cold start behind panel.open). */
  call(method: string, params: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
  /** Fire-and-forget request (input events don't need a reply). */
  send(method: string, params: unknown): void;
  /** Subscribe to push frames. `channel` filters to one channel; null = all.
   *  Returns the unsubscribe. */
  onPush(channel: string | null, cb: (channel: string, data: unknown) => void): () => void;
  /** Runs once when the socket closes (any reason), with the close code and
   *  the server's reason — 4410 "machine detached" is the desktop going away
   *  mid-panel. Returns the unsubscribe. */
  onClose(cb: (info: RelayClose) => void): () => void;
  isOpen(): boolean;
  /** Close the socket; every pending call rejects. Idempotent. */
  close(): void;
}

/**
 * Open a relay socket. Resolves once the upgrade completes; rejects if the
 * socket errors/closes before opening (bad token, server down).
 */
export function connectRelaySocket(token: string): Promise<RelaySocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(relayWsUrl(token));
    let seq = 0;
    let opened = false;
    let closed = false;
    const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    const pushSubs = new Set<{ channel: string | null; cb: (channel: string, data: unknown) => void }>();
    const closeSubs = new Set<(info: RelayClose) => void>();
    let closeInfo: RelayClose = { code: 0, reason: "" };

    const settleClosed = (info?: RelayClose): void => {
      if (closed) return;
      closed = true;
      if (info) closeInfo = info;
      for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(closeInfo.reason ? `relay socket closed: ${closeInfo.reason}` : "relay socket closed")); }
      pending.clear();
      for (const cb of closeSubs) { try { cb(closeInfo); } catch { /* subscriber's problem */ } }
      closeSubs.clear();
      pushSubs.clear();
    };

    const api: RelaySocket = {
      call(method, params, opts) {
        return new Promise((res, rej) => {
          if (socket.readyState !== WebSocket.OPEN) { rej(new Error("relay socket not open")); return; }
          const id = "w" + (++seq);
          const timer = setTimeout(() => { pending.delete(id); rej(new Error(`${method} timed out`)); }, opts?.timeoutMs ?? RPC_TIMEOUT_MS);
          pending.set(id, { resolve: res, reject: rej, timer });
          try { socket.send(JSON.stringify({ t: "req", id, method, params })); }
          catch (err) { clearTimeout(timer); pending.delete(id); rej(err as Error); }
        });
      },
      send(method, params) {
        if (socket.readyState !== WebSocket.OPEN) return;
        try { socket.send(JSON.stringify({ t: "req", id: "i" + (++seq), method, params })); } catch { /* dropped */ }
      },
      onPush(channel, cb) {
        const sub = { channel, cb };
        pushSubs.add(sub);
        return () => pushSubs.delete(sub);
      },
      onClose(cb) {
        if (closed) { cb(closeInfo); return () => {}; }
        closeSubs.add(cb);
        return () => closeSubs.delete(cb);
      },
      isOpen: () => socket.readyState === WebSocket.OPEN,
      close() {
        try { socket.close(); } catch { /* noop */ }
        settleClosed();
      },
    };

    socket.onopen = () => { opened = true; resolve(api); };
    socket.onerror = () => { /* onclose follows */ };
    socket.onclose = (ev?: CloseEvent) => {
      const reason = ev?.reason || "";
      if (!opened) reject(new Error(reason ? `relay socket failed to connect: ${reason}` : "relay socket failed to connect"));
      settleClosed({ code: ev?.code ?? 0, reason });
    };
    socket.onmessage = (ev) => {
      let f: { t?: string; id?: string; ok?: boolean; result?: unknown; error?: string; channel?: string; data?: unknown };
      try { f = JSON.parse(String(ev.data)); } catch { return; }
      if (f.t === "res" && typeof f.id === "string") {
        const p = pending.get(f.id);
        if (!p) {
          // Fire-and-forget ("i…") errors were swallowed whole — a broken
          // dispatch (no attached machine, method not allowed) made panel
          // input look like the CLIENT went dead. Keep them non-fatal, but
          // say so where a bug report can find it.
          if (f.ok === false && f.id.startsWith("i")) console.warn("[relay] send failed:", f.error || "relay error");
          return;
        }
        pending.delete(f.id);
        clearTimeout(p.timer);
        if (f.ok) p.resolve(f.result);
        else p.reject(new Error(f.error || "relay error"));
      } else if (f.t === "push" && typeof f.channel === "string" && f.data !== undefined) {
        for (const sub of [...pushSubs]) {
          if (sub.channel === null || sub.channel === f.channel) {
            try { sub.cb(f.channel, f.data); } catch { /* subscriber's problem */ }
          }
        }
      }
    };
  });
}
