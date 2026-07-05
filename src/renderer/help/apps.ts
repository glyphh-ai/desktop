/**
 * Apps section — apps list + all tabs (dashboard, panel, connection, mcp).
 */

import {
  paginate, renderPaginationBar, confirmAction, clearInvalid,
  formatBytes, relativeTime, buildPaginationBar, cssVar, closeHelp,
} from "./shared.js";
import { appIconInner, primeConnectedIcons, primeNativeIcons } from "./app-icon.js";

declare const Chart: any;

// ── Apps (unified: apps + MCP + connections) ────────────

let appsPage = 0;
const APPS_PER_PAGE = 24;
const appsList = document.getElementById("apps-list")!;
const appDetail = document.getElementById("app-detail")!;
const appAddForm = document.getElementById("app-add-form")!;
const mcpAddForm = document.getElementById("mcp-add-form")!;
const appDetailId = document.getElementById("app-detail-id") as HTMLInputElement;
const appDetailName = document.getElementById("app-detail-name") as HTMLInputElement;
const appDetailUrl = document.getElementById("app-detail-url") as HTMLInputElement;
const appSearchInput = document.getElementById("app-search") as HTMLInputElement;
const appConnectStatus = document.getElementById("app-connect-status")!;
const appCommandsList = document.getElementById("app-commands-list")!;
const appMapCommand = document.getElementById("app-map-command")!;
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

// Show the browser-vs-native field blocks for a given form prefix.
type AppType = "browser" | "native" | "llm";

function toggleTypeFields(prefix: string, type: AppType): void {
  document.getElementById(`${prefix}-browser-fields`)?.classList.toggle("hidden", type !== "browser");
  document.getElementById(`${prefix}-native-fields`)?.classList.toggle("hidden", type !== "native");
  document.getElementById(`${prefix}-llm-fields`)?.classList.toggle("hidden", type !== "llm");
}

// ── MCP-exposing apps: static LLM tool set + approval + guardrails ──────────

/** Built-in tools an LLM-type app exposes at <slug>.glyphh.app/mcp — each
 *  bridges an incoming MCP call to the app's local model (BYOK). `sdkOnly`
 *  tools only make sense for the Claude Agent SDK provider (agentic loop). */
const LLM_TOOLS: Array<{ name: string; description: string; sdkOnly?: boolean }> = [
  { name: "send_prompt", description: "Send a prompt (or messages) to this local model and return its completion." },
  { name: "use_tool", description: "Give the model a set of tools and let it choose/call one (function-calling passthrough)." },
  { name: "run_agent", description: "Run an agentic loop against a task and return the result.", sdkOnly: true },
  { name: "count_tokens", description: "Count the tokens a piece of text uses for this model — no inference, cheap." },
  { name: "list_model", description: "Report the provider and model this endpoint exposes." },
];

/** The tool list an app exposes, by app shape: LLM apps use the static set
 *  (filtered by provider); installed apps declare theirs dynamically. */
function appExposableTools(app: { appArchetype?: string | null; launchConfig?: Record<string, unknown> | null }): Array<{ name: string; description: string }> {
  const lc = (app.launchConfig || {}) as Record<string, unknown>;
  if (app.appArchetype === "llm") {
    const provider = String((lc.llm as Record<string, unknown> | undefined)?.provider || "claude");
    return LLM_TOOLS.filter((t) => !t.sdkOnly || provider === "claude-agent-sdk").map((t) => ({ name: t.name, description: t.description }));
  }
  // Installed Glyphh app — its manifest declares tools (dynamic).
  const declared = Array.isArray(lc.tools) ? (lc.tools as Array<{ name?: string; description?: string }>) : [];
  return declared.filter((t) => t?.name).map((t) => ({ name: String(t.name), description: String(t.description || "") }));
}

/** True when an app has an MCP surface worth showing the MCP/Guardrails tabs. */
function appExposesMcp(app: { appArchetype?: string | null; launchConfig?: Record<string, unknown> | null }): boolean {
  return app.appArchetype === "llm" || appExposableTools(app).length > 0;
}

/** Show/hide + populate the MCP and Guardrails tabs for the open app. */
function syncMcpTabs(app: PanelApp): void {
  const exposes = appExposesMcp(app);
  document.querySelectorAll<HTMLElement>(".tab-mcp-only").forEach((el) => el.classList.toggle("hidden", !exposes));
  if (!exposes) return;

  const lc = (app.launchConfig || {}) as Record<string, unknown>;

  // Public endpoint URL.
  const ep = document.getElementById("app-mcp-endpoint");
  if (ep) ep.textContent = `https://${app.slug}.${APP_DOMAIN}/mcp`;

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

  // Guardrails fields.
  const g = (lc.guardrails || {}) as Record<string, unknown>;
  const setNum = (id: string, v: unknown) => { (document.getElementById(id) as HTMLInputElement).value = v == null ? "" : String(v); };
  setNum("app-gr-max-input", g.maxInputTokens);
  setNum("app-gr-max-output", g.maxOutputTokens);
  setNum("app-gr-window", g.windowSeconds);
  setNum("app-gr-window-tokens", g.windowTokens);
  setNum("app-gr-window-calls", g.windowCalls);
  setNum("app-gr-concurrent", g.maxConcurrent);
}

/** Re-render the MCP/Guardrails tabs from the CURRENT form state (type +
 *  provider), preserving already-checked tools and typed guardrail values —
 *  used when the user flips the type or provider while editing. */
function syncMcpTabsFromForm(): void {
  if (!currentApp) return;
  const type = (document.getElementById("app-detail-type") as HTMLSelectElement).value as AppType;
  const provider = (document.getElementById("app-detail-llm-provider") as HTMLSelectElement).value;
  const { mcpApproved, guardrails } = readMcpConfig(); // preserve current selections
  const synthetic: PanelApp = {
    ...currentApp,
    appArchetype: type === "llm" ? "llm" : (type === "native" ? (currentApp.appArchetype || "terminal") : null),
    launchConfig: {
      ...(currentApp.launchConfig || {}),
      llm: { provider },
      mcpApproved,
      guardrails,
    },
  };
  syncMcpTabs(synthetic);
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
  commands?: Record<string, { selector: string; action: string; description?: string; text?: string }>;
  connectionIds?: string[];
  mcp?: { transport: "stdio" | "sse" | "streamable-http"; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; oauth?: { clientId: string; hasSecret: boolean; tokenUrl: string; scope?: string }; enabled: boolean } | null;
}

function toPanelApp(a: {
  id: string; slug: string; name: string; system?: boolean; url: string | null;
  isBrowser?: boolean; execPath?: string | null;
  appArchetype?: string | null; launchConfig?: Record<string, unknown> | null;
  commands: Record<string, { selector: string; action: string; description?: string; text?: string }>;
  connectionIds: string[];
  mcp: { transport: "stdio" | "sse" | "streamable-http"; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; oauth?: { clientId: string; hasSecret: boolean; tokenUrl: string; scope?: string }; enabled: boolean } | null;
}): PanelApp {
  return {
    id: a.id, slug: a.slug, name: a.name, system: a.system, url: a.url,
    isBrowser: a.isBrowser, execPath: a.execPath,
    appArchetype: a.appArchetype, launchConfig: a.launchConfig,
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
  mcpAddForm.classList.add("hidden");

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
  const paras = d.description.split("\n\n").map((p) => `<p>${escMkt(p)}</p>`).join("");

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

        <section class="mkt-dt-section mkt-dt-desc">
          <h3>About ${escMkt(d.name)}</h3>
          ${paras}
        </section>

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

/** Switch between the "My apps" library and the Marketplace storefront. */
function switchAppsPage(page: "library" | "marketplace" | "proxies"): void {
  document.querySelectorAll<HTMLButtonElement>(".apps-page-tab").forEach((t) => t.classList.toggle("active", t.dataset.page === page));
  marketplaceLibraryPage.classList.toggle("hidden", page !== "library");
  marketplacePage.classList.toggle("hidden", page !== "marketplace");
  document.getElementById("apps-proxies-page")?.classList.toggle("hidden", page !== "proxies");
  if (page === "proxies") { closeProxyEditor(false); void loadProxies(); }
  // Marketplace is temporarily "Coming Soon" (storefront hidden in markup).
  // To re-enable, restore: if (page === "marketplace") { closeMktDetail(); void loadMarketplace(); }
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
  if (tab === "dashboard") loadPanelTab();
  if (tab === "config") void loadConfigVarsTab();
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
    if (s.hostOnly) {
      const badge = document.createElement("span");
      badge.className = "config-var-hostonly";
      badge.textContent = "runtime-only";
      badge.title = "Credential — encrypted, and never readable by app code (secrets.get refuses it). Only the trusted runtime uses it.";
      keyEl.appendChild(badge);
    }
    const valEl = document.createElement("span");
    valEl.className = "config-var-masked";
    valEl.textContent = "••••••••";
    valEl.title = "Encrypted — set " + (s.at ? new Date(s.at).toLocaleDateString() : "earlier") + "; values can't be viewed again";
    const del = document.createElement("button");
    del.className = "action-btn danger";
    del.style.cssText = "height:24px;font-size:11px;padding:0 10px;";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      if (!(await confirmAction(`Delete config var ${s.key}? Apps that need it will stop working until it's re-added.`))) return;
      await window.yo.appSecretsDelete(currentAppId, s.key);
      void loadConfigVarsTab();
    });
    row.append(keyEl, valEl, del);
    listEl.appendChild(row);
  }
}

function wireConfigVarsForm() {
  const keyEl = document.getElementById("config-var-key") as HTMLInputElement;
  const valueEl = document.getElementById("config-var-value") as HTMLTextAreaElement;
  const errEl = document.getElementById("config-var-error")!;
  const statusEl = document.getElementById("config-var-status")!;
  document.getElementById("config-var-add")!.addEventListener("click", async () => {
    errEl.classList.add("hidden");
    statusEl.textContent = "";
    const key = keyEl.value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    const value = valueEl.value;
    const res = await window.yo.appSecretsSet(currentAppId, key, value);
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

function loadPanelTab() {
  const app = panelApps.find((a) => a.id === currentAppId);
  if (!app) return;
  if (!app.url) {
    document.getElementById("app-commands-list")!.innerHTML = `<div class="inline-empty">No URL configured for this app. Add one above to enable panel features.</div>`;
    return;
  }
  if (!panelLoaded) {
    appPreview.partition = "persist:yo";
    appPreview.src = app.url;
    panelLoaded = true;
  }
  refreshCommands();
}


async function openPanelAppDetail(app: PanelApp) {
  currentAppId = app.id;
  currentApp = app;
  panelLoaded = false;

  // Populate dashboard fields
  appDetailId.value = app.slug;
  appDetailName.value = app.name;
  appDetailUrl.value = app.url || "";

  // Browser ↔ Native fields (pivot-mcp). Legacy apps have isBrowser undefined
  // but always carry a url, so they default to browser.
  const isBrowser = app.isBrowser !== undefined ? app.isBrowser : true;
  const detailType: AppType = isBrowser ? "browser" : (app.appArchetype === "llm" ? "llm" : "native");
  (document.getElementById("app-detail-type") as HTMLSelectElement).value = detailType;
  {
    const lc = (app.launchConfig || {}) as Record<string, unknown>;
    (document.getElementById("app-detail-browser") as HTMLSelectElement).value = typeof lc.browser === "string" && lc.browser ? String(lc.browser) : "default";
    (document.getElementById("app-detail-open-as") as HTMLSelectElement).value = lc.openAs === "tab" ? "tab" : "window";
    // LLM fields
    const llm = (lc.llm || {}) as Record<string, unknown>;
    (document.getElementById("app-detail-llm-provider") as HTMLSelectElement).value = String(llm.provider || "claude");
    (document.getElementById("app-detail-llm-model") as HTMLInputElement).value = String(llm.model || "");
  }
  (document.getElementById("app-detail-exec-path") as HTMLInputElement).value = app.execPath || "";
  const detailArchetype = (app.appArchetype as Archetype) || "terminal";
  (document.getElementById("app-detail-archetype") as HTMLSelectElement).value = detailArchetype;
  writeLaunchConfig("app-detail", detailArchetype, app.launchConfig);
  toggleTypeFields("app-detail", detailType);
  toggleArchetypeFields("app-detail", detailArchetype);

  // MCP + Guardrails tabs: only for apps that expose an MCP endpoint.
  syncMcpTabs(app);

  appConnectStatus.textContent = "";
  appMapCommand.classList.add("hidden");
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
  mcpAddForm.classList.add("hidden");
  appDetail.classList.remove("hidden");

  switchAppTab("dashboard");
}

async function refreshCommands() {
  const apps = await window.yo.panelAppsList();
  const app = apps.find((a) => a.id === currentAppId);
  const commands = app?.commands || {};
  const keys = Object.keys(commands);

  if (keys.length === 0) {
    appCommandsList.innerHTML = `<div class="inline-empty">No commands mapped. Click "Pick Element" to add one.</div>`;
    return;
  }

  appCommandsList.innerHTML = keys.map((key) => {
    const cmd = commands[key];
    return `<div class="command-row" data-key="${key}">
      <span class="command-key">${key}</span>
      <span class="command-desc">${cmd.description || cmd.action}</span>
      <span class="command-selector" title="${cmd.selector}">${cmd.selector.length > 40 ? cmd.selector.slice(0, 40) + "…" : cmd.selector}</span>
      <div class="command-actions">
        <button class="action-btn command-edit-btn" title="Edit">Edit</button>
        <button class="action-btn command-test-btn" title="Test">Test</button>
        <button class="action-btn danger command-remove-btn" title="Remove">×</button>
      </div>
    </div>`;
  }).join("");

  appCommandsList.querySelectorAll(".command-edit-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const key = (btn.closest(".command-row") as HTMLElement).dataset.key!;
      const cmd = commands[key];
      if (!cmd) return;
      openMappingForm(key, cmd.selector, cmd.action, cmd.description || "", (cmd as any).text);
    });
  });

  appCommandsList.querySelectorAll(".command-remove-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const key = (btn.closest(".command-row") as HTMLElement).dataset.key!;
      await window.yo.panelAppsRemoveCommand(currentAppId, key);
      refreshCommands();
    });
  });

  appCommandsList.querySelectorAll(".command-test-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const key = (btn.closest(".command-row") as HTMLElement).dataset.key!;
      const wcId = getPreviewWebContentsId();
      const result = await window.yo.appsTestCommand(commands[key] || null, wcId);
      appConnectStatus.textContent = result ? `Test ${key}: ${result.slice(0, 80)}` : `Test ${key}: executed`;
      setTimeout(() => { appConnectStatus.textContent = ""; }, 3000);
    });
  });
}

function getPreviewWebContentsId(): number | undefined {
  try { return appPreview.getWebContentsId(); } catch { return undefined; }
}

async function pickElement() {
  if (!currentAppId) return;
  const pickLabel = document.getElementById("app-pick-label");
  const setPickLabel = (txt: string) => { if (pickLabel) pickLabel.textContent = txt; };
  const wcId = getPreviewWebContentsId();
  if (!wcId) {
    setPickLabel("Preview not ready");
    setTimeout(() => setPickLabel("Pick Element"), 2000);
    return;
  }

  setPickLabel("Picking…");

  // Lock the close buttons while picking. Guard against any that no longer
  // exist (#help-close is gone since Home became a panel, not an overlay) —
  // touching a null element here used to throw and abort the whole picker.
  const closeBtns = ["help-close", "app-detail-close"]
    .map((id) => document.getElementById(id))
    .filter((el): el is HTMLElement => el !== null);
  const lockCloseBtns = (locked: boolean) => {
    for (const el of closeBtns) {
      (el as HTMLButtonElement).disabled = locked;
      el.style.opacity = locked ? "0.3" : "";
    }
  };
  lockCloseBtns(true);

  const picked = await new Promise<{
    selector: string; tag: string; text: string; isEditable: boolean; isClickable: boolean;
  } | null>((resolve) => {
    window.yo.onPickerResult((result) => {
      resolve(result);
    });
    window.yo.startPicker(wcId);
  });

  lockCloseBtns(false);
  setPickLabel("Pick Element");

  if (!picked) {
    appMapCommand.classList.add("hidden");
    return;
  }

  const action = picked.isEditable ? "setValue" : picked.isClickable ? "click" : "extractText";
  const info = `<${picked.tag}>` +
    `${picked.text ? ' "' + picked.text.slice(0, 60) + '"' : ""}` +
    `${picked.isEditable ? " [editable]" : ""}${picked.isClickable ? " [clickable]" : ""}`;

  document.getElementById("map-element-info")!.textContent = info;
  openMappingForm("", picked.selector, action, "", picked.text);
}

let mappingText = "";

function openMappingForm(key: string, selector: string, action: string, description: string, text?: string) {
  document.getElementById("map-selector")!.textContent = selector;
  mappingText = text ?? "";

  const keySelect = document.getElementById("map-command-key") as HTMLSelectElement;
  const customKeyInput = document.getElementById("map-custom-key") as HTMLInputElement;
  const actionSelect = document.getElementById("map-action") as HTMLSelectElement;
  const descInput = document.getElementById("map-description") as HTMLInputElement;

  // Check if key matches a preset option
  const presetOption = keySelect.querySelector(`option[value="${key}"]`);
  if (key && presetOption) {
    keySelect.value = key;
    customKeyInput.classList.add("hidden");
  } else if (key) {
    keySelect.value = "__custom__";
    customKeyInput.value = key;
    customKeyInput.classList.remove("hidden");
  } else {
    keySelect.value = "";
    customKeyInput.value = "";
    customKeyInput.classList.add("hidden");
  }

  actionSelect.value = action;
  descInput.value = description;
  appMapCommand.classList.remove("hidden");
}

async function saveMapping() {
  const keySelect = document.getElementById("map-command-key") as HTMLSelectElement;
  const customKeyInput = document.getElementById("map-custom-key") as HTMLInputElement;
  const actionSelect = document.getElementById("map-action") as HTMLSelectElement;
  const descInput = document.getElementById("map-description") as HTMLInputElement;
  const selector = document.getElementById("map-selector")!.textContent || "";

  let key = keySelect.value;
  if (key === "__custom__") {
    key = customKeyInput.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (!key) { customKeyInput.focus(); return; }
  }
  if (!key || !selector) return;

  const mapping: Record<string, string> = {
    selector,
    action: actionSelect.value,
    description: descInput.value.trim() || key,
  };
  if (mappingText) mapping.text = mappingText;
  await window.yo.panelAppsSetCommand(currentAppId, key, mapping);

  appMapCommand.classList.add("hidden");
  appConnectStatus.textContent = `Mapped: ${key}`;
  setTimeout(() => { appConnectStatus.textContent = ""; }, 2000);
  refreshCommands();
}


function closeAppDetail() {
  appPreview.src = "about:blank";
  panelLoaded = false;
  appMapCommand.classList.add("hidden");
  appDetail.classList.add("hidden");
  appsList.classList.remove("hidden");
  appsToolbar.classList.remove("hidden");
  loadApps();
}

function reloadPanelApps(apps: Array<PanelApp>) {
  panelApps = apps.filter((a) => !a.system && (a.url || a.isBrowser === false));
}

// When a browser tab is "Create App"'d, the originating tab id is stashed here
// so the save handler can convert that tab into the new app.
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

// ── Public URLs (app proxy tunnels — APP-PROXY-UI-SPEC) ────────────────────

type ProxyRow = Awaited<ReturnType<typeof window.yo.appProxiesList>>["proxies"][number];

const APP_DOMAIN = "glyphh.app";
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

let allProxies: ProxyRow[] = [];
let editingProxyId: string | null = null;

const proxyEl = (id: string) => document.getElementById(id)!;
const proxyInput = (id: string) => document.getElementById(id) as HTMLInputElement;
const proxySelect = (id: string) => document.getElementById(id) as HTMLSelectElement;

function proxyUrl(slug: string): string { return `https://${slug || "<name>"}.${APP_DOMAIN}`; }

async function loadProxies(): Promise<void> {
  const res = await window.yo.appProxiesList();
  allProxies = res.ok ? res.proxies : [];
  renderProxiesList(res.ok ? undefined : res.error);
}

function renderProxiesList(loadError?: string): void {
  const list = proxyEl("proxies-list");
  // Same tile grid as the Apps/Connections/Layouts pages. Preserve the hidden
  // state so a re-render never pops the list over an open editor.
  const wasHidden = list.classList.contains("hidden") || !proxyEl("proxy-editor").classList.contains("hidden");
  list.className = wasHidden ? "app-list-wrap hidden" : "app-list-wrap";
  list.innerHTML = "";

  if (loadError) { list.innerHTML = `<div class="crud-empty">${escMkt(loadError)}</div>`; return; }
  if (!allProxies.length) {
    list.innerHTML = `<div class="crud-empty">No public URLs yet. Click "+ New" to expose a local app.</div>`;
    return;
  }
  const query = (document.getElementById("proxy-search") as HTMLInputElement | null)?.value.trim().toLowerCase() || "";
  const filtered = query
    ? allProxies.filter((p) => p.slug.includes(query) || (p.label || "").toLowerCase().includes(query) || p.target.toLowerCase().includes(query))
    : allProxies;
  if (!filtered.length) { list.innerHTML = `<div class="crud-empty">No public URLs matching "${escMkt(query)}"</div>`; return; }

  const grid = document.createElement("div");
  grid.className = "app-grid";
  for (const p of filtered) {
    const card = document.createElement("div");
    card.className = "app-card";
    card.innerHTML = `
      <div class="app-card-icon"><span class="app-card-initial">🌐</span></div>
      <div class="app-card-name"></div>
      <div class="app-card-id"></div>`;
    card.querySelector(".app-card-name")!.textContent = p.label || p.slug;
    card.querySelector(".app-card-id")!.textContent =
      `${p.slug}.${APP_DOMAIN}${p.status !== "active" ? ` · ${p.status}` : ""}`;
    card.addEventListener("click", () => openProxyEditor(p));
    grid.appendChild(card);
  }
  list.appendChild(grid);
}

function proxyEditorHead(slug: string): void {
  proxyEl("proxy-detail-head").innerHTML =
    `<div class="app-card-icon"><span class="app-card-initial">🌐</span></div>` +
    `<div class="edit-head-name">${escMkt(slug || "New public URL")}<span class="edit-head-slug">${escMkt(proxyUrl(slug))}</span></div>`;
}

/** Show/hide the mode-dependent field blocks + warnings. */
function syncProxyAuthFields(): void {
  const mode = proxySelect("proxy-auth-mode").value;
  proxyEl("proxy-visibility-wrap").classList.toggle("hidden", mode !== "glyphh");
  proxyEl("proxy-oidc-fields").classList.toggle("hidden", mode !== "oidc");
  proxyEl("proxy-public-warn").classList.toggle("hidden", mode !== "public");
}

function openProxyEditor(p: ProxyRow | null): void {
  editingProxyId = p?.id ?? null;
  proxyEl("proxy-form-error").classList.add("hidden");
  proxyInput("proxy-slug").value = p?.slug || "";
  proxyInput("proxy-slug").disabled = !!p;             // slug is immutable after create
  proxyInput("proxy-target").value = p?.target || "";
  proxySelect("proxy-auth-mode").value = p?.auth_mode || "glyphh";
  proxySelect("proxy-visibility").value = p?.visibility || "private";
  proxyInput("proxy-oidc-issuer").value = p?.auth_config?.issuer || "";
  proxyInput("proxy-oidc-client-id").value = p?.auth_config?.clientId || "";
  proxyInput("proxy-oidc-secret").value = "";
  proxyEl("proxy-oidc-secret-hint").classList.toggle("hidden", !p?.auth_config?.hasClientSecret);
  proxyInput("proxy-oidc-scopes").value = (p?.auth_config?.scopes || []).join(" ");
  proxyInput("proxy-oidc-domains").value = (p?.auth_config?.allowedDomains || []).join(", ");
  proxyInput("proxy-label").value = p?.label || "";
  proxyEl("proxy-delete-btn").style.display = p ? "" : "none";
  const openLink = proxyEl("proxy-open-link") as HTMLAnchorElement;
  openLink.classList.toggle("hidden", !p);
  if (p) openLink.href = proxyUrl(p.slug);
  proxyEl("proxy-copy-btn").classList.toggle("hidden", !p);
  const toggleBtn = proxyEl("proxy-toggle-btn");
  // Owners can flip active↔disabled; "flagged" is admin-only, so hide there.
  toggleBtn.classList.toggle("hidden", !p || p.status === "flagged");
  toggleBtn.textContent = p?.status === "disabled" ? "Enable" : "Disable";
  proxyEditorHead(p?.slug || "");
  syncProxySlugPreview();
  syncProxyAuthFields();

  proxyEl("proxies-list").classList.add("hidden");
  proxyEl("proxies-toolbar").classList.add("hidden");
  proxyEl("proxy-editor").classList.remove("hidden");
  if (!p) proxyInput("proxy-slug").focus();
}

function closeProxyEditor(reload = true): void {
  proxyEl("proxy-editor").classList.add("hidden");
  proxyEl("proxies-list").classList.remove("hidden");
  proxyEl("proxies-toolbar").classList.remove("hidden");
  editingProxyId = null;
  if (reload) void loadProxies();
}

function syncProxySlugPreview(): void {
  const slug = proxyInput("proxy-slug").value.trim().toLowerCase();
  proxyEl("proxy-url-preview").textContent = proxyUrl(slug);
  proxyEl("proxy-oidc-callback").textContent = `${proxyUrl(slug)}/__glyphh/oidc/callback`;
  proxyEditorHead(slug);
}

function proxyFormError(msg: string): void {
  const el = proxyEl("proxy-form-error");
  el.textContent = msg;
  el.classList.remove("hidden");
}

async function saveProxy(): Promise<void> {
  proxyEl("proxy-form-error").classList.add("hidden");
  const slug = proxyInput("proxy-slug").value.trim().toLowerCase();
  const target = proxyInput("proxy-target").value.trim();
  const authMode = proxySelect("proxy-auth-mode").value;
  const visibility = proxySelect("proxy-visibility").value;
  const label = proxyInput("proxy-label").value.trim();

  if (!editingProxyId && !SLUG_RE.test(slug)) { proxyFormError("Subdomain must be 1–63 lowercase letters, digits, or hyphens (no leading/trailing hyphen)."); return; }
  if (!/^https?:\/\//i.test(target)) { proxyFormError("Target must start with http:// or https://."); return; }

  let authConfig: Record<string, unknown> | undefined;
  if (authMode === "oidc") {
    const issuer = proxyInput("proxy-oidc-issuer").value.trim();
    const clientId = proxyInput("proxy-oidc-client-id").value.trim();
    const clientSecret = proxyInput("proxy-oidc-secret").value;
    const hadSecret = !proxyEl("proxy-oidc-secret-hint").classList.contains("hidden");
    if (!/^https:\/\//i.test(issuer)) { proxyFormError("OIDC issuer must be an https:// URL."); return; }
    if (!clientId) { proxyFormError("OIDC client ID is required."); return; }
    if (!clientSecret && !hadSecret) { proxyFormError("OIDC client secret is required."); return; }
    const scopes = proxyInput("proxy-oidc-scopes").value.trim().split(/[\s,]+/).filter(Boolean);
    const allowedDomains = proxyInput("proxy-oidc-domains").value.split(",").map((s) => s.trim()).filter(Boolean);
    authConfig = {
      issuer, clientId,
      ...(clientSecret ? { clientSecret } : {}),   // blank on edit = keep stored secret
      ...(scopes.length ? { scopes } : {}),
      ...(allowedDomains.length ? { allowedDomains } : {}),
    };
  }

  const res = editingProxyId
    ? await window.yo.appProxyUpdate(editingProxyId, { target, visibility, label: label || null, authMode, ...(authConfig ? { authConfig } : {}) })
    : await window.yo.appProxyCreate({ slug, target, visibility, label: label || undefined, authMode, ...(authConfig ? { authConfig } : {}) });

  if (!res.ok) {
    proxyFormError(/taken/i.test(res.error || "") ? "That subdomain is already taken — pick another." : (res.error || "Save failed"));
    return;
  }
  closeProxyEditor();
}

async function deleteProxy(): Promise<void> {
  if (!editingProxyId) return;
  const p = allProxies.find((x) => x.id === editingProxyId);
  const confirmed = await confirmAction(`Delete ${proxyUrl(p?.slug || "")}? Visitors will get "not found" immediately.`);
  if (!confirmed) return;
  await window.yo.appProxyDelete(editingProxyId);
  closeProxyEditor();
}

function initProxiesPage(): void {
  document.getElementById("proxy-new-btn")?.addEventListener("click", () => openProxyEditor(null));
  document.getElementById("proxy-back-link")?.addEventListener("click", () => closeProxyEditor());
  document.getElementById("proxy-cancel-btn")?.addEventListener("click", () => closeProxyEditor());
  document.getElementById("proxy-save-btn")?.addEventListener("click", () => { void saveProxy(); });
  document.getElementById("proxy-delete-btn")?.addEventListener("click", () => { void deleteProxy(); });
  document.getElementById("proxy-auth-mode")?.addEventListener("change", syncProxyAuthFields);
  document.getElementById("proxy-search")?.addEventListener("input", () => renderProxiesList());
  document.getElementById("proxy-copy-btn")?.addEventListener("click", () => {
    const p = allProxies.find((x) => x.id === editingProxyId);
    if (p) window.yo.copyToClipboard(proxyUrl(p.slug));
  });
  document.getElementById("proxy-toggle-btn")?.addEventListener("click", async () => {
    const p = allProxies.find((x) => x.id === editingProxyId);
    if (!p || p.status === "flagged") return;
    const res = await window.yo.appProxyUpdate(p.id, { status: p.status === "disabled" ? "active" : "disabled" });
    if (res.ok && res.proxy) {
      const idx = allProxies.findIndex((x) => x.id === p.id);
      if (idx >= 0) allProxies[idx] = res.proxy;
      proxyEl("proxy-toggle-btn").textContent = res.proxy.status === "disabled" ? "Enable" : "Disable";
    }
  });
  const slugInput = proxyInput("proxy-slug");
  slugInput?.addEventListener("input", () => {
    const lower = slugInput.value.toLowerCase();
    if (slugInput.value !== lower) slugInput.value = lower;
    syncProxySlugPreview();
  });
}

function initApps() {
  initProxiesPage();

  // Browser dropdowns (add form + editor) — the real browsers on this machine.
  void window.yo.browsersDetect?.().then((browsers) => {
    for (const id of ["app-add-browser", "app-detail-browser"]) {
      const sel = document.getElementById(id) as HTMLSelectElement | null;
      if (!sel) continue;
      for (const b of browsers) {
        const opt = document.createElement("option");
        opt.value = b.id;
        opt.textContent = b.name;
        sel.appendChild(opt);
      }
    }
  }).catch(() => { /* dropdowns keep "System default" */ });
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
    document.querySelector<HTMLButtonElement>('.help-nav-item[data-section="connections"]')?.click();
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
      switchAppsPage(page === "marketplace" || page === "proxies" ? page : "library");
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
    (document.getElementById("app-add-browser") as HTMLSelectElement).value = "default";
    (document.getElementById("app-add-open-as") as HTMLSelectElement).value = "window";
    addExecPath.value = "";
    addArchetypeSelect.value = "terminal";
    writeLaunchConfig("app-add", "terminal", null);
    toggleTypeFields("app-add", "browser");
    toggleArchetypeFields("app-add", "terminal");
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

  // MCP add form transport toggle
  document.getElementById("mcp-add-transport")!.addEventListener("change", () => {
    const transport = (document.getElementById("mcp-add-transport") as HTMLSelectElement).value;
    document.getElementById("mcp-add-stdio-fields")!.classList.toggle("hidden", transport !== "stdio");
    document.getElementById("mcp-add-sse-fields")!.classList.toggle("hidden", transport !== "sse");
  });

  // MCP add form save
  document.getElementById("mcp-add-save")!.addEventListener("click", async () => {
    const name = (document.getElementById("mcp-add-name") as HTMLInputElement).value.trim();
    const transport = (document.getElementById("mcp-add-transport") as HTMLSelectElement).value as "stdio" | "sse";
    const errEl = document.getElementById("mcp-form-error")!;

    if (!name) { errEl.textContent = "Name required"; errEl.classList.remove("hidden"); return; }

    const mcpConfig: Record<string, unknown> = { transport, enabled: false };
    if (transport === "stdio") {
      const command = (document.getElementById("mcp-add-command") as HTMLInputElement).value.trim();
      if (!command) { errEl.textContent = "Command required"; errEl.classList.remove("hidden"); return; }
      mcpConfig.command = command;
      const args = (document.getElementById("mcp-add-args") as HTMLInputElement).value.trim();
      if (args) mcpConfig.args = args.split(/\s+/);
      const envText = (document.getElementById("mcp-add-env") as HTMLTextAreaElement).value.trim();
      if (envText) {
        const env: Record<string, string> = {};
        for (const line of envText.split("\n")) {
          const eq = line.indexOf("=");
          if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
        }
        mcpConfig.env = env;
      }
    } else {
      const url = (document.getElementById("mcp-add-url") as HTMLInputElement).value.trim();
      if (!url) { errEl.textContent = "URL required"; errEl.classList.remove("hidden"); return; }
      mcpConfig.url = url;
    }

    // KNOWN GAP: headless MCP-only entries (no panel URL) stay local — the
    // server's saved_apps.url column is NOT NULL, so this path can't move to
    // /api/panel-apps without a schema change. Flagged, not fixed here since
    // it's a server-side ask outside this pass's scope.
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
    await window.yo.appsAdd(id, name);
    await window.yo.appsSetMcp(id, mcpConfig as any);
    await window.yo.mcpAddServer({ id, name, ...mcpConfig } as any);

    mcpAddForm.classList.add("hidden");
    const apps = await window.yo.panelAppsList();
    reloadPanelApps(apps.map(toPanelApp));
    const created = panelApps.find((a) => a.id === id);
    if (created) openPanelAppDetail(created);
    else loadApps();
  });

  // MCP add form cancel
  document.getElementById("mcp-add-cancel")!.addEventListener("click", () => loadApps());
  document.getElementById("mcp-add-cancel-btn")!.addEventListener("click", () => loadApps());

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
      appFormError.textContent = addType === "browser" ? "Name and URL are required." : addType === "native" ? "Name and executable path are required." : "Name is required.";
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
      ? { name, slug: id, isBrowser: true, url, execPath: null,
          launchConfig: {
            browser: (document.getElementById("app-add-browser") as HTMLSelectElement).value,
            openAs: (document.getElementById("app-add-open-as") as HTMLSelectElement).value,
          } }
      : addType === "llm"
      ? { name, slug: id, isBrowser: false, url: null, execPath: null, appArchetype: "llm",
          launchConfig: { llm: { provider: (document.getElementById("app-add-llm-provider") as HTMLSelectElement).value, model: null } } }
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

  // Panel tab: "Pick Element" — start the element picker on the app preview.
  document.getElementById("app-pick-btn")?.addEventListener("click", () => { void pickElement(); });

  // Panel tab: command mapping form — Save / Cancel were never wired, so a
  // captured command had no way to persist.
  document.getElementById("map-save-btn")?.addEventListener("click", () => { void saveMapping(); });
  document.getElementById("map-cancel-btn")?.addEventListener("click", () => {
    appMapCommand.classList.add("hidden");
  });
  // Reveal the custom-key input when "+ custom command" is chosen.
  document.getElementById("map-command-key")?.addEventListener("change", (e) => {
    const sel = e.target as HTMLSelectElement;
    const custom = document.getElementById("map-custom-key") as HTMLInputElement;
    custom.classList.toggle("hidden", sel.value !== "__custom__");
    if (sel.value === "__custom__") custom.focus();
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
    const type = detailTypeSelect.value as AppType;
    toggleTypeFields("app-detail", type);
    // Switching to/from LLM changes whether this app exposes MCP — re-sync the
    // tabs against a synthetic app view of the current form state.
    syncMcpTabsFromForm();
  });
  // Provider affects which static tools apply (run_agent is Agent-SDK only).
  document.getElementById("app-detail-llm-provider")?.addEventListener("change", syncMcpTabsFromForm);
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
    // LLM apps are non-browser executables (archetype "llm") that expose an
    // MCP endpoint rather than launching anything.
    const patch: PanelAppInput = { isBrowser: type === "browser" };
    if (newSlug) patch.slug = newSlug;
    const name = appDetailName.value.trim();
    if (name) patch.name = name;

    if (type === "browser") {
      const url = appDetailUrl.value.trim();
      if (url) patch.url = url;
      patch.launchConfig = {
        browser: (document.getElementById("app-detail-browser") as HTMLSelectElement).value,
        openAs: (document.getElementById("app-detail-open-as") as HTMLSelectElement).value,
      };
      patch.execPath = null;
    } else if (type === "llm") {
      patch.url = null;
      patch.execPath = null;
      patch.appArchetype = "llm";
      const { mcpApproved, guardrails } = readMcpConfig();
      patch.launchConfig = {
        llm: {
          provider: (document.getElementById("app-detail-llm-provider") as HTMLSelectElement).value,
          model: (document.getElementById("app-detail-llm-model") as HTMLInputElement).value.trim() || null,
        },
        mcpApproved,
        guardrails,
      };
    } else {
      patch.url = null;
      patch.execPath = detailExecPath.value.trim();
      const archetype = detailArchetypeSelect.value as Archetype;
      patch.appArchetype = archetype;
      // Preserve MCP approval + guardrails for installed apps that expose tools.
      const { mcpApproved, guardrails } = readMcpConfig();
      patch.launchConfig = { ...readLaunchConfig("app-detail", archetype), mcpApproved, guardrails };
    }
    await window.yo.panelAppsUpdate(currentAppId, patch);

    closeAppDetail();
  });

  // Dashboard cancel
  document.getElementById("app-dash-cancel")!.addEventListener("click", () => closeAppDetail());

  // Delete
  document.getElementById("app-detail-delete")!.addEventListener("click", async () => {
    if (!currentAppId) return;
    const confirmed = await confirmAction(`Delete app "${appDetailName.value}"?`);
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

  // Apps dir changed on disk (e.g. an app dropped into ~/yo/apps) — refresh the
  // registry list live when it's the visible view, so new apps appear without a
  // restart. Skip while a detail/form is open to avoid yanking the user away.
  window.yo.onAppsChanged(() => {
    if (!appsList.classList.contains("hidden") && appDetail.classList.contains("hidden") && appAddForm.classList.contains("hidden")) {
      loadApps();
    }
  });

  // Draggable split divider
  const divider = document.getElementById("app-builder-divider")!;
  const controls = document.querySelector(".app-builder-controls") as HTMLElement;
  let dragging = false;
  let startX = 0;
  let startW = 0;

  divider.addEventListener("mousedown", (e) => {
    dragging = true;
    startX = e.clientX;
    startW = controls.offsetWidth;
    divider.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const w = Math.max(200, Math.min(800, startW + (e.clientX - startX)));
    controls.style.width = w + "px";
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });
}

export { loadApps, initApps, closeAppDetail, pickElement, saveMapping };
