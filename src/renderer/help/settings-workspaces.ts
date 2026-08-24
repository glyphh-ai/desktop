/**
 * settings-workspaces.ts — Settings › Workspaces.
 *
 * Ported from the platform's configure/workspaces page and its data layer
 * (platform/app/lib/workspaces/hooks.js). A workspace IS the governance layer:
 * which models a member may reach, which shared and personal connections (down
 * to individual tools), whether they may add custom MCP, a rate limit, and a
 * credit cap. A workspace only ever NARROWS what the org already allows.
 *
 * The `limit<X>` flags map to a null-means-all convention exactly as the
 * platform's `toEdit` does: `limitModels === false` → `models: null` (every org
 * model); `true` → the explicit allow-list. Every patch builder below is the
 * platform's, field for field, so the two surfaces write identical records.
 *
 * Two departures from the platform, both this app's house style:
 *   - no Save button anywhere — General debounces like every other Settings
 *     field, and the rest commits on the click that changed it (the platform
 *     already live-saved its Connections tab for the same reason);
 *   - the "allow another connection" picker is an inline panel, not a modal.
 *
 * Member assignment is deliberately absent: members.list() doesn't return a
 * member's current workspace, so an assignment control could only ever show the
 * base workspace as its value while silently reassigning people. It lands when
 * the SDK returns orgRoleId.
 */

import { confirmAction, paginate, renderPaginationBar } from "./shared.js";
import { kebabCell, ROW_MENU_ICONS } from "./lib-editor.js";

const MICRO = 1_000_000;
/** Calendar-aligned periods — the interval defines the reset, no arbitrary dates. */
const PERIODS: Array<[number, string]> = [[1, "Daily"], [7, "Weekly"], [30, "Monthly"]];

interface Workspace {
  id: string;
  name: string;
  isBase: boolean;
  limitModels: boolean;
  allowedModels: string[];
  limitConnections: boolean;
  allowedConnections: string[];
  allowedConnectionTools: Record<string, string[]>;
  limitPersonalConnections: boolean;
  allowedPersonalConnections: string[];
  allowedPersonalConnectionTools: Record<string, string[]>;
  allowCustomMcp: boolean;
  creditsCap: number | null;
  capPeriodDays: number | null;
  rateLimitCalls: number | null;
  rateLimitWindowSeconds: number | null;
}

interface CatalogModel { key: string; kind: string; displayName: string; provider: string }
interface ConnMeta { name: string; icon: string | null }
interface Tool { name: string; description?: string }

/** The two connection sub-tabs are two independent field-sets on the record. */
const MODE = {
  personal: {
    list: "allowedPersonalConnections", limit: "limitPersonalConnections",
    tools: "allowedPersonalConnectionTools",
  },
  shared: {
    list: "allowedConnections", limit: "limitConnections",
    tools: "allowedConnectionTools",
  },
} as const;
type ConnMode = keyof typeof MODE;

// ── State ────────────────────────────────────────────────────────────────

let workspaces: Workspace[] = [];
let editing: Workspace | null = null;
let catalog: CatalogModel[] = [];
/** Shared connectors the org has (Pipedream apps + custom MCP), the universe
 *  the Shared sub-tab picks from. */
let orgConnectors: Array<{ id: string; name: string; icon: string | null; kind: string }> = [];
/** The ORG's tool cap — a workspace narrows within it, never past it. */
let orgToolCap: Record<string, string[]> = {};
const connMeta = new Map<string, ConnMeta>();
const slugTools = new Map<string, Tool[]>();
let connMode: ConnMode = "personal";
let selectedSlug: string | null = null;
let pickerResults: Array<{ id: string; name: string; icon: string | null }> = [];
let wired = false;
let statusTimer = 0;
let saveTimer = 0;
let pickerTimer = 0;
let hydrating = false;

const $ = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

// ── Transport ────────────────────────────────────────────────────────────
// TWO surfaces, like every other account panel (see settings-api.ts). On WEB
// the SDK handle IS the client; on the desktop the main process holds the SDK
// and the renderer reaches it over IPC.
//
// Order matters, and getting it wrong is silent: on web `window.glyphh` is a
// Proxy that fabricates an async function returning `undefined` for ANY name it
// doesn't know, so an IPC-first check "succeeds" with nothing and every read
// reports a bare "<method> failed".

interface SdkWorkspaces {
  workspaces?: {
    list?: () => Promise<Workspace[]>;
    create?: (input: Record<string, unknown>) => Promise<Workspace>;
    update?: (id: string, input: Record<string, unknown>) => Promise<Workspace>;
    delete?: (id: string) => Promise<void>;
  };
  models?: { available?: () => Promise<Array<{ id: string; kind: string; name: string; providerSlug: string }>> };
  connections?: {
    pipedreamList?: () => Promise<Array<{ appSlug: string; name?: string; appName?: string; icon?: string }>>;
    orgMcpList?: () => Promise<Array<{ slug: string; name: string; enabled?: boolean }>>;
    orgConnectionTools?: () => Promise<Record<string, string[]>>;
    appTools?: (slug: string) => Promise<{ tools?: Tool[] }>;
    apps?: (input: { search?: string; limit?: number }) => Promise<{ apps?: Array<{ id: string; name: string; icon?: string }> }>;
  };
}

const sdk = (): SdkWorkspaces | null =>
  (window as unknown as { glyphhSdk?: SdkWorkspaces }).glyphhSdk ?? null;

const ipcFns = (): Record<string, ((...a: never[]) => Promise<{ ok: boolean; data?: unknown; error?: string }>) | undefined> =>
  (window as unknown as { glyphh?: Record<string, ((...a: never[]) => Promise<{ ok: boolean; data?: unknown; error?: string }>) | undefined> }).glyphh ?? {};

/**
 * Run a read/write on whichever transport this surface has. `web` is tried
 * first and skipped when the SDK doesn't carry that resource; the IPC envelope
 * is `{ ok, data }`, and an `ok: false` is the server's own refusal, which the
 * caller shows rather than swallowing.
 */
async function via<T>(web: (s: SdkWorkspaces) => Promise<T> | undefined, method: string, ...args: unknown[]): Promise<T | null> {
  const handle = sdk();
  if (handle) {
    try {
      const p = web(handle);
      if (p) return (await p) ?? null;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }
  const fn = ipcFns()[method];
  if (!fn) { setError(`${method} is unavailable on this surface.`); return null; }
  try {
    const res = await (fn as (...a: unknown[]) => Promise<{ ok: boolean; data?: unknown; error?: string }>)(...args);
    if (!res || typeof res.ok !== "boolean") { setError(`${method} is unavailable on this surface.`); return null; }
    if (!res.ok) { setError(res.error || `${method} failed`); return null; }
    return (res.data as T) ?? null;
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err));
    return null;
  }
}

function setStatus(msg: string, kind: "success" | "error" | ""): void {
  const el = $("ws-status");
  if (!el) return;
  el.textContent = msg;
  el.className = `set-save-state${kind ? ` ${kind}` : ""}`;
  window.clearTimeout(statusTimer);
  if (kind === "success") statusTimer = window.setTimeout(() => { el.textContent = ""; }, 2500);
}

function setError(msg: string): void {
  const el = $("ws-error");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

// ── Reads ────────────────────────────────────────────────────────────────

const num = (s: string): number | null => {
  const t = String(s).trim();
  return t === "" ? null : Math.max(0, Math.floor(Number(t)) || 0);
};

/** A list field as the null-means-all convention: off ⇒ null (everything). */
function listOf(w: Workspace, mode: ConnMode): string[] | null {
  const f = MODE[mode];
  return (w[f.limit] as boolean) ? ((w[f.list] as string[]) ?? []) : null;
}
function toolsOf(w: Workspace, mode: ConnMode): Record<string, string[]> {
  return { ...((w[MODE[mode].tools] as Record<string, string[]>) || {}) };
}

const modelsOf = (w: Workspace): string[] | null => (w.limitModels ? (w.allowedModels ?? []) : null);

// ── Writes — one patch shape per tab, matching the platform's builders ────

async function patch(input: Record<string, unknown>, okMsg = "Saved"): Promise<boolean> {
  if (!editing) return false;
  setStatus("Saving…", "");
  const updated = await via<Workspace>((c) => c.workspaces?.update?.(editing!.id, input), "workspacesUpdate", editing.id, input);
  if (!updated) { setStatus("Not saved", "error"); return false; }
  // Reconcile with the server's row so the UI can't drift from what was stored.
  editing = updated;
  const idx = workspaces.findIndex((w) => w.id === updated.id);
  if (idx >= 0) workspaces[idx] = updated;
  setError("");
  setStatus(okMsg, "success");
  return true;
}

/** General — debounced, since it's typed into. */
function scheduleGeneral(delay = 700): void {
  if (hydrating) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => { void saveGeneral(); }, delay);
}

async function saveGeneral(): Promise<void> {
  if (!editing) return;
  const name = ($<HTMLInputElement>("ws-name")?.value || "").trim();
  if (!name) { setError("A role needs a name."); setStatus("", ""); return; }
  const cap = num($<HTMLInputElement>("ws-cap")?.value || "");
  await patch({
    name,
    rateLimitCalls: num($<HTMLInputElement>("ws-rate-calls")?.value || ""),
    rateLimitWindowSeconds: num($<HTMLInputElement>("ws-rate-window")?.value || ""),
    creditsCap: cap == null ? null : cap * MICRO,
    capPeriodDays: Number($<HTMLSelectElement>("ws-cap-period")?.value) || 30,
  });
  paintTitle();
}

const commitModels = (models: string[] | null, msg?: string): Promise<boolean> =>
  patch({ limitModels: models !== null, allowedModels: models ?? [] }, msg);

function commitConn(list: string[] | null, tools: Record<string, string[]>, msg?: string): Promise<boolean> {
  const f = MODE[connMode];
  return patch({ [f.limit]: list !== null, [f.list]: list ?? [], [f.tools]: tools }, msg);
}

// ── List view ────────────────────────────────────────────────────────────

const rateSummary = (w: Workspace): string =>
  w.rateLimitCalls == null ? "—" : `${w.rateLimitCalls}/${w.rateLimitWindowSeconds ?? 0}s`;

function capSummary(w: Workspace): string {
  if (w.creditsCap == null) return "—";
  const period = PERIODS.find(([d]) => d === w.capPeriodDays)?.[1]?.toLowerCase() || "monthly";
  return `${Math.round(Number(w.creditsCap) / MICRO).toLocaleString()} cr ${period}`;
}

function connSummary(w: Workspace): string {
  const personal = w.limitPersonalConnections ? (w.allowedPersonalConnections?.length ?? 0) : "All";
  const shared = w.limitConnections ? (w.allowedConnections?.length ?? 0) : "All";
  return `P ${personal} · S ${shared}`;
}

const modelSummary = (w: Workspace): string =>
  w.limitModels ? `${w.allowedModels?.length ?? 0} models` : "All models";

/** The standard list-page grammar (Skills/Loops): a lib-table with the row
 *  anatomy name / meta / dim + a kebab cell, crud-empty states, pagination.
 *  Row click opens the editor; the base workspace keeps its undeletability
 *  (no Delete in its menu). */
let wsPage = 0;

function paintList(): void {
  const list = $("ws-list");
  if (!list) return;
  const q = ($<HTMLInputElement>("ws-search")?.value || "").trim().toLowerCase();
  const rows = workspaces.filter((w) => !q || w.name.toLowerCase().includes(q));
  list.innerHTML = "";
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "crud-empty";
    empty.textContent = q ? "No roles match your search." : "No roles yet.";
    list.appendChild(empty);
    return;
  }
  const { items, state } = paginate(rows, wsPage);
  wsPage = state.page;
  const table = document.createElement("table");
  table.className = "lib-table";
  table.innerHTML = `<thead><tr><th>Name</th><th>Access</th><th>Limits</th><th class="lib-row-kebab-cell"></th></tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const w of items) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="lib-table-name"></td>
      <td class="lib-table-desc"></td>
      <td class="lib-table-dim"></td>`;
    const nameCell = tr.querySelector(".lib-table-name");
    if (nameCell) {
      nameCell.textContent = w.name;
      if (w.isBase) {
        const badge = document.createElement("span");
        badge.className = "lib-badge";
        badge.textContent = "Base";
        badge.title = "Unassigned members fall back to this role; it can't be deleted.";
        nameCell.append(" ", badge);
      }
    }
    const access = tr.querySelector(".lib-table-desc");
    if (access) access.textContent = `${modelSummary(w)} · ${connSummary(w)}`;
    const limits = tr.querySelector(".lib-table-dim");
    if (limits) limits.textContent = `${rateSummary(w)} · ${capSummary(w)}`;
    tr.addEventListener("click", () => { void openEditor(w); });
    tr.appendChild(kebabCell(() => [
      { icon: ROW_MENU_ICONS.edit, label: "Edit", onClick: () => { void openEditor(w); } },
      ...(w.isBase ? [] : [{
        icon: ROW_MENU_ICONS.delete, label: "Delete", danger: true,
        onClick: () => { void removeWorkspace(w); },
      }]),
    ]));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  list.appendChild(table);
  if (state.totalPages > 1) list.appendChild(renderPaginationBar(state, (p) => { wsPage = p; paintList(); }));
}

async function removeWorkspace(w: Workspace): Promise<void> {
  const ok = await confirmAction({
    title: `Delete ${w.name}?`,
    body: "Members assigned to it fall back to the base role.",
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  const handle = sdk();
  if (handle?.workspaces?.delete) {
    try { await handle.workspaces.delete(w.id); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); return; }
  } else {
    const fn = ipcFns()["workspacesDelete"] as ((id: string) => Promise<{ ok: boolean; error?: string }>) | undefined;
    const res = await fn?.(w.id);
    if (!res || typeof res.ok !== "boolean") { setError("Deleting a role is unavailable on this surface."); return; }
    if (!res.ok) { setError(res.error || "Delete failed"); return; }
  }
  setError("");
  await loadWorkspaces();
}

async function createWorkspace(): Promise<void> {
  const field = $<HTMLInputElement>("ws-new-name");
  const name = (field?.value || "").trim();
  if (!name) { setError("Give the new role a name."); return; }
  setStatus("Creating…", "");
  const created = await via<Workspace>((c) => c.workspaces?.create?.({ name }), "workspacesCreate", { name });
  if (!created) { setStatus("Not created", "error"); return; }
  if (field) field.value = "";
  setError("");
  setStatus("Created", "success");
  await loadWorkspaces();
  void openEditor(created);
}

// ── Editor ───────────────────────────────────────────────────────────────

function showEditor(on: boolean): void {
  $("ws-list-view")?.classList.toggle("hidden", on);
  $("ws-edit-view")?.classList.toggle("hidden", !on);
}

function paintTitle(): void {
  const el = $("ws-edit-title");
  if (el) el.textContent = editing ? `${editing.name}${editing.isBase ? " · base" : ""}` : "—";
}

async function openEditor(w: Workspace): Promise<void> {
  editing = w;
  selectedSlug = null;
  connMode = "personal";
  showEditor(true);
  setTab("general");
  hydrating = true;
  const set = (id: string, v: string): void => { const el = $<HTMLInputElement>(id); if (el) el.value = v; };
  set("ws-name", w.name);
  set("ws-rate-calls", w.rateLimitCalls == null ? "" : String(w.rateLimitCalls));
  set("ws-rate-window", w.rateLimitWindowSeconds == null ? "" : String(w.rateLimitWindowSeconds));
  set("ws-cap", w.creditsCap == null ? "" : String(Math.round(Number(w.creditsCap) / MICRO)));
  const period = $<HTMLSelectElement>("ws-cap-period");
  if (period) period.value = String([1, 7, 30].includes(w.capPeriodDays ?? 30) ? w.capPeriodDays : 30);
  hydrating = false;
  paintTitle();
  paintModels();
  paintConnections();
  // The picker needs the org's own connectors + the tool cap; the allowed
  // slugs need names and icons the record doesn't carry.
  void hydrateMeta([...(w.allowedConnections || []), ...(w.allowedPersonalConnections || [])]);
}

function setTab(tab: string): void {
  for (const b of Array.from(document.querySelectorAll<HTMLElement>("#ws-tabs .app-detail-tab"))) {
    b.classList.toggle("active", b.dataset.wstab === tab);
  }
  for (const p of Array.from(document.querySelectorAll<HTMLElement>(".ws-tab"))) {
    p.classList.toggle("active", p.dataset.wstab === tab);
  }
}

// ── Models tab ───────────────────────────────────────────────────────────

function paintModels(): void {
  const grid = $("ws-models-grid");
  const toggle = $<HTMLInputElement>("ws-limit-models");
  const hint = $("ws-models-hint");
  if (!grid || !editing) return;
  const allowed = modelsOf(editing);
  const limited = allowed !== null;
  if (toggle) toggle.checked = limited;
  if (hint) {
    hint.textContent = limited
      ? "Uncheck a model to hide it from members with this role."
      : "Off — it can use every model the org supports.";
  }
  const q = ($<HTMLInputElement>("ws-models-search")?.value || "").trim().toLowerCase();
  const rows = catalog.filter((m) => !q || m.displayName.toLowerCase().includes(q) || (m.provider || "").toLowerCase().includes(q));
  grid.innerHTML = "";
  if (!catalog.length) {
    grid.innerHTML = `<div class="crud-empty">No org models yet — add them under Settings › Models.</div>`;
    return;
  }
  if (!rows.length) {
    grid.innerHTML = `<div class="crud-empty">No models match your search.</div>`;
    return;
  }
  for (const m of rows) {
    const on = !limited || allowed.includes(m.key);
    const card = document.createElement("label");
    card.className = "mdl-card ws-model-card" + (limited && !on ? " off" : "");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = on;
    box.disabled = !limited;
    box.addEventListener("change", () => {
      const base = allowed ?? catalog.map((x) => x.key);
      const next = base.includes(m.key) ? base.filter((k) => k !== m.key) : [...base, m.key];
      // A list covering the whole catalogue IS "all" — collapse it back to null
      // so the record doesn't drift from the org's catalogue as it grows.
      void commitModels(next.length === catalog.length ? null : next).then(paintModels);
    });
    const name = document.createElement("div");
    name.className = "mdl-name";
    name.textContent = m.displayName;
    const meta = document.createElement("div");
    meta.className = "mdl-meta";
    meta.textContent = m.kind === "proxied" ? (m.provider || "proxy") : "on-device";
    card.append(box, name, meta);
    grid.appendChild(card);
  }
}

// ── Connections tab ──────────────────────────────────────────────────────

const ICON_FALLBACK = (name: string): string => (name || "?").charAt(0).toUpperCase();

function connCard(slug: string, toolsLabel: string, onClick: () => void): HTMLElement {
  const meta = connMeta.get(slug) || { name: slug, icon: null };
  const card = document.createElement("button");
  card.type = "button";
  card.className = "mdl-card ws-conn-card";
  const icon = document.createElement("span");
  icon.className = "ws-conn-icon";
  if (meta.icon) {
    const img = document.createElement("img");
    img.src = meta.icon;
    img.alt = "";
    icon.appendChild(img);
  } else {
    icon.textContent = ICON_FALLBACK(meta.name);
  }
  const name = document.createElement("div");
  name.className = "mdl-name";
  name.textContent = meta.name;
  const sub = document.createElement("div");
  sub.className = "mdl-meta";
  sub.textContent = toolsLabel;
  card.append(icon, name, sub);
  card.addEventListener("click", onClick);
  return card;
}

function paintConnections(): void {
  if (!editing) return;
  const personal = connMode === "personal";
  for (const b of Array.from(document.querySelectorAll<HTMLElement>("#ws-conn-tabs .app-detail-tab"))) {
    b.classList.toggle("active", b.dataset.wsconn === connMode);
  }
  const blurb = $("ws-conn-blurb");
  if (blurb) {
    blurb.textContent = personal
      ? "Apps a member connects with their OWN account, and which of each app's tools they may use."
      : "The org's shared, org-authenticated connectors this role may use, and which of each app's tools.";
  }
  // Custom MCP is a PERSONAL-side decision — it's the member registering their
  // own server, which has no meaning on the shared side.
  $("ws-mcp-row")?.classList.toggle("hidden", !personal);
  const mcp = $<HTMLInputElement>("ws-allow-mcp");
  if (mcp) mcp.checked = editing.allowCustomMcp !== false;

  const list = listOf(editing, connMode);
  const limitBox = $<HTMLInputElement>("ws-limit-conns");
  if (limitBox) limitBox.checked = list !== null;
  const title = $("ws-limit-conns-title");
  if (title) title.textContent = personal ? "Restrict which apps members may connect" : "Restrict to specific connections";
  const hint = $("ws-limit-conns-hint");
  if (hint) {
    hint.textContent = personal
      ? "Off — members may connect any app with their own account. On — only the apps you allow below."
      : "Off — members can use every org connector. On — only the ones you allow below.";
  }

  const toolsView = $("ws-tools-view");
  const listWrap = $("ws-conn-list-wrap");
  if (selectedSlug) {
    listWrap?.classList.add("hidden");
    toolsView?.classList.remove("hidden");
    paintTools();
    return;
  }
  toolsView?.classList.add("hidden");
  listWrap?.classList.toggle("hidden", list === null);
  if (list === null) return;

  const q = ($<HTMLInputElement>("ws-conn-search")?.value || "").trim().toLowerCase();
  const tools = toolsOf(editing, connMode);
  const shown = list.filter((slug) =>
    !q || slug.toLowerCase().includes(q) || (connMeta.get(slug)?.name || "").toLowerCase().includes(q));
  const grid = $("ws-conn-grid");
  if (!grid) return;
  grid.innerHTML = "";
  if (!list.length) {
    grid.innerHTML = `<div class="crud-empty">Nothing allowed yet — add one above.</div>`;
    return;
  }
  if (!shown.length) {
    grid.innerHTML = `<div class="crud-empty">No matches for your search.</div>`;
    return;
  }
  for (const slug of shown) {
    const t = tools[slug];
    grid.appendChild(connCard(slug, t == null ? "All tools" : `${t.length} tool${t.length === 1 ? "" : "s"}`, () => {
      selectedSlug = slug;
      void loadTools(slug).then(paintConnections);
      paintConnections();
    }));
  }
}

/** A shared connection's tool universe is what it advertises ∩ the org's cap;
 *  a personal connection has no org cap (it's the member's own auth). */
function toolUniverse(slug: string): Tool[] {
  const advertised = slugTools.get(slug) || [];
  if (connMode === "personal") return advertised;
  const cap = orgToolCap[slug];
  return cap ? advertised.filter((t) => cap.includes(t.name)) : advertised;
}

function paintTools(): void {
  if (!editing || !selectedSlug) return;
  const slug = selectedSlug;
  const meta = connMeta.get(slug) || { name: slug, icon: null };
  const nameEl = $("ws-tools-name");
  const slugEl = $("ws-tools-slug");
  if (nameEl) nameEl.textContent = meta.name;
  if (slugEl) slugEl.textContent = slug;

  const tools = toolUniverse(slug);
  const map = toolsOf(editing, connMode);
  const cur = map[slug] ?? null;   // null = every tool
  const wrap = $("ws-tools-list");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!tools.length) {
    wrap.innerHTML = `<div class="crud-empty">No tools found for this app.</div>`;
    return;
  }

  const rowFor = (label: string, checked: boolean, desc: string | undefined, onToggle: () => void): HTMLElement => {
    const row = document.createElement("label");
    row.className = "ws-tool-row";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = checked;
    box.addEventListener("change", onToggle);
    const name = document.createElement("span");
    name.className = "ws-tool-name";
    name.textContent = label;
    row.append(box, name);
    if (desc) {
      const d = document.createElement("span");
      d.className = "ws-tool-desc";
      d.textContent = desc;
      row.appendChild(d);
    }
    return row;
  };

  const checked = cur === null ? tools.length : tools.filter((t) => cur.includes(t.name)).length;
  const all = wrap.appendChild(rowFor(`Select all (${checked}/${tools.length})`, checked === tools.length, undefined, () => {
    // "Every tool" is stored as an ABSENT slug, not an empty list — an empty
    // list means "no tools at all", which is the opposite.
    const next = { ...map };
    if (checked !== tools.length) delete next[slug];
    else next[slug] = [];
    void commitConn(listOf(editing!, connMode), next).then(paintTools);
  }));
  all.classList.add("ws-tool-all");

  for (const t of tools) {
    wrap.appendChild(rowFor(t.name, cur === null || cur.includes(t.name), t.description, () => {
      const names = tools.map((x) => x.name);
      let next = cur === null
        ? names.filter((n) => n !== t.name)
        : (cur.includes(t.name) ? cur.filter((n) => n !== t.name) : [...cur, t.name]);
      const map2 = toolsOf(editing!, connMode);
      // A list covering every tool collapses back to "all" (absent slug).
      if (next.length === names.length) { delete map2[slug]; next = []; }
      else map2[slug] = next;
      void commitConn(listOf(editing!, connMode), map2).then(paintTools);
    }));
  }
}

// ── The "allow another" picker ────────────────────────────────────────────

function paintPicker(): void {
  const wrap = $("ws-picker-list");
  if (!wrap || !editing) return;
  const already = new Set(listOf(editing, connMode) || []);
  wrap.innerHTML = "";
  const rows = connMode === "shared"
    ? orgConnectors.filter((c) => !already.has(c.id)).map((c) => ({ id: c.id, name: c.name, icon: c.icon }))
    : pickerResults.filter((a) => !already.has(a.id));
  if (!rows.length) {
    wrap.innerHTML = `<div class="crud-empty">${connMode === "shared" ? "Every org connector is already allowed." : "No apps match — type to search the catalog."}</div>`;
    return;
  }
  for (const r of rows) {
    connMeta.set(r.id, { name: r.name, icon: r.icon });
    wrap.appendChild(connCard(r.id, "Add", () => {
      const list = listOf(editing!, connMode) || [];
      void commitConn([...list, r.id], toolsOf(editing!, connMode), `${r.name} allowed`).then(() => {
        $("ws-conn-picker")?.classList.add("hidden");
        paintConnections();
      });
    }));
  }
}

function schedulePickerSearch(): void {
  window.clearTimeout(pickerTimer);
  pickerTimer = window.setTimeout(() => { void runPickerSearch(); }, 220);
}

async function runPickerSearch(): Promise<void> {
  if (connMode !== "personal") { paintPicker(); return; }
  const q = ($<HTMLInputElement>("ws-picker-search")?.value || "").trim();
  const res = await via<{ apps?: Array<{ id: string; name: string; icon?: string }> }>(
    (c) => c.connections?.apps?.({ ...(q ? { search: q } : {}), limit: 24 }), "workspacesAppSearch", q, 24);
  pickerResults = (res?.apps || []).map((a) => ({ id: a.id, name: a.name, icon: a.icon || null }));
  paintPicker();
}

// ── Loads ────────────────────────────────────────────────────────────────

async function loadTools(slug: string): Promise<void> {
  if (slugTools.has(slug)) return;
  const res = await via<{ tools?: Tool[] }>((c) => c.connections?.appTools?.(slug), "workspacesConnTools", slug);
  slugTools.set(slug, res?.tools || []);
}

/** Resolve name + icon for slugs the org-connector list doesn't cover — every
 *  personal slug comes from the broad catalog, not the org's connectors. */
async function hydrateMeta(slugs: string[]): Promise<void> {
  const missing = [...new Set(slugs)].filter((s) => s && !connMeta.has(s));
  if (!missing.length) return;
  await Promise.all(missing.map(async (slug) => {
    const res = await via<{ apps?: Array<{ id: string; name: string; icon?: string }> }>(
      (c) => c.connections?.apps?.({ search: slug, limit: 5 }), "workspacesAppSearch", slug, 5);
    const hit = (res?.apps || []).find((a) => a.id === slug);
    connMeta.set(slug, hit ? { name: hit.name, icon: hit.icon || null } : { name: slug, icon: null });
  }));
  paintConnections();
}

async function loadWorkspaces(): Promise<void> {
  const rows = await via<Workspace[]>((c) => c.workspaces?.list?.(), "workspacesList");
  workspaces = rows || [];
  paintList();
  void paintBlocks();
}

// ── Blocked marketplace apps (his rule, 2026-08-20): org-wide install bar ──

type OrgBlock = { appId: string; slug: string; name: string };
async function blocksTransport(): Promise<{ list: () => Promise<{ blocks: OrgBlock[] }>; set: (ref: string, blocked: boolean) => Promise<{ ok: boolean; error?: string }> }> {
  const sdk = (window as unknown as { glyphhSdk?: { org?: { appBlocks?: () => Promise<{ blocks: OrgBlock[] }>; blockApp?: (r: string) => Promise<unknown>; unblockApp?: (r: string) => Promise<unknown> } } }).glyphhSdk?.org;
  if (sdk?.appBlocks) {
    return {
      list: () => sdk.appBlocks!(),
      set: async (ref, blocked) => {
        try { await (blocked ? sdk.blockApp!(ref) : sdk.unblockApp!(ref)); return { ok: true }; }
        catch (e) { return { ok: false, error: (e as Error).message }; }
      },
    };
  }
  const g = (window as unknown as { glyphh: { orgAppBlocks?: () => Promise<{ blocks: OrgBlock[] }>; orgAppBlockSet?: (r: string, b: boolean) => Promise<{ ok: boolean; error?: string }> } }).glyphh;
  return {
    list: async () => (typeof g.orgAppBlocks === "function" ? g.orgAppBlocks() : { blocks: [] }),
    set: async (ref, blocked) => (typeof g.orgAppBlockSet === "function" ? g.orgAppBlockSet(ref, blocked) : { ok: false, error: "unsupported build" }),
  };
}

async function paintBlocks(): Promise<void> {
  const host = $("ws-blocks-list");
  if (!host) return;
  const t = await blocksTransport();
  let blocks: OrgBlock[] = [];
  try { blocks = (await t.list()).blocks; } catch { /* non-admin or offline — empty */ }
  host.innerHTML = blocks.length
    ? blocks.map((b) => `
      <div class="mkt-admin-row" style="display:flex;align-items:center;gap:10px;padding:8px 12px;">
        <b>${b.name.replace(/</g, "&lt;")}</b> <span class="mkt-console-app-sub">${b.slug.replace(/</g, "&lt;")}</span>
        <span style="flex:1;"></span>
        <button class="action-btn ws-unblock" type="button" data-slug="${b.slug.replace(/"/g, "&quot;")}">Unblock</button>
      </div>`).join("")
    : `<div class="crud-empty">Nothing blocked — every listed marketplace app is installable.</div>`;
  host.querySelectorAll<HTMLButtonElement>(".ws-unblock").forEach((b) => {
    b.addEventListener("click", async () => {
      b.disabled = true;
      const r = await t.set(b.dataset.slug!, false);
      if (!r.ok) { b.disabled = false; return; }
      void paintBlocks();
    });
  });
}

// ── Wiring ───────────────────────────────────────────────────────────────

export function initWorkspaces(): void {
  if (wired) return;
  wired = true;

  $("ws-search")?.addEventListener("input", () => { wsPage = 0; paintList(); });
  $("ws-block-btn")?.addEventListener("click", async () => {
    const input = $("ws-block-ref") as HTMLInputElement | null;
    const ref = input?.value.trim();
    if (!ref) return;
    const t = await blocksTransport();
    const r = await t.set(ref, true);
    const chip = $("ws-blocks-status");
    if (chip) { chip.textContent = r.ok ? "Blocked" : (r.error || "Couldn't block"); chip.className = `set-save-state ${r.ok ? "success" : "error"}`; }
    if (r.ok && input) { input.value = ""; void paintBlocks(); }
  });
  $("ws-new-btn")?.addEventListener("click", () => { void createWorkspace(); });
  $("ws-new-name")?.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") void createWorkspace();
  });
  $("ws-back")?.addEventListener("click", () => { editing = null; showEditor(false); paintList(); });

  for (const b of Array.from(document.querySelectorAll<HTMLElement>("#ws-tabs .app-detail-tab"))) {
    b.addEventListener("click", () => setTab(b.dataset.wstab || "general"));
  }
  for (const b of Array.from(document.querySelectorAll<HTMLElement>("#ws-conn-tabs .app-detail-tab"))) {
    b.addEventListener("click", () => {
      connMode = (b.dataset.wsconn as ConnMode) || "personal";
      selectedSlug = null;
      pickerResults = [];
      $("ws-conn-picker")?.classList.add("hidden");
      paintConnections();
    });
  }

  // General — typed fields debounce, the period select commits at once.
  for (const id of ["ws-name", "ws-rate-calls", "ws-rate-window", "ws-cap"]) {
    $(id)?.addEventListener("input", () => scheduleGeneral());
    $(id)?.addEventListener("blur", () => scheduleGeneral(0));
  }
  $("ws-cap-period")?.addEventListener("change", () => scheduleGeneral(0));

  $("ws-models-search")?.addEventListener("input", paintModels);
  $("ws-limit-models")?.addEventListener("change", (e) => {
    const on = (e.currentTarget as HTMLInputElement).checked;
    void commitModels(on ? catalog.map((m) => m.key) : null,
      on ? "Limited to selected models" : "Every org model allowed").then(paintModels);
  });

  $("ws-allow-mcp")?.addEventListener("change", (e) => {
    const on = (e.currentTarget as HTMLInputElement).checked;
    void patch({ allowCustomMcp: on }, on ? "Custom MCP allowed" : "Custom MCP disabled");
  });

  $("ws-limit-conns")?.addEventListener("change", async (e) => {
    const box = e.currentTarget as HTMLInputElement;
    if (!editing) return;
    if (box.checked) { await commitConn([], toolsOf(editing, connMode)); paintConnections(); return; }
    // Turning restriction OFF drops the configured list — confirm, since the
    // list is real work and the toggle is one click.
    const n = (listOf(editing, connMode) || []).length;
    if (n > 0) {
      const ok = await confirmAction({
        title: connMode === "personal" ? "Stop restricting which apps members may connect?" : "Stop restricting connections?",
        body: `This removes the ${n} entr${n === 1 ? "y" : "ies"} configured here — members will be able to use every one.`,
        confirmLabel: "Remove & allow all",
        danger: true,
      });
      if (!ok) { box.checked = true; return; }
    }
    await commitConn(null, toolsOf(editing, connMode));
    paintConnections();
  });

  $("ws-conn-search")?.addEventListener("input", paintConnections);
  $("ws-conn-add")?.addEventListener("click", () => {
    const picker = $("ws-conn-picker");
    const open = picker?.classList.toggle("hidden") === false;
    if (open) { pickerResults = []; void runPickerSearch(); }
  });
  $("ws-picker-search")?.addEventListener("input", schedulePickerSearch);

  $("ws-tools-back")?.addEventListener("click", () => { selectedSlug = null; paintConnections(); });
  $("ws-tools-remove")?.addEventListener("click", () => {
    if (!editing || !selectedSlug) return;
    const slug = selectedSlug;
    const list = (listOf(editing, connMode) || []).filter((s) => s !== slug);
    const tools = toolsOf(editing, connMode);
    delete tools[slug];
    void commitConn(list, tools, "Removed").then(() => { selectedSlug = null; paintConnections(); });
  });
}

function showPanel(on: boolean): void {
  $("ws-admin-only")?.classList.toggle("hidden", on);
  $("ws-body")?.classList.toggle("hidden", !on);
  document.querySelector<HTMLElement>('.settings-nav .settings-nav-item[data-sub="workspaces"]')
    ?.classList.toggle("hidden", !on);
}

export async function loadWorkspacesPanel(): Promise<void> {
  initWorkspaces();
  const account = await window.glyphh.getAccountInfo().catch(() => null);
  const role = account?.role || "";
  if (!role || !["org_admin", "super_admin"].includes(role)) { showPanel(false); return; }
  showPanel(true);

  await loadWorkspaces();
  // The three universes a workspace narrows within. Each is independent — a
  // failed connector load must not blank the model list.
  const [models, connectors, cap] = await Promise.all([
    via<Array<{ id: string; kind: string; name: string; providerSlug: string }>>((c) => c.models?.available?.(), "workspacesModelCatalog"),
    via<{ pipedream?: Array<{ appSlug: string; name?: string; appName?: string; icon?: string }>; mcp?: Array<{ slug: string; name: string; enabled?: boolean }> }>(
      // The two shared-connector lists are one read on the desktop; on web they
      // are two SDK calls, and either failing must not lose the other.
      (c) => (c.connections?.pipedreamList && c.connections?.orgMcpList
        ? Promise.all([
          c.connections.pipedreamList().catch(() => []),
          c.connections.orgMcpList().catch(() => []),
        ]).then(([pipedream, mcp]) => ({ pipedream, mcp }))
        : undefined), "workspacesOrgConnectors"),
    via<Record<string, string[]>>((c) => c.connections?.orgConnectionTools?.(), "workspacesOrgToolCap"),
  ]);
  catalog = (models || []).map((m) => ({ key: m.id, kind: m.kind, displayName: m.name, provider: m.providerSlug }));
  const byId = new Map<string, { id: string; name: string; icon: string | null; kind: string }>();
  // Several accounts for one Pipedream app collapse to a single connector.
  for (const c of connectors?.pipedream || []) {
    if (!byId.has(c.appSlug)) byId.set(c.appSlug, { id: c.appSlug, name: c.name || c.appName || c.appSlug, icon: c.icon || null, kind: "Shared app" });
  }
  for (const c of connectors?.mcp || []) {
    if (c.enabled === false) continue;
    byId.set(c.slug, { id: c.slug, name: c.name, icon: null, kind: "Custom MCP" });
  }
  orgConnectors = [...byId.values()];
  for (const c of orgConnectors) connMeta.set(c.id, { name: c.name, icon: c.icon });
  orgToolCap = cap || {};
  if (editing) { paintModels(); paintConnections(); }
}
