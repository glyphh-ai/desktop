/**
 * McpExpose — local MCP server for the capture store.
 *
 * Runs a local HTTP+SSE server that any MCP client
 * (Claude Desktop, Cursor, etc.) can connect to. Exposes:
 *   - yo: search across all captured content (vector + keyword)
 *   - sup: push content into the capture store (chunk + embed + index)
 *
 * Protected by bearer tokens configured in Advanced settings.
 */

import http from "http";
import https from "https";
import crypto from "crypto";
import type { CaptureStore } from "./capture-store";
import type { EventLog, YoEvent } from "./event-log";
import type { WorkspaceManager } from "./workspace-manager";
import type { CypherBus } from "./cypher-bus";
import { getPreference, setPreference } from "./preferences";

const DEFAULT_PORT = 7860;
const TOKEN_TTL_DAYS = 90;

interface McpToken {
  token: string;
  label: string;
  createdAt: string;
  expiresAt: string;
}

interface McpRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface SseClient {
  res: http.ServerResponse;
  id: string;
}

interface CallContext {
  agent: string;
  workspace: string;
}

export interface HierarchyEntry {
  agentId: string;
  position: string;
  parentAgentId: string | null;
  reports: string[];
  area: string | null;
  contract: string | null;
}

export interface ProjectContext {
  projectRef: string;
  serverGet: <T>(path: string) => Promise<T | null>;
  serverPost: <T>(path: string, body: Record<string, unknown>) => Promise<T | null>;
  ghToken?: string;
  repoFullName?: string;
}

export class McpExpose {
  private server: http.Server | null = null;
  private captureStore: CaptureStore | null = null;
  private clients = new Map<string, SseClient>();
  private port = DEFAULT_PORT;
  private eventLog: EventLog | null = null;
  private workspaceManager: WorkspaceManager | null = null;
  private bus: CypherBus | null = null;
  private hierarchyContext: Map<string, HierarchyEntry> | null = null;
  private projectContext: ProjectContext | null = null;
  /** Runs a local swarm — injected by main. Returns a human status line. */
  private swarmRunner: ((goal: string, agentIds?: string[], size?: number) => Promise<string>) | null = null;

  setCaptureStore(store: CaptureStore): void {
    this.captureStore = store;
  }

  setBus(bus: CypherBus): void {
    this.bus = bus;
  }

  setSwarmRunner(fn: (goal: string, agentIds?: string[], size?: number) => Promise<string>): void {
    this.swarmRunner = fn;
  }

  setHierarchyContext(ctx: Map<string, HierarchyEntry> | null): void {
    this.hierarchyContext = ctx;
  }

  setProjectContext(ctx: ProjectContext | null): void {
    this.projectContext = ctx;
  }

  setWorkspaceBackend(eventLog: EventLog, wm: WorkspaceManager): void {
    this.eventLog = eventLog;
    this.workspaceManager = wm;
  }

  private workspaceGetter: (() => string) | null = null;
  setWorkspaceGetter(fn: () => string): void {
    this.workspaceGetter = fn;
  }

  private isLeaderRole(agentId: string): boolean {
    const entry = this.hierarchyContext?.get(agentId);
    if (!entry) return false;
    return entry.position === "leader" || entry.position === "lieutenant" || entry.position === "sub-lead";
  }

  private async ghApi<T>(method: string, apiPath: string, body?: Record<string, unknown>): Promise<T> {
    const token = this.projectContext?.ghToken;
    if (!token) throw new Error("No GitHub token");
    const res = await ghRequest(method, apiPath, token, "application/vnd.github+json", body ? JSON.stringify(body) : undefined);
    if (res.status < 200 || res.status >= 300) throw new Error(`${res.status} ${res.data.slice(0, 200)}`);
    return JSON.parse(res.data);
  }

  private async ghApiRaw(method: string, apiPath: string, accept: string): Promise<string> {
    const token = this.projectContext?.ghToken;
    if (!token) throw new Error("No GitHub token");
    const res = await ghRequest(method, apiPath, token, accept);
    if (res.status < 200 || res.status >= 300) throw new Error(`${res.status} ${res.data.slice(0, 200)}`);
    return res.data;
  }

  async getRepoTree(): Promise<{ path: string; type: string; size?: number }[] | null> {
    if (!this.projectContext?.ghToken || !this.projectContext.repoFullName) return null;
    const [owner, repo] = this.projectContext.repoFullName.split("/");
    try {
      const info = await this.ghApi<{ default_branch: string }>("GET", `/repos/${owner}/${repo}`);
      const tree = await this.ghApi<{ tree: { path: string; type: string; size?: number }[] }>(
        "GET", `/repos/${owner}/${repo}/git/trees/${info.default_branch}?recursive=1`,
      );
      return tree.tree;
    } catch {
      return null;
    }
  }

  async getRepoFile(filePath: string): Promise<{ content: string; binary: boolean } | null> {
    if (!this.projectContext?.ghToken || !this.projectContext.repoFullName) return null;
    const [owner, repo] = this.projectContext.repoFullName.split("/");
    try {
      const data = await this.ghApi<{ content: string; encoding: string; size: number }>(
        "GET", `/repos/${owner}/${repo}/contents/${filePath}`,
      );
      if (data.encoding === "base64") {
        const decoded = Buffer.from(data.content, "base64").toString("utf-8");
        return { content: decoded, binary: false };
      }
      return { content: data.content, binary: false };
    } catch {
      return null;
    }
  }

  get isRunning(): boolean {
    return this.server?.listening ?? false;
  }

  getPort(): number {
    return this.port;
  }

  /** Start the MCP server on the configured port. */
  async start(): Promise<{ ok: boolean; error?: string }> {
    if (this.server?.listening) return { ok: true };

    this.port = getPreference<number>("mcpExposePort", DEFAULT_PORT);

    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));

      this.server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          resolve({ ok: false, error: `Port ${this.port} is already in use` });
        } else {
          resolve({ ok: false, error: err.message });
        }
      });

      this.server.listen(this.port, "127.0.0.1", () => {
        console.log(`[mcp-expose] listening on http://127.0.0.1:${this.port}`);
        resolve({ ok: true });
      });
    });
  }

  /** Stop the server and disconnect all clients. */
  stop(): void {
    for (const client of this.clients.values()) {
      try { client.res.end(); } catch {}
    }
    this.clients.clear();

    if (this.server) {
      this.server.close();
      this.server = null;
      console.log("[mcp-expose] stopped");
    }
  }

  /** Generate a new access token with label and expiration, persist it. ttlDays=0 means never expires. */
  generateToken(label: string = "default", ttlDays: number = TOKEN_TTL_DAYS): McpToken {
    const now = new Date();
    const expires = ttlDays > 0
      ? new Date(now.getTime() + ttlDays * 86400000)
      : new Date("9999-12-31T23:59:59.999Z");
    const entry: McpToken = {
      token: `yo_${crypto.randomBytes(24).toString("hex")}`,
      label: label || "default",
      createdAt: now.toISOString(),
      expiresAt: expires.toISOString(),
    };
    const tokens = this.getTokens();
    tokens.push(entry);
    setPreference("mcpExposeTokens", tokens);
    return entry;
  }

  /** Remove an access token by its value. */
  revokeToken(token: string): void {
    const tokens = this.getTokens();
    setPreference("mcpExposeTokens", tokens.filter((t) => t.token !== token));
  }

  /** Get all non-expired tokens. Prunes expired ones on read. */
  getTokens(): McpToken[] {
    const raw = getPreference<(McpToken | string)[]>("mcpExposeTokens", []);
    const now = Date.now();
    const migrated: McpToken[] = raw.map((t) => {
      if (typeof t === "string") {
        return { token: t, label: "default", createdAt: new Date().toISOString(), expiresAt: new Date(now + TOKEN_TTL_DAYS * 86400000).toISOString() };
      }
      return t;
    });
    const active = migrated.filter((t) => new Date(t.expiresAt).getTime() > now);
    if (active.length !== raw.length) {
      setPreference("mcpExposeTokens", active);
    }
    return active;
  }

  private extractContext(req: http.IncomingMessage): CallContext {
    return {
      agent: String(req.headers["x-yo-agent"] || ".yo"),
      workspace: String(req.headers["x-yo-workspace"] || this.workspaceGetter?.() || "default"),
    };
  }

  // ── HTTP handling ─────────────────────────────────────────

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // CORS for local tools — must run before auth so preflight isn't blocked
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Yo-Agent, X-Yo-Workspace");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth check
    if (!this.checkAuth(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    const url = req.url || "/";

    // SSE endpoint — MCP client connects here
    if (url === "/sse" && req.method === "GET") {
      this.handleSse(req, res);
      return;
    }

    // Message endpoint — MCP client POSTs JSON-RPC here
    if (url.startsWith("/message") && req.method === "POST") {
      this.handleMessage(req, res);
      return;
    }

    // Streamable HTTP endpoint — single URL for MCP clients like Claude Code
    if (url === "/mcp" && req.method === "POST") {
      this.handleStreamableHttp(req, res);
      return;
    }

    // REST endpoint — simple POST to ingest content (used by hooks)
    if (url === "/api/sup" && req.method === "POST") {
      this.handleApiSup(req, res);
      return;
    }

    // Health check
    if (url === "/" || url === "/mcp") {
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ name: "glyphh", version: "1.0.0", status: "ok" }));
        return;
      }
    }

    res.writeHead(404);
    res.end("Not found");
  }

  private checkAuth(req: http.IncomingMessage): boolean {
    const tokens = this.getTokens();
    if (tokens.length === 0) return false;

    const authHeader = req.headers.authorization;
    if (!authHeader) return false;

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) return false;

    return tokens.some((t) => t.token === match[1]);
  }

  // ── SSE ─────────────────────────────────────────────────

  private handleSse(_req: http.IncomingMessage, res: http.ServerResponse): void {
    const clientId = crypto.randomBytes(8).toString("hex");

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Send endpoint event so client knows where to POST
    res.write(`event: endpoint\ndata: /message?clientId=${clientId}\n\n`);

    this.clients.set(clientId, { res, id: clientId });

    res.on("close", () => {
      this.clients.delete(clientId);
    });
  }

  private sendToClient(clientId: string, message: Record<string, unknown>): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    try {
      client.res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
    } catch {}
  }

  // ── Streamable HTTP (single-endpoint MCP) ──────────────────

  private async handleStreamableHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body = "";
    for await (const chunk of req) body += chunk;

    let rpc: McpRequest;
    try {
      rpc = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    const ctx = this.extractContext(req);
    const response = await this.processRpc(rpc, ctx);
    if (response) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    } else {
      res.writeHead(202);
      res.end();
    }
  }

  // ── JSON-RPC message handling (legacy SSE transport) ──────

  private async handleMessage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const clientId = url.searchParams.get("clientId") || "";

    let body = "";
    for await (const chunk of req) body += chunk;

    let rpc: McpRequest;
    try {
      rpc = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    const response = await this.processRpc(rpc);

    // Send response via SSE if client is connected, else in HTTP response
    if (clientId && this.clients.has(clientId) && response) {
      this.sendToClient(clientId, response);
      res.writeHead(202);
      res.end();
    } else if (response) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    } else {
      res.writeHead(202);
      res.end();
    }
  }

  private async processRpc(rpc: McpRequest, ctx?: CallContext): Promise<Record<string, unknown> | null> {
    const { id, method, params } = rpc;

    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "glyphh", version: "1.0.0" },
          },
        };

      case "notifications/initialized":
        return null; // No response needed

      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: this.buildToolList() } };

      case "tools/call":
        return this.handleToolCall(id, params as { name: string; arguments?: Record<string, unknown> }, ctx);

      case "ping":
        return { jsonrpc: "2.0", id, result: {} };

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
    }
  }

  private async handleApiSup(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.captureStore) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Capture store not available" }));
      return;
    }

    let body = "";
    for await (const chunk of req) body += chunk;

    let data: { name?: string; content?: string };
    try {
      data = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    const name = String(data.name || "").trim();
    const content = String(data.content || "").trim();

    if (!name || !content) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Both name and content are required" }));
      return;
    }

    const entryId = await this.captureStore.ingest(name, content, this.workspaceGetter?.());
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, id: entryId }));
  }

  private async handleToolCall(
    id: string | number | undefined,
    params: { name: string; arguments?: Record<string, unknown> },
    ctx?: CallContext,
  ): Promise<Record<string, unknown>> {
    const args = params.arguments || {};
    const reply = (text: string, isError = false) => ({
      jsonrpc: "2.0" as const, id,
      result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) },
    });
    const replyJson = (data: unknown) => reply(JSON.stringify(data, null, 2));

    switch (params.name) {
      // ── Capture store tools ────────────────────────────────
      case "glyphh_search": {
        if (!this.captureStore) return reply("Capture store not available.", true);
        const query = String(args.query || "");
        const limit = Number(args.limit) || 10;
        if (!query) return reply("query is required", true);

        const results = await this.captureStore.search(query, limit);
        if (results.length === 0) return reply(`No results for "${query}".`);

        const text = results.map((r) =>
          `[${r.meta.source}] (score: ${r.score.toFixed(2)}) ${new Date(r.meta.created).toLocaleString()}\n${r.content}`,
        ).join("\n\n---\n\n");
        return reply(text);
      }

      case "sup": {
        if (!this.captureStore) return reply("Capture store not available.", true);
        const name = String(args.name || "").trim();
        const content = String(args.content || "").trim();
        if (!name || !content) return reply("Both name and content are required.", true);

        const entryId = await this.captureStore.ingest(name, content, this.workspaceGetter?.());
        return reply(`Stored "${name}" (id: ${entryId}). Content chunked, embedded, and indexed.`);
      }

      // ── Workspace tools ────────────────────────────────────
      case "team_status": {
        // In a cypher, the team IS the cypher's jammer roster — not the
        // workspace's registered agents (which is typically empty here, so
        // the old behavior returned `agents: []` and the orchestrator was
        // blind to its own swarm). The hierarchy context is that roster.
        if (this.hierarchyContext && this.hierarchyContext.size > 0) {
          return replyJson({
            cypher: true,
            jammers: [...this.hierarchyContext.values()].map((e) => ({
              agent: e.agentId,
              position: e.position,
              reports_to: e.parentAgentId,
              reports: e.reports,
              area: e.area,
            })),
          });
        }
        if (!this.workspaceManager || !this.eventLog) return reply("Workspace backend not available.", true);
        const wsSlug = ctx?.workspace || this.workspaceGetter?.() || "default";
        const ws = this.workspaceManager.get(wsSlug);
        if (!ws) return reply(`Unknown workspace: ${wsSlug}`, true);
        const agents = this.workspaceManager.listAgents(wsSlug);
        const status = this.eventLog.teamStatus(wsSlug, agents);
        return replyJson({
          workspace: ws.slug,
          rootDir: ws.rootDir,
          agents: status.map((s) => ({
            ...s,
            lastPostAt: s.lastPostTs ? new Date(s.lastPostTs).toISOString() : null,
          })),
        });
      }

      case "read_log": {
        if (!this.eventLog) return reply("Workspace backend not available.", true);
        const wsSlug = ctx?.workspace || this.workspaceGetter?.() || "default";
        const filter = (args.filter as Record<string, unknown>) || args;
        // In a cypher, default to recent activity when no explicit `since` is
        // given — the workspace event log accumulates across cyphers, so an
        // unfiltered read drowns the orchestrator in stale events from
        // previous cyphers (the "why am I seeing the old cypher" problem).
        const since = typeof filter.since === "number"
          ? filter.since
          : (this.hierarchyContext ? Date.now() - 45 * 60_000 : undefined);
        const events = this.eventLog.read(wsSlug, {
          tags: asStringArray(filter.tags),
          from: asStringArray(filter.from),
          to: typeof filter.to === "string" ? filter.to : undefined,
          since,
          until: typeof filter.until === "number" ? filter.until : undefined,
          kinds: asStringArray(filter.kinds) as YoEvent["kind"][] | undefined,
          limit: typeof filter.limit === "number" ? filter.limit : undefined,
        });
        return replyJson({ count: events.length, events, scoped: since ? "recent" : "all" });
      }

      case "read_agent": {
        if (!this.eventLog) return reply("Workspace backend not available.", true);
        const wsSlug = ctx?.workspace || this.workspaceGetter?.() || "default";
        const name = String(args.name || "").trim();
        if (!name) return reply("name is required", true);
        const kind = String(args.kind || "scratchpad");
        if (kind === "log") {
          const events = this.eventLog.read(wsSlug, { from: [name] });
          return replyJson({ agent: name, events });
        }
        const text = this.eventLog.readScratchpad(wsSlug, name);
        return reply(text || `(${name} has no scratchpad yet)`);
      }

      case "post": {
        if (!this.eventLog) return reply("Workspace backend not available.", true);
        const wsSlug = ctx?.workspace || this.workspaceGetter?.() || "default";
        const body = String(args.body || "").trim();
        if (!body) return reply("body is required", true);
        const tags = mergeTags(asStringArray(args.tags) ?? [], ctx || { agent: ".yo", workspace: wsSlug });
        if (this.bus) {
          await this.bus.post(wsSlug, {
            from: ctx?.agent || ".yo",
            kind: (args.kind as string) || "post",
            body,
            tags,
            refs: asStringArray(args.refs),
          });
        } else {
          this.eventLog.append(wsSlug, {
            from: ctx?.agent || ".yo",
            tags,
            kind: (args.kind as YoEvent["kind"]) || "post",
            body,
            refs: asStringArray(args.refs),
          });
        }
        return replyJson({ ts: Date.now() });
      }

      case "post_to": {
        if (!this.eventLog) return reply("Workspace backend not available.", true);
        const wsSlug = ctx?.workspace || this.workspaceGetter?.() || "default";
        const to = String(args.agent || "").trim();
        const body = String(args.body || "").trim();
        if (!to) return reply("agent is required", true);
        if (!body) return reply("body is required", true);
        const tags = mergeTags(asStringArray(args.tags) ?? [], ctx || { agent: ".yo", workspace: wsSlug });
        if (this.bus) {
          await this.bus.post(wsSlug, {
            from: ctx?.agent || ".yo",
            to,
            kind: (args.kind as string) || "post",
            body,
            tags,
            refs: asStringArray(args.refs),
          });
        } else {
          this.eventLog.append(wsSlug, {
            from: ctx?.agent || ".yo",
            to,
            tags,
            kind: (args.kind as YoEvent["kind"]) || "post",
            body,
            refs: asStringArray(args.refs),
          });
        }
        return replyJson({ ts: Date.now() });
      }

      case "subscribe": {
        if (!this.workspaceManager) return reply("Workspace backend not available.", true);
        const wsSlug = ctx?.workspace || this.workspaceGetter?.() || "default";
        const filter = (args.filter as Record<string, unknown>) || args;
        const result = this.workspaceManager.addSubscription(wsSlug, ctx?.agent || ".yo", {
          tags: asStringArray(filter.tags),
          from: asStringArray(filter.from),
          mentions_me: filter.mentions_me === true,
        });
        if (!result.ok) return reply(result.error!, true);
        return replyJson({ id: result.id });
      }

      case "unsubscribe": {
        if (!this.workspaceManager) return reply("Workspace backend not available.", true);
        const wsSlug = ctx?.workspace || this.workspaceGetter?.() || "default";
        const subId = String(args.id || "").trim();
        if (!subId) return reply("id is required", true);
        const ok = this.workspaceManager.removeSubscription(wsSlug, ctx?.agent || ".yo", subId);
        return reply(ok ? "ok" : `No subscription ${subId}`, !ok);
      }

      // ── Hierarchy tools (cypher mode only) ──────────────────
      case "get_hierarchy": {
        if (!this.hierarchyContext) return reply("No hierarchy context (not in cypher mode)", true);
        const agent = ctx?.agent || ".yo";
        const entry = this.hierarchyContext.get(agent);
        if (!entry) return reply(`Agent "${agent}" not found in hierarchy`, true);
        const chain: string[] = [];
        let cur = entry.parentAgentId;
        while (cur) {
          chain.push(cur);
          const p = this.hierarchyContext.get(cur);
          cur = p?.parentAgentId ?? null;
        }
        return replyJson({ ...entry, chain_of_command: chain });
      }

      case "assign_task": {
        if (!this.hierarchyContext) return reply("No hierarchy context (not in cypher mode)", true);
        const agent = ctx?.agent || ".yo";
        const wsSlug = ctx?.workspace || this.workspaceGetter?.() || "default";
        const caller = this.hierarchyContext.get(agent);
        if (!caller) return reply(`Agent "${agent}" not found in hierarchy`, true);
        if (caller.reports.length === 0) return reply(`${agent} has no direct reports — only leaders/lieutenants/sub-leads can assign tasks`, true);
        const target = String(args.agent || "").trim();
        const taskBody = String(args.body || "").trim();
        if (!target) return reply("agent is required", true);
        if (!taskBody) return reply("body is required", true);
        if (!caller.reports.includes(target)) return reply(`${target} is not a direct report of ${agent}. Your reports: ${caller.reports.join(", ")}`, true);
        if (this.bus) {
          await this.bus.post(wsSlug, { from: agent, to: target, kind: "assign_task", body: taskBody });
        }
        return replyJson({ ok: true, assigned_to: target, task: taskBody });
      }

      case "accept_task": {
        if (!this.hierarchyContext) return reply("No hierarchy context (not in cypher mode)", true);
        const agent = ctx?.agent || ".yo";
        const wsSlug = ctx?.workspace || this.workspaceGetter?.() || "default";
        const caller = this.hierarchyContext.get(agent);
        if (!caller) return reply(`Agent "${agent}" not found in hierarchy`, true);
        const taskId = String(args.task_id || "").trim();
        if (this.bus) {
          await this.bus.post(wsSlug, {
            from: agent,
            to: caller.parentAgentId || undefined,
            kind: "accept_task",
            body: taskId ? `Accepted task ${taskId}` : "Task accepted",
            meta: taskId ? { task_id: taskId } : undefined,
          });
        }
        return replyJson({ ok: true, accepted_by: agent });
      }

      case "complete_task": {
        if (!this.hierarchyContext) return reply("No hierarchy context (not in cypher mode)", true);
        const agent = ctx?.agent || ".yo";
        const wsSlug = ctx?.workspace || this.workspaceGetter?.() || "default";
        const caller = this.hierarchyContext.get(agent);
        if (!caller) return reply(`Agent "${agent}" not found in hierarchy`, true);
        const summary = String(args.summary || "").trim();
        if (!summary) return reply("summary is required", true);
        if (this.bus) {
          await this.bus.post(wsSlug, {
            from: agent,
            to: caller.parentAgentId || undefined,
            kind: "complete_task",
            body: summary,
          });
        }
        return replyJson({ ok: true, completed_by: agent });
      }

      case "submit_work": {
        const agent = ctx?.agent || ".yo";
        const wsSlug = ctx?.workspace || this.workspaceGetter?.() || "default";
        const summary = String(args.summary || "").trim();
        if (!summary) return reply("summary is required", true);
        const ws = this.workspaceManager?.get(wsSlug);
        if (!ws) return reply(`workspace "${wsSlug}" not found`, true);
        try {
          const { uploadWorkPackage } = await import("./work-package-uploader");
          const result = await uploadWorkPackage(ws.rootDir, `${agent}-work`);
          if (this.bus) {
            await this.bus.post(wsSlug, {
              from: agent,
              kind: "work_package_submitted",
              body: summary,
              tags: ["broadcast"],
              meta: {
                work_package_id: result.id,
                sha256: result.sha256,
                files: result.fileCount,
                size_bytes: result.sizeBytes,
              },
            });
          }
          return replyJson({
            ok: true,
            work_package_id: result.id,
            files: result.fileCount,
            truncated: result.truncated,
            note: result.truncated
              ? "Work package submitted (capped at the size limit — some files were left out). The maestro will integrate and push it."
              : "Work package submitted. The maestro will integrate and push it.",
          });
        } catch (err) {
          return reply(`submit_work failed: ${err instanceof Error ? err.message : String(err)}`, true);
        }
      }

      case "report_status": {
        if (!this.hierarchyContext) return reply("No hierarchy context (not in cypher mode)", true);
        const agent = ctx?.agent || ".yo";
        const wsSlug = ctx?.workspace || this.workspaceGetter?.() || "default";
        const caller = this.hierarchyContext.get(agent);
        if (!caller) return reply(`Agent "${agent}" not found in hierarchy`, true);
        const statusBody = String(args.body || "").trim();
        if (!statusBody) return reply("body is required", true);
        const statusKind = String(args.kind || "progress");
        if (this.bus) {
          await this.bus.post(wsSlug, {
            from: agent,
            to: caller.parentAgentId || undefined,
            kind: "report_status",
            body: statusBody,
            meta: { status_kind: statusKind },
          });
        }
        return replyJson({ ok: true, reported_by: agent, to: caller.parentAgentId });
      }

      case "request_review": {
        if (!this.hierarchyContext) return reply("No hierarchy context (not in cypher mode)", true);
        const agent = ctx?.agent || ".yo";
        const wsSlug = ctx?.workspace || this.workspaceGetter?.() || "default";
        const caller = this.hierarchyContext.get(agent);
        if (!caller) return reply(`Agent "${agent}" not found in hierarchy`, true);
        const reviewBody = String(args.body || "").trim();
        if (!reviewBody) return reply("body is required", true);
        if (this.bus) {
          await this.bus.post(wsSlug, {
            from: agent,
            to: caller.parentAgentId || undefined,
            kind: "request_review",
            body: reviewBody,
          });
        }
        return replyJson({ ok: true, requested_by: agent, reviewer: caller.parentAgentId });
      }

      // ── GitHub tools (cypher mode only) ───────────────────
      case "gh_repo_info": {
        if (!this.projectContext?.ghToken || !this.projectContext.repoFullName) {
          return reply("No GitHub context (not in cypher mode or no linked repo)", true);
        }
        const [owner, repo] = this.projectContext.repoFullName.split("/");
        try {
          const data = await this.ghApi<{ default_branch: string; description: string | null; html_url: string }>(
            "GET", `/repos/${owner}/${repo}`,
          );
          return replyJson({
            full_name: this.projectContext.repoFullName,
            default_branch: data.default_branch,
            description: data.description,
            html_url: data.html_url,
            clone_url: `https://x-access-token:${this.projectContext.ghToken}@github.com/${owner}/${repo}.git`,
          });
        } catch (e) {
          return reply(`GitHub API error: ${e instanceof Error ? e.message : e}`, true);
        }
      }

      case "gh_open_pr": {
        if (!this.projectContext?.ghToken || !this.projectContext.repoFullName) return reply("No GitHub context", true);
        const [owner, repo] = this.projectContext.repoFullName.split("/");
        const title = String(args.title || "").trim();
        const head = String(args.head || "").trim();
        const base = String(args.base || "").trim();
        if (!title) return reply("title is required", true);
        if (!head) return reply("head (branch name) is required", true);
        if (!base) return reply("base (target branch) is required", true);
        try {
          const payload: Record<string, unknown> = { title, head, base };
          if (args.body) payload.body = String(args.body);
          const data = await this.ghApi<{ number: number; html_url: string }>(
            "POST", `/repos/${owner}/${repo}/pulls`, payload,
          );
          return replyJson({ number: data.number, url: data.html_url });
        } catch (e) {
          return reply(`GitHub API error: ${e instanceof Error ? e.message : e}`, true);
        }
      }

      case "gh_list_prs": {
        if (!this.projectContext?.ghToken || !this.projectContext.repoFullName) return reply("No GitHub context", true);
        const [owner, repo] = this.projectContext.repoFullName.split("/");
        const state = String(args.state || "open");
        try {
          const prs = await this.ghApi<{ number: number; title: string; state: string; head: { ref: string }; user: { login: string }; html_url: string }[]>(
            "GET", `/repos/${owner}/${repo}/pulls?state=${encodeURIComponent(state)}&per_page=50`,
          );
          return replyJson(prs.map(p => ({
            number: p.number, title: p.title, branch: p.head.ref,
            author: p.user.login, url: p.html_url,
          })));
        } catch (e) {
          return reply(`GitHub API error: ${e instanceof Error ? e.message : e}`, true);
        }
      }

      case "gh_get_pr_diff": {
        if (!this.projectContext?.ghToken || !this.projectContext.repoFullName) return reply("No GitHub context", true);
        const [owner, repo] = this.projectContext.repoFullName.split("/");
        const prNum = Number(args.number);
        if (!prNum) return reply("number is required", true);
        try {
          const diff = await this.ghApiRaw("GET", `/repos/${owner}/${repo}/pulls/${prNum}`, "application/vnd.github.diff");
          return reply(diff.length > 50000 ? diff.slice(0, 50000) + "\n... (diff truncated)" : diff);
        } catch (e) {
          return reply(`GitHub API error: ${e instanceof Error ? e.message : e}`, true);
        }
      }

      case "gh_review_pr": {
        if (!this.projectContext?.ghToken || !this.projectContext.repoFullName) return reply("No GitHub context", true);
        const agent = ctx?.agent || ".yo";
        if (!this.isLeaderRole(agent)) return reply("Only leaders can review PRs", true);
        const [owner, repo] = this.projectContext.repoFullName.split("/");
        const prNum = Number(args.number);
        const event = String(args.event || "").toUpperCase();
        if (!prNum) return reply("number is required", true);
        if (!["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(event)) {
          return reply("event must be APPROVE, REQUEST_CHANGES, or COMMENT", true);
        }
        try {
          const payload: Record<string, unknown> = { event };
          if (args.body) payload.body = String(args.body);
          const data = await this.ghApi<{ id: number; state: string }>(
            "POST", `/repos/${owner}/${repo}/pulls/${prNum}/reviews`, payload,
          );
          return replyJson({ id: data.id, state: data.state });
        } catch (e) {
          return reply(`GitHub API error: ${e instanceof Error ? e.message : e}`, true);
        }
      }

      case "gh_merge_pr": {
        if (!this.projectContext?.ghToken || !this.projectContext.repoFullName) return reply("No GitHub context", true);
        const agent = ctx?.agent || ".yo";
        if (!this.isLeaderRole(agent)) return reply("Only leaders can merge PRs", true);
        const [owner, repo] = this.projectContext.repoFullName.split("/");
        const prNum = Number(args.number);
        if (!prNum) return reply("number is required", true);
        try {
          const payload: Record<string, unknown> = { merge_method: String(args.method || "squash") };
          if (args.commit_title) payload.commit_title = String(args.commit_title);
          const data = await this.ghApi<{ merged: boolean; sha: string; message: string }>(
            "PUT", `/repos/${owner}/${repo}/pulls/${prNum}/merge`, payload,
          );
          return replyJson({ merged: data.merged, sha: data.sha, message: data.message });
        } catch (e) {
          return reply(`GitHub API error: ${e instanceof Error ? e.message : e}`, true);
        }
      }

      // ── Testing / presentation tools (cypher mode only) ──
      case "preview_url": {
        if (!this.hierarchyContext) return reply("No hierarchy context (not in cypher mode)", true);
        const agent = ctx?.agent || ".yo";
        const wsSlug = ctx?.workspace || this.workspaceGetter?.() || "default";
        const url = String(args.url || "").trim();
        if (!url) return reply("url is required", true);
        try { new URL(url); } catch { return reply(`Invalid URL: ${url}`, true); }
        const title = String(args.title || "").trim() || `Preview by ${agent}`;
        if (this.bus) {
          await this.bus.post(wsSlug, {
            from: agent,
            kind: "preview_url",
            body: title,
            meta: { url, title },
          });
        }
        return replyJson({ ok: true, url, title, message: `Preview panel opened for ${url}` });
      }

      case "show_output": {
        if (!this.hierarchyContext) return reply("No hierarchy context (not in cypher mode)", true);
        const agent = ctx?.agent || ".yo";
        const wsSlug = ctx?.workspace || this.workspaceGetter?.() || "default";
        const content = String(args.content || "").trim();
        if (!content) return reply("content is required", true);
        const title = String(args.title || "").trim() || "Output";
        const format = String(args.format || "plain");
        if (this.bus) {
          await this.bus.post(wsSlug, {
            from: agent,
            kind: "show_output",
            body: content,
            meta: { title, format },
          });
        }
        return replyJson({ ok: true, title, length: content.length });
      }

      // ── Jammer tools — create & run reusable sub-agents on the fly ──
      case "create_jammer": {
        const name = String(args.name || "").trim();
        const role = String(args.role || "").trim();
        const instructions = String(args.instructions || "").trim();
        if (!name || !role || !instructions) {
          return reply("name, role, and instructions are required", true);
        }
        const { listAgents, saveAgent } = await import("./stores/agent-store-db");
        // Slugify the name into an id, uniquified against the existing library.
        const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "jammer";
        const taken = new Set(listAgents().map((a) => a.id));
        let jid = base;
        for (let n = 2; taken.has(jid); n++) jid = `${base}-${n}`;
        const maxTurns = typeof args.max_turns === "number" ? args.max_turns : undefined;
        try {
          const saved = saveAgent({
            id: jid,
            name,
            type: "local",
            role,
            systemPrompt: instructions,
            ...(args.model ? { model_name: String(args.model) } : {}),
            ...(maxTurns ? { guardrails: { max_turns: maxTurns } } : {}),
          } as Parameters<typeof saveAgent>[0]);
          return replyJson({
            ok: true, id: saved.id, name: saved.name, role: saved.role,
            note: `Jammer "${saved.name}" saved to the global library. Run it any time with run_jammer (id: ${saved.id}).`,
          });
        } catch (err) {
          return reply(`create_jammer failed: ${err instanceof Error ? err.message : String(err)}`, true);
        }
      }

      case "list_jammers": {
        const { listAgents } = await import("./stores/agent-store-db");
        const jammers = listAgents().map((a) => ({
          id: a.id, name: a.name, role: a.role || "agent", model: a.model_name || "default",
        }));
        return replyJson({ jammers, count: jammers.length });
      }

      case "run_jammer": {
        const jammerId = String(args.jammer || "").trim();
        const task = String(args.task || "").trim();
        if (!jammerId || !task) return reply("jammer and task are required", true);
        const { getAgent } = await import("./stores/agent-store-db");
        const jammer = getAgent(jammerId);
        if (!jammer) {
          return reply(`Jammer "${jammerId}" not found — use list_jammers to see the library.`, true);
        }
        const cwd = String(args.cwd || "").trim()
          || this.workspaceManager?.getActive()?.rootDir
          || process.cwd();
        const wsSlug = ctx?.workspace || this.workspaceGetter?.() || "default";
        // NON-BLOCKING: an MCP tool call cannot block for the minutes a real
        // agent run takes — it would (and did) exceed the tool-call timeout.
        // Kick the run off in the background and return immediately; the
        // jammer's progress + result post to the feed via the bus.
        const runJammerBg = async (): Promise<void> => {
          try {
            const { getShellPath } = await import("./shell-path");
            const { asarSafeQueryOptions } = await import("./sdk-llm");
            const dynImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;
            const sdk = await dynImport("@anthropic-ai/claude-agent-sdk");
            const options: Record<string, unknown> = {
              ...asarSafeQueryOptions(cwd),
              model: jammer.model_name || "claude-sonnet-4-6",
              maxTurns: jammer.guardrails?.max_turns ?? 25,
              permissionMode: "bypassPermissions",
              allowedTools: ["Bash", "Read", "Edit", "Write", "Grep", "Glob", "WebFetch", "WebSearch", "TodoWrite"],
              systemPrompt: jammer.systemPrompt || `You are ${jammer.name}, a ${jammer.role || "helper"} agent.`,
              env: {
                ...process.env,
                PATH: getShellPath(),
                YO_AGENT_NAME: jammer.id,
                YO_AGENT_ROLE: jammer.role || "agent",
              },
            };
            let fullText = "";
            let resultText = "";
            let subtype = "success";
            for await (const msg of sdk.query({ prompt: task, options })) {
              if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
                for (const block of msg.message.content) {
                  if (block.type === "text" && block.text) fullText += block.text;
                }
              } else if (msg.type === "result") {
                if (typeof msg.result === "string") resultText = msg.result;
                if (msg.subtype) subtype = msg.subtype;
              }
            }
            const output = (fullText.trim() || resultText.trim() || "(no output)").slice(0, 4000);
            this.bus?.post(wsSlug, {
              from: jammerId,
              kind: subtype === "success" ? "agent_result" : "agent_error",
              body: output,
            }).catch(() => {});
          } catch (err) {
            this.bus?.post(wsSlug, {
              from: jammerId,
              kind: "agent_error",
              body: `run failed: ${err instanceof Error ? err.message : String(err)}`,
            }).catch(() => {});
          }
        };
        void runJammerBg();
        return replyJson({
          ok: true,
          note: `Jammer "${jammerId}" started on the task — it runs in the background; its progress and result appear in the cypher feed. This call returns immediately (a jammer run is too long to block on).`,
        });
      }

      case "create_swarm": {
        const goal = String(args.goal || "").trim();
        if (!goal) return reply("goal is required", true);
        if (!this.swarmRunner) return reply("swarm runner not available", true);
        try {
          const jammers = Array.isArray(args.jammers)
            ? (args.jammers as unknown[]).map((j) => String(j)).filter(Boolean)
            : undefined;
          const size = typeof args.size === "number" ? args.size : undefined;
          return reply(await this.swarmRunner(goal, jammers, size));
        } catch (err) {
          return reply(`create_swarm failed: ${err instanceof Error ? err.message : String(err)}`, true);
        }
      }

      default:
        return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${params.name}` } };
    }
  }

  // ── Tool definitions ───────────────────────────────────────

  private buildToolList() {
    const tools: Record<string, unknown>[] = [
      {
        name: "glyphh_search",
        description: "Search the user's Glyphh capture store. Returns context from across all the user's apps — conversations, code, emails, docs, anything they've worked on.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Natural language search query" },
            limit: { type: "number", description: "Max results (default 10)" },
          },
          required: ["query"],
        },
      },
      {
        name: "sup",
        description: "Push context into the user's .Yo capture store. Content is chunked, embedded, and indexed for future search.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Short label (e.g. 'auth-refactor')" },
            content: { type: "string", description: "The content to store" },
          },
          required: ["name", "content"],
        },
      },
      {
        name: "create_jammer",
        description: "Create a reusable jammer (a named sub-agent) in the user's global jammer "
          + "library. Once created it persists and can be run any time via run_jammer, or "
          + "brought into a cypher. Use this when the user asks for a specialized agent — "
          + "a reviewer, a frontend specialist, a test-writer, etc.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Display name, e.g. 'Code Reviewer'" },
            role: { type: "string", description: "Short role label, e.g. 'reviewer', 'frontend'" },
            instructions: { type: "string", description: "The jammer's system prompt — who it is, how it works, what it's good at" },
            model: { type: "string", description: "Optional model id (default: claude-sonnet-4-6)" },
            max_turns: { type: "number", description: "Optional per-run turn budget (default 25)" },
          },
          required: ["name", "role", "instructions"],
        },
      },
      {
        name: "list_jammers",
        description: "List the jammers in the user's global jammer library — their ids, names, and roles.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "run_jammer",
        description: "Run a jammer one-shot on a task and return its result. Blocks until the "
          + "jammer finishes. Use this to delegate work to a specialized jammer — the yo agent "
          + "orchestrates, the jammer does the focused task. The jammer can read/write files and "
          + "run commands in the working directory.",
        inputSchema: {
          type: "object",
          properties: {
            jammer: { type: "string", description: "The jammer's id (from list_jammers)" },
            task: { type: "string", description: "The task for the jammer to carry out" },
            cwd: { type: "string", description: "Optional working directory (defaults to the active workspace)" },
          },
          required: ["jammer", "task"],
        },
      },
      {
        name: "create_swarm",
        description: "Spin up a local swarm of agents to work a goal together. The first "
          + "agent leads — it decomposes the goal and assigns tasks to the rest over the bus. "
          + "Pass specific jammer ids, or a size to take that many from the library. Agents "
          + "run locally; their activity streams inline into the yo conversation — there is "
          + "no separate swarm panel.",
        inputSchema: {
          type: "object",
          properties: {
            goal: { type: "string", description: "The objective — what the swarm should accomplish" },
            jammers: { type: "array", items: { type: "string" }, description: "Jammer ids (from list_jammers); first one leads" },
            size: { type: "number", description: "If no jammers given, take this many from the library (default 3)" },
          },
          required: ["goal"],
        },
      },
    ];

    if (this.workspaceManager && this.eventLog) {
      tools.push(
        {
          name: "team_status",
          description: "List all agents in this workspace with roles and last-post timestamps.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "read_log",
          description: "Read workspace event log. Filter by tags, sender, kind, or time.",
          inputSchema: {
            type: "object",
            properties: {
              tags: { type: "array", items: { type: "string" } },
              from: { type: "array", items: { type: "string" } },
              to: { type: "string" },
              since: { type: "number" },
              until: { type: "number" },
              kinds: { type: "array", items: { type: "string" } },
              limit: { type: "number" },
            },
          },
        },
        {
          name: "read_agent",
          description: "Read another agent's scratchpad or post history.",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string", description: "Agent name" },
              kind: { type: "string", enum: ["scratchpad", "log"] },
            },
            required: ["name"],
          },
        },
        {
          name: "post",
          description: "Append an event to the workspace log. Tags: ['broadcast'] for status, ['role:X'] for role-targeted, 'blocking' if response needed.",
          inputSchema: {
            type: "object",
            properties: {
              body: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
              kind: { type: "string", enum: ["post", "status", "question", "answer", "artifact"] },
              refs: { type: "array", items: { type: "string" } },
            },
            required: ["body"],
          },
        },
        {
          name: "post_to",
          description: "Direct message another agent.",
          inputSchema: {
            type: "object",
            properties: {
              agent: { type: "string" },
              body: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
              kind: { type: "string", enum: ["post", "status", "question", "answer", "artifact"] },
              refs: { type: "array", items: { type: "string" } },
            },
            required: ["agent", "body"],
          },
        },
        {
          name: "subscribe",
          description: "Register a tag-filter for inbox delivery of matching events.",
          inputSchema: {
            type: "object",
            properties: {
              tags: { type: "array", items: { type: "string" } },
              from: { type: "array", items: { type: "string" } },
              mentions_me: { type: "boolean" },
            },
          },
        },
        {
          name: "unsubscribe",
          description: "Remove a subscription by id.",
          inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        },
      );
    }

    if (this.hierarchyContext) {
      tools.push(
        {
          name: "get_hierarchy",
          description: "Returns your position, parent, direct reports, and full chain of command in the cypher hierarchy.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "assign_task",
          description: "Assign a task to one of your direct reports. Only leaders, lieutenants, and sub-leads can call this.",
          inputSchema: {
            type: "object",
            properties: {
              agent: { type: "string", description: "Agent name of the direct report to assign to" },
              body: { type: "string", description: "Task description" },
            },
            required: ["agent", "body"],
          },
        },
        {
          name: "accept_task",
          description: "Accept a task assigned to you by your parent in the chain of command.",
          inputSchema: {
            type: "object",
            properties: {
              task_id: { type: "string", description: "Optional task identifier" },
            },
          },
        },
        {
          name: "complete_task",
          description: "Mark your current task as complete. Notifies your parent in the chain of command.",
          inputSchema: {
            type: "object",
            properties: {
              summary: { type: "string", description: "Summary of what was accomplished" },
            },
            required: ["summary"],
          },
        },
        {
          name: "submit_work",
          description: "Submit your completed work as a package for the cypher to integrate. "
            + "Use this when you have finished but cannot push to GitHub directly (no git / no "
            + "auth on this machine). Zips your working directory and hands it to the maestro, "
            + "who reviews and pushes it. Call complete_task afterwards.",
          inputSchema: {
            type: "object",
            properties: {
              summary: { type: "string", description: "Short summary of the work you completed" },
            },
            required: ["summary"],
          },
        },
        {
          name: "report_status",
          description: "Report progress, blockers, or other status to your parent in the chain of command.",
          inputSchema: {
            type: "object",
            properties: {
              body: { type: "string", description: "Status update" },
              kind: { type: "string", enum: ["progress", "blocker", "question", "complete"], description: "Status type (default: progress)" },
            },
            required: ["body"],
          },
        },
        {
          name: "request_review",
          description: "Request your parent to review your completed work before it's considered done.",
          inputSchema: {
            type: "object",
            properties: {
              body: { type: "string", description: "Description of what needs review" },
            },
            required: ["body"],
          },
        },
        {
          name: "preview_url",
          description: "Open a URL in a browser panel visible to the user. Use this to showcase web UIs you've built (e.g. after starting a dev server). The panel supports localhost with automatic retry while the server starts.",
          inputSchema: {
            type: "object",
            properties: {
              url: { type: "string", description: "URL to preview (e.g. http://localhost:3000)" },
              title: { type: "string", description: "Panel title (default: 'Preview by <agent>')" },
            },
            required: ["url"],
          },
        },
        {
          name: "show_output",
          description: "Display formatted output in the cypher feed, visible to the user and all agents. Use this to present command output, test results, build logs, or any text the team should see.",
          inputSchema: {
            type: "object",
            properties: {
              content: { type: "string", description: "The output text to display" },
              title: { type: "string", description: "Title/label for the output block (default: 'Output')" },
              format: { type: "string", enum: ["plain", "ansi", "json", "markdown"], description: "Content format hint (default: plain)" },
            },
            required: ["content"],
          },
        },
      );
    }

    if (this.projectContext?.ghToken && this.projectContext?.repoFullName) {
      tools.push(
        {
          name: "gh_repo_info",
          description: "Get repository info including the authenticated clone URL, default branch, and description.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "gh_open_pr",
          description: "Create a pull request from a feature branch.",
          inputSchema: {
            type: "object",
            properties: {
              title: { type: "string", description: "PR title" },
              body: { type: "string", description: "PR description (markdown)" },
              head: { type: "string", description: "Source branch name" },
              base: { type: "string", description: "Target branch (e.g. main)" },
            },
            required: ["title", "head", "base"],
          },
        },
        {
          name: "gh_list_prs",
          description: "List pull requests with branch and author info.",
          inputSchema: {
            type: "object",
            properties: {
              state: { type: "string", enum: ["open", "closed", "all"], description: "Filter by state (default: open)" },
            },
          },
        },
        {
          name: "gh_get_pr_diff",
          description: "Get the diff for a pull request. Truncated at 50k characters.",
          inputSchema: {
            type: "object",
            properties: { number: { type: "number", description: "PR number" } },
            required: ["number"],
          },
        },
        {
          name: "gh_review_pr",
          description: "Submit a review on a pull request (APPROVE, REQUEST_CHANGES, or COMMENT). Leaders only.",
          inputSchema: {
            type: "object",
            properties: {
              number: { type: "number", description: "PR number" },
              event: { type: "string", enum: ["APPROVE", "REQUEST_CHANGES", "COMMENT"], description: "Review action" },
              body: { type: "string", description: "Review comment" },
            },
            required: ["number", "event"],
          },
        },
        {
          name: "gh_merge_pr",
          description: "Merge an approved pull request. Leaders only.",
          inputSchema: {
            type: "object",
            properties: {
              number: { type: "number", description: "PR number" },
              method: { type: "string", enum: ["squash", "merge", "rebase"], description: "Merge method (default: squash)" },
              commit_title: { type: "string", description: "Custom merge commit title" },
            },
            required: ["number"],
          },
        },
      );
    }

    return tools;
  }
}

// ── helpers ─────────────────────────────────────────────────

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

function mergeTags(userTags: string[], ctx: CallContext): string[] {
  const merged = new Set<string>(userTags);
  merged.add(`from:${ctx.agent}`);
  merged.add(`workspace:${ctx.workspace}`);
  return Array.from(merged);
}

export function ghRequest(
  method: string,
  apiPath: string,
  token: string,
  accept: string,
  body?: string,
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.github.com",
        path: apiPath,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: accept,
          "User-Agent": "yo-client",
          ...(body ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode || 0, data }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
