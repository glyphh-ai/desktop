/**
 * Apps section — apps list + all tabs (dashboard, panel, connection, mcp).
 */

import {
  paginate, renderPaginationBar, confirmAction, promptAction, clearInvalid,
  formatBytes, relativeTime, buildPaginationBar, cssVar, closeHelp,
} from "./shared.js";
import { appIconInner, primeConnectedIcons, primeNativeIcons } from "./app-icon.js";
import { gotoSection, closeSettingsModal } from "./navigation.js";
import { openAppInWorkbench, openWorkPanelInWorkbench } from "./code.js";

/** HTML-escape (inlined from the dead marketplace-data module). */
function escMkt(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
/** Compact date for history rows (inlined from the dead marketplace-data module). */
function mktDate(iso: string): string {
  try { return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
  catch { return iso; }
}
import { formatMarkdown } from "../format-markdown.js";

declare const Chart: any;

// ── Apps (unified: apps + MCP + connections) ────────────

let appsPage = 0;
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

// WEB surface (browser tab): there is no privileged <webview>, so the editor's
// preview pane renders as a sandboxed <iframe> instead — see renderWebPreview.
// Same branch flag the rest of the renderer uses (set by web/src/bridge.js).
const IS_WEB = !!(window as unknown as { __GLYPHH_WEB__?: boolean }).__GLYPHH_WEB__;

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
  const list = document.getElementById("app-mcp-tools");
  if (!list) return;
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
  const setNum = (id: string, v: unknown) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.value = v == null ? "" : String(v);
  };
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
  const res = await window.glyphh.panelAppsUpdate?.(currentAppId, { launchConfig });
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
  const res = await window.glyphh.appCallTool?.(currentApp.slug, tool, args);
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
  /** The app's steered NEXT version — what the next build releases. */
  version?: string;
  /** Secret NAMES the manifest declares — drives the Config Vars tab. */
  secretNames?: string[];
  /** Connections the manifest requires, with connected status. */
  requiredConnections?: { slug: string; actAs: string; connected: boolean }[];
  /** The listing's uploaded icon — the ONE icon source (same as the command
   *  center): a hosted app's launch URL has no favicon to derive one from. */
  iconUrl?: string | null;
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
  access?: string; iconUrl?: string | null; listing?: PanelApp["listing"];
  owned?: boolean; latestVersion?: string | null; version?: string; secretNames?: string[];
  requiredConnections?: { slug: string; actAs: string; connected: boolean }[];
  commands: Record<string, { selector: string; action: string; description?: string; text?: string }>;
  connectionIds: string[];
  mcp: { transport: "stdio" | "sse" | "streamable-http"; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; oauth?: { clientId: string; hasSecret: boolean; tokenUrl: string; scope?: string }; enabled: boolean } | null;
}): PanelApp {
  return {
    id: a.id, slug: a.slug, name: a.name, system: a.system, url: a.url,
    isBrowser: a.isBrowser, execPath: a.execPath,
    appArchetype: a.appArchetype, launchConfig: a.launchConfig, access: a.access,
    iconUrl: a.iconUrl ?? a.listing?.iconUrl ?? null, listing: a.listing,
    owned: a.owned, latestVersion: a.latestVersion, version: a.version, secretNames: a.secretNames, requiredConnections: a.requiredConnections,
    commands: a.commands, connectionIds: a.connectionIds, mcp: a.mcp,
  };
}

let panelApps: PanelApp[] = [];

/** Open an app the way its config dictates (Browser↔Native model): native apps
 *  launch their executable, browser apps open in native Chrome or Glyphh's
 *  the configured real browser (window or tab). Returns the launch result so callers can
 *  surface an error. */
async function launchPanelApp(app: PanelApp): Promise<{ ok: boolean; error?: string }> {
  return (await window.glyphh.appLaunch?.({
    slug: app.slug, name: app.name, url: app.url,
    isBrowser: app.isBrowser,
    execPath: app.execPath, appArchetype: app.appArchetype, launchConfig: app.launchConfig,
  })) ?? { ok: false, error: "Launching apps isn't available on this surface." };
}

async function loadApps() {
  appDetail.classList.add("hidden");
  appAddForm.classList.add("hidden");

  document.getElementById("apps-pro-gate")?.classList.add("hidden");
  appsList.classList.remove("hidden");
  appsToolbar.classList.remove("hidden");

  try {
    const apps = (await window.glyphh.panelAppsList?.()) || [];
    // Keep browser apps (have a url) and native apps (isBrowser === false).
    // Legacy rows have neither field set but always carry a url, so the url
    // check still covers them.
    // Hide seeded system apps (Glyphh) — they aren't user-managed. Builtin
    // WORKPANELS never reach this list (kind 'workpanel': no url, isBrowser
    // true — the first filter drops them). A USER-BUILT workbench app
    // (config.workbench === true on a glyphh app) is the user's own work and
    // BELONGS here (his rule, 2026-08-19: the Apps page is what you built) —
    // the old truthy workbench filter hid those too, leaving customs with no
    // edit/delete surface at all.
    panelApps = apps
      .filter((a) => !a.system && (a.url || a.isBrowser === false))
      .map(toPanelApp);
  } catch { panelApps = []; }
  // The rail's Apps grid mirrors this list — tell it to refresh.
  document.dispatchEvent(new CustomEvent("glyphh:apps-changed"));

  document.getElementById("apps-limit-msg")?.classList.add("hidden");

  renderAppsList();
  // Async — re-renders once OS file icons (native apps) land. Apps no longer
  // carry a Pipedream connection (Connections are their own tab now), so their
  // icon comes from the url favicon or the executable icon.
  void primeNativeIcons(panelApps, renderAppsList);
  // Org admins: the co-working approval queue above the grid (empty → hidden).
}

function renderAppsList() {
  const query = appSearchInput.value.trim().toLowerCase();

  const filtered = query
    ? panelApps.filter((a) => a.name.toLowerCase().includes(query) || (a.url || "").toLowerCase().includes(query))
    : panelApps;

  // ONE grid for everything: #apps-grid is static in sections/apps.html and
  // already holds the ten built-in work-panel cards. We only manage the org
  // cards rendered after them — clear those (plus any pagination bar / empty
  // message, which live as SIBLINGS of the grid; a bar inside the grid would
  // be a stray grid cell) and leave the work panels alone.
  const grid = document.getElementById("apps-grid")!;
  grid.querySelectorAll(".app-card:not(.workpanel-card)").forEach((el) => el.remove());
  appsList.querySelectorAll(".pagination-bar, .crud-empty").forEach((el) => el.remove());

  // The work panels join the search: hide the cards that don't match.
  let panelsVisible = 0;
  grid.querySelectorAll<HTMLElement>(".workpanel-card").forEach((card) => {
    const name = (card.querySelector(".app-card-name")?.textContent || "").toLowerCase();
    const hit = !query || name.includes(query);
    card.classList.toggle("hidden", !hit);
    if (hit) panelsVisible++;
  });

  if (query && filtered.length === 0) {
    if (panelsVisible === 0) {
      appsList.insertAdjacentHTML("beforeend", `<div class="crud-empty">No apps matching "${query}"</div>`);
    }
    return;
  }

  const { items: pageApps, state } = paginate(filtered, appsPage);
  appsPage = state.page;

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

  if (state.totalPages > 1) {
    appsList.appendChild(renderPaginationBar(state, (p) => { appsPage = p; renderAppsList(); }));
  }
}

// ── Work panels (built-in) ───────────────────────────────

// ── Tab switching ────────────────────────────────────────

function switchAppTab(tab: string) {
  activeAppTab = tab as typeof activeAppTab;
  document.querySelectorAll<HTMLButtonElement>(".app-detail-tab[data-tab]").forEach(btn => {
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
  if (tab === "history") void loadHistoryTab();
  if (tab === "webhooks") { void import("./settings-webhooks.js").then((m) => m.renderAppData(currentApp?.slug || currentAppId, currentApp?.name || currentAppId)); }
  // Consumer view (marketplace-installed): render from the cached store
  // Deploy + "own your code" share the Public hosting tab: both answer "who runs
  // this for the public", which is a different question from how it is distributed
  // inside Glyphh (Releases + Marketplace).

}

// ── Marketplace tab — the listing an installer sees ──────────────
//
// The agent can write every field here (set_app_listing / upload_app_image over
// MCP). What it deliberately cannot do is press List: publishing to other orgs is
// the irreversible half, so it stays a human click on this tab.

async function loadHistoryTab(): Promise<void> {
  const list = document.getElementById("apphist-list");
  const errEl = document.getElementById("apphist-error");
  if (!list) return;
  errEl?.classList.add("hidden");
  list.innerHTML = `<div class="inline-empty">Loading…</div>`;
  const slug = currentApp?.slug || currentAppId;
  const res = await window.glyphh.appSourceHistory?.(slug);
  if (currentApp && (currentApp.slug || currentAppId) !== slug) return;
  if (!res?.ok) {
    list.innerHTML = "";
    if (errEl) { errEl.textContent = res?.error || "Couldn't load the version history."; errEl.classList.remove("hidden"); }
    return;
  }
  if (!res.history.length) {
    list.innerHTML = `<div class="inline-empty">No snapshots yet — the first build records one.</div>`;
    return;
  }
  list.innerHTML = "";
  for (const s of res.history) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);";
    row.innerHTML = `
      <code style="font-family:var(--font-mono);font-size:11.5px;color:var(--text-2);">${escMkt(s.hash.slice(0, 12))}</code>
      ${s.isHead ? `<span class="release-badge live">latest</span>` : ""}
      <div style="flex:1;min-width:0;font-size:12.5px;color:var(--text-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
        ${s.note ? `${escMkt(s.note)}<span style="color:var(--text-3);margin-left:8px;">${escMkt(s.createdByEmail || "unknown")}</span>` : escMkt(s.createdByEmail || "unknown")}
        <span style="color:var(--text-3);margin-left:8px;">${escMkt(mktDate(s.createdAt))}</span>
      </div>
      ${!s.isHead && !IS_WEB ? `<button type="button" class="action-btn apphist-restore" style="height:24px;font-size:11px;padding:0 10px;">Restore</button>` : ""}`;
    row.querySelector(".apphist-restore")?.addEventListener("click", () => {
      void (async () => {
        const ok = await confirmAction({
          title: `Restore ${s.hash.slice(0, 12)}?`,
          body: "This version's files replace your working folder's copy of the app. Your next build makes it the new latest — nothing in the history is lost.",
          confirmLabel: "Restore",
        });
        if (!ok) return;
        const r = await window.glyphh.appSourceRestore?.(slug, s.hash);
        if (!r?.ok) {
          if (errEl) { errEl.textContent = r?.error || "Couldn't restore the snapshot."; errEl.classList.remove("hidden"); }
          return;
        }
        errEl?.classList.add("hidden");
        const done = document.createElement("div");
        done.className = "settings-hint";
        done.style.cssText = "margin:8px 0;";
        done.textContent = `Restored into ${r.dir} (${r.files} files) — build + update the app to run it.`;
        list.prepend(done);
      })();
    });
    list.appendChild(row);
  }
}

// ── Edge traffic (his order, 2026-09-02): the apex fleet's stats for this
// app's custom hostnames — requests/day chart, totals, per-hostname table. ──

type TrafficRow = { day: string; requests: number; bytesIn: number; bytesOut: number; avgMs: number; maxMs: number; s2xx: number; s3xx: number; s4xx: number; s5xx: number; blocked: number; offline?: number };

const fmtInt = (n: number): string => Math.max(0, Math.round(n || 0)).toLocaleString();

type CollabRole = "read" | "edit" | "admin";
interface CollabRow { userId: string; role: CollabRole; email: string; name: string | null; addedAt: string }

function collabError(msg: string): void {
  const el = document.getElementById("app-collab-error");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

async function loadCollabSection(): Promise<void> {
  const sec = document.getElementById("app-collab-section");
  if (!sec) return;
  sec.classList.add("hidden");
  collabError("");
  const app = currentApp;
  // Built glyphh apps the caller PUBLISHED — an installed app's seats belong
  // to its developer, and legacy launcher rows have nothing to co-work on.
  if (!app || app.appArchetype !== "glyphh-app" || app.owned === false) return;
  const slug = app.slug;
  const res = await window.glyphh.appCollaborators?.(slug);
  if (currentApp?.slug !== slug) return;   // he moved on — never paint stale
  if (!res?.ok) return;                    // no access / no seam here — stay hidden
  sec.classList.remove("hidden");
  renderCollabList(slug, res.collaborators || []);
  void primeCollabPicker(res.collaborators || []);
  wireCollabAdd(slug);
}

function renderCollabList(slug: string, rows: CollabRow[]): void {
  const list = document.getElementById("app-collab-list");
  if (!list) return;
  list.innerHTML = rows.length ? "" : `<div class="inline-empty" style="padding:6px 0;">Just you so far.</div>`;
  for (const c of rows) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);";
    row.innerHTML = `
      <div style="flex:1;min-width:0;">
        <div style="font-size:12.5px;color:var(--text-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escMkt(c.name || c.email)}</div>
        ${c.name ? `<div style="font-size:11px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escMkt(c.email)}</div>` : ""}
      </div>
      <select class="settings-input collab-role-sel" style="width:110px;margin:0;font-size:12px;">
        <option value="read"${c.role === "read" ? " selected" : ""}>Read</option>
        <option value="edit"${c.role === "edit" ? " selected" : ""}>Edit</option>
        <option value="admin"${c.role === "admin" ? " selected" : ""}>Admin</option>
      </select>
      <button type="button" class="ws-icon-btn collab-remove" title="Remove collaborator" aria-label="Remove collaborator">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>`;
    row.querySelector<HTMLSelectElement>(".collab-role-sel")!.addEventListener("change", (ev) => {
      const sel = ev.currentTarget as HTMLSelectElement;
      void window.glyphh.appCollaboratorSet?.(slug, c.userId, sel.value as CollabRole).then((r) => {
        if (!r?.ok) { collabError(r?.error || "Couldn't change the role."); sel.value = c.role; return; }
        collabError("");
        void loadCollabSection();
      });
    });
    row.querySelector(".collab-remove")!.addEventListener("click", () => {
      void (async () => {
        const ok = await confirmAction({
          title: `Remove ${c.name || c.email}?`,
          body: "They lose access to this app and its source. You can add them back any time.",
          confirmLabel: "Remove",
          danger: true,
        });
        if (!ok) return;
        const r = await window.glyphh.appCollaboratorRemove?.(slug, c.userId);
        if (!r?.ok) { collabError(r?.error || "Couldn't remove the collaborator."); return; }
        collabError("");
        void loadCollabSection();
      })();
    });
    list.appendChild(row);
  }
}

/** Fill the member picker with org members not already seated. */
async function primeCollabPicker(seated: CollabRow[]): Promise<void> {
  const sel = document.getElementById("app-collab-member") as HTMLSelectElement | null;
  if (!sel) return;
  sel.innerHTML = `<option value="">Loading members…</option>`;
  try {
    const { accountApi } = await import("./settings-api.js");
    const members = await accountApi().members();
    const taken = new Set(seated.map((c) => c.userId));
    const options = members.filter((m) => !taken.has(m.userId) && !m.disabled);
    sel.innerHTML = options.length
      ? `<option value="">Add a member…</option>` + options.map((m) =>
          `<option value="${escMkt(m.userId)}">${escMkt(m.name || m.email)}</option>`).join("")
      : `<option value="">Everyone in your org is already here</option>`;
  } catch {
    sel.innerHTML = `<option value="">Couldn't load members</option>`;
  }
}

function wireCollabAdd(slug: string): void {
  const btn = document.getElementById("app-collab-add") as HTMLButtonElement | null;
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = "1";
  btn.addEventListener("click", () => {
    const member = (document.getElementById("app-collab-member") as HTMLSelectElement | null)?.value || "";
    const role = ((document.getElementById("app-collab-role") as HTMLSelectElement | null)?.value || "edit") as CollabRole;
    if (!member) { collabError("Pick a member to add."); return; }
    const live = currentApp?.slug || slug;
    btn.disabled = true;
    void window.glyphh.appCollaboratorSet?.(live, member, role).then((r) => {
      btn.disabled = false;
      if (!r?.ok) { collabError(r?.error || "Couldn't add the collaborator."); return; }
      collabError("");
      void loadCollabSection();
    });
  });
}

// ── Installed-app release view: version + update availability ────
//
// An installer doesn't edit notes or promote — they see which version they have
// and whether a newer one is published. The auto-update toggle is per-app.

/** Lazy kebab imports (the lib-editor module is already loaded by the page). */
function kebabBits(): { kebabCell: typeof import("./lib-editor.js").kebabCell; ROW_MENU_ICONS: typeof import("./lib-editor.js").ROW_MENU_ICONS } {
  const m = kebabModule;
  if (!m) throw new Error("lib-editor not loaded");
  return m;
}
let kebabModule: { kebabCell: typeof import("./lib-editor.js").kebabCell; ROW_MENU_ICONS: typeof import("./lib-editor.js").ROW_MENU_ICONS } | null = null;
void import("./lib-editor.js").then((m) => { kebabModule = { kebabCell: m.kebabCell, ROW_MENU_ICONS: m.ROW_MENU_ICONS }; });

/** Delete is refused server-side while a live deployment exists — it would orphan
 *  the running Fly machine. So gate the Delete button on deploy state: clearly
 *  INACTIVE (with a why) until the app is taken down, instead of failing on click. */
async function gateAppDelete(slug: string): Promise<void> {
  // THE PURGE: hosting is gone — nothing blocks a delete any more.
  void slug;
  const btn = document.getElementById("app-detail-delete") as HTMLButtonElement | null;
  if (!btn) return;
  btn.disabled = false;
  btn.title = "";
  btn.classList.remove("delete-blocked");
}

async function loadConfigVarsTab() {
  // Never let unsaved plaintext linger in the entry fields across a tab switch
  // or app reopen — a value only ever exists here while actively being typed.
  const keyField = document.getElementById("config-var-key") as HTMLInputElement | null;
  const valueField = document.getElementById("config-var-value") as HTMLTextAreaElement | null;
  const readableField = document.getElementById("config-var-readable") as HTMLInputElement | null;
  if (keyField) keyField.value = "";
  if (valueField) valueField.value = "";
  if (readableField) readableField.checked = false;
  const listEl = document.getElementById("config-var-list");
  if (!listEl) return;
  const res = await window.glyphh.appSecretsList?.(currentAppId);
  listEl.innerHTML = "";
  if (!res?.ok) {
    listEl.innerHTML = `<div class="inline-empty">Couldn't load config vars.</div>`;
    return;
  }
  const secrets = res.secrets || [];
  // The manifest's DECLARED names lead the list: an unset declaration is the
  // one thing the user must act on, so it renders as a row, not a guess.
  const setKeys = new Set(secrets.map((sec) => sec.key));
  const missing = (currentApp?.secretNames ?? []).filter((k) => !setKeys.has(k));
  for (const k of missing) {
    const row = document.createElement("div");
    row.className = "config-var-row";
    row.innerHTML = `<span class="config-var-key" style="font-family:var(--font-mono);"></span>
      <span style="flex:1;font-size:12px;color:var(--warning);">required by the app — not set</span>
      <button class="action-btn" type="button" style="height:24px;font-size:11px;padding:0 10px;">Set…</button>`;
    (row.querySelector(".config-var-key") as HTMLElement).textContent = k;
    row.querySelector("button")?.addEventListener("click", () => {
      const kf = document.getElementById("config-var-key") as HTMLInputElement | null;
      if (kf) { kf.value = k; }
      (document.getElementById("config-var-value") as HTMLTextAreaElement | null)?.focus();
    });
    listEl.appendChild(row);
  }
  if (!secrets.length && !missing.length) {
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
        badge.style.cssText = "color:var(--success);border-color:color-mix(in srgb, var(--success) 40%, transparent);";
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
      const editKey = document.getElementById("config-var-key") as HTMLInputElement | null;
      const editReadable = document.getElementById("config-var-readable") as HTMLInputElement | null;
      if (editKey) editKey.value = s.key;
      if (editReadable) editReadable.checked = !!s.appReadable;
      // Write-only: the stored value can never be shown again, so editing wipes
      // the field — the user re-enters the value (and can flip app-readable) to save.
      const editValue = document.getElementById("config-var-value") as HTMLTextAreaElement | null;
      if (editValue) editValue.value = "";
      const statusEl = document.getElementById("config-var-status");
      if (statusEl) statusEl.textContent = `Editing ${s.key} — re-enter its value to save (values are write-only and can't be shown).`;
      editValue?.focus();
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
      await window.glyphh.appSecretsDelete?.(currentAppId, s.key);
      void loadConfigVarsTab();
    });
    row.append(keyEl, valEl, edit, del);
    listEl.appendChild(row);
  }
}

function wireConfigVarsForm() {
  const keyEl = document.getElementById("config-var-key") as HTMLInputElement | null;
  const valueEl = document.getElementById("config-var-value") as HTMLTextAreaElement | null;
  const readableEl = document.getElementById("config-var-readable") as HTMLInputElement | null;
  const errEl = document.getElementById("config-var-error");
  const statusEl = document.getElementById("config-var-status");
  if (!keyEl || !valueEl || !readableEl || !errEl || !statusEl) return;
  document.getElementById("config-var-add")?.addEventListener("click", async () => {
    errEl.classList.add("hidden");
    statusEl.textContent = "";
    const key = keyEl.value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    const value = valueEl.value;
    const res = await window.glyphh.appSecretsSet?.(currentAppId, key, value, readableEl.checked);
    if (!res?.ok) {
      errEl.textContent = res?.error || "Couldn't save";
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

// ── WEB preview (browser tab) ────────────────────────────
// Desktop previews through a privileged <webview>; a browser has none, so the
// web surface previews an app the way its other web panels work — an <iframe>
// of the app's public address (glyphh apps: their deployed <slug>.glyphh.app
// URL, which the web bridge maps into `url` from prodUrl; url apps: their
// configured http(s) URL) — with an honest card when nothing is framable yet.

/** The address the web preview can frame, or null (undeployed / non-http). */
function webPreviewUrl(app: PanelApp | null): string | null {
  const url = app?.url || null;
  return url && /^https?:\/\//i.test(url) ? url : null;
}

/** The dashboard tab's right pane — the slot the desktop webview lives in. */
function webPreviewHost(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".app-builder-preview .app-tab-right[data-tab='dashboard']");
}

/** Ensure the preview iframe exists in the slot and show `url` in it. */
function webPreviewNavigate(url: string): void {
  const host = webPreviewHost();
  if (!host) return;
  document.getElementById("app-preview-fallback")?.remove();
  let frame = document.getElementById("app-preview-frame") as HTMLIFrameElement | null;
  if (!frame) {
    frame = document.createElement("iframe");
    frame.id = "app-preview-frame";
    frame.className = "app-preview-frame";
    // Scripts + same-origin + forms is enough for a real app to run; no
    // top-navigation and no popups from inside the preview.
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
    // A hard load failure is detectable; a frame-ancestors refusal mostly is
    // not (the browser hides it from the embedder) — the toolbar's "Open in
    // new tab" stays as the honest escape hatch either way.
    frame.addEventListener("error", () => {
      webPreviewFallback("This site refused to load in the preview.", frame?.src || null);
    });
    host.appendChild(frame);
  }
  if (frame.src !== url) frame.src = url;
}

/** Show the no-preview card (replacing any iframe). */
function webPreviewFallback(message: string, openUrl: string | null): void {
  const host = webPreviewHost();
  if (!host) return;
  document.getElementById("app-preview-frame")?.remove();
  let card = document.getElementById("app-preview-fallback");
  if (!card) {
    card = document.createElement("div");
    card.id = "app-preview-fallback";
    card.className = "app-preview-fallback";
    host.appendChild(card);
  }
  card.innerHTML = `<div class="app-preview-fallback-card">
      <p>${escMkt(message)}</p>
      ${openUrl ? `<button type="button" class="action-btn app-preview-open-tab">Open in new tab</button>` : ""}
    </div>`;
  card.querySelector<HTMLButtonElement>(".app-preview-open-tab")?.addEventListener("click", () => {
    if (openUrl) window.open(openUrl, "_blank", "noopener");
  });
}

/** WEB: render the preview pane for `app` — iframe when framable, honest card
 *  when not. Idempotent; the desktop <webview> is CSS-hidden on web. */
function renderWebPreview(app: PanelApp): void {
  const url = webPreviewUrl(app);
  // NON-GLYPHH apps never frame on the web (his rule, 2026-08-25): external
  // sites mostly refuse framing and native rows have no web surface — the
  // themed card says so honestly instead of a blank or broken frame.
  if (app.appArchetype !== "glyphh-app") {
    webPreviewFallback(
      url
        ? "This app can't be viewed from the web. Open it in its own tab, or on the desktop app."
        : "This app can't be viewed from the web — it runs on the desktop app.",
      url,
    );
    return;
  }
  if (url) { webPreviewNavigate(url); return; }
  webPreviewFallback("This app isn't deployed yet. Deploy it from the Public hosting tab, then preview it here.", null);
}

let panelLoaded = false;

async function loadPanelTab() {
  const app = panelApps.find((a) => a.id === currentAppId);
  if (!app) return;

  // WEB: the desktop <webview> path below is inert in a browser — preview via
  // a sandboxed iframe of the app's public address instead. No machine IPC.
  if (IS_WEB) { renderWebPreview(app); return; }

  // Installed glyphh-apps have no url — their UI lives on disk at execPath
  // (~/.glyphh/custom-apps/<slug>/index.html). Mirror isGlyphhAppRow so native
  // terminal/editor apps (also execPath, no url) still fall through to "no url".
  const isGlyphhApp = app.appArchetype === "glyphh-app" || /\.html?$/i.test(app.execPath || "");

  if (!app.url && !isGlyphhApp) {
    // #app-commands-list was removed from the markup — guard, don't crash
    // (the old non-null assertion threw "Cannot set properties of null" and
    // took down Open App on web).
    const noUrlHost = document.getElementById("app-commands-list");
    if (noUrlHost) noUrlHost.innerHTML = `<div class="inline-empty">No URL configured for this app. Add one above to enable panel features.</div>`;
    return;
  }

  if (!panelLoaded) {
    if (isGlyphhApp) {
      // ONE RULE with Echo (his correction, 2026-08-25): the LOCAL bundle
      // wins. Previewing your own app should never take an internet round
      // trip and a members auth challenge; after a deploy the on-disk build
      // is the same bytes anyway. The hosted URL is the fallback for an app
      // whose source lives on someone else's machine.
      const wcId = await ensurePreviewWcId();
      // Register the preview guest so the app-data seam injects the bearer.
      if (wcId !== undefined) (window.glyphh as unknown as { rpaRegister?: (slug: string, wcId: number) => void }).rpaRegister?.(app.slug, wcId);
      const res = await window.glyphh.glyphhAppPreviewOpen(app.slug, wcId);
      // LOCAL BUILD ONLY (his law, 2026-09-01): the preview never loads the
      // published site — what you see is what's on disk, not what shipped.
      // No local build → say so honestly instead of silently showing prod.
      if (res?.ok && res.fileUrl) { appPreview.src = res.fileUrl; }
      else {
        const errHost = document.getElementById("app-commands-list");
        if (errHost) errHost.innerHTML = `<div class="inline-empty">${res?.error || "No local build to preview yet — build the app (update_app) and it appears here."}</div>`;
        return;
      }
    } else {
      // Web app: drop any glyphh grant left on the reused preview webContents.
      void window.glyphh.glyphhAppPreviewClear(getPreviewWebContentsId());
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
  // M7 consumer view: installed FROM the marketplace, not published here. The
  // developer hosts it, so the installer sees the store's tabs — exactly
  // About / Connections / Support — and none of the builder affordances.
  const mktInstalled = !owned;
  document.querySelectorAll<HTMLElement>(".tab-mkt-installed").forEach((el) => el.classList.toggle("hidden", !mktInstalled));
  document.querySelector(".app-detail-tab[data-tab='dashboard']")?.classList.toggle("hidden", mktInstalled);
  // Config Vars is NEED-driven (his order, 2026-08-25): shown when the
  // manifest declares secret names — for owners AND installers (an installed
  // app that declares OPENAI_API_KEY is exactly where the installer must set
  // it; values are per-org). No declaration → hidden, then un-hidden only if
  // vars already exist (the async check below).
  const declaresSecrets = (app.secretNames?.length ?? 0) > 0;
  const configTab = document.querySelector(".app-detail-tab[data-tab='config']");
  configTab?.classList.toggle("hidden", !declaresSecrets);
  if (!declaresSecrets && app.appArchetype === "glyphh-app") {
    void window.glyphh.appSecretsList?.(app.id).then((r) => {
      if (currentAppId === app.id && r?.ok && (r.secrets?.length ?? 0) > 0) configTab?.classList.remove("hidden");
    });
  }
  document.querySelectorAll<HTMLElement>(".tab-built-only").forEach((el) => {
    // The consumer view keeps Connections (the grants the app needs) and
    // drops Releases (the publisher's history, not the installer's).
    const show = mktInstalled ? el.dataset.tab === "connections" : isBuilt;
    el.classList.toggle("hidden", !show);
  });
  document.querySelectorAll<HTMLElement>(".tab-owner-only").forEach((el) => {
    el.classList.toggle("hidden", !(isBuilt && owned));
  });
  // The type control is retired: every NEW app is a web panel, and a built
  // app's type comes from its bundle either way.
  void isBuilt;
  document.getElementById("app-detail-type-row")?.classList.add("hidden");

  // Populate dashboard fields
  appDetailId.value = app.slug;
  appDetailName.value = app.name;
  appDetailUrl.value = app.url || "";
  const detailForce = document.getElementById("app-detail-force-web") as HTMLInputElement | null;
  if (detailForce) detailForce.checked = !!(app.launchConfig as { forceWeb?: boolean } | null)?.forceWeb;

  // Browser ↔ Native fields. Legacy apps have isBrowser undefined but always
  // carry a url, so they default to browser.
  const isBrowser = app.isBrowser !== undefined ? app.isBrowser : true;
  const detailType: AppType = isBrowser ? "browser" : "native";
  const typeSel = document.getElementById("app-detail-type") as HTMLSelectElement | null;
  if (typeSel) typeSel.value = detailType;
  const execEl = document.getElementById("app-detail-exec-path") as HTMLInputElement | null;
  if (execEl) execEl.value = app.execPath || "";
  const detailArchetype = (app.appArchetype as Archetype) || "generic";
  const archSel = document.getElementById("app-detail-archetype") as HTMLSelectElement | null;
  if (archSel) archSel.value = detailArchetype;
  writeLaunchConfig("app-detail", detailArchetype, app.launchConfig);
  // A GLYPHH app is BUILT, not launcher-configured (his rule, 2026-08-25): the
  // native exec-path/archetype block is the NATIVE launcher's, and an installed
  // glyphh app only rides those rails technically (entry html as execPath).
  // Its real "path" is the source of record — never show the native fields.
  const isGlyphhKind = app.appArchetype === "glyphh-app";
  document.querySelectorAll<HTMLElement>(".tab-glyphh-only").forEach((el) =>
    el.classList.toggle("hidden", !(isGlyphhKind && app.owned !== false)));
  toggleTypeFields("app-detail", isGlyphhKind ? "browser" : detailType);
  if (isGlyphhKind) document.getElementById("app-detail-browser-fields")?.classList.add("hidden");
  toggleArchetypeFields("app-detail", detailArchetype);

  // MCP + Guardrails tabs — installed apps that declare tools. The consumer
  // view doesn't carry them (its tabs are exactly About/Connections/Support);
  // the app's tools still reach the org's agents through the install.
  if (mktInstalled) document.querySelectorAll<HTMLElement>(".tab-mcp-only").forEach((el) => el.classList.add("hidden"));
  else syncMcpTabs(app);

  // Co-working seats (General tab) — async; hides itself when not applicable.
  void loadCollabSection();

  // Shared edit header: icon + name + slug, with the app's PUBLISHED address
  // (or an honest "Not Published") underneath (his order, 2026-09-01). The
  // hosting-status load refreshes it with the live deployment's URL.
  appDetailHeading.textContent = "";
  const headEl = document.getElementById("app-detail-head");
  if (headEl) headEl.innerHTML =
    `<div class="app-card-icon">${appIconInner(app, app.name, "app-card-initial")}</div>` +
    `<div class="edit-head-col">` +
      `<div class="edit-head-name">${escMkt(app.name)}<span class="edit-head-slug">${escMkt(app.slug)}</span></div>` +
      `<div id="app-detail-url" class="edit-head-url"></div>` +
    `</div>`;
  // THE PURGE: no hosted address — a glyphh app's UI lives on disk. Only a
  // plain web entry carries a visitable url in its header.
  const urlEl = document.getElementById("app-detail-url");
  if (urlEl) urlEl.textContent = app.appArchetype === "glyphh-app" ? "" : (app.url || "");

  // The Glyphh system app can't be deleted (server enforces it) — don't offer.
  document.getElementById("app-detail-delete")?.classList.toggle("hidden", app.slug === "glyphh");
  // The open action resets per app — a prior suspended marketplace app must
  // not leave the button dead for the next one opened.
  const openBtn = document.getElementById("app-detail-open") as HTMLButtonElement | null;
  if (openBtn) { openBtn.disabled = false; openBtn.textContent = "Open app"; openBtn.title = "Open this app as a panel"; }
  if (!mktInstalled) void gateAppDelete(app.slug);

  // All tabs always visible
  document.querySelectorAll<HTMLButtonElement>(".app-detail-tab").forEach(btn => {
    btn.classList.remove("tab-hidden");
  });

  // Show detail, hide grid
  appsList.classList.add("hidden");
  appsToolbar.classList.add("hidden");
  appAddForm.classList.add("hidden");
  appDetail.classList.remove("hidden");

  switchAppTab(mktInstalled ? "mkt-about" : "dashboard");
}

function getPreviewWebContentsId(): number | undefined {
  try { return appPreview.getWebContentsId(); } catch { return undefined; }
}

function closeAppDetail() {
  // Drop any glyphh capability grant on the reused preview webContents.
  void window.glyphh.glyphhAppPreviewClear?.(getPreviewWebContentsId());
  appPreview.src = "about:blank";
  // WEB preview cleanup — the iframe/fallback card are created per-app.
  document.getElementById("app-preview-frame")?.remove();
  document.getElementById("app-preview-fallback")?.remove();
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

  // Echo tile menu bridge: "Edit" on a command-center app tile opens the
  // Apps section straight onto that app's edit screen.
  (window as unknown as { __glyphhEditApp?: (idOrSlug: string) => void }).__glyphhEditApp = (idOrSlug: string) => {
    (window as unknown as { __wbOpenSection?: (s: string) => void }).__wbOpenSection?.("apps");
    void (async () => {
      try {
        const apps = (await window.glyphh.panelAppsList?.()) || [];
        const app = apps.find((a) => a.id === idOrSlug || a.slug === idOrSlug);
        if (app) await openPanelAppDetail(app as PanelApp);
      } catch (err) {
        console.error("[apps] edit-from-tile failed:", err);
      }
    })();
  };

  // Upgrade gates (App connections / MCP) open the platform to manage the plan,
  // the same way Settings → Account → Manage Account does.
  document.querySelectorAll<HTMLElement>(".tab-upgrade-btn").forEach((btn) => {
    btn.addEventListener("click", () => { void window.glyphh.execCommand(`dip ${window.glyphh.platformUrl}`); });
  });

  // Manual refresh + live refresh when the app library changes server-side
  // (e.g. an app installed over the MCP relay while this page is open).
  document.getElementById("apps-refresh-btn")?.addEventListener("click", () => { void loadApps(); });
  window.glyphh.onPanelAppsChanged?.(() => {
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
      // WEB: navigate the preview iframe instead of the (inert) webview.
      if (IS_WEB) { webPreviewNavigate(normalized); return; }
      if (appPreview && appPreview.src !== normalized) {
        appPreview.partition = "persist:yo";
        appPreview.src = normalized;
        panelLoaded = true;
      }
    }, 400);
  });

  // WEB preview toolbar: Refresh re-navigates the iframe, and "Open in new
  // tab" mirrors web appLaunch's tab fallback — a browser can't force a site
  // to allow framing, so the honest affordance is always on offer.
  if (IS_WEB) {
    const refreshBtn = document.getElementById("app-preview-refresh");
    refreshBtn?.addEventListener("click", () => {
      const frame = document.getElementById("app-preview-frame") as HTMLIFrameElement | null;
      if (frame?.src) { const u = frame.src; frame.src = u; }
      else if (currentApp) renderWebPreview(currentApp);
    });
    const openTab = document.createElement("button");
    openTab.id = "app-preview-open-tab";
    openTab.type = "button";
    openTab.className = "preview-action preview-action-visible";
    openTab.textContent = "Open in new tab";
    openTab.addEventListener("click", () => {
      const url = webPreviewUrl(currentApp);
      if (url) window.open(url, "_blank", "noopener");
    });
    refreshBtn?.insertAdjacentElement("beforebegin", openTab);
  }

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
  // Apps are WEB PANELS now — the add form has no type control at all.
  const addTypeSelect = document.getElementById("app-add-type") as HTMLSelectElement | null;
  const addArchetypeSelect = document.getElementById("app-add-archetype") as HTMLSelectElement;
  const addExecPath = document.getElementById("app-add-exec-path") as HTMLInputElement;

  // (The Marketplace storefront is its own left-rail section now — its search,
  // scope, sort, and refresh are wired by help/marketplace.ts.)

  document.getElementById("apps-add-btn")?.addEventListener("click", () => {
    addNameInput.value = "";
    addSlugInput.value = "";
    slugTouched = false;
    addUrlInput.value = "";
    // Every new app is a WEB PANEL.
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

  // Add-form archetype toggle + Browse… button (the type control is gone).
  addArchetypeSelect?.addEventListener("change", () => toggleArchetypeFields("app-add", addArchetypeSelect.value as Archetype));
  document.getElementById("app-add-exec-browse")?.addEventListener("click", async () => {
    const picked = await window.glyphh.pickExecutable?.();
    if (picked) addExecPath.value = picked;
  });

  // App add form save
  document.getElementById("app-add-save")?.addEventListener("click", async () => {
    let valid = true;
    const name = addNameInput.value.trim();
    const url = addUrlInput.value.trim();
    const slugInput = addSlugInput.value.trim();
    const addType = "browser" as AppType;   // apps ARE web panels
    const isBrowser = true;
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
    const existing = (await window.glyphh.panelAppsList?.()) || [];
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
      ? {
          name, slug: id, isBrowser: true, url, execPath: null,
          launchConfig: (document.getElementById("app-add-force-web") as HTMLInputElement | null)?.checked ? { forceWeb: true } : {},
        }
      : { name, slug: id, isBrowser: false, url: null, execPath, appArchetype: archetype, launchConfig: readLaunchConfig("app-add", archetype) };
    const created = await window.glyphh.panelAppsCreate?.(createInput);
    if (!created?.ok || !created.app) {
      appFormError.textContent = created?.error || "Failed to create app.";
      appFormError.classList.remove("hidden");
      return;
    }
    // Force-web / do-not-record are set from the app's detail screen now; new
    // apps already default to capture-off.
    appAddForm.classList.add("hidden");
    const apps = (await window.glyphh.panelAppsList?.()) || [];
    reloadPanelApps(apps.map(toPanelApp));
    const createdLocal = panelApps.find((a) => a.id === created.app!.id);
    if (createdLocal) openPanelAppDetail(createdLocal);
    else loadApps();
  });

  // App detail back button
  document.getElementById("app-detail-close")?.addEventListener("click", () => closeAppDetail());

  // App detail "Open app" — leaves settings: close the modal and open the app
  // as a WORKBENCH panel (web + glyphh apps). A native executable can't run
  // in a panel — it keeps the OS launch, closing the modal only on success so
  // a launch error stays visible inline.
  document.getElementById("app-detail-open")?.addEventListener("click", async () => {
    const app = panelApps.find((a) => a.id === currentAppId);
    if (!app) return;
    const glyphh = app.appArchetype === "glyphh-app";
    if (app.url || glyphh) {
      closeSettingsModal();
      // A marketplace-installed app is a chromeless panel to the installer.
      openAppInWorkbench({ slug: app.slug, name: app.name, url: app.url, glyphh: glyphh || undefined, workbench: (glyphh && app.owned === false) || undefined });
      return;
    }
    const r = await launchPanelApp(app);
    if (!r?.ok && r?.error) { appFormError.textContent = r.error; appFormError.classList.remove("hidden"); return; }
    closeSettingsModal();
  });

  // App add form cancel
  document.getElementById("app-add-cancel")?.addEventListener("click", () => { loadApps(); });
  document.getElementById("app-add-cancel-btn")?.addEventListener("click", () => { loadApps(); });

  // Tab buttons — [data-tab] only: other editors (Roles) share the tab
  // CLASS but key their own data attributes.
  document.querySelectorAll<HTMLButtonElement>(".app-detail-tab[data-tab]").forEach(btn => {
    btn.addEventListener("click", () => switchAppTab(btn.dataset.tab!));
  });

  // Config Vars tab: add-form wiring (list loads on tab switch).
  wireConfigVarsForm();

  // Detail-form Browser ↔ Native + archetype toggles + Browse… button.
  const detailTypeSelect = document.getElementById("app-detail-type") as HTMLSelectElement;
  const detailArchetypeSelect = document.getElementById("app-detail-archetype") as HTMLSelectElement;
  const detailExecPath = document.getElementById("app-detail-exec-path") as HTMLInputElement;
  detailTypeSelect?.addEventListener("change", () => {
    toggleTypeFields("app-detail", detailTypeSelect.value as AppType);
  });
  detailArchetypeSelect?.addEventListener("change", () => toggleArchetypeFields("app-detail", detailArchetypeSelect.value as Archetype));
  document.getElementById("app-detail-exec-browse")?.addEventListener("click", async () => {
    const picked = await window.glyphh.pickExecutable?.();
    if (picked) detailExecPath.value = picked;
  });

  // Dashboard save
  document.getElementById("app-dash-save")?.addEventListener("click", async () => {
    if (!currentAppId) return;
    const newSlug = appDetailId.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    const type = (detailTypeSelect?.value || "browser") as AppType;
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
      patch.launchConfig = (document.getElementById("app-detail-force-web") as HTMLInputElement | null)?.checked ? { forceWeb: true } : {};
      patch.execPath = null;
    } else {
      patch.url = null;
      patch.execPath = detailExecPath?.value.trim() ?? "";
      const archetype = (detailArchetypeSelect?.value || "generic") as Archetype;
      patch.appArchetype = archetype;
      patch.launchConfig = readLaunchConfig("app-detail", archetype);
    }
    const saved = await window.glyphh.panelAppsUpdate?.(currentAppId, patch);
    if (!saved?.ok) {
      appFormError.textContent = saved?.error || "Failed to save app.";
      appFormError.classList.remove("hidden");
      return;
    }

    closeAppDetail();
  });

  // Dashboard cancel
  document.getElementById("app-dash-cancel")?.addEventListener("click", () => closeAppDetail());

  // Delete
  document.getElementById("app-detail-delete")?.addEventListener("click", async () => {
    if (!currentAppId) return;
    const confirmed = await confirmAction({
      title: `Delete “${appDetailName.value}”?`,
      body: "The app leaves your library — connected accounts stay intact.",
      confirmLabel: "Delete app",
      danger: true,
    });
    if (!confirmed) return;
    const res = await window.glyphh.panelAppsDelete?.(currentAppId);
    if (res && res.ok === false) {
      // Almost always the live-deployment guard. Tell the user instead of silently
      // closing as if it worked, and re-sync the gate.
      await confirmAction({
        title: "Couldn't delete this app",
        body: res.error || "Take the app down first (Hosting tab → Take down), then delete.",
        confirmLabel: "OK",
      });
      if (currentApp?.slug) void gateAppDelete(currentApp.slug);
      return;
    }
    closeAppDetail();
  });

  // Duplicate as a template (his order, 2026-09-02): new private app whose
  // version history starts from this app's latest snapshot. One-app-plus-
  // updates stays the sanctioned model; this is the deliberate-fork door.
  document.getElementById("app-detail-clone")?.addEventListener("click", async () => {
    const srcSlug = currentApp?.slug;
    if (!srcSlug) return;
    const { formModal } = await import("./settings-list-page.js");
    await formModal({
      title: `Duplicate ${appDetailName.value || srcSlug}`,
      fields: [
        { key: "slug", label: "New slug", placeholder: `${srcSlug}-v2`, required: true,
          validate: (v) => (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v.trim().toLowerCase()) ? null : "Kebab-case: letters, numbers, hyphens.") },
        { key: "name", label: "Name", placeholder: `${appDetailName.value || srcSlug} copy` },
      ],
      submitLabel: "Duplicate",
      onSubmit: async (values) => {
        const r = await window.glyphh.appClone?.(srcSlug, {
          slug: values.slug!.trim().toLowerCase(),
          ...(values.name?.trim() ? { name: values.name.trim() } : {}),
        });
        if (!r?.ok) return { ok: false as const, error: r?.error || "Couldn't duplicate the app." };
        closeAppDetail();
        void loadApps();
        return { ok: true as const };
      },
    });
  });

  // Export the current app as a .glyphh bundle (main shows the save dialog).
  document.getElementById("app-detail-export")?.addEventListener("click", async () => {
    if (!currentAppId) return;
    const btn = document.getElementById("app-detail-export") as HTMLButtonElement;
    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Exporting…";
    try {
      const res = await window.glyphh.appExport(currentAppId);
      btn.textContent = res?.ok ? "Exported ✓" : (res?.error === "Canceled" ? prev : "Export failed");
    } catch {
      btn.textContent = "Export failed";
    } finally {
      setTimeout(() => { btn.disabled = false; btn.textContent = prev; }, 1800);
    }
  });


  // Draggable split divider. Pointer CAPTURE, not document mouse listeners:
  // the preview pane is a webview, and a webview swallows mouse events — the
  // old document-level mouseup never fired over it, so the handle stuck to
  // the cursor until the next click on host chrome.
  //
  // The controls lookup is SCOPED to this divider's own split: the Layouts and
  // Connections editors reuse `.app-builder-controls`, and layouts.html sits
  // EARLIER in the assembled document (the settings-modal adoption also moves
  // whole sections around the DOM), so a bare
  // `document.querySelector(".app-builder-controls")` resolved to a DIFFERENT
  // editor's hidden column — every drag wrote its width and this pane never
  // moved. (Below the 1140px collapse breakpoint the divider is display:none
  // and the stacked columns are width:auto !important — dragging is off there
  // by design.)
  const divider = document.getElementById("app-builder-divider")!;
  const split = divider.closest<HTMLElement>(".app-builder-split")!;
  const controls = split.querySelector<HTMLElement>(":scope > .app-builder-controls")!;
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
    // Clamp against the split's LIVE width — inside the settings modal the
    // split is much narrower than the old full page, so a fixed 800px max
    // could shove the preview pane out of the modal. The preview always keeps
    // at least 260px.
    const max = Math.min(800, split.clientWidth - 260);
    const w = Math.max(200, Math.min(max, startW + (e.clientX - startX)));
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
