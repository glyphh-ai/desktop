/**
 * Connections section — custom MCP servers, mirroring the Apps tab's look.
 * The list uses the same crud-card pattern; "+ Custom MCP" opens the add form
 * (name, remote URL, optional OAuth client + headers). Each saved server has
 * a detail with its live status, an enable/disable switch and a per-server
 * tool-exposure list (uncheck to hide a tool from the AI).
 */

import { confirmAction } from "./shared.js";
import { openRowMenu, ROW_MENU_ICONS } from "./lib-editor.js";

type McpConn = Awaited<ReturnType<typeof window.glyphh.mcpConnectionsList>>["connections"][number];

// The servers live in the local store (main/mcp-connections.ts), which dials
// each endpoint and holds the write-only auth headers.
let customServers: McpConn[] = [];
let connSearch = "";
let currentCustomSlug: string | null = null;
// "new" = the + Custom MCP form; "edit" = a saved server's detail.
let customMode: "new" | "edit" | null = null;

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A server's tile art: its own icon when it has one, else the initial. */
function serverIcon(c: McpConn): string {
  const initial = esc((c.name || "?").charAt(0).toUpperCase());
  if (!c.iconUrl) return `<span class="app-card-initial">${initial}</span>`;
  return `<img src="${esc(c.iconUrl)}" style="width:100%;height:100%;object-fit:contain;border-radius:8px;" onerror="this.outerHTML='<span class=\\'app-card-initial\\'>${initial}</span>'" />`;
}

/** The card's corner controls (his rule, 2026-09-13): the standard BARE
 *  toggle + the three-dot kebab, far right. Delete rides the kebab and opens
 *  the app-standard confirm dialog. Clicks never open the card underneath. */
function attachCardControls(card: HTMLElement, opts: {
  enabled: boolean;
  onToggle: (on: boolean) => Promise<void>;
  deleteWhat: string; onDelete: () => Promise<void>;
}): void {
  const corner = document.createElement("div");
  corner.className = "app-card-controls";
  corner.style.cssText = "position:absolute;top:8px;right:8px;display:flex;align-items:center;gap:4px;z-index:2;";
  const sw = document.createElement("label");
  sw.className = "settings-toggle ws-model-allow";
  sw.innerHTML = `<input type="checkbox" ${opts.enabled ? "checked" : ""} /><span class="toggle-switch"></span>`;
  sw.addEventListener("click", (e) => e.stopPropagation());
  sw.querySelector("input")!.addEventListener("change", (e) => {
    void opts.onToggle((e.target as HTMLInputElement).checked);
  });
  corner.appendChild(sw);
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
            body: "Its tools disappear from your AI. The MCP server itself is not touched.",
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
let removeBtn: HTMLButtonElement, saveBtn: HTMLButtonElement;

/** Swap a button into/out of a busy state with an inline spinner. */
function setBtnBusy(btn: HTMLButtonElement, busy: boolean, label: string): void {
  btn.disabled = busy;
  btn.innerHTML = busy ? `<span class="btn-spinner"></span>${esc(label)}` : esc(label);
}

export async function loadConnections(): Promise<void> {
  listEl.innerHTML = `<div class="crud-empty">Loading…</div>`;
  const custom = await window.glyphh.mcpConnectionsList().catch(() => ({ ok: false, connections: [] as McpConn[] }));
  customServers = custom.ok ? custom.connections : [];
  renderConnectionsList();
  // Anyone else painting the same data (Settings → Connections) refreshes
  // here — ONE load path, so an add/edit/delete lands everywhere.
  for (const cb of changeHooks) { try { cb(); } catch { /* a broken listener is not this page's problem */ } }
}

/** Subscribe to "the connection set changed" — fired after every load. */
const changeHooks = new Set<() => void>();
export function onConnectionsChanged(cb: () => void): void { changeHooks.add(cb); }

function renderConnectionsList(): void {
  const q = connSearch.trim().toLowerCase();
  const items = q
    ? customServers.filter((c) => c.name.toLowerCase().includes(q) || c.slug.toLowerCase().includes(q))
    : customServers;

  // Same wrapper class the Apps list uses — the grid CSS is `.app-list-wrap .app-grid`.
  // Preserve the hidden state: a re-render must not pop the list back over
  // an open detail view.
  const wasHidden = listEl.classList.contains("hidden") || !detailEl.classList.contains("hidden");
  listEl.className = wasHidden ? "app-list-wrap hidden" : "app-list-wrap";
  listEl.innerHTML = "";
  if (items.length === 0) {
    listEl.innerHTML = customServers.length === 0
      ? '<div class="crud-empty">No connections yet — click “+ Custom MCP” to add an MCP server.</div>'
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
      ${c.enabled ? "" : `<span class="app-card-badge badge-connection">Disabled</span>`}
      <div class="app-card-icon">${serverIcon(c)}</div>
      <div class="app-card-name">${esc(c.name)}</div>
      <div class="app-card-id">Custom MCP</div>`;
    card.addEventListener("click", () => openCustomDetail(c.slug));
    attachCardControls(card, {
      enabled: c.enabled,
      onToggle: async (on) => {
        // Either way the list re-reads: a refused switch snaps back.
        await window.glyphh.mcpConnectionsUpdate(c.slug, { enabled: on }).catch(() => null);
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
  listEl.appendChild(grid);
}

/**
 * The tool list's "Select all": the checkbox only ever flips the rows and
 * re-saves the whole set through `save`, exactly like a manual toggle does.
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

export function closeConnDetail(): void {
  detailEl.classList.add("hidden");
  currentCustomSlug = null;
  customMode = null;
  customStatusEl.classList.add("hidden");
  setBtnBusy(saveBtn, false, "Save");
  document.getElementById("connections-toolbar")?.classList.remove("hidden");
  listEl.classList.remove("hidden");
  renderConnectionsList();   // reflect any name change
}

// ── Custom MCP detail (the add + edit form) ───────────────

/** Open the detail split as the custom MCP form — "new" (blank) or "edit"
 *  (prefilled from a saved server). The left column's edit-head is the page
 *  header in both modes. */
function openCustomForm(mode: "new" | "edit", c?: McpConn): void {
  customMode = mode;
  currentCustomSlug = mode === "edit" && c ? c.slug : null;
  detailErr.classList.add("hidden");
  listEl.classList.add("hidden");
  document.getElementById("connections-toolbar")?.classList.add("hidden");
  detailEl.classList.remove("hidden");

  const urlInput = document.getElementById("conn-custom-url") as HTMLInputElement;
  const headersInput = document.getElementById("conn-custom-headers") as HTMLTextAreaElement;
  const headersHint = document.getElementById("conn-custom-headers-hint")!;
  const oauthId = document.getElementById("conn-oauth-id") as HTMLInputElement | null;
  const oauthSecret = document.getElementById("conn-oauth-secret") as HTMLInputElement | null;
  // A pre-registered OAuth client is set when the server is added (the
  // store keeps it with the secrets and an update does not change it), so
  // the edit form leaves those fields out rather than offering a no-op.
  if (oauthId) oauthId.value = "";
  if (oauthSecret) oauthSecret.value = "";
  document.getElementById("conn-oauth-fields")?.classList.toggle("hidden", mode === "edit");

  if (mode === "new") {
    detailHead.innerHTML = `
      <div class="app-card-icon"><span class="app-card-initial">+</span></div>
      <div class="edit-head-name">New custom MCP connection<span class="edit-head-slug">a remote MCP server</span></div>`;
    nameInput.value = "";
    nameInput.placeholder = "My MCP server";
    urlInput.value = "";
    headersInput.value = "";
    headersInput.placeholder = "Authorization: Bearer sk-...";
    headersHint.classList.add("hidden");
    customStatusEl.classList.add("hidden");
    removeBtn.classList.add("hidden");
    setBtnBusy(saveBtn, false, "Add & Connect");
    document.getElementById("conn-tools-select-all-wrap")?.classList.add("hidden");
    toolsEl.innerHTML = `<div class="crud-empty">Add the connection to see its tools.</div>`;
    nameInput.focus();
    return;
  }

  const conn = c!;
  detailHead.innerHTML = `
    <div class="app-card-icon">${serverIcon(conn)}</div>
    <div class="edit-head-name">${esc(conn.name)}<span class="edit-head-slug">${esc(conn.slug)}</span></div>`;
  nameInput.value = conn.name;
  nameInput.placeholder = conn.name;
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
  customStatusEl.classList.remove("hidden");
  removeBtn.classList.remove("hidden");
  setBtnBusy(saveBtn, false, "Save");
  void loadCustomStatus(conn);
}

export function openCustomDetail(slug: string): void {
  const c = customServers.find((x) => x.slug === slug);
  if (c) openCustomForm("edit", c);
}

/** Live-check the server (main dials it) and fill status + tools. */
async function loadCustomStatus(c: McpConn): Promise<void> {
  document.getElementById("conn-tools-select-all-wrap")?.classList.add("hidden");
  if (!c.enabled) {
    customStatusText.textContent = "disabled";
    toolsEl.innerHTML = `<div class="crud-empty">Enable the connection to see its tools.</div>`;
    return;
  }
  customStatusText.textContent = "checking…";
  toolsEl.innerHTML = `<div class="crud-empty">Loading tools…</div>`;
  const res = await window.glyphh.mcpConnectionsTools(c.slug)
    .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err), tools: [] }));
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
  // Uncheck to hide a tool from the AI. The ROLES tools grammar: toggle
  // right, two-line clamped description.
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
  const slug = currentCustomSlug;
  const hidden = Array.from(toolsEl.querySelectorAll<HTMLInputElement>(".conn-tool-check"))
    .filter((cb) => !cb.checked)
    .map((cb) => cb.dataset.tool || "");
  const res = await window.glyphh.mcpConnectionsUpdate(slug, { hiddenTools: hidden })
    .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  if (!res.ok) {
    detailErr.textContent = res.error || "Couldn't save the tool list.";
    detailErr.classList.remove("hidden");
    return;
  }
  const c = customServers.find((x) => x.slug === slug);
  if (c) c.hiddenTools = hidden;
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

/** Save the custom form — create (main runs a connect test; the spinner
 *  waits on it) or update. */
async function saveCustomForm(): Promise<void> {
  const fail = (msg: string): void => { detailErr.textContent = msg; detailErr.classList.remove("hidden"); };
  detailErr.classList.add("hidden");

  const name = nameInput.value.trim();
  if (!name) { fail("Name is required."); nameInput.focus(); return; }
  const url = (document.getElementById("conn-custom-url") as HTMLInputElement).value.trim();
  if (!url) { fail("Remote MCP server URL is required."); return; }
  if (!/^https?:\/\//i.test(url)) { fail("The server URL must start with http:// or https://."); return; }
  const headers = collectCustomHeaders();
  // Optional pre-registered OAuth client (Advanced). Blank = the server is
  // discovered + registered automatically on first connect (OAuth/PKCE).
  const oauthId = (document.getElementById("conn-oauth-id") as HTMLInputElement | null)?.value.trim();
  const oauthSecret = (document.getElementById("conn-oauth-secret") as HTMLInputElement | null)?.value.trim();
  const oauth = customMode === "new" && oauthId ? { clientId: oauthId, ...(oauthSecret ? { clientSecret: oauthSecret } : {}) } : undefined;

  if (customMode === "new") {
    setBtnBusy(saveBtn, true, "Connecting…");
    const res = await window.glyphh.mcpConnectionsCreate({ name, url, headers: headers ?? {}, ...(oauth ? { oauth } : {}) })
      .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err), connection: undefined }));
    if (!res.connection) {
      setBtnBusy(saveBtn, false, "Add & Connect");
      fail(res.error || "Couldn't create the connection.");
      return;
    }
    await loadConnections();
    openCustomDetail(res.connection.slug);   // edit mode: live status + tools (or the connect error)
    return;
  }

  if (customMode === "edit" && currentCustomSlug) {
    setBtnBusy(saveBtn, true, "Saving…");
    const fields: Record<string, unknown> = { name, url };
    if (headers) fields.headers = headers;   // blank box = keep saved values
    const res = await window.glyphh.mcpConnectionsUpdate(currentCustomSlug, fields)
      .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    if (!res.ok) {
      setBtnBusy(saveBtn, false, "Save");
      fail(res.error || "Couldn't save the connection.");
      return;
    }
    await refreshCustomList();
    closeConnDetail();
    void loadConnections();
  }
}

export function initConnections(): void {
  listEl = document.getElementById("connections-list")!;
  detailEl = document.getElementById("conn-detail")!;
  searchEl = document.getElementById("conn-search") as HTMLInputElement;
  nameInput = document.getElementById("conn-name") as HTMLInputElement;
  toolsEl = document.getElementById("conn-tools")!;
  detailHead = document.getElementById("conn-detail-head")!;
  detailErr = document.getElementById("conn-detail-error")!;
  customStatusEl = document.getElementById("conn-custom-status")!;
  customStatusText = document.getElementById("conn-custom-status-text")!;
  customToggle = document.getElementById("conn-custom-toggle") as HTMLButtonElement;
  removeBtn = document.getElementById("conn-remove") as HTMLButtonElement;
  saveBtn = document.getElementById("conn-name-save") as HTMLButtonElement;

  searchEl.addEventListener("input", () => { connSearch = searchEl.value; renderConnectionsList(); });
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
    const res = await window.glyphh.mcpConnectionsUpdate(c.slug, { enabled: enabling })
      .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    if (!res.ok) {
      detailErr.textContent = res.error || "Couldn't update the connection.";
      detailErr.classList.remove("hidden");
    } else {
      c.enabled = enabling;
    }
    setBtnBusy(customToggle, false, c.enabled ? "Disable" : "Enable");
    void loadCustomStatus(c);
  });
  document.getElementById("conn-detail-back")!.addEventListener("click", closeConnDetail);
  document.getElementById("conn-cancel")!.addEventListener("click", closeConnDetail);
  saveBtn.addEventListener("click", () => { void saveCustomForm(); });

  // Remove — the app's standard confirm modal.
  removeBtn.addEventListener("click", async () => {
    if (!currentCustomSlug) return;
    const slug = currentCustomSlug;
    const c = customServers.find((x) => x.slug === slug);
    const label = c?.name || "this connection";
    if (!(await confirmAction({
      title: `Remove “${label}”?`,
      body: "Its tools disappear from your AI. The MCP server itself is not touched.",
      confirmLabel: "Remove",
      danger: true,
    }))) return;
    removeBtn.disabled = true;
    const res = await window.glyphh.mcpConnectionsDelete(slug)
      .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    removeBtn.disabled = false;
    if (!res.ok) {
      detailErr.textContent = res.error || "Couldn't remove the connection.";
      detailErr.classList.remove("hidden");
      return;
    }
    closeConnDetail();
    await loadConnections();
  });
}
