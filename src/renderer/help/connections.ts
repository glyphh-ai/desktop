/**
 * Connections section — first-class Connections (connected Pipedream accounts),
 * mirroring the Apps tab's look. The installed list uses the same crud-card
 * pattern; "+ New" opens a modal with the full Pipedream catalog (click one to
 * connect it). Each connection has a user-editable Name and a per-connection
 * tool-exposure list (uncheck to hide a tool from the AI).
 */

import { appIconInner, primeConnectedIcons } from "./app-icon.js";
import { confirmAction } from "./shared.js";
import { openRowMenu, ROW_MENU_ICONS } from "./lib-editor.js";
import { showAppOverlay, hideAppOverlay } from "../app-overlay.js";

type Conn = Awaited<ReturnType<typeof window.glyphh.connectionsList>>["connections"][number];
type CatalogApp = Awaited<ReturnType<typeof window.glyphh.connectorsGetApps>>["apps"][number];
type McpConn = Awaited<ReturnType<typeof window.glyphh.mcpConnectionsList>>["connections"][number];

let connections: Conn[] = [];
// Custom MCP connections — server-side rows like any other connection; the
// server dials the endpoint and holds the (write-only) auth headers.
let customServers: McpConn[] = [];
let customAllowed = false;   // org × role policy (server-enforced; this only shows/hides UI)
let isAdminUser = false;     // decides which AXIS the platform page shows (org vs personal)
let connSearch = "";
let currentConnId: string | null = null;
let currentCustomSlug: string | null = null;
// "new" = the + Custom MCP form; "edit" = a saved custom connection's detail.
let customMode: "new" | "edit" | null = null;
let catalogOffset = 0;

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function connIconApp(c: { accountId: string; appSlug: string }) {
  return { connection: { accountId: c.accountId, pipedreamSlug: c.appSlug } };
}

/** The card's corner controls (his rule, 2026-09-13): the standard BARE
 *  toggle + the three-dot kebab, far right. Delete rides the kebab and opens
 *  the app-standard confirm dialog. Clicks never open the card underneath. */
function attachCardControls(card: HTMLElement, opts: {
  enabled: boolean; canToggle: boolean;
  onToggle: (on: boolean) => Promise<void>;
  deleteWhat: string; onDelete: () => Promise<void>;
}): void {
  const corner = document.createElement("div");
  corner.className = "app-card-controls";
  corner.style.cssText = "position:absolute;top:8px;right:8px;display:flex;align-items:center;gap:4px;z-index:2;";
  if (opts.canToggle) {
    const sw = document.createElement("label");
    sw.className = "settings-toggle ws-model-allow";
    sw.innerHTML = `<input type="checkbox" ${opts.enabled ? "checked" : ""} /><span class="toggle-switch"></span>`;
    sw.addEventListener("click", (e) => e.stopPropagation());
    sw.querySelector("input")!.addEventListener("change", (e) => {
      void opts.onToggle((e.target as HTMLInputElement).checked);
    });
    corner.appendChild(sw);
  }
  const kebab = document.createElement("button");
  kebab.type = "button";
  kebab.className = "lib-row-kebab";
  kebab.title = "More";
  kebab.textContent = "⋮";
  kebab.addEventListener("click", (e) => {
    e.stopPropagation();
    openRowMenu(kebab, [{
      icon: ROW_MENU_ICONS.delete, label: "Delete", danger: true,
      onClick: () => {
        void (async () => {
          const sure = await confirmAction({
            title: `Delete ${opts.deleteWhat}?`,
            body: "This disconnects the account and removes it for everyone it serves.",
            confirmLabel: "Delete",
          });
          if (sure) await opts.onDelete();
        })();
      },
    }]);
  });
  corner.appendChild(kebab);
  card.style.position = "relative";
  card.appendChild(corner);
}

// DOM (resolved in initConnections)
let listEl: HTMLElement, detailEl: HTMLElement, searchEl: HTMLInputElement;
let nameInput: HTMLInputElement, toolsEl: HTMLElement, detailHead: HTMLElement, detailErr: HTMLElement;
let customStatusEl: HTMLElement, customStatusText: HTMLElement, customToggle: HTMLButtonElement;
let customConfigEl: HTMLElement, disconnectBtn: HTMLButtonElement, saveBtn: HTMLButtonElement;
let modalEl: HTMLElement, catalogGrid: HTMLElement, catalogSearch: HTMLInputElement, catalogMore: HTMLElement;

/** Swap a button into/out of a busy state with an inline spinner. */
function setBtnBusy(btn: HTMLButtonElement, busy: boolean, label: string): void {
  btn.disabled = busy;
  btn.innerHTML = busy ? `<span class="btn-spinner"></span>${esc(label)}` : esc(label);
}

// ── ADOPTION (his order, 2026-08-25): the App → edit → Connections tab hosts
// this page's OWN toolbar/list/detail nodes — one component, so the forms can
// never drift. While adopted, the list filters to the app's REQUIRED
// connection slugs, with unconnected requirements rendered as Connect cards.
let requiredFilter: string[] | null = null;
let adoptedHomes: Array<{ n: HTMLElement; parent: HTMLElement | null; next: Node | null }> | null = null;

/** While adopted, the open connection's TOOLS pane is hosted separately (the
 *  app tab's right pane) — the detail's own split is only half a page wide
 *  there, which clipped the list to a sliver. Null = not adopted. */
let adoptedToolsHost: HTMLElement | null = null;
let toolsPaneHome: { parent: HTMLElement; next: Node | null } | null = null;

/** Re-point where the tools pane lands — the Settings accordion hosts it in
 *  the EXPANDED row, so the host changes per open. */
export function setConnectionsToolsHost(host: HTMLElement | null): void {
  adoptedToolsHost = host;
}

/** Move the tools pane to the adopted host (open) or back home (close). */
function placeToolsPane(open: boolean): void {
  const pane = document.querySelector<HTMLElement>(".conn-tools-pane");
  if (!pane || !adoptedToolsHost) return;
  const explainer = document.getElementById("app-conns-explainer");
  if (open) {
    if (!toolsPaneHome && pane.parentElement) toolsPaneHome = { parent: pane.parentElement, next: pane.nextSibling };
    adoptedToolsHost.appendChild(pane);
    adoptedToolsHost.classList.remove("hidden");
    explainer?.classList.add("hidden");
  } else {
    if (toolsPaneHome) toolsPaneHome.parent.insertBefore(pane, toolsPaneHome.next);
    adoptedToolsHost.classList.add("hidden");
    explainer?.classList.remove("hidden");
  }
}

export function adoptConnectionsInto(host: HTMLElement, requiredSlugs: string[], toolsHost?: HTMLElement | null): void {
  // The catalog MODAL rides along too — left home it opens inside the hidden
  // Connections section, i.e. invisibly (his bug, 2026-08-25).
  const nodes = ["connections-toolbar", "connections-list", "conn-detail", "conn-modal"]
    .map((id) => document.getElementById(id))
    .filter((n): n is HTMLElement => !!n);
  if (nodes.length !== 4) return;
  if (!adoptedHomes) adoptedHomes = nodes.map((n) => ({ n, parent: n.parentElement, next: n.nextSibling }));
  host.append(...nodes);
  adoptedToolsHost = toolsHost ?? null;
  requiredFilter = requiredSlugs.map((x) => x.toLowerCase());
  closeConnDetail();
  void loadConnections();
}

export function releaseConnections(): void {
  placeToolsPane(false);
  adoptedToolsHost = null;
  toolsPaneHome = null;
  requiredFilter = null;
  if (!adoptedHomes) return;
  for (const { n, parent, next } of adoptedHomes) parent?.insertBefore(n, next);
  adoptedHomes = null;
}

export async function loadConnections(): Promise<void> {
  listEl.innerHTML = `<div class="crud-empty">Loading…</div>`;
  // Which AXIS the platform page shows depends on the role (his ruling,
  // 2026-09-12) — resolved WITH the data reads, before the first paint: a
  // fire-and-forget here would race renderConnectionsList and flash the
  // wrong axis.
  const account = await window.glyphh.getAccountInfo?.().catch(() => null);
  isAdminUser = !!account?.role && ["org_admin", "admin", "super_admin"].includes(account.role);
  // The org × role policy can change with any heartbeat, so re-check it on
  // every load — it hides the "+ Custom MCP" button AND the custom cards.
  const [res, custom, gate] = await Promise.all([
    window.glyphh.connectionsList(),
    window.glyphh.mcpConnectionsList().catch(() => ({ ok: false, connections: [] })),
    window.glyphh.mcpCustomAllowed().catch(() => ({ allowed: false })),
  ]);
  connections = res.ok ? res.connections : [];
  customServers = custom.ok ? custom.connections : [];
  customAllowed = !!gate.allowed;
  document.getElementById("conn-add-custom-btn")!.classList.toggle("hidden", !customAllowed);
  renderConnectionsList();
  // Real Pipedream catalog icons, then re-render.
  void primeConnectedIcons(connections.map(connIconApp), renderConnectionsList);
  // Anyone else painting the same data (Settings → Connections) refreshes
  // here — ONE load path, so a connect/install/delete lands everywhere.
  for (const cb of changeHooks) { try { cb(); } catch { /* a broken listener is not this page's problem */ } }
}

/** Subscribe to "the connection set changed" — fired after every load. */
const changeHooks = new Set<() => void>();
export function onConnectionsChanged(cb: () => void): void { changeHooks.add(cb); }

function renderConnectionsList(): void {
  const q = connSearch.trim().toLowerCase();
  // PLATFORM, split by role (his ruling, 2026-09-12): the ADMIN manages the
  // org-level connections; a MEMBER sees just THEIR connections — the org's
  // shared ones never render as theirs to manage. Desktop keeps both axes.
  const onPlatform = document.body.classList.contains("platform-shell");
  const isOrg = (c: unknown): boolean =>
    (c as { org?: boolean }).org === true || (c as { kind?: string }).kind === "org";
  const orgOnly = onPlatform
    ? (isAdminUser ? connections.filter(isOrg) : connections.filter((c) => !isOrg(c)))
    : connections;
  const scoped = requiredFilter
    ? orgOnly.filter((c) => requiredFilter!.includes(c.appSlug.toLowerCase()))
    : orgOnly;
  const items = q
    ? scoped.filter((c) => (c.label || c.appName).toLowerCase().includes(q) || c.appSlug.toLowerCase().includes(q))
    : scoped;
  // While ADOPTED into an app tab, a required-but-unconnected slug is the row
  // the user must act on — a Connect card, straight into the same flow the
  // catalog uses.
  const missingRequired = (requiredFilter ?? []).filter(
    (slug) => !connections.some((c) => c.appSlug.toLowerCase() === slug) && (!q || slug.includes(q)),
  );

  // Role-gated: when custom MCP is disallowed the cards disappear entirely —
  // the rows stay on the server (inert; the catalog and call path exclude
  // them), so they reappear if the policy is turned back on.
  const visibleCustom = customAllowed && !requiredFilter ? customServers : [];
  const customItems = q
    ? visibleCustom.filter((c) => c.name.toLowerCase().includes(q) || c.slug.toLowerCase().includes(q))
    : visibleCustom;

  // Same wrapper class the Apps list uses — the grid CSS is `.app-list-wrap .app-grid`.
  // Preserve the hidden state: an async icon re-render must not pop the list
  // back over an open detail view.
  const wasHidden = listEl.classList.contains("hidden") || !detailEl.classList.contains("hidden");
  listEl.className = wasHidden ? "app-list-wrap hidden" : "app-list-wrap";
  listEl.innerHTML = "";
  if (items.length === 0 && customItems.length === 0 && missingRequired.length === 0) {
    listEl.innerHTML = requiredFilter
      ? '<div class="crud-empty">This app requires no connections.</div>'
      : connections.length === 0 && visibleCustom.length === 0
        ? '<div class="crud-empty">No connections yet — click “+ New” to connect an account.</div>'
        : `<div class="crud-empty">No connections match your search.</div>`;
    return;
  }

  // Same grid-of-tiles as the Apps tab (.app-grid / .app-card).
  const grid = document.createElement("div");
  grid.className = "app-grid";
  for (const c of items) {
    const card = document.createElement("div");
    card.className = "app-card";
    // Governance beats cosmetics: a connected-but-BLOCKED connection looks
    // healthy while every agent call fails — say so, right on the card.
    const blocked = c.agentAllowed === false;
    const toolless = c.agentAllowed === true && c.agentAvailable! > 0 && c.agentTools === 0;
    const badge = c.healthy === false
      ? `<span class="app-card-badge badge-connection">Reconnect</span>`
      : blocked
        ? `<span class="app-card-badge badge-blocked">Blocked by policy</span>`
        : toolless
          ? `<span class="app-card-badge badge-blocked">All tools blocked</span>`
          : (c.org ? `<span class="app-card-badge badge-connection">Org</span>` : "");
    const subtitle = blocked
      ? "Not allowed for your workspace"
      : toolless
        ? "Every tool is blocked for you"
        : c.agentAllowed === true && c.agentTools! < c.agentAvailable!
          ? `${c.agentTools} of ${c.agentAvailable} tools allowed`
          : (c.org ? "Org connection" : esc(c.appName));
    card.innerHTML = `
      ${badge}
      <div class="app-card-icon">${appIconInner(connIconApp(c), c.appName, "app-card-initial")}</div>
      <div class="app-card-name">${esc(c.label || c.appName)}</div>
      <div class="app-card-id">${subtitle}</div>`;
    card.addEventListener("click", () => void openConnDetail(c.id));
    attachCardControls(card, {
      enabled: (c as { enabled?: boolean }).enabled !== false,
      // The org admin governs BOTH scopes (his rule); a member only their own.
      canToggle: isAdminUser || !c.org,
      onToggle: async (on) => {
        const r = await window.glyphh.connectionSetEnabled?.(c.id, on, !!c.org || isAdminUser);
        if (!r?.ok) { void loadConnections(); return; }
        void loadConnections();
      },
      deleteWhat: c.label || c.appName,
      onDelete: async () => {
        const r = await window.glyphh.connectionDisconnect(c.id);
        if (r?.ok) void loadConnections();
      },
    });
    grid.appendChild(card);
  }
  for (const c of customItems) {
    const card = document.createElement("div");
    card.className = "app-card";
    const initial = (c.name || "?").charAt(0).toUpperCase();
    const icon = c.iconUrl
      ? `<img src="${esc(c.iconUrl)}" style="width:100%;height:100%;object-fit:contain;border-radius:8px;" onerror="this.outerHTML='<span class=\\'app-card-initial\\'>${initial}</span>'" />`
      : `<span class="app-card-initial">${esc(initial)}</span>`;
    card.innerHTML = `
      ${c.enabled ? "" : `<span class="app-card-badge badge-connection">Disabled</span>`}
      <div class="app-card-icon">${icon}</div>
      <div class="app-card-name">${esc(c.name)}</div>
      <div class="app-card-id">${c.kind === "org" ? "Org connection" : "Custom MCP"}</div>`;
    card.addEventListener("click", () => openCustomDetail(c.slug));
    attachCardControls(card, {
      enabled: c.enabled,
      canToggle: isAdminUser || c.kind !== "org",
      onToggle: async (on) => {
        const r = await window.glyphh.mcpConnectionsUpdate(c.slug, { enabled: on });
        if (!r?.ok) { void loadConnections(); return; }
        void loadConnections();
      },
      deleteWhat: c.name,
      onDelete: async () => {
        const r = await window.glyphh.mcpConnectionsDelete(c.slug);
        if (r?.ok) void loadConnections();
      },
    });
    grid.appendChild(card);
  }
  for (const slug of missingRequired) {
    const card = document.createElement("div");
    card.className = "app-card";
    const initial = slug.charAt(0).toUpperCase();
    card.innerHTML = `
      <span class="app-card-badge badge-connection">Required</span>
      <div class="app-card-icon"><span class="app-card-initial">${esc(initial)}</span></div>
      <div class="app-card-name">${esc(slug)}</div>
      <div class="app-card-id">Not connected — click to connect</div>`;
    card.addEventListener("click", () => {
      void (async () => {
        const nameEl = card.querySelector(".app-card-id")!;
        nameEl.textContent = "Connecting…";
        const beforeIds = new Set(connections.map((c) => c.id));
        const result = await window.glyphh.connectorsConnect?.(slug);
        if (!result?.ok) { nameEl.textContent = result?.error || "Failed"; setTimeout(() => { nameEl.textContent = "Not connected — click to connect"; }, 2500); return; }
        showAppOverlay("Connecting");
        try {
          await loadConnections();
          const fresh = connections.filter((c) => !beforeIds.has(c.id));
          const target = fresh.find((c) => c.appSlug.toLowerCase() === slug) || fresh[0];
          if (target) await openConnDetail(target.id);
        } finally { hideAppOverlay(); }
      })();
    });
    grid.appendChild(card);
  }
  listEl.appendChild(grid);
}

export async function openConnDetail(id: string): Promise<void> {
  const c = connections.find((x) => x.id === id);
  if (!c) return;
  currentConnId = id;
  currentCustomSlug = null;
  customMode = null;
  customStatusEl.classList.add("hidden");
  customConfigEl.classList.add("hidden");
  // Org-shared connections are managed by an admin (Configure → Connections):
  // no rename or disconnect here. Tools are different — the member cap is the
  // LAST narrowing layer (advertised ∩ org ∩ workspace ∩ member), so hiding a
  // tool from your own agents is always yours to do, org connection or not.
  const isOrg = !!c.org;
  disconnectBtn.classList.toggle("hidden", isOrg);
  disconnectBtn.textContent = "Disconnect";
  nameInput.disabled = isOrg;
  saveBtn.classList.toggle("hidden", isOrg);
  customToggle.classList.toggle("hidden", isOrg);
  setBtnBusy(saveBtn, false, "Save");
  detailErr.classList.add("hidden");
  listEl.classList.add("hidden");
  document.getElementById("connections-toolbar")?.classList.add("hidden");
  detailEl.classList.remove("hidden");
  placeToolsPane(true);

  detailHead.innerHTML = `
    <div class="app-card-icon">${appIconInner(connIconApp(c), c.appName, "app-card-initial")}</div>
    <div class="edit-head-name">${esc(c.label || c.appName)}<span class="edit-head-slug">${isOrg ? "Org connection · " : ""}${esc(c.appSlug)}</span></div>`;
  nameInput.value = c.label || c.appName;   // default to the Pipedream app name
  nameInput.placeholder = c.appName;

  // Scope (his rule, 2026-09-13): the form asks org vs personal, under the
  // Name — admins only; the server refuses a member regardless.
  const scopeRow = document.getElementById("conn-scope-row");
  const scopeToggle = document.getElementById("conn-scope-toggle") as HTMLInputElement | null;
  if (scopeRow && scopeToggle) {
    scopeRow.classList.toggle("hidden", !isAdminUser);
    scopeToggle.checked = isOrg;
    scopeToggle.onchange = () => {
      void (async () => {
        const to = scopeToggle.checked ? "org" : "personal";
        const r = await window.glyphh.connectionSetScope?.(c.id, to);
        if (!r?.ok) {
          scopeToggle.checked = isOrg;
          detailErr.textContent = r?.error || "Couldn't change the connection's scope.";
          detailErr.classList.remove("hidden");
          return;
        }
        await loadConnections();
        void openConnDetail(c.id);
      })();
    };
  }

  document.getElementById("conn-tools-select-all-wrap")?.classList.add("hidden");
  toolsEl.innerHTML = `<div class="crud-empty">Loading tools…</div>`;
  const res = await window.glyphh.connectionToolsList(id);
  if (!res.ok) { toolsEl.innerHTML = `<div class="crud-empty">Couldn't load tools.</div>`; return; }
  if (res.tools.length === 0) { toolsEl.innerHTML = `<div class="crud-empty">This app publishes no tools yet.</div>`; return; }

  toolsEl.innerHTML = "";
  for (const t of res.tools) {
    // The ROLES tools grammar: toggle right, two-line clamped description.
    const row = document.createElement("div");
    row.className = "conn-tool-row set-pref-row ws-tool-line";
    const text = document.createElement("div");
    text.className = "set-pref-text";
    const title = document.createElement("div");
    title.className = "set-pref-title";
    title.textContent = t.name;
    text.appendChild(title);
    if (t.description) {
      const d = document.createElement("div");
      d.className = "set-pref-desc";
      d.textContent = t.description;
      text.appendChild(d);
      text.addEventListener("click", () => row.classList.toggle("expanded"));
    }
    const sw = document.createElement("label");
    sw.className = "settings-toggle ws-model-allow";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "conn-tool-check";
    box.dataset.tool = t.name;
    box.checked = !t.hidden;
    const knob = document.createElement("span");
    knob.className = "toggle-switch";
    sw.append(box, knob);
    row.append(text, sw);
    toolsEl.appendChild(row);
  }
  // Toggling any checkbox persists the full hidden set.
  toolsEl.querySelectorAll<HTMLInputElement>(".conn-tool-check").forEach((cb) => {
    cb.addEventListener("change", () => { syncToolsSelectAll(); void saveHiddenTools(); });
  });
  wireToolsSelectAll(saveHiddenTools);
}


/**
 * The tool list's "Select all" — one control for both tool panes (a Pipedream
 * connection and a custom MCP server render into the same container).
 *
 * `save` differs per pane, so the caller hands in the persister it already uses;
 * the checkbox itself only ever flips the rows and re-saves the whole set, exactly
 * like a manual toggle does.
 */
function wireToolsSelectAll(save: () => void | Promise<void>): void {
  const box = document.getElementById("conn-tools-select-all") as HTMLInputElement | null;
  const wrap = document.getElementById("conn-tools-select-all-wrap");
  const boxes = () => Array.from(toolsEl.querySelectorAll<HTMLInputElement>(".conn-tool-check"));
  if (!box || !wrap) return;

  wrap.classList.toggle("hidden", boxes().length === 0);
  syncToolsSelectAll();

  // Re-wired per render (the pane is rebuilt each time), so replace the node to
  // drop the previous pane's listener rather than stacking a second save.
  const fresh = box.cloneNode(true) as HTMLInputElement;
  box.replaceWith(fresh);
  fresh.addEventListener("change", () => {
    for (const cb of boxes()) cb.checked = fresh.checked;
    syncToolsSelectAll();
    void save();
  });
}

/** Reflect the rows in the title-row master toggle; the hint carries the
 *  count (the switch has no text slot). */
function syncToolsSelectAll(): void {
  const box = document.getElementById("conn-tools-select-all") as HTMLInputElement | null;
  if (!box) return;
  const all = Array.from(toolsEl.querySelectorAll<HTMLInputElement>(".conn-tool-check"));
  const checked = all.filter((c) => c.checked).length;
  box.checked = all.length > 0 && checked === all.length;
  const hint = document.getElementById("conn-tools-hint");
  if (hint && all.length) {
    hint.textContent = `Turn a tool off to hide it — your AI won't see or be able to call it. ${checked} of ${all.length} exposed.`;
  }
}

async function saveHiddenTools(): Promise<void> {
  if (!currentConnId) return;
  const hidden = Array.from(toolsEl.querySelectorAll<HTMLInputElement>(".conn-tool-check"))
    .filter((cb) => !cb.checked)
    .map((cb) => cb.dataset.tool || "");
  const res = await window.glyphh.connectionToolsSet(currentConnId, hidden);
  if (res.ok && res.connection) {
    const c = connections.find((x) => x.id === currentConnId);
    if (c) c.hiddenTools = (res.connection as Conn).hiddenTools;
  }
}

export function closeConnDetail(): void {
  placeToolsPane(false);
  detailEl.classList.add("hidden");
  currentConnId = null;
  currentCustomSlug = null;
  customMode = null;
  customStatusEl.classList.add("hidden");
  customConfigEl.classList.add("hidden");
  disconnectBtn.classList.remove("hidden");
  disconnectBtn.textContent = "Disconnect";
  nameInput.disabled = false;
  saveBtn.classList.remove("hidden");
  customToggle.classList.remove("hidden");
  setBtnBusy(saveBtn, false, "Save");
  document.getElementById("connections-toolbar")?.classList.remove("hidden");
  listEl.classList.remove("hidden");
  renderConnectionsList();   // reflect any label change
}

// ── Custom MCP detail (the add + edit form) ───────────────

/** Open the detail split as the custom MCP form — "new" (blank) or "edit"
 *  (prefilled from a saved connection). The left column's edit-head is the
 *  page header in both modes. */
function openCustomForm(mode: "new" | "edit", c?: McpConn): void {
  document.getElementById("conn-scope-row")?.classList.add("hidden");
  customMode = mode;
  currentCustomSlug = mode === "edit" && c ? c.slug : null;
  currentConnId = null;
  detailErr.classList.add("hidden");
  listEl.classList.add("hidden");
  document.getElementById("connections-toolbar")?.classList.add("hidden");
  detailEl.classList.remove("hidden");
  placeToolsPane(true);
  customConfigEl.classList.remove("hidden");

  const urlInput = document.getElementById("conn-custom-url") as HTMLInputElement;
  const headersInput = document.getElementById("conn-custom-headers") as HTMLTextAreaElement;
  const headersHint = document.getElementById("conn-custom-headers-hint")!;

  if (mode === "new") {
    detailHead.innerHTML = `
      <div class="app-card-icon"><span class="app-card-initial">+</span></div>
      <div class="edit-head-name">New custom MCP connection<span class="edit-head-slug">a remote MCP server</span></div>`;
    nameInput.value = "";
    nameInput.disabled = false;
    saveBtn.classList.remove("hidden");
    customToggle.classList.remove("hidden");
    nameInput.placeholder = "My MCP server";
    urlInput.value = "";
    headersInput.value = "";
    headersInput.placeholder = "Authorization: Bearer sk-...";
    headersHint.classList.add("hidden");
    customStatusEl.classList.add("hidden");
    disconnectBtn.classList.add("hidden");
    setBtnBusy(saveBtn, false, "Add & Connect");
    toolsEl.innerHTML = `<div class="crud-empty">Add the connection to see its tools.</div>`;
    nameInput.focus();
    return;
  }

  const conn = c!;
  const isOrg = conn.kind === "org";
  const initial = (conn.name || "?").charAt(0).toUpperCase();
  const icon = conn.iconUrl
    ? `<img src="${esc(conn.iconUrl)}" style="width:100%;height:100%;object-fit:contain;border-radius:8px;" />`
    : `<span class="app-card-initial">${esc(initial)}</span>`;
  detailHead.innerHTML = `
    <div class="app-card-icon">${icon}</div>
    <div class="edit-head-name">${esc(conn.name)}<span class="edit-head-slug">${esc(conn.slug)}${isOrg ? " · published by your org" : ""}</span></div>`;
  nameInput.value = conn.name;
  nameInput.placeholder = conn.name;
  // Org-published connections are admin-owned: config is read-only here,
  // enable/disable is the admin's switch, and Save has nothing to save
  // (tool exposure below auto-saves). Remove = uninstall for this user.
  nameInput.disabled = isOrg;
  customConfigEl.classList.toggle("hidden", isOrg);
  saveBtn.classList.toggle("hidden", isOrg);
  customToggle.classList.toggle("hidden", isOrg);
  if (!isOrg) {
    urlInput.value = conn.url;
    headersInput.value = "";
    headersInput.placeholder = "leave blank to keep the saved headers";
    // Values are write-only — show WHICH headers are saved, never what's in them.
    if (conn.headerKeys.length) {
      headersHint.textContent = `Saved headers (values hidden): ${conn.headerKeys.join(", ")}. Enter new lines to replace them all.`;
      headersHint.classList.remove("hidden");
    } else {
      headersHint.classList.add("hidden");
    }
    customToggle.textContent = conn.enabled ? "Disable" : "Enable";
  }
  customStatusEl.classList.remove("hidden");
  disconnectBtn.classList.remove("hidden");
  disconnectBtn.textContent = "Remove";
  setBtnBusy(saveBtn, false, "Save");
  void loadCustomStatus(conn);
}

export function openCustomDetail(slug: string): void {
  document.getElementById("conn-scope-row")?.classList.add("hidden");
  const c = customServers.find((x) => x.slug === slug);
  if (c) openCustomForm("edit", c);
}

/** Live-check the connection (the server dials it) and fill status + tools. */
async function loadCustomStatus(c: McpConn): Promise<void> {
  if (!c.enabled) {
    customStatusText.textContent = "disabled";
    toolsEl.innerHTML = `<div class="crud-empty">Enable the connection to see its tools.</div>`;
    return;
  }
  customStatusText.textContent = "checking…";
  document.getElementById("conn-tools-select-all-wrap")?.classList.add("hidden");
  toolsEl.innerHTML = `<div class="crud-empty">Loading tools…</div>`;
  const res = await window.glyphh.mcpConnectionsTools(c.slug);
  if (currentCustomSlug !== c.slug) return;   // user navigated away meanwhile
  if (!res.ok) {
    customStatusText.textContent = `unreachable — ${res.error || "connection failed"}`;
    toolsEl.innerHTML = `<div class="crud-empty">Couldn't reach the server.</div>`;
    return;
  }
  customStatusText.textContent = `connected · ${res.tools.length} tool${res.tools.length === 1 ? "" : "s"}`;
  if (res.tools.length === 0) {
    toolsEl.innerHTML = `<div class="crud-empty">This server publishes no tools yet.</div>`;
    return;
  }
  // Same exposure UI as any connection: uncheck to hide a tool from the AI.
  toolsEl.innerHTML = "";
  for (const t of res.tools) {
    const row = document.createElement("div");
    row.className = "conn-tool-row set-pref-row ws-tool-line";
    const text = document.createElement("div");
    text.className = "set-pref-text";
    const title = document.createElement("div");
    title.className = "set-pref-title";
    title.textContent = t.name;
    text.appendChild(title);
    if (t.description) {
      const d = document.createElement("div");
      d.className = "set-pref-desc";
      d.textContent = t.description;
      text.appendChild(d);
      text.addEventListener("click", () => row.classList.toggle("expanded"));
    }
    const sw = document.createElement("label");
    sw.className = "settings-toggle ws-model-allow";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "conn-tool-check";
    box.dataset.tool = t.name;
    box.checked = !t.hidden;
    const knob = document.createElement("span");
    knob.className = "toggle-switch";
    sw.append(box, knob);
    row.append(text, sw);
    toolsEl.appendChild(row);
  }
  toolsEl.querySelectorAll<HTMLInputElement>(".conn-tool-check").forEach((cb) => {
    cb.addEventListener("change", () => { syncToolsSelectAll(); void saveCustomHiddenTools(); });
  });
  wireToolsSelectAll(saveCustomHiddenTools);
}

async function saveCustomHiddenTools(): Promise<void> {
  if (!currentCustomSlug) return;
  const hidden = Array.from(toolsEl.querySelectorAll<HTMLInputElement>(".conn-tool-check"))
    .filter((cb) => !cb.checked)
    .map((cb) => cb.dataset.tool || "");
  const res = await window.glyphh.mcpConnectionsUpdate(currentCustomSlug, { hiddenTools: hidden });
  if (res.ok) {
    const c = customServers.find((x) => x.slug === currentCustomSlug);
    if (c) c.hiddenTools = hidden;
  }
}

/** Parse the headers textarea: "Name: value" (or "Name=value"), one per
 *  line. Returns null when the box is blank (edit mode: keep saved values). */
function collectCustomHeaders(): Record<string, string> | null {
  const raw = (document.getElementById("conn-custom-headers") as HTMLTextAreaElement).value.trim();
  if (!raw) return null;
  const headers: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const sep = line.match(/[:=]/)?.index ?? -1;
    if (sep > 0) headers[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
  }
  return headers;
}

async function refreshCustomList(): Promise<void> {
  const r = await window.glyphh.mcpConnectionsList().catch(() => ({ ok: false as const, connections: [] }));
  if (r.ok) customServers = r.connections;
}

/** Save the custom form — create (server runs a connect test; the spinner
 *  waits on it) or update. Policy failures come back as server errors. */
async function saveCustomForm(): Promise<void> {
  const fail = (msg: string): void => { detailErr.textContent = msg; detailErr.classList.remove("hidden"); };
  detailErr.classList.add("hidden");

  const name = nameInput.value.trim();
  if (!name) { fail("Name is required."); nameInput.focus(); return; }
  const url = (document.getElementById("conn-custom-url") as HTMLInputElement).value.trim();
  if (!url) { fail("Remote MCP server URL is required."); return; }
  const headers = collectCustomHeaders();
  // Optional pre-registered OAuth client (Advanced). Blank = the server is
  // discovered + registered automatically on first connect (OAuth/PKCE).
  const oauthId = (document.getElementById("conn-oauth-id") as HTMLInputElement | null)?.value.trim();
  const oauthSecret = (document.getElementById("conn-oauth-secret") as HTMLInputElement | null)?.value.trim();
  const oauth = oauthId ? { clientId: oauthId, ...(oauthSecret ? { clientSecret: oauthSecret } : {}) } : undefined;

  if (customMode === "new") {
    setBtnBusy(saveBtn, true, "Connecting…");
    const res = await window.glyphh.mcpConnectionsCreate({ name, url, headers: headers ?? {}, ...(oauth ? { oauth } : {}) });
    if (!res.connection) {
      setBtnBusy(saveBtn, false, "Add & Connect");
      fail(res.error || "Couldn't create the connection.");
      return;
    }
    await refreshCustomList();
    openCustomDetail(res.connection.slug);   // edit mode: live status + tools (or the connect error)
    return;
  }

  if (customMode === "edit" && currentCustomSlug) {
    setBtnBusy(saveBtn, true, "Saving…");
    const fields: Record<string, unknown> = { name, url };
    if (headers) fields.headers = headers;   // blank box = keep saved values
    const res = await window.glyphh.mcpConnectionsUpdate(currentCustomSlug, fields);
    if (!res.ok) {
      setBtnBusy(saveBtn, false, "Save");
      fail(res.error || "Couldn't save the connection.");
      return;
    }
    await refreshCustomList();
    closeConnDetail();
  }
}

// ── Catalog modal ────────────────────────────────────────
// Org-published MCP connections ride at the top of the catalog — they're
// "just connections" to members: click = install, no OAuth dance.
let orgCatalog: Awaited<ReturnType<typeof window.glyphh.mcpConnectionsCatalog>>["connections"] = [];

function openCatalog(): void {
  modalEl.classList.remove("hidden");
  catalogSearch.value = "";
  catalogOffset = 0;
  orgCatalog = [];
  void window.glyphh.mcpConnectionsCatalog().then((r) => {
    orgCatalog = r.ok ? r.connections : [];
    // Re-render the first page so the org section appears once it's known.
    if (catalogOffset === 0 && !modalEl.classList.contains("hidden")) {
      void loadCatalog(catalogSearch.value.trim() || undefined);
    }
  }).catch(() => { /* offline — Pipedream section still renders */ });
  void loadCatalog();
  catalogSearch.focus();
}

function renderOrgCatalogSection(search?: string): void {
  const q = (search || "").toLowerCase();
  const items = orgCatalog.filter((c) => !c.installed &&
    (!q || c.name.toLowerCase().includes(q) || c.slug.toLowerCase().includes(q)));
  if (!items.length) return;
  const label = document.createElement("div");
  label.textContent = "From your organization";
  label.style.cssText = "grid-column:1/-1;font-size:11px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:.04em;margin:2px 2px 0;";
  catalogGrid.appendChild(label);
  for (const oc of items) {
    const card = document.createElement("div");
    card.className = "connector-card";
    const initial = (oc.name || "?").charAt(0).toUpperCase();
    card.innerHTML = `
      ${oc.iconUrl
        ? `<img class="connector-card-icon" src="${esc(oc.iconUrl)}" onerror="this.outerHTML='<span class=\\'connector-card-initial\\'>${initial}</span>'" />`
        : `<span class="connector-card-initial">${initial}</span>`}
      <div class="connector-card-info"><div class="connector-card-name">${esc(oc.name)}</div></div>`;
    card.addEventListener("click", async () => {
      const nameEl = card.querySelector(".connector-card-name")!;
      nameEl.textContent = "Installing…";
      const r = await window.glyphh.mcpConnectionsInstall(oc.slug);
      if (!r.ok) { nameEl.textContent = r.error || "Failed"; setTimeout(() => { nameEl.textContent = oc.name; }, 2500); return; }
      closeCatalog();
      await loadConnections();
      openCustomDetail(oc.slug);
    });
    catalogGrid.appendChild(card);
  }
  const all = document.createElement("div");
  all.textContent = "All apps";
  all.style.cssText = label.style.cssText;
  catalogGrid.appendChild(all);
}
function closeCatalog(): void { modalEl.classList.add("hidden"); }

async function loadCatalog(search?: string): Promise<void> {
  if (catalogOffset === 0) catalogGrid.innerHTML = `<div class="crud-empty" style="grid-column:1/-1;">Loading…</div>`;
  let apps: CatalogApp[] = [], hasMore = false;
  try { ({ apps, hasMore } = await window.glyphh.connectorsGetApps(search, catalogOffset)); }
  catch { catalogGrid.innerHTML = `<div class="crud-empty" style="grid-column:1/-1;">Couldn't load apps.</div>`; return; }

  if (catalogOffset === 0) {
    catalogGrid.innerHTML = "";
    renderOrgCatalogSection(search);
  }
  for (const app of apps) {
    const card = document.createElement("div");
    card.className = "connector-card";
    const initial = (app.name || "?").charAt(0).toUpperCase();
    card.innerHTML = `
      ${app.icon
        ? `<img class="connector-card-icon" src="${esc(app.icon)}" onerror="this.outerHTML='<span class=\\'connector-card-initial\\'>${initial}</span>'" />`
        : `<span class="connector-card-initial">${initial}</span>`}
      <div class="connector-card-info"><div class="connector-card-name">${esc(app.name)}</div></div>`;
    card.addEventListener("click", async () => {
      const nameEl = card.querySelector(".connector-card-name")!;
      nameEl.textContent = "Connecting…";
      const beforeIds = new Set(connections.map((c) => c.id));
      // Optional-chained: the web bridge stubs this (the OAuth connect flow is
      // desktop-driven) — an undefined result must read as a failure, not throw.
      const result = await window.glyphh.connectorsConnect?.(app.id);
      if (!result?.ok) { nameEl.textContent = result?.error || "Failed"; setTimeout(() => { nameEl.textContent = app.name; }, 2500); return; }
      // The overlay is already up (the "verifying" phase raised it). The SLOW
      // tail is here — reloading the list and fetching the detail screen's
      // tool catalog — so it stays up until the details actually paint.
      showAppOverlay("Connecting");
      try {
        closeCatalog();
        await loadConnections();
        // Open the just-connected connection so the user can name it + choose tools.
        const fresh = connections.filter((c) => !beforeIds.has(c.id));
        const target = fresh.find((c) => c.appSlug === app.id) || fresh[0];
        if (target) await openConnDetail(target.id);
      } finally {
        hideAppOverlay();
      }
    });
    catalogGrid.appendChild(card);
  }
  catalogMore.classList.toggle("hidden", !hasMore);
}

export function initConnections(): void {
  listEl = document.getElementById("connections-list")!;
  detailEl = document.getElementById("conn-detail")!;
  searchEl = document.getElementById("conn-search") as HTMLInputElement;
  nameInput = document.getElementById("conn-name") as HTMLInputElement;
  toolsEl = document.getElementById("conn-tools")!;
  detailHead = document.getElementById("conn-detail-head")!;
  detailErr = document.getElementById("conn-detail-error")!;
  modalEl = document.getElementById("conn-modal")!;
  catalogGrid = document.getElementById("conn-catalog-grid")!;
  catalogSearch = document.getElementById("conn-catalog-search") as HTMLInputElement;
  catalogMore = document.getElementById("conn-catalog-more")!;
  customStatusEl = document.getElementById("conn-custom-status")!;
  customStatusText = document.getElementById("conn-custom-status-text")!;
  customToggle = document.getElementById("conn-custom-toggle") as HTMLButtonElement;
  customConfigEl = document.getElementById("conn-custom-config")!;
  disconnectBtn = document.getElementById("conn-disconnect") as HTMLButtonElement;
  saveBtn = document.getElementById("conn-name-save") as HTMLButtonElement;

  // Connect-flow overlay — from the moment the OAuth window closes until the
  // connection is verified (or ruled cancelled), the standard spinner covers
  // the whole app so the handoff never looks dead.
  window.glyphh.onConnectorsConnectProgress?.((p) => {
    if (p.phase === "verifying") showAppOverlay("Connecting");
    // A SUCCESSFUL done keeps the overlay up — the connect click handler
    // drops it once the detail screen has painted (the slow tail lives
    // there). A failure drops it here so the error is immediately visible.
    else if (p.phase === "done" && !p.ok) hideAppOverlay();
  });

  searchEl.addEventListener("input", () => { connSearch = searchEl.value; renderConnectionsList(); });
  document.getElementById("conn-add-btn")?.addEventListener("click", openCatalog);
  document.getElementById("conn-add-custom-btn")!.addEventListener("click", () => openCustomForm("new"));
  document.getElementById("connections-refresh-btn")?.addEventListener("click", () => { void loadConnections(); });
  document.getElementById("conn-advanced-toggle")?.addEventListener("click", () => {
    const adv = document.getElementById("conn-advanced")!;
    const btn = document.getElementById("conn-advanced-toggle")!;
    const hidden = adv.classList.toggle("hidden");
    btn.textContent = hidden ? "▸ Advanced settings" : "▾ Advanced settings";
  });
  customToggle.addEventListener("click", async () => {
    if (!currentCustomSlug) return;
    const c = customServers.find((x) => x.slug === currentCustomSlug);
    if (!c) return;
    const enabling = !c.enabled;
    setBtnBusy(customToggle, true, enabling ? "Enabling…" : "Disabling…");
    detailErr.classList.add("hidden");
    const res = await window.glyphh.mcpConnectionsUpdate(c.slug, { enabled: enabling });
    if (!res.ok) {
      detailErr.textContent = res.error || "Couldn't update the connection.";
      detailErr.classList.remove("hidden");
    } else {
      c.enabled = enabling;
    }
    setBtnBusy(customToggle, false, c.enabled ? "Disable" : "Enable");
    void loadCustomStatus(c);
  });
  document.getElementById("conn-modal-close")!.addEventListener("click", closeCatalog);
  modalEl.querySelector(".conn-modal-backdrop")!.addEventListener("click", closeCatalog);
  document.getElementById("conn-detail-back")!.addEventListener("click", closeConnDetail);
  document.getElementById("conn-cancel")!.addEventListener("click", closeConnDetail);

  let catalogTimer: ReturnType<typeof setTimeout> | null = null;
  catalogSearch.addEventListener("input", () => {
    if (catalogTimer) clearTimeout(catalogTimer);
    catalogTimer = setTimeout(() => { catalogOffset = 0; void loadCatalog(catalogSearch.value.trim() || undefined); }, 200);
  });
  catalogMore.addEventListener("click", () => { catalogOffset += 30; void loadCatalog(catalogSearch.value.trim() || undefined); });

  saveBtn.addEventListener("click", async () => {
    if (customMode) { await saveCustomForm(); return; }   // custom MCP: full config form
    const name = nameInput.value.trim();
    if (!name) {   // a connection must have a name
      detailErr.textContent = "Name is required.";
      detailErr.classList.remove("hidden");
      nameInput.focus();
      return;
    }
    detailErr.classList.add("hidden");
    if (!currentConnId) return;
    const res = await window.glyphh.connectionRename(currentConnId, name);
    if (res.ok && res.connection) {
      const c = connections.find((x) => x.id === currentConnId);
      if (c) c.label = (res.connection as Conn).label;
      closeConnDetail();   // back to the list, like the app form
    } else {
      detailErr.textContent = res.error || "Couldn't save the name.";
      detailErr.classList.remove("hidden");
    }
  });

  // Disconnect (Pipedream) / Remove (custom MCP) — the app's standard confirm modal.
  const disc = disconnectBtn;
  disc.addEventListener("click", async () => {
    if (currentCustomSlug) {
      const c = customServers.find((x) => x.slug === currentCustomSlug);
      const label = c?.name || "this connection";
      if (!(await confirmAction({
        title: `Remove “${label}”?`,
        body: "Its tools disappear from your AI. The MCP server itself is not touched.",
        confirmLabel: "Remove",
        danger: true,
      }))) return;
      disc.disabled = true;
      const res = await window.glyphh.mcpConnectionsDelete(currentCustomSlug);
      disc.disabled = false;
      if (!res.ok) {
        detailErr.textContent = res.error || "Couldn't remove the connection.";
        detailErr.classList.remove("hidden");
        return;
      }
      closeConnDetail();
      await loadConnections();
      return;
    }
    if (!currentConnId) return;
    const c = connections.find((x) => x.id === currentConnId);
    const label = c ? (c.label || c.appName) : "this connection";
    if (!(await confirmAction({
      title: `Disconnect “${label}”?`,
      body: "Your AI loses access to its tools until you reconnect the account.",
      confirmLabel: "Disconnect",
      danger: true,
    }))) return;
    disc.disabled = true;
    const res = await window.glyphh.connectionDisconnect(currentConnId);
    disc.disabled = false;
    if (!res.ok) {
      detailErr.textContent = res.error || "Couldn't disconnect.";
      detailErr.classList.remove("hidden");
      return;
    }
    closeConnDetail();
    await loadConnections();
  });
}
