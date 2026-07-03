/**
 * Connections section — first-class Connections (connected Pipedream accounts),
 * mirroring the Apps tab's look. The installed list uses the same crud-card
 * pattern; "+ New" opens a modal with the full Pipedream catalog (click one to
 * connect it). Each connection has a user-editable Name and a per-connection
 * tool-exposure list (uncheck to hide a tool from the AI).
 */

import { appIconInner, primeConnectedIcons } from "./app-icon.js";
import { confirmAction } from "./shared.js";

type Conn = Awaited<ReturnType<typeof window.yo.connectionsList>>["connections"][number];
type CatalogApp = Awaited<ReturnType<typeof window.yo.connectorsGetApps>>["apps"][number];

let connections: Conn[] = [];
let connSearch = "";
let currentConnId: string | null = null;
let catalogOffset = 0;

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function connIconApp(c: { accountId: string; appSlug: string }) {
  return { connection: { accountId: c.accountId, pipedreamSlug: c.appSlug } };
}

// DOM (resolved in initConnections)
let listEl: HTMLElement, detailEl: HTMLElement, searchEl: HTMLInputElement;
let nameInput: HTMLInputElement, toolsEl: HTMLElement, detailHead: HTMLElement, detailErr: HTMLElement;
let modalEl: HTMLElement, catalogGrid: HTMLElement, catalogSearch: HTMLInputElement, catalogMore: HTMLElement;

export async function loadConnections(): Promise<void> {
  listEl.innerHTML = `<div class="crud-empty">Loading…</div>`;
  const res = await window.yo.connectionsList();
  connections = res.ok ? res.connections : [];
  renderConnectionsList();
  // Real Pipedream catalog icons, then re-render.
  void primeConnectedIcons(connections.map(connIconApp), renderConnectionsList);
}

function renderConnectionsList(): void {
  const q = connSearch.trim().toLowerCase();
  const items = q
    ? connections.filter((c) => (c.label || c.appName).toLowerCase().includes(q) || c.appSlug.toLowerCase().includes(q))
    : connections;

  // Same wrapper class the Apps list uses — the grid CSS is `.app-list-wrap .app-grid`.
  // Preserve the hidden state: an async icon re-render must not pop the list
  // back over an open detail view.
  const wasHidden = listEl.classList.contains("hidden") || !detailEl.classList.contains("hidden");
  listEl.className = wasHidden ? "app-list-wrap hidden" : "app-list-wrap";
  listEl.innerHTML = "";
  if (items.length === 0) {
    listEl.innerHTML = connections.length === 0
      ? `<div class="crud-empty">No connections yet. Click “+ New” to connect an account.</div>`
      : `<div class="crud-empty">No connections match your search.</div>`;
    return;
  }

  // Same grid-of-tiles as the Apps tab (.app-grid / .app-card).
  const grid = document.createElement("div");
  grid.className = "app-grid";
  for (const c of items) {
    const card = document.createElement("div");
    card.className = "app-card";
    card.innerHTML = `
      ${c.healthy === false ? `<span class="app-card-badge badge-connection">Reconnect</span>` : ""}
      <div class="app-card-icon">${appIconInner(connIconApp(c), c.appName, "app-card-initial")}</div>
      <div class="app-card-name">${esc(c.label || c.appName)}</div>
      <div class="app-card-id">${esc(c.appName)}</div>`;
    card.addEventListener("click", () => void openConnDetail(c.id));
    grid.appendChild(card);
  }
  listEl.appendChild(grid);
}

async function openConnDetail(id: string): Promise<void> {
  const c = connections.find((x) => x.id === id);
  if (!c) return;
  currentConnId = id;
  detailErr.classList.add("hidden");
  listEl.classList.add("hidden");
  document.getElementById("connections-toolbar")?.classList.add("hidden");
  detailEl.classList.remove("hidden");

  detailHead.innerHTML = `
    <div class="app-card-icon">${appIconInner(connIconApp(c), c.appName, "app-card-initial")}</div>
    <div class="edit-head-name">${esc(c.label || c.appName)}<span class="edit-head-slug">${esc(c.appSlug)}</span></div>`;
  nameInput.value = c.label || c.appName;   // default to the Pipedream app name
  nameInput.placeholder = c.appName;

  toolsEl.innerHTML = `<div class="crud-empty">Loading tools…</div>`;
  const res = await window.yo.connectionToolsList(id);
  if (!res.ok) { toolsEl.innerHTML = `<div class="crud-empty">Couldn't load tools.</div>`; return; }
  if (res.tools.length === 0) { toolsEl.innerHTML = `<div class="crud-empty">This app publishes no tools yet.</div>`; return; }

  toolsEl.innerHTML = "";
  for (const t of res.tools) {
    const row = document.createElement("div");
    row.className = "conn-tool-row";
    // Checkbox = expose/hide. Description is collapsed by default inside a
    // <details> — click the tool name to expand it.
    row.innerHTML = `
      <input type="checkbox" class="conn-tool-check" data-tool="${esc(t.name)}" ${t.hidden ? "" : "checked"} title="Expose this tool to your AI" />
      ${t.description
        ? `<details class="conn-tool-details">
             <summary class="conn-tool-name">${esc(t.name)}</summary>
             <div class="conn-tool-desc">${esc(t.description)}</div>
           </details>`
        : `<span class="conn-tool-name conn-tool-name-flat">${esc(t.name)}</span>`}`;
    toolsEl.appendChild(row);
  }
  // Toggling any checkbox persists the full hidden set.
  toolsEl.querySelectorAll<HTMLInputElement>(".conn-tool-check").forEach((cb) => {
    cb.addEventListener("change", () => void saveHiddenTools());
  });
}

async function saveHiddenTools(): Promise<void> {
  if (!currentConnId) return;
  const hidden = Array.from(toolsEl.querySelectorAll<HTMLInputElement>(".conn-tool-check"))
    .filter((cb) => !cb.checked)
    .map((cb) => cb.dataset.tool || "");
  const res = await window.yo.connectionToolsSet(currentConnId, hidden);
  if (res.ok && res.connection) {
    const c = connections.find((x) => x.id === currentConnId);
    if (c) c.hiddenTools = (res.connection as Conn).hiddenTools;
  }
}

function closeConnDetail(): void {
  detailEl.classList.add("hidden");
  currentConnId = null;
  document.getElementById("connections-toolbar")?.classList.remove("hidden");
  listEl.classList.remove("hidden");
  renderConnectionsList();   // reflect any label change
}

// ── Catalog modal ────────────────────────────────────────
function openCatalog(): void {
  modalEl.classList.remove("hidden");
  catalogSearch.value = "";
  catalogOffset = 0;
  void loadCatalog();
  catalogSearch.focus();
}
function closeCatalog(): void { modalEl.classList.add("hidden"); }

async function loadCatalog(search?: string): Promise<void> {
  if (catalogOffset === 0) catalogGrid.innerHTML = `<div class="crud-empty" style="grid-column:1/-1;">Loading…</div>`;
  let apps: CatalogApp[] = [], hasMore = false;
  try { ({ apps, hasMore } = await window.yo.connectorsGetApps(search, catalogOffset)); }
  catch { catalogGrid.innerHTML = `<div class="crud-empty" style="grid-column:1/-1;">Couldn't load apps.</div>`; return; }

  if (catalogOffset === 0) catalogGrid.innerHTML = "";
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
      const result = await window.yo.connectorsConnect(app.id);
      if (!result.ok) { nameEl.textContent = result.error || "Failed"; setTimeout(() => { nameEl.textContent = app.name; }, 2500); return; }
      closeCatalog();
      await loadConnections();
      // Open the just-connected connection so the user can name it + choose tools.
      const fresh = connections.filter((c) => !beforeIds.has(c.id));
      const target = fresh.find((c) => c.appSlug === app.id) || fresh[0];
      if (target) void openConnDetail(target.id);
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

  searchEl.addEventListener("input", () => { connSearch = searchEl.value; renderConnectionsList(); });
  document.getElementById("conn-add-btn")!.addEventListener("click", openCatalog);
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

  document.getElementById("conn-name-save")!.addEventListener("click", async () => {
    if (!currentConnId) return;
    const name = nameInput.value.trim();
    if (!name) {   // a connection must have a name
      detailErr.textContent = "Name is required.";
      detailErr.classList.remove("hidden");
      nameInput.focus();
      return;
    }
    detailErr.classList.add("hidden");
    const res = await window.yo.connectionRename(currentConnId, name);
    if (res.ok && res.connection) {
      const c = connections.find((x) => x.id === currentConnId);
      if (c) c.label = (res.connection as Conn).label;
      closeConnDetail();   // back to the list, like the app form
    } else {
      detailErr.textContent = res.error || "Couldn't save the name.";
      detailErr.classList.remove("hidden");
    }
  });

  // Disconnect — the app's standard confirm modal.
  const disc = document.getElementById("conn-disconnect") as HTMLButtonElement;
  disc.addEventListener("click", async () => {
    if (!currentConnId) return;
    const c = connections.find((x) => x.id === currentConnId);
    const label = c ? (c.label || c.appName) : "this connection";
    if (!(await confirmAction(`Disconnect “${label}”? Your AI will lose access to its tools.`))) return;
    disc.disabled = true;
    const res = await window.yo.connectionDisconnect(currentConnId);
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
