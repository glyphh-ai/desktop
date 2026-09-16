/**
 * mcp-connections.ts — CUSTOM MCP CONNECTIONS, local (the build, 2026-09-10).
 *
 * The main-era Connections UX returns, but the execution moved HERE: this
 * machine dials the servers directly and re-exposes their tools through the
 * local Glyphh MCP server, so every CLI agent sees them as glyphh tools.
 *
 *   ~/.glyphh/connections/<slug>.json          — the row (name, url, headerKeys,
 *                                                enabled, hiddenTools)
 *   ~/.glyphh/connections/<slug>.secrets.json  — 0600: header VALUES, the OAuth
 *                                                client info + tokens + verifier
 *
 * Transports: streamable HTTP first, SSE fallback (a URL), or STDIO when the
 * "URL" has no scheme (a command line). AUTH is the spec's own dance — on 401
 * the SDK's OAuth 2.1 client discovers/registers, the browser opens, and a
 * loopback listener catches the code; headers under Advanced stay write-only.
 */

import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import { ipcMain, shell } from "electron";
import { getClient } from "./glyphh-client.js";
import { userScopedPath } from "./app-paths.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationFull, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

const CONN_DIR = (): string => userScopedPath("connections");

export interface McpConnRow {
  slug: string;
  name: string;
  url: string;
  headerKeys: string[];
  enabled: boolean;
  hiddenTools: string[];
  createdAt: string;
  kind: "personal";
  iconUrl: null;
}
interface ConnSecrets {
  headers?: Record<string, string>;
  clientInformation?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

const rowFile = (slug: string): string => path.join(CONN_DIR(), `${slug}.json`);
const secretsFile = (slug: string): string => path.join(CONN_DIR(), `${slug}.secrets.json`);
const slugify = (name: string): string =>
  name.trim().toLowerCase().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "mcp";

function readRow(slug: string): McpConnRow | null {
  try { return JSON.parse(fs.readFileSync(rowFile(slug), "utf-8")) as McpConnRow; }
  catch { return null; }
}
function writeRow(row: McpConnRow): void {
  fs.mkdirSync(CONN_DIR(), { recursive: true });
  fs.writeFileSync(rowFile(row.slug), JSON.stringify(row, null, 2), "utf-8");
}
function readSecrets(slug: string): ConnSecrets {
  try { return JSON.parse(fs.readFileSync(secretsFile(slug), "utf-8")) as ConnSecrets; }
  catch { return {}; }
}
function writeSecrets(slug: string, sec: ConnSecrets): void {
  fs.mkdirSync(CONN_DIR(), { recursive: true });
  fs.writeFileSync(secretsFile(slug), JSON.stringify(sec, null, 2), { encoding: "utf-8", mode: 0o600 });
}
/**
 * THE SERVER IS THE SOURCE OF TRUTH (his ruling, 2026-09-12: "loops and
 * connections are server side only. Nothing local").
 *
 * Every custom-MCP read and write goes through the SDK to
 * /api/connections/personal/mcp. The files under ~/.glyphh/connections are a
 * CACHE for dialing while offline, plus the home of OAuth token state, which
 * is per-machine by nature. Nothing is authored locally.
 */
async function syncFromServer(): Promise<McpConnRow[]> {
  const remote = await getClient().connections.personalMcpList();
  const rows: McpConnRow[] = remote.map((c) => ({
    slug: c.slug,
    name: c.name,
    url: c.url,
    headerKeys: c.headerKeys ?? [],
    enabled: c.enabled !== false,
    // The wire row carries neither of these: tool caps are the caller's own
    // (connections.personalToolCaps) and createdAt is cache-local ordering.
    hiddenTools: readRow(c.slug)?.hiddenTools ?? [],
    createdAt: readRow(c.slug)?.createdAt ?? new Date().toISOString(),
    kind: "personal",
    iconUrl: null,
  }));
  for (const r of rows) writeRow(r);
  return rows;
}

export function listConnRows(): McpConnRow[] {
  let names: string[] = [];
  try { names = fs.readdirSync(CONN_DIR()).filter((n) => n.endsWith(".json") && !n.endsWith(".secrets.json")); }
  catch { return []; }
  const out: McpConnRow[] = [];
  for (const n of names) {
    const row = readRow(n.slice(0, -5));
    if (row) out.push(row);
  }
  return out;
}

// ── OAuth 2.1 (the SDK drives discovery/registration/PKCE; we hold state,
//    open the browser, and catch the loopback redirect) ──────────────────────

const OAUTH_TIMEOUT_MS = 3 * 60 * 1000;

class LocalOAuthProvider implements OAuthClientProvider {
  authCode: Promise<string> | null = null;
  private server: http.Server | null = null;
  private port = 0;
  constructor(private readonly slug: string, private readonly preset?: { clientId: string; clientSecret?: string }) {}

  get redirectUrl(): string { return `http://127.0.0.1:${this.port}/callback`; }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Glyphh Desktop",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.preset?.clientSecret ? "client_secret_post" : "none",
    };
  }
  clientInformation(): OAuthClientInformationFull | undefined {
    if (this.preset?.clientId) {
      return { client_id: this.preset.clientId, ...(this.preset.clientSecret ? { client_secret: this.preset.clientSecret } : {}), redirect_uris: [this.redirectUrl] } as OAuthClientInformationFull;
    }
    return readSecrets(this.slug).clientInformation;
  }
  saveClientInformation(info: OAuthClientInformationFull): void {
    const sec = readSecrets(this.slug);
    sec.clientInformation = info;
    writeSecrets(this.slug, sec);
  }
  tokens(): OAuthTokens | undefined { return readSecrets(this.slug).tokens; }
  saveTokens(tokens: OAuthTokens): void {
    const sec = readSecrets(this.slug);
    sec.tokens = tokens;
    writeSecrets(this.slug, sec);
  }
  saveCodeVerifier(v: string): void {
    const sec = readSecrets(this.slug);
    sec.codeVerifier = v;
    writeSecrets(this.slug, sec);
  }
  codeVerifier(): string {
    const v = readSecrets(this.slug).codeVerifier;
    if (!v) throw new Error("no code verifier saved");
    return v;
  }
  /** Start the loopback listener, then hand the browser the auth URL. */
  async prepare(): Promise<void> {
    if (this.server) return;
    await new Promise<void>((resolve) => {
      this.server = http.createServer((req, res) => {
        const url = new URL(req.url || "/", `http://127.0.0.1:${this.port}`);
        if (url.pathname !== "/callback") { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body style='font-family:sans-serif'>Connected — you can close this window and return to Glyphh.</body></html>");
        this.resolveCode?.(url.searchParams.get("code") || "");
      });
      this.server.listen(0, "127.0.0.1", () => {
        this.port = (this.server!.address() as { port: number }).port;
        resolve();
      });
    });
    this.authCode = new Promise<string>((resolve, reject) => {
      this.resolveCode = resolve;
      setTimeout(() => reject(new Error("sign-in timed out — try connecting again")), OAUTH_TIMEOUT_MS);
    });
  }
  private resolveCode: ((code: string) => void) | null = null;
  redirectToAuthorization(url: URL): void { void shell.openExternal(url.toString()); }
  close(): void {
    try { this.server?.close(); } catch { /* down */ }
    this.server = null;
  }
}

// ── Connecting — live clients, one per enabled connection ────────────────────

interface LiveConn { client: Client; close: () => Promise<void> }
const live = new Map<string, LiveConn>();

const isUrl = (s: string): boolean => /^https?:\/\//i.test(s);

async function dial(row: McpConnRow, interactive: boolean): Promise<LiveConn> {
  const secrets = readSecrets(row.slug);
  const headers = secrets.headers ?? {};
  const client = new Client({ name: "glyphh-desktop", version: "1.0.0" });

  if (!isUrl(row.url)) {
    // STDIO — the "URL" is a command line.
    const parts = row.url.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((p) => p.replace(/^"|"$/g, "")) ?? [];
    if (!parts.length) throw new Error("stdio connections need a command");
    const transport = new StdioClientTransport({ command: parts[0]!, args: parts.slice(1), env: { ...process.env as Record<string, string> } });
    await client.connect(transport);
    return { client, close: () => client.close() };
  }

  const provider = new LocalOAuthProvider(row.slug);
  const attempt = async (kind: "http" | "sse"): Promise<void> => {
    const mk = (): StreamableHTTPClientTransport | SSEClientTransport => kind === "http"
      ? new StreamableHTTPClientTransport(new URL(row.url), { authProvider: provider, requestInit: { headers } })
      : new SSEClientTransport(new URL(row.url), { authProvider: provider, requestInit: { headers } });
    let transport = mk();
    try {
      await client.connect(transport);
    } catch (err) {
      if (err instanceof UnauthorizedError && interactive) {
        // The spec's own sign-in: browser + loopback, then finish the dance.
        await provider.prepare();
        try {
          const code = await provider.authCode!;
          if (!code) throw new Error("sign-in was cancelled");
          await transport.finishAuth(code);
        } finally {
          provider.close();
        }
        transport = mk();
        await client.connect(transport);
        return;
      }
      throw err;
    }
  };

  try {
    await attempt("http");
  } catch (err) {
    if (err instanceof UnauthorizedError) throw new Error("this server requires sign-in — open the connection and hit Save to connect");
    // Older servers speak SSE only — fall back before giving up.
    await attempt("sse");
  }
  return { client, close: () => client.close() };
}

async function getLive(slug: string, interactive = false): Promise<LiveConn> {
  const have = live.get(slug);
  if (have) return have;
  const row = readRow(slug);
  if (!row) throw new Error(`connection "${slug}" not found`);
  if (!row.enabled) throw new Error("connection is disabled");
  const conn = await dial(row, interactive);
  live.set(slug, conn);
  return conn;
}

async function dropLive(slug: string): Promise<void> {
  const have = live.get(slug);
  live.delete(slug);
  if (have) { try { await have.close(); } catch { /* closing */ } }
}

// ── The aggregation surface the local MCP server serves ──────────────────────

export interface ConnTool { connection: string; name: string; description: string; inputSchema: unknown }

/** Every EXPOSED tool across enabled connections (hidden ones filtered). */
export async function listConnectionTools(): Promise<ConnTool[]> {
  const out: ConnTool[] = [];
  for (const row of listConnRows()) {
    if (!row.enabled) continue;
    try {
      const conn = await getLive(row.slug);
      const res = await conn.client.listTools();
      for (const t of res.tools) {
        if (row.hiddenTools.includes(t.name)) continue;
        out.push({ connection: row.slug, name: t.name, description: t.description ?? "", inputSchema: t.inputSchema });
      }
    } catch { /* unreachable connection — its tools just don't appear */ }
  }
  return out;
}

export async function callConnectionTool(slug: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const row = readRow(slug);
  if (!row) throw new Error(`connection "${slug}" not found`);
  if (row.hiddenTools.includes(tool)) throw new Error(`tool "${tool}" is hidden on this connection`);
  const conn = await getLive(slug);
  return conn.client.callTool({ name: tool, arguments: args });
}

// ── IPC — the exact lanes the main-era page rides ────────────────────────────

export function registerMcpConnectionsIpc(): void {
  // Local machine, user's own servers — always allowed.
  ipcMain.handle("mcp-custom-allowed", () => ({ allowed: true }));

  ipcMain.handle("mcp-connections-list", async () => {
    try { return { ok: true, connections: await syncFromServer() }; }
    catch (err) {
      // Offline (or signed out): serve the cache rather than an empty page.
      console.warn("[mcp] server list failed, using cache:", err instanceof Error ? err.message : err);
      return { ok: true, connections: listConnRows() };
    }
  });

  // The org catalog died with the server — an honest empty list.
  ipcMain.handle("mcp-connections-catalog", () => ({ ok: true, connections: [] }));
  ipcMain.handle("mcp-connections-install", () => ({ ok: false, error: "the org catalog is retired — add servers directly with + Custom MCP" }));

  ipcMain.handle("mcp-connections-create", async (_e, fields: { name: string; url: string; headers?: Record<string, string>; oauth?: { clientId: string; clientSecret?: string } }) => {
    try {
      const name = String(fields?.name ?? "").trim();
      const url = String(fields?.url ?? "").trim();
      if (!name || !url) return { ok: false, error: "name and server URL (or command) are required" };
      const headers = fields.headers && typeof fields.headers === "object" ? fields.headers : {};
      // THE SERVER mints the row (and probes the endpoint). The local copy is
      // only the offline cache written from its answer.
      const wanted = slugify(name);
      const created = await getClient().connections.personalMcpCreate({
        slug: wanted, name, url, ...(Object.keys(headers).length ? { headers } : {}),
      });
      const slug = (created as { connection?: { slug?: string } }).connection?.slug ?? wanted;
      const row: McpConnRow = {
        slug, name, url,
        headerKeys: Object.keys(headers),
        enabled: true, hiddenTools: [],
        createdAt: new Date().toISOString(),
        kind: "personal", iconUrl: null,
      };
      writeRow(row);
      writeSecrets(slug, {
        headers,
        ...(fields.oauth?.clientId ? { clientInformation: { client_id: fields.oauth.clientId, ...(fields.oauth.clientSecret ? { client_secret: fields.oauth.clientSecret } : {}), redirect_uris: [] } as OAuthClientInformationFull } : {}),
      });
      // The connect TEST — interactive: a 401 opens the browser sign-in.
      const conn = await dial(row, true);
      live.set(slug, conn);
      const tools = await conn.client.listTools();
      return { ok: true, connection: { slug, name }, toolCount: tools.tools.length };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("mcp-connections-update", async (_e, slug: string, fields: Record<string, unknown>) => {
    try {
      const row = readRow(String(slug));
      if (!row) return { ok: false, error: "connection not found" };
      // THE SERVER takes the edit; the cache follows its answer.
      const patch: Record<string, unknown> = {};
      if (fields.name !== undefined) { row.name = String(fields.name); patch.name = row.name; }
      if (fields.url !== undefined && String(fields.url).trim()) { row.url = String(fields.url).trim(); patch.url = row.url; }
      if (fields.enabled !== undefined) { row.enabled = fields.enabled !== false; patch.enabled = row.enabled; }
      if (Array.isArray(fields.hiddenTools)) { row.hiddenTools = fields.hiddenTools.map(String); patch.hiddenTools = row.hiddenTools; }
      if (fields.headers && typeof fields.headers === "object" && Object.keys(fields.headers as object).length) {
        // Secrets stay sealed on the server; the local copy is what dials
        // while offline, so both are written.
        const sec = readSecrets(row.slug);
        sec.headers = fields.headers as Record<string, string>;
        writeSecrets(row.slug, sec);
        row.headerKeys = Object.keys(fields.headers as object);
        patch.headers = fields.headers;
      }
      await getClient().connections.personalMcpUpdate(row.slug, patch as never);
      writeRow(row);
      await dropLive(row.slug);   // config changed — the next call re-dials
      return { ok: true, connection: row };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("mcp-connections-delete", async (_e, slug: string) => {
    try {
      await getClient().connections.personalMcpRemove(String(slug));
      await dropLive(String(slug));
      fs.rmSync(rowFile(String(slug)), { force: true });
      fs.rmSync(secretsFile(String(slug)), { force: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("mcp-connections-tools", async (_e, slug: string) => {
    try {
      const row = readRow(String(slug));
      if (!row) return { ok: false, error: "connection not found", tools: [] };
      const conn = await getLive(row.slug, true);
      const res = await conn.client.listTools();
      return {
        ok: true,
        tools: res.tools.map((t) => ({ name: t.name, description: t.description ?? "", hidden: row.hiddenTools.includes(t.name) })),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), tools: [] };
    }
  });
}

export function closeMcpConnections(): void {
  for (const slug of [...live.keys()]) void dropLive(slug);
}
