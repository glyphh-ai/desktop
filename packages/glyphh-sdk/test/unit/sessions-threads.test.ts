/**
 * SessionsClient threads over a mocked fetch — the harness thread routes
 * (/api/harness/threads), the `{ data }` envelope, the transcript URL, the
 * append-messages verdict (a 409 stale answer is applied:false, not a throw),
 * and a `{ error, detail }` 404 as NotFoundError.
 */

import { describe, it, expect } from "vitest";
import { HttpClient, type FetchLike } from "../../src/core/http.js";
import { AuthedHttp } from "../../src/core/authed-http.js";
import { NotFoundError } from "../../src/core/errors.js";
import { SessionsClient } from "../../src/resources/sessions.js";
import type { SessionThread, SessionThreadMeta } from "../../src/contract/threads.js";

interface Seen { method: string; url: string; body: unknown }

function harness(answer: (seen: Seen) => Response) {
  const calls: Seen[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const seen: Seen = { method: init?.method ?? "GET", url: String(url), body: typeof init?.body === "string" ? JSON.parse(init.body) : null };
    calls.push(seen);
    return answer(seen);
  };
  const http = new AuthedHttp(new HttpClient({ baseUrl: "http://x", fetchImpl }), async () => "tok");
  return { calls, client: new SessionsClient(http) };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const meta: SessionThreadMeta = { id: "c1", title: "t", mode: "chat", source: null, createdAt: 1, updatedAt: 10, messageCount: 2 };
const thread: SessionThread = { ...meta, messages: [{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }], transcriptUrl: "https://r2/c1.ndjson" };

describe("SessionsClient threads", () => {
  it("threads() lists metadata from /api/harness/threads", async () => {
    const { calls, client } = harness(() => json(200, { data: [meta] }));
    expect(await client.threads()).toEqual([meta]);
    expect(calls).toEqual([{ method: "GET", url: "http://x/api/harness/threads", body: null }]);
  });

  it("thread() reads one with its preview and transcriptUrl", async () => {
    const { calls, client } = harness(() => json(200, { data: thread }));
    expect(await client.thread("c1")).toEqual(thread);
    expect(calls[0]).toEqual({ method: "GET", url: "http://x/api/harness/threads/c1", body: null });
  });

  it("thread() maps a { error, detail } 404 to NotFoundError", async () => {
    const { client } = harness(() => json(404, { error: "not-found", detail: "no thread c9" }));
    const err = await client.thread("c9").catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.message).toBe("no thread c9");
  });

  it("transcriptUrl() GETs …/transcript and returns { url }", async () => {
    const { calls, client } = harness(() => json(200, { data: { url: "https://r2/c1.ndjson?sig" } }));
    expect(await client.transcriptUrl("c1")).toEqual({ url: "https://r2/c1.ndjson?sig" });
    expect(calls[0]).toEqual({ method: "GET", url: "http://x/api/harness/threads/c1/transcript", body: null });
  });

  it("appendMessages() POSTs …/messages with { messages, updatedAt } and returns the verdict", async () => {
    const { calls, client } = harness(() => json(200, { data: { applied: true, thread: { ...meta, updatedAt: 11, messageCount: 3 } } }));
    const body = { messages: [{ role: "user", text: "more", at: 11 }], updatedAt: 11 };
    const out = await client.appendMessages("c1", body);
    expect(out).toEqual({ applied: true, thread: { ...meta, updatedAt: 11, messageCount: 3 } });
    expect(calls).toEqual([{ method: "POST", url: "http://x/api/harness/threads/c1/messages", body }]);
  });

  it("appendMessages() on a stale clock answers applied:false with the stored thread", async () => {
    const { client } = harness(() => json(200, { data: { applied: false, thread: meta } }));
    expect(await client.appendMessages("c1", { messages: [{ role: "user" }], updatedAt: 5 })).toEqual({ applied: false, thread: meta });
  });

  it("pushThread() PUTs and deleteThread() DELETEs the harness thread path", async () => {
    const { calls, client } = harness((seen) => (seen.method === "DELETE" ? new Response(null, { status: 204 }) : json(200, { data: { applied: true, thread: meta } })));
    await client.pushThread("c1", { title: "t", updatedAt: 10 });
    expect(await client.deleteThread("c1")).toBeUndefined();
    expect(calls).toEqual([
      { method: "PUT", url: "http://x/api/harness/threads/c1", body: { title: "t", updatedAt: 10 } },
      { method: "DELETE", url: "http://x/api/harness/threads/c1", body: null },
    ]);
  });
});
