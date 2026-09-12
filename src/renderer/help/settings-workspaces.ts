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
 * House style (his Security-page spec, 2026-09-01, matching Domains):
 *   - "+ New role" opens the standard validated modal and lands on the editor;
 *   - the editor carries the standard footer — Delete (confirmed) bottom-left,
 *     Cancel + Save bottom-right. General fields are STAGED (Save commits);
 *     the Models/Connections allow-toggles still commit on the click that
 *     changed them (the platform live-saved those for the same reason);
 *   - the "allow another connection" picker is an inline panel, not a modal.
 *
 * Member assignment is deliberately absent: members.list() doesn't return a
 * member's current workspace, so an assignment control could only ever show the
 * base workspace as its value while silently reassigning people. It lands when
 * the SDK returns orgRoleId.
 */

import { confirmAction, paginate, renderPaginationBar, escapeHtml } from "./shared.js";
import { gateSurface } from "./plan-gate.js";
import { openProviderDropdown, MDL_SVG, icoBtn } from "./models-admin.js";
import { kebabCell, ROW_MENU_ICONS, openRowMenu } from "./lib-editor.js";
import { formModal } from "./settings-list-page.js";
import { primeConnectedIcons, connectedIconCache } from "./app-icon.js";
import { hidePanelsForModal, restorePanelsForModal } from "../yo-modal.js";

const MICRO = 1_000_000;
/** Calendar-aligned periods — the interval defines the reset, no arbitrary dates. */
const PERIODS: Array<[number, string]> = [[1, "Daily"], [7, "Weekly"], [30, "Monthly"]];

interface Workspace {
  id: string;
  name: string;
  isBase: boolean;
  limitModels: boolean;
  allowedModels: string[];
  /** LOOPS: which CLIs this role may drive, each with its default model, at
   *  most one flagged the role's default, and whether it routes semantically. */
  limitLoops?: boolean;
  loopGrants?: LoopGrant[];
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
  budgetUsd: number | null;
  budgetHard: boolean;
  budgetPeriodDays: number | null;
  tpmLimit: number | null;
  memberCount?: number;
}

interface GatewayKeyLite {
  id: string;
  name: string;
  workspaceId: string;
  tokenHint: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface CatalogModel { key: string; kind: string; displayName: string; provider: string; inCr: number; outCr: number }
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
let gwKeys: GatewayKeyLite[] = [];
// The org's ENABLED vendors — the provider-keys block lists these, NOT the
// supported-model catalog (an enabled vendor with no models toggled on yet
// must still take a role key; his report, 2026-09-11).
let orgProviderRows: Array<{ slug: string; name: string }> = [];
// ws id → gateway USD, one map per budget window (daily/weekly/monthly).
let roleSpend: Record<number, Map<string, number>> = { 1: new Map(), 7: new Map(), 30: new Map() };
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
  /** The ORG's loop support list — the catalog a role narrows from. */
  orgLoops?: { list?: () => Promise<OrgLoopRow[]> };
  /** The org's members — who can hold this role. */
  members?: { list?: () => Promise<OrgMember[]> };
  workspaces?: {
    list?: () => Promise<Workspace[]>;
    create?: (input: Record<string, unknown>) => Promise<Workspace>;
    update?: (id: string, input: Record<string, unknown>) => Promise<Workspace>;
    delete?: (id: string) => Promise<void>;
    /** Move a member to a role. The only verb: everyone holds one. */
    assign?: (userId: string, workspaceId: string) => Promise<void>;
    providerKeys?: (id: string) => Promise<Array<{ providerSlug: string; updatedAt: string }>>;
    setProviderKey?: (id: string, slug: string, key: string) => Promise<{ providerSlug: string }>;
    clearProviderKey?: (id: string, slug: string) => Promise<void>;
  };
  models?: { available?: () => Promise<Array<{ id: string; kind: string; name: string; providerSlug: string }>> };
  catalog?: { providers?: () => Promise<Array<{ slug: string; name: string; enabledForOrg?: boolean }>> };
  gateway?: {
    keys?: () => Promise<GatewayKeyLite[]>;
    metrics?: (opts: { days?: number }) => Promise<{ byRole?: Array<{ key: string; spendUsd: number }> }>;
  };
  orgModels?: { list?: () => Promise<Array<{ id: string; name: string; providerSlug: string; kind: string; inputCreditsPerMTok: number; outputCreditsPerMTok: number; supported: boolean; providerEnabled?: boolean }>> };
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

/** General — STAGED (his spec, 2026-09-01, matching Domains): typing changes
 *  nothing; the footer's Save commits the fields in one patch. */
async function saveGeneral(): Promise<boolean> {
  if (!editing) return false;
  const name = ($<HTMLInputElement>("ws-name")?.value || "").trim();
  if (!name) { setError("A role needs a name."); setStatus("", ""); return false; }
  const cap = num($<HTMLInputElement>("ws-cap")?.value || "");
  return patch({
    name,
    rateLimitCalls: num($<HTMLInputElement>("ws-rate-calls")?.value || ""),
    rateLimitWindowSeconds: num($<HTMLInputElement>("ws-rate-window")?.value || ""),
    creditsCap: cap == null ? null : cap * MICRO,
    capPeriodDays: Number($<HTMLSelectElement>("ws-cap-period")?.value) || 30,
    budgetUsd: num($<HTMLInputElement>("ws-budget")?.value || ""),
    budgetHard: !!$<HTMLInputElement>("ws-budget-hard")?.checked,
    budgetPeriodDays: Number($<HTMLSelectElement>("ws-budget-period")?.value) || 30,
    tpmLimit: num($<HTMLInputElement>("ws-tpm")?.value || ""),
  });
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

/** Spend vs budget with the traffic light (his spec, 2026-09-11): green under
 *  70%, yellow to the line, red over. No budget → plain spend (or —). */
function budgetCell(w: Workspace): HTMLElement {
  const td = document.createElement("td");
  td.className = "lib-table-dim";
  const period = [1, 7, 30].includes(w.budgetPeriodDays ?? 30) ? (w.budgetPeriodDays ?? 30) : 30;
  const label = period === 1 ? "daily" : period === 7 ? "weekly" : "monthly";
  const spend = roleSpend[period]?.get(w.id) ?? 0;
  const usd = (n: number): string => `$${n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(2)}`;
  if (w.budgetUsd == null) {
    td.textContent = spend > 0 ? usd(spend) : "—";
    return td;
  }
  const pct = w.budgetUsd > 0 ? spend / w.budgetUsd : 1;
  const dot = document.createElement("span");
  dot.className = `ws-budget-dot ${pct >= 1 ? "red" : pct >= 0.7 ? "yellow" : "green"}`;
  dot.title = `${Math.round(pct * 100)}% of the ${label} budget`;
  td.append(dot, ` ${usd(spend)} / ${usd(w.budgetUsd)} ${label}${w.budgetHard ? " · hard" : ""}`);
  return td;
}

const keysSummary = (w: Workspace): string => {
  const mine = gwKeys.filter((k) => k.workspaceId === w.id);
  if (!mine.length) return "—";
  const live = mine.filter((k) => !k.revokedAt && !(k.expiresAt && Date.parse(k.expiresAt) < Date.now())).length;
  return live === mine.length ? String(mine.length) : `${live} of ${mine.length}`;
};

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
  table.innerHTML = `<thead><tr><th>Name</th><th>Members</th><th>Models</th><th>Keys</th><th>Limits</th><th>Spend / Budget</th><th class="lib-row-kebab-cell"></th></tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const w of items) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="lib-table-name"></td>
      <td class="lib-table-dim"></td>
      <td class="lib-table-desc"></td>
      <td class="lib-table-dim"></td>
      <td class="lib-table-dim ws-limits-cell"></td>`;
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
    const cells = tr.querySelectorAll("td");
    if (cells[1]) cells[1].textContent = String(w.memberCount ?? 0);
    if (cells[2]) cells[2].textContent = modelSummary(w);
    if (cells[3]) cells[3].textContent = keysSummary(w);
    if (cells[4]) cells[4].textContent = `${rateSummary(w)} · ${capSummary(w)}`;
    tr.appendChild(budgetCell(w));
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
  // Deleting from the editor's footer must land back on the list (a no-op
  // when the delete came from the list's kebab).
  if (editing?.id === w.id) { editing = null; showEditor(false); }
  await loadWorkspaces();
}

/** + New role — the standard validated modal (his spec, 2026-09-01), landing
 *  on the new role's editor exactly like Domains lands on the new domain. */
function newWorkspaceModal(): void {
  let created: Workspace | null = null;
  void formModal({
    title: "New role",
    fields: [{ key: "name", label: "Name", placeholder: "e.g. Analysts", required: true }],
    submitLabel: "Create",
    onSubmit: async (values) => {
      created = await via<Workspace>((c) => c.workspaces?.create?.({ name: values.name! }), "workspacesCreate", { name: values.name! });
      return created ? { ok: true as const } : { ok: false as const, error: "Couldn't create the role." };
    },
  }).then(async (saved) => {
    if (!saved) return;
    setError("");
    await loadWorkspaces();
    if (created) void openEditor(created);
  });
}

// ── Editor ───────────────────────────────────────────────────────────────

function showEditor(on: boolean): void {
  $("ws-list-view")?.classList.toggle("hidden", on);
  $("ws-edit-view")?.classList.toggle("hidden", !on);
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
  set("ws-budget", w.budgetUsd == null ? "" : String(w.budgetUsd));
  set("ws-tpm", w.tpmLimit == null ? "" : String(w.tpmLimit));
  const bperiod = $<HTMLSelectElement>("ws-budget-period");
  if (bperiod) bperiod.value = String([1, 7, 30].includes(w.budgetPeriodDays ?? 30) ? w.budgetPeriodDays ?? 30 : 30);
  const hard = $<HTMLInputElement>("ws-budget-hard");
  if (hard) hard.checked = !!w.budgetHard;
  hydrating = false;
  paintRoleKeys();
  wsProviderKeys = new Set();
  paintModels();
  paintProviderKeys();
  void loadProviderKeys(w.id);
  paintConnections();
  // The picker needs the org's own connectors + the tool cap; the allowed
  // slugs need names and icons the record doesn't carry.
  void hydrateMeta([...(w.allowedConnections || []), ...(w.allowedPersonalConnections || [])]);
}

/** One loop's grant on a role. */
interface LoopGrant { cli: string; model: string; isDefault?: boolean; forceAuto?: boolean }

function setTab(tab: string): void {
  for (const b of Array.from(document.querySelectorAll<HTMLElement>("#ws-tabs .app-detail-tab"))) {
    b.classList.toggle("active", b.dataset.wstab === tab);
  }
  for (const p of Array.from(document.querySelectorAll<HTMLElement>(".ws-tab"))) {
    p.classList.toggle("active", p.dataset.wstab === tab);
  }
  // Paint on ENTRY, not on role load — these two fetch, and a role editor
  // that pulled the org's members and loop catalog every time you opened
  // General would pay for tabs nobody clicked.
  if (tab === "loops") void paintLoopsTab();
  if (tab === "members") void paintMembersTab();
}

// ── Models tab ───────────────────────────────────────────────────────────

const WS_MODELS_PAGE_SIZE = 15;   // 15 everywhere — the one pagination size (his rule)
let wsModelsPage = 0;
let wsConnPage = 0;
let wsModelsProvider = "";   // "" = every provider

// ── role provider keys (his order, 2026-09-11) ──────────────────────────────
// The org key is the DEFAULT credential for a vendor; a role key overrides it
// for this workspace's members (separate vendor billing per role). Presence
// only ever crosses the wire.
let wsProviderKeys = new Set<string>();

async function loadProviderKeys(id: string): Promise<void> {
  const rows = await via<Array<{ providerSlug: string }>>(
    (c) => c.workspaces?.providerKeys?.(id), "workspaceProviderKeys", id);
  if (editing?.id !== id) return;
  wsProviderKeys = new Set((rows ?? []).map((r) => r.providerSlug));
  paintProviderKeys();
}

function roleKeyModal(slug: string): void {
  if (!editing) return;
  const id = editing.id;
  void formModal({
    title: `${slug} key for ${editing.name}`,
    fields: [{ key: "key", label: "API key", placeholder: "sk-…", required: true }],
    submitLabel: "Save key",
    onSubmit: async (values) => {
      const r = await via<{ providerSlug: string }>(
        (c) => c.workspaces?.setProviderKey?.(id, slug, values.key!), "workspaceProviderKeySet", id, slug, values.key!);
      return r ? { ok: true as const } : { ok: false as const, error: "Couldn\u2019t save the key." };
    },
  }).then((saved) => {
    if (saved && editing?.id === id) { wsProviderKeys.add(slug); paintProviderKeys(); }
  });
}

function paintProviderKeys(): void {
  const host = $("ws-provider-keys");
  if (!host || !editing) return;
  host.innerHTML = "";
  // The org's ENABLED vendors, straight off the providers read — enabled with
  // zero supported models still takes a role key.
  const providers = orgProviderRows;
  if (!providers.length) {
    host.innerHTML = `<div class="crud-empty">No enabled providers yet \u2014 the org adds vendor keys under Models.</div>`;
    return;
  }
  const table = document.createElement("table");
  table.className = "lib-table";
  table.innerHTML = `<thead><tr><th>Provider</th><th>Key</th><th class="ws-model-toggle-cell"></th></tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const { slug, name: provName } of providers) {
    const has = wsProviderKeys.has(slug);
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    name.textContent = provName;
    const state = document.createElement("td");
    const actions = document.createElement("td");
    actions.className = "ws-model-toggle-cell";
    if (has) {
      state.innerHTML = `<span class="mdl-key-check" title="This role has its own key"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span> Role key`;
      const removeKey = icoBtn(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>`, "Remove the role key");
      removeKey.classList.add("mdl-key-remove");
      removeKey.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void (async () => {
          const ws = editing;
          if (!ws) return;
          const sure = await confirmAction({
            title: `Remove the ${slug} role key?`,
            body: `Members with this role go back to the organization\u2019s ${slug} key.`,
            confirmLabel: "Remove key",
            danger: true,
          });
          if (!sure) return;
          // A void DELETE gives `via` nothing to return — re-read the truth
          // instead of guessing; failures surface through setError regardless.
          await via<unknown>((c) => c.workspaces?.clearProviderKey?.(ws.id, slug)?.then(() => ({ ok: true })), "workspaceProviderKeyClear", ws.id, slug);
          void loadProviderKeys(ws.id);
        })();
      });
      actions.appendChild(removeKey);
    } else {
      state.textContent = "Org key";
      const edit = icoBtn(MDL_SVG.edit, "Set a key for this role");
      edit.addEventListener("click", (ev) => { ev.stopPropagation(); roleKeyModal(slug); });
      actions.appendChild(edit);
    }
    tr.append(name, state, actions);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.appendChild(table);
}

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
  const rows = catalog
    .filter((m) => !wsModelsProvider || (m.provider || (m.kind === "proxied" ? "" : "on-device")) === wsModelsProvider)
    .filter((m) => !q || m.displayName.toLowerCase().includes(q) || (m.provider || "").toLowerCase().includes(q));
  const filterLabel = $("ws-models-filter-label");
  if (filterLabel) {
    filterLabel.textContent = wsModelsProvider;
    filterLabel.classList.toggle("hidden", !wsModelsProvider);
  }
  const pagerHost = $("ws-models-pager");
  if (pagerHost) pagerHost.textContent = "";
  grid.innerHTML = "";
  if (!catalog.length) {
    grid.innerHTML = `<div class="crud-empty">No org models yet — add them under <a href="#" id="ws-models-link">Models</a>.</div>`;
    grid.querySelector("#ws-models-link")?.addEventListener("click", (ev) => {
      ev.preventDefault();
      void import("./navigation.js").then((m) => m.openSettings("models"));
    });
    return;
  }
  if (!rows.length) {
    grid.innerHTML = `<div class="crud-empty">No models match your search.</div>`;
    return;
  }
  const table = document.createElement("table");
  table.className = "lib-table";
  table.innerHTML = `<thead><tr><th>Provider</th><th>Name</th><th class="ws-model-toggle-cell">Auto exempt <button type="button" class="ws-info-btn" id="ws-exempt-info" title="What is Auto exempt?">&#9432;</button></th><th class="ws-model-toggle-cell">Allowed</th></tr></thead>`;
  table.querySelector("#ws-exempt-info")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    document.querySelector(".ws-info-pop")?.remove();
    const pop = document.createElement("div");
    pop.className = "mdl-provider-drop ws-info-pop";
    pop.textContent = "Allows this role to use this model directly even when one of its loops is set to force auto (Roles \u2192 Loops). Without an exemption, members see only \"Auto\" on that loop \u2014 the gateway picks the model for each request from the role's allowed set.";
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 300))}px`;
    pop.style.top = `${r.bottom + 6}px`;
    pop.style.zIndex = "10000";
    document.body.appendChild(pop);
    const away = (e: MouseEvent): void => {
      if (!pop.contains(e.target as Node)) { pop.remove(); document.removeEventListener("mousedown", away, true); }
    };
    document.addEventListener("mousedown", away, true);
  });
  const tbody = document.createElement("tbody");
  const pg = paginate(rows, wsModelsPage, WS_MODELS_PAGE_SIZE);
  wsModelsPage = pg.state.page;
  for (const m of pg.items) {
    const on = !limited || allowed.includes(m.key);
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td class="lib-table-desc"></td>` +
      `<td class="lib-table-name"></td>` +
      `<td class="ws-model-toggle-cell"><label class="settings-toggle ws-model-exempt"><input type="checkbox" /><span class="toggle-switch"></span></label></td>` +
      `<td class="ws-model-toggle-cell"><label class="settings-toggle ws-model-allow"><input type="checkbox" /><span class="toggle-switch"></span></label></td>`;
    (tr.children[0] as HTMLElement).textContent = m.kind === "proxied" ? (m.provider || "proxy") : "on-device";
    (tr.children[1] as HTMLElement).textContent = m.displayName;
    // AUTO EXEMPT (owner, 2026-09-11): with org-forced semantic routing,
    // members see only "Auto" — plus the models this toggle exempts for the
    // role (frontier access). Routing always runs the role's FULL allowed
    // set; exemption only widens the PICKER.
    const exemptBox = tr.querySelector<HTMLInputElement>(".ws-model-exempt input")!;
    const exemptNow = ((editing as unknown as { autoExemptModels?: string[] })?.autoExemptModels ?? []);
    exemptBox.checked = exemptNow.includes(m.key);
    exemptBox.addEventListener("change", () => {
      const next = exemptNow.includes(m.key) ? exemptNow.filter((k) => k !== m.key) : [...exemptNow, m.key];
      void patch({ autoExemptModels: next } as Parameters<typeof patch>[0]).then(paintModels);
    });
    const box = tr.querySelector<HTMLInputElement>(".ws-model-allow input")!;
    box.checked = on;
    box.disabled = !limited;
    box.addEventListener("change", () => {
      const base = allowed ?? catalog.map((x) => x.key);
      const next = base.includes(m.key) ? base.filter((k) => k !== m.key) : [...base, m.key];
      // A list covering the whole catalogue IS "all" — collapse it back to null
      // so the record doesn't drift from the org's catalogue as it grows.
      void commitModels(next.length === catalog.length ? null : next).then(paintModels);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  grid.appendChild(table);
  if (pagerHost && pg.state.totalPages > 1) {
    pagerHost.appendChild(renderPaginationBar(pg.state, (p) => { wsModelsPage = p; paintModels(); }));
  }
}

/** The funnel next to the search — pick ONE provider (or all). */
function openModelsFilter(anchor: HTMLElement): void {
  // The SAME searchable dropdown the org Models page uses (his order,
  // 2026-09-11) — options are only the providers the org actually EXPOSES
  // (catalog is already enabled-provider ∩ supported-model).
  const providers = [...new Set(catalog.map((m) => m.provider || (m.kind === "proxied" ? "" : "on-device")).filter(Boolean))].sort();
  openProviderDropdown(anchor, providers.map((pr) => ({ slug: pr, name: pr })), wsModelsProvider, (slug) => {
    wsModelsProvider = slug;
    wsModelsPage = 0;
    paintModels();
  });
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
  const chrome = $("ws-conn-chrome");
  const editorHead = document.querySelector<HTMLElement>("#ws-edit-view > .crud-inline-header");
  const tabBar = $("ws-tabs");
  if (selectedSlug) {
    editorHead?.classList.add("hidden");
    tabBar?.classList.add("hidden");
    chrome?.classList.add("hidden");
    listWrap?.classList.add("hidden");
    toolsView?.classList.remove("hidden");
    paintTools();
    return;
  }
  editorHead?.classList.remove("hidden");
  tabBar?.classList.remove("hidden");
  chrome?.classList.remove("hidden");
  toolsView?.classList.add("hidden");
  // The table shows in BOTH states, like the Models tab — toggles just sit
  // disabled until the restriction is on.
  listWrap?.classList.remove("hidden");
  const limited = list !== null;
  // "Allow another" only matters when a PERSONAL restriction is on — its
  // catalog is unbounded; the shared universe IS the org's connector set.
  $("ws-conn-add")?.classList.toggle("hidden", !(limited && personal));

  const q = ($<HTMLInputElement>("ws-conn-search")?.value || "").trim().toLowerCase();
  const tools = toolsOf(editing, connMode);
  // Row universe: the org's connectors, plus anything the allow-list names
  // that the org set doesn't cover (personal picks from the broad catalog).
  const universe = [...new Set([...orgConnectors.map((c) => c.id), ...(list || [])])];
  void hydrateMeta(universe);
  const shown = universe.filter((slug) =>
    !q || slug.toLowerCase().includes(q) || (connMeta.get(slug)?.name || "").toLowerCase().includes(q));
  const grid = $("ws-conn-grid");
  const pagerHost = $("ws-conn-pager");
  if (pagerHost) pagerHost.textContent = "";
  if (!grid) return;
  grid.innerHTML = "";
  if (!universe.length) {
    grid.innerHTML = `<div class="crud-empty">No connections yet — connect apps on the Connections page first.</div>`;
    return;
  }
  if (!shown.length) {
    grid.innerHTML = `<div class="crud-empty">No matches for your search.</div>`;
    return;
  }
  const table = document.createElement("table");
  table.className = "lib-table ws-conn-table";
  table.innerHTML = `<thead><tr><th class="ws-conn-icon-cell"></th><th>Name</th><th>Description</th><th>Tools</th><th>Allowed</th><th class="ws-model-toggle-cell"></th><th class="lib-row-kebab-cell"></th></tr></thead>`;
  const tbody = document.createElement("tbody");
  const pg = paginate(shown, wsConnPage, WS_MODELS_PAGE_SIZE);
  wsConnPage = pg.state.page;
  // Tool counts load lazily, one page at a time — repaint once they land.
  const missing = pg.items.filter((slug) => !slugTools.has(slug));
  if (missing.length) {
    void Promise.all(missing.map((slug) => loadTools(slug))).then(() => {
      if (!selectedSlug) paintConnections();
    });
  }
  void primeConnectedIcons(
    pg.items.map((slug) => ({ connection: { accountId: "x", pipedreamSlug: slug } })),
    () => { if (!selectedSlug) paintConnections(); },
  );
  for (const slug of pg.items) {
    const meta = connMeta.get(slug) || { name: slug, icon: null };
    const kind = orgConnectors.find((c) => c.id === slug)?.kind || (personal ? "Personal app" : "");
    const universeTools = slugTools.has(slug) ? toolUniverse(slug).length : null;
    const cur = tools[slug];
    const allowedCount = cur == null ? (universeTools == null ? "All" : String(universeTools)) : String(cur.length);
    const on = !limited || (list || []).includes(slug);
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td class="ws-conn-icon-cell"><span class="ws-conn-icon"></span></td>` +
      `<td class="lib-table-name"></td>` +
      `<td class="lib-table-desc"></td>` +
      `<td class="lib-table-dim">${universeTools == null ? "—" : universeTools}</td>` +
      `<td class="lib-table-dim"></td>` +
      `<td class="ws-model-toggle-cell"><label class="settings-toggle ws-model-allow"><input type="checkbox" /><span class="toggle-switch"></span></label></td>`;
    const iconHost = tr.querySelector(".ws-conn-icon") as HTMLElement;
    const iconUrl = meta.icon || connectedIconCache[slug] || "";
    if (iconUrl) {
      const img = document.createElement("img");
      img.src = iconUrl; img.alt = "";
      iconHost.appendChild(img);
    } else iconHost.textContent = ICON_FALLBACK(meta.name);
    (tr.querySelector(".lib-table-name") as HTMLElement).textContent = meta.name;
    (tr.querySelector(".lib-table-desc") as HTMLElement).textContent = kind;
    (tr.children[4] as HTMLElement).textContent = on ? allowedCount : "—";
    const box = tr.querySelector<HTMLInputElement>("input")!;
    box.checked = on;
    box.disabled = !limited;
    box.addEventListener("change", () => {
      const cur2 = listOf(editing!, connMode) || [];
      const next = cur2.includes(slug) ? cur2.filter((x) => x !== slug) : [...cur2, slug];
      const map = toolsOf(editing!, connMode);
      if (!next.includes(slug)) delete map[slug];
      void commitConn(next, map).then(paintConnections);
    });
    tr.appendChild(kebabCell(() => [
      { icon: ROW_MENU_ICONS.edit, label: "Edit tools", onClick: () => {
        selectedSlug = slug;
        void loadTools(slug).then(paintConnections);
        paintConnections();
      } },
    ]));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  grid.appendChild(table);
  if (pagerHost && pg.state.totalPages > 1) {
    pagerHost.appendChild(renderPaginationBar(pg.state, (p) => { wsConnPage = p; paintConnections(); }));
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
  if (nameEl) nameEl.textContent = meta.name;

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

  // The STANDARD row grammar with the standard switch — title + description
  // left (clamped to two lines; clicking the text expands), toggle at the
  // right edge, one divider per row.
  const rowFor = (label: string, checked: boolean, desc: string | undefined, onToggle: () => void): HTMLElement => {
    const row = document.createElement("div");
    row.className = "set-pref-row ws-tool-line";
    const text = document.createElement("div");
    text.className = "set-pref-text";
    const title = document.createElement("div");
    title.className = "set-pref-title";
    title.textContent = label;
    text.appendChild(title);
    if (desc) {
      const d = document.createElement("div");
      d.className = "set-pref-desc";
      d.textContent = desc;
      text.appendChild(d);
      text.addEventListener("click", () => row.classList.toggle("expanded"));
    }
    const sw = document.createElement("label");
    sw.className = "settings-toggle ws-model-allow";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = checked;
    box.addEventListener("change", onToggle);
    const knob = document.createElement("span");
    knob.className = "toggle-switch";
    sw.append(box, knob);
    row.append(text, sw);
    return row;
  };

  const checked = cur === null ? tools.length : tools.filter((t) => cur.includes(t.name)).length;
  const master = $<HTMLInputElement>("ws-tools-all");
  if (master) {
    master.checked = checked === tools.length;
    master.onchange = () => {
      // "Every tool" is stored as an ABSENT slug, not an empty list — an
      // empty list means "no tools at all", which is the opposite.
      const next = { ...map };
      if (checked !== tools.length) delete next[slug];
      else next[slug] = [];
      void commitConn(listOf(editing!, connMode), next).then(paintTools);
    };
  }

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

// ── The "allow another" picker — a yo-modal, never an embedded panel ─────

function openAllowModal(): void {
  if (!editing) return;
  document.querySelectorAll(".yo-modal.ws-allow-overlay").forEach((n) => n.remove());
  const isWeb = !!(window as unknown as { __GLYPHH_WEB__?: boolean }).__GLYPHH_WEB__;
  let panelsWereHidden = false;
  if (!isWeb) void hidePanelsForModal().then((h) => { panelsWereHidden = h; });

  // The SAME skeleton as Connections › "+ New" (conn-modal): header with a
  // title + ✕, the search, a connector-card grid.
  const overlay = document.createElement("div");
  overlay.className = "conn-modal ws-allow-overlay";
  const backdrop = document.createElement("div");
  backdrop.className = "conn-modal-backdrop";
  const panel = document.createElement("div");
  panel.className = "conn-modal-panel";
  const header = document.createElement("div");
  header.className = "conn-modal-header";
  const title = document.createElement("h3");
  title.className = "conn-modal-title";
  title.textContent = "Add a connection";
  const closeBtn = document.createElement("button");
  closeBtn.className = "conn-modal-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "✕";
  header.append(title, closeBtn);
  const search = document.createElement("input");
  search.type = "text";
  search.className = "settings-input";
  search.placeholder = connMode === "personal" ? "Search apps…" : "Search org connectors…";
  search.spellcheck = false;
  search.autocomplete = "off";
  const listHost = document.createElement("div");
  listHost.className = "connector-grid";
  panel.append(header, search, listHost);

  const close = (): void => {
    overlay.remove();
    if (!isWeb) restorePanelsForModal(panelsWereHidden);
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", close);
  closeBtn.addEventListener("click", close);

  const paint = (): void => {
    const already = new Set(listOf(editing!, connMode) || []);
    const q = search.value.trim().toLowerCase();
    const rows = (connMode === "shared"
      ? orgConnectors.map((c) => ({ id: c.id, name: c.name, icon: c.icon }))
      : pickerResults
    ).filter((r) => !already.has(r.id))
      .filter((r) => !q || connMode === "personal" || r.name.toLowerCase().includes(q) || r.id.includes(q));
    listHost.innerHTML = "";
    if (!rows.length) {
      listHost.innerHTML = `<div class="crud-empty">${connMode === "shared" ? "Every org connector is already allowed." : "No apps match — type to search the catalog."}</div>`;
      return;
    }
    for (const r of rows) {
      connMeta.set(r.id, { name: r.name, icon: r.icon });
      const card = document.createElement("div");
      card.className = "connector-card";
      const iconHtml = document.createElement("span");
      if (r.icon) {
        const img = document.createElement("img");
        img.className = "connector-card-icon";
        img.src = r.icon; img.alt = "";
        iconHtml.replaceWith(img);
        card.appendChild(img);
      } else {
        iconHtml.className = "connector-card-initial";
        iconHtml.textContent = ICON_FALLBACK(r.name);
        card.appendChild(iconHtml);
      }
      const info = document.createElement("div");
      info.className = "connector-card-info";
      const name = document.createElement("div");
      name.className = "connector-card-name";
      name.textContent = r.name;
      info.appendChild(name);
      card.appendChild(info);
      card.addEventListener("click", () => {
        const list = listOf(editing!, connMode) || [];
        void commitConn([...list, r.id], toolsOf(editing!, connMode), `${r.name} allowed`).then(() => {
          close();
          paintConnections();
        });
      });
      listHost.appendChild(card);
    }
  };

  const runSearch = async (): Promise<void> => {
    if (connMode !== "personal") { paint(); return; }
    const q = search.value.trim();
    const res = await via<{ apps?: Array<{ id: string; name: string; icon?: string }> }>(
      (c) => c.connections?.apps?.({ ...(q ? { search: q } : {}), limit: 24 }), "workspacesAppSearch", q, 24);
    pickerResults = (res?.apps || []).map((a) => ({ id: a.id, name: a.name, icon: a.icon || null }));
    paint();
  };
  search.addEventListener("input", () => {
    window.clearTimeout(pickerTimer);
    pickerTimer = window.setTimeout(() => { void runSearch(); }, 220);
  });

  overlay.append(backdrop, panel);
  document.body.appendChild(overlay);
  search.focus();
  pickerResults = [];
  void runSearch();
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
  // Keys + 30-day spend enrich the table when the gateway lanes answer —
  // an unconfigured gateway must never blank the roles page.
  const windows = [1, 7, 30] as const;
  const [keys, ...spends] = await Promise.all([
    via<GatewayKeyLite[]>((c) => c.gateway?.keys?.(), "gatewayKeysList").catch(() => null),
    ...windows.map((days) =>
      via<{ byRole?: Array<{ key: string; spendUsd: number }> }>((c) => c.gateway?.metrics?.({ days }), "gatewayMetrics", { days }).catch(() => null)),
  ]);
  gwKeys = (keys as GatewayKeyLite[] | null) ?? [];
  roleSpend = { 1: new Map(), 7: new Map(), 30: new Map() };
  windows.forEach((days, i) => {
    const m = spends[i] as { byRole?: Array<{ key: string; spendUsd: number }> } | null;
    roleSpend[days] = new Map((m?.byRole ?? []).map((r) => [r.key, r.spendUsd]));
  });
  paintList();
  paintRoleKeys();
}

/** The role's minted keys, read-only (his order, 2026-09-11) — minting and
 *  revoking live under Gateway › API Keys. */
function paintRoleKeys(): void {
  const host = $("ws-keys-list");
  if (!host || !editing) return;
  host.innerHTML = "";
  const mine = gwKeys.filter((k) => k.workspaceId === editing!.id);
  if (!mine.length) {
    host.innerHTML = `<div class="crud-empty">No keys minted for this role yet — mint one under Gateway › API Keys.</div>`;
    return;
  }
  const day = (iso: string | null): string =>
    iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";
  const status = (k: GatewayKeyLite): string => {
    if (k.revokedAt) return `Revoked ${day(k.revokedAt)}`;
    if (k.expiresAt && Date.parse(k.expiresAt) < Date.now()) return `Expired ${day(k.expiresAt)}`;
    return k.expiresAt ? `Expires ${day(k.expiresAt)}` : "Never expires";
  };
  const table = document.createElement("table");
  table.className = "lib-table";
  table.innerHTML = `<thead><tr><th>Key</th><th>Created</th><th>Status</th></tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const k of mine) {
    const dead = !!k.revokedAt || !!(k.expiresAt && Date.parse(k.expiresAt) < Date.now());
    const tr = document.createElement("tr");
    if (dead) tr.style.opacity = "0.55";
    tr.innerHTML = `<td class="lib-table-name"><span class="ak-name"></span><span class="ak-prefix"></span></td>` +
      `<td class="lib-table-dim"></td><td class="lib-table-dim"></td>`;
    (tr.querySelector(".ak-name") as HTMLElement).textContent = k.name || "(unnamed)";
    (tr.querySelector(".ak-prefix") as HTMLElement).textContent = k.tokenHint;
    const tds = tr.querySelectorAll("td");
    if (tds[1]) tds[1].textContent = day(k.createdAt);
    if (tds[2]) tds[2].textContent = status(k);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.appendChild(table);
}

/** Security › Marketplace — the org's blocked-apps governance page. */
export function loadMarketplaceBlocks(): void {
  initWorkspaces();   // the block-input wiring rides the shared init
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
  $("ws-new-btn")?.addEventListener("click", () => newWorkspaceModal());
  $("ws-back")?.addEventListener("click", () => { editing = null; showEditor(false); paintList(); });

  // ── editor footer: Delete (confirmed) ← … Cancel · Save ─────────────────
  $("ws-cancel-btn")?.addEventListener("click", () => { editing = null; showEditor(false); paintList(); });
  $("ws-del-btn")?.addEventListener("click", () => { if (editing) void removeWorkspace(editing); });
  $("ws-save-btn")?.addEventListener("click", async () => {
    const btn = $<HTMLButtonElement>("ws-save-btn");
    if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
    const ok = await saveGeneral();
    if (btn) { btn.disabled = false; btn.textContent = "Save"; }
    if (!ok) return; // the inline error says why; stay on the form
    editing = null; showEditor(false); paintList();
  });

  for (const b of Array.from(document.querySelectorAll<HTMLElement>("#ws-tabs .app-detail-tab"))) {
    b.addEventListener("click", () => setTab(b.dataset.wstab || "general"));
  }
  for (const b of Array.from(document.querySelectorAll<HTMLElement>("#ws-conn-tabs .app-detail-tab"))) {
    b.addEventListener("click", () => {
      connMode = (b.dataset.wsconn as ConnMode) || "personal";
      selectedSlug = null;
      pickerResults = [];
      paintConnections();
    });
  }

  // General fields are STAGED — no per-keystroke autosave; the footer's Save
  // commits them (his spec, 2026-09-01, matching Domains).

  $("ws-models-search")?.addEventListener("input", () => { wsModelsPage = 0; paintModels(); });
  $("ws-models-filter")?.addEventListener("click", (e) => {
    e.stopPropagation();
    openModelsFilter(e.currentTarget as HTMLElement);
  });
  // LOOPS tab — the limit switch. On with no grants yet means "allowed: none",
  // which is a real (if strict) answer; the table is how you widen it.
  $("ws-limit-loops")?.addEventListener("change", (e) => {
    const on = (e.currentTarget as HTMLInputElement).checked;
    void patch({ limitLoops: on },
      on ? "Limited to selected loops" : "Every org loop allowed").then(paintLoopsTab);
  });
  // MEMBERS tab — search filters in place; + Add opens the org's roster.
  $<HTMLInputElement>("ws-members-search")?.addEventListener("input", () => {
    wsMembersPage = 0;
    void paintMembersTab();
  });
  $("ws-members-add")?.addEventListener("click", () => void openAddMemberModal());

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

  $("ws-conn-search")?.addEventListener("input", () => { wsConnPage = 0; paintConnections(); });
  $("ws-conn-add")?.addEventListener("click", openAllowModal);

  $("ws-tools-back")?.addEventListener("click", () => { selectedSlug = null; paintConnections(); });
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
  if (!role || !["org_admin", "admin", "super_admin"].includes(role)) { showPanel(false); return; }
  showPanel(true);
  // THE licensing read (help/plan-gate.ts → SDK client.plans). Roles ARE the
  // governance layer, so this whole surface is what Pro buys: shown, inert,
  // and labelled — never hidden, or nobody discovers it exists.
  void gateSurface(document.querySelector<HTMLElement>('.settings-panel[data-sub="workspaces"]'),
    "governance", "Roles");

  await loadWorkspaces();
  // The three universes a workspace narrows within. Each is independent — a
  // failed connector load must not blank the model list.
  const [models, connectors, cap, provs] = await Promise.all([
    // The MODELS PAGE's own list (rates included) — the role tab mirrors it,
    // active (supported) models only.
    via<Array<{ id: string; name: string; providerSlug: string; kind: string; inputCreditsPerMTok: number; outputCreditsPerMTok: number; supported: boolean; providerEnabled?: boolean }>>(
      (c) => c.orgModels?.list?.(), "orgModelsList"),
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
    via<Array<{ slug: string; name: string; enabledForOrg?: boolean }>>(
      (c) => c.catalog?.providers?.(), "orgProvidersList").catch(() => null),
  ]);
  orgProviderRows = (provs ?? [])
    .filter((pr) => pr.enabledForOrg === true)
    .map((pr) => ({ slug: pr.slug, name: pr.name || pr.slug }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // The role picker offers ONLY what the org actually reaches (his report,
  // 2026-09-11): enabled provider AND supported model — never the raw catalog.
  catalog = (models || []).filter((m) => m.supported !== false && m.providerEnabled !== false).map((m) => ({
    key: m.id, kind: m.kind, displayName: m.name, provider: m.providerSlug,
    inCr: m.inputCreditsPerMTok ?? 0, outCr: m.outputCreditsPerMTok ?? 0,
  }));
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
  if (editing) { paintModels(); paintProviderKeys(); paintConnections(); }
}

// ── Loops tab ────────────────────────────────────────────────────────────
//
// Which CLIs this role may drive. Each row carries the model it opens with,
// whether it is the role's default, and whether it routes semantically —
// per-loop, so a coding loop keeps its model while a summarising one is
// auto-routed (his ruling, 2026-09-12). Models come from the role's OWN
// allowed set: a role can never default to a model it may not use.

interface OrgLoopRow { cli: string; name: string; provider: string; enabled: boolean }
let orgLoopCatalog: OrgLoopRow[] = [];

const grantsOf = (w: Workspace | null): LoopGrant[] =>
  Array.isArray(w?.loopGrants) ? w!.loopGrants! : [];

/** Commit the whole grant list — the server normalises it (known CLIs, one
 *  row each, at most one default), so the UI never has to police that. */
async function commitLoops(grants: LoopGrant[], msg: string): Promise<void> {
  await patch({ loopGrants: grants }, msg);
}

async function paintLoopsTab(): Promise<void> {
  const grid = $("ws-loops-grid");
  const toggle = $<HTMLInputElement>("ws-limit-loops");
  const hint = $("ws-loops-hint");
  if (!grid || !editing) return;

  if (!orgLoopCatalog.length) {
    const r = await via<OrgLoopRow[]>((c) => c.orgLoops?.list?.(), "orgLoopsList");
    orgLoopCatalog = (r ?? []).filter((l) => l.enabled);
  }
  const limited = editing.limitLoops === true;
  if (toggle) toggle.checked = limited;
  if (hint) {
    hint.textContent = limited
      ? "Only the loops ticked below, each opening on the model you choose."
      : "Off — this role can use every loop the org runs.";
  }
  const grants = new Map(grantsOf(editing).map((g) => [g.cli, g]));
  // The role's OWN models, so a default can never name one it may not use.
  const allowed = modelsOf(editing);
  const usable = allowed === null ? catalog : catalog.filter((m) => allowed.includes(m.key));

  grid.innerHTML = "";
  if (!orgLoopCatalog.length) {
    grid.innerHTML = `<div class="crud-empty">Your organization hasn't enabled any loops yet — Organization &rarr; Loops.</div>`;
    return;
  }
  const table = document.createElement("table");
  table.className = "lib-table";
  table.innerHTML = `<thead><tr><th>Loop</th><th>Default model</th>`
    + `<th class="ws-model-toggle-cell">Force auto</th>`
    + `<th class="ws-model-toggle-cell">Default</th>`
    + `<th class="ws-model-toggle-cell">Allowed</th></tr></thead>`;
  const body = document.createElement("tbody");

  for (const loop of orgLoopCatalog) {
    const g = grants.get(loop.cli);
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="lib-table-name"></td><td></td>`
      + `<td class="ws-model-toggle-cell"><label class="settings-toggle"><input type="checkbox" class="wl-force" /><span class="toggle-switch"></span></label></td>`
      + `<td class="ws-model-toggle-cell"><label class="settings-toggle"><input type="radio" name="wl-default" class="wl-default" /><span class="toggle-switch"></span></label></td>`
      + `<td class="ws-model-toggle-cell"><label class="settings-toggle"><input type="checkbox" class="wl-on" /><span class="toggle-switch"></span></label></td>`;
    (tr.querySelector(".lib-table-name") as HTMLElement).textContent = loop.name;

    // Default model — this loop's vendor, within the role's allowed set.
    const sel = document.createElement("select");
    sel.className = "settings-input ws-loop-model";
    const pool = usable.filter((m) => !loop.provider || m.provider === loop.provider);
    const list = pool.length ? pool : usable;
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = "The CLI's own default";
    sel.appendChild(auto);
    for (const m of list) {
      const o = document.createElement("option");
      o.value = m.key;
      o.textContent = m.displayName || m.key;
      sel.appendChild(o);
    }
    sel.value = g?.model ?? "";
    (tr.children[1] as HTMLElement).appendChild(sel);

    const on = tr.querySelector<HTMLInputElement>(".wl-on")!;
    const force = tr.querySelector<HTMLInputElement>(".wl-force")!;
    const dflt = tr.querySelector<HTMLInputElement>(".wl-default")!;
    on.checked = !!g;
    force.checked = g?.forceAuto === true;
    dflt.checked = g?.isDefault === true;
    // A loop this role doesn't grant can't carry a model or a flag.
    sel.disabled = force.disabled = dflt.disabled = !g;
    // Forcing auto makes the default model moot — the gateway chooses.
    if (force.checked) sel.disabled = true;

    /** Rebuild the whole list from the table, so one write is one truth. */
    const commit = (msg: string): void => {
      const next: LoopGrant[] = [];
      for (const row of Array.from(body.querySelectorAll<HTMLElement>("tr"))) {
        const cli = row.dataset.cli!;
        if (!row.querySelector<HTMLInputElement>(".wl-on")!.checked) continue;
        const f = row.querySelector<HTMLInputElement>(".wl-force")!.checked;
        const d = row.querySelector<HTMLInputElement>(".wl-default")!.checked;
        next.push({
          cli,
          model: row.querySelector<HTMLSelectElement>(".ws-loop-model")!.value,
          ...(d ? { isDefault: true } : {}),
          ...(f ? { forceAuto: true } : {}),
        });
      }
      void commitLoops(next, msg).then(paintLoopsTab);
    };
    on.addEventListener("change", () => commit(on.checked ? `${loop.name} allowed` : `${loop.name} removed`));
    force.addEventListener("change", () => commit(force.checked ? `${loop.name} routes automatically` : `${loop.name} picks its model`));
    // Radio, so the browser clears the others — only one default can exist.
    dflt.addEventListener("change", () => commit(`${loop.name} is the default loop`));
    sel.addEventListener("change", () => commit("Default model set"));

    tr.dataset.cli = loop.cli;
    body.appendChild(tr);
  }
  table.appendChild(body);
  grid.appendChild(table);
}

// ── Members tab ──────────────────────────────────────────────────────────
//
// Who holds this role. The models page's grammar: search, pagination, an add
// button that opens the org's members in a modal, and a per-row kebab whose
// Remove hands the member back to the BASE role.
//
// There is no "unassign" on the server and there shouldn't be: everyone
// belongs to a role, and the base role IS "no special role". Removal is an
// assignment like any other.

interface OrgMember { userId: string; email: string; name: string | null; role: string; workspaceId: string | null }
const WS_MEMBERS_PAGE_SIZE = 15;   // 15 everywhere — the one pagination size
let wsMembers: OrgMember[] = [];
let wsMembersPage = 0;

async function loadOrgMembers(force = false): Promise<void> {
  if (wsMembers.length && !force) return;
  wsMembers = (await via<OrgMember[]>((c) => c.members?.list?.(), "orgMembersList")) ?? [];
}

/** Move a member to a role — assignment is the only verb there is. */
async function assignMember(userId: string, workspaceId: string, msg: string): Promise<void> {
  setStatus("Saving…", "");
  const ok = await via<void>((c) => c.workspaces?.assign?.(userId, workspaceId), "workspacesAssign", userId, workspaceId);
  if (ok === null) { setStatus("Not saved", "error"); return; }
  setStatus(msg, "success");
  await loadOrgMembers(true);
  await paintMembersTab();
}

async function paintMembersTab(): Promise<void> {
  const grid = $("ws-members-grid");
  const pager = $("ws-members-pager");
  if (!grid || !editing) return;
  await loadOrgMembers();

  const q = ($<HTMLInputElement>("ws-members-search")?.value || "").trim().toLowerCase();
  const mine = wsMembers
    .filter((m) => m.workspaceId === editing!.id)
    .filter((m) => !q || `${m.name ?? ""} ${m.email}`.toLowerCase().includes(q));

  grid.innerHTML = "";
  if (pager) pager.innerHTML = "";
  if (!mine.length) {
    grid.innerHTML = q
      ? `<div class="crud-empty">No members matching "${escapeHtml(q)}"</div>`
      : `<div class="crud-empty">No one holds this role yet — <b>+ Add member</b> assigns someone.</div>`;
    return;
  }

  const { items, state } = paginate(mine, wsMembersPage, WS_MEMBERS_PAGE_SIZE);
  wsMembersPage = state.page;
  const table = document.createElement("table");
  table.className = "lib-table";
  table.innerHTML = `<thead><tr><th>Name</th><th>Email</th><th class="lib-row-kebab-cell"></th></tr></thead>`;
  const body = document.createElement("tbody");
  for (const m of items) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="lib-table-name"></td><td class="lib-table-desc"></td>`;
    (tr.querySelector(".lib-table-name") as HTMLElement).textContent = m.name || "—";
    (tr.querySelector(".lib-table-desc") as HTMLElement).textContent = m.email;
    tr.appendChild(kebabCell(() => [
      { icon: ROW_MENU_ICONS.delete, label: "Remove", danger: true, onClick: () => {
        void (async () => {
          const sure = await confirmAction({
            title: `Remove ${m.name || m.email} from ${editing!.name}?`,
            body: "They move back to the base role and keep whatever it allows.",
            confirmLabel: "Remove", danger: true,
          });
          if (!sure) return;
          const base = workspaces.find((w) => w.isBase);
          if (!base) { setError("This organization has no base role to move them to."); return; }
          await assignMember(m.userId, base.id, "Removed from this role");
        })();
      } },
    ]));
    body.appendChild(tr);
  }
  table.appendChild(body);
  grid.appendChild(table);
  if (state.totalPages > 1 && pager) {
    pager.appendChild(renderPaginationBar(state, (p) => { wsMembersPage = p; void paintMembersTab(); }));
  }
}

/** + Add member — the org's members, minus the ones already here. */
async function openAddMemberModal(): Promise<void> {
  if (!editing) return;
  await loadOrgMembers(true);
  const candidates = wsMembers.filter((m) => m.workspaceId !== editing!.id);

  const host = document.createElement("div");
  const search = document.createElement("input");
  search.type = "text";
  search.className = "crud-search";
  search.placeholder = "Search members…";
  search.spellcheck = false;
  const list = document.createElement("div");
  list.className = "ws-add-member-list";
  host.append(search, list);

  const paint = (): void => {
    const q = search.value.trim().toLowerCase();
    const rows = candidates.filter((m) => !q || `${m.name ?? ""} ${m.email}`.toLowerCase().includes(q));
    list.innerHTML = "";
    if (!rows.length) {
      list.innerHTML = `<div class="crud-empty">${candidates.length ? "No members match." : "Everyone in the organization already holds this role."}</div>`;
      return;
    }
    const table = document.createElement("table");
    table.className = "lib-table";
    table.innerHTML = `<thead><tr><th>Name</th><th>Email</th></tr></thead>`;
    const body = document.createElement("tbody");
    for (const m of rows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td class="lib-table-name"></td><td class="lib-table-desc"></td>`;
      (tr.querySelector(".lib-table-name") as HTMLElement).textContent = m.name || "—";
      (tr.querySelector(".lib-table-desc") as HTMLElement).textContent = m.email;
      tr.addEventListener("click", () => {
        close();
        void assignMember(m.userId, editing!.id, `${m.name || m.email} added`);
      });
      body.appendChild(tr);
    }
    table.appendChild(body);
    list.appendChild(table);
  };
  search.addEventListener("input", paint);
  paint();

  // formModal is FIELD-based; this needs a searchable table, so it uses the
  // same overlay chrome directly. Picking a row IS the action — a Save button
  // would be a second click for a choice already made.
  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay";
  overlay.innerHTML = `<div class="confirm-box ws-add-member-box" role="dialog" aria-modal="true">
      <div class="confirm-head"><h3></h3></div>
      <div class="confirm-body"></div>
      <div class="confirm-actions"><button type="button" class="action-btn ws-add-cancel">Close</button></div>
    </div>`;
  (overlay.querySelector("h3") as HTMLElement).textContent = `Add to ${editing.name}`;
  overlay.querySelector(".confirm-body")!.appendChild(host);
  const hidden = await hidePanelsForModal();
  const close = (): void => { overlay.remove(); restorePanelsForModal(hidden); };
  overlay.querySelector(".ws-add-cancel")!.addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", function esc(e) {
    if (e.key !== "Escape") return;
    document.removeEventListener("keydown", esc);
    close();
  });
  document.body.appendChild(overlay);
  search.focus();
}
