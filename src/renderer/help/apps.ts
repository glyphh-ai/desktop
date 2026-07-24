/**
 * Apps section — apps list + all tabs (dashboard, panel, connection, mcp).
 */

import {
  paginate, renderPaginationBar, confirmAction, clearInvalid,
  formatBytes, relativeTime, buildPaginationBar, cssVar, closeHelp,
} from "./shared.js";
import { appIconInner, primeConnectedIcons, primeNativeIcons } from "./app-icon.js";
import { gotoSection } from "./navigation.js";
import { formatMarkdown } from "../format-markdown.js";

declare const Chart: any;

// ── Apps (unified: apps + MCP + connections) ────────────

let appsPage = 0;
const APPS_PER_PAGE = 24;
const appsList = document.getElementById("apps-list")!;
const appDetail = document.getElementById("app-detail")!;
const appAddForm = document.getElementById("app-add-form")!;
const appDetailId = document.getElementById("app-detail-id") as HTMLInputElement;
const appDetailName = document.getElementById("app-detail-name") as HTMLInputElement;
const appDetailUrl = document.getElementById("app-detail-url") as HTMLInputElement;
const appSearchInput = document.getElementById("app-search") as HTMLInputElement;
const appPreview = document.getElementById("app-preview") as HTMLElement & {
  src: string;
  partition: string;
  getWebContentsId: () => number;
  reload: () => void;
};
const appsToolbar = document.getElementById("apps-toolbar")!;
const appFormError = document.getElementById("app-form-error")!;
const appDetailHeading = document.getElementById("app-detail-heading")!;

let currentAppId = "";
let currentApp: PanelApp | null = null;
let activeAppTab: "dashboard" | "config" = "dashboard";

// Reasonable default guardrails, prefilled in the per-app Guardrails tab (and
// mirrored in the org Security panels) so a new app is never shipped unbounded.
// All sit under the server GUARDRAIL_FLOOR, so they only ever tighten.
const DEFAULT_GUARDRAILS: Record<string, number> = {
  maxInputTokens: 16000,
  maxOutputTokens: 4000,
  windowSeconds: 60,
  windowTokens: 200000,
  windowCalls: 100,
  maxConcurrent: 4,
};

// ── Browser ↔ Native helpers (pivot-mcp) ─────────────────
// Apps are either web apps (isBrowser, url + launchConfig browser/openAs) or native desktop
// apps (execPath + an archetype-specific launchConfig). These build/read the
// launchConfig from the flat DOM fields, shared by the add + detail forms.
type Archetype = "terminal" | "editor" | "generic";

// Local mirror of preload.ts PanelAppInput — apps.ts is a standalone renderer
// module and can't name the type declared in renderer.ts's `declare global`,
// so it re-declares a structurally-identical alias for building patch bodies.
type PanelAppInput = {
  name?: string;
  slug?: string;
  url?: string | null;
  isBrowser?: boolean;
  execPath?: string | null;
  appArchetype?: string | null;
  launchConfig?: Record<string, unknown> | null;
};

function readLaunchConfig(prefix: string, archetype: Archetype): Record<string, unknown> {
  const val = (id: string) => (document.getElementById(`${prefix}-${id}`) as HTMLInputElement | HTMLTextAreaElement | null)?.value.trim() || "";
  if (archetype === "terminal") {
    const lc: Record<string, unknown> = {};
    lc.windowMode = val("window-mode") || "window";
    if (val("shell")) lc.shell = val("shell");
    if (val("profile")) lc.profile = val("profile");
    if (val("cwd")) lc.cwd = val("cwd");
    const cmds = val("init-commands").split("\n").map((s) => s.trim()).filter(Boolean);
    if (cmds.length) lc.initCommands = cmds;
    return lc;
  }
  if (archetype === "editor") {
    const lc: Record<string, unknown> = {};
    if (val("folder")) lc.folder = val("folder");
    return lc;
  }
  const lc: Record<string, unknown> = {};
  const args = val("args") ? val("args").split(/\s+/) : [];
  if (args.length) lc.args = args;
  return lc;
}

function writeLaunchConfig(prefix: string, archetype: Archetype, lc: Record<string, unknown> | null | undefined): void {
  const set = (id: string, v: string) => { const el = document.getElementById(`${prefix}-${id}`) as HTMLInputElement | HTMLTextAreaElement | null; if (el) el.value = v; };
  const c = lc || {};
  set("window-mode", c.windowMode === "tab" ? "tab" : c.windowMode === "blank" ? "blank" : "window");
  set("shell", typeof c.shell === "string" ? c.shell : "");
  set("profile", typeof c.profile === "string" ? c.profile : "");
  set("cwd", typeof c.cwd === "string" ? c.cwd : "");
  set("init-commands", Array.isArray(c.initCommands) ? (c.initCommands as string[]).join("\n") : "");
  set("folder", typeof c.folder === "string" ? c.folder : "");
  set("args", Array.isArray(c.args) ? (c.args as string[]).join(" ") : "");
}

// Show only the archetype-specific field block that matches the selection.
function toggleArchetypeFields(prefix: string, archetype: Archetype): void {
  document.getElementById(`${prefix}-terminal-fields`)?.classList.toggle("hidden", archetype !== "terminal");
  document.getElementById(`${prefix}-editor-fields`)?.classList.toggle("hidden", archetype !== "editor");
  document.getElementById(`${prefix}-generic-fields`)?.classList.toggle("hidden", archetype !== "generic");
}

// Show the browser-vs-native field blocks for a given form prefix. A glyphh app
// is BUILT, not configured here, so it is not one of the choices.
type AppType = "browser" | "native";

function toggleTypeFields(prefix: string, type: AppType): void {
  document.getElementById(`${prefix}-browser-fields`)?.classList.toggle("hidden", type !== "browser");
  document.getElementById(`${prefix}-native-fields`)?.classList.toggle("hidden", type !== "native");
}

// ── Installed Glyphh apps: tool approval + guardrails ───────────────────────

/** The tools an installed Glyphh app declares in its bundle manifest. */
function appExposableTools(app: { appArchetype?: string | null; launchConfig?: Record<string, unknown> | null }): Array<{ name: string; description: string }> {
  const lc = (app.launchConfig || {}) as Record<string, unknown>;
  const declared = Array.isArray(lc.tools) ? (lc.tools as Array<{ name?: string; description?: string }>) : [];
  return declared.filter((t) => t?.name).map((t) => ({ name: String(t.name), description: String(t.description || "") }));
}

/** True when an app has an MCP surface worth showing the MCP/Guardrails tabs. */
function appExposesMcp(app: { appArchetype?: string | null; launchConfig?: Record<string, unknown> | null }): boolean {
  return appExposableTools(app).length > 0;
}

/** Show/hide + populate the MCP and Guardrails tabs for the open app. */
function syncMcpTabs(app: PanelApp): void {
  const exposes = appExposesMcp(app);
  document.querySelectorAll<HTMLElement>(".tab-mcp-only").forEach((el) => el.classList.toggle("hidden", !exposes));
  if (!exposes) return;

  const lc = (app.launchConfig || {}) as Record<string, unknown>;

  // Public endpoint URL.
  const ep = document.getElementById("app-mcp-endpoint");
  if (ep) ep.textContent = `https://${app.slug}.glyphh.app/mcp`;

  // Approved-tools list — allowlist, so anything NOT in mcpApproved is off,
  // including newly-appeared tools (safe default).
  const approved = new Set(Array.isArray(lc.mcpApproved) ? (lc.mcpApproved as string[]) : []);
  const tools = appExposableTools(app);
  const list = document.getElementById("app-mcp-tools")!;
  const empty = document.getElementById("app-mcp-tools-empty");
  empty?.classList.toggle("hidden", tools.length > 0);
  list.innerHTML = "";
  for (const t of tools) {
    const row = document.createElement("label");
    row.className = "mcp-tool-row";
    row.innerHTML = `
      <input type="checkbox" class="mcp-tool-check" data-tool="${escMkt(t.name)}" ${approved.has(t.name) ? "checked" : ""} />
      <div class="mcp-tool-info">
        <span class="mcp-tool-name">${escMkt(t.name)}</span>
        <span class="mcp-tool-desc">${escMkt(t.description)}</span>
      </div>`;
    list.appendChild(row);
  }

  // Test-a-tool picker — runs the tool through the local runtime.
  document.getElementById("app-mcp-test-section")?.classList.toggle("hidden", tools.length === 0);
  const testSel = document.getElementById("app-mcp-test-tool") as HTMLSelectElement | null;
  if (testSel) testSel.innerHTML = tools.map((t) => `<option value="${escMkt(t.name)}">${escMkt(t.name)}</option>`).join("");

  // "Select all" reflects the current approvals (hidden when there are no tools).
  document.getElementById("app-mcp-select-all-wrap")?.classList.toggle("hidden", tools.length === 0);
  updateMcpSelectAll();

  // Guardrails fields.
  const g = (lc.guardrails || {}) as Record<string, unknown>;
  const setNum = (id: string, v: unknown) => { (document.getElementById(id) as HTMLInputElement).value = v == null ? "" : String(v); };
  setNum("app-gr-max-input", g.maxInputTokens ?? DEFAULT_GUARDRAILS.maxInputTokens);
  setNum("app-gr-max-output", g.maxOutputTokens ?? DEFAULT_GUARDRAILS.maxOutputTokens);
  setNum("app-gr-window", g.windowSeconds ?? DEFAULT_GUARDRAILS.windowSeconds);
  setNum("app-gr-window-tokens", g.windowTokens ?? DEFAULT_GUARDRAILS.windowTokens);
  setNum("app-gr-window-calls", g.windowCalls ?? DEFAULT_GUARDRAILS.windowCalls);
  setNum("app-gr-concurrent", g.maxConcurrent ?? DEFAULT_GUARDRAILS.maxConcurrent);
}

/** Read the MCP-approval + guardrails fields back into a launchConfig patch. */
function readMcpConfig(): { mcpApproved: string[]; guardrails: Record<string, number> } {
  const mcpApproved = Array.from(document.querySelectorAll<HTMLInputElement>(".mcp-tool-check"))
    .filter((c) => c.checked).map((c) => c.dataset.tool!).filter(Boolean);
  const num = (id: string): number | undefined => {
    const v = (document.getElementById(id) as HTMLInputElement | null)?.value.trim();
    if (!v) return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const guardrails: Record<string, number> = {};
  const put = (k: string, v: number | undefined) => { if (v !== undefined) guardrails[k] = v; };
  put("maxInputTokens", num("app-gr-max-input"));
  put("maxOutputTokens", num("app-gr-max-output"));
  put("windowSeconds", num("app-gr-window"));
  put("windowTokens", num("app-gr-window-tokens"));
  put("windowCalls", num("app-gr-window-calls"));
  put("maxConcurrent", num("app-gr-concurrent"));
  return { mcpApproved, guardrails };
}

/** Sync the MCP "Select all" checkbox to the tool checkboxes — checked when all
 *  are on, indeterminate when only some are. */
function updateMcpSelectAll(): void {
  const sa = document.getElementById("app-mcp-select-all") as HTMLInputElement | null;
  if (!sa) return;
  const all = Array.from(document.querySelectorAll<HTMLInputElement>(".mcp-tool-check"));
  const checked = all.filter((c) => c.checked).length;
  sa.checked = all.length > 0 && checked === all.length;
  sa.indeterminate = checked > 0 && checked < all.length;
}

/** Persist just the MCP-approval + Guardrails fields (from either tab), merged
 *  into the app's launchConfig — a per-tab Save that doesn't close the detail. */
async function saveMcpGuardrails(statusId: string): Promise<void> {
  if (!currentAppId) return;
  const { mcpApproved, guardrails } = readMcpConfig();
  const base = (currentApp?.launchConfig || {}) as Record<string, unknown>;
  const launchConfig = { ...base, mcpApproved, guardrails };
  const statusEl = document.getElementById(statusId);
  if (statusEl) statusEl.textContent = "Saving…";
  const res = await window.yo.panelAppsUpdate(currentAppId, { launchConfig });
  if (res?.ok && currentApp) currentApp.launchConfig = launchConfig;
  if (statusEl) {
    statusEl.textContent = res?.ok ? "Saved ✓" : (res?.error || "Save failed");
    setTimeout(() => { if (statusEl.textContent === "Saved ✓") statusEl.textContent = ""; }, 2500);
  }
}

/** Invoke one of the app's exposed tools through the local runtime and show the
 *  result — a smoke test before external agents rely on it (installed apps). */
async function testMcpTool(): Promise<void> {
  const sel = document.getElementById("app-mcp-test-tool") as HTMLSelectElement | null;
  const argsEl = document.getElementById("app-mcp-test-args") as HTMLTextAreaElement | null;
  const out = document.getElementById("app-mcp-test-result");
  const tool = sel?.value;
  if (!currentApp || !tool || !out) return;
  let args: unknown = {};
  const raw = (argsEl?.value || "").trim();
  if (raw) {
    try { args = JSON.parse(raw); }
    catch { out.classList.remove("hidden"); out.textContent = "Args must be valid JSON."; return; }
  }
  out.classList.remove("hidden");
  out.textContent = "Running…";
  const res = await window.yo.appCallTool(currentApp.slug, tool, args);
  out.textContent = res?.ok
    ? (typeof res.result === "string" ? res.result : JSON.stringify(res.result, null, 2))
    : `Error: ${res?.error || "failed"}`;
}

// Dashboard shell (5a): apps are server objects (yo-server's saved_apps),
// not local ones — `id` is the server row's UUID (used for every write:
// update/delete/connection/mcp/commands); `slug` is the human-readable
// identifier shown/edited in the UI (was previously `id` in the local model).
interface PanelApp {
  id: string;
  slug: string;
  name: string;
  system?: boolean;
  url?: string | null;
  // Browser ↔ Native model (pivot-mcp).
  isBrowser?: boolean;
  execPath?: string | null;
  appArchetype?: string | null;
  launchConfig?: Record<string, unknown> | null;
  /** Who may reach it once deployed — shown + set on the Public hosting tab. */
  access?: string;
  /** True when this org published the app — an installed app hides publish tabs. */
  owned?: boolean;
  /** Newest live release version, or null — drives the auto-update banner. */
  latestVersion?: string | null;
  /** Connections the manifest requires, with connected status. */
  requiredConnections?: { slug: string; actAs: string; connected: boolean }[];
  /** The marketplace listing — copy, images, rating, listed state. */
  listing?: {
    title: string; tagline: string | null; category: string | null; body: string | null;
    iconUrl: string | null; screenshots: { url: string; caption: string }[];
    videoUrl: string | null; website: string | null; supportEmail: string | null;
    ratingAvg: number; ratingCount: number; listedAt: string | null;
  };
  commands?: Record<string, { selector: string; action: string; description?: string; text?: string }>;
  connectionIds?: string[];
  mcp?: { transport: "stdio" | "sse" | "streamable-http"; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; oauth?: { clientId: string; hasSecret: boolean; tokenUrl: string; scope?: string }; enabled: boolean } | null;
}

function toPanelApp(a: {
  id: string; slug: string; name: string; system?: boolean; url: string | null;
  isBrowser?: boolean; execPath?: string | null;
  appArchetype?: string | null; launchConfig?: Record<string, unknown> | null;
  access?: string; listing?: PanelApp["listing"];
  owned?: boolean; latestVersion?: string | null;
  requiredConnections?: { slug: string; actAs: string; connected: boolean }[];
  commands: Record<string, { selector: string; action: string; description?: string; text?: string }>;
  connectionIds: string[];
  mcp: { transport: "stdio" | "sse" | "streamable-http"; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; oauth?: { clientId: string; hasSecret: boolean; tokenUrl: string; scope?: string }; enabled: boolean } | null;
}): PanelApp {
  return {
    id: a.id, slug: a.slug, name: a.name, system: a.system, url: a.url,
    isBrowser: a.isBrowser, execPath: a.execPath,
    appArchetype: a.appArchetype, launchConfig: a.launchConfig, access: a.access, listing: a.listing,
    owned: a.owned, latestVersion: a.latestVersion, requiredConnections: a.requiredConnections,
    commands: a.commands, connectionIds: a.connectionIds, mcp: a.mcp,
  };
}

let panelApps: PanelApp[] = [];

/** Open an app the way its config dictates (Browser↔Native model): native apps
 *  launch their executable, browser apps open in native Chrome or Glyphh's
 *  the configured real browser (window or tab). Returns the launch result so callers can
 *  surface an error. */
async function launchPanelApp(app: PanelApp): Promise<{ ok: boolean; error?: string }> {
  return window.yo.appLaunch({
    slug: app.slug, name: app.name, url: app.url,
    isBrowser: app.isBrowser,
    execPath: app.execPath, appArchetype: app.appArchetype, launchConfig: app.launchConfig,
  });
}

async function loadApps() {
  appDetail.classList.add("hidden");
  appAddForm.classList.add("hidden");

  document.getElementById("apps-pro-gate")!.classList.add("hidden");
  appsList.classList.remove("hidden");
  appsToolbar.classList.remove("hidden");

  try {
    const apps = await window.yo.panelAppsList();
    // Keep browser apps (have a url) and native apps (isBrowser === false).
    // Legacy rows have neither field set but always carry a url, so the url
    // check still covers them.
    // Hide seeded system apps (Glyphh) — they aren't user-managed.
    panelApps = apps.filter((a) => !a.system && (a.url || a.isBrowser === false)).map(toPanelApp);
  } catch { panelApps = []; }
  // The rail's Apps grid mirrors this list — tell it to refresh.
  document.dispatchEvent(new CustomEvent("glyphh:apps-changed"));

  document.getElementById("apps-limit-msg")!.classList.add("hidden");

  renderAppsList();
  // Async — re-renders once OS file icons (native apps) land. Apps no longer
  // carry a Pipedream connection (Connections are their own tab now), so their
  // icon comes from the url favicon or the executable icon.
  void primeNativeIcons(panelApps, renderAppsList);
}

function renderAppsList() {
  const query = appSearchInput.value.trim().toLowerCase();

  const filtered = query
    ? panelApps.filter((a) => a.name.toLowerCase().includes(query) || (a.url || "").toLowerCase().includes(query))
    : panelApps;

  appsList.className = "app-list-wrap";

  if (panelApps.length === 0) {
    appsList.innerHTML = `<div class="crud-empty">No apps yet. Click "+ New" to add one.</div>`;
    return;
  }
  if (filtered.length === 0) {
    appsList.innerHTML = `<div class="crud-empty">No apps matching "${query}"</div>`;
    return;
  }

  const { items: pageApps, state } = paginate(filtered, appsPage, APPS_PER_PAGE);
  appsPage = state.page;
  appsList.innerHTML = "";

  // Cards live in their own grid; the pagination bar is a sibling below it
  // (appending the bar into the grid would make it a stray grid cell).
  const grid = document.createElement("div");
  grid.className = "app-grid";
  for (const app of pageApps) {
    const badges: string[] = [];

    const card = document.createElement("div");
    card.className = "app-card";
    card.innerHTML = `
      ${badges.join("")}
      <div class="app-card-icon">${appIconInner(app, app.name, "app-card-initial")}</div>
      <div class="app-card-name">${app.name}</div>
      <div class="app-card-id">${app.slug}</div>`;

    card.addEventListener("click", () => openPanelAppDetail(app));
    // Double-click skips the editor and opens the app per its config (5b) —
    // webview window, native Chrome, or a native executable.
    card.addEventListener("dblclick", () => { void launchPanelApp(app); });
    grid.appendChild(card);
  }
  appsList.appendChild(grid);

  if (state.totalPages > 1) {
    appsList.appendChild(renderPaginationBar(state, (p) => { appsPage = p; renderAppsList(); }));
  }
}

// ── Marketplace (Shopify-style storefront) ───────────────
// Public catalog + org-private apps: search, categories, sponsored + popular
// strips, paginated grid. Backed by marketplace.ts (placeholder catalog until
// the yo-server routes land).
type MktApp = Awaited<ReturnType<typeof window.yo.marketplaceList>>["items"][number];

const marketplaceLibraryPage = document.getElementById("apps-library-page")!;
const marketplacePage = document.getElementById("apps-marketplace-page")!;
const mktStoreEl = document.getElementById("mkt-store")!;
const mktDetailEl = document.getElementById("mkt-detail")!;
const mktSearchInput = document.getElementById("mkt-search") as HTMLInputElement;
const mktSortSelect = document.getElementById("mkt-sort") as HTMLSelectElement;
const mktCategoriesEl = document.getElementById("mkt-categories")!;
const mktFeaturedWrap = document.getElementById("mkt-featured")!;
const mktFeaturedList = document.getElementById("mkt-featured-list")!;
const mktPopularWrap = document.getElementById("mkt-popular")!;
const mktPopularList = document.getElementById("mkt-popular-list")!;
const mktListEl = document.getElementById("mkt-list")!;
const mktPagerEl = document.getElementById("mkt-pager")!;
const mktCountEl = document.getElementById("mkt-count")!;
const mktAllTitle = document.getElementById("mkt-all-title")!;

let mktScope: "public" | "private" = "public";
let mktCategory = "";
let mktQuery = "";
let mktSort: "popular" | "rating" | "newest" = "popular";
let mktPage = 1;
let mktSearchTimer: ReturnType<typeof setTimeout> | null = null;

function escMkt(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Canonical domain per connection slug — feeds appIconInner's favicon fallback
// so a real brand icon still shows if the Pipedream catalog icon isn't cached.
const CONN_DOMAIN: Record<string, string> = {
  slack: "slack.com", slack_v2: "slack.com", gmail: "mail.google.com", notion: "notion.so", github: "github.com",
  linear: "linear.app", google_sheets: "sheets.google.com", hubspot: "hubspot.com",
  stripe: "stripe.com", figma: "figma.com", google_calendar: "calendar.google.com",
  snowflake: "snowflake.com", google_drive: "drive.google.com", google_slides: "slides.google.com",
  okta: "okta.com", zendesk: "zendesk.com",
};

/** A single required-connection icon — identical to the Layouts row
 *  (appIconInner, icon only, name on hover), just sized smaller. Resolution
 *  order matches the rest of the app: Pipedream catalog icon → favicon → initial. */
function mktConnChip(conn: { name: string; slug: string }): string {
  const domain = CONN_DOMAIN[conn.slug];
  const app = { url: domain ? `https://${domain}` : undefined, connection: { accountId: "mkt", pipedreamSlug: conn.slug } };
  return `<span class="mkt-conn" title="${escMkt(conn.name)}">${appIconInner(app, conn.name, "mkt-conn-initial")}</span>`;
}

/** Row of required-connection icons (icons only, like the Layouts card). */
/** A YouTube or Vimeo demo as an embedded iframe. Only these two hosts (the
 *  server restricts the link to them), so the embed URL is derived safely. */
function mktVideoEmbed(url: string | null | undefined): string {
  if (!url) return "";
  let embed = "";
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") embed = `https://www.youtube.com/embed/${u.pathname.slice(1)}`;
    else if (host.endsWith("youtube.com")) { const v = u.searchParams.get("v"); if (v) embed = `https://www.youtube.com/embed/${v}`; }
    else if (host.endsWith("vimeo.com")) { const id = u.pathname.split("/").filter(Boolean).pop(); if (id) embed = `https://player.vimeo.com/video/${id}`; }
  } catch { /* not a URL — no embed */ }
  if (!embed) return "";
  return `<section class="mkt-dt-section"><h3>Demo</h3>
    <div class="mkt-video"><iframe src="${escMkt(embed)}" allow="fullscreen; picture-in-picture" allowfullscreen loading="lazy"></iframe></div></section>`;
}

/** Required connections with connected status — what the app needs to work. */
function mktRequiredConns(conns: Array<{ slug: string; actAs: string; connected: boolean }> | undefined): string {
  if (!conns || !conns.length) return "";
  const rows = conns.map((c) => `
    <div class="mkt-req-conn">
      ${mktConnChip({ name: connLabel(c.slug), slug: c.slug })}
      <span class="mkt-req-conn-name">${escMkt(connLabel(c.slug))}</span>
      <span class="app-conn-status ${c.connected ? "ok" : "missing"}">${c.connected ? "Connected" : "Not connected"}</span>
    </div>`).join("");
  return `<section class="mkt-dt-section">
    <h3>Requires</h3>
    <p class="settings-hint" style="margin:0 0 8px;">This app calls these connected accounts through Glyphh's governed connectors.</p>
    <div class="mkt-req-conns">${rows}</div></section>`;
}

function mktConnRow(conns: Array<{ name: string; slug: string }>): string {
  if (!conns || conns.length === 0) return "";
  return `<div class="mkt-conns">${conns.map(mktConnChip).join("")}</div>`;
}

/** Pseudo-apps (connection-only) to hand to primeConnectedIcons so it fetches
 *  the Pipedream catalog icon for every required-connection slug on screen. */
function mktConnIconApps(conns: Array<{ slug: string }>): Array<{ connection: { accountId: string; pipedreamSlug: string } }> {
  const slugs = new Set(conns.map((c) => c.slug));
  return [...slugs].map((slug) => ({ connection: { accountId: "mkt", pipedreamSlug: slug } }));
}

// Pretty display name for a connector slug ("slack_v2" → "Slack").
const CONN_LABEL: Record<string, string> = {
  slack_v2: "Slack", gmail: "Gmail", google_calendar: "Google Calendar",
  google_sheets: "Google Sheets", google_drive: "Google Drive",
};
function connLabel(slug: string): string {
  return CONN_LABEL[slug] || slug.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** "Required connections" block on the app editor — one row per connector the
 *  installed app's manifest declares, with live connected/not-connected status.
 *  The app's tools call these accounts; missing ones mean the app WILL fail,
 *  so the warning line under the list says exactly that. */
async function renderRequiredConnections(app: PanelApp): Promise<void> {
  const wrap = document.getElementById("app-req-conns");
  const list = document.getElementById("app-req-conns-list");
  const warn = document.getElementById("app-req-conns-warn");
  if (!wrap || !list || !warn) return;
  const required = ((app.launchConfig?.connectors as string[] | undefined) || []).filter(Boolean);
  if (!required.length) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");

  let connected = new Set<string>();
  try {
    const res = await window.yo.connectionsList();
    connected = new Set((res.connections || []).map((c) => c.appSlug));
  } catch { /* status unknown — render everything as missing */ }

  const render = () => {
    list.innerHTML = required.map((slug) => {
      const ok = connected.has(slug);
      return `<div class="app-req-conn-row">
        ${mktConnChip({ name: connLabel(slug), slug })}
        <span class="app-req-conn-name">${escMkt(connLabel(slug))}</span>
        <span class="app-req-conn-status ${ok ? "ok" : "missing"}">${ok ? "Connected" : "Not connected"}</span>
      </div>`;
    }).join("");
  };
  render();
  warn.classList.toggle("hidden", required.every((s) => connected.has(s)));
  primeConnectedIcons(mktConnIconApps(required.map((slug) => ({ slug }))), render);
}

function mktCard(app: MktApp, variant: "grid" | "row" | "featured"): HTMLElement {
  const card = document.createElement("div");
  card.className = `mkt-card mkt-card-${variant}`;
  const price = app.priceCredits > 0 ? `${app.priceCredits} credits/mo` : "Free plan available";
  const icon = app.iconUrl ? `<img src="${escMkt(app.iconUrl)}" alt="" />` : `<span class="mkt-card-initial">${escMkt((app.name || "?").charAt(0).toUpperCase())}</span>`;
  card.innerHTML = `
    <div class="mkt-card-top">
      <div class="mkt-card-icon">${icon}</div>
      <div class="mkt-card-head">
        <div class="mkt-card-name">${escMkt(app.name)}</div>
        <div class="mkt-card-metaline">
          ${app.featured ? `<span class="mkt-ad">Ad</span>` : ""}
          <span class="mkt-rating"><b>${app.rating.toFixed(1)}</b> <span class="mkt-stars">★</span> <span class="mkt-rating-count">(${app.ratingCount.toLocaleString()})</span></span>
          <span class="mkt-dot">•</span>
          <span class="mkt-price">${escMkt(price)}</span>
        </div>
      </div>
    </div>
    <div class="mkt-card-tagline">${escMkt(app.tagline)}</div>
    ${mktConnRow(app.connections)}`;
  // The whole card is a link into the detail page — no per-card Install button.
  card.setAttribute("role", "link");
  card.tabIndex = 0;
  card.addEventListener("click", () => void openMktDetail(app.id));
  card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void openMktDetail(app.id); } });
  return card;
}

function flashMktNote(msg: string): void {
  let note = document.getElementById("mkt-note");
  if (!note) {
    note = document.createElement("div");
    note.id = "mkt-note";
    note.className = "mkt-note";
    marketplacePage.prepend(note);
  }
  note.textContent = msg;
  note.classList.remove("hidden");
  setTimeout(() => note?.classList.add("hidden"), 4000);
}

function renderMktCategories(cats: Array<{ id: string; label: string; count: number }>): void {
  mktCategoriesEl.innerHTML = "";
  const chip = (id: string, label: string, count?: number) => {
    const b = document.createElement("button");
    b.className = "mkt-cat" + (mktCategory === id ? " active" : "");
    b.textContent = count != null ? `${label} ${count}` : label;
    b.addEventListener("click", () => { mktCategory = mktCategory === id ? "" : id; mktPage = 1; void loadMarketplace(); });
    return b;
  };
  mktCategoriesEl.appendChild(chip("", "All"));
  for (const c of cats) mktCategoriesEl.appendChild(chip(c.id, c.label, c.count));
}

type MktRes = Awaited<ReturnType<typeof window.yo.marketplaceList>>;
let lastMktRes: MktRes | null = null;

async function loadMarketplace(): Promise<void> {
  mktListEl.innerHTML = `<div class="crud-empty">Loading…</div>`;
  try {
    lastMktRes = await window.yo.marketplaceList({ scope: mktScope, category: mktCategory || undefined, q: mktQuery || undefined, sort: mktSort, page: mktPage });
  } catch {
    lastMktRes = null;
    mktListEl.innerHTML = `<div class="crud-empty">Marketplace unavailable right now.</div>`;
    return;
  }
  renderMktStorefront(lastMktRes);
  // Fetch the real Pipedream catalog icons for every required connection on
  // screen, then re-render so chips swap from initials to the icons the Apps
  // and Layouts pages use. primeConnectedIcons only re-fires for uncached
  // slugs, so this can't loop.
  const conns = [...lastMktRes.featured, ...lastMktRes.popular, ...lastMktRes.items].flatMap((a) => a.connections);
  void primeConnectedIcons(mktConnIconApps(conns), () => { if (lastMktRes) renderMktStorefront(lastMktRes); });
}

function renderMktStorefront(res: MktRes): void {
  renderMktCategories(res.categories);

  // Strips only on the default view (no search / category / non-first page).
  const stripsVisible = !mktQuery && !mktCategory && mktPage === 1;
  mktFeaturedWrap.classList.toggle("hidden", !stripsVisible || res.featured.length === 0);
  mktPopularWrap.classList.toggle("hidden", !stripsVisible || res.popular.length === 0);
  if (stripsVisible) {
    mktFeaturedList.innerHTML = "";
    for (const a of res.featured) mktFeaturedList.appendChild(mktCard(a, "featured"));
    mktPopularList.innerHTML = "";
    for (const a of res.popular) mktPopularList.appendChild(mktCard(a, "row"));
  }

  mktAllTitle.textContent = mktCategory ? (res.categories.find((c) => c.id === mktCategory)?.label || "Apps")
    : mktQuery ? `Results for “${mktQuery}”` : "All apps";
  mktCountEl.textContent = res.total ? `${res.total} app${res.total === 1 ? "" : "s"}` : "";

  mktListEl.innerHTML = "";
  if (res.items.length === 0) {
    mktListEl.innerHTML = mktScope === "private"
      ? `<div class="crud-empty">Your organization hasn't published any apps yet. Publish from your CI, then release them to members.</div>`
      : `<div class="crud-empty">No apps match your search.</div>`;
  } else {
    for (const a of res.items) mktListEl.appendChild(mktCard(a, "grid"));
  }

  // Pagination.
  mktPagerEl.innerHTML = "";
  const totalPages = Math.max(1, Math.ceil(res.total / res.pageSize));
  if (totalPages > 1) {
    const mk = (label: string, to: number, disabled: boolean) => {
      const b = document.createElement("button");
      b.className = "pagination-btn"; b.textContent = label; b.disabled = disabled;
      b.addEventListener("click", () => { mktPage = to; void loadMarketplace(); marketplacePage.scrollTop = 0; });
      return b;
    };
    mktPagerEl.appendChild(mk("‹ Prev", mktPage - 1, mktPage <= 1));
    const info = document.createElement("span");
    info.className = "pagination-info";
    info.textContent = `${mktPage} / ${totalPages}`;
    mktPagerEl.appendChild(info);
    mktPagerEl.appendChild(mk("Next ›", mktPage + 1, mktPage >= totalPages));
  }
}

// ── App detail page (Shopify-style listing) ──────────────
type MktDetail = NonNullable<Awaited<ReturnType<typeof window.yo.marketplaceDetail>>>;

const MKT_CATEGORY_LABELS: Record<string, string> = {
  productivity: "Productivity", communication: "Communication", developer: "Developer tools",
  ai: "AI & automation", marketing: "Marketing & sales", finance: "Finance",
  design: "Design", data: "Data & analytics",
};
const mktCheckIcon = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4.5 4.5L19 7"/></svg>`;
const mktDotIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="4"/></svg>`;

/** 5-glyph star row for a rating (rounded). */
function mktStarRow(rating: number): string {
  const full = Math.max(0, Math.min(5, Math.round(rating)));
  return `<span class="mkt-stars">${"★".repeat(full)}${"☆".repeat(5 - full)}</span>`;
}

/** Hide the detail page and return to the storefront grid. */
function closeMktDetail(): void {
  mktDetailEl.classList.add("hidden");
  mktDetailEl.innerHTML = "";
  mktStoreEl.classList.remove("hidden");
  marketplacePage.scrollTop = 0;
}

/** Load + show the detail page for one app id. */
async function openMktDetail(id: string): Promise<void> {
  mktStoreEl.classList.add("hidden");
  mktDetailEl.classList.remove("hidden");
  mktDetailEl.innerHTML = `<button class="mkt-back">‹ Back to marketplace</button><div class="crud-empty">Loading…</div>`;
  mktDetailEl.querySelector(".mkt-back")?.addEventListener("click", closeMktDetail);
  marketplacePage.scrollTop = 0;

  let detail: MktDetail | null = null;
  try { detail = await window.yo.marketplaceDetail(id); }
  catch { detail = null; }
  if (!detail) {
    mktDetailEl.innerHTML = `<button class="mkt-back">‹ Back to marketplace</button><div class="crud-empty">Couldn't load this app right now.</div>`;
    mktDetailEl.querySelector(".mkt-back")?.addEventListener("click", closeMktDetail);
    return;
  }
  renderMktDetail(detail);
}

function renderMktDetail(d: MktDetail): void {
  const catLabel = MKT_CATEGORY_LABELS[d.category] || "Apps";
  const priceLabel = d.priceCredits > 0 ? `From ${d.priceCredits} credits/mo` : "Free plan available";
  const ctaNote = d.priceCredits > 0 ? "Free trial available" : "Free to install";
  const total = d.ratingCount || d.ratingBreakdown.reduce((a, b) => a + b.count, 0) || 1;

  const highlights = d.highlights.map((h) => `<li>${mktCheckIcon}<span>${escMkt(h)}</span></li>`).join("");
  // The description is markdown — render it, don't escape it into raw syntax.
  const descHtml = d.description ? formatMarkdown(d.description) : "";
  // A demo video (YouTube/Vimeo) embeds above the gallery when present.
  const videoHtml = mktVideoEmbed(d.videoUrl);
  // Required connections with the caller's connected status.
  const reqConnHtml = mktRequiredConns(d.requiredConnections);

  const plans = d.plans.map((p) => `
    <div class="mkt-plan">
      <div class="mkt-plan-name">${escMkt(p.name)}</div>
      <div class="mkt-plan-price">${p.priceCredits > 0 ? `${p.priceCredits}<small> credits/mo</small>` : "Free"}</div>
      ${p.blurb ? `<div class="mkt-plan-blurb">${escMkt(p.blurb)}</div>` : ""}
      <ul class="mkt-plan-features">${p.features.map((f) => `<li>${mktCheckIcon}<span>${escMkt(f)}</span></li>`).join("")}</ul>
    </div>`).join("");

  const bars = d.ratingBreakdown.map((b) => {
    const pct = Math.round((b.count / total) * 100);
    return `<div class="mkt-bar-row"><span>${b.stars} star</span><div class="mkt-bar-track"><div class="mkt-bar-fill" style="width:${pct}%"></div></div><span class="pct">${pct}%</span></div>`;
  }).join("");

  const reviews = d.reviews.map((r) => `
    <div class="mkt-review">
      <div class="mkt-review-head">${mktStarRow(r.rating)}<span class="mkt-review-date">${escMkt(r.date)}</span></div>
      <p class="mkt-review-body">${escMkt(r.body)}</p>
      <div class="mkt-review-who"><b>${escMkt(r.author)}</b>${r.location ? ` · ${escMkt(r.location)}` : ""}${r.usage ? ` · ${escMkt(r.usage)}` : ""}</div>
    </div>`).join("");

  const works = d.worksWith.map((w) => `<li><span class="dot"></span>${escMkt(w)}</li>`).join("");
  const dataAccess = d.dataAccess.map((a) => `<li>${mktDotIcon}<span>${escMkt(a)}</span></li>`).join("");

  const installBtn = d.installed
    ? `<button class="action-btn mkt-dt-install" disabled>Installed</button>`
    : `<button class="action-btn primary mkt-dt-install">Install</button>`;

  const icon = d.iconUrl ? `<img src="${escMkt(d.iconUrl)}" alt="" />` : `<span class="mkt-card-initial">${escMkt((d.name || "?").charAt(0).toUpperCase())}</span>`;

  mktDetailEl.innerHTML = `
    <button class="mkt-back">‹ Back to marketplace</button>
    <nav class="mkt-crumbs">Marketplace<span class="sep">›</span><a class="mkt-crumb-cat" href="#">${escMkt(catLabel)}</a><span class="sep">›</span><span class="cur">${escMkt(d.name)}</span></nav>

    <header class="mkt-dt-hero">
      <div class="mkt-dt-icon">${icon}</div>
      <div class="mkt-dt-headmain">
        <h1 class="mkt-dt-name">${escMkt(d.name)}</h1>
        <p class="mkt-dt-tagline">${escMkt(d.tagline)}</p>
        <div class="mkt-dt-metarow">
          <span class="mkt-dt-dev">by <b>${escMkt(d.developer.name)}</b></span>
          ${mktConnRow(d.connections)}
        </div>
        <div class="mkt-dt-statrow">${mktStarRow(d.rating)}<b>${d.rating.toFixed(1)}</b><span>(${d.ratingCount.toLocaleString()} reviews)</span><span class="mkt-dot">•</span><span>${escMkt(priceLabel)}</span></div>
      </div>
      <div class="mkt-dt-cta">
        ${installBtn}
        <div class="mkt-dt-price-note">${escMkt(ctaNote)}</div>
      </div>
    </header>

    <div class="mkt-dt-body">
      <div class="mkt-dt-main">
        <section class="mkt-dt-section mkt-gallery">
          <div class="mkt-gallery-main"><img id="mkt-shot-main" src="${escMkt(d.screenshots[0]?.url || "")}" alt="" /></div>
          <div class="mkt-gallery-caption" id="mkt-shot-caption">${escMkt(d.screenshots[0]?.caption || "")}</div>
          <div class="mkt-gallery-thumbs">
            ${d.screenshots.map((s, i) => `<button class="mkt-thumb${i === 0 ? " active" : ""}" data-i="${i}"><img src="${escMkt(s.url)}" alt="" /></button>`).join("")}
          </div>
        </section>

        <section class="mkt-dt-section">
          <h3>Highlights</h3>
          <ul class="mkt-highlights">${highlights}</ul>
        </section>

        ${videoHtml}
        <section class="mkt-dt-section mkt-dt-desc">
          <h3>About ${escMkt(d.name)}</h3>
          <div class="mkt-md">${descHtml}</div>
        </section>
        ${reqConnHtml}

        <section class="mkt-dt-section">
          <h3>Pricing</h3>
          <div class="mkt-plans">${plans}</div>
          <div class="mkt-plans-note">All charges are billed in Glyphh compute credits. ${d.priceCredits > 0 ? "Free trial available." : ""}</div>
        </section>

        <section class="mkt-dt-section">
          <h3>Reviews</h3>
          <div class="mkt-reviews-summary">
            <div class="mkt-reviews-score">
              <div class="big">${d.rating.toFixed(1)}</div>
              ${mktStarRow(d.rating)}
              <div class="cnt">${d.ratingCount.toLocaleString()} reviews</div>
            </div>
            <div class="mkt-reviews-bars">${bars}</div>
          </div>
          <div class="mkt-review-list">${reviews}</div>
        </section>

        ${d.similar.length ? `<section class="mkt-dt-section"><h3>More apps like this</h3><div class="mkt-grid" id="mkt-similar"></div></section>` : ""}
      </div>

      <aside class="mkt-dt-side">
        <div class="mkt-side-card">
          <h4>Works with</h4>
          <ul class="mkt-works">${works}</ul>
        </div>
        <div class="mkt-side-card">
          <h4>Resources</h4>
          <div class="mkt-side-row"><span>Developer</span><b>${escMkt(d.developer.name)}</b></div>
          ${d.website ? `<div class="mkt-side-row"><span>Website</span><a class="mkt-ext" data-url="${escMkt(d.website)}" href="#">${escMkt(d.website.replace(/^https?:\/\//, ""))}</a></div>` : ""}
          <div class="mkt-side-row"><span>Launched</span><b>${escMkt(d.launchedAt)}</b></div>
          ${d.updatedAt ? `<div class="mkt-side-row"><span>Changelog</span><b>${escMkt(d.updatedAt)}</b></div>` : ""}
          <div class="mkt-side-row"><span>Category</span><b>${escMkt(catLabel)}</b></div>
          <div class="mkt-side-row"><span>Languages</span><b>${escMkt(d.languages.join(", "))}</b></div>
          ${d.version ? `<div class="mkt-side-row"><span>Version</span><b>${escMkt(d.version)}</b></div>` : ""}
        </div>
        <div class="mkt-side-card">
          <h4>Data access</h4>
          <ul class="mkt-dataaccess">${dataAccess}</ul>
        </div>
      </aside>
    </div>`;

  // Wire interactions.
  mktDetailEl.querySelector(".mkt-back")?.addEventListener("click", closeMktDetail);
  mktDetailEl.querySelector(".mkt-crumb-cat")?.addEventListener("click", (e) => {
    e.preventDefault();
    mktCategory = d.category; mktQuery = ""; mktPage = 1;
    if (mktSearchInput) mktSearchInput.value = "";
    closeMktDetail(); void loadMarketplace();
  });
  mktDetailEl.querySelector(".mkt-ext")?.addEventListener("click", (e) => {
    e.preventDefault();
    const url = (e.currentTarget as HTMLElement).dataset.url;
    if (url) void window.yo.execCommand(`dip ${url}`);
  });

  const mainImg = mktDetailEl.querySelector("#mkt-shot-main") as HTMLImageElement | null;
  const cap = mktDetailEl.querySelector("#mkt-shot-caption") as HTMLElement | null;
  for (const t of Array.from(mktDetailEl.querySelectorAll<HTMLButtonElement>(".mkt-thumb"))) {
    t.addEventListener("click", () => {
      const i = Number(t.dataset.i);
      const s = d.screenshots[i];
      if (!s || !mainImg) return;
      mainImg.src = s.url;
      if (cap) cap.textContent = s.caption;
      mktDetailEl.querySelectorAll(".mkt-thumb").forEach((x) => x.classList.toggle("active", x === t));
    });
  }

  const installEl = mktDetailEl.querySelector(".mkt-dt-install") as HTMLButtonElement | null;
  if (installEl && !d.installed) {
    installEl.addEventListener("click", async () => {
      installEl.disabled = true; installEl.textContent = "Installing…";
      const res = await window.yo.marketplaceInstall(d.id);
      if (res.ok) { installEl.textContent = "Installed"; }
      else { installEl.disabled = false; installEl.textContent = "Install"; flashMktNote(res.error || "Install failed"); }
    });
  }

  const similarWrap = mktDetailEl.querySelector("#mkt-similar");
  if (similarWrap) for (const a of d.similar) similarWrap.appendChild(mktCard(a, "grid"));

  // Real connection icons for the hero chips + similar cards, then re-render
  // (only if this detail is still on screen).
  const conns = [...d.connections, ...d.similar.flatMap((s) => s.connections)];
  void primeConnectedIcons(mktConnIconApps(conns), () => {
    if (!mktDetailEl.classList.contains("hidden")) renderMktDetail(d);
  });
}

/** The marketplace storefront is gated behind a coming-soon page for now. Flip
 *  to false to bring the live storefront + the app-editor Marketplace tab back. */
const MARKETPLACE_COMING_SOON = true;

/** Switch between the "My apps" library and the Marketplace storefront. */
function switchAppsPage(page: "library" | "marketplace"): void {
  document.querySelectorAll<HTMLButtonElement>(".apps-page-tab").forEach((t) => t.classList.toggle("active", t.dataset.page === page));
  marketplaceLibraryPage.classList.toggle("hidden", page !== "library");
  marketplacePage.classList.toggle("hidden", page !== "marketplace");
  if (page !== "marketplace") return;
  const soon = document.getElementById("mkt-coming-soon");
  const store = document.getElementById("mkt-store");
  if (MARKETPLACE_COMING_SOON) {
    // Show the placeholder; keep the storefront + any open detail out of the way.
    store?.classList.add("hidden");
    closeMktDetail();
    soon?.classList.remove("hidden");
    return;
  }
  soon?.classList.add("hidden");
  store?.classList.remove("hidden");
  closeMktDetail();
  void loadMarketplace();
}

// ── Tab switching ────────────────────────────────────────

function switchAppTab(tab: string) {
  activeAppTab = tab as typeof activeAppTab;
  document.querySelectorAll<HTMLButtonElement>(".app-detail-tab").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  document.querySelectorAll<HTMLElement>(".app-tab-left").forEach(el => {
    el.classList.toggle("active", el.dataset.tab === tab);
  });
  document.querySelectorAll<HTMLElement>(".app-tab-right").forEach(el => {
    el.classList.toggle("active", el.dataset.tab === tab);
  });
  if (tab === "dashboard") void loadPanelTab();
  if (tab === "config") void loadConfigVarsTab();
  if (tab === "releases") void loadReleasesTab();
  if (tab === "connections") void loadAppConnectionsTab();
  if (tab === "marketplace") loadMarketplaceTab();
  // Deploy + "own your code" share the Public hosting tab: both answer "who runs
  // this for the public", which is a different question from how it is distributed
  // inside Glyphh (Releases + Marketplace).
  if (tab === "hosting") { void loadDeployTab(); loadProductionTab(); }
}

// ── Marketplace tab — the listing an installer sees ──────────────
//
// The agent can write every field here (set_app_listing / upload_app_image over
// MCP). What it deliberately cannot do is press List: publishing to other orgs is
// the irreversible half, so it stays a human click on this tab.

function listingEls() {
  return {
    title: document.getElementById("listing-title") as HTMLInputElement,
    tagline: document.getElementById("listing-tagline") as HTMLInputElement,
    category: document.getElementById("listing-category") as HTMLSelectElement,
    body: document.getElementById("listing-body") as HTMLTextAreaElement,
    video: document.getElementById("listing-video") as HTMLInputElement,
    website: document.getElementById("listing-website") as HTMLInputElement,
    support: document.getElementById("listing-support") as HTMLInputElement,
  };
}

function loadMarketplaceTab(): void {
  document.getElementById("listing-error")!.classList.add("hidden");
  const l = currentApp?.listing;
  const el = listingEls();
  el.title.value = l?.title || currentApp?.name || "";
  el.tagline.value = l?.tagline || "";
  el.category.value = l?.category || "";
  el.body.value = l?.body || "";
  el.video.value = l?.videoUrl || "";
  el.website.value = l?.website || "";
  el.support.value = l?.supportEmail || "";

  // Icon + screenshots.
  const icon = document.getElementById("listing-icon-preview")!;
  const clear = document.getElementById("listing-icon-clear")!;
  if (l?.iconUrl) {
    icon.innerHTML = `<img src="${escMkt(l.iconUrl)}" alt="" />`;
    clear.classList.remove("hidden");
  } else {
    icon.textContent = "No icon";
    clear.classList.add("hidden");
  }

  const shots = document.getElementById("listing-shots")!;
  const shotsEmpty = document.getElementById("listing-shots-empty")!;
  const list = l?.screenshots ?? [];
  shotsEmpty.classList.toggle("hidden", list.length > 0);
  shots.innerHTML = "";
  for (const shot of list) {
    const key = mediaKeyFromUrl(shot.url);
    const cell = document.createElement("div");
    cell.className = "listing-shot";
    cell.innerHTML = `<img src="${escMkt(shot.url)}" alt="${escMkt(shot.caption)}" />
      <button class="listing-shot-remove" type="button" data-key="${escMkt(key)}" aria-label="Remove screenshot">×</button>`;
    cell.querySelector<HTMLButtonElement>(".listing-shot-remove")!
      .addEventListener("click", () => void removeListingImage(key));
    shots.appendChild(cell);
  }

  // Listed state + which button to offer.
  const state = document.getElementById("listing-listed-state")!;
  const listBtn = document.getElementById("listing-list-btn")!;
  const unlistBtn = document.getElementById("listing-unlist-btn")!;
  const listed = !!l?.listedAt;
  state.innerHTML = listed
    ? `<span class="deploy-dot on"></span>Listed${l?.ratingCount ? ` · ${l.ratingAvg.toFixed(1)}★ from ${l.ratingCount} review${l.ratingCount === 1 ? "" : "s"}` : " · no reviews yet"}`
    : `<span class="deploy-dot"></span>Not listed`;
  listBtn.classList.toggle("hidden", listed);
  unlistBtn.classList.toggle("hidden", !listed);
}

/** The stored key back out of a served media URL — the remove call takes the key,
 *  and the listing hands us URLs so a client never builds one itself. */
function mediaKeyFromUrl(url: string): string {
  try { return decodeURIComponent(new URL(url).pathname.split("/media/")[1] ?? ""); }
  catch { return ""; }
}

function listingError(msg: string): void {
  const el = document.getElementById("listing-error")!;
  el.textContent = msg;
  el.classList.remove("hidden");
}

function listingStatus(msg: string): void {
  const el = document.getElementById("listing-status");
  if (!el) return;
  el.textContent = msg;
  if (msg.endsWith("✓")) setTimeout(() => { if (el.textContent === msg) el.textContent = ""; }, 2500);
}

/** Re-read the app so the tab renders what the server actually stored. */
async function refreshCurrentApp(): Promise<void> {
  const apps = await window.yo.panelAppsList();
  reloadPanelApps(apps.map(toPanelApp));
  const fresh = panelApps.find((a) => a.id === currentAppId);
  if (fresh) currentApp = fresh;
}

async function saveListing(): Promise<void> {
  if (!currentApp) return;
  document.getElementById("listing-error")!.classList.add("hidden");
  const el = listingEls();
  const patch: Record<string, unknown> = {
    title: el.title.value.trim() || undefined,
    tagline: el.tagline.value.trim() || undefined,
    category: el.category.value || undefined,
    body: el.body.value.trim() || undefined,
    website: el.website.value.trim() || undefined,
    supportEmail: el.support.value.trim() || undefined,
    // Empty means CLEAR, which is null on the wire — undefined would leave it.
    videoUrl: el.video.value.trim() || null,
  };
  listingStatus("Saving…");
  const res = await window.yo.appListingSet(currentApp.slug, patch);
  if (!res.ok) { listingStatus(""); listingError(res.error || "Couldn't save the listing."); return; }
  listingStatus("Saved ✓");
  await refreshCurrentApp();
  loadMarketplaceTab();
}

async function addListingImage(kind: "icon" | "screenshot"): Promise<void> {
  if (!currentApp) return;
  document.getElementById("listing-error")!.classList.add("hidden");
  listingStatus("Uploading…");
  const res = await window.yo.appListingImageAdd(currentApp.slug, kind);
  if (!res.ok) {
    listingStatus("");
    if (res.error !== "Canceled") listingError(res.error || "Couldn't upload the image.");
    return;
  }
  listingStatus("Uploaded ✓");
  await refreshCurrentApp();
  loadMarketplaceTab();
}

async function removeListingImage(key: string): Promise<void> {
  if (!currentApp || !key) return;
  const res = await window.yo.appListingImageRemove(currentApp.slug, key);
  if (!res.ok) { listingError(res.error || "Couldn't remove the image."); return; }
  await refreshCurrentApp();
  loadMarketplaceTab();
}

async function setListed(listed: boolean): Promise<void> {
  if (!currentApp) return;
  document.getElementById("listing-error")!.classList.add("hidden");
  if (listed) {
    const confirmed = await confirmAction({
      title: `List ${currentApp.name} on the marketplace?`,
      body: "Other organizations will be able to find and install it, and installers can review it. You can unlist at any time — existing installs keep working.",
      confirmLabel: "List it",
    });
    if (!confirmed) return;
  }
  listingStatus(listed ? "Listing…" : "Unlisting…");
  const res = await window.yo.appListingList(currentApp.slug, listed);
  if (!res.ok) { listingStatus(""); listingError(res.error || "Couldn't change the listing."); return; }
  listingStatus(listed ? "Listed ✓" : "Unlisted ✓");
  await refreshCurrentApp();
  loadMarketplaceTab();
}

function initMarketplaceTab(): void {
  document.getElementById("listing-save")?.addEventListener("click", () => { void saveListing(); });
  document.getElementById("listing-icon-pick")?.addEventListener("click", () => { void addListingImage("icon"); });
  document.getElementById("listing-shot-add")?.addEventListener("click", () => { void addListingImage("screenshot"); });
  document.getElementById("listing-icon-clear")?.addEventListener("click", () => {
    const url = currentApp?.listing?.iconUrl;
    if (url) void removeListingImage(mediaKeyFromUrl(url));
  });
  document.getElementById("listing-list-btn")?.addEventListener("click", () => { void setListed(true); });
  document.getElementById("listing-unlist-btn")?.addEventListener("click", () => { void setListed(false); });
}

// ── Releases tab — the app's version history ─────────────────────
//
// A build is immutable, so the only things editable here are its NOTES and its
// channel. The left pane edits the selected release; the right pane is the history.

type ReleaseRow = Awaited<ReturnType<typeof window.yo.appReleases>>["releases"][number];

let releases: ReleaseRow[] = [];
let selectedReleaseId: string | null = null;

/** Human date for a release row — the thing an installer scans the list for. */
function releaseDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

async function loadReleasesTab(): Promise<void> {
  const listEl = document.getElementById("release-list")!;
  const emptyEl = document.getElementById("release-empty")!;
  const countEl = document.getElementById("release-count")!;
  document.getElementById("release-error")!.classList.add("hidden");
  listEl.innerHTML = `<div class="inline-empty">Loading…</div>`;

  // Owner sees the notes editor + promotion; an installer sees a read-only
  // version + update view. The history (right pane) is shown to both.
  const owned = currentApp?.owned !== false;
  document.getElementById("release-owner-view")?.classList.toggle("hidden", !owned);
  document.getElementById("release-installed-view")?.classList.toggle("hidden", owned);
  if (!owned) renderInstalledReleaseView();

  const slug = currentApp?.slug || currentAppId;
  const res = await window.yo.appReleases(slug);
  if (!res.ok) {
    listEl.innerHTML = "";
    releaseError(res.error || "Couldn't load the release history.");
    return;
  }
  releases = res.releases;

  // An INSTALLED app has no server-side history — its releases belong to whoever
  // published it. What it does carry is the release its bundle was cut from, so
  // the tab shows that rather than an empty list and a lie about having none.
  const imported = (currentApp?.launchConfig as { release?: { version?: string; notes?: string | null; channel?: string; releasedAt?: string | null } } | null)?.release;
  if (!releases.length && imported?.version) {
    releases = [{
      id: `imported:${imported.version}`,
      version: imported.version,
      status: "ready",
      error: null,
      notes: imported.notes ?? null,
      channel: imported.channel === "live" ? "live" : "dev",
      promotedAt: imported.releasedAt ?? null,
      createdAt: imported.releasedAt ?? new Date().toISOString(),
      updatedAt: imported.releasedAt ?? new Date().toISOString(),
    }];
  }
  const readOnly = releases.some((r) => r.id.startsWith("imported:"));

  countEl.textContent = releases.length
    ? `${releases.length} release${releases.length === 1 ? "" : "s"}${readOnly ? " · from the bundle" : ""}`
    : "";
  emptyEl.classList.toggle("hidden", releases.length > 0);
  listEl.innerHTML = "";

  for (const r of releases) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `release-row${r.id === selectedReleaseId ? " selected" : ""}`;
    row.dataset.id = r.id;
    // A failed build is the row an author most needs to find, so it carries its
    // compiler error inline rather than hiding it behind a click.
    const badge = r.channel === "live"
      ? `<span class="release-badge live">live</span>`
      : `<span class="release-badge">dev</span>`;
    const state = r.status === "ready" ? "" : `<span class="release-state ${r.status}">${escMkt(r.status)}</span>`;
    row.innerHTML = `
      <div class="release-row-head">
        <span class="release-version">${escMkt(r.version)}</span>
        ${badge}${state}
        <span class="release-date">${escMkt(releaseDate(r.promotedAt || r.createdAt))}</span>
      </div>
      ${r.notes ? `<div class="release-notes-preview">${escMkt(r.notes.split("\n").slice(0, 3).join(" · ").slice(0, 160))}</div>` : ""}
      ${r.status === "failed" && r.error ? `<div class="release-build-error">${escMkt(r.error.slice(0, 300))}</div>` : ""}`;
    row.addEventListener("click", () => selectRelease(r.id));
    listEl.appendChild(row);
  }

  // Default to the newest release, so the pane is never empty on open.
  if (!releases.some((r) => r.id === selectedReleaseId)) selectedReleaseId = releases[0]?.id ?? null;
  selectRelease(selectedReleaseId);
}

function selectRelease(id: string | null): void {
  selectedReleaseId = id;
  const r = releases.find((x) => x.id === id) ?? null;
  document.querySelectorAll<HTMLElement>(".release-row").forEach((el) => {
    el.classList.toggle("selected", el.dataset.id === id);
  });
  const notes = document.getElementById("release-notes") as HTMLTextAreaElement;
  const promote = document.getElementById("release-promote") as HTMLButtonElement;
  const save = document.getElementById("release-save-notes") as HTMLButtonElement;
  const head = document.getElementById("release-selected")!;

  if (!r) {
    head.textContent = "Select a release from the history →";
    notes.value = "";
    notes.disabled = true;
    promote.disabled = true;
    save.disabled = true;
    return;
  }
  head.innerHTML = `<strong>${escMkt(r.version)}</strong> · ${escMkt(r.channel)} · ${escMkt(releaseDate(r.createdAt))}`;
  notes.value = r.notes || "";
  // A release you INSTALLED is the publisher's record, not yours: readable, not editable.
  const imported = r.id.startsWith("imported:");
  notes.disabled = imported;
  save.disabled = imported;
  if (imported) {
    promote.disabled = true;
    promote.textContent = "Published by its author";
    return;
  }
  // Only a BUILT release can go live: promoting a failed one would publish a
  // version that cannot run, and the server refuses it anyway.
  promote.disabled = r.status !== "ready" || r.channel === "live";
  promote.textContent = r.channel === "live" ? "Already live" : "Promote to live";
}

function releaseError(msg: string): void {
  const el = document.getElementById("release-error")!;
  el.textContent = msg;
  el.classList.remove("hidden");
}

function releaseStatus(msg: string): void {
  const el = document.getElementById("release-status");
  if (!el) return;
  el.textContent = msg;
  if (msg.endsWith("✓")) setTimeout(() => { if (el.textContent === msg) el.textContent = ""; }, 2500);
}

// ── Installed-app release view: version + update availability ────
//
// An installer doesn't edit notes or promote — they see which version they have
// and whether a newer one is published. The auto-update toggle is per-app.

/** The version the local bundle was cut from (its manifest's release). */
function installedVersion(app: PanelApp | null): string | null {
  const r = (app?.launchConfig as { release?: { version?: string } } | null)?.release;
  return r?.version ?? null;
}

/** naive semver-ish compare — "1.2.0" vs "1.10.0". Non-numeric segments sort last. */
function versionNewer(candidate: string, have: string): boolean {
  const seg = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10));
  const a = seg(candidate), b = seg(have);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return candidate > have;
    if (x !== y) return x > y;
  }
  return false;
}

function autoUpdateKey(slug: string): string { return `appAutoUpdate:${slug}`; }

function renderInstalledReleaseView(): void {
  const app = currentApp;
  const have = installedVersion(app);
  const latest = app?.latestVersion ?? null;
  document.getElementById("release-installed-version")!.textContent = have ? `v${have}` : "—";

  const banner = document.getElementById("release-update-banner")!;
  const text = document.getElementById("release-update-text")!;
  const updatable = !!(latest && have && versionNewer(latest, have));
  banner.classList.toggle("hidden", !updatable);
  if (updatable) text.textContent = `Version ${latest} is available — you have ${have}.`;

  // Toggle reflects the stored preference (default on).
  const toggle = document.getElementById("release-autoupdate") as HTMLInputElement;
  void window.yo.getPreference?.(autoUpdateKey(app?.slug || ""), true).then((v) => { toggle.checked = v !== false; });
}

// ── Connections tab: the app's required connections + their tools ────

/** The connection slugs the app requires (from the server's requiredConnections). */
function requiredConnSlugs(app: PanelApp | null): { slug: string; connected: boolean }[] {
  return (app?.requiredConnections || []).map((c) => ({ slug: c.slug, connected: c.connected }));
}

async function loadAppConnectionsTab(): Promise<void> {
  const listEl = document.getElementById("app-conns-list")!;
  const emptyEl = document.getElementById("app-conns-empty")!;
  const required = requiredConnSlugs(currentApp);
  emptyEl.classList.toggle("hidden", required.length > 0);
  listEl.innerHTML = "";
  if (!required.length) return;

  // Map required slugs → the user's actual connection (for the id → tools lookup).
  let byslug = new Map<string, { id: string; hiddenTools: string[] }>();
  try {
    const res = await window.yo.connectionsList();
    byslug = new Map((res.connections || []).map((c) => [c.appSlug, { id: c.id, hiddenTools: c.hiddenTools }]));
  } catch { /* offline — everything renders as not connected */ }

  for (const { slug, connected } of required) {
    const conn = byslug.get(slug);
    const row = document.createElement("div");
    row.className = "app-conn-row";
    row.innerHTML = `
      <button class="app-conn-head" type="button">
        <span class="app-conn-chev">▸</span>
        ${mktConnChip({ name: connLabel(slug), slug })}
        <span class="app-conn-name">${escMkt(connLabel(slug))}</span>
        <span class="app-conn-status ${connected ? "ok" : "missing"}">${connected ? "Connected" : "Not connected"}</span>
      </button>
      <div class="app-conn-tools hidden"></div>`;
    const head = row.querySelector<HTMLButtonElement>(".app-conn-head")!;
    const tools = row.querySelector<HTMLDivElement>(".app-conn-tools")!;
    const chev = row.querySelector<HTMLElement>(".app-conn-chev")!;
    head.addEventListener("click", async () => {
      const open = tools.classList.toggle("hidden");
      chev.textContent = open ? "▸" : "▾";
      if (open || tools.dataset.loaded) return;
      tools.dataset.loaded = "1";
      if (!conn) { tools.innerHTML = `<div class="app-conn-tool-empty">Connect ${escMkt(connLabel(slug))} to see its tools.</div>`; return; }
      tools.innerHTML = `<div class="app-conn-tool-empty">Loading tools…</div>`;
      const tres = await window.yo.connectionToolsList(conn.id).catch(() => ({ ok: false as const, tools: [] }));
      if (!tres.ok || !tres.tools.length) { tools.innerHTML = `<div class="app-conn-tool-empty">No tools.</div>`; return; }
      // A tool the user/org has hidden is BLOCKED — the app can't call it, so the
      // dependency is unmet even though the account is connected.
      tools.innerHTML = tres.tools.map((t) => `
        <div class="app-conn-tool">
          <span class="app-conn-tool-name">${escMkt(t.name)}</span>
          <span class="app-conn-tool-state ${t.hidden ? "blocked" : "allowed"}">${t.hidden ? "Blocked" : "Allowed"}</span>
        </div>`).join("");
    });
    listEl.appendChild(row);
    // Any required connection that's connected but has all tools blocked is a
    // silent failure — surface it on the row without needing expansion.
    if (conn) void window.yo.connectionToolsList(conn.id).then((tres) => {
      if (tres.ok && tres.tools.length && tres.tools.every((t) => t.hidden)) {
        const st = row.querySelector<HTMLElement>(".app-conn-status")!;
        st.textContent = "Tools blocked";
        st.className = "app-conn-status missing";
      }
    }).catch(() => {});
  }
  primeConnectedIcons(mktConnIconApps(required.map(({ slug }) => ({ slug }))), () => {});
}

function initReleasesTab(): void {
  document.getElementById("release-refresh")?.addEventListener("click", () => { void loadReleasesTab(); });

  // Auto-update toggle (installed apps) — persisted per app slug.
  document.getElementById("release-autoupdate")?.addEventListener("change", (e) => {
    const on = (e.target as HTMLInputElement).checked;
    void window.yo.setPreference?.(autoUpdateKey(currentApp?.slug || ""), on);
  });
  // Manual "Update now" — the download mechanism is server-side (a bundle
  // endpoint); until it lands this reports honestly rather than silently no-op.
  document.getElementById("release-update-btn")?.addEventListener("click", async () => {
    const btn = document.getElementById("release-update-btn") as HTMLButtonElement;
    const prev = btn.textContent; btn.disabled = true; btn.textContent = "Updating…";
    const res = await window.yo.appUpdateInstalled?.(currentApp?.slug || "");
    btn.disabled = false; btn.textContent = res?.ok ? "Updated ✓" : prev;
    if (res?.ok) { await refreshCurrentApp(); loadReleasesTab(); }
    else if (res?.error) releaseError(res.error);
  });

  // Connections tab: jump to the Connections page to connect/allow.
  document.getElementById("app-conns-goto")?.addEventListener("click", () => { void gotoSection("connections"); });

  document.getElementById("release-save-notes")?.addEventListener("click", async () => {
    if (!selectedReleaseId) return;
    document.getElementById("release-error")!.classList.add("hidden");
    const notes = (document.getElementById("release-notes") as HTMLTextAreaElement).value;
    releaseStatus("Saving…");
    const res = await window.yo.appReleaseNotes(currentApp?.slug || currentAppId, selectedReleaseId, notes || null);
    if (!res.ok) { releaseStatus(""); releaseError(res.error || "Couldn't save the notes."); return; }
    releaseStatus("Saved ✓");
    await loadReleasesTab();
  });

  document.getElementById("release-promote")?.addEventListener("click", async () => {
    if (!selectedReleaseId) return;
    const r = releases.find((x) => x.id === selectedReleaseId);
    if (!r) return;
    document.getElementById("release-error")!.classList.add("hidden");
    const confirmed = await confirmAction({
      title: `Promote ${r.version} to live?`,
      body: "Everyone who installs this app gets this version. Promoting an older release again is how you roll back.",
      confirmLabel: "Promote",
    });
    if (!confirmed) return;
    releaseStatus("Promoting…");
    const res = await window.yo.appReleasePromote(currentApp?.slug || currentAppId, selectedReleaseId);
    if (!res.ok) { releaseStatus(""); releaseError(res.error || "Couldn't promote the release."); return; }
    releaseStatus("Live ✓");
    await loadReleasesTab();
  });
}

// ── Deploy tab (dev-host) — status + deploy + take-down ──────────
let deployCurrentId: string | null = null;

async function loadDeployTab(): Promise<void> {
  const statusEl = document.getElementById("deploy-status")!;
  const urlRow = document.getElementById("deploy-url-row")!;
  const urlEl = document.getElementById("deploy-url") as HTMLAnchorElement;
  const takedown = document.getElementById("deploy-takedown-btn")!;
  const deployBtn = document.getElementById("deploy-btn") as HTMLButtonElement;
  document.getElementById("deploy-error")!.classList.add("hidden");
  statusEl.textContent = "Checking…";
  urlRow.classList.add("hidden");
  takedown.classList.add("hidden");
  deployCurrentId = null;

  // Who can reach it — the app's own setting, not the deployment's. Shown here
  // because "it's live" and "who can open it" are one question to the owner.
  const accessSel = document.getElementById("deploy-access") as HTMLSelectElement;
  accessSel.value = currentApp?.access === "public" ? "public" : "members";
  syncDeployAccessHint();

  const slug = currentApp?.slug || currentAppId;
  const res = await window.yo.hostingStatus(slug);
  if (!res.ok) { statusEl.textContent = "Couldn't load deploy status."; return; }
  const d = res.deployment;
  if (d && (d.status === "live" || d.status === "building" || d.status === "queued")) {
    deployCurrentId = d.id;
    statusEl.innerHTML = `<span class="deploy-dot ${d.status === "live" ? "on" : "pending"}"></span>${d.status === "live" ? "Deployed" : d.status}`;
    if (d.url) { urlEl.textContent = d.url; urlEl.href = d.url; urlRow.classList.remove("hidden"); }
    takedown.classList.remove("hidden");
    deployBtn.textContent = "Redeploy";
  } else {
    statusEl.innerHTML = `<span class="deploy-dot"></span>Not deployed`;
    deployBtn.textContent = "Deploy";
  }
}

/** Spell out what the chosen access actually means — "public" is the one that
 *  can surprise someone, so it says so plainly. */
function syncDeployAccessHint(): void {
  const hint = document.getElementById("deploy-access-hint");
  const isPublic = (document.getElementById("deploy-access") as HTMLSelectElement).value === "public";
  if (hint) {
    hint.textContent = isPublic
      ? "Anyone with the link can open this app, signed in or not, and their requests spend your org's credits."
      : "Visitors sign in with a Glyphh account; anyone else is turned away at the edge, before the app is reached.";
  }
}

/** Persist the access choice against the app entry. */
async function saveDeployAccess(): Promise<void> {
  if (!currentAppId) return;
  const status = document.getElementById("deploy-access-status");
  const access = (document.getElementById("deploy-access") as HTMLSelectElement).value as "public" | "members";
  if (status) status.textContent = "Saving…";
  const res = await window.yo.panelAppsUpdate(currentAppId, { access });
  if (res?.ok && currentApp) currentApp.access = access;
  if (status) {
    status.textContent = res?.ok ? "Saved ✓" : (res?.error || "Save failed");
    setTimeout(() => { if (status.textContent === "Saved ✓") status.textContent = ""; }, 2500);
  }
}

async function loadProductionTab(): Promise<void> {
  document.getElementById("graduate-error")!.classList.add("hidden");
}

// ── Config Vars tab (per-app encrypted secrets) ──────────
//
// Values are write-only: typed once into the form, encrypted in the main
// process, and never returned to any renderer again — the list shows key
// names and set-dates only.

async function loadConfigVarsTab() {
  // Never let unsaved plaintext linger in the entry fields across a tab switch
  // or app reopen — a value only ever exists here while actively being typed.
  (document.getElementById("config-var-key") as HTMLInputElement).value = "";
  (document.getElementById("config-var-value") as HTMLTextAreaElement).value = "";
  (document.getElementById("config-var-readable") as HTMLInputElement).checked = false;
  const listEl = document.getElementById("config-var-list")!;
  const res = await window.yo.appSecretsList(currentAppId);
  listEl.innerHTML = "";
  if (!res.ok) {
    listEl.innerHTML = `<div class="inline-empty">Couldn't load config vars.</div>`;
    return;
  }
  const secrets = res.secrets || [];
  if (!secrets.length) {
    listEl.innerHTML = `<div class="inline-empty">No config vars yet. Keys like OPENAI_API_KEY let this app use services on your behalf — the value is encrypted and can never be viewed again.</div>`;
    return;
  }
  for (const s of secrets) {
    const row = document.createElement("div");
    row.className = "config-var-row";
    const keyEl = document.createElement("span");
    keyEl.className = "config-var-key";
    keyEl.textContent = s.key;
    {
      const badge = document.createElement("span");
      badge.className = "config-var-hostonly";
      if (s.appReadable) {
        badge.textContent = "app-readable";
        badge.title = "App code can read this value via secrets.get.";
        badge.style.cssText = "color:var(--ok,#22c55e);border-color:rgba(34,197,94,.4);";
      } else {
        badge.textContent = "runtime-only";
        badge.title = s.hostOnly
          ? "Credential — encrypted, never readable by app code (secrets.get refuses it). Only the trusted runtime uses it."
          : "Encrypted; not readable by app code. Turn on \"Readable by app code\" when saving to expose it.";
      }
      keyEl.appendChild(badge);
    }
    const valEl = document.createElement("span");
    valEl.className = "config-var-masked";
    valEl.textContent = "••••••••";
    valEl.title = "Encrypted — set " + (s.at ? new Date(s.at).toLocaleDateString() : "earlier") + "; values can't be viewed again";
    const edit = document.createElement("button");
    edit.className = "action-btn";
    edit.style.cssText = "height:24px;font-size:11px;padding:0 10px;";
    edit.textContent = "Edit";
    edit.title = "Load this var into the form to change its value or its \"readable by app code\" setting. Values are write-only, so editing clears the value — re-enter it to save.";
    edit.addEventListener("click", () => {
      (document.getElementById("config-var-key") as HTMLInputElement).value = s.key;
      (document.getElementById("config-var-readable") as HTMLInputElement).checked = !!s.appReadable;
      // Write-only: the stored value can never be shown again, so editing wipes
      // the field — the user re-enters the value (and can flip app-readable) to save.
      const valueField = document.getElementById("config-var-value") as HTMLTextAreaElement;
      valueField.value = "";
      document.getElementById("config-var-status")!.textContent = `Editing ${s.key} — re-enter its value to save (values are write-only and can't be shown).`;
      valueField.focus();
    });
    const del = document.createElement("button");
    del.className = "action-btn danger";
    del.style.cssText = "height:24px;font-size:11px;padding:0 10px;";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      if (!(await confirmAction({
        title: `Delete config var ${s.key}?`,
        body: "Apps that need it stop working until it's re-added.",
        confirmLabel: "Delete var",
        danger: true,
      }))) return;
      await window.yo.appSecretsDelete(currentAppId, s.key);
      void loadConfigVarsTab();
    });
    row.append(keyEl, valEl, edit, del);
    listEl.appendChild(row);
  }
}

function wireConfigVarsForm() {
  const keyEl = document.getElementById("config-var-key") as HTMLInputElement;
  const valueEl = document.getElementById("config-var-value") as HTMLTextAreaElement;
  const readableEl = document.getElementById("config-var-readable") as HTMLInputElement;
  const errEl = document.getElementById("config-var-error")!;
  const statusEl = document.getElementById("config-var-status")!;
  document.getElementById("config-var-add")!.addEventListener("click", async () => {
    errEl.classList.add("hidden");
    statusEl.textContent = "";
    const key = keyEl.value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    const value = valueEl.value;
    const res = await window.yo.appSecretsSet(currentAppId, key, value, readableEl.checked);
    if (!res.ok) {
      errEl.textContent = res.error || "Couldn't save";
      errEl.classList.remove("hidden");
      return;
    }
    // The one and only moment the plaintext existed in the UI — clear it.
    keyEl.value = "";
    valueEl.value = "";
    statusEl.textContent = `${key} saved — value encrypted; it can't be viewed again.`;
    setTimeout(() => { if (statusEl.textContent?.startsWith(key)) statusEl.textContent = ""; }, 6000);
    void loadConfigVarsTab();
  });
}


// ── Panel tab ────────────────────────────────────────────

let panelLoaded = false;

async function loadPanelTab() {
  const app = panelApps.find((a) => a.id === currentAppId);
  if (!app) return;

  // Installed glyphh-apps have no url — their UI lives on disk at execPath
  // (~/.glyphh/custom-apps/<slug>/index.html). Mirror isGlyphhAppRow so native
  // terminal/editor apps (also execPath, no url) still fall through to "no url".
  const isGlyphhApp = app.appArchetype === "glyphh-app" || /\.html?$/i.test(app.execPath || "");

  if (!app.url && !isGlyphhApp) {
    document.getElementById("app-commands-list")!.innerHTML = `<div class="inline-empty">No URL configured for this app. Add one above to enable panel features.</div>`;
    return;
  }

  if (!panelLoaded) {
    if (isGlyphhApp) {
      // Grant the preview <webview> the app's caps (so window.glyphh.call is
      // authorized — the preload is attached in main) and load its on-disk entry
      // so relative ../_libs/* references resolve. Mirrors openGlyphhApp.
      const wcId = await ensurePreviewWcId();
      const res = await window.yo.glyphhAppPreviewOpen(app.slug, wcId);
      if (!res?.ok || !res.fileUrl) {
        document.getElementById("app-commands-list")!.innerHTML = `<div class="inline-empty">${res?.error || "Could not load app preview."}</div>`;
        return;
      }
      appPreview.src = res.fileUrl;
    } else {
      // Web app: drop any glyphh grant left on the reused preview webContents.
      void window.yo.glyphhAppPreviewClear(getPreviewWebContentsId());
      appPreview.partition = "persist:yo";
      appPreview.src = app.url!;
    }
    panelLoaded = true;
  }
}

/** The preview <webview> creates its guest (and thus a webContents id) shortly
 *  after it attaches to the DOM; wait briefly so the caps grant has a target. */
async function ensurePreviewWcId(): Promise<number | undefined> {
  let id = getPreviewWebContentsId();
  for (let i = 0; id === undefined && i < 30; i++) {
    await new Promise((r) => setTimeout(r, 50));
    id = getPreviewWebContentsId();
  }
  return id;
}


async function openPanelAppDetail(app: PanelApp) {
  currentAppId = app.id;
  currentApp = app;
  panelLoaded = false;

  // Built-app tabs. Releases + Connections show for the builder AND anyone who
  // installed it; Marketplace + Public hosting are the builder's alone.
  const isBuilt = app.appArchetype === "glyphh-app";
  const owned = app.owned !== false;   // undefined (self/legacy) reads as owned
  document.querySelectorAll<HTMLElement>(".tab-built-only").forEach((el) => el.classList.toggle("hidden", !isBuilt));
  document.querySelectorAll<HTMLElement>(".tab-owner-only").forEach((el) => {
    // The Marketplace tab stays hidden while the storefront is coming-soon —
    // there is nothing to list an app into yet. Flip MARKETPLACE_COMING_SOON to
    // bring it back with the rest of the owner-only tabs.
    const marketplaceGated = MARKETPLACE_COMING_SOON && el.getAttribute("data-tab") === "marketplace";
    el.classList.toggle("hidden", marketplaceGated || !(isBuilt && owned));
  });
  // A built app's type is its bundle's, not a dropdown choice — the server refuses
  // to retype it, so offering the control would only produce a failed save.
  document.getElementById("app-detail-type-row")?.classList.toggle("hidden", isBuilt);

  // Populate dashboard fields
  appDetailId.value = app.slug;
  appDetailName.value = app.name;
  appDetailUrl.value = app.url || "";

  // Browser ↔ Native fields. Legacy apps have isBrowser undefined but always
  // carry a url, so they default to browser.
  const isBrowser = app.isBrowser !== undefined ? app.isBrowser : true;
  const detailType: AppType = isBrowser ? "browser" : "native";
  (document.getElementById("app-detail-type") as HTMLSelectElement).value = detailType;
  {
    const lc = (app.launchConfig || {}) as Record<string, unknown>;
  }
  (document.getElementById("app-detail-exec-path") as HTMLInputElement).value = app.execPath || "";
  const detailArchetype = (app.appArchetype as Archetype) || "generic";
  (document.getElementById("app-detail-archetype") as HTMLSelectElement).value = detailArchetype;
  writeLaunchConfig("app-detail", detailArchetype, app.launchConfig);
  toggleTypeFields("app-detail", detailType);
  toggleArchetypeFields("app-detail", detailArchetype);

  // MCP + Guardrails tabs — installed apps that declare tools.
  syncMcpTabs(app);

  // Shared edit header: icon + name + slug (the header title span is now blank).
  appDetailHeading.textContent = "";
  document.getElementById("app-detail-head")!.innerHTML =
    `<div class="app-card-icon">${appIconInner(app, app.name, "app-card-initial")}</div>` +
    `<div class="edit-head-name">${escMkt(app.name)}<span class="edit-head-slug">${escMkt(app.slug)}</span></div>`;

  // The Glyphh system app can't be deleted (server enforces it) — don't offer.
  document.getElementById("app-detail-delete")?.classList.toggle("hidden", app.slug === "glyphh");

  // Required connections (installed Glyphh apps) — status + missing warning.
  void renderRequiredConnections(app);

  // All tabs always visible
  document.querySelectorAll<HTMLButtonElement>(".app-detail-tab").forEach(btn => {
    btn.classList.remove("tab-hidden");
  });

  // Show detail, hide grid
  appsList.classList.add("hidden");
  appsToolbar.classList.add("hidden");
  appAddForm.classList.add("hidden");
  appDetail.classList.remove("hidden");

  switchAppTab("dashboard");
}

function getPreviewWebContentsId(): number | undefined {
  try { return appPreview.getWebContentsId(); } catch { return undefined; }
}

function closeAppDetail() {
  // Drop any glyphh capability grant on the reused preview webContents.
  void window.yo.glyphhAppPreviewClear(getPreviewWebContentsId());
  appPreview.src = "about:blank";
  panelLoaded = false;
  appDetail.classList.add("hidden");
  appsList.classList.remove("hidden");
  appsToolbar.classList.remove("hidden");
  loadApps();
}

/** The apps the panel/launcher paths can open — a system row (Glyphh itself)
 *  and a row with nothing to open are both excluded. */
function reloadPanelApps(apps: Array<PanelApp>) {
  panelApps = apps.filter((a) => !a.system && (a.url || a.isBrowser === false));
}

let pendingOriginTab: string | null = null;

/**
 * Open the New App form, prefilled. Used by the browser-tab "Create App"
 * deep-link. Clicks the + New button to open the form, then fills the fields.
 */
export function openNewAppForm(url = "", name = "", tabId: string | null = null): void {
  pendingOriginTab = tabId;
  document.getElementById("apps-add-btn")?.click(); // opens + clears the form
  const nameInput = document.getElementById("app-add-name") as HTMLInputElement | null;
  const slugInput = document.getElementById("app-add-slug") as HTMLInputElement | null;
  const urlInput = document.getElementById("app-add-url") as HTMLInputElement | null;
  if (!nameInput || !urlInput) return;
  let host = "";
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* noop */ }
  const finalName = name || host || "";
  nameInput.value = finalName;
  if (slugInput) slugInput.value = finalName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  urlInput.value = url;
  nameInput.focus();
}

// ── MCP tab wiring — approvals + guardrails for an installed app ───────────

function initMcpTab(): void {
  document.getElementById("app-mcp-save")?.addEventListener("click", () => { void saveMcpGuardrails("app-mcp-status"); });
  document.getElementById("app-gr-save")?.addEventListener("click", () => { void saveMcpGuardrails("app-gr-status"); });
  document.getElementById("app-mcp-test-btn")?.addEventListener("click", () => { void testMcpTool(); });
  document.getElementById("app-mcp-select-all")?.addEventListener("change", (e) => {
    const on = (e.target as HTMLInputElement).checked;
    document.querySelectorAll<HTMLInputElement>(".mcp-tool-check").forEach((c) => { c.checked = on; });
    updateMcpSelectAll();
  });
  document.getElementById("app-mcp-tools")?.addEventListener("change", (e) => {
    if ((e.target as HTMLElement).classList?.contains("mcp-tool-check")) updateMcpSelectAll();
  });
}

function initApps() {
  initMcpTab();
  initReleasesTab();
  initMarketplaceTab();

  // Upgrade gates (App connections / MCP) open the platform to manage the plan,
  // the same way Settings → Account → Manage Account does.
  document.querySelectorAll<HTMLElement>(".tab-upgrade-btn").forEach((btn) => {
    btn.addEventListener("click", () => { void window.yo.execCommand(`dip ${window.yo.platformUrl}`); });
  });

  // Manual refresh + live refresh when the app library changes server-side
  // (e.g. an app installed over the MCP relay while this page is open).
  document.getElementById("apps-refresh-btn")?.addEventListener("click", () => { void loadApps(); });
  window.yo.onPanelAppsChanged?.(() => {
    // Don't stomp an open editor — the list re-fetches next time it shows.
    if (appDetail.classList.contains("hidden")) void loadApps();
  });

  // "Open Connections" from the required-connections warning.
  document.getElementById("app-req-conns-goto")?.addEventListener("click", (e) => {
    e.preventDefault();
    gotoSection("connections");
  });

  const addNameInput = document.getElementById("app-add-name") as HTMLInputElement;
  const addSlugInput = document.getElementById("app-add-slug") as HTMLInputElement;
  const addUrlInput = document.getElementById("app-add-url") as HTMLInputElement;
  // URL → live preview sync in the detail form. Editing the URL field
  // navigates the embedded panel preview to the new address so the user
  // sees their change without having to Save + reopen. Debounced to ride
  // out fast typing; only fires for well-formed URLs.
  let urlSyncTimer: ReturnType<typeof setTimeout> | null = null;
  appDetailUrl?.addEventListener("input", () => {
    if (urlSyncTimer) clearTimeout(urlSyncTimer);
    urlSyncTimer = setTimeout(() => {
      const u = appDetailUrl.value.trim();
      if (!u) return;
      let normalized = u;
      try { normalized = new URL(u).toString(); } catch { return; /* not yet a full URL */ }
      if (appPreview && appPreview.src !== normalized) {
        appPreview.partition = "persist:yo";
        appPreview.src = normalized;
        panelLoaded = true;
      }
    }, 400);
  });

  // Slug helpers
  const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  let slugTouched = false;
  addSlugInput?.addEventListener("input", () => { slugTouched = addSlugInput.value.trim().length > 0; });
  addNameInput?.addEventListener("input", () => {
    if (!slugTouched) addSlugInput.value = slugify(addNameInput.value);
  });

  // + New — opens the simple App add form (name → auto-slug → URL).
  // The old "Add App | Add MCP Server" dropdown is gone; the form
  // already lets the user wire MCP in the detail view after creating.
  const addTypeSelect = document.getElementById("app-add-type") as HTMLSelectElement;
  const addArchetypeSelect = document.getElementById("app-add-archetype") as HTMLSelectElement;
  const addExecPath = document.getElementById("app-add-exec-path") as HTMLInputElement;

  // Apps page tabs: My apps ↔ Marketplace ↔ Public URLs.
  for (const t of Array.from(document.querySelectorAll<HTMLButtonElement>(".apps-page-tab"))) {
    t.addEventListener("click", () => {
      const page = t.dataset.page;
      switchAppsPage(page === "marketplace" ? "marketplace" : "library");
    });
  }
  // Marketplace scope (Public / Your organization).
  for (const t of Array.from(document.querySelectorAll<HTMLButtonElement>(".mkt-scope"))) {
    t.addEventListener("click", () => {
      const scope = t.dataset.scope === "private" ? "private" : "public";
      if (scope === mktScope) return;
      mktScope = scope; mktCategory = ""; mktPage = 1;
      document.querySelectorAll<HTMLButtonElement>(".mkt-scope").forEach((x) => x.classList.toggle("active", x === t));
      void loadMarketplace();
    });
  }
  // Marketplace search (debounced) + sort.
  mktSearchInput?.addEventListener("input", () => {
    if (mktSearchTimer) clearTimeout(mktSearchTimer);
    mktSearchTimer = setTimeout(() => { mktQuery = mktSearchInput.value.trim(); mktPage = 1; void loadMarketplace(); }, 200);
  });
  mktSortSelect?.addEventListener("change", () => {
    mktSort = (mktSortSelect.value as "popular" | "rating" | "newest") || "popular";
    mktPage = 1; void loadMarketplace();
  });
  // Refresh — reload the current storefront view.
  const mktRefreshBtn = document.getElementById("mkt-refresh");
  mktRefreshBtn?.addEventListener("click", async () => {
    mktRefreshBtn.classList.add("spinning");
    closeMktDetail();
    await loadMarketplace();
    mktRefreshBtn.classList.remove("spinning");
  });

  document.getElementById("apps-add-btn")!.addEventListener("click", () => {
    addNameInput.value = "";
    addSlugInput.value = "";
    slugTouched = false;
    addUrlInput.value = "";
    // Reset Browser ↔ Native fields to defaults (browser / webview / terminal).
    addTypeSelect.value = "browser";
    addExecPath.value = "";
    addArchetypeSelect.value = "generic";
    writeLaunchConfig("app-add", "generic", null);
    toggleTypeFields("app-add", "browser");
    toggleArchetypeFields("app-add", "generic");
    appFormError.classList.add("hidden");
    appsList.classList.add("hidden");
    appsToolbar.classList.add("hidden");
    appAddForm.classList.remove("hidden");
    addNameInput.focus();
  });

  // Add-form Browser / Native / LLM + archetype toggles + Browse… button.
  addTypeSelect.addEventListener("change", () => toggleTypeFields("app-add", addTypeSelect.value as AppType));
  addArchetypeSelect.addEventListener("change", () => toggleArchetypeFields("app-add", addArchetypeSelect.value as Archetype));
  document.getElementById("app-add-exec-browse")!.addEventListener("click", async () => {
    const picked = await window.yo.pickExecutable();
    if (picked) addExecPath.value = picked;
  });

  // App add form save
  document.getElementById("app-add-save")!.addEventListener("click", async () => {
    let valid = true;
    const name = addNameInput.value.trim();
    const url = addUrlInput.value.trim();
    const slugInput = addSlugInput.value.trim();
    const addType = addTypeSelect.value as AppType;
    const isBrowser = addType === "browser";
    const execPath = addExecPath.value.trim();
    if (!name) { addNameInput.classList.add("invalid"); clearInvalid(addNameInput); valid = false; }
    if (addType === "browser" && !url) { addUrlInput.classList.add("invalid"); clearInvalid(addUrlInput); valid = false; }
    if (addType === "native" && !execPath) { addExecPath.classList.add("invalid"); clearInvalid(addExecPath); valid = false; }
    if (!valid) {
      appFormError.textContent = addType === "browser"
        ? "Name and URL are required."
        : "Name and executable path are required.";
      appFormError.classList.remove("hidden");
      return;
    }
    const id = slugInput ? slugify(slugInput) : slugify(name);
    if (!id) {
      addSlugInput.classList.add("invalid"); clearInvalid(addSlugInput);
      appFormError.textContent = "Slug must contain at least one letter or number.";
      appFormError.classList.remove("hidden");
      return;
    }
    const RESERVED = new Set(["yo", "sup", "dip", "drip", "peace", "council", "vibe"]);
    if (RESERVED.has(id)) {
      addSlugInput.classList.add("invalid"); clearInvalid(addSlugInput);
      appFormError.textContent = `"${id}" is a reserved command. Pick a different slug.`;
      appFormError.classList.remove("hidden");
      return;
    }
    // Uniqueness check — apps and vibes share one namespace.
    const existing = await window.yo.panelAppsList();
    if (existing.some((a) => a.slug === id)) {
      addSlugInput.classList.add("invalid"); clearInvalid(addSlugInput);
      appFormError.textContent = `Slug "${id}" is already taken. Pick a different one.`;
      appFormError.classList.remove("hidden");
      return;
    }
    const archetype = addArchetypeSelect.value as Archetype;
    const createInput = addType === "browser"
      // A web app opens as a Glyphh panel — there is no browser or window
      // placement to configure, so it carries no launcher config at all.
      ? { name, slug: id, isBrowser: true, url, execPath: null, launchConfig: {} }
      : { name, slug: id, isBrowser: false, url: null, execPath, appArchetype: archetype, launchConfig: readLaunchConfig("app-add", archetype) };
    const created = await window.yo.panelAppsCreate(createInput);
    if (!created.ok || !created.app) {
      appFormError.textContent = created.error || "Failed to create app.";
      appFormError.classList.remove("hidden");
      return;
    }
    // Force-web / do-not-record are set from the app's detail screen now; new
    // apps already default to capture-off.
    // If this app was created from a browser tab, convert that tab into it.
    if (pendingOriginTab) { window.yo.convertTabToApp(pendingOriginTab, id); pendingOriginTab = null; }
    appAddForm.classList.add("hidden");
    const apps = await window.yo.panelAppsList();
    reloadPanelApps(apps.map(toPanelApp));
    const createdLocal = panelApps.find((a) => a.id === created.app!.id);
    if (createdLocal) openPanelAppDetail(createdLocal);
    else loadApps();
  });

  // App detail back button
  document.getElementById("app-detail-close")!.addEventListener("click", () => closeAppDetail());

  // App detail "Open app" — opens the app per its config (webview window,
  // native Chrome, or a native executable). Surfaces launch errors inline.
  document.getElementById("app-detail-open")!.addEventListener("click", async () => {
    const app = panelApps.find((a) => a.id === currentAppId);
    if (!app) return;
    const r = await launchPanelApp(app);
    if (!r.ok && r.error) { appFormError.textContent = r.error; appFormError.classList.remove("hidden"); }
  });

  // App add form cancel
  document.getElementById("app-add-cancel")!.addEventListener("click", () => { pendingOriginTab = null; loadApps(); });
  document.getElementById("app-add-cancel-btn")!.addEventListener("click", () => { pendingOriginTab = null; loadApps(); });

  // Tab buttons
  document.querySelectorAll<HTMLButtonElement>(".app-detail-tab").forEach(btn => {
    btn.addEventListener("click", () => switchAppTab(btn.dataset.tab!));
  });

  // Config Vars tab: add-form wiring (list loads on tab switch).
  wireConfigVarsForm();

  // Detail-form Browser ↔ Native + archetype toggles + Browse… button.
  const detailTypeSelect = document.getElementById("app-detail-type") as HTMLSelectElement;
  const detailArchetypeSelect = document.getElementById("app-detail-archetype") as HTMLSelectElement;
  const detailExecPath = document.getElementById("app-detail-exec-path") as HTMLInputElement;
  detailTypeSelect.addEventListener("change", () => {
    toggleTypeFields("app-detail", detailTypeSelect.value as AppType);
  });
  detailArchetypeSelect.addEventListener("change", () => toggleArchetypeFields("app-detail", detailArchetypeSelect.value as Archetype));
  document.getElementById("app-detail-exec-browse")!.addEventListener("click", async () => {
    const picked = await window.yo.pickExecutable();
    if (picked) detailExecPath.value = picked;
  });

  // Dashboard save
  document.getElementById("app-dash-save")!.addEventListener("click", async () => {
    if (!currentAppId) return;
    const newSlug = appDetailId.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    const type = detailTypeSelect.value as AppType;
    // A BUILT app keeps its kind (the server refuses to retype one) and its bundle
    // config; only its owner-set fields — name, tool approvals, limits — move here.
    const isBuilt = currentApp?.appArchetype === "glyphh-app";
    const patch: PanelAppInput = isBuilt ? {} : { isBrowser: type === "browser" };
    if (newSlug) patch.slug = newSlug;
    const name = appDetailName.value.trim();
    if (name) patch.name = name;

    if (isBuilt) {
      // The approvals + guardrails ride on top of the bundle's own contract, so
      // spread the existing config rather than replacing it.
      const { mcpApproved, guardrails } = readMcpConfig();
      patch.launchConfig = { ...(currentApp?.launchConfig || {}), mcpApproved, guardrails };
    } else if (type === "browser") {
      const url = appDetailUrl.value.trim();
      if (url) patch.url = url;
      patch.launchConfig = {};
      patch.execPath = null;
    } else {
      patch.url = null;
      patch.execPath = detailExecPath.value.trim();
      const archetype = detailArchetypeSelect.value as Archetype;
      patch.appArchetype = archetype;
      patch.launchConfig = readLaunchConfig("app-detail", archetype);
    }
    const saved = await window.yo.panelAppsUpdate(currentAppId, patch);
    if (!saved?.ok) {
      appFormError.textContent = saved?.error || "Failed to save app.";
      appFormError.classList.remove("hidden");
      return;
    }

    closeAppDetail();
  });

  // Dashboard cancel
  document.getElementById("app-dash-cancel")!.addEventListener("click", () => closeAppDetail());

  // Delete
  document.getElementById("app-detail-delete")!.addEventListener("click", async () => {
    if (!currentAppId) return;
    const confirmed = await confirmAction({
      title: `Delete “${appDetailName.value}”?`,
      body: "The app leaves your library — connected accounts stay intact.",
      confirmLabel: "Delete app",
      danger: true,
    });
    if (!confirmed) return;
    await window.yo.panelAppsDelete(currentAppId);
    closeAppDetail();
  });

  // Export the current app as a .glyphh bundle (main shows the save dialog).
  document.getElementById("app-detail-export")?.addEventListener("click", async () => {
    if (!currentAppId) return;
    const btn = document.getElementById("app-detail-export") as HTMLButtonElement;
    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Exporting…";
    try {
      const res = await window.yo.appExport(currentAppId);
      btn.textContent = res?.ok ? "Exported ✓" : (res?.error === "Canceled" ? prev : "Export failed");
    } catch {
      btn.textContent = "Export failed";
    } finally {
      setTimeout(() => { btn.disabled = false; btn.textContent = prev; }, 1800);
    }
  });

  // Deploy tab: who can reach the app. Saved on change — it is one control, and
  // a separate Save would let someone leave the page believing it took.
  document.getElementById("deploy-access")?.addEventListener("change", () => {
    syncDeployAccessHint();
    void saveDeployAccess();
  });

  // Deploy tab: deploy + take-down.
  document.getElementById("deploy-btn")?.addEventListener("click", async () => {
    const btn = document.getElementById("deploy-btn") as HTMLButtonElement;
    const err = document.getElementById("deploy-error")!;
    err.classList.add("hidden");
    btn.disabled = true; const prev = btn.textContent; btn.textContent = "Deploying…";
    const res = await window.yo.hostingDeploy(currentApp?.slug || currentAppId);
    btn.disabled = false; btn.textContent = prev;
    if (!res.ok) { err.textContent = res.error || "Deploy failed."; err.classList.remove("hidden"); return; }
    await loadDeployTab();
  });
  document.getElementById("deploy-takedown-btn")?.addEventListener("click", async () => {
    if (!deployCurrentId) return;
    const btn = document.getElementById("deploy-takedown-btn") as HTMLButtonElement;
    const err = document.getElementById("deploy-error")!;
    err.classList.add("hidden");
    btn.disabled = true; const prev = btn.textContent; btn.textContent = "Taking down…";
    const res = await window.yo.hostingDestroy(deployCurrentId);
    btn.disabled = false; btn.textContent = prev;
    if (!res.ok) { err.textContent = res.error || "Take-down failed."; err.classList.remove("hidden"); return; }
    await loadDeployTab();
  });

  // Production tab: graduate to a standalone Supabase repo (download zip).
  document.getElementById("graduate-btn")?.addEventListener("click", async () => {
    const btn = document.getElementById("graduate-btn") as HTMLButtonElement;
    const err = document.getElementById("graduate-error")!;
    err.classList.add("hidden");
    btn.disabled = true; const prev = btn.textContent; btn.textContent = "Exporting…";
    const res = await window.yo.appGraduate(currentApp?.slug || currentAppId);
    btn.disabled = false; btn.textContent = res.ok ? "Exported ✓" : prev;
    if (!res.ok && res.error !== "Canceled") { err.textContent = res.error || "Export failed."; err.classList.remove("hidden"); }
    setTimeout(() => { btn.textContent = prev; }, 1800);
  });

  // Import a .glyphh bundle (main shows the open dialog) → reload the apps list.
  document.getElementById("apps-import-btn")?.addEventListener("click", async () => {
    const btn = document.getElementById("apps-import-btn") as HTMLButtonElement;
    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Importing…";
    try {
      const res = await window.yo.appImport();
      if (res?.ok) {
        btn.textContent = "Imported ✓";
        await loadApps();
      } else {
        btn.textContent = res?.error === "Canceled" ? (prev || "Import app") : "Import failed";
      }
    } catch {
      btn.textContent = "Import failed";
    } finally {
      setTimeout(() => { btn.disabled = false; btn.textContent = prev || "Import app"; }, 1800);
    }
  });

  appSearchInput.addEventListener("input", () => { appsPage = 0; renderAppsList(); });

  // Apps dir changed on disk (e.g. an app dropped into ~/.glyphh/apps) — refresh the
  // registry list live when it's the visible view, so new apps appear without a
  // restart. Skip while a detail/form is open to avoid yanking the user away.
  window.yo.onAppsChanged(() => {
    if (!appsList.classList.contains("hidden") && appDetail.classList.contains("hidden") && appAddForm.classList.contains("hidden")) {
      loadApps();
    }
  });

  // Draggable split divider. Pointer CAPTURE, not document mouse listeners:
  // the preview pane is a webview, and a webview swallows mouse events — the
  // old document-level mouseup never fired over it, so the handle stuck to
  // the cursor until the next click on host chrome.
  const divider = document.getElementById("app-builder-divider")!;
  const controls = document.querySelector(".app-builder-controls") as HTMLElement;
  let startX = 0;
  let startW = 0;
  divider.addEventListener("pointerdown", (e) => {
    divider.setPointerCapture(e.pointerId);
    startX = e.clientX;
    startW = controls.offsetWidth;
    divider.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  divider.addEventListener("pointermove", (e) => {
    if (!divider.hasPointerCapture(e.pointerId)) return;
    const w = Math.max(200, Math.min(800, startW + (e.clientX - startX)));
    controls.style.width = w + "px";
  });
  const releaseDivider = (e: PointerEvent): void => {
    if (!divider.hasPointerCapture(e.pointerId)) return;
    divider.releasePointerCapture(e.pointerId);
    divider.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };
  divider.addEventListener("pointerup", releaseDivider);
  divider.addEventListener("pointercancel", releaseDivider);
}

export { loadApps, initApps, closeAppDetail };
