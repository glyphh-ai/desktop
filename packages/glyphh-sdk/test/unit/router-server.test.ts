/**
 * router-server.test.ts — the router on loopback for the CLIs: only the
 * per-process token gets in, only the Messages edge is served, a turn streams
 * through the router's fetch byte for byte, and count_tokens answers a rough
 * count without calling a provider.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { presented, roughTokens, startRouterServer, tokenMatches, type FetchLike, type RouterServer } from "../../src/router/index.js";

const seen: Array<{ url: string; body: string }> = [];
const route: FetchLike = async (url, init) => {
  seen.push({ url, body: String(init.body) });
  if (String(init.body).includes("boom")) throw new Error("upstream down");
  return new Response("event: message_stop\ndata: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
};
let srv: RouterServer;
beforeAll(async () => { srv = await startRouterServer(route); });
afterAll(async () => { await srv.close(); });

const post = (path: string, body: string, key?: string): Promise<Response> =>
  fetch(`${srv.url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) }, body });

describe("the loopback router", () => {
  it("listens on 127.0.0.1 with a long per-process token", () => {
    expect(srv.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(srv.token).toMatch(/^glyphh-router-[0-9a-f]{48}$/);
  });

  it("refuses a request without the token, or with the wrong one", async () => {
    expect((await post("/v1/messages", "{}")).status).toBe(401);
    expect((await post("/v1/messages", "{}", "nope")).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("streams a Messages call through the router's fetch, with the token as x-api-key or a bearer", async () => {
    const res = await post("/v1/messages", '{"model":"anthropic::claude-opus-5-5"}', srv.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toContain("message_stop");
    expect(seen.at(-1)).toEqual({ url: "http://glyphh-router.local/v1/messages", body: '{"model":"anthropic::claude-opus-5-5"}' });
    const bearer = await fetch(`${srv.url}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${srv.token}` }, body: "{}" });
    expect(bearer.status).toBe(200);
  });

  it("answers count_tokens itself and refuses anything else", async () => {
    const res = await post("/v1/messages/count_tokens", "x".repeat(40), srv.token);
    expect(await res.json()).toEqual({ input_tokens: 10 });
    const other = await fetch(`${srv.url}/v1/models`, { headers: { "x-api-key": srv.token } });
    expect(other.status).toBe(404);
  });

  it("says the router failed when its fetch throws", async () => {
    const res = await post("/v1/messages", '{"boom":1}', srv.token);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe("upstream down");
  });

  it("compares tokens in constant time and reads either header", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abd", "abc")).toBe(false);
    expect(tokenMatches("ab", "abc")).toBe(false);
    expect(tokenMatches(undefined, "abc")).toBe(false);
    expect(presented({ headers: { "x-api-key": "k" } })).toBe("k");
    expect(presented({ headers: { authorization: "Bearer t" } })).toBe("t");
    expect(presented({ headers: {} })).toBeUndefined();
    expect(roughTokens("12345678")).toBe(2);
  });
});
