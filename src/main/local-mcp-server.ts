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
import { getPreference, setPreference } from "./preferences.js";
import { dispatchRelayMethod } from "./relay-client.js";

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

  mcp.tool(
    "relay_ping",
    "Smoke-test the local server: pings Glyphh and returns whatever it echoes. Use this to confirm the connection is alive before relying on panel / RPA tools.",
    { message: z.string().optional().describe("Optional message to echo back") },
    async ({ message }) => via("relay.ping", { message: message ?? "ping" }),
  );

  // ── Panel management ─────────────────────────────────
  mcp.tool(
    "panels_list",
    "List the user's open app windows. Returns app (slug — the key every other panel/RPA tool takes), name, current url, page title, and which window is focused.",
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
    "panels_open",
    "Open an app in its own native window on the user's machine. `app` is 'browser', 'terminal', or a slug from the user's saved app library (the same apps the platform's Apps page manages). Re-opening an already-open app focuses its window.",
    { app: z.string().describe("App to open: 'browser', 'terminal', or a saved-app slug") },
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

  // ── RPA — drive a panel's webContents ───────────────
  mcp.tool(
    "rpa_click",
    "Click an element in an open app matched by CSS selector. Throws if no match or the element is hidden.",
    {
      app: z.string().describe("Target app slug (see panels_list)"),
      selector: z.string().describe("CSS selector for the element to click"),
    },
    async ({ app, selector }) => via("rpa.click", { app, selector }),
  );
  mcp.tool(
    "rpa_type",
    "Type text into an input / textarea / contenteditable in an open app. Sets the value and dispatches input + change so frameworks pick it up.",
    {
      app: z.string().describe("Target app slug (see panels_list)"),
      selector: z.string().describe("CSS selector for the input"),
      text: z.string().describe("Text to type"),
    },
    async ({ app, selector, text }) => via("rpa.type", { app, selector, text }),
  );
  mcp.tool(
    "rpa_read",
    "Read text content (or a specific attribute) from an element in an open app.",
    {
      app: z.string().describe("Target app slug (see panels_list)"),
      selector: z.string().describe("CSS selector for the element"),
      attr: z.string().optional().describe("Optional attribute name; omit for innerText / value"),
    },
    async ({ app, selector, attr }) => via("rpa.read", { app, selector, attr }),
  );
  mcp.tool(
    "rpa_screenshot",
    "Capture a screenshot of an open app as a base64 PNG data URL. Use when text extraction isn't enough.",
    { app: z.string().describe("Target app slug (see panels_list)") },
    async ({ app }) => via("rpa.screenshot", { app }),
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
    "Install (or update) a Glyphh app on the user's machine from a .glyphh bundle so its tools become available. Pass the bundle as base64. Re-installing the same slug updates it in place.",
    { bundleBase64: z.string().describe("The .glyphh bundle (a zip) as a base64 string") },
    async ({ bundleBase64 }) => via("apps.install", { bundleBase64 }),
  );

  // ── Local MCP servers via the client ─────────────────
  mcp.tool(
    "local_mcp_list_tools",
    "List tools from MCP servers the user is running locally (custom dev MCPs, local-file tools, etc.).",
    {},
    async () => via("mcp.list_tools", {}),
  );
  mcp.tool(
    "local_mcp_call_tool",
    "Invoke a tool on a user's local MCP server. Pass serverId + name from local_mcp_list_tools.",
    {
      serverId: z.string().describe("MCP server id"),
      name: z.string().describe("Tool name"),
      args: z.record(z.string(), z.unknown()).optional().describe("Tool arguments"),
    },
    async ({ serverId, name, args }) => via("mcp.call_tool", { serverId, name, args: args || {} }),
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
  const enabled = getPreference<boolean>("localMcpEnabled", false) === true;
  if (enabled && !server) return startLocalMcpServer();
  if (!enabled && server) { stopLocalMcpServer(); return { ok: true }; }
  return { ok: true };
}
