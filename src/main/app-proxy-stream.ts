/**
 * app-proxy-stream — client side of the relay's HTTP stream protocol
 * (yo-server RELAY-AND-APP-PROXY §"Required client-side counterpart").
 *
 * A request to https://<slug>.glyphh.app hits yo-server, which opens a relay
 * stream to THIS client. We resolve the slug (from the forwarded Host header)
 * against the org's proxy rows (`GET /api/apps/proxies`, cached), open the
 * request against the row's local `target`, feed it the request-body chunks,
 * and stream the response back:
 *
 *   server → client : stream_request { reqId, params:{ method, path, headers } }
 *                     stream_req_data { reqId, dataB64 }   (request-body chunk)
 *                     stream_req_end  { reqId }            (request body done)
 *                     stream_cancel   { reqId }            (visitor gone; abort)
 *   client → server : stream_head  { reqId, status, headers }
 *                     stream_data  { reqId, dataB64 }      (response chunk)
 *                     stream_end   { reqId }
 *                     stream_error { reqId, error }
 */

import http from "http";
import https from "https";
import { serverGetAuthed } from "./auth.js";

type SendFrame = (frame: Record<string, unknown>) => void;

interface StreamFrame {
  type: "stream_request" | "stream_req_data" | "stream_req_end" | "stream_cancel";
  reqId: string;
  params?: { method?: string; path?: string; headers?: Record<string, string | string[]> };
  dataB64?: string;
}

interface ProxyRow { slug: string; target: string; status: string }

// ── slug → target resolution (cached; refreshed on miss) ──────────────────

let proxyCache: ProxyRow[] = [];
let proxyCacheAt = 0;
const PROXY_CACHE_MS = 30_000;

async function resolveTarget(slug: string): Promise<string | null> {
  const lookup = () => proxyCache.find((p) => p.slug === slug && p.status === "active")?.target || null;
  if (Date.now() - proxyCacheAt < PROXY_CACHE_MS) {
    const hit = lookup();
    if (hit) return hit;
  }
  try {
    const res = await serverGetAuthed<{ proxies: ProxyRow[] }>("/api/apps/proxies");
    proxyCache = res.proxies || [];
    proxyCacheAt = Date.now();
  } catch { /* keep the stale cache — better than dropping the request */ }
  return lookup();
}

/** Drop the cache — call after the user edits proxies so changes apply now. */
export function invalidateProxyCache(): void {
  proxyCacheAt = 0;
}

// ── active streams ─────────────────────────────────────────────────────────

interface ActiveStream {
  creq: http.ClientRequest;
  /** Body chunks that arrived before the upstream request existed. */
  done: boolean;
}

const active = new Map<string, ActiveStream>();

function slugFromHost(host: string | string[] | undefined): string | null {
  const h = String(Array.isArray(host) ? host[0] : host || "").toLowerCase().split(":")[0];
  const label = h.split(".")[0];
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label) ? label : null;
}

async function startStream(frame: StreamFrame, send: SendFrame): Promise<void> {
  const reqId = frame.reqId;
  const params = frame.params || {};
  const headers: Record<string, string | string[]> = { ...(params.headers || {}) };

  const slug = slugFromHost(headers.host);
  const target = slug ? await resolveTarget(slug) : null;
  if (!target) {
    send({ type: "stream_error", reqId, error: `no app "${slug || "?"}" is served from this machine` });
    return;
  }

  let base: URL;
  try { base = new URL(target); } catch {
    send({ type: "stream_error", reqId, error: `invalid target for "${slug}": ${target}` });
    return;
  }

  // Rewrite Host to the local target (dev servers vhost-check it); keep the
  // public host in X-Forwarded-* like any tunnel would.
  headers["x-forwarded-host"] = headers.host || "";
  headers["x-forwarded-proto"] = "https";
  headers.host = base.host;

  const mod = base.protocol === "https:" ? https : http;
  const creq = mod.request(
    {
      protocol: base.protocol,
      hostname: base.hostname,
      port: base.port || (base.protocol === "https:" ? 443 : 80),
      path: params.path || "/",
      method: params.method || "GET",
      headers,
    },
    (cres) => {
      send({ type: "stream_head", reqId, status: cres.statusCode || 502, headers: cres.headers });
      cres.on("data", (chunk: Buffer) => send({ type: "stream_data", reqId, dataB64: chunk.toString("base64") }));
      cres.on("end", () => { send({ type: "stream_end", reqId }); active.delete(reqId); });
      cres.on("error", () => { send({ type: "stream_error", reqId, error: "response stream failed" }); active.delete(reqId); });
    },
  );

  creq.on("error", (err) => {
    send({ type: "stream_error", reqId, error: `app unreachable at ${target}: ${err.message}` });
    active.delete(reqId);
  });

  active.set(reqId, { creq, done: false });
}

/**
 * Handle one relay stream frame. Called by relay-client for every
 * stream_* frame that arrives on the socket.
 */
export function handleStreamFrame(raw: unknown, send: SendFrame): void {
  const frame = raw as StreamFrame;
  if (!frame?.reqId) return;

  if (frame.type === "stream_request") {
    void startStream(frame, send);
    return;
  }

  const s = active.get(frame.reqId);
  if (!s) return; // late frame for a dead stream — drop

  if (frame.type === "stream_req_data" && frame.dataB64) {
    try { s.creq.write(Buffer.from(frame.dataB64, "base64")); } catch { /* aborted */ }
  } else if (frame.type === "stream_req_end") {
    s.done = true;
    try { s.creq.end(); } catch { /* aborted */ }
  } else if (frame.type === "stream_cancel") {
    try { s.creq.destroy(); } catch { /* already gone */ }
    active.delete(frame.reqId);
  }
}

/** Abort everything (socket dropped) — upstream requests must not linger. */
export function abortAllStreams(): void {
  for (const s of active.values()) {
    try { s.creq.destroy(); } catch { /* already gone */ }
  }
  active.clear();
}
