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

import { escapeHtml, confirmAction, loadingHtml } from "./shared.js";
import { appIconInner, primeConnectedIcons } from "./app-icon.js";
import { adoptConnectionsInto, onConnectionsChanged } from "./connections.js";
import { planGates } from "./plan-gate.js";
import { toastError } from "./toast.js";

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
  if (msg) toastError(msg);
}

let entries: Entry[] = [];
let customAllowed = false;
/** Pipedream connections are paid-plan only (each connected account is billed);
 *  custom MCP servers stay free, so only Connect actions lock, never the page. */
let pdAllowed = true;
let tab: "mine" | "discover" = "mine";
let stateFilter: "all" | "connected" | "not" = "all";
let query = "";
let catalog: CatalogApp[] = [];
/** Popular = most connected across the server, from the fork. */
let popular: Array<CatalogApp & { installs: number }> = [];
let popularLoaded = false;
let catalogQuery = "";
let catalogAll = false;
/** The cursor for the directory's next page; empty = the end. */
let catalogNext = "";
let catalogLoading = false;
/** The directory by category (name, count, a few featured apps), loaded once. */
type Category = { name: string; count: number; apps: CatalogApp[] };
let categories: Category[] = [];
let categoriesLoaded = false;
/** A category page: its apps so far, the next offset, its own search. */
let catView: string | null = null;
let catApps: CatalogApp[] = [];
let catNext = "";
let catQuery = "";
let catTotal = 0;
let catLoading = false;
/** The detail on screen: a connection of ours, or a directory app not yet connected. */
let current: { entry?: Entry; app?: CatalogApp; page?: "summary" | "permissions" } | null = null;
let wired = false;

// ── loading ─────────────────────────────────────────────────────────────────
/** An app to open as soon as the page loads, on its permissions — the door a
 *  refused unattended call offers ("not set to Always allow"). */
let pendingApp: { app: string } | null = null;
export function openConnectionOnLoad(appSlug: string): void { pendingApp = { app: String(appSlug || "") }; }

export async function loadSettingsConnections(): Promise<void> {
  const body = el("conn2-body");
  if (!body) return;
  wire();
  ensureAdopted();
  el("conn2-detail-view")?.classList.add("hidden");
  el("conn2-list-view")?.classList.remove("hidden");
  fail("");
  if (!entries.length) body.innerHTML = loadingHtml("Loading your connections…");
  const [res, custom, gate, gates] = await Promise.all([
    window.glyphh.connectionsList().catch(() => ({ ok: false, connections: [] as Conn[] })),
    window.glyphh.mcpConnectionsList().catch(() => ({ ok: false, connections: [] as McpConn[] })),
    window.glyphh.mcpCustomAllowed?.().catch(() => ({ allowed: false })) ?? Promise.resolve({ allowed: false }),
    planGates(),
  ]);
  customAllowed = !!(gate as { allowed?: boolean })?.allowed;
  pdAllowed = gates.connectionsAllowed !== false;
  const addBtn = el<HTMLButtonElement>("conn2-add");
  if (addBtn) { addBtn.disabled = !customAllowed; addBtn.title = customAllowed ? "Add an MCP server of your own" : (gate as { reason?: string })?.reason || "Custom MCP servers aren't available on your plan"; }
  const conns = (res as { connections?: Conn[] })?.connections ?? [];
  const mcps = (custom as { connections?: McpConn[] })?.connections ?? [];
  const mcpSlugs = new Set(mcps.map((m) => m.slug));
  entries = [
    ...conns.filter((c) => !mcpSlugs.has(c.appSlug) && !mcpSlugs.has(c.id)).map((c): Entry => ({
      key: `pd:${c.id}`,
      kind: c.org ? "org" : "pipedream",
      name: c.label || c.appName,
      // A SHARED ACCOUNT NOBODY SIGNED INTO (his report, 2026-09-17): say so
      // here, since a member cannot fix it and every call it makes is refused.
      desc: c.org
        ? (c.shared ? (c.connected === false ? "Shared org account — your admin has not signed into it yet." : "Shared org account — every member rides it.") : "Added by your organization.")
        : c.appName,
      type: "Web",
      badge: c.org ? (c.shared ? (c.connected === false ? "Needs your admin" : "Shared") : "Org") : "",
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
  // A deep link lands on the account's permissions, where the toggles are.
  if (pendingApp) {
    const want = pendingApp.app.toLowerCase();
    pendingApp = null;
    const hit = entries.find((e) => (e.conn?.appSlug || e.mcp?.slug || "").toLowerCase() === want);
    if (hit) void openDetail({ entry: hit, page: "permissions" });
  }
  void primeConnectedIcons(
    entries.filter((x) => x.conn).map((x) => ({ connection: { accountId: x.conn!.accountId, pipedreamSlug: x.conn!.appSlug } })),
    render,
  );
}

async function loadCatalog(q: string): Promise<void> {
  catalogQuery = q;
  catalogNext = "";
  if (!catalog.length) { const b = el("conn2-body"); if (b) b.innerHTML = loadingHtml("Loading the directory…"); }
  try {
    const r = await window.glyphh.connectorsGetApps(q);
    catalog = r.apps ?? [];
    catalogNext = r.next || "";
  } catch (err) {
    catalog = [];
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function loadCategories(): Promise<void> {
  if (categoriesLoaded) return;
  try { categories = await window.glyphh.connectorsGetCategories(); } catch { categories = []; }
  categoriesLoaded = true;
}

async function loadCategoryPage(reset: boolean): Promise<void> {
  if (!catView || catLoading) return;
  if (!reset && !catNext) return;
  if (reset) { const b = el("conn2-body"); if (b) b.innerHTML = loadingHtml("Loading this category…"); }
  catLoading = true;
  try {
    const r = await window.glyphh.connectorsGetApps(catQuery.trim(), reset ? undefined : catNext, catView);
    catApps = reset ? (r.apps ?? []) : [...catApps, ...(r.apps ?? [])];
    catNext = r.next || "";
    catTotal = r.total ?? catApps.length;
  } catch (err) {
    if (reset) catApps = [];
    catNext = "";
    fail(err instanceof Error ? err.message : String(err));
  } finally {
    catLoading = false;
  }
}

async function openCategory(name: string | null): Promise<void> {
  catView = name;
  catQuery = "";
  catApps = [];
  catNext = "";
  if (name) await loadCategoryPage(true);
  render();
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

/** The upsell line every plan-gated page wears, but only over Connect: the
 *  list, tool switches and custom MCP servers stay live on Free. */
function lockedNote(): HTMLElement {
  const note = document.createElement("div");
  note.className = "plan-locked-note";
  const msg = document.createElement("span");
  msg.textContent = "Connections are on a paid plan — upgrade to connect apps. Custom MCP servers are free on every plan. ";
  const link = document.createElement("a");
  link.href = "#";
  link.className = "plan-locked-link";
  link.textContent = "Upgrade plan →";
  link.addEventListener("click", (ev) => {
    ev.preventDefault();
    document.querySelector<HTMLButtonElement>('.settings-nav-item[data-sub="billing"]')?.click();
  });
  note.append(msg, link);
  return note;
}

function render(): void {
  const host = el("conn2-body");
  if (!host) return;
  document.querySelectorAll<HTMLButtonElement>("[data-conn2-tab]").forEach((b) => b.classList.toggle("active", b.dataset.conn2Tab === tab));
  host.textContent = "";
  if (!pdAllowed) host.appendChild(lockedNote());
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
      const adminsToFix = e.kind === "org" && !e.connected;
      tr.innerHTML = `${iconFor(e)}<span class="conn2-name"></span><span class="conn2-type"><span></span>${e.badge ? `<span class="conn2-badge">${escapeHtml(e.badge)}</span>` : ""}</span><span class="conn2-status"></span>`;
      (tr.querySelector(".conn2-name") as HTMLElement).textContent = e.name;
      (tr.querySelector(".conn2-type > span") as HTMLElement).textContent = e.type;
      const st = tr.querySelector(".conn2-status") as HTMLElement;
      if (e.connected) st.innerHTML = `<span class="conn2-check">${CHECK}</span>`;
      else if (adminsToFix) st.innerHTML = `<span class="conn2-muted">Ask your admin</span>`;
      else st.appendChild(connectButton(e));
      tr.addEventListener("click", () => void openDetail({ entry: e, page: "permissions" }));
      table.appendChild(tr);
    }
    host.appendChild(table);
  }

  // POPULAR — the most connected apps across the server (install counts),
  // minus what this member already has, three across.
  if (!popularLoaded) {
    popularLoaded = true;
    void window.glyphh.connectorsGetPopular().then((rows) => { popular = rows; if (tab === "mine") render(); }).catch(() => { popular = []; });
  }
  const have = connectedSlugs();
  const show = popular.filter((a) => !have.has(a.id)).slice(0, 3);
  if (show.length) {
    const sec = document.createElement("div");
    sec.className = "conn2-popular";
    sec.innerHTML = `<div class="skill-group-head"><span>Popular</span></div><div class="conn2-popular-grid"></div>`;
    const grid = sec.querySelector(".conn2-popular-grid") as HTMLElement;
    for (const a of show) {
      const card = document.createElement("div");
      card.className = "conn2-pop openable";
      card.innerHTML = `${iconForApp(a)}<span class="conn2-name"></span>`;
      (card.querySelector(".conn2-name") as HTMLElement).textContent = a.name;
      card.title = a.installs ? `${a.installs} connection${a.installs === 1 ? "" : "s"} across Glyphh` : "Featured";
      card.appendChild(connectAppButton(a, true));
      card.addEventListener("click", () => void openDetail({ app: a }));
      grid.appendChild(card);
    }
    host.appendChild(sec);
  }
}

/**
 * ONE CONNECTION TABLE (his order, 2026-09-17).
 *
 * A bundle's Connections tab listed its accounts as plain rows with a link
 * glyph while the Connections page showed a real table: the connector's own
 * logo, a Type column, the Shared badge, a check when connected. Both
 * surfaces render HERE now, so they cannot drift again — the same lesson as
 * the app list the wall and the rail share.
 *
 * `deps` are what a manifest declares. Every one is REQUIRED: an unconnected
 * account gets the page's own Connect button, which runs the same flow.
 */
export interface ConnDep { app: string; as?: string }

/** A manifest carries either `["gmail"]` or `[{ app: "gmail", as: "member" }]`.
 *  Reading both is the RENDERER's job here: nothing in src/renderer may import
 *  src/shared — one such import moves tsc's inferred rootDir and every
 *  renderer file emits to a directory the app never loads (2026-09-17). */
export const connDeps = (raw: ReadonlyArray<ConnDep | string> | undefined | null): ConnDep[] =>
  (raw ?? [])
    .map((d) => (typeof d === "string" ? { app: d } : d))
    .filter((d): d is ConnDep => !!d && typeof d.app === "string" && !!d.app.trim())
    .map((d) => ({ app: d.app.trim().toLowerCase(), as: d.as === "org" ? "org" : "member" }));

export async function renderConnectionTable(
  host: HTMLElement,
  raw: ReadonlyArray<ConnDep | string>,
  opts: { onChanged?: () => void } = {},
): Promise<void> {
  const deps = connDeps(raw);
  host.textContent = "";
  if (!deps.length) return;
  pdAllowed = (await planGates()).connectionsAllowed !== false;
  // THE LOADING LINE THE PAGE ITSELF USES (his order, 2026-09-17), so the pane
  // never sits blank while the member's accounts come back.
  host.innerHTML = loadingHtml("Loading connections…");
  const settle = (): void => { host.textContent = ""; };
  const mine = await window.glyphh.connectionsList().catch(() => ({ ok: false, connections: [] as Conn[] }));
  const have = new Map((mine.connections ?? []).map((c) => [c.appSlug, c]));
  const pretty = (slug: string): string => slug.replace(/[_-]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());

  settle();
  const table = document.createElement("div");
  table.className = "conn2-table";
  table.innerHTML = `<div class="conn2-tr head"><span class="conn2-head-connector">Connector</span><span>Type</span><span class="conn2-head-status">Status</span></div>`;
  const rows: Entry[] = [];
  for (const dep of deps) {
    const c = have.get(dep.app);
    const org = dep.as === "org";
    const e: Entry = c
      ? {
          key: `pd:${c.id}`, kind: c.org ? "org" : "pipedream", name: c.label || c.appName || pretty(dep.app),
          desc: c.appName || "", type: "Web",
          badge: c.org ? (c.shared ? (c.connected === false ? "Needs your admin" : "Shared") : "Org") : "",
          // A shared account is only usable once an admin has signed into it.
          connected: c.connected !== false, enabled: true, icon: null, conn: c,
        }
      : {
          key: `dep:${dep.app}`, kind: "pipedream", name: pretty(dep.app), desc: "", type: "Web",
          badge: org ? "Org" : "", connected: false, enabled: true, icon: catalog.find((a) => a.id === dep.app)?.icon ?? null,
        };
    rows.push(e);
    const tr = document.createElement("div");
    tr.className = "conn2-tr";
    tr.innerHTML = `${iconFor(e)}<span class="conn2-name"></span><span class="conn2-type"><span></span>${e.badge ? `<span class="conn2-badge">${escapeHtml(e.badge)}</span>` : ""}</span><span class="conn2-status"></span>`;
    (tr.querySelector(".conn2-name") as HTMLElement).textContent = e.name;
    (tr.querySelector(".conn2-type > span") as HTMLElement).textContent = e.type;
    const st = tr.querySelector(".conn2-status") as HTMLElement;
    if (e.connected) st.innerHTML = `<span class="conn2-check">${CHECK}</span>`;
    else if (org || e.kind === "org") st.innerHTML = `<span class="conn2-muted">Ask your admin</span>`;
    else {
      // The catalog row when we have it (its own name and logo), else the slug.
      const app: CatalogApp = catalog.find((a) => a.id === dep.app) ?? { id: dep.app, name: e.name, description: "" };
      const btn = connectAppButton(app, true);
      btn.addEventListener("click", () => {
        // The flow finishes out of band; re-read until the row turns.
        let tries = 0;
        const tick = (): void => {
          void renderConnectionTable(host, deps, opts).then(() => { opts.onChanged?.(); });
          if (++tries < 6) window.setTimeout(tick, 1500);
        };
        window.setTimeout(tick, 1500);
      });
      st.appendChild(btn);
    }
    table.appendChild(tr);
  }
  host.appendChild(table);
  // Connected accounts wear their own logo once the icon cache warms.
  void primeConnectedIcons(
    rows.filter((x) => x.conn).map((x) => ({ connection: { accountId: x.conn!.accountId, pipedreamSlug: x.conn!.appSlug } })),
    () => { void renderConnectionTable(host, deps, opts); },
  );
}

const LOCKED_TITLE = "Connections are on a paid plan — upgrade to connect apps";

function connectButton(e: Entry): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "action-btn conn2-connect";
  b.textContent = "Connect";
  if (!pdAllowed && !e.mcp) { b.disabled = true; b.title = LOCKED_TITLE; }
  b.addEventListener("click", (ev) => { ev.stopPropagation(); void connectEntry(e, b); });
  return b;
}
function connectAppButton(a: CatalogApp, wide = false): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  const done = connectedSlugs().has(a.id);
  b.className = wide ? "action-btn conn2-connect" : "action-btn conn2-plus" + (done ? " done" : "");
  b.innerHTML = wide ? (done ? "Connected" : "Connect") : (done ? CHECK : PLUS);
  b.disabled = done || !pdAllowed;
  b.title = done ? "Connected" : pdAllowed ? "Connect" : LOCKED_TITLE;
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
    if (keep) {
      const fresh = keep.entry ? entries.find((x) => x.key === keep.entry!.key) : entries.find((x) => x.conn?.appSlug === slug);
      // Once the account has landed the user is on their connection, not the
      // directory: open its permissions page (his report, 2026-09-20).
      const landed = !!fresh?.connected;
      await openDetail(fresh ? { entry: fresh, app: keep.app, page: landed ? "permissions" : keep.page } : keep, true);
    }
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
  // On Discover the header search steps aside: the search and the Filter sit
  // under the breadcrumb (his screens, 2026-09-16).
  document.querySelector<HTMLElement>("#conn2-list-view .skills-search")?.classList.add("hidden");
  if (catView) { renderCategoryPage(host); return; }
  const count = el("conn2-count"); if (count) count.textContent = `${catalog.length} available`;
  const crumb = document.createElement("div");
  crumb.className = "conn2-crumb";
  crumb.innerHTML = `<span class="crumb-link">Connections</span><span class="sep">/</span><span class="here">Directory</span>`;
  crumb.querySelector(".crumb-link")!.addEventListener("click", () => { tab = "mine"; render(); });
  host.appendChild(crumb);
  host.appendChild(dirBar(catalogQuery, (q) => { void loadCatalog(q).then(() => { catalogAll = false; render(); refocusDirSearch(); }); }, "All"));


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
  for (const a of catalogAll ? rows : rows.slice(0, 8)) grid.appendChild(dirCard(a, have));
  host.appendChild(sec);
  // SHOW ALL paginates by scrolling: a sentinel under the grid pulls the next
  // page as it comes into view, until the directory runs out.
  if (catalogAll && catalogNext) {
    sec.appendChild(sentinel(host, () => loadMoreCatalog().then(() => { if (tab === "discover") render(); })));
    return;
  }
  // BY CATEGORY (his order, 2026-09-16): a section per category with a few
  // featured apps, Show all opening the category page. Not under a search.
  if (catalogQuery || catalogAll) return;
  if (!categoriesLoaded) {
    host.insertAdjacentHTML("beforeend", `<div class="conn2-more">Indexing the directory…</div>`);
    void loadCategories().then(() => { if (tab === "discover" && !catView) render(); });
    return;
  }
  for (const c of categories) {
    const csec = document.createElement("section");
    csec.className = "disc-shelf";
    csec.innerHTML = `<div class="disc-shelf-head"><span></span></div><div class="conn2-dir-grid"></div>`;
    (csec.querySelector(".disc-shelf-head > span") as HTMLElement).textContent = c.name;
    const all = document.createElement("button");
    all.type = "button"; all.className = "disc-link"; all.textContent = "Show all";
    all.addEventListener("click", () => void openCategory(c.name));
    csec.querySelector(".disc-shelf-head")!.appendChild(all);
    const cgrid = csec.querySelector(".conn2-dir-grid") as HTMLElement;
    for (const a of c.apps.slice(0, 6)) cgrid.appendChild(dirCard(a, have));
    host.appendChild(csec);
  }
}

function sentinel(host: HTMLElement, more: () => Promise<void>): HTMLElement {
  const m = document.createElement("div");
  m.className = "conn2-more";
  m.textContent = "Loading more…";
  const scroller = host.closest(".settings-panels") ?? undefined;
  const io = new IntersectionObserver((entries) => {
    if (!entries.some((x) => x.isIntersecting)) return;
    io.disconnect();
    void more();
  }, { root: scroller as Element | undefined, rootMargin: "240px" });
  io.observe(m);
  return m;
}

function dirCard(a: CatalogApp, have: Set<string>): HTMLElement {
  const card = document.createElement("div");
  card.className = "conn2-dir-card openable";
  card.innerHTML = `${iconForApp(a, "conn2-icon lg")}<div class="conn2-dir-main"><div class="conn2-dir-name"><span></span>${have.has(a.id) ? `<span class="conn2-verified" title="Connected">${CHECK}</span>` : ""}</div><div class="conn2-dir-desc"></div></div>`;
  (card.querySelector(".conn2-dir-name > span") as HTMLElement).textContent = a.name;
  (card.querySelector(".conn2-dir-desc") as HTMLElement).textContent = a.description || "";
  card.appendChild(connectAppButton(a));
  card.addEventListener("click", () => void openDetail({ app: a }));
  return card;
}

/** The directory bar under the breadcrumb: search on the left, "Filter: <x>"
 *  on the right opening the category list. */
function dirBar(value: string, onQuery: (q: string) => void, filterLabel: string): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "conn2-dir-bar";
  bar.innerHTML = `<div class="skills-search conn2-dir-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input type="text" placeholder="Search connectors" spellcheck="false" autocomplete="off" /></div><button type="button" class="action-btn conn2-filter"><span class="conn2-muted">Filter:</span> <span></span></button>`;
  const input = bar.querySelector("input") as HTMLInputElement;
  input.value = value;
  let t: ReturnType<typeof setTimeout> | null = null;
  input.addEventListener("input", () => { if (t) clearTimeout(t); t = setTimeout(() => onQuery(input.value.trim()), 250); });
  const filter = bar.querySelector(".conn2-filter") as HTMLButtonElement;
  (filter.querySelector("span:last-child") as HTMLElement).textContent = filterLabel;
  filter.addEventListener("click", () => {
    if (!categoriesLoaded) { void loadCategories().then(() => filter.click()); return; }
    openMenu(filter, [
      { label: "All connectors", onClick: () => void openCategory(null) },
      ...categories.map((c) => ({ label: `${c.name} (${c.count})`, onClick: () => void openCategory(c.name) })),
    ]);
  });
  return bar;
}
function refocusDirSearch(): void {
  const again = document.querySelector<HTMLInputElement>(".conn2-dir-search input");
  if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
}

/** A category page: breadcrumb, its own search with the Filter dropdown, the
 *  grid paging by scroll. */
function renderCategoryPage(host: HTMLElement): void {
  const count = el("conn2-count"); if (count) count.textContent = `${catTotal} in ${catView}`;
  const crumb = document.createElement("div");
  crumb.className = "conn2-crumb";
  crumb.innerHTML = `<span class="crumb-link">Connections</span><span class="sep">/</span><span class="crumb-link dir">Directory</span><span class="sep">/</span><span class="here"></span>`;
  (crumb.querySelector(".here") as HTMLElement).textContent = catView!;
  crumb.querySelector(".crumb-link:not(.dir)")!.addEventListener("click", () => { catView = null; tab = "mine"; render(); });
  crumb.querySelector(".crumb-link.dir")!.addEventListener("click", () => void openCategory(null));
  host.appendChild(crumb);
  host.appendChild(dirBar(catQuery, (q) => { catQuery = q; void loadCategoryPage(true).then(() => { render(); refocusDirSearch(); }); }, catView!));

  const have = connectedSlugs();
  const grid = document.createElement("div");
  grid.className = "conn2-dir-grid";
  if (!catApps.length) grid.innerHTML = `<div class="crud-empty">${catLoading ? "Loading…" : catQuery ? `Nothing in ${escapeHtml(catView!)} matching "${escapeHtml(catQuery)}"` : "Nothing here yet."}</div>`;
  for (const a of catApps) grid.appendChild(dirCard(a, have));
  host.appendChild(grid);
  if (catNext) host.appendChild(sentinel(host, () => loadCategoryPage(false).then(() => { if (tab === "discover" && catView) render(); })));
}

// ── tools: names people can read, split by what they do ─────────────────────
const READ_VERBS = /^(get|list|search|find|read|fetch|retrieve|query|describe|count|check|lookup|view|show|download|export|preview|watch|summarize|detect)\b/i;
/** The tool's own name, as words: the gateway prefixes tool names with the
 *  server's technical name and Pipedream with the app slug, so everything up
 *  to the last run of the app's tokens is dropped. "pd_o52…_gmail-gmail-send-email"
 *  → "Send email". The raw name rides the tooltip. */
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
  } else if (tokens[0] === "pd") {
    rest = tokens.slice(tokens.findIndex((t) => t.length >= 30) + 1);
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
    const val = cell.querySelector(".conn2-meta-v") as HTMLElement;
    if (k === "Made by" && v === "Pipedream") {
      const link = document.createElement("a");
      link.href = "https://pipedream.com/";
      link.textContent = "Pipedream";
      link.className = "conn2-link";
      link.addEventListener("click", (ev) => { ev.preventDefault(); const g = window.glyphh as unknown as { openExternal?: (u: string) => void }; if (g.openExternal) g.openExternal("https://pipedream.com/"); else window.open("https://pipedream.com/", "_blank", "noopener"); });
      val.appendChild(link);
    } else val.textContent = v;
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
  const appName = e.conn?.appSlug || e.mcp?.slug || e.name;
  for (const t of tools) { const c = document.createElement("span"); c.className = "conn2-tool-chip" + (t.hidden ? " off" : ""); c.textContent = humanize(t.name, appName); c.title = t.description ? `${t.name}\n${t.description}` : t.name; chips.appendChild(c); }

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

  await renderToolGroups(groupsHost, {
    key: e.key, appName: e.conn?.appSlug || e.mcp?.slug || e.name, tools, readOnly: e.kind === "org",
    persistHidden: async (list) => { if (e.mcp) await window.glyphh.mcpConnectionsUpdate(e.mcp.slug, { hiddenTools: list }); else await window.glyphh.connectionToolsSet(e.conn!.id, list); },
  });
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
  persistHidden: (hidden: string[]) => Promise<unknown>;
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
      await o.persistHidden(Array.from(hidden));
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
  el<HTMLInputElement>("conn2-search")?.addEventListener("input", (ev) => {
    query = (ev.target as HTMLInputElement).value;
    render();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-conn2-tab]").forEach((b) => b.addEventListener("click", async () => {
    tab = b.dataset.conn2Tab as "mine" | "discover";
    if (tab === "discover" && !catalog.length) await loadCatalog("");
    render();
  }));
  // Apps come from Discover; the button is for a server of your own.
  el("conn2-add")?.addEventListener("click", () => void openCustomMcpModal());
  el("conn2-back")?.addEventListener("click", () => {
    current = null;
    el("conn2-detail-view")?.classList.add("hidden");
    el("conn2-list-view")?.classList.remove("hidden");
    render();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-conn2-tab]").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.conn2Tab === "mine") document.querySelector<HTMLElement>("#conn2-list-view .skills-search")?.classList.remove("hidden");
  }));
}

// ── the adopted original: catalog modal + connect flow (one implementation) ──
let adopted = false;
let selfTriggered = false;
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
    if (current) return;
    void refreshFromStore();
  });
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
