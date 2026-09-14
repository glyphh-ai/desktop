/**
 * Local MCP server — a 127.0.0.1 HTTP MCP endpoint so an LLM running on the
 * SAME machine (Claude Desktop, Cursor, the `claude` CLI) can drive Glyphh
 * directly, with no cloud round-trip. It's an alternative to the cloud relay:
 * lowest latency, no account/tier requirement, works offline.
 *
 * It exposes the SAME tool surface as the cloud relay by dispatching every
 * call through `dispatchRelayMethod` — the shared handler registry that
 * `relay-handlers.ts` populates. Server-only tools (Pipedream connectors, the
 * capture store) are intentionally absent: those need cloud auth the local
 * server can't provide.
 *
 * Opt-in via the `localMcpEnabled` preference (Settings > MCP > Local server).
 * Bearer-token authed against locally-stored, SHA-256-hashed tokens.
 */

import http from "node:http";
import crypto from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getPreference, setPreference } from "./stores/preferences-db.js";
import { dispatchRelayMethod } from "./relay-client.js";
import { listConnectionTools, callConnectionTool } from "./mcp-connections.js";
import { listTaskSpecs, getTaskSpec, saveTaskSpec, runTaskNow, listTaskRunsFor, listSkillRows, getSkillRow, saveSkillRow } from "./local-library.js";
import { listCliAgents } from "./cli-agents.js";
import { SEMANTIC_TOOLS } from "./glyphh-agent-semantic.js";
import { refreshConnectorCatalog, getConnectorCatalog, getCatalogAge, callConnectorTool } from "./connector-tools-client.js";

const DEFAULT_PORT = 7860;
const TOKEN_TTL_DAYS = 90;
const SERVER_NAME = "glyphh-local";
const SERVER_VERSION = "1.0.0";

// ── Token storage (hashed at rest in preferences) ──────────────────

interface StoredToken {
  id: string;
  label: string;
  hash: string; // sha256(rawToken)
  createdAt: string;
  expiresAt: string;
}

export interface LocalMcpTokenInfo {
  id: string;
  label: string;
  createdAt: string;
  expiresAt: string;
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function loadTokens(): StoredToken[] {
  const raw = getPreference<StoredToken[]>("localMcpTokens", []);
  return Array.isArray(raw) ? raw : [];
}

function saveTokens(tokens: StoredToken[]): void {
  setPreference("localMcpTokens", tokens);
}

/** Generate a token. The raw value is returned ONCE — only its hash is stored. */
export function localMcpGenToken(label: string = "default", ttlDays: number = TOKEN_TTL_DAYS): LocalMcpTokenInfo & { token: string } {
  const raw = `glyphh_${crypto.randomBytes(24).toString("hex")}`;
  const now = new Date();
  const expires = ttlDays > 0
    ? new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000)
    : new Date("9999-12-31T00:00:00.000Z");
  const rec: StoredToken = {
    id: crypto.randomBytes(8).toString("hex"),
    label: label.trim() || "default",
    hash: sha256(raw),
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
  };
  const tokens = loadTokens();
  tokens.push(rec);
  saveTokens(tokens);
  return { id: rec.id, label: rec.label, createdAt: rec.createdAt, expiresAt: rec.expiresAt, token: raw };
}

export function localMcpListTokens(): LocalMcpTokenInfo[] {
  return loadTokens().map((t) => ({ id: t.id, label: t.label, createdAt: t.createdAt, expiresAt: t.expiresAt }));
}

export function localMcpRevokeToken(id: string): void {
  saveTokens(loadTokens().filter((t) => t.id !== id));
}

function isValidBearer(raw: string | undefined): boolean {
  if (!raw) return false;
  const hash = sha256(raw);
  const now = Date.now();
  return loadTokens().some((t) => t.hash === hash && new Date(t.expiresAt).getTime() > now);
}

// ── MCP tool surface (mirrors the cloud relay's WS-routed tools) ───

function buildMcpServer(): McpServer {
  const mcp = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const via = async (method: string, params: unknown) => {
    try {
      const result = await dispatchRelayMethod(method, params);
      return { content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  };

  // ── Tasks + skills — Glyphh's OWN primitives, author-grade (the write
  //    path agents lacked: a pipeline built here lands in Glyphh's registry,
  //    schedulable and visible in the UI, not beside it) ─────────────────
  const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v) }] });
  mcp.tool(
    "agents_list",
    "The user's CLI-agent roster — the ONLY valid values for a task slot's agent binding and for task_run's agent override. Returns [{ id, name, cli, model, cwd }].",
    {},
    async () => text(listCliAgents().map((a) => ({ id: a.id, name: a.name, cli: a.cli, model: a.model ?? null, cwd: a.cwd ?? null }))),
  );
  mcp.tool(
    "tasks_list",
    "List the user's Glyphh TASKS. A task is a PROGRAM — a spec an agent authors and can rewrite; only the slots\u2192agents are fixed. Returns [{ slug, name, description, program, slots: [{ name, label?, agent }] }].",
    {},
    async () => text(listTaskSpecs()),
  );
  mcp.tool(
    "task_get",
    "Read one Glyphh task in full — its program (the spec) and its slots.",
    { slug: z.string().describe("Task slug from tasks_list") },
    async ({ slug }) => {
      try { return text(getTaskSpec(slug)); }
      catch (err) { return text(`Error: ${err instanceof Error ? err.message : String(err)}`); }
    },
  );
  mcp.tool(
    "task_save",
    "Create or update a Glyphh task. The program is the SPEC the slotted agent runs — write it freely (steps inside it can carry prompts or reference Glyphh skills via skill_get); the agent building the task owns its shape. slots are the FIXED cast: create ONE SLOT PER STAGE of the pipeline (e.g. plan/review/build), each bound to a real agent id from agents_list (null leaves it for the user to pick in the Tasks UI) — never collapse a multi-model pipeline into a single slot. Saved tasks appear in the Tasks UI, where the user schedules them on a cron or runs them one-off.",
    {
      slug: z.string().optional().describe("Existing task slug to update; omit to create"),
      name: z.string().describe("Task name"),
      description: z.string().optional(),
      program: z.string().optional().describe("The spec the slotted agent runs"),
      slots: z.array(z.object({
        name: z.string().optional(),
        label: z.string().optional(),
        description: z.string().optional().describe("What this slot is for"),
        agent: z.string().nullable().optional().describe("CLI-agent id bound to this slot (null = first agent)"),
        model: z.string().optional().describe("Model override for this slot (omit = the agent's own model)"),
      })).optional().describe("The fixed slots\u2192agents; omit to keep existing (default: one Main slot)"),
    },
    async (input) => {
      try { return text(saveTaskSpec(input)); }
      catch (err) { return text(`Error: ${err instanceof Error ? err.message : String(err)}`); }
    },
  );
  mcp.tool(
    "task_run",
    "Run a Glyphh task NOW — its program through the slotted agent's headless CLI. Returns { status, output }.",
    {
      slug: z.string().describe("Task slug from tasks_list"),
      agent: z.string().optional().describe("CLI-agent id override for this run"),
    },
    async ({ slug, agent }) => {
      try { return text(await runTaskNow(slug, agent)); }
      catch (err) { return text(`Error: ${err instanceof Error ? err.message : String(err)}`); }
    },
  );
  mcp.tool(
    "task_runs",
    "A Glyphh task's recent scheduled runs (newest first): { id, startedAt, durationMs, status, error, output }.",
    { slug: z.string().describe("Task slug") },
    async ({ slug }) => text(listTaskRunsFor(slug)),
  );
  mcp.tool(
    "skills_list",
    "List the user's Glyphh SKILLS — cross-agent instruction sets any CLI can read. Returns summaries; read one with skill_get.",
    {},
    async () => text(listSkillRows().map(({ prompt: _p, code: _c, manifest: _m, ...sum }) => sum)),
  );
  mcp.tool(
    "skill_get",
    "Read a Glyphh skill in full — its markdown instructions (prompt) are the payload.",
    { slug: z.string().describe("Skill slug from skills_list") },
    async ({ slug }) => {
      try { return text(getSkillRow(slug)); }
      catch (err) { return text(`Error: ${err instanceof Error ? err.message : String(err)}`); }
    },
  );
  mcp.tool(
    "skill_save",
    "Create or update a Glyphh skill (name, description, prompt = its markdown instructions). Saved skills appear in the Skills UI and are readable by EVERY CLI agent through skill_get.",
    {
      slug: z.string().optional().describe("Existing slug to update; omit to create"),
      name: z.string().describe("Skill name"),
      description: z.string().optional(),
      prompt: z.string().optional().describe("The skill's markdown instructions"),
    },
    async (input) => {
      try { return text(saveSkillRow(input)); }
      catch (err) { return text(`Error: ${err instanceof Error ? err.message : String(err)}`); }
    },
  );

  // ── Custom MCP connections — the user's own servers, aggregated ─────
  // ── Connected APPS (Pipedream Connect, server-executed) ──────────────
  // The org/personal connector reach (Gmail, Slack, 3,500 more) — governed
  // and METERED server-side; this lane just carries the call. Distinct from
  // connections_* below, which are the user's own LOCAL custom MCP servers.
  mcp.tool(
    "connector_tools",
    "The user's CONNECTED APPS (Gmail, Slack, Google Drive — 3,500+ via the org's connections) and each app's callable tools with input schemas. Governed server-side: this lists exactly what YOU may call. Invoke with connector_call.",
    {},
    async () => {
      const tools = getCatalogAge() < 5 * 60 * 1000 ? getConnectorCatalog() : await refreshConnectorCatalog();
      return text(tools.map((t) => ({ app: t.slug, tool: t.name, description: t.description, inputSchema: t.inputSchema })));
    },
  );
  mcp.tool(
    "connector_call",
    "Call one connected app's tool (from connector_tools). Executes on the Glyphh server under the org's governance — the account binding, allow-lists, and metering all apply there.",
    {
      app: z.string().describe("The connection slug (connector_tools 'app')"),
      tool: z.string().describe("The tool key to invoke"),
      props: z.record(z.string(), z.unknown()).optional().describe("The tool's arguments per its inputSchema"),
    },
    async ({ app, tool, props }) => {
      try { return text(await callConnectorTool(app, tool, props ?? {})); }
      catch (err) { return text(`Error: ${err instanceof Error ? err.message : String(err)}`); }
    },
  );
  mcp.tool(
    "connections_list_tools",
    "List the tools published by the user's CUSTOM MCP CONNECTIONS (their own servers, dialed locally). Returns [{ connection, name, description, inputSchema }]. Call one with connections_call_tool.",
    {},
    async () => {
      const tools = await listConnectionTools();
      return { content: [{ type: "text" as const, text: JSON.stringify(tools) }] };
    },
  );
  mcp.tool(
    "connections_call_tool",
    "Call a tool on one of the user's custom MCP connections (discover with connections_list_tools).",
    {
      connection: z.string().describe("Connection slug"),
      tool: z.string().describe("Tool name on that connection"),
      args: z.record(z.string(), z.unknown()).optional().describe("Tool arguments"),
    },
    async ({ connection, tool, args }) => {
      try {
        const r = await callConnectionTool(connection, tool, (args as Record<string, unknown>) || {});
        return { content: [{ type: "text" as const, text: typeof r === "string" ? r : JSON.stringify(r) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    },
  );

  mcp.tool(
    "relay_ping",
    "Smoke-test the local server: pings Glyphh and returns whatever it echoes. Use this to confirm the connection is alive before relying on panel tools.",
    { message: z.string().optional().describe("Optional message to echo back") },
    async ({ message }) => via("relay.ping", { message: message ?? "ping" }),
  );

  // ── Panel management ─────────────────────────────────
  mcp.tool(
    "panels_list",
    "List the user's OPEN app panels (see panels_available for everything that CAN be opened). Returns app (slug — the key every other panel tool takes), name, current url, page title, and which window is focused.",
    {},
    async () => via("panels.list", {}),
  );
  mcp.tool(
    "panels_switch",
    "Focus an open app's window. Use panels_list to see what's open.",
    { app: z.string().describe("App slug to focus") },
    async ({ app }) => via("panels.switch", { app }),
  );
  mcp.tool(
    "panels_close",
    "Close an app's window.",
    { app: z.string().describe("App slug to close") },
    async ({ app }) => via("panels.close", { app }),
  );
  mcp.tool(
    "panels_available",
    "List the user's SAVED APP LIBRARY — everything panels_open can open (slug, name, url, kind). When the user asks about a site or service (mail, calendar, a dashboard…), check here FIRST and open their saved app for it instead of driving the raw browser.",
    {},
    async () => via("panels.available", {}),
  );
  mcp.tool(
    "panels_open",
    "Open an app as a panel. `app` is a slug from panels_available (the user's saved app library — PREFER these over the raw browser when one matches the task), or 'browser' / 'terminal'. Re-opening an already-open app focuses it. Installed Glyphh apps MUST open this way (by slug) — a file:// URL in the browser panel gets no glyphh bridge and the app won't work.",
    { app: z.string().describe("App to open: a saved-app slug from panels_available, or 'browser' / 'terminal'") },
    async ({ app }) => via("panels.open", { app }),
  );
  mcp.tool(
    "layouts_open",
    "Open one of the user's saved layouts (a named grid of apps). mode 'window' (default) opens ONE window with the apps tiled inside it; mode 'screen' tiles the whole screen with one native window per app.",
    {
      name: z.string().describe("Saved layout name"),
      mode: z.enum(["window", "screen"]).optional().describe("'window' = tiled inside one window (default); 'screen' = OS-level tiling, one window per app"),
    },
    async ({ name, mode }) => via("layouts.open", { name, mode }),
  );

  // ── Installed Glyphh apps — discover / invoke / deploy ─
  mcp.tool(
    "app_list_tools",
    "List the MCP tools exposed by the user's installed Glyphh apps. Returns [{ app (slug), name, tools: [{ name, description, inputSchema }] }]. Call this to discover what THIS user's Glyphh can do, then invoke with app_call_tool.",
    {},
    async () => via("apps.listTools", {}),
  );
  mcp.tool(
    "app_call_tool",
    "Invoke a tool exposed by an installed Glyphh app. Pass the app slug + tool name from app_list_tools and an args object matching the tool's inputSchema. Runs headlessly on the user's machine.",
    {
      app: z.string().describe("App slug — from app_list_tools"),
      tool: z.string().describe("Tool name — from app_list_tools"),
      args: z.record(z.string(), z.unknown()).optional().describe("Tool arguments matching the tool's inputSchema"),
    },
    async ({ app, tool, args }) => via("apps.callTool", { app, tool, args: args || {} }),
  );
  mcp.tool(
    "app_install",
    "Install (or update) a Glyphh app on the user's machine from a .glyphh bundle so its tools become available. Pass the bundle as base64. Re-installing the same slug updates it in place. To show the app afterwards, call panels_open with its slug — NEVER open its index.html via a file:// URL in the browser panel: the glyphh bridge (glyphh.call, db.exec, its tools) only exists when the app opens through its slug.",
    { bundleBase64: z.string().describe("The .glyphh bundle (a zip) as a base64 string") },
    async ({ bundleBase64 }) => via("apps.install", { bundleBase64 }),
  );

  // ── The SEMANTIC STACK — every app's own vector store + knowledge graph
  //    (glyphh-agent-semantic.ts; restored 2026-09-14). The workpanel-app
  //    contract's data plane: loops discover, build, and query an app's
  //    stores through these six; scheduled tasks refresh them.
  const semantic = (name: string, shape: Record<string, z.ZodTypeAny>): void => {
    const def = SEMANTIC_TOOLS.find((t) => t.name === name)!;
    mcp.tool(name, def.doc, shape, async (a: Record<string, unknown>) => {
      try { return text(await def.run(a)); }
      catch (err) { return text(`Error: ${err instanceof Error ? err.message : String(err)}`); }
    });
  };
  const appArg = z.string().describe("Target app slug — the stores travel with the app");
  const collArg = z.string().describe("Vector collection name ([a-zA-Z0-9_-])");
  semantic("semantic_collections", { app: appArg });
  semantic("index_files", {
    app: appArg, collection: collArg,
    paths: z.array(z.string()).describe("Working-folder file paths (max 50, 1MB each)"),
    chunkChars: z.number().optional().describe("Chunk size in chars (200–4000, default 1500)"),
  });
  semantic("index_text", {
    app: appArg, collection: collArg,
    id: z.string().describe("Stable source id for these chunks"),
    text: z.string().describe("Raw text to chunk + embed"),
    chunkChars: z.number().optional(),
  });
  semantic("index_connection", {
    app: appArg, collection: collArg,
    slug: z.string().describe("Connection slug (from the user's connections)"),
    tool: z.string().describe("The connector tool to run"),
    props: z.record(z.string(), z.unknown()).optional().describe("Arguments for the connector tool"),
  });
  semantic("vector_search", {
    app: appArg, collection: collArg,
    query: z.string().describe("Semantic query text"),
    k: z.number().optional().describe("Top-k (1–50, default 8)"),
    filter: z.record(z.string(), z.unknown()).optional().describe("Exact-match metadata filter"),
  });
  semantic("graph_query", {
    app: appArg,
    cypher: z.string().describe("Cypher statement(s) — CREATE NODE TABLE first; Kuzu is schema-full"),
  });

  // ── RPA — drive an open app panel ────────────────────
  mcp.tool(
    "rpa_click",
    "Click inside an open app panel. Pass the panel `app` slug (from panels_list) and EITHER a CSS `selector` (clicked in-page) OR absolute `x`/`y` coordinates (a real input event). Open the panel first with panels_open.",
    { app: z.string(), selector: z.string().optional(), x: z.number().optional(), y: z.number().optional() },
    async (a) => via("rpa.click", a),
  );
  mcp.tool(
    "rpa_type",
    "Type into an element in an open app panel: focuses `selector`, sets its value, fires input/change. Set `submit` to also submit the surrounding form.",
    { app: z.string(), selector: z.string(), text: z.string(), submit: z.boolean().optional() },
    async (a) => via("rpa.type", a),
  );
  mcp.tool(
    "rpa_read",
    "Read text or HTML from an open app panel — a `selector`'s content, or the whole page when omitted. `as` is 'text' (default) or 'html'.",
    { app: z.string(), selector: z.string().optional(), as: z.enum(["text", "html"]).optional() },
    async (a) => via("rpa.read", a),
  );
  mcp.tool(
    "rpa_screenshot",
    "Capture the current frame of an open app panel as a PNG data URL.",
    { app: z.string() },
    async (a) => via("rpa.screenshot", a),
  );
  mcp.tool(
    "rpa_goto",
    "Navigate an open app panel to an http(s) URL.",
    { app: z.string(), url: z.string() },
    async (a) => via("rpa.goto", a),
  );

  // ── Run the user's automations / scrape ──────────────
  mcp.tool(
    "loop_run",
    "Run one of the user's saved loops on their machine and return its output.",
    { slug: z.string().describe("Loop slug"), input: z.record(z.string(), z.unknown()).optional() },
    async ({ slug, input }) => via("loops.run", { slug, input: input || {} }),
  );
  mcp.tool(
    "skill_run",
    "Run one of the user's saved skills on their machine and return its output.",
    { slug: z.string().describe("Skill slug"), input: z.record(z.string(), z.unknown()).optional() },
    async ({ slug, input }) => via("skills.run", { slug, input: input || {} }),
  );
  mcp.tool(
    "agent_run",
    "Fire a standing agent's scheduled task now, on the user's machine.",
    { agentId: z.string(), taskId: z.string() },
    async ({ agentId, taskId }) => via("agents.run", { agentId, taskId }),
  );
  mcp.tool(
    "scrape_page",
    "Load an http(s) URL headlessly on the user's machine and return its title, text, and html. `wait` (ms, ≤15000) delays extraction for JS-rendered pages.",
    { url: z.string(), wait: z.number().optional() },
    async ({ url, wait }) => via("scrape.page", { url, wait }),
  );

  return mcp;
}

// ── HTTP server lifecycle ──────────────────────────────────────────

let server: http.Server | null = null;
let boundPort = DEFAULT_PORT;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function setCors(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id, mcp-protocol-version");
}

function bearerFrom(req: http.IncomingMessage): string | undefined {
  const h = req.headers["authorization"];
  if (!h || Array.isArray(h)) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : undefined;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  setCors(res);
  const url = new URL(req.url || "/", `http://127.0.0.1:${boundPort}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check — unauthenticated, so users can curl to confirm it's up.
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/mcp")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ name: SERVER_NAME, version: SERVER_VERSION, status: "ok" }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/mcp") {
    if (!isValidBearer(bearerFrom(req))) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid or missing bearer token. Generate one in Settings > MCP > Local server." }));
      return;
    }
    let parsed: unknown;
    try {
      const body = await readBody(req);
      parsed = body ? JSON.parse(body) : undefined;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }
    // Stateless: a fresh server + transport per request (matches the cloud relay).
    const mcp = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close().catch(() => {}); });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}

/** Start the local MCP server on 127.0.0.1. Idempotent. */
export function startLocalMcpServer(): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    if (server) { resolve({ ok: true }); return; }
    const port = Number(getPreference("localMcpPort", DEFAULT_PORT)) || DEFAULT_PORT;
    const srv = http.createServer((req, res) => { void handle(req, res); });
    srv.on("error", (err: NodeJS.ErrnoException) => {
      server = null;
      const msg = err.code === "EADDRINUSE" ? `Port ${port} is already in use — pick another in Settings.` : err.message;
      console.error("[local-mcp] failed to start:", msg);
      resolve({ ok: false, error: msg });
    });
    srv.listen(port, "127.0.0.1", () => {
      server = srv;
      boundPort = port;
      console.log(`[local-mcp] listening on http://127.0.0.1:${port}/mcp`);
      resolve({ ok: true });
    });
  });
}

/** Stop the local MCP server. Idempotent. */
export function stopLocalMcpServer(): void {
  if (!server) return;
  try { server.close(); } catch { /* ignore */ }
  server = null;
  console.log("[local-mcp] stopped");
}

export function localMcpStatus(): { running: boolean; port: number } {
  const port = server ? boundPort : (Number(getPreference("localMcpPort", DEFAULT_PORT)) || DEFAULT_PORT);
  return { running: !!server, port };
}

/**
 * Reconcile the running server with the `localMcpEnabled` preference. Called at
 * boot and whenever the user toggles the setting.
 */
export async function syncLocalMcpServer(): Promise<{ ok: boolean; error?: string }> {
  const enabled = getPreference<boolean>("localMcpEnabled", true) !== false;
  if (enabled && !server) return startLocalMcpServer();
  if (!enabled && server) { stopLocalMcpServer(); return { ok: true }; }
  return { ok: true };
}
