import http from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { BridgeServer, type BridgeUsage } from "../../../src/main/bridge/server.js";
import type { SpawnOptions } from "../../../src/main/bridge/claude-session.js";
import type { RoutingRow } from "../../../src/main/bridge/routing.js";

/** A stand-in for the `claude` process: we read what the bridge writes to stdin and script stdout. */
class FakeClaude extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  written: string[] = [];
  killed = false;
  constructor(readonly opts: SpawnOptions) {
    super();
    this.stdin.on("data", (b: Buffer) => { for (const line of b.toString("utf-8").split("\n")) if (line.trim()) this.written.push(line); this.emit("line"); });
  }
  say(ev: Record<string, unknown>): void { this.stdout.write(JSON.stringify(ev) + "\n"); }
  kill(): boolean { this.killed = true; this.emit("exit", null); return true; }
  async nextLine(): Promise<Record<string, unknown>> {
    if (this.written.length) return JSON.parse(this.written.shift()!) as Record<string, unknown>;
    await new Promise((r) => this.once("line", r));
    return JSON.parse(this.written.shift()!) as Record<string, unknown>;
  }
}

const pkce = () => { const v = randomBytes(32).toString("base64url"); return { v, c: createHash("sha256").update(v).digest("base64url") }; };
const listen = (s: http.Server): Promise<number> => new Promise((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));
const free = async (): Promise<number> => { const s = http.createServer(); const p = await listen(s); await new Promise((r) => s.close(r)); return p; };

describe("BridgeServer", () => {
  let bridge: BridgeServer;
  let upstream: http.Server;
  let upstreamHits: Array<{ path: string; auth: string; body: Record<string, unknown> }>;
  let spawned: FakeClaude[];
  let usage: BridgeUsage[];
  let rows: RoutingRow[];
  let member: { userId: string; email: string; name: string | null; orgSlug: string | null } | null;
  let gatewayOn = true;
  let base = "";
  let port = 0;

  beforeEach(async () => {
    upstreamHits = []; spawned = []; usage = []; member = { userId: "u-1", email: "ada@acme.co", name: "Ada", orgSlug: "acme" }; gatewayOn = true;
    rows = [{ model: "claude-*", lane: "account", permission: "read-only" }, { model: "*", lane: "gateway", target: "router/default" }];
    upstream = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => { raw += c.toString("utf-8"); });
      req.on("end", () => {
        upstreamHits.push({ path: req.url || "", auth: String(req.headers.authorization ?? ""), body: JSON.parse(raw || "{}") });
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
        res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      });
    });
    const up = await listen(upstream);
    port = await free();
    bridge = new BridgeServer({
      port,
      member: () => member,
      gateway: async () => (gatewayOn ? { baseUrl: `http://127.0.0.1:${up}/v1`, token: "gw-key" } : null),
      routing: async () => rows,
      forward: async () => null,
      spawnClaude: (opts) => { const f = new FakeClaude(opts); spawned.push(f); return f as unknown as ChildProcessWithoutNullStreams; },
      reportUsage: async (u) => { usage.push(u); },
    });
    await bridge.start();
    base = bridge.url();
  });
  afterEach(async () => { bridge.stop(); await new Promise((r) => upstream.close(r)); });

  const signIn = async (): Promise<string> => {
    const reg = await (await fetch(`${base}/oauth/register`, { method: "POST", body: JSON.stringify({ client_name: "Claude Desktop", redirect_uris: ["http://127.0.0.1:9/cb"] }) })).json() as { client_id: string };
    const { v, c } = pkce();
    const q = new URLSearchParams({ client_id: reg.client_id, redirect_uri: "http://127.0.0.1:9/cb", state: "s", code_challenge: c, code_challenge_method: "S256", scope: "openid glyphh-gateway offline_access", response_type: "code" });
    const page = await (await fetch(`${base}/oauth/authorize?${q}`)).text();
    expect(page).toContain("Connect Claude Desktop to Glyphh?");
    expect(page).toContain("ada@acme.co");
    const decide = await fetch(`${base}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...Object.fromEntries(q), decision: "allow" }) });
    expect(decide.status).toBe(302);
    const back = new URL(decide.headers.get("location")!);
    const tok = await (await fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code")!, client_id: reg.client_id, redirect_uri: "http://127.0.0.1:9/cb", code_verifier: v }) })).json() as { access_token: string };
    expect(tok.access_token).toBeTruthy();
    return tok.access_token;
  };

  it("serves discovery under its own URL and refuses turns without its token", async () => {
    const d = await (await fetch(`${base}/.well-known/openid-configuration`)).json() as Record<string, string>;
    expect(d.issuer).toBe(base);
    expect(d.authorization_endpoint).toBe(`${base}/oauth/authorize`);
    const r = await fetch(`${base}/v1/messages`, { method: "POST", body: JSON.stringify({ model: "x", messages: [] }) });
    expect(r.status).toBe(401);
  });

  it("tells a signed-out machine to sign in to Glyphh first", async () => {
    member = null;
    const { c } = pkce();
    const page = await (await fetch(`${base}/oauth/authorize?client_id=claude-desktop&redirect_uri=http%3A%2F%2F127.0.0.1%3A9%2Fcb&state=s&code_challenge=${c}`)).text();
    expect(page).toContain("Sign in to Glyphh first");
  });

  it("gateway lane: forwards with the member's gateway key and the row's target model", async () => {
    const token = await signIn();
    const r = await fetch(`${base}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: "gpt-oss-120b", stream: true, messages: [{ role: "user", content: "hi" }] }) });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("message_stop");
    expect(upstreamHits).toHaveLength(1);
    expect(upstreamHits[0].path).toBe("/v1/messages");
    expect(upstreamHits[0].auth).toBe("Bearer gw-key");
    expect(upstreamHits[0].body.model).toBe("router/default");
    expect(spawned).toHaveLength(0);
  });

  it("gateway lane: an org with the lane off gets a clear refusal, not a hang", async () => {
    const token = await signIn();
    gatewayOn = false;
    const r = await fetch(`${base}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ model: "gpt-oss-120b", messages: [{ role: "user", content: "hi" }] }) });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { message: string } }).error.message).toContain("gateway lane is off");
  });

  it("account lane: a headless claude session answers, streams as Messages SSE, continues, and reports usage", async () => {
    const token = await signIn();
    const turn1 = fetch(`${base}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ model: "claude-opus-5", stream: true, system: "be brief", messages: [{ role: "user", content: "hello" }] }) });
    while (!spawned.length) await new Promise((r) => setTimeout(r, 5));
    const cli = spawned[0];
    expect(cli.opts).toMatchObject({ permission: "read-only", model: "claude-opus-5", appendSystem: "be brief", resume: null });
    const first = await cli.nextLine();
    expect(first).toEqual({ type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] } });
    cli.say({ type: "system", subtype: "init", session_id: "sess-1" });
    cli.say({ type: "stream_event", event: { type: "message_start" } });
    cli.say({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
    cli.say({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi there." } } });
    cli.say({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
    cli.say({ type: "result", subtype: "success", usage: { input_tokens: 10, output_tokens: 3 } });
    const r1 = await turn1;
    expect(r1.headers.get("content-type")).toBe("text/event-stream");
    const sse = await r1.text();
    expect(sse).toContain('"text":"Hi there."');
    expect(sse).toContain('"stop_reason":"end_turn"');
    expect(sse).toContain("event: message_stop");
    expect(usage).toEqual([expect.objectContaining({ model: "claude-opus-5", inputTokens: 10, outputTokens: 3, cacheReadTokens: 0 })]);

    // the next turn of the same conversation rides the same session, no new spawn
    const turn2 = fetch(`${base}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ model: "claude-opus-5", messages: [{ role: "user", content: "hello" }, { role: "assistant", content: [{ type: "text", text: "Hi there." }] }, { role: "user", content: "and now?" }] }) });
    const second = await cli.nextLine();
    expect(second).toMatchObject({ type: "user", message: { content: [{ type: "text", text: "and now?" }] } });
    cli.say({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "Now this." } } });
    cli.say({ type: "result", subtype: "success", usage: { input_tokens: 20, output_tokens: 2 } });
    const r2 = await turn2;
    const msg = await r2.json() as { content: Array<{ text: string }>; usage: { input_tokens: number } };
    expect(msg.content[0].text).toBe("Now this.");
    expect(msg.usage.input_tokens).toBe(20);
    expect(spawned).toHaveLength(1);
  });

  it("account lane: a permission ask ends the turn as a question and the next message answers it", async () => {
    const token = await signIn();
    const turn = fetch(`${base}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "clean the build" }] }) });
    while (!spawned.length) await new Promise((r) => setTimeout(r, 5));
    const cli = spawned[0];
    await cli.nextLine();
    cli.say({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "Sure, " } } });
    cli.say({ type: "control_request", request_id: "req-1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "rm -rf build" } } });
    const msg = await (await turn).json() as { content: Array<{ text: string }> };
    const ask = "Claude Code wants to run `Bash`: rm -rf build.\nReply **allow**, **deny**, or **always** (allow for the rest of this conversation).";
    expect(msg.content.map((c) => c.text)).toEqual(["Sure, ", ask]);
    expect(cli.written).toHaveLength(0);

    const answer = fetch(`${base}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ model: "claude-sonnet-5", messages: [
      { role: "user", content: "clean the build" }, { role: "assistant", content: [{ type: "text", text: "Sure, " }, { type: "text", text: ask }] }, { role: "user", content: "allow" },
    ] }) });
    const ctl = await cli.nextLine();
    expect(ctl).toEqual({ type: "control_response", response: { subtype: "success", request_id: "req-1", response: { behavior: "allow" } } });
    cli.say({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "Removed build." } } });
    cli.say({ type: "result", subtype: "success", usage: { input_tokens: 30, output_tokens: 4 } });
    const done = await (await answer).json() as { content: Array<{ text: string }> };
    expect(done.content[0].text).toBe("Removed build.");
    expect(spawned).toHaveLength(1);
  });

  it("account lane: a reply that is not an answer denies the tool and runs as the next prompt", async () => {
    const token = await signIn();
    const turn = fetch(`${base}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "clean the build" }] }) });
    while (!spawned.length) await new Promise((r) => setTimeout(r, 5));
    const cli = spawned[0];
    await cli.nextLine();
    cli.say({ type: "control_request", request_id: "req-9", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "rm -rf build" } } });
    const msg = await (await turn).json() as { content: Array<{ text: string }> };
    const ask = msg.content[0].text;
    const next = fetch(`${base}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ model: "claude-sonnet-5", messages: [
      { role: "user", content: "clean the build" }, { role: "assistant", content: ask }, { role: "user", content: "just list it instead" },
    ] }) });
    const deny = await cli.nextLine();
    expect(deny).toMatchObject({ type: "control_response", response: { request_id: "req-9", response: { behavior: "deny" } } });
    cli.say({ type: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 1 } });
    const prompt = await cli.nextLine();
    expect(prompt).toMatchObject({ type: "user", message: { content: [{ type: "text", text: "just list it instead" }] } });
    cli.say({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "build/, dist/" } } });
    cli.say({ type: "result", subtype: "success", usage: { input_tokens: 5, output_tokens: 2 } });
    const done = await (await next).json() as { content: Array<{ text: string }> };
    expect(done.content[0].text).toBe("build/, dist/");
  });

  it("sign-out revokes the client's token and kills every session", async () => {
    const token = await signIn();
    const turn = fetch(`${base}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "x" }] }) });
    while (!spawned.length) await new Promise((r) => setTimeout(r, 5));
    spawned[0].say({ type: "result", subtype: "success" });
    await turn;
    await new Promise((r) => setTimeout(r, 1100));
    bridge.revokeAll();
    expect(spawned[0].killed).toBe(true);
    const r = await fetch(`${base}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ model: "x", messages: [] }) });
    expect(r.status).toBe(401);
  });
});
