/**
 * pipedream.test.ts — the user's own Pipedream project (main/pipedream.ts)
 * against a fake Pipedream: the config with its secret sealed and masked,
 * the token cached and re-minted, the Connect Link, the poll that sees a new
 * account (and its timeout, its 429 and its cancel), the directory's pages,
 * the accounts, delete, Test, and the MCP headers. No network.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const home = mkdtempSync(join(tmpdir(), "glyphh-pd-"));
vi.mock("../../src/main/app-paths.js", () => ({ userScopedPath: (...p: string[]) => join(home, ...p) }));
// No keychain in a test: secure-store takes its AES fallback.
vi.mock("electron", () => ({ safeStorage: { isEncryptionAvailable: () => false } }));

const P = await import("../../src/main/pipedream.js");

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
type Handler = (c: Call) => Response | Promise<Response>;

/** A scripted Pipedream: routes by method + path, records every call. */
function fakePd(routes: Record<string, Handler | Handler[]>): { calls: Call[] } {
  const calls: Call[] = [];
  const queues = new Map(Object.entries(routes).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]));
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const u = new URL(input);
    const c: Call = {
      url: input, method: init.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(c);
    if ((init.signal as AbortSignal | undefined)?.aborted) throw new Error("aborted");
    const key = `${c.method} ${u.pathname}`;
    const h = queues.get(key);
    if (!h) return new Response("no route " + key, { status: 404 });
    if (Array.isArray(h)) {
      const next = h.length > 1 ? h.shift()! : h[0]!;
      return next(c);
    }
    return h(c);
  });
  return { calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const tokenOk = (value = "tok-1", expires = 3600): Handler => () => json({ access_token: value, expires_in: expires });
const acct = (id: string, app = "gmail", over: Record<string, unknown> = {}) => ({ id, healthy: true, dead: false, created_at: "2026-10-19", app: { name_slug: app, name: app === "gmail" ? "Gmail" : app, img_src: `https://img/${app}.png` }, ...over });
const accounts = (...rows: unknown[]): Handler => () => json({ data: rows, page_info: { count: rows.length, total_count: rows.length, end_cursor: null } });

const ACCOUNTS = "GET /v1/connect/proj_abc/accounts";
const configure = (over: Record<string, string> = {}): void => {
  P.savePdConfig({ projectId: "proj_abc", clientId: "cid", clientSecret: "shh-secret-1234", environment: "development", ...over });
};

beforeEach(() => {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  P.invalidatePdToken();
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("config", () => {
  it("is not configured until project, client id and secret are all saved", () => {
    expect(P.readPdConfig()).toBeNull();
    expect(P.pdConfigView()).toEqual({ configured: false, projectId: "", environment: "development", clientId: "", secretSet: false, secretHint: "" });
  });

  it("seals the secret on disk and only ever shows its last four", () => {
    configure();
    const raw = readFileSync(join(home, "pipedream.json"), "utf-8");
    expect(raw).not.toContain("shh-secret-1234");
    expect(P.pdConfigView()).toEqual({ configured: true, projectId: "proj_abc", environment: "development", clientId: "cid", secretSet: true, secretHint: "…1234" });
    expect(P.readPdConfig()).toEqual({ projectId: "proj_abc", environment: "development", clientId: "cid", clientSecret: "shh-secret-1234" });
  });

  it("a blank secret keeps the saved one; the environment and fields can change", () => {
    configure();
    P.savePdConfig({ projectId: "proj_abc", clientId: "cid2", clientSecret: "", environment: "production" });
    expect(P.readPdConfig()).toEqual({ projectId: "proj_abc", environment: "production", clientId: "cid2", clientSecret: "shh-secret-1234" });
  });

  it("refuses a missing or malformed project id, a missing client id or secret", () => {
    expect(() => P.savePdConfig({ projectId: "", clientId: "c", clientSecret: "s" })).toThrow(/project ID is required/);
    expect(() => P.savePdConfig({ projectId: "abc", clientId: "c", clientSecret: "s" })).toThrow(/proj_abc123/);
    expect(() => P.savePdConfig({ projectId: "proj_a", clientId: "", clientSecret: "s" })).toThrow(/client ID/);
    expect(() => P.savePdConfig({ projectId: "proj_a", clientId: "c" })).toThrow(/secret/);
  });

  it("clear forgets everything", () => {
    configure();
    P.clearPdConfig();
    expect(P.readPdConfig()).toBeNull();
    expect(P.cachedPdAccounts()).toEqual([]);
  });

  it("calls before setup say where to set it up", async () => {
    await expect(P.pdApps()).rejects.toThrow(/Settings › Connections/);
  });
});

describe("the API token", () => {
  it("is minted with client credentials once and cached across calls", async () => {
    configure();
    const pd = fakePd({ "POST /v1/oauth/token": tokenOk(), [ACCOUNTS]: accounts() });
    await P.pdAccounts();
    await P.pdAccounts();
    const mints = pd.calls.filter((c) => c.url.endsWith("/oauth/token"));
    expect(mints).toHaveLength(1);
    expect(mints[0]!.body).toEqual({ grant_type: "client_credentials", client_id: "cid", client_secret: "shh-secret-1234" });
    const list = pd.calls.find((c) => c.url.includes("/accounts"))!;
    expect(list.headers.Authorization).toBe("Bearer tok-1");
    expect(list.headers["x-pd-environment"]).toBe("development");
  });

  it("is re-minted inside its last minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T10:00:00Z"));
    configure();
    const pd = fakePd({ "POST /v1/oauth/token": [tokenOk("tok-1", 3600), tokenOk("tok-2", 3600)], [ACCOUNTS]: accounts() });
    expect(await P.pdAccessToken()).toBe("tok-1");
    expect(P.currentPdToken()).toBe("tok-1");
    vi.setSystemTime(new Date("2026-10-19T10:59:30Z"));
    expect(P.currentPdToken()).toBe("");
    expect(await P.pdAccessToken()).toBe("tok-2");
    expect(pd.calls.filter((c) => c.url.endsWith("/oauth/token"))).toHaveLength(2);
  });

  it("a 401 from the API re-mints once and retries", async () => {
    configure();
    const pd = fakePd({
      "POST /v1/oauth/token": [tokenOk("old"), tokenOk("new")],
      [ACCOUNTS]: [() => json({ error: "expired" }, 401), accounts(acct("apn_1"))],
    });
    expect((await P.pdAccounts()).map((a) => a.id)).toEqual(["apn_1"]);
    expect(pd.calls.filter((c) => c.url.includes("/accounts")).map((c) => c.headers.Authorization)).toEqual(["Bearer old", "Bearer new"]);
  });

  it("refused credentials read as such", async () => {
    configure();
    fakePd({ "POST /v1/oauth/token": () => json({ error: "invalid_client" }, 401) });
    await expect(P.pdAccessToken()).rejects.toThrow(/refused the OAuth client ID or secret: invalid_client/);
  });

  it("changing the credentials drops the cached token", async () => {
    configure();
    const pd = fakePd({ "POST /v1/oauth/token": [tokenOk("a"), tokenOk("b")] });
    await P.pdAccessToken();
    configure({ clientSecret: "another-secret" });
    expect(await P.pdAccessToken()).toBe("b");
    expect(pd.calls).toHaveLength(2);
  });
});

describe("rate limits", () => {
  it("Retry-After reads seconds or a date, defaults to 2 s, and is capped at a minute", () => {
    expect(P.retryAfterMs("3")).toBe(3000);
    expect(P.retryAfterMs(null)).toBe(2000);
    expect(P.retryAfterMs("garbage")).toBe(2000);
    expect(P.retryAfterMs("9999")).toBe(60_000);
    const now = Date.parse("2026-10-19T10:00:00Z");
    expect(P.retryAfterMs("Mon, 19 Oct 2026 10:00:05 GMT", now)).toBe(5000);
  });

  it("a 429 waits out Retry-After and tries again", async () => {
    configure();
    const pd = fakePd({
      "POST /v1/oauth/token": tokenOk(),
      [ACCOUNTS]: [() => json({ error: "slow down" }, 429, { "retry-after": "0" }), accounts(acct("apn_1"))],
    });
    expect((await P.pdAccounts()).length).toBe(1);
    expect(pd.calls.filter((c) => c.url.includes("/accounts"))).toHaveLength(2);
  });

  it("gives up after three 429s with the error", async () => {
    configure();
    fakePd({ "POST /v1/oauth/token": tokenOk(), [ACCOUNTS]: () => json({ error: "slow down" }, 429, { "retry-after": "0" }) });
    await expect(P.pdAccounts()).rejects.toThrow(/429: slow down/);
  });
});

describe("the directory", () => {
  it("with no search: featured first, a page of 24, the next cursor while pages are full", async () => {
    configure();
    const page = Array.from({ length: 24 }, (_, i) => ({ name_slug: `app${i}`, name: `App ${i}`, img_src: "", description: null, categories: ["Email"] }));
    const pd = fakePd({ "POST /v1/oauth/token": tokenOk(), "GET /v1/connect/apps": () => json({ data: page, page_info: { count: 24, total_count: 3000, end_cursor: "cur1" } }) });
    const r = await P.pdApps();
    expect(r.apps).toHaveLength(24);
    expect(r.apps[0]).toEqual({ slug: "app0", name: "App 0", icon: null, description: "", categories: ["Email"] });
    expect(r.next).toBe("cur1");
    expect(r.total).toBe(3000);
    const q = new URL(pd.calls.at(-1)!.url).searchParams;
    expect(q.get("sort_key")).toBe("featured_weight");
    expect(q.get("sort_direction")).toBe("desc");
    expect(q.get("limit")).toBe("24");
  });

  it("a search keeps Pipedream's relevance order; the cursor and category ride along; a short page is the end", async () => {
    configure();
    const pd = fakePd({ "POST /v1/oauth/token": tokenOk(), "GET /v1/connect/apps": () => json({ data: [{ name_slug: "gmail", name: "Gmail", img_src: "https://img/g.png", categories: [] }], page_info: { end_cursor: "x" } }) });
    const r = await P.pdApps({ q: " gmail ", after: "cur1", category: "appcat_email" });
    expect(r.next).toBe("");
    const q = new URL(pd.calls.at(-1)!.url).searchParams;
    expect(q.get("q")).toBe("gmail");
    expect(q.get("sort_key")).toBeNull();
    expect(q.get("after")).toBe("cur1");
    expect(q.getAll("category_ids")).toEqual(["appcat_email"]);
  });

  it("categories come back sorted, whether bare or wrapped, and are read once", async () => {
    configure();
    const pd = fakePd({ "POST /v1/oauth/token": tokenOk(), "GET /v1/connect/app_categories": () => json([{ id: "appcat_b", name: "Email" }, { id: "appcat_a", name: "CRM" }]) });
    expect(await P.pdCategories()).toEqual([{ id: "appcat_a", name: "CRM" }, { id: "appcat_b", name: "Email" }]);
    await P.pdCategories();
    expect(pd.calls.filter((c) => c.url.includes("app_categories"))).toHaveLength(1);
  });
});

describe("accounts", () => {
  it("lists every page for this machine's user and caches the full list", async () => {
    configure();
    const first = Array.from({ length: 100 }, (_, i) => acct(`apn_${i}`));
    const pd = fakePd({
      "POST /v1/oauth/token": tokenOk(),
      [ACCOUNTS]: [() => json({ data: first, page_info: { end_cursor: "next" } }), accounts(acct("apn_last", "slack"))],
    });
    const all = await P.pdAccounts();
    expect(all).toHaveLength(101);
    const urls = pd.calls.filter((c) => c.url.includes("/accounts")).map((c) => new URL(c.url).searchParams);
    expect(urls[0]!.get("external_user_id")).toBe(P.EXTERNAL_USER_ID);
    expect(urls[1]!.get("after")).toBe("next");
    expect(P.cachedPdAccounts()).toHaveLength(101);
    expect(all.at(-1)).toEqual({ id: "apn_last", app: "slack", appName: "slack", icon: "https://img/slack.png", healthy: true, dead: false, createdAt: "2026-10-19" });
  });

  it("the tool apps are the healthy, live, switched-on apps, once each", async () => {
    configure();
    fakePd({
      "POST /v1/oauth/token": tokenOk(),
      [ACCOUNTS]: accounts(acct("a1", "gmail"), acct("a2", "gmail"), acct("a3", "slack", { dead: true }), acct("a4", "github", { healthy: false }), acct("a5", "notion")),
    });
    await P.pdAccounts();
    expect(P.pdToolApps().map((a) => a.app)).toEqual(["gmail", "notion"]);
    P.setPdAppEnabled("notion", false);
    expect(P.isPdAppEnabled("notion")).toBe(false);
    expect(P.pdToolApps().map((a) => a.app)).toEqual(["gmail"]);
    P.setPdAppEnabled("notion", true);
    expect(P.pdToolApps().map((a) => a.app)).toEqual(["gmail", "notion"]);
  });

  it("delete removes the account on Pipedream and from the cache", async () => {
    configure();
    const pd = fakePd({
      "POST /v1/oauth/token": tokenOk(),
      [ACCOUNTS]: accounts(acct("apn_1"), acct("apn_2", "slack")),
      "DELETE /v1/connect/proj_abc/accounts/apn_1": () => new Response(null, { status: 204 }),
    });
    await P.pdAccounts();
    await P.pdDeleteAccount("apn_1");
    expect(pd.calls.at(-1)!.method).toBe("DELETE");
    expect(P.cachedPdAccounts().map((a) => a.id)).toEqual(["apn_2"]);
  });

  it("Test mints a fresh token and counts the accounts", async () => {
    configure();
    const pd = fakePd({ "POST /v1/oauth/token": tokenOk(), [ACCOUNTS]: accounts(acct("apn_1")) });
    await P.pdAccessToken();
    expect(await P.pdTest()).toEqual({ accounts: 1 });
    expect(pd.calls.filter((c) => c.url.endsWith("/oauth/token"))).toHaveLength(2);
  });
});

describe("connect", () => {
  const LINK = "https://pipedream.com/_static/connect.html?token=ctok_1&connectLink=true";
  const connectRoutes = (accountReads: Handler[]): Record<string, Handler | Handler[]> => ({
    "POST /v1/oauth/token": tokenOk(),
    "POST /v1/connect/proj_abc/tokens": () => json({ token: "ctok_1", expires_at: "2026-10-19T11:00:00Z", connect_link_url: LINK }),
    [ACCOUNTS]: accountReads,
  });

  it("the Connect Link names the app", () => {
    expect(P.connectLinkFor(LINK, "google_calendar")).toBe(`${LINK}&app=google_calendar`);
  });

  it("asks for a connect token for this user, opens the link, and polls until a NEW account appears", async () => {
    configure();
    const pd = fakePd(connectRoutes([
      accounts(acct("apn_old")),            // before
      accounts(acct("apn_old")),            // first poll: nothing new
      accounts(acct("apn_old"), acct("apn_new")),
    ]));
    const opened: string[] = [];
    const progress: string[] = [];
    const r = await P.pdConnect("gmail", { open: (u) => { opened.push(u); }, onProgress: (p) => progress.push(p.phase), pollMs: 1 });
    expect(r.ok).toBe(true);
    expect(r.ok && r.account.id).toBe("apn_new");
    expect(opened).toEqual([`${LINK}&app=gmail`]);
    expect(progress).toEqual(["opening", "waiting", "done"]);
    expect(pd.calls.find((c) => c.url.endsWith("/tokens"))!.body).toEqual({ external_user_id: P.EXTERNAL_USER_ID });
    const appReads = pd.calls.filter((c) => c.url.includes("/accounts") && new URL(c.url).searchParams.get("app") === "gmail");
    expect(appReads.length).toBe(3);
    // The full list was re-read, so the tools see the new app at once.
    expect(P.cachedPdAccounts().map((a) => a.id)).toContain("apn_new");
  });

  it("times out when nothing new lands", async () => {
    configure();
    fakePd(connectRoutes([accounts(acct("apn_old"))]));
    const r = await P.pdConnect("gmail", { open: () => undefined, pollMs: 1, timeoutMs: 15 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/No new account showed up/);
  });

  it("a 429 while polling waits and carries on", async () => {
    configure();
    fakePd(connectRoutes([
      accounts(),
      () => json({ error: "slow" }, 429, { "retry-after": "0" }),
      accounts(acct("apn_new")),
    ]));
    const r = await P.pdConnect("gmail", { open: () => undefined, pollMs: 1 });
    expect(r.ok).toBe(true);
  });

  it("cancel stops the poll and says so", async () => {
    configure();
    fakePd(connectRoutes([accounts()]));
    const ctl = new AbortController();
    const done = P.pdConnect("gmail", { open: () => { setTimeout(() => ctl.abort(), 5); }, signal: ctl.signal, pollMs: 2 });
    const r = await done;
    expect(r).toEqual({ phase: "done", app: "gmail", ok: false, error: "Connecting was cancelled.", cancelled: true });
  });

  it("a failure along the way is the result, not a throw", async () => {
    configure();
    fakePd({ "POST /v1/oauth/token": tokenOk(), [ACCOUNTS]: accounts(), "POST /v1/connect/proj_abc/tokens": () => json({ error: "project not found" }, 404) });
    const r = await P.pdConnect("gmail", { open: () => undefined });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/404: project not found/);
  });
});

describe("MCP", () => {
  it("hands the dialer the v3 URL and the x-pd headers with a bearer", async () => {
    configure({ environment: "production" });
    fakePd({ "POST /v1/oauth/token": tokenOk("tok-mcp") });
    expect(await P.pdMcpAuth("gmail")).toEqual({
      url: "https://remote.mcp.pipedream.net/v3",
      token: "tok-mcp",
      headers: {
        Authorization: "Bearer tok-mcp",
        "x-pd-project-id": "proj_abc",
        "x-pd-environment": "production",
        "x-pd-external-user-id": "glyphh-local",
        "x-pd-app-slug": "gmail",
      },
    });
  });
});
