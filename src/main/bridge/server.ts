/**
 * server.ts — the Bridge Mode listener (BRIDGE-MODE.md §3): one loopback HTTP
 * server Claude Desktop is pointed at. It is the local OpenID provider (§2),
 * the Messages API front the turns arrive on, and the switch between the two
 * lanes (§5, §6). Everything it depends on is injected, so it knows nothing
 * about Electron: who the member is, how to reach the gateway, the routing
 * table, how to spawn `claude`, where to report usage.
 */

import http from "node:http";
import { LocalIssuer, type Member } from "./oidc-local.js";
import { decide, type RoutingRow } from "./routing.js";
import type { SpawnClaude } from "./claude-session.js";
import { sseText } from "./sse-adapter.js";
import { turnsOf, type Turn } from "./conversation.js";
import { AccountLane, type BridgeUsage } from "./account-lane.js";

export interface GatewayCreds { baseUrl: string; token: string }

export type { BridgeUsage } from "./account-lane.js";

export interface BridgeDeps {
  port: number;
  /** The signed-in Glyphh member, or null when nobody is. */
  member: () => Member | null;
  /** The member's gateway credential; null when the org's lane is off or nobody is signed in. */
  gateway: () => Promise<GatewayCreds | null>;
  routing: () => Promise<RoutingRow[]>;
  /** The memory bridge's wrap of an upstream base URL, or null to go direct. */
  forward: (upstream: string) => Promise<string | null>;
  spawnClaude: SpawnClaude;
  reportUsage: (usage: BridgeUsage) => Promise<void>;
  onActivity?: (line: string) => void;
  now?: () => number;
  /** A shared account lane (the relay's bridge.turn rides the same one); built here when absent. */
  lane?: AccountLane;
}

export interface BridgeStatus { running: boolean; port: number; url: string; member: string | null; sessions: number; clients: number }

const BODY_CAP = 10_000_000;
const FORWARD_IDLE_MS = 180_000;
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

export class BridgeServer {
  private server: http.Server | null = null;
  readonly issuer: LocalIssuer;
  readonly lane: AccountLane;
  private registered = 0;
  private readonly now: () => number;
  private readonly activity: (line: string) => void;

  constructor(private readonly deps: BridgeDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.activity = deps.onActivity ?? (() => undefined);
    this.issuer = new LocalIssuer(() => this.url(), this.now);
    this.lane = deps.lane ?? new AccountLane({ spawnClaude: deps.spawnClaude, reportUsage: deps.reportUsage, onActivity: this.activity, now: this.now });
  }

  url(): string { return `http://127.0.0.1:${this.deps.port}`; }

  status(): BridgeStatus {
    return { running: !!this.server, port: this.deps.port, url: this.url(), member: this.deps.member()?.email ?? null, sessions: this.lane.sessionCount(), clients: this.registered };
  }

  start(): Promise<number> {
    if (this.server) return Promise.resolve(this.deps.port);
    return new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => { void this.handle(req, res).catch((err) => this.fail(res, 500, "api_error", err instanceof Error ? err.message : String(err))); });
      s.on("error", (err) => { this.server = null; reject(err); });
      s.listen(this.deps.port, "127.0.0.1", () => {
        this.server = s;
        this.activity(`bridge listening on ${this.url()}`);
        resolve(this.deps.port);
      });
    });
  }

  stop(): void {
    if (!this.deps.lane) this.lane.stop();
    try { this.server?.close(); } catch { /* closing */ }
    this.server = null;
  }

  /** Sign-out: Claude Desktop's tokens die, every CLI session goes. */
  revokeAll(): void {
    this.issuer.revokeAll();
    this.lane.killAll();
    this.activity("signed out: every client token and session revoked");
  }

  // ── plumbing ──────────────────────────────────────────────────────────────

  private json(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extra });
    res.end(JSON.stringify(body));
  }

  private fail(res: http.ServerResponse, status: number, type: string, message: string): void {
    if (res.headersSent) { try { res.end(); } catch { /* gone */ } return; }
    this.json(res, status, { type: "error", error: { type, message } });
  }

  private html(res: http.ServerResponse, status: number, body: string): void {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Glyphh bridge</title><style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;background:#0b0b0d;color:#e9e9ee;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:420px;padding:32px;border:1px solid #2a2a30;border-radius:12px;background:#121216}h1{font-size:18px;margin:0 0 8px}p{color:#a8a8b3;margin:6px 0}button{font:inherit;padding:10px 18px;border-radius:8px;border:1px solid #3a3a42;background:#1c1c22;color:#fff;cursor:pointer;margin-right:8px}button.primary{background:#fff;color:#000;border-color:#fff}form{margin-top:18px}code{color:#fff}</style></head><body><main>${body}</main></body></html>`);
  }

  private readBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => { size += c.length; if (size > BODY_CAP) { reject(new Error("body too large")); req.destroy(); return; } chunks.push(c); });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  private bearer(req: http.IncomingMessage): string {
    const h = String(req.headers.authorization ?? "");
    return h.startsWith("Bearer ") ? h.slice(7) : String(req.headers["x-api-key"] ?? "");
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", this.url());
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method || "GET";
    const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": "content-type" };
    if (method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }

    if (path === "/.well-known/openid-configuration" && method === "GET") return this.json(res, 200, this.issuer.discovery(), cors);
    if (path === "/health" && method === "GET") return this.json(res, 200, this.status(), cors);
    if (path === "/oauth/jwks" && method === "GET") return this.json(res, 200, this.issuer.jwks());
    if (path === "/oauth/register" && method === "POST") {
      let body: unknown = {};
      try { body = JSON.parse((await this.readBody(req)).toString("utf-8") || "{}"); } catch { return this.json(res, 400, { error: "invalid_client_metadata" }); }
      this.registered++;
      return this.json(res, 201, this.issuer.register(body));
    }
    if (path === "/oauth/authorize" && method === "GET") return this.authorizePage(url, res);
    if (path === "/oauth/authorize" && method === "POST") return this.authorizeDecide(req, res);
    if (path === "/oauth/token" && method === "POST") {
      const raw = (await this.readBody(req)).toString("utf-8");
      const form = Object.fromEntries(new URLSearchParams(raw));
      const out = this.issuer.token(form);
      if ("error" in out) return this.json(res, 400, { error: out.error, error_description: out.description });
      return this.json(res, 200, out);
    }
    if (path === "/oauth/userinfo" && method === "GET") {
      const info = this.issuer.userinfo(this.bearer(req));
      return info ? this.json(res, 200, info) : this.json(res, 401, { error: "invalid_token" });
    }
    if (path === "/v1/models" && method === "GET") {
      if (!this.issuer.verifyAccess(this.bearer(req))) return this.fail(res, 401, "authentication_error", "sign in to the Glyphh bridge");
      const rows = await this.deps.routing();
      const names = [...new Set(rows.map((r) => r.model).filter((m) => m && !m.includes("*")))];
      return this.json(res, 200, { data: names.map((id) => ({ id, type: "model", display_name: id, created_at: "2026-01-01T00:00:00Z" })), has_more: false });
    }
    if (path === "/v1/messages" && method === "POST") return this.messages(req, res);
    return this.fail(res, 404, "not_found_error", `no route for ${method} ${path}`);
  }

  // ── the local issuer's one page: consent ─────────────────────────────────

  private authorizePage(url: URL, res: http.ServerResponse): void {
    const q = Object.fromEntries(url.searchParams) as Record<string, string>;
    const check = this.issuer.checkAuthorize({ client_id: q.client_id ?? "", redirect_uri: q.redirect_uri ?? "", state: q.state ?? "", code_challenge: q.code_challenge ?? "", code_challenge_method: q.code_challenge_method, scope: q.scope, nonce: q.nonce, response_type: q.response_type });
    if (!check.ok) return this.json(res, 400, { error: check.error, error_description: check.description });
    const member = this.deps.member();
    if (!member) {
      return this.html(res, 200, `<h1>Sign in to Glyphh first</h1><p>The bridge signs Claude Desktop in as the member signed in to the Glyphh app on this machine, and nobody is.</p><p>Open Glyphh, sign in, then come back to Claude Desktop and connect again.</p>`);
    }
    const fields = Object.entries(q).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
    this.html(res, 200, `<h1>Connect ${esc(this.issuer.clientName(q.client_id ?? ""))} to Glyphh?</h1><p>It will run as <code>${esc(member.email)}</code>${member.orgSlug ? ` in <code>${esc(member.orgSlug)}</code>` : ""}, through the Glyphh bridge on this machine. Your organization decides which model goes where.</p><form method="post" action="/oauth/authorize">${fields}<button class="primary" name="decision" value="allow">Allow</button><button name="decision" value="deny">Deny</button></form>`);
  }

  private async authorizeDecide(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const form = Object.fromEntries(new URLSearchParams((await this.readBody(req)).toString("utf-8"))) as Record<string, string>;
    const q = { client_id: form.client_id ?? "", redirect_uri: form.redirect_uri ?? "", state: form.state ?? "", code_challenge: form.code_challenge ?? "", code_challenge_method: form.code_challenge_method, scope: form.scope, nonce: form.nonce, response_type: form.response_type };
    const check = this.issuer.checkAuthorize(q);
    if (!check.ok) return this.json(res, 400, { error: check.error, error_description: check.description });
    const member = this.deps.member();
    if (!member) return this.html(res, 200, `<h1>Sign in to Glyphh first</h1><p>Nobody is signed in to the Glyphh app on this machine.</p>`);
    if (form.decision !== "allow") {
      const sep = q.redirect_uri.includes("?") ? "&" : "?";
      res.writeHead(302, { location: `${q.redirect_uri}${sep}error=access_denied&state=${encodeURIComponent(q.state)}`, "cache-control": "no-store" });
      res.end();
      return;
    }
    this.activity(`${this.issuer.clientName(q.client_id)} connected as ${member.email}`);
    res.writeHead(302, { location: this.issuer.issueCode(q, check.scope, member), "cache-control": "no-store" });
    res.end();
  }

  // ── the turn ──────────────────────────────────────────────────────────────

  private async messages(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const claims = this.issuer.verifyAccess(this.bearer(req));
    if (!claims) return this.fail(res, 401, "authentication_error", "sign in to the Glyphh bridge");
    const member = this.deps.member();
    if (!member || member.userId !== claims.sub) return this.fail(res, 401, "authentication_error", "the Glyphh member changed; sign in again");
    let body: Record<string, unknown>;
    try { body = JSON.parse((await this.readBody(req)).toString("utf-8")) as Record<string, unknown>; } catch { return this.fail(res, 400, "invalid_request_error", "the body is not JSON"); }
    const model = String(body.model ?? "");
    if (!model) return this.fail(res, 400, "invalid_request_error", "model is required");
    const decision = decide(await this.deps.routing(), model);
    if (decision.lane === "gateway") return this.gatewayLane(req, res, body, decision.model);
    return this.accountLane(res, body, model, decision);
  }

  private async gatewayLane(req: http.IncomingMessage, res: http.ServerResponse, body: Record<string, unknown>, model: string): Promise<void> {
    const creds = await this.deps.gateway();
    if (!creds) return this.fail(res, 403, "permission_error", "your organization's gateway lane is off; ask an org admin, or route this model to the account lane");
    const base = creds.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
    const via = (await this.deps.forward(base)) ?? base;
    const target = new URL(`${via}/v1/messages`);
    if (body.model !== model) body.model = model;
    const payload = Buffer.from(JSON.stringify(body), "utf-8");
    const headers: Record<string, string> = { host: target.host, "content-type": "application/json", "content-length": String(payload.length), authorization: `Bearer ${creds.token}` };
    for (const k of ["anthropic-version", "anthropic-beta", "accept", "user-agent"]) { const v = req.headers[k]; if (typeof v === "string") headers[k] = v; }
    this.activity(`gateway lane → ${model}`);
    const mod = target.protocol === "https:" ? await import("node:https") : await import("node:http");
    const pr = mod.request({ protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, method: "POST", path: target.pathname + target.search, headers }, (pres) => {
      res.writeHead(pres.statusCode || 502, pres.headers);
      pres.on("data", (c: Buffer) => res.write(c));
      pres.on("end", () => res.end());
      pres.on("error", () => { try { res.end(); } catch { /* gone */ } });
    });
    pr.on("error", (err) => this.fail(res, 502, "api_error", `gateway unreachable: ${err instanceof Error ? err.message : String(err)}`));
    pr.setTimeout(FORWARD_IDLE_MS, () => { this.fail(res, 504, "api_error", "the gateway did not answer in time"); pr.destroy(); });
    pr.end(payload);
  }

  private async accountLane(res: http.ServerResponse, body: Record<string, unknown>, model: string, decision: ReturnType<typeof decide>): Promise<void> {
    const turns = turnsOf(body.messages);
    if (!turns.length || turns[turns.length - 1].role !== "user") return this.fail(res, 400, "invalid_request_error", "the last message must be the user's");
    const stream = body.stream === true;
    let headed = false;
    const ms = await this.lane.run(body, model, decision, (frame) => {
      if (!stream) return;
      if (!headed) { headed = true; res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" }); }
      res.write(sseText(frame));
    });
    if (stream) { res.end(); return; }
    this.json(res, 200, ms.toMessage());
  }

  /** For tests and the TUI: the turns a conversation has seen. */
  conversation(key: string): Turn[] | null {
    return this.lane.conversation(key);
  }
}
