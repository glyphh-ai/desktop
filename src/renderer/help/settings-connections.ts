/**
 * settings-connections.ts — CONNECTIONS in the Skills page's grammar (his
 * order, 2026-09-16: "exact same layout" as Skills).
 *
 *   Your connections   a table: connector · type · status, filtered by
 *                      All / Connected / Not connected; search and + Add
 *   Pipedream          the project setup, then the app directory
 *   Detail             a compact header, the server's fields, and the tool
 *                      permissions (Always allow / Needs approval / Never)
 *
 * Two kinds of connection share the table:
 *
 *   MCP        a custom MCP server of the member's own, held in the local
 *              store (main/mcp-connections.ts): + Add takes a remote server by
 *              URL, and "connected" means the server is turned on.
 *   Pipedream  an app connected through the member's OWN Pipedream project
 *              (main/pipedream.ts). Its own tab sets the project up, then
 *              becomes the directory: search, a category filter, the
 *              featured apps first, and Connect, which finishes in
 *              a modal over this page.
 */

import { escapeHtml, confirmAction, loadingHtml } from "./shared.js";
import { onConnectionsChanged } from "./connections.js";
import { toastError, toastOk } from "./toast.js";
import { appIconInner } from "./app-icon.js";
import { hostHas } from "./web-surface.js";
import { closePipedreamConnectModal, openPipedreamConnectModal } from "./pipedream-connect-modal.js";
import { connectProgressText, mergeApps, pdAppRows, projectIdProblem, type PdAppRow, type PdProgressLike } from "./pipedream-view.js";

type McpConn = Awaited<ReturnType<typeof window.glyphh.mcpConnectionsList>>["connections"][number];
type PdView = Extract<Awaited<ReturnType<typeof window.glyphh.pipedreamConfigGet>>, { ok: true }>["data"];
type PdApp = Extract<Awaited<ReturnType<typeof window.glyphh.pipedreamApps>>, { ok: true }>["data"]["apps"][number];
type PdCategory = { id: string; name: string };

/** One row of Your connections. */
interface Entry {
  key: string;
  kind: "mcp" | "pd";
  name: string;
  desc: string;
  /** A server or an app is connected while it is turned on. */
  connected: boolean;
  iconUrl: string | null;
  mcp?: McpConn;
  pd?: PdAppRow;
}

const el = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

function fail(msg: string): void {
  if (msg) toastError(msg);
}

let entries: Entry[] = [];
let stateFilter: "all" | "connected" | "not" = "all";
let query = "";
/** Which tab the list view shows: your connections, or the Pipedream setup and directory. */
let tab: "mine" | "pd" = "mine";
/** The server whose permissions are on screen. */
let current: Entry | null = null;
let wired = false;

const entryOf = (m: McpConn): Entry => ({
  key: `mcp:${m.slug}`,
  kind: "mcp",
  name: m.name,
  desc: m.url || "Custom MCP server",
  connected: m.enabled,
  iconUrl: m.iconUrl,
  mcp: m,
});
const pdEntryOf = (r: PdAppRow): Entry => ({
  key: `pd:${r.app}`,
  kind: "pd",
  name: r.name,
  desc: r.app,
  connected: r.enabled,
  iconUrl: r.icon,
  pd: r,
});

/** Pipedream is this machine's (main/pipedream.ts): a host that does not
 *  serve it (the web) never shows the card, so no Pipedream door is called. */
const pdHosted = (): boolean => hostHas("pipedreamConfigGet");
/** The Pipedream project as the page knows it: null until first read, and
 *  on a host without Pipedream. */
let pd: PdView | null = null;
/** The setup form is open over a configured project (Edit). */
let pdEditing = false;
/** Pipedream's account list is read from the network once per visit; the
 *  cache answers the rest. */
let pdRefreshed = false;

// ── loading ─────────────────────────────────────────────────────────────────
/** A server to open as soon as the page loads, on its permissions — the door
 *  a refused unattended call offers ("not set to Always allow"). Consumed by
 *  the page's own load ONLY, never by a quiet re-read (his report,
 *  2026-10-07: a stale one hijacked a later load). */
let pendingApp: { app: string } | null = null;
export function openConnectionOnLoad(appSlug: string): void { pendingApp = { app: String(appSlug || "") }; }

/** THE CUSTOMIZE PAGE'S ONE SCOPE (his report, 2026-10-07: "instead of each
 *  tab having a different Yours / Discover it should span all the tabs"):
 *  the page hands its scope down before this tab loads. The app directory
 *  lives on the Pipedream tab, so the only scope is Yours, and arriving on it lands on the list rather than on whatever
 *  connection was open last. */
export function setConnectionsScope(_scope: "mine"): void {
  current = null;
}

/** Is the Connections tab on screen? A quiet re-read never repaints a page
 *  the member moved off. */
const pageShowing = (): boolean => {
  const panel = document.querySelector<HTMLElement>(`.settings-panel[data-sub="connections-cfg"]`);
  return !!panel && panel.getClientRects().length > 0;
};

export async function loadSettingsConnections(): Promise<void> {
  const body = el("conn2-body");
  if (!body) return;
  wire();
  current = null;
  el("conn2-detail-view")?.classList.add("hidden");
  el("conn2-list-view")?.classList.remove("hidden");
  await loadLists();
  // A deep link lands on the connection's permissions, where the toggles are.
  if (pendingApp) {
    const want = pendingApp.app.toLowerCase();
    pendingApp = null;
    const hit = entries.find((e) => (e.mcp?.slug ?? e.pd?.app ?? "").toLowerCase() === want || e.key.toLowerCase() === want);
    if (hit) void openDetail(hit);
  }
  // Accounts connected or removed on pipedream.com since the last read.
  if (pd?.configured && !pdRefreshed) {
    pdRefreshed = true;
    void window.glyphh.pipedreamAccounts(true).then((r) => { if (r.ok && pageShowing() && !current) void loadLists(); }).catch(() => undefined);
  }
}

/** Re-read the servers and repaint the list view — the page's load and every
 *  quiet re-read share this; neither view is switched here. */
async function loadLists(): Promise<void> {
  const body = el("conn2-body");
  if (!body) return;
  if (!entries.length) body.innerHTML = loadingHtml("Loading your connections…");
  const [res, cfg, accounts] = await Promise.all([
    window.glyphh.mcpConnectionsList().catch((err: unknown) => {
      fail(err instanceof Error ? err.message : String(err));
      return { ok: false, connections: [] as McpConn[] };
    }),
    pdHosted() ? window.glyphh.pipedreamConfigGet().catch(() => null) : null,
    pdHosted() ? window.glyphh.pipedreamAccounts().catch(() => null) : null,
  ]);
  pd = cfg?.ok ? cfg.data : null;
  const pdRows = accounts?.ok ? pdAppRows(accounts.data) : [];
  entries = [...(res.connections ?? []).map(entryOf), ...pdRows.map(pdEntryOf)].sort((a, b) => a.name.localeCompare(b.name));
  render();
}

// ── the list ────────────────────────────────────────────────────────────────
const CHECK = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7"/></svg>`;

const PLUS = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`;

function iconFor(name: string, iconUrl: string | null | undefined, cls = "conn2-icon"): string {
  if (iconUrl) return `<span class="${cls}"><img src="${escapeHtml(iconUrl)}" alt="" /></span>`;
  return `<span class="${cls}"><span class="conn2-icon-initial">${escapeHtml((name || "?").charAt(0).toUpperCase())}</span></span>`;
}
/** A directory app's logo: Pipedream's art, else the house monogram. */
function iconForApp(a: { slug: string; name: string; icon: string | null }, cls = "conn2-icon"): string {
  return `<span class="${cls}">${appIconInner({ iconUrl: a.icon, slug: a.slug }, a.name, "conn2-icon-initial")}</span>`;
}

/** One table row: icon, name, type, then the status cell the caller fills. */
function tableRow(name: string, iconUrl: string | null | undefined, type = "MCP"): { tr: HTMLElement; status: HTMLElement } {
  const tr = document.createElement("div");
  tr.className = "conn2-tr";
  tr.innerHTML = `${iconFor(name, iconUrl)}<span class="conn2-name"></span><span class="conn2-type"><span></span></span><span class="conn2-status"></span>`;
  (tr.querySelector(".conn2-type > span") as HTMLElement).textContent = type;
  (tr.querySelector(".conn2-name") as HTMLElement).textContent = name;
  return { tr, status: tr.querySelector(".conn2-status") as HTMLElement };
}

function tableHead(): HTMLElement {
  const table = document.createElement("div");
  table.className = "conn2-table";
  table.innerHTML = `<div class="conn2-tr head"><span class="conn2-head-connector">Connector</span><span>Type</span><span class="conn2-head-status">Status</span></div>`;
  return table;
}

/** The tab bar: the active tab lit; search and + Add belong to Your connections
 *  (the Pipedream tab has its own app search). */
function paintTabs(): void {
  document.querySelectorAll<HTMLElement>("[data-conn-tab]").forEach((b) => b.classList.toggle("active", b.dataset.connTab === tab));
  el("conn2-search")?.closest(".skills-search")?.classList.toggle("hidden", tab !== "mine");
  el("conn2-add")?.classList.toggle("hidden", tab !== "mine");
}

function render(): void {
  const host = el("conn2-body");
  if (!host) return;
  noteDirSearchFocus();
  host.textContent = "";
  paintTabs();
  const count = el("conn2-count"); if (count) count.textContent = tab === "mine" ? `${entries.length} connection${entries.length === 1 ? "" : "s"}` : "";
  if (tab === "pd") {
    const pdHost = document.createElement("div");
    pdHost.id = "conn2-pd";
    host.appendChild(pdHost);
    renderPd();
    if (!pd) host.insertAdjacentHTML("beforeend", `<div class="crud-empty">Pipedream isn't available here.</div>`);
    return;
  }

  const q = query.trim().toLowerCase();
  const shown = entries
    .filter((e) => !q || `${e.name} ${e.desc}`.toLowerCase().includes(q))
    .filter((e) => stateFilter === "all" || (stateFilter === "connected" ? e.connected : !e.connected));

  const chips = document.createElement("div");
  chips.className = "conn2-chips";
  for (const [id, label] of [["all", "All"], ["connected", "Connected"], ["not", "Not connected"]] as const) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "conn2-chip" + (stateFilter === id ? " active" : "");
    b.textContent = label;
    b.addEventListener("click", () => { stateFilter = id; render(); });
    chips.appendChild(b);
  }
  host.appendChild(chips);

  if (!shown.length) {
    host.insertAdjacentHTML("beforeend", `<div class="crud-empty">${q ? `No connections matching "${escapeHtml(q)}"` : stateFilter === "not" ? "Everything is connected." : pd?.configured ? "No connections yet — connect an app on the Pipedream tab, or + Add an MCP server of your own." : "No connections yet — + Add an MCP server of your own, or set up Pipedream on its tab."}</div>`);
    return;
  }
  const table = tableHead();
  for (const e of shown) {
    const { tr, status } = tableRow(e.name, e.iconUrl, e.kind === "pd" ? "Pipedream" : "MCP");
    tr.classList.add("openable");
    if (e.connected) status.innerHTML = `<span class="conn2-check">${CHECK}</span>`;
    else status.appendChild(enableButton(e));
    tr.addEventListener("click", () => void openDetail(e));
    table.appendChild(tr);
  }
  host.appendChild(table);
}

/** A turned-off server's one action: turn it back on. */
function enableButton(e: Entry): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "action-btn conn2-connect";
  b.textContent = "Enable";
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    b.disabled = true;
    void setEnabled(e, true).then((ok) => { if (!ok) b.disabled = false; });
  });
  return b;
}

/** Turn a server or an app on or off, then re-read. */
async function setEnabled(e: Entry, on: boolean): Promise<boolean> {
  const r = await (e.pd
    ? window.glyphh.pipedreamAppEnable(e.pd.app, on).then((x) => (x.ok ? { ok: true as const } : { ok: false as const, error: x.error }))
    : window.glyphh.mcpConnectionsUpdate(e.mcp!.slug, { enabled: on }))
    .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  if (!r.ok) { fail(r.error || `Couldn't turn ${e.name} ${on ? "on" : "off"}.`); return false; }
  await reloadKeepingDetail(e);
  return true;
}

/** Re-read the servers; when `e`'s page is open, repaint it from the fresh
 *  row in place (its name, status and tools follow the change). */
async function reloadKeepingDetail(e: Entry): Promise<void> {
  await loadLists();
  if (current?.key !== e.key) return;
  const fresh = entries.find((x) => x.key === e.key);
  if (fresh) await openDetail(fresh, true);
}

/**
 * ONE CONNECTION TABLE (his order, 2026-09-17).
 *
 * A bundle's Connections tab draws its declared connections with the same
 * table as the Connections page, so the two surfaces cannot drift.
 *
 * `deps` are what a manifest declares, each by slug. One is connected when a
 * custom MCP server with that slug, or a Pipedream app of that slug, exists
 * and is turned on; otherwise the row says so, and adding it on the
 * Connections page connects it.
 */
export interface ConnDep { app: string; as?: string }

/** A manifest carries either `["gmail"]` or `[{ app: "gmail", as: "member" }]`.
 *  Reading both is the RENDERER's job here: nothing in src/renderer may import
 *  src/shared — one such import moves tsc's inferred rootDir and every
 *  renderer file emits to a directory the app never loads (2026-09-17). A
 *  local server has one owner, so `as` is accepted and not carried. */
export const connDeps = (raw: ReadonlyArray<ConnDep | string> | undefined | null): ConnDep[] =>
  (raw ?? [])
    .map((d) => (typeof d === "string" ? { app: d } : d))
    .filter((d): d is ConnDep => !!d && typeof d.app === "string" && !!d.app.trim())
    .map((d) => ({ app: d.app.trim().toLowerCase() }));

export async function renderConnectionTable(host: HTMLElement, raw: ReadonlyArray<ConnDep | string>): Promise<void> {
  const deps = connDeps(raw);
  host.textContent = "";
  if (!deps.length) return;
  // THE LOADING LINE THE PAGE ITSELF USES (his order, 2026-09-17), so the pane
  // never sits blank while the servers come back.
  host.innerHTML = loadingHtml("Loading connections…");
  const [res, accounts] = await Promise.all([
    window.glyphh.mcpConnectionsList().catch(() => ({ ok: false, connections: [] as McpConn[] })),
    pdHosted() ? window.glyphh.pipedreamAccounts().catch(() => null) : null,
  ]);
  const have = new Map((res.connections ?? []).map((m) => [m.slug.toLowerCase(), { name: m.name, iconUrl: m.iconUrl, enabled: m.enabled, type: "MCP" }]));
  for (const r of accounts?.ok ? pdAppRows(accounts.data) : []) {
    if (!have.has(r.app)) have.set(r.app, { name: r.name, iconUrl: r.icon, enabled: r.enabled, type: "Pipedream" });
  }
  const pretty = (slug: string): string => slug.replace(/[_-]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());

  host.textContent = "";
  const table = tableHead();
  for (const dep of deps) {
    const m = have.get(dep.app);
    const { tr, status } = tableRow(m?.name || pretty(dep.app), m?.iconUrl, m?.type);
    if (m?.enabled) status.innerHTML = `<span class="conn2-check">${CHECK}</span>`;
    else status.innerHTML = `<span class="conn2-muted">${m ? "Turned off" : "Not connected"}</span>`;
    table.appendChild(tr);
  }
  host.appendChild(table);
}

// ── tools: names people can read, split by what they do ─────────────────────
const READ_VERBS = /^(get|list|search|find|read|fetch|retrieve|query|describe|count|check|lookup|view|show|download|export|preview|watch|summarize|detect)\b/i;
/** The tool's own name, as words: a server often prefixes its tool names with
 *  its own name, so everything up to the last run of the server's tokens is
 *  dropped. "linear-mcp_linear_mcp_create_issue" → "Create issue". The raw
 *  name rides the tooltip. Mirrors main's humanizeTool (conn-tool-modes.ts),
 *  which decides the default each mode starts from. */
function humanize(name: string, app?: string): string {
  const tokens = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const appTokens = (app || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let rest = tokens;
  if (appTokens.length) {
    let cut = -1;
    for (let i = 0; i + appTokens.length < tokens.length; i++) {
      if (appTokens.every((t, j) => tokens[i + j] === t)) cut = i + appTokens.length;
    }
    if (cut > 0) rest = tokens.slice(cut);
  }
  const words = rest.length ? rest : tokens;
  const out = words.join(" ");
  return out ? out.charAt(0).toUpperCase() + out.slice(1) : name;
}
const isReadTool = (name: string, app?: string): boolean => READ_VERBS.test(humanize(name, app));
type ToolMode = "allow" | "ask" | "never";
const MODE_LABEL: Record<ToolMode, string> = { allow: "Always allow", ask: "Needs approval", never: "Never" };
const MODE_ICON: Record<ToolMode, string> = {
  allow: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>`,
  ask: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V6a2 2 0 1 1 4 0v6M12 7a2 2 0 1 1 4 0v6M16 9a2 2 0 1 1 4 0v5a7 7 0 0 1-7 7h-1a7 7 0 0 1-6-3.4L3.4 13a2 2 0 0 1 3.4-2L8 13"/></svg>`,
  never: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="m6 6 12 12"/></svg>`,
};
/** Modes other than Never are the member's preference, per connection (local prefs). */
async function readModes(key: string): Promise<Record<string, ToolMode>> {
  const raw = await window.glyphh.getPreference?.(`connToolModes:${key}`, {}).catch(() => ({}));
  return raw && typeof raw === "object" ? (raw as Record<string, ToolMode>) : {};
}

// ── detail ──────────────────────────────────────────────────────────────────
/** THE PERMISSIONS PAGE (his screens, 2026-09-16): a compact header, the
 *  server's fields, then the tools in two groups, Read-only and Write/delete,
 *  each with a group mode and a three-way switch per tool: Always allow,
 *  Needs approval, Never. Never = hidden from every agent (the server's
 *  hidden list); the other two are the member's preference per connection.
 *  `quiet` repaints in place (after a switch) without flipping the views. */
async function openDetail(e: Entry, quiet = false): Promise<void> {
  current = e;
  const host = el("conn2-detail");
  if (!host) return;
  if (!quiet) {
    el("conn2-list-view")?.classList.add("hidden");
    el("conn2-detail-view")?.classList.remove("hidden");
  }
  host.textContent = "";

  const head = document.createElement("div");
  head.className = "conn2-phead";
  head.innerHTML = `${iconFor(e.name, e.iconUrl)}<span class="conn2-phead-name"></span><div style="flex:1"></div><div class="conn2-hero-actions"></div>`;
  (head.querySelector(".conn2-phead-name") as HTMLElement).textContent = e.name;
  const actions = head.querySelector(".conn2-hero-actions") as HTMLElement;
  if (e.connected) actions.insertAdjacentHTML("beforeend", `<span class="conn2-connected">${CHECK}<span>Connected</span></span>`);
  else { const b = enableButton(e); b.classList.add("primary"); actions.appendChild(b); }
  const del = document.createElement("button");
  del.type = "button";
  del.className = "action-btn";
  del.textContent = e.pd ? "Disconnect" : "Delete";
  del.addEventListener("click", () => void removeEntry(e));
  actions.appendChild(del);
  const kebab = document.createElement("button");
  kebab.type = "button";
  kebab.className = "skills-kebab";
  kebab.title = "More";
  kebab.textContent = "⋮";
  const url = e.mcp?.url ?? "";
  kebab.addEventListener("click", () => openMenu(kebab, [
    ...(url ? [{ label: "Copy server URL", onClick: () => { void navigator.clipboard?.writeText(url); } }] : []),
    { label: e.connected ? "Turn off" : "Turn on", onClick: () => { void setEnabled(e, !e.connected); } },
  ]));
  actions.appendChild(kebab);
  host.appendChild(head);

  const about = document.createElement("p");
  about.className = "conn2-about";
  about.textContent = e.pd
    ? (!e.connected
      ? "This app is turned off: your agents see none of its tools until you turn it back on."
      : e.pd.healthy
        ? `Connected through your Pipedream project${e.pd.accounts.length > 1 ? ` (${e.pd.accounts.length} accounts)` : ""}. Every agent reaches its tools; each call uses Pipedream credits.`
        : "Pipedream reports this account as unhealthy — disconnect it and connect again from the directory.")
    : e.connected
      ? "A custom MCP server your agents reach through the local Glyphh MCP server."
      : "This server is turned off: your agents see none of its tools until you turn it back on.";
  host.appendChild(about);

  if (e.mcp) host.appendChild(customFields(e));

  const title = document.createElement("div");
  title.className = "conn2-h3";
  title.textContent = "Tool permissions";
  host.appendChild(title);
  const sub = document.createElement("div");
  sub.className = "conn2-muted";
  sub.style.marginBottom = "10px";
  sub.textContent = "Choose when your AI is allowed to use these tools.";
  host.appendChild(sub);

  const groupsHost = document.createElement("div");
  groupsHost.className = "conn2-groups";
  groupsHost.innerHTML = `<div class="conn2-chip-muted">Loading tools…</div>`;
  host.appendChild(groupsHost);

  const res = await toolsOf(e);
  if (current?.key !== e.key) return;   // the member opened another meanwhile
  if (!res.ok) {
    groupsHost.innerHTML = `<div class="conn2-chip-muted">Couldn't reach the ${e.pd ? "app" : "server"}.</div>`;
    fail(res.error || "Couldn't load the tools.");
    return;
  }
  if (!res.tools.length) { groupsHost.innerHTML = `<div class="conn2-chip-muted">This ${e.pd ? "app" : "server"} publishes no tools yet.</div>`; return; }

  const mcp = e.mcp;
  await renderToolGroups(groupsHost, {
    key: e.key, appName: mcp?.slug ?? e.pd?.app ?? e.name, tools: res.tools,
    // A custom server also keeps Never as its own hidden list; a Pipedream
    // app's Never lives in the modes alone.
    ...(mcp ? {
      persistHidden: async (list: string[]) => {
        const r = await window.glyphh.mcpConnectionsUpdate(mcp.slug, { hiddenTools: list });
        if (!r.ok) throw new Error(r.error || "Couldn't save the tool list.");
      },
    } : {}),
  });
}

/** A connection's tools, from its own server. */
async function toolsOf(e: Entry): Promise<{ ok: boolean; error?: string; tools: Array<{ name: string; description: string; hidden?: boolean }> }> {
  const err = (x: unknown) => ({ ok: false, error: x instanceof Error ? x.message : String(x), tools: [] });
  if (e.pd) {
    const r = await window.glyphh.pipedreamTools(e.pd.app).catch(err);
    return "data" in r ? { ok: true, tools: r.data } : { ok: false, error: r.error, tools: [] };
  }
  return window.glyphh.mcpConnectionsTools(e.mcp!.slug).catch(err);
}

/** ONE tool-permissions grammar for everything that publishes tools (his
 *  order, 2026-09-16): connections, custom MCP servers, and installed apps.
 *  Read-only vs write/delete groups, Always allow / Needs approval / Never per
 *  tool or per group. Modes persist as a preference under `key`; "Never" is
 *  the hidden list the caller stores wherever its tools live. */
export interface ToolPermissionsOpts {
  key: string;
  appName: string;
  tools: Array<{ name: string; description?: string; hidden?: boolean }>;
  readOnly?: boolean;
  /** Where Never is also kept as a hidden list; absent, the modes alone hold it. */
  persistHidden?: (hidden: string[]) => Promise<unknown>;
}

export async function renderToolGroups(groupsHost: HTMLElement, o: ToolPermissionsOpts): Promise<void> {
  const { tools, appName } = o;
  const readOnly = !!o.readOnly;
  const hidden = new Set(tools.filter((t) => t.hidden).map((t) => t.name));
  const prefs = await readModes(o.key);
  // THE RULE COMES FROM MAIN (conn-tool-modes.ts): this page used to apply its
  // own default — read-only means allowed — and never write it down, so an
  // unattended run was refused a tool shown here as Always allow.
  const eff = await window.glyphh.connToolModes?.(o.key, tools.map((t) => t.name)).catch(() => null);
  const defaults = eff?.ok ? eff.data ?? {} : {};
  const modeOf = (t: { name: string }): ToolMode => hidden.has(t.name) ? "never" : (prefs[t.name] ?? defaults[t.name] ?? "ask");
  const persist = async (): Promise<void> => {
    try {
      await o.persistHidden?.(Array.from(hidden));
      window.glyphh.setPreference?.(`connToolModes:${o.key}`, prefs);
    } catch (err) { fail(err instanceof Error ? err.message : String(err)); }
  };
  const setMode = (t: { name: string }, m: ToolMode): void => {
    if (m === "never") { hidden.add(t.name); prefs[t.name] = "never"; }
    else { hidden.delete(t.name); prefs[t.name] = m; }
  };

  groupsHost.textContent = "";
  const groups: Array<{ label: string; items: typeof tools }> = [
    { label: "Read-only tools", items: tools.filter((t) => isReadTool(t.name, appName)) },
    { label: "Write/delete tools", items: tools.filter((t) => !isReadTool(t.name, appName)) },
  ].filter((g) => g.items.length);
  for (const g of groups) {
    const sec = document.createElement("div");
    sec.className = "conn2-group open";
    sec.innerHTML = `<div class="conn2-group-head"><svg class="conn2-group-chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg><span class="conn2-group-label"></span><span class="conn2-group-count"></span><div style="flex:1"></div><button type="button" class="conn2-mode-btn"></button></div><div class="conn2-group-body"></div>`;
    (sec.querySelector(".conn2-group-label") as HTMLElement).textContent = g.label;
    (sec.querySelector(".conn2-group-count") as HTMLElement).textContent = String(g.items.length);
    const modeBtn = sec.querySelector(".conn2-mode-btn") as HTMLButtonElement;
    const body = sec.querySelector(".conn2-group-body") as HTMLElement;
    const rows = new Map<string, HTMLElement>();
    const paintGroup = (): void => {
      const modes = new Set(g.items.map(modeOf));
      const m: ToolMode | null = modes.size === 1 ? [...modes][0] : null;
      modeBtn.innerHTML = `${m ? MODE_ICON[m] : ""}<span>${m ? MODE_LABEL[m] : "Mixed"}</span><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;
      modeBtn.disabled = readOnly;
      for (const t of g.items) {
        const row = rows.get(t.name); if (!row) continue;
        const cur = modeOf(t);
        row.querySelectorAll<HTMLButtonElement>(".conn2-seg button").forEach((b) => b.classList.toggle("active", b.dataset.mode === cur));
      }
    };
    modeBtn.addEventListener("click", (ev) => { ev.stopPropagation(); openMenu(modeBtn, (["allow", "ask", "never"] as ToolMode[]).map((m) => ({ label: MODE_LABEL[m], onClick: () => { for (const t of g.items) setMode(t, m); paintGroup(); void persist(); } }))); });
    sec.querySelector(".conn2-group-head")!.addEventListener("click", () => { sec.classList.toggle("open"); body.classList.toggle("hidden", !sec.classList.contains("open")); });
    for (const t of g.items) {
      const row = document.createElement("div");
      row.className = "conn2-prow";
      row.innerHTML = `<div class="conn2-perm-main"><span class="conn2-perm-name"></span></div><div class="conn2-seg">${(["allow", "ask", "never"] as ToolMode[]).map((m) => `<button type="button" data-mode="${m}" title="${MODE_LABEL[m]}">${MODE_ICON[m]}</button>`).join("")}</div>`;
      const nameEl = row.querySelector(".conn2-perm-name") as HTMLElement;
      nameEl.textContent = humanize(t.name, appName);
      // No popover (his call, 2026-09-16): the description rides the tooltip.
      nameEl.title = t.description ? `${t.name}\n\n${t.description}` : t.name;
      row.querySelectorAll<HTMLButtonElement>(".conn2-seg button").forEach((b) => {
        b.disabled = readOnly;
        b.addEventListener("click", () => { setMode(t, b.dataset.mode as ToolMode); paintGroup(); void persist(); });
      });
      rows.set(t.name, row);
      body.appendChild(row);
    }
    paintGroup();
    groupsHost.appendChild(sec);
  }
}

/** A custom MCP server's fields, committing on change. The OAuth client is
 *  set when the server is added (+ Add): the store keeps it with the secrets
 *  and an update leaves it alone, so it has no field here. */
function customFields(e: Entry): HTMLElement {
  const mcp = e.mcp!;
  const wrap = document.createElement("div");
  wrap.className = "conn2-fields";
  const commitField = async (fields: Record<string, unknown>): Promise<void> => {
    const r = await window.glyphh.mcpConnectionsUpdate(mcp.slug, fields);
    if (!r.ok) throw new Error(r.error || "Couldn't save that.");
    await reloadKeepingDetail(e);
  };
  const field = (title: string, desc: string, value: string, placeholder: string, secret: boolean, commit: (v: string) => Promise<unknown>): HTMLElement => {
    const r = document.createElement("div");
    r.className = "set-pref-row";
    r.innerHTML = `<div class="set-pref-text"><div class="set-pref-title"></div><div class="set-pref-desc"></div></div><div class="set-pref-value"></div>`;
    (r.querySelector(".set-pref-title") as HTMLElement).textContent = title;
    (r.querySelector(".set-pref-desc") as HTMLElement).textContent = desc;
    const input = document.createElement("input");
    input.type = secret ? "password" : "text";
    input.autocomplete = secret ? "new-password" : "off";
    input.className = "settings-input";
    input.value = value;
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.addEventListener("change", () => {
      const v = input.value.trim();
      // A blank secret keeps the saved one; a blank name or URL is refused.
      if (!v) { if (!secret) input.value = value; return; }
      void commit(v).then(() => { if (secret) input.value = ""; }).catch((err) => fail(err instanceof Error ? err.message : String(err)));
    });
    r.querySelector(".set-pref-value")!.appendChild(input);
    return r;
  };
  wrap.appendChild(field("Name", "", e.name, "My MCP server", false, (v) => commitField({ name: v })));
  wrap.appendChild(field("Remote MCP server URL", "The endpoint Glyphh dials.", mcp.url, "https://mcp.example.com/mcp", false, (v) => {
    if (!/^https?:\/\//i.test(v)) return Promise.reject(new Error("The server URL must start with http:// or https://."));
    return commitField({ url: v });
  }));
  wrap.appendChild(field("Header", mcp.headerKeys?.length ? `Stored: ${mcp.headerKeys.join(", ")} — write-only, enter a line to replace.` : "Write-only — stored sealed, never shown again.", "", "Authorization: Bearer …", true, (v) => {
    const k = v.indexOf(":");
    if (k <= 0) return Promise.reject(new Error("A header is “Name: value”."));
    return commitField({ headers: { [v.slice(0, k).trim()]: v.slice(k + 1).trim() } });
  }));
  return wrap;
}

async function removeEntry(e: Entry): Promise<void> {
  if (e.pd) { await disconnectApp(e.pd); return; }
  const yes = await confirmAction({
    title: `Delete ${e.name}?`,
    body: "Agents lose its tools immediately. The MCP server itself is not touched; you can add it again any time.",
    confirmLabel: "Delete",
    danger: true,
  });
  if (!yes) return;
  const r = await window.glyphh.mcpConnectionsDelete(e.mcp!.slug)
    .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  if (!r.ok) { fail(r.error || `Couldn't delete ${e.name}.`); return; }
  await loadSettingsConnections();
}

/** Disconnect = every account of the app removed from the Pipedream project,
 *  its credentials with it. */
async function disconnectApp(row: PdAppRow): Promise<void> {
  const yes = await confirmAction({
    title: `Disconnect ${row.name}?`,
    body: `Agents lose its tools immediately, and Pipedream deletes the ${row.accounts.length > 1 ? `${row.accounts.length} connected accounts` : "connected account"} and ${row.accounts.length > 1 ? "their" : "its"} credentials. You can connect it again from the directory.`,
    confirmLabel: "Disconnect",
    danger: true,
  });
  if (!yes) return;
  for (const a of row.accounts) {
    const r = await window.glyphh.pipedreamDisconnect(a.id).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
    if (!r.ok) { fail(r.error || `Couldn't disconnect ${row.name}.`); break; }
  }
  await loadSettingsConnections();
}

// ── menus ───────────────────────────────────────────────────────────────────
let menuEl: HTMLElement | null = null;
function closeMenu(): void { menuEl?.remove(); menuEl = null; }
function openMenu(anchor: HTMLElement, items: Array<{ label: string; danger?: boolean; onClick: () => void }>): void {
  closeMenu();
  const m = document.createElement("div");
  m.className = "code-menu skills-menu";
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "code-menu-item" + (it.danger ? " danger" : "");
    b.textContent = it.label;
    b.addEventListener("click", () => { closeMenu(); it.onClick(); });
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const rect = anchor.getBoundingClientRect();
  m.style.left = `${Math.max(8, Math.min(rect.right - m.offsetWidth, window.innerWidth - m.offsetWidth - 8))}px`;
  m.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - m.offsetHeight - 8)}px`;
  menuEl = m;
  const dismiss = (ev: MouseEvent): void => { if (menuEl && menuEl.contains(ev.target as Node)) return; document.removeEventListener("mousedown", dismiss, true); closeMenu(); };
  setTimeout(() => document.addEventListener("mousedown", dismiss, true), 0);
}

// ── wiring ──────────────────────────────────────────────────────────────────
function wire(): void {
  if (wired) return;
  wired = true;
  el<HTMLInputElement>("conn2-search")?.addEventListener("input", (ev) => {
    query = (ev.target as HTMLInputElement).value;
    render();
  });
  el("conn2-add")?.addEventListener("click", () => void openCustomMcpModal());
  document.querySelectorAll<HTMLElement>("[data-conn-tab]").forEach((b) => b.addEventListener("click", () => {
    const next = b.dataset.connTab === "pd" ? "pd" : "mine";
    if (next === tab) return;
    tab = next;
    render();
  }));
  el("conn2-back")?.addEventListener("click", () => {
    current = null;
    el("conn2-detail-view")?.classList.add("hidden");
    el("conn2-list-view")?.classList.remove("hidden");
    render();
  });
  // The Connections section (connections.ts) edits the same store: when it
  // re-reads, the list here follows — never over an open server's page.
  onConnectionsChanged(() => {
    if (pageShowing() && !current) void loadLists();
  });
  // A Pipedream account landed or went (a connect, a disconnect, the start-up
  // re-read): the table follows, the same way.
  window.glyphh.onPipedreamChanged?.(() => {
    if (pageShowing() && !current) void loadLists();
  });
  window.glyphh.onPipedreamConnectProgress?.((p) => {
    // The Connect Link opens in a modal over this page (a panel beside it sat
    // under Customize); it closes when the connect ends, however it ends.
    if (p.phase === "waiting" && p.url) openPipedreamConnectModal(p.app, catalog.find((x) => x.slug === p.app)?.name ?? p.app, p.url);
    if (p.phase === "done") { connecting.delete(p.app); closePipedreamConnectModal(p.app); }
    else connecting.set(p.app, p);
    if (pageShowing() && !current) renderPd();
  });
}

/** + Add uses the app's standard form modal. */
async function openCustomMcpModal(): Promise<void> {
  const { formModal } = await import("./settings-list-page.js");
  await formModal({
    title: "Custom MCP",
    submitLabel: "Add & Connect",
    fields: [
      { key: "name", label: "Name", required: true, placeholder: "My MCP server" },
      {
        key: "url", label: "Remote MCP server URL", required: true,
        placeholder: "https://mcp.example.com/mcp",
        validate: (v) => /^https?:\/\//i.test(v.trim()) ? null : "must start with http:// or https://",
      },
      { key: "headers", label: "Headers (optional)", placeholder: "Authorization: Bearer …" },
      { key: "clientId", label: "OAuth client ID (optional)" },
      { key: "clientSecret", label: "OAuth client secret (optional)" },
    ],
    onSubmit: async (v) => {
      const headers: Record<string, string> = {};
      for (const line of (v.headers ?? "").split("\n")) {
        const k = line.indexOf(":");
        if (k > 0) headers[line.slice(0, k).trim()] = line.slice(k + 1).trim();
      }
      const res = await window.glyphh.mcpConnectionsCreate({
        name: v.name.trim(),
        url: v.url.trim(),
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(v.clientId ? { oauth: { clientId: v.clientId.trim(), ...(v.clientSecret ? { clientSecret: v.clientSecret.trim() } : {}) } } : {}),
      }).catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err), connection: undefined }));
      if (!res?.ok) return { ok: false as const, error: res?.error || "couldn't add that server" };
      const slug = res.connection?.slug;
      // After the modal closes: the fresh list, then the new server's page.
      setTimeout(() => {
        void loadSettingsConnections().then(() => {
          const fresh = slug ? entries.find((x) => x.key === `mcp:${slug}`) : undefined;
          if (fresh) void openDetail(fresh);
        });
      }, 0);
      return { ok: true as const };
    },
  });
}

// ── Pipedream: the setup card, then the directory ───────────────────────────
const PD_SETTINGS_API = "https://pipedream.com/settings/api";
const PD_PROJECTS = "https://pipedream.com/projects";

/** The apps a connect is in flight for, with how far it got: every card for
 *  one paints the browser hand-off and its Cancel across re-renders. */
const connecting = new Map<string, PdProgressLike>();

let catalog: PdApp[] = [];
let catalogNext = "";
let catalogQuery = "";
let catalogLoaded = false;
let catalogLoading = false;
/** Show all: the grid grows by scrolling, page by page. */
let catalogAll = false;
let categories: PdCategory[] = [];
let categoriesLoaded = false;
let category: PdCategory | null = null;

const connectedApps = (): Set<string> => new Set(entries.filter((e) => e.pd).map((e) => e.pd!.app));

/** Paint the Pipedream card in place: the page's other rows stay as they are. */
function renderPd(): void {
  const host = el("conn2-pd");
  if (!host) return;
  noteDirSearchFocus();
  host.textContent = "";
  if (!pd) return;
  const card = document.createElement("section");
  card.className = "conn2-pd-card";
  host.appendChild(card);
  if (!pd.configured || pdEditing) { renderPdSetup(card); return; }
  renderPdHeader(card);
  renderDiscover(card);
  refocusDirSearch();
}

/** A link that opens in the system browser. */
function extLink(label: string, url: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.href = url;
  a.className = "conn2-link";
  a.textContent = label;
  a.addEventListener("click", (ev) => { ev.preventDefault(); window.glyphh.openExternal(url); });
  return a;
}

/** THE SETUP FORM: the member's own Pipedream project and OAuth client. */
function renderPdSetup(card: HTMLElement): void {
  const view = pd!;
  card.insertAdjacentHTML("beforeend", `<div class="conn2-pd-head"><span class="conn2-pd-title">Connect apps with Pipedream</span></div>`);
  const intro = document.createElement("p");
  intro.className = "conn2-pd-intro";
  intro.textContent = "Gmail, Slack, GitHub and thousands more, through your own Pipedream project. Glyphh talks to Pipedream directly from this machine.";
  card.appendChild(intro);

  const steps = document.createElement("ol");
  steps.className = "conn2-pd-steps";
  const step = (...parts: Array<string | Node>): void => { const li = document.createElement("li"); li.append(...parts); steps.appendChild(li); };
  step("Open ", extLink("pipedream.com/projects", PD_PROJECTS), ", create or pick a project, and copy its ID (proj_…) from the project's Settings.");
  step("Open ", extLink("pipedream.com/settings/api", PD_SETTINGS_API), ", create a New OAuth Client, and copy its client ID and secret — the secret is shown once.");
  step("Paste them below and Save. Glyphh tests them right away.");
  card.appendChild(steps);

  const note = document.createElement("p");
  note.className = "conn2-muted conn2-pd-note";
  note.textContent = "Development is free for your own accounts, on any Pipedream plan; connecting opens Pipedream's sign-in in a window here, where you sign in to pipedream.com once. Production needs a paid Pipedream plan. Tool calls use your Pipedream credits.";
  card.appendChild(note);

  const fields = document.createElement("div");
  fields.className = "conn2-fields";
  const row = (title: string, desc: string, input: HTMLElement): void => {
    const r = document.createElement("div");
    r.className = "set-pref-row";
    r.innerHTML = `<div class="set-pref-text"><div class="set-pref-title"></div><div class="set-pref-desc"></div></div><div class="set-pref-value"></div>`;
    (r.querySelector(".set-pref-title") as HTMLElement).textContent = title;
    (r.querySelector(".set-pref-desc") as HTMLElement).textContent = desc;
    r.querySelector(".set-pref-value")!.appendChild(input);
    fields.appendChild(r);
  };
  const text = (value: string, placeholder: string, secret = false): HTMLInputElement => {
    const i = document.createElement("input");
    i.type = secret ? "password" : "text";
    i.autocomplete = secret ? "new-password" : "off";
    i.spellcheck = false;
    i.className = "settings-input";
    i.value = value;
    i.placeholder = placeholder;
    return i;
  };
  const project = text(view.projectId, "proj_abc123");
  const clientId = text(view.clientId, "OAuth client ID");
  const secret = text("", view.secretSet ? `Saved (${view.secretHint}) — leave blank to keep` : "OAuth client secret", true);
  const envSel = document.createElement("select");
  envSel.className = "settings-input";
  for (const [v, label] of [["development", "Development"], ["production", "Production"]] as const) {
    const o = document.createElement("option");
    o.value = v; o.textContent = label; o.selected = view.environment === v;
    envSel.appendChild(o);
  }
  row("Project ID", "From the project's Settings on pipedream.com.", project);
  row("Client ID", "From your OAuth client.", clientId);
  row("Client secret", "Stored encrypted on this machine and never shown again.", secret);
  row("Environment", "Development for your own accounts; production for a paid plan.", envSel);
  card.appendChild(fields);

  const bar = document.createElement("div");
  bar.className = "conn2-pd-actions";
  if (view.configured) {
    const cancel = document.createElement("button");
    cancel.type = "button"; cancel.className = "action-btn"; cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => { pdEditing = false; renderPd(); });
    bar.appendChild(cancel);
  }
  const save = document.createElement("button");
  save.type = "button"; save.className = "action-btn primary"; save.textContent = "Save & test";
  save.addEventListener("click", () => {
    const problem = projectIdProblem(project.value);
    if (problem) { fail(problem); project.focus(); return; }
    save.disabled = true; save.textContent = "Testing…";
    void (async () => {
      const r = await window.glyphh.pipedreamConfigSet({
        projectId: project.value.trim(), clientId: clientId.value.trim(),
        environment: envSel.value === "production" ? "production" : "development",
        ...(secret.value.trim() ? { clientSecret: secret.value.trim() } : {}),
      }).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
      if (!r.ok) { save.disabled = false; save.textContent = "Save & test"; fail(r.error); return; }
      pd = r.data;
      const t = await testPd();
      save.disabled = false; save.textContent = "Save & test";
      if (!t) return;   // saved but refused: the form stays up to fix it
      pdEditing = false;
      pdRefreshed = true;
      await loadLists();
    })();
  });
  bar.appendChild(save);
  card.appendChild(bar);
}

/** Mint a token and list the accounts; says how it went. */
async function testPd(): Promise<boolean> {
  const r = await window.glyphh.pipedreamTest().catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
  if (!r.ok) { fail(`Pipedream test failed: ${r.error}`); return false; }
  toastOk(`Pipedream is connected — ${r.data.accounts} account${r.data.accounts === 1 ? "" : "s"} in this project.`);
  return true;
}

/** The configured card's head: which project, Test, Edit, and Remove. */
function renderPdHeader(card: HTMLElement): void {
  const view = pd!;
  const head = document.createElement("div");
  head.className = "conn2-pd-head";
  head.innerHTML = `<span class="conn2-pd-title">Pipedream</span><span class="conn2-muted"></span><div style="flex:1"></div>`;
  (head.querySelector(".conn2-muted") as HTMLElement).textContent = `${view.projectId} · ${view.environment === "production" ? "Production" : "Development"}`;
  const test = document.createElement("button");
  test.type = "button"; test.className = "action-btn"; test.textContent = "Test";
  test.addEventListener("click", () => {
    test.disabled = true;
    void testPd().then((ok) => { test.disabled = false; if (ok) void loadLists(); });
  });
  const kebab = document.createElement("button");
  kebab.type = "button"; kebab.className = "skills-kebab"; kebab.title = "More"; kebab.textContent = "⋮";
  kebab.addEventListener("click", () => openMenu(kebab, [
    { label: "Edit credentials", onClick: () => { pdEditing = true; renderPd(); } },
    { label: "Remove Pipedream", danger: true, onClick: () => { void removePd(); } },
  ]));
  head.append(test, kebab);
  card.appendChild(head);
}

async function removePd(): Promise<void> {
  const yes = await confirmAction({
    title: "Remove Pipedream?",
    body: "Glyphh forgets your project ID and OAuth client, and agents lose every connected app's tools. The accounts stay in your Pipedream project; set it up again to use them.",
    confirmLabel: "Remove",
    danger: true,
  });
  if (!yes) return;
  const r = await window.glyphh.pipedreamConfigClear().catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
  if (!r.ok) { fail(r.error); return; }
  catalog = []; catalogLoaded = false; categories = []; categoriesLoaded = false; category = null; pdRefreshed = false;
  await loadLists();
}

// ── the directory ───────────────────────────────────────────────────────────
async function loadCatalog(reset: boolean): Promise<void> {
  if (catalogLoading || (!reset && !catalogNext)) return;
  catalogLoading = true;
  try {
    const r = await window.glyphh.pipedreamApps({ q: catalogQuery, after: reset ? "" : catalogNext, category: category?.id ?? "" });
    if (!r.ok) throw new Error(r.error);
    catalog = reset ? r.data.apps : mergeApps(catalog, r.data.apps);
    catalogNext = r.data.next;
  } catch (err) {
    if (reset) catalog = [];
    catalogNext = "";
    fail(err instanceof Error ? err.message : String(err));
  } finally {
    catalogLoading = false;
    catalogLoaded = true;
  }
}

async function loadCategories(): Promise<void> {
  if (categoriesLoaded) return;
  const r = await window.glyphh.pipedreamCategories().catch(() => null);
  categories = r?.ok ? r.data : [];
  categoriesLoaded = true;
}

/** Re-query from the first page (a search or a filter changed). */
function requery(): void {
  catalogAll = !!catalogQuery || !!category;
  void loadCatalog(true).then(() => { if (pageShowing() && !current) renderPd(); });
}

function renderDiscover(card: HTMLElement): void {
  card.appendChild(dirBar(catalogQuery, (q) => { catalogQuery = q; requery(); }, category?.name ?? "All"));
  if (!catalogLoaded) {
    card.insertAdjacentHTML("beforeend", loadingHtml("Loading the directory…"));
    void loadCatalog(true).then(() => { if (pageShowing() && !current) renderPd(); });
    return;
  }
  const sec = document.createElement("section");
  sec.className = "disc-shelf conn2-pd-shelf";
  sec.innerHTML = `<div class="disc-shelf-head"><span></span></div><div class="conn2-dir-grid"></div>`;
  (sec.querySelector(".disc-shelf-head > span") as HTMLElement).textContent = catalogQuery ? "Results" : category ? category.name : "Featured";
  const collapsible = !catalogQuery && !category;
  if (collapsible && (catalog.length > 6 || catalogNext)) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "disc-link"; b.textContent = catalogAll ? "Show fewer" : "Show all";
    b.addEventListener("click", () => { catalogAll = !catalogAll; renderPd(); });
    sec.querySelector(".disc-shelf-head")!.appendChild(b);
  }
  const grid = sec.querySelector(".conn2-dir-grid") as HTMLElement;
  const have = connectedApps();
  if (!catalog.length) grid.innerHTML = `<div class="crud-empty">${catalogQuery ? `Nothing matching "${escapeHtml(catalogQuery)}"` : "Nothing here."}</div>`;
  for (const a of catalogAll ? catalog : catalog.slice(0, 6)) grid.appendChild(dirCard(a, have));
  card.appendChild(sec);
  // SHOW ALL paginates by scrolling: a sentinel under the grid pulls the next
  // page as it comes into view, until the directory runs out.
  if (catalogAll && catalogNext) sec.appendChild(sentinel(card, () => loadCatalog(false).then(() => { if (pageShowing() && !current) renderPd(); })));
}

function sentinel(host: HTMLElement, more: () => Promise<void>): HTMLElement {
  const m = document.createElement("div");
  m.className = "conn2-more";
  m.textContent = "Loading more…";
  const scroller = host.closest(".settings-panels") ?? undefined;
  const io = new IntersectionObserver((seen) => {
    if (!seen.some((x) => x.isIntersecting)) return;
    io.disconnect();
    void more();
  }, { root: scroller as Element | undefined, rootMargin: "240px" });
  io.observe(m);
  return m;
}

function dirCard(a: PdApp, have: Set<string>): HTMLElement {
  const card = document.createElement("div");
  card.className = "conn2-dir-card";
  card.innerHTML = `${iconForApp(a, "conn2-icon lg")}<div class="conn2-dir-main"><div class="conn2-dir-name"><span></span>${have.has(a.slug) ? `<span class="conn2-verified" title="Connected">${CHECK}</span>` : ""}</div><div class="conn2-dir-desc"></div></div>`;
  (card.querySelector(".conn2-dir-name > span") as HTMLElement).textContent = a.name;
  const desc = card.querySelector(".conn2-dir-desc") as HTMLElement;
  const busy = connectProgressText(connecting.get(a.slug));
  desc.textContent = busy || a.description || "";
  desc.classList.toggle("busy", !!busy);
  if (busy) {
    const cancel = document.createElement("button");
    cancel.type = "button"; cancel.className = "action-btn conn2-connect"; cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => { void window.glyphh.pipedreamConnectCancel(a.slug); });
    card.appendChild(cancel);
  } else {
    card.appendChild(connectAppButton(a, have.has(a.slug)));
  }
  return card;
}

function connectAppButton(a: PdApp, done: boolean): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "action-btn conn2-plus" + (done ? " done" : "");
  b.innerHTML = done ? CHECK : PLUS;
  b.title = done ? `${a.name} is connected — connect another account` : `Connect ${a.name}`;
  b.addEventListener("click", (ev) => { ev.stopPropagation(); void connectApp(a); });
  return b;
}

/** CONNECT: the Connect Link opens in a modal and main polls until
 *  the account lands; the card narrates it (progress events) and offers
 *  Cancel. The new connection's permissions open once it is in. */
async function connectApp(a: PdApp): Promise<void> {
  if (connecting.has(a.slug)) return;
  connecting.set(a.slug, { phase: "opening", app: a.slug });
  renderPd();
  const r = await window.glyphh.pipedreamConnect(a.slug).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
  connecting.delete(a.slug);
  closePipedreamConnectModal(a.slug);
  if (!r.ok) { fail(r.error); if (pageShowing() && !current) renderPd(); return; }
  if (!r.data.ok) {
    if (!r.data.cancelled) fail(r.data.error);
    if (pageShowing() && !current) renderPd();
    return;
  }
  toastOk(`${a.name} is connected.`);
  await loadLists();
  if (!pageShowing() || current) return;
  const fresh = entries.find((e) => e.key === `pd:${a.slug}`);
  if (fresh) await openDetail(fresh);
}

/** ONE BAR, KEPT ACROSS RE-RENDERS: the input is created once and
 *  re-attached, so a repaint never wipes what is being typed or drops the
 *  caret; only the latest onQuery fires. */
let dirBarEl: HTMLElement | null = null;
let dirBarOnQuery: (q: string) => void = () => {};
let dirBarWasFocused = false;
function dirBar(value: string, onQuery: (q: string) => void, filterLabel: string): HTMLElement {
  dirBarOnQuery = onQuery;
  if (!dirBarEl) {
    const bar = document.createElement("div");
    bar.className = "conn2-dir-bar";
    bar.innerHTML = `<div class="skills-search conn2-dir-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input type="text" placeholder="Search apps to connect" spellcheck="false" autocomplete="off" /></div><button type="button" class="action-btn conn2-filter"><span class="conn2-muted">Filter:</span> <span></span></button>`;
    const input = bar.querySelector("input") as HTMLInputElement;
    let t: ReturnType<typeof setTimeout> | null = null;
    input.addEventListener("input", () => { if (t) clearTimeout(t); t = setTimeout(() => dirBarOnQuery(input.value.trim()), 250); });
    const filter = bar.querySelector(".conn2-filter") as HTMLButtonElement;
    filter.addEventListener("click", () => {
      if (!categoriesLoaded) { void loadCategories().then(() => filter.click()); return; }
      openMenu(filter, [
        { label: "All apps", onClick: () => { category = null; requery(); } },
        ...categories.map((c) => ({ label: c.name, onClick: () => { category = c; requery(); } })),
      ]);
    });
    dirBarEl = bar;
  }
  const input = dirBarEl.querySelector("input") as HTMLInputElement;
  if (!dirBarWasFocused && document.activeElement !== input) input.value = value;
  (dirBarEl.querySelector(".conn2-filter > span:last-child") as HTMLElement).textContent = filterLabel;
  return dirBarEl;
}
/** Called before a repaint empties the card: remember whether the box had
 *  focus, so it is restored (caret at the end) once re-attached. */
function noteDirSearchFocus(): void {
  const input = dirBarEl?.querySelector("input") ?? null;
  if (input && document.activeElement === input) dirBarWasFocused = true;
}
function refocusDirSearch(): void {
  if (!dirBarWasFocused) return;
  const again = dirBarEl?.querySelector<HTMLInputElement>("input") ?? null;
  if (again && again.isConnected) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
  dirBarWasFocused = false;
}
