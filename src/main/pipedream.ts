/**
 * pipedream.ts — CONNECTED APPS on the user's OWN Pipedream project.
 *
 * Nothing of Glyphh's sits in between: the user brings a project id and an
 * OAuth client (pipedream.com/settings/api), this machine mints the API token
 * with client credentials and talks to Pipedream Connect directly.
 *
 *   ~/.glyphh/users/<id>/pipedream.json — project id, environment, client id,
 *     the client secret SEALED (secure-store), the apps the user turned off,
 *     and the last account list read (so "is anything connected?" answers
 *     synchronously and offline).
 *
 * Connecting opens Pipedream's Connect Link in the SYSTEM browser: in
 * development mode Pipedream requires the user to be signed in to
 * pipedream.com, and only their own browser carries that session. There is no
 * backend to receive a webhook, so success is seen by polling the accounts
 * list until a new account for the app appears.
 *
 * Tools: one MCP server per connected app at remote.mcp.pipedream.net/v3,
 * dialed by mcp-connections.ts with the headers `mcpAuth` hands it.
 *
 * Electron-free apart from the sealing (secure-store); the IPC lives in
 * pipedream-ipc.ts.
 */

import fs from "fs";
import path from "path";
import { userScopedPath } from "./app-paths.js";
import { decryptJson, encryptJson } from "./secure-store.js";

export const PD_API = "https://api.pipedream.com/v1";
export const PD_MCP_URL = "https://remote.mcp.pipedream.net/v3";
/** One of the development environment's ten external-user slots: this
 *  machine's user, the same id on every call so accounts persist. */
export const EXTERNAL_USER_ID = "glyphh-local";

export type PdEnvironment = "development" | "production";

export interface PdApp {
  slug: string;
  name: string;
  icon: string | null;
  description: string;
  categories: string[];
}
export interface PdCategory { id: string; name: string }
export interface PdAccount {
  id: string;
  app: string;
  appName: string;
  icon: string | null;
  healthy: boolean;
  dead: boolean;
  createdAt: string;
}
export interface PdConfig { projectId: string; environment: PdEnvironment; clientId: string; clientSecret: string }
/** What Settings is shown: never the secret, only that one is saved and its tail. */
export interface PdConfigView {
  configured: boolean;
  projectId: string;
  environment: PdEnvironment;
  clientId: string;
  secretSet: boolean;
  secretHint: string;
}
export type PdConnectProgress =
  | { phase: "opening"; app: string }
  | { phase: "waiting"; app: string; url: string }
  | { phase: "done"; app: string; ok: true; account: PdAccount }
  | { phase: "done"; app: string; ok: false; error: string; cancelled?: boolean };

interface PdFile {
  projectId?: string;
  environment?: PdEnvironment;
  clientId?: string;
  /** encryptJson({ secret }) as base64. */
  clientSecret?: string;
  disabledApps?: string[];
  accounts?: PdAccount[];
}

const FILE = (): string => userScopedPath("pipedream.json");

function readFile(): PdFile {
  try { return JSON.parse(fs.readFileSync(FILE(), "utf-8")) as PdFile; }
  catch { return {}; }
}
function writeFile(f: PdFile): void {
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(f, null, 2), { encoding: "utf-8", mode: 0o600 });
}
const seal = (secret: string): string => encryptJson({ secret }).toString("base64");
/** Opening the seal is a keychain (or scrypt) round trip, and the config is
 *  read on every call: the last one opened is kept in memory. */
let opened: { sealed: string; secret: string } | null = null;
const unseal = (sealed: string | undefined): string => {
  if (!sealed) return "";
  if (opened?.sealed === sealed) return opened.secret;
  const secret = decryptJson<{ secret?: string }>(Buffer.from(sealed, "base64"))?.secret ?? "";
  opened = { sealed, secret };
  return secret;
};

// ── Config ─────────────────────────────────────────────────────────────────

/** The full config with the secret opened, or null until every field is set. */
export function readPdConfig(): PdConfig | null {
  const f = readFile();
  const clientSecret = unseal(f.clientSecret);
  if (!f.projectId || !f.clientId || !clientSecret) return null;
  return { projectId: f.projectId, environment: f.environment === "production" ? "production" : "development", clientId: f.clientId, clientSecret };
}

export function pdConfigView(): PdConfigView {
  const f = readFile();
  const secret = unseal(f.clientSecret);
  return {
    configured: readPdConfig() !== null,
    projectId: f.projectId ?? "",
    environment: f.environment === "production" ? "production" : "development",
    clientId: f.clientId ?? "",
    secretSet: !!secret,
    secretHint: secret ? `…${secret.slice(-4)}` : "",
  };
}

/** Save what the form sent. A blank secret keeps the saved one, so the form
 *  can be re-saved without retyping it. Credentials changing invalidates the
 *  token and the accounts read under the old ones. */
export function savePdConfig(input: { projectId?: string; environment?: string; clientId?: string; clientSecret?: string }): PdConfigView {
  const f = readFile();
  const projectId = String(input.projectId ?? f.projectId ?? "").trim();
  const clientId = String(input.clientId ?? f.clientId ?? "").trim();
  const secret = String(input.clientSecret ?? "").trim();
  const environment: PdEnvironment = (input.environment ?? f.environment) === "production" ? "production" : "development";
  if (!projectId) throw new Error("The project ID is required.");
  if (!/^proj_[A-Za-z0-9]+$/.test(projectId)) throw new Error("A project ID looks like proj_abc123 — copy it from the project's Settings on pipedream.com.");
  if (!clientId) throw new Error("The OAuth client ID is required.");
  if (!secret && !unseal(f.clientSecret)) throw new Error("The OAuth client secret is required.");
  const moved = projectId !== f.projectId || clientId !== f.clientId || environment !== f.environment || !!secret;
  writeFile({
    ...f, projectId, clientId, environment,
    ...(secret ? { clientSecret: seal(secret) } : {}),
    ...(moved ? { accounts: [] } : {}),
  });
  if (moved) token = null;
  return pdConfigView();
}

/** Forget the project: credentials, cached accounts and app switches. The
 *  accounts themselves stay on Pipedream. */
export function clearPdConfig(): void {
  try { fs.rmSync(FILE(), { force: true }); } catch { /* already gone */ }
  token = null;
}

// ── Apps on and off, and the account cache ─────────────────────────────────

export const isPdAppEnabled = (app: string): boolean => !(readFile().disabledApps ?? []).includes(app);

export function setPdAppEnabled(app: string, on: boolean): void {
  const f = readFile();
  const off = new Set(f.disabledApps ?? []);
  if (on) off.delete(app); else off.add(app);
  writeFile({ ...f, disabledApps: [...off].sort() });
}

/** The accounts as last read from Pipedream — no network. */
export function cachedPdAccounts(): PdAccount[] {
  return readPdConfig() ? readFile().accounts ?? [] : [];
}

/** One app per connected account the tools can use: healthy, not dead, and
 *  the app not turned off. Two accounts of one app share its MCP server. */
export function pdToolApps(): Array<{ app: string; name: string }> {
  const seen = new Map<string, string>();
  for (const a of cachedPdAccounts()) {
    if (a.dead || !a.healthy || seen.has(a.app) || !isPdAppEnabled(a.app)) continue;
    seen.set(a.app, a.appName);
  }
  return [...seen].map(([app, name]) => ({ app, name }));
}

// ── The API ────────────────────────────────────────────────────────────────

export class PipedreamError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const requireConfig = (): PdConfig => {
  const c = readPdConfig();
  if (!c) throw new Error("Pipedream isn't set up — add your project ID and OAuth client in Settings › Connections.");
  return c;
};

let token: { value: string; expiresAt: number; for: string } | null = null;
let minting: Promise<string> | null = null;
const credKey = (c: PdConfig): string => `${c.projectId}|${c.environment}|${c.clientId}|${c.clientSecret}`;
/** Refresh a minute early, so a token never expires mid-call. */
const EARLY_MS = 60_000;

/** The API token: cached until a minute before it expires, one mint in flight. */
export async function pdAccessToken(): Promise<string> {
  const c = requireConfig();
  if (token && token.for === credKey(c) && token.expiresAt - EARLY_MS > Date.now()) return token.value;
  if (minting) return minting;
  minting = (async () => {
    const res = await fetch(`${PD_API}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "client_credentials", client_id: c.clientId, client_secret: c.clientSecret }),
    });
    if (!res.ok) {
      const why = await errorText(res);
      throw new PipedreamError(res.status, res.status === 401 || res.status === 400
        ? `Pipedream refused the OAuth client ID or secret${why ? `: ${why}` : ""}.`
        : `Pipedream's token endpoint answered ${res.status}${why ? `: ${why}` : ""}.`);
    }
    const body = await res.json() as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new PipedreamError(500, "Pipedream returned no access token.");
    token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000, for: credKey(c) };
    return body.access_token;
  })().finally(() => { minting = null; });
  return minting;
}

/** Drop the cached token — a 401 means it is no longer good, whatever its clock says. */
export function invalidatePdToken(): void { token = null; }

async function errorText(res: Response): Promise<string> {
  const raw = await res.text().catch(() => "");
  try {
    const j = JSON.parse(raw) as { error?: unknown; message?: unknown; error_description?: unknown };
    const e = j.error_description ?? j.message ?? j.error;
    if (typeof e === "string") return e;
    if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") return (e as { message: string }).message;
  } catch { /* not JSON */ }
  return raw.slice(0, 200);
}

/** Retry-After as milliseconds: seconds or an HTTP date; 2 s when absent,
 *  capped at a minute so a bad header cannot park a call for good. */
export function retryAfterMs(header: string | null, now = Date.now()): number {
  if (!header) return 2000;
  const secs = Number(header);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(header) - now;
  return Number.isFinite(ms) ? Math.min(60_000, Math.max(0, ms)) : 2000;
}

const RATE_RETRIES = 3;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("cancelled")); return; }
    const t = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, ms);
    const stop = (): void => { clearTimeout(t); reject(new Error("cancelled")); };
    signal?.addEventListener("abort", stop, { once: true });
  });
}

/** One Connect API call: bearer + environment, one re-mint on 401, and a 429
 *  waits out Retry-After before trying again. */
async function pd<T>(p: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const c = requireConfig();
  let reminted = false;
  for (let rate = 0; ; ) {
    const bearer = await pdAccessToken();
    const res = await fetch(`${PD_API}${p}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "x-pd-environment": c.environment,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    });
    if (res.status === 401 && !reminted) { reminted = true; invalidatePdToken(); continue; }
    if (res.status === 429 && rate < RATE_RETRIES) {
      rate++;
      await sleep(retryAfterMs(res.headers.get("retry-after")), init.signal);
      continue;
    }
    if (!res.ok) {
      const why = await errorText(res);
      throw new PipedreamError(res.status, `Pipedream answered ${res.status}${why ? `: ${why}` : ""}`);
    }
    if (res.status === 204) return undefined as T;
    return await res.json() as T;
  }
}

interface RawApp { name_slug: string; name: string; img_src?: string | null; description?: string | null; categories?: string[] }
interface RawAccount { id: string; name?: string | null; healthy?: boolean; dead?: boolean | null; created_at?: string; app?: { name_slug?: string; name?: string; img_src?: string | null } }
interface PageInfo { count?: number; total_count?: number; end_cursor?: string | null }

const appOf = (a: RawApp): PdApp => ({
  slug: a.name_slug, name: a.name, icon: a.img_src || null,
  description: a.description ?? "", categories: Array.isArray(a.categories) ? a.categories : [],
});
const accountOf = (a: RawAccount): PdAccount => ({
  id: a.id,
  app: a.app?.name_slug ?? "",
  appName: a.app?.name ?? a.name ?? a.app?.name_slug ?? "",
  icon: a.app?.img_src || null,
  healthy: a.healthy !== false,
  dead: a.dead === true,
  createdAt: a.created_at ?? "",
});

const CATALOG_PAGE = 24;

/** The app directory, a page at a time. With no search it is Pipedream's
 *  featured order, so the popular apps come first; a search keeps Pipedream's
 *  relevance order. `next` is empty at the end. */
export async function pdApps(o: { q?: string; after?: string; category?: string; limit?: number } = {}): Promise<{ apps: PdApp[]; next: string; total: number }> {
  const limit = Math.min(100, Math.max(1, o.limit ?? CATALOG_PAGE));
  const qs = new URLSearchParams({ limit: String(limit) });
  const q = o.q?.trim();
  if (q) qs.set("q", q);
  else { qs.set("sort_key", "featured_weight"); qs.set("sort_direction", "desc"); }
  if (o.after) qs.set("after", o.after);
  if (o.category) qs.append("category_ids", o.category);
  const r = await pd<{ data?: RawApp[]; page_info?: PageInfo }>(`/connect/apps?${qs}`);
  const apps = (r.data ?? []).filter((a) => a?.name_slug).map(appOf);
  const info = r.page_info ?? {};
  const more = apps.length >= limit && !!info.end_cursor;
  return { apps, next: more ? String(info.end_cursor) : "", total: info.total_count ?? apps.length };
}

let categories: PdCategory[] | null = null;
/** The directory's categories, read once per run (they rarely move). */
export async function pdCategories(): Promise<PdCategory[]> {
  if (categories) return categories;
  const r = await pd<Array<{ id: string; name: string }> | { data?: Array<{ id: string; name: string }> }>("/connect/app_categories");
  const rows = Array.isArray(r) ? r : r.data ?? [];
  categories = rows.filter((c) => c?.id && c?.name).map((c) => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name));
  return categories;
}

/** Every account this machine's user has connected (all pages), optionally
 *  for one app. A full read refreshes the cache the tools are listed from. */
export async function pdAccounts(app?: string, signal?: AbortSignal): Promise<PdAccount[]> {
  const c = requireConfig();
  const out: PdAccount[] = [];
  let after = "";
  for (let page = 0; page < 50; page++) {
    const qs = new URLSearchParams({ external_user_id: EXTERNAL_USER_ID, limit: "100" });
    if (app) qs.set("app", app);
    if (after) qs.set("after", after);
    const r = await pd<{ data?: RawAccount[]; page_info?: PageInfo }>(`/connect/${encodeURIComponent(c.projectId)}/accounts?${qs}`, signal ? { signal } : {});
    const rows = (r.data ?? []).filter((a) => a?.id).map(accountOf);
    out.push(...rows);
    after = r.page_info?.end_cursor ?? "";
    if (!after || rows.length < 100) break;
  }
  if (!app) writeFile({ ...readFile(), accounts: out });
  return out;
}

/** Remove an account and its credentials on Pipedream, then drop it here. */
export async function pdDeleteAccount(id: string): Promise<void> {
  const c = requireConfig();
  await pd<void>(`/connect/${encodeURIComponent(c.projectId)}/accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
  const f = readFile();
  writeFile({ ...f, accounts: (f.accounts ?? []).filter((a) => a.id !== id) });
}

/** A single-use Connect token and its Connect Link. */
export async function pdConnectToken(): Promise<{ token: string; expiresAt: string; connectLinkUrl: string }> {
  const c = requireConfig();
  const r = await pd<{ token: string; expires_at: string; connect_link_url: string }>(`/connect/${encodeURIComponent(c.projectId)}/tokens`, {
    method: "POST", body: { external_user_id: EXTERNAL_USER_ID },
  });
  if (!r?.connect_link_url) throw new PipedreamError(500, "Pipedream returned no Connect Link.");
  return { token: r.token, expiresAt: r.expires_at, connectLinkUrl: r.connect_link_url };
}

/** The Connect Link for one app: Pipedream's link names the app as a query param. */
export function connectLinkFor(base: string, app: string): string {
  const u = new URL(base);
  u.searchParams.set("app", app);
  return u.toString();
}

export const POLL_MS = 2000;
export const CONNECT_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Connect one app: a fresh Connect token, the link handed to `open` (and on
 * in the "waiting" progress, which Glyphh's browser panel opens), then the accounts polled until one for the app appears
 * that was not there before. Progress goes to `onProgress`; `signal` cancels.
 */
export async function pdConnect(app: string, o: {
  open: (url: string) => Promise<void> | void;
  onProgress?: (p: PdConnectProgress) => void;
  signal?: AbortSignal;
  pollMs?: number;
  timeoutMs?: number;
}): Promise<PdConnectProgress & { phase: "done" }> {
  const say = (p: PdConnectProgress): void => { try { o.onProgress?.(p); } catch { /* a listener's problem */ } };
  const done = (r: PdConnectProgress & { phase: "done" }): PdConnectProgress & { phase: "done" } => { say(r); return r; };
  const cancelled = (): PdConnectProgress & { phase: "done" } => done({ phase: "done", app, ok: false, error: "Connecting was cancelled.", cancelled: true });
  try {
    say({ phase: "opening", app });
    const before = new Set((await pdAccounts(app, o.signal)).map((a) => a.id));
    const { connectLinkUrl } = await pdConnectToken();
    const url = connectLinkFor(connectLinkUrl, app);
    await o.open(url);
    say({ phase: "waiting", app, url });
    const deadline = Date.now() + (o.timeoutMs ?? CONNECT_TIMEOUT_MS);
    while (Date.now() < deadline) {
      await sleep(o.pollMs ?? POLL_MS, o.signal);
      const fresh = (await pdAccounts(app, o.signal)).find((a) => !before.has(a.id));
      if (fresh) {
        // The full list refreshes the cache the tools are listed from.
        await pdAccounts().catch(() => undefined);
        return done({ phase: "done", app, ok: true, account: fresh });
      }
    }
    return done({ phase: "done", app, ok: false, error: "No new account showed up in 3 minutes. If you finished in the browser, it will appear once Pipedream has it — otherwise try Connect again." });
  } catch (err) {
    if (o.signal?.aborted) return cancelled();
    return done({ phase: "done", app, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Settings' Test: mint a token and list the accounts. */
export async function pdTest(): Promise<{ accounts: number }> {
  invalidatePdToken();
  const accounts = await pdAccounts();
  return { accounts: accounts.length };
}

/** The headers one app's MCP server is dialed with, and the token inside
 *  them, so the dialer can tell when the token has rotated under it. */
export async function pdMcpAuth(app: string): Promise<{ url: string; token: string; headers: Record<string, string> }> {
  const c = requireConfig();
  const bearer = await pdAccessToken();
  return {
    url: PD_MCP_URL,
    token: bearer,
    headers: {
      Authorization: `Bearer ${bearer}`,
      "x-pd-project-id": c.projectId,
      "x-pd-environment": c.environment,
      "x-pd-external-user-id": EXTERNAL_USER_ID,
      "x-pd-app-slug": app,
    },
  };
}

/** The token the next dial would carry, without minting: "" when none is
 *  cached or it is inside its refresh minute. */
export function currentPdToken(): string {
  const c = readPdConfig();
  if (!c || !token || token.for !== credKey(c) || token.expiresAt - EARLY_MS <= Date.now()) return "";
  return token.value;
}
