/**
 * harness-api.ts — the renderer's plain HTTP/WS door to the server's harness
 * front door (`/api/harness/*`) — on the WEB target, and on the DESKTOP for
 * the cloud terminal (the pod's pty).
 *
 * The SDK's HarnessClient (window.glyphhSdk.harnessViaApi()) owns the RUN
 * transport (frames, answers, stops) and the workspace fs. The routes added
 * for the web command center — the thread store and the worker pty — are
 * thin JSON/WS resources the renderer can speak directly, authenticated by the
 * same session bearer the SDK holds (`client.token()`), against the same API
 * origin the bridge booted with (window.__GLYPHH_API_URL__). This module is
 * that one place: base url, bearer, error shape, WS url.
 *
 * Routes the web expects (the control plane serves them; confirmed 2026-10-04):
 *   GET    /api/harness/threads                → ThreadMeta[] (owner's, newest first, no messages)
 *   GET    /api/harness/threads/:id            → ThreadMeta + { messages }
 *   PUT    /api/harness/threads/:id            ← { title?, mode?, source?, messages?, updatedAt }
 *                                              → { applied, thread: ThreadMeta }   (LWW on updatedAt;
 *                                                409 `stale` when the stored copy is newer)
 *   DELETE /api/harness/threads/:id            → tombstone (404 = already gone)
 *   POST   /api/harness/pty                    ← { cwd?, cols, rows, command?, scope? }
 *                                              → { ptyId, wsPath, wire: "glyphh.terminal/v2" }
 *   DELETE /api/harness/pty/:ptyId             closes it
 *   WS     /api/harness/pty/:ptyId?token=…     JSON frames (pty-frames.ts): data (base64), resize,
 *                                              close, ping both ways; ready / exit / error from the worker
 * Errors are `{ error, detail }`.
 *
 * The renderer cannot import from @glyphh/sdk (preload boundary); the SDK
 * handle's `token()` is reached structurally, like remote-run.ts does.
 */

export class HarnessHttpError extends Error {
  readonly httpStatus: number;
  /** The server's error code (`{ error }`), e.g. "stale" on a 409 push. */
  readonly code: string;
  constructor(status: number, message: string, code = "") {
    super(message);
    this.httpStatus = status;
    this.code = code;
  }
}

/** The two doors to the bearer and the origin: the WEB's SDK handle (the
 *  bridge stamps `__GLYPHH_API_URL__`), else the DESKTOP's preload bridge —
 *  its renderer never holds the SDK; main does (glyphh-client.ts), and
 *  `glyphh-harness-token` hands the current session token over (cloud-run.ts). */
interface HarnessDoors {
  __GLYPHH_API_URL__?: string;
  glyphhSdk?: { token?: () => Promise<string | null> };
  glyphh?: { apiUrl?: string; serverUrl?: string; harnessToken?: () => Promise<string | null> };
}
const doors = (): HarnessDoors => (typeof window === "undefined" ? {} : (window as unknown as HarnessDoors));

/** The API origin this surface talks to: the web bridge's stamp, else the
 *  desktop's SERVER_URL as preload carries it. */
export function harnessApiUrl(): string {
  const w = doors();
  return (w.__GLYPHH_API_URL__ || w.glyphh?.apiUrl || w.glyphh?.serverUrl || "https://api.glyphh.ai").replace(/\/+$/, "");
}

/** The session bearer: the SDK handle on the web, main's token store on the
 *  desktop; null when signed out / neither door exists. Never logged. */
export async function harnessToken(): Promise<string | null> {
  const w = doors();
  const sdk = w.glyphhSdk;
  if (typeof sdk?.token === "function") {
    try { return (await sdk.token()) || null; } catch { return null; }
  }
  const bridge = w.glyphh;
  if (typeof bridge?.harnessToken === "function") {
    try { return (await bridge.harnessToken()) || null; } catch { return null; }
  }
  return null;
}

/** `wss://…/api/harness<path>?token=…` — a browser cannot set WS headers, so
 *  the bearer rides the query, exactly as the SDK's own harness socket does. */
export function harnessWsUrl(path: string, token: string): string {
  const base = harnessApiUrl().replace(/^http/i, "ws");
  const p = path.startsWith("/") ? path : `/${path}`;
  const sep = p.includes("?") ? "&" : "?";
  return `${base}/api/harness${p}${sep}token=${encodeURIComponent(token)}`;
}

/** One JSON request against /api/harness. Throws HarnessHttpError (with the
 *  status) on a non-2xx answer; a 204 resolves undefined. Server envelopes
 *  (`{ data }`) are unwrapped. */
export async function harnessRequest<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const token = await harnessToken();
  if (!token) throw new HarnessHttpError(401, "signed out");
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const p = path.startsWith("/") ? path : `/${path}`;
  const res = await fetch(`${harnessApiUrl()}/api/harness${p}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) { try { parsed = JSON.parse(text); } catch { parsed = text; } }
  if (!res.ok) {
    // The server's shape is `{ error, detail }` — the code first, the human line after.
    const e = parsed && typeof parsed === "object" ? (parsed as { error?: unknown; detail?: unknown }) : {};
    const code = typeof e.error === "string" ? e.error : "";
    const detail = typeof e.detail === "string" ? e.detail : "";
    const msg = code || detail
      ? `${code}${code && detail ? ": " : ""}${detail}`
      : `${method} /api/harness${p} failed (${res.status})`;
    throw new HarnessHttpError(res.status, msg, code);
  }
  if (parsed && typeof parsed === "object" && "data" in (parsed as Record<string, unknown>) && Object.keys(parsed as object).length === 1) {
    return (parsed as { data: T }).data;
  }
  return parsed as T;
}
