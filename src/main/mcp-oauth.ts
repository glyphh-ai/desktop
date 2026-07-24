/**
 * mcp-oauth.ts — OAuth 2.1 client for connecting to authenticated MCP servers.
 *
 * Implements the MCP authorization spec (client side), hand-rolled so it needs
 * no SDK import and ports verbatim between the desktop and code apps:
 *   - Protected Resource Metadata discovery (RFC 9728, /.well-known/oauth-protected-resource)
 *   - Authorization Server Metadata discovery (RFC 8414 + OpenID Connect Discovery)
 *   - Dynamic Client Registration (RFC 7591) for public clients
 *   - Authorization Code + PKCE (S256) — PKCE is mandatory for public clients
 *   - Resource Indicators (RFC 8707): the `resource` param binds the token audience
 *
 * Consent is shown in an IN-APP web-view panel (a BrowserView overlaid on the
 * main window) — never the system browser. The loopback redirect is intercepted
 * from the web view's navigation, so no local HTTP server is needed. Tokens +
 * the registered client are stored encrypted (Electron safeStorage), per server,
 * and refreshed automatically before expiry.
 *
 * Zero-config by design: the caller just connects; on a 401 the app discovers the
 * auth server, registers, and pops the consent panel. No client id/secret to paste.
 */

import { BrowserView, type BrowserWindow, safeStorage } from "electron";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

const STORE_PATH = path.join(os.homedir(), "yo", ".mcp-oauth.json");
// Loopback redirect (RFC 8252). No server listens here — we intercept the
// web view's navigation to this URL and read the code from the query.
const REDIRECT_URI = "http://127.0.0.1:41999/oauth/callback";
const CLIENT_NAME = "Glyphh Desktop";

interface StoredClient { client_id: string; client_secret?: string }
interface StoredTokens { access_token: string; refresh_token?: string; expires_at?: number; scope?: string }
interface StoredEntry {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  resource: string;
  client?: StoredClient;
  tokens?: StoredTokens;
}
type Store = Record<string, StoredEntry>;

/** Thrown by the MCP client when a server demands authorization. Carries the
 *  PRM URL advertised in `WWW-Authenticate` so discovery can start there. */
export class McpUnauthorizedError extends Error {
  constructor(public readonly serverUrl: string, public readonly resourceMetadataUrl?: string) {
    super("MCP server requires authorization");
    this.name = "McpUnauthorizedError";
  }
}

// ── encrypted per-server store ──────────────────────────────────────────────

function readStore(): Store {
  try {
    if (!fs.existsSync(STORE_PATH)) return {};
    const raw = fs.readFileSync(STORE_PATH);
    const json = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString("utf-8");
    return JSON.parse(json) as Store;
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    const json = JSON.stringify(store);
    const buf = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(json)
      : Buffer.from(json, "utf-8");
    fs.writeFileSync(STORE_PATH, buf, { mode: 0o600 });
  } catch (err) {
    console.error("[mcp-oauth] failed to persist token store:", err);
  }
}

/** The canonical resource identifier (RFC 8707): scheme+host(+port)+path, no
 *  fragment, no trailing slash. Also the per-server store key. */
export function canonicalResource(serverUrl: string): string {
  const u = new URL(serverUrl);
  u.hash = "";
  let s = u.toString();
  if (s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

// ── PKCE ────────────────────────────────────────────────────────────────────

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function makePkce(): { verifier: string; challenge: string } {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

// ── discovery ───────────────────────────────────────────────────────────────

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/** RFC 9728: discover the MCP server's Protected Resource Metadata. Prefer the
 *  URL from the `WWW-Authenticate` challenge, else the well-known path. */
async function discoverProtectedResource(serverUrl: string, resourceMetadataUrl?: string): Promise<{ authServers: string[]; scopes?: string[] }> {
  const origin = new URL(serverUrl).origin;
  const candidates = [
    resourceMetadataUrl,
    `${origin}/.well-known/oauth-protected-resource`,
  ].filter(Boolean) as string[];
  for (const url of candidates) {
    try {
      const prm = await fetchJson(url);
      const authServers = Array.isArray(prm.authorization_servers) ? (prm.authorization_servers as string[]) : [];
      if (authServers.length) {
        return { authServers, scopes: Array.isArray(prm.scopes_supported) ? (prm.scopes_supported as string[]) : undefined };
      }
    } catch { /* try next */ }
  }
  // Fallback: treat the server's own origin as the authorization server.
  return { authServers: [origin] };
}

/** RFC 8414 / OIDC: discover the authorization server's endpoints. */
async function discoverAuthServer(issuer: string): Promise<{ authorization_endpoint: string; token_endpoint: string; registration_endpoint?: string }> {
  const base = issuer.replace(/\/$/, "");
  const candidates = [
    `${base}/.well-known/oauth-authorization-server`,
    `${base}/.well-known/openid-configuration`,
  ];
  for (const url of candidates) {
    try {
      const md = await fetchJson(url);
      if (md.authorization_endpoint && md.token_endpoint) {
        return {
          authorization_endpoint: String(md.authorization_endpoint),
          token_endpoint: String(md.token_endpoint),
          registration_endpoint: md.registration_endpoint ? String(md.registration_endpoint) : undefined,
        };
      }
    } catch { /* try next */ }
  }
  throw new Error(`no authorization server metadata at ${issuer}`);
}

/** RFC 7591: register a public client dynamically. */
async function registerClient(registrationEndpoint: string): Promise<StoredClient> {
  const md = await fetchJson(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!md.client_id) throw new Error("dynamic client registration returned no client_id");
  return { client_id: String(md.client_id), client_secret: md.client_secret ? String(md.client_secret) : undefined };
}

// ── the in-app consent web view ─────────────────────────────────────────────

/** Open `authUrl` in a BrowserView overlaid on the main window and resolve with
 *  the redirect callback URL once the web view navigates to REDIRECT_URI. */
function openConsentView(win: BrowserWindow, authUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const view = new BrowserView({ webPreferences: { partition: "persist:mcp-oauth", contextIsolation: true, nodeIntegration: false } });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try { win.removeBrowserView(view); } catch { /* already gone */ }
      try { (view.webContents as unknown as { destroy?: () => void }).destroy?.(); } catch { /* ignore */ }
      fn();
    };

    const layout = () => {
      const b = win.getBounds();
      const w = Math.min(520, b.width - 40);
      const h = Math.min(760, b.height - 40);
      view.setBounds({ x: Math.round((b.width - w) / 2), y: Math.round((b.height - h) / 2), width: w, height: h });
    };

    const onNavigate = (url: string, e?: { preventDefault: () => void }) => {
      if (!url.startsWith(REDIRECT_URI)) return;
      e?.preventDefault();
      finish(() => resolve(url));
    };

    view.webContents.on("will-redirect", (e, url) => onNavigate(url, e));
    view.webContents.on("will-navigate", (e, url) => onNavigate(url, e));
    view.webContents.on("did-start-navigation", (_e, url, _inPage, isMainFrame) => { if (isMainFrame) onNavigate(url); });

    win.addBrowserView(view);
    layout();
    win.on("resize", layout);

    // Guard: if the user closes/cancels or it hangs, don't leak the view.
    const timer = setTimeout(() => finish(() => reject(new Error("authorization timed out"))), 5 * 60_000);
    view.webContents.on("destroyed", () => clearTimeout(timer));

    view.webContents.loadURL(authUrl).catch((err) => finish(() => reject(err as Error)));
  });
}

// ── token lifecycle ─────────────────────────────────────────────────────────

async function exchangeCode(entry: StoredEntry, code: string, verifier: string): Promise<StoredTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
    client_id: entry.client!.client_id,
    resource: entry.resource,
  });
  if (entry.client!.client_secret) body.set("client_secret", entry.client!.client_secret);
  return tokenRequest(entry.token_endpoint, body);
}

async function refreshTokens(entry: StoredEntry): Promise<StoredTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: entry.tokens!.refresh_token!,
    client_id: entry.client!.client_id,
    resource: entry.resource,
  });
  if (entry.client!.client_secret) body.set("client_secret", entry.client!.client_secret);
  return tokenRequest(entry.token_endpoint, body);
}

async function tokenRequest(tokenEndpoint: string, body: URLSearchParams): Promise<StoredTokens> {
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`token request failed: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_in ? Date.now() + (data.expires_in - 60) * 1000 : undefined,
    scope: data.scope,
  };
}

// ── public API ──────────────────────────────────────────────────────────────

/** A valid bearer for `serverUrl` from the store, refreshing if near expiry.
 *  Returns null when there's no stored authorization (caller runs interactive). */
export async function getValidAccessToken(serverUrl: string): Promise<string | null> {
  const key = canonicalResource(serverUrl);
  const store = readStore();
  const entry = store[key];
  if (!entry?.tokens) return null;
  const t = entry.tokens;
  if (!t.expires_at || Date.now() < t.expires_at) return t.access_token;
  if (t.refresh_token) {
    try {
      const fresh = await refreshTokens(entry);
      entry.tokens = { ...fresh, refresh_token: fresh.refresh_token ?? t.refresh_token };
      store[key] = entry;
      writeStore(store);
      return entry.tokens.access_token;
    } catch (err) {
      console.error("[mcp-oauth] refresh failed:", err);
      return null; // fall back to interactive re-auth
    }
  }
  return null;
}

/** Run the full interactive OAuth flow for `serverUrl` (discovery → register →
 *  consent in the in-app web view → code exchange), persist the tokens, and
 *  return the access token. */
export async function authorizeMcpServer(win: BrowserWindow, serverUrl: string, resourceMetadataUrl?: string, preClient?: { clientId: string; clientSecret?: string }): Promise<string> {
  const key = canonicalResource(serverUrl);
  const store = readStore();

  const { authServers, scopes } = await discoverProtectedResource(serverUrl, resourceMetadataUrl);
  const issuer = authServers[0];
  const as = await discoverAuthServer(issuer);

  const entry: StoredEntry = {
    issuer,
    authorization_endpoint: as.authorization_endpoint,
    token_endpoint: as.token_endpoint,
    registration_endpoint: as.registration_endpoint,
    resource: key,
    // Prefer a stored client, then a caller-supplied pre-registered one
    // (Advanced settings), then fall back to dynamic registration.
    client: store[key]?.client ?? (preClient ? { client_id: preClient.clientId, client_secret: preClient.clientSecret } : undefined),
  };

  if (!entry.client) {
    if (!as.registration_endpoint) throw new Error(`${issuer} supports neither a stored client nor dynamic registration`);
    entry.client = await registerClient(as.registration_endpoint);
  }

  const { verifier, challenge } = makePkce();
  const state = b64url(crypto.randomBytes(16));
  const authUrl = new URL(as.authorization_endpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", entry.client.client_id);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("resource", key);
  if (scopes?.length) authUrl.searchParams.set("scope", scopes.join(" "));

  const callback = await openConsentView(win, authUrl.toString());
  const cb = new URL(callback);
  if (cb.searchParams.get("state") !== state) throw new Error("OAuth state mismatch — possible CSRF");
  const err = cb.searchParams.get("error");
  if (err) throw new Error(`authorization denied: ${err} ${cb.searchParams.get("error_description") ?? ""}`.trim());
  const code = cb.searchParams.get("code");
  if (!code) throw new Error("no authorization code in callback");

  entry.tokens = await exchangeCode(entry, code, verifier);
  store[key] = entry;
  writeStore(store);
  return entry.tokens.access_token;
}

/** True when we hold (or can refresh into) a token for this server. */
export function hasStoredAuth(serverUrl: string): boolean {
  const entry = readStore()[canonicalResource(serverUrl)];
  return Boolean(entry?.tokens);
}

/** Forget a server's tokens + registered client (a "disconnect"). */
export function clearMcpAuth(serverUrl: string): void {
  const store = readStore();
  delete store[canonicalResource(serverUrl)];
  writeStore(store);
}

/** Pull the `resource_metadata` URL out of a `WWW-Authenticate: Bearer …` header. */
export function resourceMetadataFrom(header: string | null): string | undefined {
  if (!header) return undefined;
  const m = /resource_metadata="?([^",\s]+)"?/i.exec(header);
  return m?.[1];
}

/** Probe a remote MCP server (a lightweight `initialize`) to see whether it
 *  demands authorization. Used where the client can't observe the 401 directly
 *  (e.g. the desktop app, whose server dials the endpoint) so the app can run
 *  the consent flow up front and hand the token off. */
export async function probeMcpAuth(serverUrl: string): Promise<{ needsAuth: boolean; resourceMetadataUrl?: string }> {
  try {
    const res = await fetch(serverUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "glyphh", version: "1.0.0" } } }),
    });
    if (res.status === 401) return { needsAuth: true, resourceMetadataUrl: resourceMetadataFrom(res.headers.get("www-authenticate")) };
    return { needsAuth: false };
  } catch {
    return { needsAuth: false };
  }
}

/** Refresh (if possible) and return the current bearer header for a server, so a
 *  server-mediated connection (desktop) can be re-stamped with a fresh token via
 *  the connection's `headers`. Returns null when there's no usable token. */
export async function bearerHeaderFor(serverUrl: string): Promise<Record<string, string> | null> {
  const tok = await getValidAccessToken(serverUrl);
  return tok ? { Authorization: `Bearer ${tok}` } : null;
}
