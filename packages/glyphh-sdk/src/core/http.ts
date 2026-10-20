/**
 * http.ts — the SDK's one HTTP client, built on injectable `fetch` so it runs on
 * Node, the browser, and React Native/Hermes unchanged. It owns: base-URL join,
 * JSON encode/decode, bearer injection, an AbortController timeout, response
 * envelope unwrapping (`{ data }`), and mapping the server's typed error envelope
 * to the SDK error hierarchy. Reconnect/refresh policy lives above it.
 */

import { ConnectError, apiErrorFor } from "./errors.js";
import { createLogger, type Logger } from "./logger.js";

export type FetchLike = typeof fetch;

export interface HttpOptions {
  baseUrl: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  logger?: Logger;
}

export interface RequestOptions {
  /** Bearer token to attach (access token or a static API key). */
  bearer?: string | undefined;
  signal?: AbortSignal | undefined;
  /**
   * Return the response body AS-IS instead of unwrapping the `{ data }` success
   * envelope. For the endpoints that deliberately speak a foreign wire format —
   * the gateway answers an OpenAI-shaped completion verbatim so an OpenAI client
   * can call it unchanged.
   */
  raw?: boolean | undefined;
}

/**
 * The two error shapes the control plane speaks: the typed envelope
 * (`{ error: { code, message, … } }`) on the glyphh routes, and the flat
 * `{ error, detail }` pair the harness and member-library routes answer with
 * (the pod's shape, so one decoder serves both). The flat form's `error` IS the
 * code and `detail` the message.
 */
interface ErrorEnvelope {
  error?: string | { code?: string; message?: string; remediation?: string; requestId?: string; retryable?: boolean };
  detail?: string;
}

function decodeError(env: ErrorEnvelope, status: number): Parameters<typeof apiErrorFor>[0] {
  if (typeof env.error === "string") {
    return { code: env.error, message: env.detail ?? env.error, httpStatus: status };
  }
  const e = env.error;
  return {
    code: e?.code ?? "E_INTERNAL",
    message: e?.message ?? `HTTP ${status}`,
    httpStatus: status,
    ...(e?.remediation !== undefined ? { remediation: e.remediation } : {}),
    ...(e?.requestId !== undefined ? { requestId: e.requestId } : {}),
    ...(e?.retryable !== undefined ? { retryable: e.retryable } : {}),
  };
}

export class HttpClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly log: Logger;

  constructor(opts: HttpOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    // Bind to preserve the global's `this` (some runtimes require it).
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.log = opts.logger ?? createLogger();
  }

  get<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("GET", path, undefined, opts);
  }
  /** A GET that returns the raw response bytes (a download), not a parsed envelope. */
  async getBytes(path: string, opts: RequestOptions = {}): Promise<ArrayBuffer> {
    const headers: Record<string, string> = {};
    if (opts.bearer) headers["authorization"] = `Bearer ${opts.bearer}`;
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { method: "GET", headers });
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
    return res.arrayBuffer();
  }
  /** POST raw bytes with an explicit content-type (e.g. audio/webm) → JSON. */
  async postBinary<T>(path: string, bytes: Uint8Array, contentType: string, opts: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { "content-type": contentType, accept: "application/json" };
    if (opts.bearer) headers["authorization"] = `Bearer ${opts.bearer}`;
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { method: "POST", headers, body: bytes as Uint8Array<ArrayBuffer> });
    if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
    // Unwrap the `{ data }` success envelope exactly like request() does —
    // returning it raw made every postBinary payload arrive one level deeper
    // than the declared type (the web mic transcribed to "" because of it).
    const json = (await res.json()) as { data?: T };
    return (json?.data !== undefined ? json.data : json) as T;
  }
  /** POST a JSON body and read the response as raw bytes (e.g. synthesized audio). */
  async postForBytes(path: string, body: unknown, opts: RequestOptions = {}): Promise<ArrayBuffer> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.bearer) headers["authorization"] = `Bearer ${opts.bearer}`;
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
    return res.arrayBuffer();
  }
  post<T>(path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("POST", path, body, opts);
  }
  patch<T>(path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("PATCH", path, body, opts);
  }
  put<T>(path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("PUT", path, body, opts);
  }
  /**
   * A STREAMING request: the raw `Response`, body untouched.
   *
   * Everything else here buffers, parses, and unwraps — right for a control-plane
   * call, wrong for a model turn, which arrives as SSE over a long-lived
   * connection. This is also deliberately exempt from the standard timeout: that
   * clock is sized for a request/response round trip and would cut a streaming
   * turn off mid-answer. The caller's `signal` is the only cancellation.
   */
  async stream(path: string, body: unknown, opts: RequestOptions & { headers?: Record<string, string> } = {}): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
    if (opts.bearer) headers["authorization"] = `Bearer ${opts.bearer}`;
    const init: RequestInit = {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    };
    if (opts.signal) init.signal = opts.signal;
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch (e) {
      throw new ConnectError(`request failed: ${(e as Error).message}`);
    }
  }

  /** DELETE, optionally with a JSON body (a tombstone carries its LWW clock). */
  del<T>(path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("DELETE", path, body, opts);
  }

  private async request<T>(method: string, path: string, body: unknown, opts: RequestOptions): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { accept: "application/json" };
    // A Uint8Array body goes over the wire AS-IS (app source archives); everything
    // else is JSON. One request path, so auth/timeout/error handling stay identical.
    const raw = body instanceof Uint8Array;
    if (body !== undefined) headers["content-type"] = raw ? "application/octet-stream" : "application/json";
    if (opts.bearer) headers["authorization"] = `Bearer ${opts.bearer}`;

    // Timeout via AbortController, composed with any caller-supplied signal.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onAbort);

    const init: RequestInit = { method, headers, signal: controller.signal };
    if (body !== undefined) init.body = raw ? (body as Uint8Array<ArrayBuffer>) : JSON.stringify(body);

    let res: Response;
    try {
      res = await this.fetchImpl(url, init);
    } catch (e) {
      this.log.warn("request error", { method, path });
      throw new ConnectError(`request to ${path} failed`, e);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }

    const text = await res.text().catch(() => "");
    const json = text ? safeParse(text) : undefined;

    if (!res.ok) {
      const decoded = decodeError((json ?? {}) as ErrorEnvelope, res.status);
      this.log.warn("request failed", { method, path, status: res.status, code: decoded.code });
      throw apiErrorFor(decoded);
    }
    // Success envelope is `{ data }`; 204/no-body returns undefined. `raw`
    // endpoints answer a foreign shape and are handed back untouched.
    if (opts.raw) return json as T;
    return (json as { data?: T } | undefined)?.data as T;
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
