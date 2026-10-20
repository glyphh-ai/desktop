/**
 * runtime/interceptor.ts — the local Anthropic endpoint an agent loop is pointed at.
 * Node-only; imported by the desktop's main process and the CLI.
 *
 * WHY THIS EXISTS. The Claude Agent SDK runs its loop in a subprocess that speaks
 * the Anthropic Messages API over HTTP, addressed by `ANTHROPIC_BASE_URL`. It cannot
 * be handed a function — it needs a real listener. This is that listener, and it is
 * the ONLY thing it does: accept a request on loopback, hand it to the SDK client,
 * and stream the reply back byte for byte. It holds no URL, no token, and no fetch;
 * everything outbound goes through `client.gateway.messages()`.
 *
 * It is deliberately NOT a router, a translator, or a policy layer. Everything that
 * decides anything — which models a caller may use, whose key pays, what a turn
 * costs, when to refuse — lives server-side where the keys and the ledger are. An
 * earlier desktop version of this file made those decisions locally and drifted out
 * of sync with the server until every model call failed; keeping this dumb is the
 * fix, not an accident.
 *
 * SECURITY. It binds 127.0.0.1 on an ephemeral port and mints a per-process bearer
 * that the caller must present as `x-api-key`/`authorization`. Any local process can
 * reach a loopback port, so without that check the machine's other software could
 * spend the org's dollars through it.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Client } from "../client.js";
import { findLocalModel } from "../models/catalog.js";
import { ensureLocalModel } from "../models/manager.js";
import { toOpenAIRequest, toAnthropicResponse, createStreamTranslator, type AnthropicRequest } from "./anthropic-openai.js";

/** Local model ids ride the catalog as `local::<spec-id>` (priced 0). */
const LOCAL_PREFIX = "local::";

export interface InterceptorOptions {
  /**
   * The SDK client. The interceptor holds NO url, no token, and no fetch of its
   * own — it forwards through `client.gateway.messages()`, so the base URL, the
   * bearer, and token refresh all stay where they already live. Nothing here
   * addresses the control plane directly.
   */
  client: Client;
  /** Called when a forwarded turn fails, for logs/telemetry. Never throws. */
  onError?: (error: Error) => void;
  /**
   * Per-turn usage, from a trailing `glyphh_usage` frame the gateway appends to
   * the SSE stream. `usd` is the server's computed price in dollars; tokens are real.
   * The frame is stripped here so the Agent SDK never sees a non-Anthropic event.
   */
  onUsage?: (usage: { usd: number; inputTokens: number; outputTokens: number }, runId?: string) => void;
}

export interface Interceptor {
  /** Base URL to hand the Agent SDK as ANTHROPIC_BASE_URL. */
  url: string;
  /** The value the Agent SDK must send as ANTHROPIC_API_KEY. */
  apiKey: string;
  close(): Promise<void>;
}

/** Read a request body without assuming a parser is installed. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

/** Anthropic-shaped error body — the Agent SDK reads this format. */
function anthError(type: string, message: string): unknown {
  return { type: "error", error: { type, message } };
}

/**
 * Serve one `local::…` turn from the machine's own llama-server: ensure the
 * model (download once, spawn once, health-checked singleton), translate
 * Anthropic → OpenAI, relay, translate back — streaming or not. Usage reports
 * at ZERO dollars: local compute is the user's own.
 */
async function handleLocal(body: AnthropicRequest, modelId: string, res: ServerResponse, opts: InterceptorOptions, runId?: string): Promise<void> {
  const specId = modelId.slice(LOCAL_PREFIX.length);
  const spec = findLocalModel(specId);
  if (!spec) {
    send(res, 404, anthError("invalid_request_error", `unknown local model '${specId}'`));
    return;
  }
  let local: { url: string };
  try {
    local = await ensureLocalModel(spec.id);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    send(res, 502, anthError("api_error",
      `local model '${spec.id}' failed to start: ${detail}. Install llama.cpp (brew install llama.cpp) or point GLYPHH_LLAMA_BIN at a llama-server binary.`));
    return;
  }

  const streaming = (body as { stream?: boolean }).stream === true;
  const oai = toOpenAIRequest(body, spec.id) as Record<string, unknown>;
  oai.stream = streaming;

  let upstream: Response;
  try {
    upstream = await fetch(`${local.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(oai),
    });
  } catch (err) {
    send(res, 502, anthError("api_error", `local model unreachable: ${err instanceof Error ? err.message : String(err)}`));
    return;
  }
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    send(res, 502, anthError("api_error", `local model error (${upstream.status}): ${text.slice(0, 400)}`));
    return;
  }

  if (!streaming) {
    const json = (await upstream.json()) as Parameters<typeof toAnthropicResponse>[0];
    const usage = (json as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
    try { opts.onUsage?.({ usd: 0, inputTokens: usage?.prompt_tokens ?? 0, outputTokens: usage?.completion_tokens ?? 0 }, runId); } catch { /* listener */ }
    send(res, 200, toAnthropicResponse(json, modelId));
    return;
  }

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const translator = createStreamTranslator(modelId);
  const reader = upstream.body?.getReader();
  const decoder = new TextDecoder();
  try {
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const frames = translator.feed(decoder.decode(value, { stream: true }));
        if (frames) res.write(frames);
      }
    }
  } finally {
    res.write(translator.end());
    res.end();
    const usage = translator.usage();
    try { opts.onUsage?.({ usd: 0, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }, runId); } catch { /* listener */ }
  }
}

/**
 * Start the local Anthropic endpoint. Resolves once it is listening.
 *
 * The returned `url`/`apiKey` go straight into the agent subprocess's environment;
 * nothing else should hold them.
 */
export async function startInterceptor(opts: InterceptorOptions): Promise<Interceptor> {
  // Per-process, never persisted: a restart invalidates it, which is what we want.
  const apiKey = `glyphh-local-${randomBytes(24).toString("hex")}`;

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      try { opts.onError?.(error); } catch { /* a listener must not break the relay */ }
      if (!res.headersSent) {
        send(res, 502, { type: "error", error: { type: "api_error", message: error.message } });
      } else {
        res.end();
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Loopback is not authentication: gate on the per-process key.
    const presented = String(req.headers["x-api-key"] ?? "")
      || String(req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
    if (presented !== apiKey) {
      send(res, 401, { type: "error", error: { type: "authentication_error", message: "bad local key" } });
      return;
    }

    const path = (req.url ?? "").split("?")[0];
    if (req.method !== "POST" || !path?.startsWith("/v1/messages")) {
      send(res, 404, { type: "error", error: { type: "not_found_error", message: `no route for ${req.method} ${path}` } });
      return;
    }

    const body = await readBody(req);

    // LOCAL models never leave the machine: `local::…` routes to a llama-server
    // this process owns (downloaded + spawned on first use), translated to and
    // from OpenAI chat-completions right here. No gateway, no internet, no
    // dollars — the compute the user owns.
    let parsedBody: AnthropicRequest | null = null;
    try { parsedBody = JSON.parse(body) as AnthropicRequest; } catch { /* not JSON — the gateway will reject it */ }
    // Concurrent runs share this one interceptor — the caller tags each
    // subprocess's requests (ANTHROPIC_CUSTOM_HEADERS) so usage attributes
    // to the run that spent it, not to whichever run listened last.
    const runId = String(req.headers["x-glyphh-run"] ?? "") || undefined;
    const requestedModel = String(parsedBody?.model ?? "");
    if (parsedBody && requestedModel.startsWith(LOCAL_PREFIX)) {
      await handleLocal(parsedBody, requestedModel, res, opts, runId);
      return;
    }

    // Through the SDK: it owns the route, the base URL, and a bearer refreshed
    // per call, so a long agent run cannot outlive the token it started with.
    // Version + beta headers are the caller's to choose; pass them through so a
    // feature the agent opts into is not silently dropped here.
    const upstream = await opts.client.gateway.messages(body, {
      headers: {
        ...(req.headers["anthropic-version"] ? { "anthropic-version": String(req.headers["anthropic-version"]) } : {}),
        ...(req.headers["anthropic-beta"] ? { "anthropic-beta": String(req.headers["anthropic-beta"]) } : {}),
      },
    });

    // Status and body are relayed as-is. The Agent SDK reads upstream statuses to
    // decide whether to retry, so translating them into something friendlier would
    // break behaviour that already works.
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      ...(upstream.headers.get("content-type")?.includes("event-stream")
        ? { "cache-control": "no-cache", connection: "keep-alive" }
        : {}),
    });

    if (!upstream.body) {
      res.end(await upstream.text());
      return;
    }

    // Forward the stream, but hold back a trailing `glyphh_usage` frame the
    // gateway appends after Anthropic's message_stop. Everything from that
    // marker on is ours: strip it so the Agent SDK sees only Anthropic events,
    // and report the dollars it carries. A small carry buffer covers the marker
    // being split across chunk boundaries.
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const MARKER = "event: glyphh_usage";
    let tail = "";        // decoded text not yet forwarded (possible partial marker)
    let captured = "";    // our frame, once the marker is seen

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      tail += decoder.decode(value, { stream: true });
      const idx = tail.indexOf(MARKER);
      if (idx !== -1) {
        if (idx > 0) res.write(encoder.encode(tail.slice(0, idx)));
        captured = tail.slice(idx);
        // The frame is the stream's tail — drain the rest into it and stop.
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          captured += decoder.decode(r.value, { stream: true });
        }
        tail = "";
        break;
      }
      // No marker yet: forward all but a marker-length tail, in case it is split.
      const safe = tail.length - MARKER.length;
      if (safe > 0) { res.write(encoder.encode(tail.slice(0, safe))); tail = tail.slice(safe); }
    }
    if (tail) res.write(encoder.encode(tail));  // flush a marker that never came
    res.end();

    if (captured && opts.onUsage) {
      const m = /data: (\{.*\})/.exec(captured);
      if (m?.[1]) { try { opts.onUsage(JSON.parse(m[1]), runId); } catch { /* malformed frame — skip */ } }
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    apiKey,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Sockets held open by a live stream would keep the process alive.
        server.closeAllConnections?.();
      }),
  };
}
