/**
 * harness-mcp-bridge.ts — the desktop's tool surface, lent to the LOCAL
 * HARNESS POD over loopback MCP.
 *
 * When a tool-bearing turn runs on the pod (glyphh-harness-run.ts) instead of
 * in this process, the loop lives outside Electron — but the TOOLS must not.
 * `open_app`, `update_app`, `run_command`, the connector wire tools, Ada: every
 * one of them touches this machine, this user's session, this window. So the
 * pod is lent them: rrotor's `POST /run` takes `mcpServers` (validated
 * loopback-or-https, name `^[a-z0-9_-]{1,32}$`, never `glyphh`, max 4), and
 * this module is the server behind that entry. Every call arrives here, is
 * gated by `executeGlyphhTool` exactly as the in-process path gates it, and
 * runs in the SESSION'S OWN WORKDIR — the user's real folder.
 *
 * DELIBERATELY NOT `local-mcp-server.ts`. That one is the user's OPT-IN
 * endpoint for foreign clients (Claude Desktop, Cursor): a fixed port,
 * long-lived hashed tokens, gated behind the `localMcpEnabled` preference —
 * turning it
 * on to run our own agent would silently open the machine to every other MCP
 * client on it. This bridge is the opposite: an ephemeral 127.0.0.1:0 listener
 * with a per-RUN random bearer, alive only while runs are registered, exposing
 * the AGENT's toolset (not the relay's), and requiring no preference at all.
 *
 * Auth: the bearer IS the run handle. A token maps to exactly one live run's
 * {webContents, workdir, abort signal, tool defs}; when the run ends the token
 * is dropped and the listener closes with the last one. A stale or unknown
 * bearer gets 401 with no hint of what else is listening.
 */

import http from "node:http";
import { randomBytes } from "node:crypto";
import type { WebContents } from "electron";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { executeGlyphhTool, type ConnectorWireDef } from "./glyphh-agent-tools";

/** The lent server's name on the wire. rrotor rejects `glyphh` (its own
 *  in-process ask_user server) and anything outside ^[a-z0-9_-]{1,32}$. */
export const BRIDGE_SERVER_NAME = "desktop";

/** The SDK's tool prefix for this server — the pod's frames name lent tools
 *  `mcp__desktop__<tool>`, which the run translator uses to tell OUR tool
 *  activity (reported here, in full fidelity) from the pod's own. */
export const BRIDGE_TOOL_PREFIX = `mcp__${BRIDGE_SERVER_NAME}__`;

/** What the renderer's `glyphh-agent:tool` channel carries (sdkRun's shape). */
export interface BridgeToolEvent {
  phase: "start" | "done";
  name: string;
  title?: string;
  denied?: boolean;
  failed?: boolean;
  preview?: string;
}

export interface LendOptions {
  /** The panel the tools act on (approval cards, ask dock, panel tools). */
  wc: WebContents;
  /** The run's abort signal — a stopped run must not leave a tool running. */
  signal: AbortSignal;
  /** The SESSION's folder. This is what makes lent tools operate on the user's
   *  real project rather than anything pod-side. */
  workdir?: string;
  /** Builtin tool defs for the run's mode (glyphhToolDefs). */
  defs: Array<{ name: string; doc: string }>;
  /** Connector tools with their real catalog schemas. */
  connDefs: ConnectorWireDef[];
  /** Tool activity, reported with the same payloads sdkRun emits. */
  onTool: (event: BridgeToolEvent) => void;
}

/** A live lend: the pod-facing reference plus its release. */
export interface LentSurface {
  name: string;
  url: string;
  headers: Record<string, string>;
  release: () => void;
}

const runs = new Map<string, LendOptions>();
let server: http.Server | null = null;
let boundPort = 0;

// ── HTTP plumbing ──────────────────────────────────────────────────────────

function bearerFrom(req: http.IncomingMessage): string {
  const h = req.headers["authorization"];
  if (!h || Array.isArray(h)) return "";
  return /^Bearer\s+(.+)$/i.exec(h)?.[1]?.trim() ?? "";
}

function readBody(req: http.IncomingMessage, limit = 8_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(payload);
}

/**
 * The MCP surface for ONE run. Stateless (a fresh server + transport per POST,
 * like the relay's local endpoint): the run's identity rides the bearer, so
 * there is no MCP session to keep.
 */
function buildServer(run: LendOptions): McpServer {
  const mcp = new McpServer({ name: BRIDGE_SERVER_NAME, version: "1.0.0" }, { capabilities: { tools: {} } });
  mcp.server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({
      tools: [
        // Builtins ride as open objects described by each tool's doc line —
        // the executor validates (same contract as the in-process path).
        ...run.defs.map((d) => ({
          name: d.name,
          description: d.doc,
          inputSchema: { type: "object" as const, additionalProperties: true },
        })),
        ...run.connDefs.map((d) => ({
          name: d.name,
          description: d.description,
          inputSchema: d.inputSchema as { type: "object"; [k: string]: unknown },
        })),
      ],
    }),
  );
  mcp.server.setRequestHandler(CallToolRequestSchema, async (rq) => {
    const name = String(rq.params.name || "");
    const args = (rq.params.arguments ?? {}) as Record<string, unknown>;
    run.onTool({ phase: "start", name });
    const outcome = await executeGlyphhTool(
      run.wc,
      { name, arguments: args },
      run.signal,
      run.workdir ? { workdir: run.workdir } : undefined,
    );
    const failed = outcome.result.startsWith("ERROR");
    run.onTool({
      phase: "done",
      name,
      title: outcome.title,
      denied: outcome.denied,
      failed,
      // Errors keep enough of the message to actually diagnose — a 160-char
      // preview ate API error bodies right where the reason starts.
      preview: outcome.result.slice(0, failed ? 600 : 160),
    });
    // A DENIAL is an error to the MODEL (it must re-plan), even though it is
    // not a tool failure. Marking it lets the pod's own frame translation
    // agree with ours instead of reading a refusal as a success.
    return {
      content: [{ type: "text" as const, text: outcome.result }],
      isError: failed || outcome.denied,
    };
  });
  return mcp;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const path = (req.url ?? "/").split("?", 1)[0];
  if (path !== "/mcp") { sendJson(res, 404, { error: "not-found" }); return; }
  // Stateless streamable-HTTP: POST only. Answering GET with 405 tells the
  // client's SSE probe to stop asking instead of hanging on an open stream.
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST", "content-type": "application/json" });
    res.end(JSON.stringify({ error: "method-not-allowed" }));
    return;
  }
  const run = runs.get(bearerFrom(req));
  if (!run) { sendJson(res, 401, { error: "unauthorized" }); return; }

  let parsed: unknown;
  try {
    const body = await readBody(req);
    parsed = body ? JSON.parse(body) : undefined;
  } catch {
    sendJson(res, 400, { error: "invalid-json" });
    return;
  }
  const mcp = buildServer(run);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { void transport.close().catch(() => { /* already closed */ }); });
  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res, parsed);
  } catch (err) {
    console.error("[harness-mcp] request failed:", err instanceof Error ? err.message : String(err));
    if (!res.headersSent) sendJson(res, 500, { error: "bridge-error" });
  }
}

/** Bring the loopback listener up on an EPHEMERAL port. Idempotent. */
function ensureListener(): Promise<number> {
  if (server && boundPort) return Promise.resolve(boundPort);
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => { void handle(req, res); });
    srv.on("error", (err) => { server = null; boundPort = 0; reject(err); });
    // 127.0.0.1 only — the bind IS the security boundary, same law the pod
    // follows when it runs auth-off.
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      if (!port) { srv.close(); reject(new Error("could not allocate a bridge port")); return; }
      server = srv;
      boundPort = port;
      console.log(`[harness-mcp] lending the desktop tool surface on http://127.0.0.1:${port}/mcp`);
      resolve(port);
    });
  });
}

/**
 * Lend one run the desktop tool surface. Returns the `mcpServers[]` entry to
 * put in the pod's run body, plus the release that revokes the bearer (and
 * closes the listener when it was the last one).
 */
export async function lendToolSurface(opts: LendOptions): Promise<LentSurface> {
  const port = await ensureListener();
  const token = randomBytes(24).toString("hex");
  runs.set(token, opts);
  let released = false;
  return {
    name: BRIDGE_SERVER_NAME,
    url: `http://127.0.0.1:${port}/mcp`,
    headers: { authorization: `Bearer ${token}` },
    release: () => {
      if (released) return;
      released = true;
      runs.delete(token);
      if (runs.size === 0) closeBridge();
    },
  };
}

/** Drop the listener (no live lends). Also the shutdown path. */
export function closeBridge(): void {
  if (!server) return;
  try { server.close(); } catch { /* already closing */ }
  server = null;
  boundPort = 0;
}

/** For diagnostics/tests: is anything lent right now, and where. */
export function bridgeStatus(): { running: boolean; port: number; lends: number } {
  return { running: !!server, port: boundPort, lends: runs.size };
}
