/**
 * loop/mcp.ts — a minimal MCP client over Streamable HTTP, on plain fetch.
 * The loop needs three verbs from a server (initialize, tools/list,
 * tools/call); the app's local MCP server and the gateway's /mcp both speak
 * this transport. A response may arrive as JSON or as one SSE stream — both
 * are read for the reply whose id matches.
 */

import type { ImageParam } from "./messages.js";

/** MCP tool annotations (2025-03-26): a server's own word on what a tool does. */
export interface McpToolAnnotations { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean; title?: string }
export interface McpToolInfo { name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: McpToolAnnotations }
export interface McpContentPart { type: string; text?: string; [k: string]: unknown }
export interface McpCallResult { content: McpContentPart[]; isError: boolean }

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface McpHttpClientOptions {
  url: string;
  headers?: Record<string, string>;
  /** Shown to the server as clientInfo.name. */
  name?: string;
  version?: string;
  fetch?: FetchLike;
  /** Per-request timeout for list/initialize (default 30s). */
  timeoutMs?: number;
  /** Per-call timeout for tools/call (default 10 minutes). */
  callTimeoutMs?: number;
}

const PROTOCOL = "2025-03-26";

interface RpcResponse { id?: unknown; result?: unknown; error?: { code?: number; message?: string } }

export class McpHttpClient {
  private nextId = 1;
  private sessionId: string | null = null;
  private readonly doFetch: FetchLike;

  constructor(private readonly opts: McpHttpClientOptions) {
    this.doFetch = opts.fetch ?? ((u, i) => fetch(u, i));
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      ...(this.opts.headers ?? {}),
    };
  }

  private async post(payload: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    const ctl = new AbortController();
    const onAbort = (): void => ctl.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(new Error("the MCP server did not answer in time")), timeoutMs);
    try {
      return await this.doFetch(this.opts.url, { method: "POST", headers: this.headers(), body: JSON.stringify(payload), signal: ctl.signal });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** One JSON-RPC request → its result (JSON or SSE body). */
  private async request(method: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: "2.0", id, method, params }, timeoutMs, signal);
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`mcp ${res.status}: ${text.slice(0, 300) || res.statusText}`);
    }
    const ctype = res.headers.get("content-type") ?? "";
    const reply = ctype.includes("text/event-stream") ? await this.readSse(res, id) : ((await res.json()) as RpcResponse);
    if (!reply) throw new Error(`mcp: no reply to ${method}`);
    if (reply.error) throw new Error(reply.error.message ?? `mcp: ${method} failed`);
    return reply.result;
  }

  private async readSse(res: Response, id: number): Promise<RpcResponse | null> {
    if (!res.body) return null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let found: RpcResponse | null = null;
    const take = (raw: string): void => {
      const data = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
      if (!data) return;
      try {
        const j = JSON.parse(data) as RpcResponse | RpcResponse[];
        for (const r of Array.isArray(j) ? j : [j]) if (r && typeof r === "object" && r.id === id) found = r;
      } catch { /* a notification or a partial frame */ }
    };
    try {
      while (!found) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let at: number;
        while ((at = buf.indexOf("\n\n")) >= 0) {
          take(buf.slice(0, at));
          buf = buf.slice(at + 2);
          if (found) break;
        }
      }
      if (!found && buf.trim()) take(buf);
    } finally {
      try { await reader.cancel(); } catch { /* closed */ }
    }
    return found;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    const timeout = this.opts.timeoutMs ?? 30_000;
    await this.request("initialize", {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: this.opts.name ?? "glyphh-loop", version: this.opts.version ?? "1.0.0" },
    }, timeout, signal);
    // The initialized notification has no id and expects no reply (202).
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, timeout, signal).catch(() => undefined);
  }

  async listTools(signal?: AbortSignal): Promise<McpToolInfo[]> {
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = (await this.request("tools/list", cursor ? { cursor } : {}, this.opts.timeoutMs ?? 30_000, signal)) as { tools?: McpToolInfo[]; nextCursor?: string } | undefined;
      out.push(...(r?.tools ?? []));
      if (!r?.nextCursor) break;
      cursor = r.nextCursor;
    }
    return out;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    const r = (await this.request("tools/call", { name, arguments: args }, this.opts.callTimeoutMs ?? 600_000, signal)) as { content?: McpContentPart[]; isError?: boolean } | undefined;
    return { content: Array.isArray(r?.content) ? r.content : [], isError: r?.isError === true };
  }

  /** End the session server-side, best-effort. */
  async close(): Promise<void> {
    if (!this.sessionId) return;
    try { await this.doFetch(this.opts.url, { method: "DELETE", headers: this.headers() }); } catch { /* gone */ }
    this.sessionId = null;
  }
}

/** The text of a tool result, one line per text part. */
export function resultText(r: McpCallResult): string {
  return r.content.map((b) => (b.type === "text" ? b.text ?? "" : `[${b.type}]`)).join("\n") || "(no output)";
}

/** A tool result's IMAGE parts, as images the model can see. */
export function resultImages(r: McpCallResult): ImageParam[] {
  return r.content
    .filter((b) => b.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string")
    .map((b) => ({ type: "image" as const, source: { type: "base64" as const, media_type: String(b.mimeType), data: String(b.data) } }));
}

/** THE MODEL NEVER READS BASE64 (his audit, 2026-09-29: one screenshot, sent
 *  as a 200,000-character data URL in a tool's text, was a 96,667-token call
 *  that cost $1.23 and showed the model nothing). Any data:image URL in a
 *  result's text comes out as an image; the text keeps a marker. */
const DATA_IMAGE = /data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]{64,})/g;
export function splitDataImages(text: string): { text: string; images: ImageParam[] } {
  const images: ImageParam[] = [];
  const out = text.replace(DATA_IMAGE, (_m, mediaType: string, data: string) => {
    images.push({ type: "image", source: { type: "base64", media_type: mediaType, data } });
    return "[image]";
  });
  return { text: out, images };
}
