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
 *
 * PIPEDREAM APPS (pipedream.ts) are connections here too, under the id
 * `pd:<app>`: one streamable-HTTP client per connected app at Pipedream's
 * MCP endpoint, dialed with a freshly minted bearer and re-dialed when that
 * token rotates or a call comes back 401. They are listed and called through
 * the same two functions, so every loop — Glyphh's catalog and the CLIs over
 * the local MCP server — reaches both kinds the same way.
 */

import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import { ipcMain, shell } from "electron";
import { userScopedPath } from "./app-paths.js";
import { effectiveToolMode, type ToolMode } from "./conn-tool-modes.js";
import { currentPdToken, invalidatePdToken, pdMcpAuth, pdToolApps } from "./pipedream.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationFull, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

const CONN_DIR = (): string => userScopedPath("connections");

type OAuthPreset = { clientId: string; clientSecret?: string };

/** A Pipedream app's connection id, and back. */
export const PD_PREFIX = "pd:";
export const pdConnectionId = (app: string): string => `${PD_PREFIX}${app}`;
const pdAppOf = (connection: string): string | null => connection.startsWith(PD_PREFIX) ? connection.slice(PD_PREFIX.length) : null;

/** The key a connection's tool permissions are stored under — the one the
 *  Connections page writes (`connToolModes:<key>`). */
export const connModeKey = (connection: string): string => pdAppOf(connection) !== null ? connection : `mcp:${connection}`;

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
  /** A pre-registered OAuth client the user typed in, used instead of dynamic registration. */
  oauth?: OAuthPreset;
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
export function listConnRows(): McpConnRow[] {
  let names: string[] = [];
  try { names = fs.readdirSync(CONN_DIR()).filter((n) => n.endsWith(".json") && !n.endsWith(".secrets.json")); }
  catch { return []; }
  const out: McpConnRow[] = [];
  for (const n of names) {
    const row = readRow(n.slice(0, -5));
    if (row) out.push(row);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** A slug no other connection holds: the name's, then `-2`, `-3`, … */
function freeSlug(name: string): string {
  const base = slugify(name);
  let slug = base;
  for (let n = 2; readRow(slug); n++) slug = `${base}-${n}`;
  return slug;
}

// ── OAuth 2.1 (the SDK drives discovery/registration/PKCE; we hold state,
//    open the browser, and catch the loopback redirect) ──────────────────────

const OAUTH_TIMEOUT_MS = 3 * 60 * 1000;

class LocalOAuthProvider implements OAuthClientProvider {
  authCode: Promise<string> | null = null;
  private server: http.Server | null = null;
  private port = 0;
  constructor(private readonly slug: string, private readonly preset?: OAuthPreset) {}

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

/** `token` is the Pipedream bearer a pd connection was dialed with. */
interface LiveConn { client: Client; close: () => Promise<void>; token?: string }
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

  const provider = new LocalOAuthProvider(row.slug, secrets.oauth ?? presetOf(secrets.clientInformation));
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

/** Rows saved before the preset had its own field kept the typed client as
 *  clientInformation with no redirect URIs; that is a preset, not a
 *  registration the server handed back. */
function presetOf(info: OAuthClientInformationFull | undefined): OAuthPreset | undefined {
  if (!info?.client_id || (Array.isArray(info.redirect_uris) && info.redirect_uris.length)) return undefined;
  return { clientId: info.client_id, ...(info.client_secret ? { clientSecret: info.client_secret } : {}) };
}

/** One Pipedream app's MCP server, with the bearer minted now. */
async function dialPipedream(app: string): Promise<LiveConn> {
  const auth = await pdMcpAuth(app);
  const client = new Client({ name: "glyphh-desktop", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(auth.url), { requestInit: { headers: auth.headers } }));
  return { client, close: () => client.close(), token: auth.token };
}

async function getLive(slug: string, interactive = false): Promise<LiveConn> {
  const have = live.get(slug);
  const app = pdAppOf(slug);
  if (app !== null) {
    // The bearer rides the headers fixed at dial: a rotated token re-dials.
    if (have && have.token === currentPdToken()) return have;
    if (have) await dropLive(slug);
    if (!pdToolApps().some((a) => a.app === app)) throw new Error(`no connected Pipedream account for "${app}"`);
    const conn = await dialPipedream(app);
    live.set(slug, conn);
    return conn;
  }
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

const isUnauthorized = (err: unknown): boolean =>
  err instanceof UnauthorizedError || (err as { code?: unknown })?.code === 401;

/** Run against a live connection. A Pipedream server that answers 401 has
 *  outlived its bearer: mint a new one, re-dial, and try once more. */
async function withLive<T>(slug: string, work: (conn: LiveConn) => Promise<T>, interactive = false): Promise<T> {
  try {
    return await work(await getLive(slug, interactive));
  } catch (err) {
    if (pdAppOf(slug) === null || !isUnauthorized(err)) throw err;
    invalidatePdToken();
    await dropLive(slug);
    return work(await getLive(slug));
  }
}

/** Every connection the tools come from: the enabled custom servers and the
 *  connected Pipedream apps that are turned on. */
export function connectionSources(): Array<{ connection: string; label: string; hidden: string[] }> {
  return [
    ...listConnRows().filter((r) => r.enabled).map((r) => ({ connection: r.slug, label: r.name, hidden: r.hiddenTools })),
    ...pdToolApps().map((a) => ({ connection: pdConnectionId(a.app), label: a.name, hidden: [] as string[] })),
  ];
}

/** Is there anything to lend? Synchronous and offline: the custom rows and
 *  the last Pipedream account list read. */
export const hasConnections = (): boolean => connectionSources().length > 0;

export interface ConnTool {
  connection: string;
  /** The connection's display name ("Gmail", "My CRM"). */
  label: string;
  name: string;
  description: string;
  inputSchema: unknown;
  /** What the user allowed (conn-tool-modes.ts); a Never tool is never listed. */
  mode: Exclude<ToolMode, "never">;
}

/** One connection's tools as its server publishes them. */
export async function connectionTools(connection: string, interactive = false): Promise<Array<{ name: string; description: string; inputSchema: unknown }>> {
  const res = await withLive(connection, (conn) => conn.client.listTools(), interactive);
  return res.tools.map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema }));
}

/** Every EXPOSED tool across enabled connections: a hidden or Never tool is
 *  left out, and each carries the mode it runs under. */
export async function listConnectionTools(): Promise<ConnTool[]> {
  const out: ConnTool[] = [];
  for (const src of connectionSources()) {
    try {
      const key = connModeKey(src.connection);
      for (const t of await connectionTools(src.connection)) {
        if (src.hidden.includes(t.name)) continue;
        const mode = effectiveToolMode(key, t.name);
        if (mode === "never") continue;
        out.push({ connection: src.connection, label: src.label, name: t.name, description: t.description, inputSchema: t.inputSchema, mode });
      }
    } catch { /* unreachable connection — its tools just don't appear */ }
  }
  return out;
}

export async function callConnectionTool(slug: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const app = pdAppOf(slug);
  if (app === null) {
    const row = readRow(slug);
    if (!row) throw new Error(`connection "${slug}" not found`);
    if (row.hiddenTools.includes(tool)) throw new Error(`tool "${tool}" is hidden on this connection`);
  } else if (!pdToolApps().some((a) => a.app === app)) {
    throw new Error(`no connected Pipedream account for "${app}" — connect it in Settings › Connections`);
  }
  if (effectiveToolMode(connModeKey(slug), tool) === "never") throw new Error(`tool "${tool}" is set to Never on this connection`);
  return withLive(slug, (conn) => conn.client.callTool({ name: tool, arguments: args }));
}

/** Close a connection's live client so the next call dials it fresh — after a
 *  Pipedream account is added, removed or switched. */
export async function resetConnection(connection: string): Promise<void> { await dropLive(connection); }

// ── IPC — the exact lanes the main-era page rides ────────────────────────────

export function registerMcpConnectionsIpc(): void {
  // Local machine, user's own servers — always allowed.
  ipcMain.handle("mcp-custom-allowed", () => ({ allowed: true }));

  ipcMain.handle("mcp-connections-list", () => ({ ok: true, connections: listConnRows() }));

  ipcMain.handle("mcp-connections-create", async (_e, fields: { name: string; url: string; headers?: Record<string, string>; oauth?: { clientId: string; clientSecret?: string } }) => {
    try {
      const name = String(fields?.name ?? "").trim();
      const url = String(fields?.url ?? "").trim();
      if (!name || !url) return { ok: false, error: "name and server URL (or command) are required" };
      const headers = fields.headers && typeof fields.headers === "object" ? fields.headers : {};
      const slug = freeSlug(name);
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
        ...(fields.oauth?.clientId ? { oauth: { clientId: String(fields.oauth.clientId).trim(), ...(fields.oauth.clientSecret ? { clientSecret: String(fields.oauth.clientSecret).trim() } : {}) } } : {}),
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
      if (fields.name !== undefined) row.name = String(fields.name);
      if (fields.url !== undefined && String(fields.url).trim()) row.url = String(fields.url).trim();
      if (fields.enabled !== undefined) row.enabled = fields.enabled !== false;
      if (Array.isArray(fields.hiddenTools)) row.hiddenTools = fields.hiddenTools.map(String);
      if (fields.headers && typeof fields.headers === "object" && Object.keys(fields.headers as object).length) {
        // Header values are write-only: they live in the 0600 secrets file.
        const sec = readSecrets(row.slug);
        sec.headers = fields.headers as Record<string, string>;
        writeSecrets(row.slug, sec);
        row.headerKeys = Object.keys(fields.headers as object);
      }
      writeRow(row);
      await dropLive(row.slug);   // config changed — the next call re-dials
      return { ok: true, connection: row };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("mcp-connections-delete", async (_e, slug: string) => {
    try {
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
      const tools = await connectionTools(row.slug, true);
      return {
        ok: true,
        tools: tools.map((t) => ({ name: t.name, description: t.description, hidden: row.hiddenTools.includes(t.name) })),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), tools: [] };
    }
  });
}

export function closeMcpConnections(): void {
  for (const slug of [...live.keys()]) void dropLive(slug);
}
