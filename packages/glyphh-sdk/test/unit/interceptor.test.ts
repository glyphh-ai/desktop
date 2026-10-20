/**
 * The local Anthropic endpoint. It should forward faithfully, stream without
 * buffering, refuse unauthenticated local callers, and relay upstream statuses
 * rather than reinterpreting them.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { startInterceptor, type Interceptor } from "../../src/runtime/interceptor.js";
import { createClient } from "../../src/client.js";
import { InMemoryTokenStore } from "../../src/auth/token-store.js";

let running: Interceptor | null = null;
afterEach(async () => {
  await running?.close();
  running = null;
});

/** A fake control plane that records what it was sent. */
function upstream(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return handler(String(url), init ?? {});
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

/**
 * A real Client over the fake network. The interceptor takes a CLIENT, never a
 * url or a token — the SDK owns the route and the bearer, which is what these
 * assertions are really checking.
 */
async function clientWith(fetchImpl: typeof fetch, token = "tok-123") {
  const store = new InMemoryTokenStore();
  // Well clear of the refresh margin: an expiry sitting on it would send the
  // client off to refresh through the fake network mid-test.
  await store.save({ accessToken: token, refreshToken: "r", expiresAt: Date.now() + 3_600_000 });
  return createClient({ url: "https://api.example.com", fetch: fetchImpl, tokenStore: store });
}

const jsonReply = () =>
  new Response(JSON.stringify({ type: "message", content: [{ type: "text", text: "hi" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("interceptor", () => {
  it("forwards to the control plane with the caller's bearer", async () => {
    const up = upstream(() => jsonReply());
    running = await startInterceptor({ client: await clientWith(up.fetch) });

    const res = await fetch(`${running.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": running.apiKey },
      body: JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);

    expect(up.calls).toHaveLength(1);
    expect(up.calls[0]!.url).toBe("https://api.example.com/api/gateway/v1/messages");
    const headers = up.calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok-123");
    // The body is relayed untouched — this is a relay, not a translator.
    expect(JSON.parse(String(up.calls[0]!.init.body))).toEqual({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("refuses a local caller without the process key", async () => {
    const up = upstream(() => jsonReply());
    running = await startInterceptor({ client: await clientWith(up.fetch, "t") });

    // Loopback is reachable by anything on the machine; the key is the gate.
    const res = await fetch(`${running.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(up.calls).toHaveLength(0);
  });

  it("accepts the key as a bearer as well as x-api-key", async () => {
    const up = upstream(() => jsonReply());
    running = await startInterceptor({ client: await clientWith(up.fetch, "t") });

    const res = await fetch(`${running.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${running.apiKey}` },
      body: "{}",
    });
    expect(res.status).toBe(200);
  });

  it("streams SSE frames through as they arrive", async () => {
    const frames = [
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const up = upstream(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const enc = new TextEncoder();
              for (const f of frames) controller.enqueue(enc.encode(f));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );
    running = await startInterceptor({ client: await clientWith(up.fetch, "t") });

    const res = await fetch(`${running.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": running.apiKey },
      body: JSON.stringify({ stream: true }),
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toBe(frames.join(""));
  });

  /** An SSE upstream whose bytes are exactly `chunks` (to force boundary cases). */
  function sseChunks(chunks: string[]) {
    return upstream(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const enc = new TextEncoder();
              for (const c of chunks) controller.enqueue(enc.encode(c));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );
  }

  it("strips the trailing glyphh_usage frame and reports it via onUsage", async () => {
    const anthropic =
      'event: message_start\ndata: {"type":"message_start"}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const usage = 'event: glyphh_usage\ndata: {"usd":0.0042,"inputTokens":1500,"outputTokens":300}\n\n';
    const onUsage = vi.fn();
    const up = sseChunks([anthropic + usage]);
    running = await startInterceptor({ client: await clientWith(up.fetch, "t"), onUsage });

    const res = await fetch(`${running.url}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": running.apiKey },
      body: JSON.stringify({ stream: true }),
    });
    const seen = await res.text();
    // The SDK sees ONLY Anthropic events — an unknown frame in the stream could
    // break its parser.
    expect(seen).toBe(anthropic);
    expect(seen).not.toContain("glyphh_usage");
    expect(onUsage).toHaveBeenCalledWith({ usd: 0.0042, inputTokens: 1500, outputTokens: 300 }, undefined);
  });

  it("attributes usage to the run named in the x-glyphh-run header", async () => {
    // Concurrent runs share one interceptor — each subprocess tags its own
    // requests, and the usage callback carries that tag back.
    const anthropic = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const usage = 'event: glyphh_usage\ndata: {"usd":0.09,"inputTokens":4,"outputTokens":2}\n\n';
    const onUsage = vi.fn();
    const up = sseChunks([anthropic + usage]);
    running = await startInterceptor({ client: await clientWith(up.fetch, "t"), onUsage });

    await (await fetch(`${running.url}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": running.apiKey, "x-glyphh-run": "run-abc12" },
      body: JSON.stringify({ stream: true }),
    })).text();
    expect(onUsage).toHaveBeenCalledWith({ usd: 0.09, inputTokens: 4, outputTokens: 2 }, "run-abc12");
  });

  it("strips the frame even when its marker is split across chunks", async () => {
    // The frame lands as the stream's tail, and the marker itself can straddle a
    // chunk boundary — the carry buffer has to catch that.
    const onUsage = vi.fn();
    const up = sseChunks([
      'event: message_stop\ndata: {"type":"message_stop"}\n\nevent: gly',
      'phh_usage\ndata: {"usd":0.07,"inputTokens":2,"outputTokens":1}\n\n',
    ]);
    running = await startInterceptor({ client: await clientWith(up.fetch, "t"), onUsage });

    const res = await fetch(`${running.url}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": running.apiKey },
      body: JSON.stringify({ stream: true }),
    });
    const seen = await res.text();
    expect(seen).toBe('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    expect(seen).not.toContain("glyphh_usage");
    expect(seen).not.toContain("event: gly");   // the split half must not leak either
    expect(onUsage).toHaveBeenCalledWith({ usd: 0.07, inputTokens: 2, outputTokens: 1 }, undefined);
  });

  it("forwards a stream with no usage frame unchanged", async () => {
    const onUsage = vi.fn();
    const anthropic = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const up = sseChunks([anthropic]);
    running = await startInterceptor({ client: await clientWith(up.fetch, "t"), onUsage });

    const res = await fetch(`${running.url}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": running.apiKey },
      body: JSON.stringify({ stream: true }),
    });
    expect(await res.text()).toBe(anthropic);
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("relays an upstream status instead of reinterpreting it", async () => {
    // The Agent SDK reads 429/529 to decide whether to retry — flattening these
    // into a generic failure would break behaviour that already works.
    const up = upstream(
      () =>
        new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
    );
    running = await startInterceptor({ client: await clientWith(up.fetch, "t") });

    const res = await fetch(`${running.url}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": running.apiKey },
      body: "{}",
    });
    expect(res.status).toBe(429);
    expect((await res.json()).error.type).toBe("rate_limit_error");
  });

  it("passes anthropic version and beta headers through", async () => {
    const up = upstream(() => jsonReply());
    running = await startInterceptor({ client: await clientWith(up.fetch, "t") });

    await fetch(`${running.url}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": running.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "tools-2024-04-04",
      },
      body: "{}",
    });
    const headers = up.calls[0]!.init.headers as Record<string, string>;
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["anthropic-beta"]).toBe("tools-2024-04-04");
  });

  it("resolves the bearer per request rather than capturing one at start", async () => {
    const up = upstream(() => jsonReply());
    running = await startInterceptor({ client: await clientWith(up.fetch, "tok-1") });

    for (let i = 0; i < 2; i++) {
      await fetch(`${running.url}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": running.apiKey },
        body: "{}",
      });
    }
    // Each forward asks the client for a token, so refresh/rotation upstream is
    // picked up mid-run instead of a long agent run pinning a stale one.
    expect(up.calls).toHaveLength(2);
    for (const call of up.calls) {
      expect((call.init.headers as Record<string, string>).authorization).toBe("Bearer tok-1");
    }
  });

  it("404s a route that is not messages", async () => {
    const up = upstream(() => jsonReply());
    running = await startInterceptor({ client: await clientWith(up.fetch, "t") });

    const res = await fetch(`${running.url}/v1/complete`, {
      method: "POST",
      headers: { "x-api-key": running.apiKey },
      body: "{}",
    });
    expect(res.status).toBe(404);
    expect(up.calls).toHaveLength(0);
  });

  it("reports a transport failure as an api_error without crashing", async () => {
    const onError = vi.fn();
    const up = upstream(() => { throw new Error("network down"); });
    running = await startInterceptor({ client: await clientWith(up.fetch, "t"), onError });

    const res = await fetch(`${running.url}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": running.apiKey },
      body: "{}",
    });
    expect(res.status).toBe(502);
    expect((await res.json()).error.type).toBe("api_error");
    expect(onError).toHaveBeenCalled();
  });

  it("binds loopback only", async () => {
    const up = upstream(() => jsonReply());
    running = await startInterceptor({ client: await clientWith(up.fetch, "t") });
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});
