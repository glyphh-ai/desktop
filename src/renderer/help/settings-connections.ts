/**
 * settings-connections.ts — CONNECTIONS in the Skills page's grammar (his
 * order, 2026-09-16: "exact same layout" as Skills, with a connector-style
 * detail screen).
 *
 *   Your connections   a table: connector · type · status, filtered by
 *                      All / Connected / Not connected, with a Popular row
 *   Discover           the directory: search + a grid of cards (+ / ✓),
 *                      Show all, each card opening the same detail
 *   Detail             hero (icon, name, description, Connected badge or
 *                      Connect, ⋮), the description, Tools as chips, the
 *                      tool switches, and the metadata grid
 *
 * Data lanes are the ones that already existed: the member's connection list
 * (personal + the org's, with state), custom MCP servers, the Pipedream app
 * directory, and the connect flow. ORG rows stay read-only except for
 * "connect your own account" on a per-member org connection.
 */

import { escapeHtml, confirmAction } from "./shared.js";
import { appIconInner, primeConnectedIcons } from "./app-icon.js";
import { adoptConnectionsInto, onConnectionsChanged, closeConnDetail } from "./connections.js";

type Conn = Awaited<ReturnType<typeof window.glyphh.connectionsList>>["connections"][number];
type McpConn = Awaited<ReturnType<typeof window.glyphh.mcpConnectionsList>>["connections"][number];
type CatalogApp = Awaited<ReturnType<typeof window.glyphh.connectorsGetApps>>["apps"][number];

/** One row of Your connections, whatever lane it came from. */
interface Entry {
  key: string;
  kind: "pipedream" | "custom" | "org";
  name: string;
  desc: string;
  type: string;
  badge: string;
  connected: boolean;
  enabled: boolean;
  icon: string | null;
  conn?: Conn;
  mcp?: McpConn;
}

const el = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

function fail(msg: string): void {
  const e = el("conn2-error");
  if (!e) return;
  e.textContent = msg;
  e.classList.toggle("hidden", !msg);
}

let entries: Entry[] = [];
let customAllowed = false;
let tab: "mine" | "discover" = "mine";
let stateFilter: "all" | "connected" | "not" = "all";
let query = "";
let catalog: CatalogApp[] = [];
let catalogQuery = "";
let catalogAll = false;
/** The cursor for the directory's next page; empty = the end. */
let catalogNext = "";
let catalogLoading = false;
/** The detail on screen: a connection of ours, or a directory app not yet connected. */
let current: { entry?: Entry; app?: CatalogApp } | null = null;
let wired = false;

// ── loading ─────────────────────────────────────────────────────────────────
export async function loadSettingsConnections(): Promise<void> {
  const body = el("conn2-body");
  if (!body) return;
  wire();
  ensureAdopted();
  el("conn2-detail-view")?.classList.add("hidden");
  el("conn2-list-view")?.classList.remove("hidden");
  fail("");
  const [res, custom, gate] = await Promise.all([
    window.glyphh.connectionsList().catch(() => ({ ok: false, connections: [] as Conn[] })),
    window.glyphh.mcpConnectionsList().catch(() => ({ ok: false, connections: [] as McpConn[] })),
    window.glyphh.mcpCustomAllowed?.().catch(() => ({ allowed: false })) ?? Promise.resolve({ allowed: false }),
  ]);
  customAllowed = !!(gate as { allowed?: boolean })?.allowed;
  const conns = (res as { connections?: Conn[] })?.connections ?? [];
  const mcps = (custom as { connections?: McpConn[] })?.connections ?? [];
  const mcpSlugs = new Set(mcps.map((m) => m.slug));
  entries = [
    ...conns.filter((c) => !mcpSlugs.has(c.appSlug) && !mcpSlugs.has(c.id)).map((c): Entry => ({
      key: `pd:${c.id}`,
      kind: c.org ? "org" : "pipedream",
      name: c.label || c.appName,
      desc: c.org ? (c.shared ? "Shared org account — every member rides it." : "Added by your organization.") : c.appName,
      type: "Web",
      badge: c.org ? (c.shared ? "Shared" : "Org") : "",
      connected: c.connected !== false,
      enabled: true,
      icon: null,
      conn: c,
    })),
    ...mcps.map((m): Entry => ({
      key: `mcp:${m.slug}`,
      kind: m.kind === "org" ? "org" : "custom",
      name: m.name,
      desc: m.url || "Custom MCP server",
      type: "MCP",
      badge: m.kind === "org" ? "Org" : "",
      connected: m.enabled,
      enabled: m.enabled,
      icon: m.iconUrl,
      mcp: m,
    })),
  ].sort((a, b) => a.name.localeCompare(b.name));
  if (tab === "discover" && !catalog.length) await loadCatalog("");
  render();
  void primeConnectedIcons(
    entries.filter((x) => x.conn).map((x) => ({ connection: { accountId: x.conn!.accountId, pipedreamSlug: x.conn!.appSlug } })),
    render,
  );
}

async function loadCatalog(q: string): Promise<void> {
  catalogQuery = q;
  catalogNext = "";
  try {
    const r = await window.glyphh.connectorsGetApps(q);
    catalog = r.apps ?? [];
    catalogNext = r.next || "";
  } catch (err) {
    catalog = [];
    fail(err instanceof Error ? err.message : String(err));
  }
}

/** Show all = the directory keeps loading as the user scrolls, page by page. */
async function loadMoreCatalog(): Promise<void> {
  if (!catalogNext || catalogLoading) return;
  catalogLoading = true;
  try {
    const r = await window.glyphh.connectorsGetApps(catalogQuery, catalogNext);
    const seen = new Set(catalog.map((a) => a.id));
    catalog = [...catalog, ...(r.apps ?? []).filter((a) => !seen.has(a.id))];
    catalogNext = r.next || "";
  } catch (err) {
    catalogNext = "";
    fail(err instanceof Error ? err.message : String(err));
  } finally {
    catalogLoading = false;
  }
}

// ── the list ────────────────────────────────────────────────────────────────
const CHECK = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7"/></svg>`;
const PLUS = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`;

function iconFor(e: Entry, cls = "conn2-icon"): string {
  if (e.conn) return `<span class="${cls}">${appIconInner({ connection: { accountId: e.conn.accountId, pipedreamSlug: e.conn.appSlug } }, e.name, "conn2-icon-initial")}</span>`;
  if (e.icon) return `<span class="${cls}"><img src="${escapeHtml(e.icon)}" alt="" /></span>`;
  return `<span class="${cls}"><span class="conn2-icon-initial">${escapeHtml((e.name || "?").charAt(0).toUpperCase())}</span></span>`;
}
function iconForApp(a: CatalogApp, cls = "conn2-icon"): string {
  return `<span class="${cls}">${appIconInner({ iconUrl: a.icon ?? null, connection: { pipedreamSlug: a.id } }, a.name, "conn2-icon-initial")}</span>`;
}
const connectedSlugs = (): Set<string> => new Set(entries.filter((e) => e.conn && e.connected).map((e) => e.conn!.appSlug));

function render(): void {
  const host = el("conn2-body");
  if (!host) return;
  document.querySelectorAll<HTMLButtonElement>("[data-conn2-tab]").forEach((b) => b.classList.toggle("active", b.dataset.conn2Tab === tab));
  host.textContent = "";
  if (tab === "discover") { renderDiscover(host); return; }

  const q = query.trim().toLowerCase();
  const shown = entries
    .filter((e) => !q || `${e.name} ${e.desc}`.toLowerCase().includes(q))
    .filter((e) => stateFilter === "all" || (stateFilter === "connected" ? e.connected : !e.connected));
  const count = el("conn2-count"); if (count) count.textContent = `${entries.length} connection${entries.length === 1 ? "" : "s"}`;

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
    host.insertAdjacentHTML("beforeend", `<div class="crud-empty">${q ? `No connections matching "${escapeHtml(q)}"` : stateFilter === "not" ? "Everything is connected." : "No connections yet — Add one, or pick from Discover."}</div>`);
  } else {
    const table = document.createElement("div");
    table.className = "conn2-table";
    table.innerHTML = `<div class="conn2-tr head"><span class="conn2-head-connector">Connector</span><span>Type</span><span class="conn2-head-status">Status</span></div>`;
    for (const e of shown) {
      const tr = document.createElement("div");
      tr.className = "conn2-tr openable";
      tr.innerHTML = `${iconFor(e)}<span class="conn2-name"></span><span class="conn2-type"><span></span>${e.badge ? `<span class="conn2-badge">${escapeHtml(e.badge)}</span>` : ""}</span><span class="conn2-status"></span>`;
      (tr.querySelector(".conn2-name") as HTMLElement).textContent = e.name;
      (tr.querySelector(".conn2-type > span") as HTMLElement).textContent = e.type;
      const st = tr.querySelector(".conn2-status") as HTMLElement;
      if (e.connected) st.innerHTML = `<span class="conn2-check">${CHECK}</span>`;
      else st.appendChild(connectButton(e));
      tr.addEventListener("click", () => void openDetail({ entry: e, page: "permissions" }));
      table.appendChild(tr);
    }
    host.appendChild(table);
  }

  // POPULAR — directory apps not yet connected, three across.
  const have = connectedSlugs();
  const popular = catalog.filter((a) => !have.has(a.id)).slice(0, 3);
  if (popular.length) {
    const sec = document.createElement("div");
    sec.className = "conn2-popular";
    sec.innerHTML = `<div class="skill-group-head"><span>Popular</span></div><div class="conn2-popular-grid"></div>`;
    const grid = sec.querySelector(".conn2-popular-grid") as HTMLElement;
    for (const a of popular) {
      const card = document.createElement("div");
      card.className = "conn2-pop openable";
      card.innerHTML = `${iconForApp(a)}<span class="conn2-name"></span>`;
      (card.querySelector(".conn2-name") as HTMLElement).textContent = a.name;
      card.appendChild(connectAppButton(a, true));
      card.addEventListener("click", () => void openDetail({ app: a }));
      grid.appendChild(card);
    }
    host.appendChild(sec);
  } else if (!catalog.length && !catalogQuery) {
    void loadCatalog("").then(() => { if (tab === "mine" && catalog.length) render(); });
  }
}

function connectButton(e: Entry): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "action-btn conn2-connect";
  b.textContent = "Connect";
  b.addEventListener("click", (ev) => { ev.stopPropagation(); void connectEntry(e, b); });
  return b;
}
function connectAppButton(a: CatalogApp, wide = false): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  const done = connectedSlugs().has(a.id);
  b.className = wide ? "action-btn conn2-connect" : "action-btn conn2-plus" + (done ? " done" : "");
  b.innerHTML = wide ? (done ? "Connected" : "Connect") : (done ? CHECK : PLUS);
  b.disabled = done;
  b.title = done ? "Connected" : "Connect";
  b.addEventListener("click", (ev) => { ev.stopPropagation(); void connectApp(a.id, b); });
  return b;
}

async function connectEntry(e: Entry, btn: HTMLButtonElement): Promise<void> {
  if (e.mcp) {
    btn.disabled = true;
    const r = await window.glyphh.mcpConnectionsUpdate(e.mcp.slug, { enabled: true }).catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    if (!(r as { ok?: boolean })?.ok) { btn.disabled = false; fail((r as { error?: string })?.error || "Couldn't enable that server."); return; }
    await loadSettingsConnections();
    return;
  }
  if (e.conn) await connectApp(e.conn.appSlug, btn);
}

async function connectApp(slug: string, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  const was = btn.innerHTML;
  btn.textContent = "Connecting…";
  const r = await (window.glyphh.connectorsConnect?.(slug) ?? Promise.resolve({ ok: false, error: "Connect is not available here." }))
    .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  if (!r.ok) { btn.disabled = false; btn.innerHTML = was; fail(r.error || "Couldn't connect."); return; }
  // The account lands asynchronously after the OAuth: a few reloads catch it.
  const keep = current;
  let tries = 0;
  const tick = async (): Promise<void> => {
    await reloadQuietly();
    if (keep) { const fresh = keep.entry ? entries.find((x) => x.key === keep.entry!.key) : entries.find((x) => x.conn?.appSlug === slug); await openDetail(fresh ? { entry: fresh, app: keep.app } : keep, true); }
    if (++tries < 6 && !connectedSlugs().has(slug)) setTimeout(() => void tick(), 1500);
  };
  await tick();
}

/** Re-read the lists without leaving the detail view. */
async function reloadQuietly(): Promise<void> {
  const onDetail = !!current;
  await loadSettingsConnections();
  if (onDetail) { el("conn2-list-view")?.classList.add("hidden"); el("conn2-detail-view")?.classList.remove("hidden"); }
}

// ── discover ────────────────────────────────────────────────────────────────
function renderDiscover(host: HTMLElement): void {
  const count = el("conn2-count"); if (count) count.textContent = `${catalog.length} available`;
  const crumb = document.createElement("div");
  crumb.className = "conn2-crumb";
  crumb.innerHTML = `<span>Connections</span><span class="sep">/</span><span class="here">Directory</span>`;
  host.appendChild(crumb);

  const bar = document.createElement("div");
  bar.className = "conn2-dir-bar";
  bar.innerHTML = `<div class="skills-search conn2-dir-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input type="text" placeholder="Search connectors" spellcheck="false" autocomplete="off" /></div>`;
  const input = bar.querySelector("input") as HTMLInputElement;
  input.value = catalogQuery;
  let t: ReturnType<typeof setTimeout> | null = null;
  input.addEventListener("input", () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      void loadCatalog(input.value.trim()).then(() => {
        catalogAll = false;
        render();
        const again = document.querySelector<HTMLInputElement>(".conn2-dir-search input");
        if (again) { again.value = input.value; again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
      });
    }, 250);
  });
  host.appendChild(bar);

  const have = connectedSlugs();
  const rows = catalog;
  const sec = document.createElement("section");
  sec.className = "disc-shelf";
  sec.innerHTML = `<div class="disc-shelf-head"><span>${catalogQuery ? "Results" : "Top connectors"}</span></div><div class="conn2-dir-grid"></div>`;
  if (rows.length > 8 || catalogNext) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "disc-link"; b.textContent = catalogAll ? "Show fewer" : "Show all";
    b.addEventListener("click", () => { catalogAll = !catalogAll; render(); });
    sec.querySelector(".disc-shelf-head")!.appendChild(b);
  }
  const grid = sec.querySelector(".conn2-dir-grid") as HTMLElement;
  if (!rows.length) grid.innerHTML = `<div class="crud-empty">${catalogQuery ? `Nothing matching "${escapeHtml(catalogQuery)}"` : "The directory is empty."}</div>`;
  for (const a of catalogAll ? rows : rows.slice(0, 8)) {
    const card = document.createElement("div");
    card.className = "conn2-dir-card openable";
    card.innerHTML = `${iconForApp(a, "conn2-icon lg")}<div class="conn2-dir-main"><div class="conn2-dir-name"><span></span>${have.has(a.id) ? `<span class="conn2-verified" title="Connected">${CHECK}</span>` : ""}</div><div class="conn2-dir-desc"></div></div>`;
    (card.querySelector(".conn2-dir-name > span") as HTMLElement).textContent = a.name;
    (card.querySelector(".conn2-dir-desc") as HTMLElement).textContent = a.description || "";
    card.appendChild(connectAppButton(a));
    card.addEventListener("click", () => void openDetail({ app: a }));
    grid.appendChild(card);
  }
  host.appendChild(sec);
  // SHOW ALL paginates by scrolling: a sentinel under the grid pulls the next
  // page as it comes into view, until the directory runs out.
  if (catalogAll && catalogNext) {
    const more = document.createElement("div");
    more.className = "conn2-more";
    more.textContent = "Loading more…";
    sec.appendChild(more);
    const scroller = host.closest(".settings-panels") ?? undefined;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((x) => x.isIntersecting)) return;
      io.disconnect();
      void loadMoreCatalog().then(() => { if (tab === "discover") render(); });
    }, { root: scroller as Element | undefined, rootMargin: "240px" });
    io.observe(more);
  }
}

// ── tools: names people can read, split by what they do ─────────────────────
const READ_VERBS = /^(get|list|search|find|read|fetch|retrieve|query|describe|count|check|lookup|view|show|download|export|preview|watch|summarize|detect)\b/i;
/** "gmail-send-email" → "Send email"; the raw name rides the tooltip. */
function humanize(name: string, app?: string): string {
  let n = name;
  const prefix = (app || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const flat = n.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (prefix && flat.startsWith(prefix)) n = n.replace(new RegExp(`^${app!.replace(/[^a-z0-9]/gi, "[^a-z0-9]?")}[-_ ]?`, "i"), "");
  n = n.replace(/[-_.]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return n ? n.charAt(0).toUpperCase() + n.slice(1) : name;
}
const isReadTool = (name: string, app?: string): boolean => READ_VERBS.test(humanize(name, app));
type ToolMode = "allow" | "ask" | "never";
const MODE_LABEL: Record<ToolMode, string> = { allow: "Always allow", ask: "Needs approval", never: "Never" };
const MODE_ICON: Record<ToolMode, string> = {
  allow: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>`,
  ask: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V6a2 2 0 1 1 4 0v6M12 7a2 2 0 1 1 4 0v6M16 9a2 2 0 1 1 4 0v5a7 7 0 0 1-7 7h-1a7 7 0 0 1-6-3.4L3.4 13a2 2 0 0 1 3.4-2L8 13"/></svg>`,
  never: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="m6 6 12 12"/></svg>`,
};
/** Modes other than Never are the member's preference, per connection (server-side prefs). */
async function readModes(key: string): Promise<Record<string, ToolMode>> {
  const raw = await window.glyphh.getPreference?.(`connToolModes:${key}`, {}).catch(() => ({}));
  return raw && typeof raw === "object" ? (raw as Record<string, ToolMode>) : {};
}

// ── detail ──────────────────────────────────────────────────────────────────
async function openDetail(target: { entry?: Entry; app?: CatalogApp; page?: "summary" | "permissions" }, quiet = false): Promise<void> {
  // A directory app we already have becomes its connection's detail.
  if (target.app && !target.entry) {
    const mine = entries.find((e) => e.conn?.appSlug === target.app!.id);
    if (mine) target = { entry: mine, app: target.app, page: target.page };
  }
  // A connection of ours opened from the list: fetch its app so the detail
  // carries Pipedream's blurb and categories, not just the app name.
  if (target.entry?.conn && !target.app) {
    const slug = target.entry.conn.appSlug;
    const hit = catalog.find((x) => x.id === slug) ?? (await window.glyphh.connectorsGetApps(target.entry.conn.appName).catch(() => ({ apps: [] as CatalogApp[] }))).apps.find((x) => x.id === slug);
    if (hit) target = { entry: target.entry, app: hit, page: target.page };
  }
  current = target;
  const host = el("conn2-detail");
  if (!host) return;
  if (!quiet) {
    el("conn2-list-view")?.classList.add("hidden");
    el("conn2-detail-view")?.classList.remove("hidden");
  }
  host.textContent = "";
  // A CONNECTED connection opened from Your connections is the permissions
  // page; Discover opens the summary (hero, description, tools, metadata).
  if (target.page === "permissions" && target.entry) { await renderPermissionsPage(host, target.entry, target.app); return; }
  const e = target.entry;
  const a = target.app;
  const name = e?.name ?? a?.name ?? "";
  const desc = e ? (e.mcp ? (e.mcp.url || "Custom MCP server") : (a?.description || e.desc)) : (a?.description || "");
  const connected = !!e?.connected;

  // HERO — icon, name, description; Connected badge or Connect; ⋮.
  const hero = document.createElement("div");
  hero.className = "conn2-hero";
  hero.innerHTML = `${e ? iconFor(e, "conn2-icon xl") : iconForApp(a!, "conn2-icon xl")}<div class="conn2-hero-main"><div class="conn2-hero-name"></div><div class="conn2-hero-desc"></div></div><div class="conn2-hero-actions"></div>`;
  (hero.querySelector(".conn2-hero-name") as HTMLElement).textContent = name;
  (hero.querySelector(".conn2-hero-desc") as HTMLElement).textContent = desc;
  const actions = hero.querySelector(".conn2-hero-actions") as HTMLElement;
  if (connected) actions.insertAdjacentHTML("beforeend", `<span class="conn2-connected">${CHECK}<span>Connected</span></span>`);
  else if (e) { const b = connectButton(e); b.classList.add("primary"); b.textContent = e.mcp ? "Enable" : "Connect"; actions.appendChild(b); }
  else if (a) { const b = connectAppButton(a, true); b.classList.add("primary"); actions.appendChild(b); }
  if (e && e.kind !== "org") {
    const kebab = document.createElement("button");
    kebab.type = "button";
    kebab.className = "skills-kebab";
    kebab.title = "More";
    kebab.textContent = "⋮";
    kebab.addEventListener("click", () => openMenu(kebab, [
      ...(e.mcp?.url ? [{ label: "Copy server URL", onClick: () => { void navigator.clipboard?.writeText(e.mcp!.url); } }] : []),
      ...(e.mcp ? [{ label: e.enabled ? "Turn off" : "Turn on", onClick: async () => {
        await window.glyphh.mcpConnectionsUpdate(e.mcp!.slug, { enabled: !e.enabled });
        await reloadQuietly();
        const fresh = entries.find((x) => x.key === e.key);
        if (fresh) await openDetail({ entry: fresh }, true);
      } }] : []),
      { label: e.mcp ? "Delete" : "Disconnect", danger: true, onClick: () => void removeEntry(e) },
    ]));
    actions.appendChild(kebab);
  }
  host.appendChild(hero);

  const body = document.createElement("div");
  body.className = "conn2-detail-body";
  host.appendChild(body);

  // DESCRIPTION
  const about = document.createElement("p");
  about.className = "conn2-about";
  about.textContent = e?.kind === "org"
    ? (e.conn?.shared ? `${name} is a shared org account: your organization authorized it once and every member's agents ride it.` : `Your organization added ${name}. ${connected ? "Your own account is connected; your agents use it through the gateway." : "Connect your own account to use it from your agents."}`)
    : e?.mcp ? "A custom MCP server your agents reach through the gateway. Its tools are listed below; turn one off to hide it from your AI."
    : `${name} through Pipedream Connect: ${connected ? "your account is authorized and its tools are exposed to your agents through the gateway." : "connect your account and its tools become available to your agents through the gateway."}`;
  body.appendChild(about);

  // CUSTOM MCP — the fields (URL, headers, OAuth) commit on change.
  if (e?.mcp && e.kind !== "org") body.appendChild(customFields(e));

  // TOOLS — chips, then the switches.
  const toolsHead = document.createElement("h3");
  toolsHead.className = "conn2-h3";
  toolsHead.textContent = "Tools";
  body.appendChild(toolsHead);
  const chips = document.createElement("div");
  chips.className = "conn2-tool-chips";
  chips.innerHTML = `<span class="conn2-chip-muted">Loading…</span>`;
  body.appendChild(chips);
  const perms = document.createElement("div");
  perms.className = "conn2-perms";
  body.appendChild(perms);

  // META
  const meta = document.createElement("div");
  meta.className = "conn2-meta";
  const metaRows: Array<[string, string]> = [
    ["Made by", e?.mcp ? (e.kind === "org" ? "Your organization" : "You") : e?.kind === "org" ? "Your organization" : "Pipedream"],
    ["Type", e?.type ?? "Web"],
    ...(e?.mcp?.url ? [["Server URL", e.mcp.url] as [string, string]] : []),
    ["Sign-in", e?.conn?.shared ? "Org account (shared)" : e?.mcp ? (e.mcp.headerKeys?.length ? "Headers" : "Server's own") : "Required"],
    ...(e?.conn ? [["Access", e.kind === "org" ? "Managed by your organization" : "Yours"] as [string, string]] : []),
    ...(a?.categories?.length ? [["Categories", a.categories.join(", ")] as [string, string]] : []),
  ];
  for (const [k, v] of metaRows) {
    const cell = document.createElement("div");
    cell.className = "conn2-meta-cell";
    cell.innerHTML = `<div class="conn2-meta-k"></div><div class="conn2-meta-v"></div>`;
    (cell.querySelector(".conn2-meta-k") as HTMLElement).textContent = k;
    (cell.querySelector(".conn2-meta-v") as HTMLElement).textContent = v;
    meta.appendChild(cell);
  }
  body.appendChild(meta);

  if (!e) { chips.innerHTML = `<span class="conn2-chip-muted">Connect to see this connector's tools.</span>`; return; }
  await paintTools(e, chips, perms);
}

async function paintTools(e: Entry, chips: HTMLElement, perms: HTMLElement): Promise<void> {
  let tools: Array<{ name: string; description?: string; hidden?: boolean }> = [];
  try {
    const res = e.mcp ? await window.glyphh.mcpConnectionsTools(e.mcp.slug) : await window.glyphh.connectionToolsList(e.conn!.id);
    if (!(res as { ok?: boolean })?.ok) throw new Error((res as { error?: string }).error || "couldn't load tools");
    tools = (res as { tools?: typeof tools }).tools ?? [];
  } catch (err) {
    chips.innerHTML = `<span class="conn2-chip-muted">Couldn't load tools.</span>`;
    fail(err instanceof Error ? err.message : String(err));
    return;
  }
  if (!tools.length) { chips.innerHTML = `<span class="conn2-chip-muted">${e.connected ? "This connection publishes no tools yet." : "Connect to see its tools."}</span>`; return; }
  chips.textContent = "";
  const appName = e.conn?.appName || e.name;
  for (const t of tools) { const c = document.createElement("span"); c.className = "conn2-tool-chip" + (t.hidden ? " off" : ""); c.textContent = humanize(t.name, appName); c.title = t.name; chips.appendChild(c); }

  const readOnly = e.kind === "org";
  const hidden = new Set(tools.filter((t) => t.hidden).map((t) => t.name));
  const commit = async (): Promise<void> => {
    const list = Array.from(hidden);
    try {
      if (e.mcp) await window.glyphh.mcpConnectionsUpdate(e.mcp.slug, { hiddenTools: list });
      else await window.glyphh.connectionToolsSet(e.conn!.id, list);
    } catch (err) { fail(err instanceof Error ? err.message : String(err)); }
    chips.querySelectorAll<HTMLElement>(".conn2-tool-chip").forEach((c) => c.classList.toggle("off", hidden.has(c.textContent || "")));
  };
  const head = document.createElement("div");
  head.className = "conn2-perms-head";
  head.innerHTML = `<div><div class="conn2-h3" style="margin:0">Tool permissions</div><div class="conn2-muted">Choose which tools your AI may use. ${readOnly ? "Managed by your organization." : "Off hides a tool from every agent."}</div></div><label class="skills-switch conn2-all" title="All tools"><input type="checkbox" /><span></span></label>`;
  const all = head.querySelector("input") as HTMLInputElement;
  all.disabled = readOnly;
  perms.appendChild(head);
  const list = document.createElement("div");
  list.className = "conn2-perm-list";
  perms.appendChild(list);
  const paintAll = (): void => { all.checked = hidden.size === 0; };
  all.addEventListener("change", () => {
    hidden.clear();
    if (!all.checked) for (const t of tools) hidden.add(t.name);
    list.querySelectorAll<HTMLInputElement>("input").forEach((b) => { b.checked = all.checked; });
    void commit();
  });
  for (const t of tools) {
    const row = document.createElement("div");
    row.className = "conn2-perm";
    row.innerHTML = `<div class="conn2-perm-main"><div class="conn2-perm-name"></div><div class="conn2-perm-desc"></div></div><label class="skills-switch"><input type="checkbox" /><span></span></label>`;
    (row.querySelector(".conn2-perm-name") as HTMLElement).textContent = humanize(t.name, appName);
    (row.querySelector(".conn2-perm-name") as HTMLElement).title = t.name;
    (row.querySelector(".conn2-perm-desc") as HTMLElement).textContent = t.description || "";
    const box = row.querySelector("input") as HTMLInputElement;
    box.checked = !hidden.has(t.name);
    box.disabled = readOnly;
    box.addEventListener("change", () => { if (box.checked) hidden.delete(t.name); else hidden.add(t.name); paintAll(); void commit(); });
    row.querySelector(".conn2-perm-main")!.addEventListener("click", () => row.classList.toggle("expanded"));
    list.appendChild(row);
  }
  paintAll();
}

/** THE PERMISSIONS PAGE (his screens, 2026-09-16): a compact header, the
 *  description, then the tools in two groups, Read-only and Write/delete, each
 *  with a group mode and a three-way switch per tool: Always allow, Needs
 *  approval, Never. Never = hidden from every agent (the existing hidden
 *  list); the other two are the member's preference per connection. */
async function renderPermissionsPage(host: HTMLElement, e: Entry, app?: CatalogApp): Promise<void> {
  const head = document.createElement("div");
  head.className = "conn2-phead";
  head.innerHTML = `${iconFor(e, "conn2-icon")}<span class="conn2-phead-name"></span><div style="flex:1"></div><div class="conn2-hero-actions"></div>`;
  (head.querySelector(".conn2-phead-name") as HTMLElement).textContent = e.name;
  const actions = head.querySelector(".conn2-hero-actions") as HTMLElement;
  if (e.kind !== "org") {
    const dis = document.createElement("button");
    dis.type = "button";
    dis.className = "action-btn";
    dis.textContent = e.mcp ? "Delete" : "Disconnect";
    dis.addEventListener("click", () => void removeEntry(e));
    actions.appendChild(dis);
  } else if (!e.connected && !e.conn?.shared) {
    const b = connectButton(e); b.classList.add("primary"); actions.appendChild(b);
  }
  const kebab = document.createElement("button");
  kebab.type = "button";
  kebab.className = "skills-kebab";
  kebab.title = "More";
  kebab.textContent = "⋮";
  kebab.addEventListener("click", () => openMenu(kebab, [
    { label: "About this connector", onClick: () => void openDetail({ entry: e, app, page: "summary" }) },
    ...(e.mcp?.url ? [{ label: "Copy server URL", onClick: () => { void navigator.clipboard?.writeText(e.mcp!.url); } }] : []),
    ...(e.mcp && e.kind !== "org" ? [{ label: e.enabled ? "Turn off" : "Turn on", onClick: async () => { await window.glyphh.mcpConnectionsUpdate(e.mcp!.slug, { enabled: !e.enabled }); await reloadQuietly(); const fresh = entries.find((x) => x.key === e.key); if (fresh) await openDetail({ entry: fresh, app, page: "permissions" }, true); } }] : []),
  ]));
  actions.appendChild(kebab);
  host.appendChild(head);

  const about = document.createElement("p");
  about.className = "conn2-about";
  about.textContent = app?.description || (e.mcp ? (e.mcp.url || "A custom MCP server your agents reach through the gateway.") : e.desc);
  host.appendChild(about);

  if (e.mcp && e.kind !== "org") host.appendChild(customFields(e));

  const title = document.createElement("div");
  title.className = "conn2-h3";
  title.textContent = "Tool permissions";
  host.appendChild(title);
  const sub = document.createElement("div");
  sub.className = "conn2-muted";
  sub.style.marginBottom = "10px";
  sub.textContent = e.kind === "org" ? "Managed by your organization." : "Choose when your AI is allowed to use these tools.";
  host.appendChild(sub);

  const groupsHost = document.createElement("div");
  groupsHost.className = "conn2-groups";
  groupsHost.innerHTML = `<div class="conn2-chip-muted">Loading tools…</div>`;
  host.appendChild(groupsHost);

  let tools: Array<{ name: string; description?: string; hidden?: boolean }> = [];
  try {
    const res = e.mcp ? await window.glyphh.mcpConnectionsTools(e.mcp.slug) : await window.glyphh.connectionToolsList(e.conn!.id);
    if (!(res as { ok?: boolean })?.ok) throw new Error((res as { error?: string }).error || "couldn't load tools");
    tools = (res as { tools?: typeof tools }).tools ?? [];
  } catch (err) {
    groupsHost.innerHTML = `<div class="conn2-chip-muted">Couldn't load tools.</div>`;
    fail(err instanceof Error ? err.message : String(err));
    return;
  }
  if (!tools.length) { groupsHost.innerHTML = `<div class="conn2-chip-muted">${e.connected ? "This connection publishes no tools yet." : "Connect to see its tools."}</div>`; return; }

  const appName = e.conn?.appName || e.name;
  const readOnly = e.kind === "org";
  const hidden = new Set(tools.filter((t) => t.hidden).map((t) => t.name));
  const prefs = await readModes(e.key);
  const modeOf = (t: { name: string }): ToolMode => hidden.has(t.name) ? "never" : (prefs[t.name] ?? (isReadTool(t.name, appName) ? "allow" : "ask"));
  const persist = async (): Promise<void> => {
    try {
      const list = Array.from(hidden);
      if (e.mcp) await window.glyphh.mcpConnectionsUpdate(e.mcp.slug, { hiddenTools: list });
      else await window.glyphh.connectionToolsSet(e.conn!.id, list);
      window.glyphh.setPreference?.(`connToolModes:${e.key}`, prefs);
    } catch (err) { fail(err instanceof Error ? err.message : String(err)); }
  };
  const setMode = (t: { name: string }, m: ToolMode): void => {
    if (m === "never") { hidden.add(t.name); delete prefs[t.name]; }
    else { hidden.delete(t.name); prefs[t.name] = m; }
  };

  groupsHost.textContent = "";
  const groups: Array<{ label: string; items: typeof tools }> = [
    { label: "Read-only tools", items: tools.filter((t) => isReadTool(t.name, appName)) },
    { label: "Write/delete tools", items: tools.filter((t) => !isReadTool(t.name, appName)) },
  ].filter((g) => g.items.length);
  for (const g of groups) {
    const sec = document.createElement("div");
    sec.className = "conn2-group";
    sec.innerHTML = `<div class="conn2-group-head"><svg class="conn2-group-chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg><span class="conn2-group-label"></span><span class="conn2-group-count"></span><div style="flex:1"></div><button type="button" class="conn2-mode-btn"></button></div><div class="conn2-group-body hidden"></div>`;
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
      row.innerHTML = `<div class="conn2-perm-main"><div class="conn2-perm-name"></div><div class="conn2-perm-desc"></div></div><div class="conn2-seg">${(["allow", "ask", "never"] as ToolMode[]).map((m) => `<button type="button" data-mode="${m}" title="${MODE_LABEL[m]}">${MODE_ICON[m]}</button>`).join("")}</div>`;
      (row.querySelector(".conn2-perm-name") as HTMLElement).textContent = humanize(t.name, appName);
      (row.querySelector(".conn2-perm-name") as HTMLElement).title = t.name;
      (row.querySelector(".conn2-perm-desc") as HTMLElement).textContent = t.description || "";
      row.querySelector(".conn2-perm-main")!.addEventListener("click", () => row.classList.toggle("expanded"));
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

/** A custom MCP server's fields, committing on change. */
function customFields(e: Entry): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "conn2-fields";
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
      if (!v && secret) return;
      void commit(v).then(() => { if (secret) input.value = ""; }).catch((err) => fail(err instanceof Error ? err.message : String(err)));
    });
    r.querySelector(".set-pref-value")!.appendChild(input);
    return r;
  };
  wrap.appendChild(field("Name", "", e.name, "My MCP server", false, (v) => window.glyphh.mcpConnectionsUpdate(e.mcp!.slug, { name: v })));
  wrap.appendChild(field("Remote MCP server URL", "The endpoint the server dials.", e.mcp!.url, "https://mcp.example.com/mcp", false, (v) => window.glyphh.mcpConnectionsUpdate(e.mcp!.slug, { url: v })));
  wrap.appendChild(field("Header", e.mcp!.headerKeys?.length ? `Stored: ${e.mcp!.headerKeys.join(", ")} — write-only, enter a line to replace.` : "Write-only — stored sealed, never shown again.", "", "Authorization: Bearer …", true, (v) => {
    const k = v.indexOf(":");
    return window.glyphh.mcpConnectionsUpdate(e.mcp!.slug, { headers: k > 0 ? { [v.slice(0, k).trim()]: v.slice(k + 1).trim() } : {} });
  }));
  wrap.appendChild(field("OAuth client ID", "For servers that sign you in on first connect.", "", "", false, (v) => window.glyphh.mcpConnectionsUpdate(e.mcp!.slug, { oauth: { clientId: v } })));
  wrap.appendChild(field("OAuth client secret", "Write-only — never shown again.", "", "", true, (v) => window.glyphh.mcpConnectionsUpdate(e.mcp!.slug, { oauth: { clientSecret: v } })));
  return wrap;
}

async function removeEntry(e: Entry): Promise<void> {
  const yes = await confirmAction({
    title: e.mcp ? `Delete ${e.name}?` : `Disconnect ${e.name}?`,
    body: "Agents lose its tools immediately. You can connect it again any time.",
    confirmLabel: e.mcp ? "Delete" : "Disconnect",
    danger: true,
  });
  if (!yes) return;
  try {
    if (e.mcp) await window.glyphh.mcpConnectionsDelete(e.mcp.slug);
    else if (e.conn) await window.glyphh.connectionDisconnect(e.conn.id);
    current = null;
    await loadSettingsConnections();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
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
  el<HTMLInputElement>("conn2-search")?.addEventListener("input", (ev) => { query = (ev.target as HTMLInputElement).value; render(); });
  document.querySelectorAll<HTMLButtonElement>("[data-conn2-tab]").forEach((b) => b.addEventListener("click", async () => {
    tab = b.dataset.conn2Tab as "mine" | "discover";
    if (tab === "discover" && !catalog.length) await loadCatalog("");
    render();
  }));
  el("conn2-add")?.addEventListener("click", (ev) => openMenu(ev.currentTarget as HTMLElement, [
    { label: "New connection", onClick: () => driveOriginal("conn-add-btn") },
    ...(customAllowed ? [{ label: "Custom MCP server", onClick: () => void openCustomMcpModal() }] : []),
    { label: "Browse the directory", onClick: async () => { tab = "discover"; if (!catalog.length) await loadCatalog(""); render(); } },
  ]));
  el("conn2-back")?.addEventListener("click", () => {
    current = null;
    el("conn2-detail-view")?.classList.add("hidden");
    el("conn2-list-view")?.classList.remove("hidden");
    render();
  });
}

// ── the adopted original: catalog modal + connect flow (one implementation) ──
let adopted = false;
let selfTriggered = false;
let suspendRefresh = false;
let refreshing = false;
async function refreshFromStore(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try { await loadSettingsConnections(); } finally { refreshing = false; }
}
function ensureAdopted(): void {
  const host = el("conncfg-legacy");
  if (!host || adopted) return;
  adopted = true;
  selfTriggered = true;
  adoptConnectionsInto(host, [], null);
  onConnectionsChanged(() => {
    if (selfTriggered) { selfTriggered = false; return; }
    if (suspendRefresh || current) return;
    void refreshFromStore();
  });
}

/** Click the real catalog button: the real modal, the real connect flow. */
function driveOriginal(id: string): void {
  closeConnDetail();
  const btn = document.getElementById(id) as HTMLElement | null;
  if (!btn) return;
  suspendRefresh = true;
  btn.click();
  const modal = document.getElementById("conn-modal");
  if (!modal) { suspendRefresh = false; return; }
  const obs = new MutationObserver(() => {
    if (!modal.classList.contains("hidden")) return;
    obs.disconnect();
    suspendRefresh = false;
    let tries = 0;
    const tick = (): void => { void refreshFromStore().then(() => { if (++tries < 8) setTimeout(tick, 1500); }); };
    setTimeout(tick, 400);
  });
  obs.observe(modal, { attributes: true, attributeFilter: ["class"] });
}

/** + Custom MCP uses the app's standard form modal. */
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
      });
      if (!res?.ok) return { ok: false as const, error: res?.error || "couldn't add that server" };
      const slug = res.connection?.slug;
      setTimeout(() => {
        void loadSettingsConnections().then(() => {
          const fresh = slug ? entries.find((x) => x.key === `mcp:${slug}`) : undefined;
          if (fresh) void openDetail({ entry: fresh });
        });
      }, 0);
      return { ok: true as const };
    },
  });
}
