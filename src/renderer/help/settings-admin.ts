/**
 * settings-admin.ts — Settings › Platform (super_admin only).
 *
 * The platform admin console, ported from the platform's admin pages onto the
 * settings modal's existing grammar (lib-table lists, crud-toolbar, the
 * crud-inline-form editor standard, dash-card + Chart.js usage):
 *
 *   • Catalog (admin/models)  — the GLOBAL model catalog: rates, context
 *     window, availability. Wire rates are MICRO-credits per MTok; edits go
 *     through PUT /api/admin/models/:provider/:model.
 *   • Plans (admin/pricing + admin/plans) — global tier pricing (PATCH
 *     /api/admin/plans/:tier) plus the Stripe price HISTORY contract
 *     (plan_prices: append a price, promote one to active — never mutate).
 *   • Usage (admin/usage) — platform-wide rollups: per-day series, top
 *     spenders, and the region × shared|dedicated × tier breakdown.
 *   • Orgs (admin/orgs) — the org list + admin credit grants.
 *
 * Transport — web → window.glyphhSdk.admin (checked FIRST; on web
 * window.glyphh is a Proxy that fabricates methods); desktop →
 * window.glyphh.admin* IPC (admin-ipc.ts → main-process SDK). Neither → an
 * honest "not available" message. The server enforces super_admin regardless;
 * the nav gate (navigation.ts) only hides the entries.
 */

import { escapeHtml, paginate, renderPaginationBar, confirmAction } from "./shared.js";
import { kebabCell, ROW_MENU_ICONS } from "./lib-editor.js";

// Chart.js is loaded globally (app-libs/chart.js → window.Chart) by home.html.
declare const Chart: { new (ctx: CanvasRenderingContext2D, cfg: unknown): { destroy: () => void } };

const MICRO = 1_000_000;

// ── Shapes (structural mirrors of the SDK's contract/admin.ts) ────────────

interface AdminModel {
  provider: string;
  model: string;
  display_name: string;
  alias: string | null;
  modality: string;   // chat | image | video | speech | transcription
  rate_unit: string;  // mtok | image | second | mchar | minute
  input_credits_per_mtok: number | null;  // MICRO-credits per unit on the wire
  output_credits_per_mtok: number | null;
  context_window: number | null;
  max_output_tokens: number | null;
  active: boolean;
  /** Live per-org default: orgs with no explicit override follow this. */
  default_on: boolean;
}
interface AdminModelPatch {
  display_name?: string;
  alias?: string | null;
  active?: boolean;
  default_on?: boolean;
  modality?: string;
  rate_unit?: string;
  input_credits_per_mtok?: number | null;
  output_credits_per_mtok?: number | null;
  context_window?: number | null;
  max_output_tokens?: number | null;
}
interface AdminPlan {
  tier: string;
  display_name: string;
  monthly_usd_cents: number;
  included_credits: number;               // MICRO-credits per seat per month
  max_seats: number;
  active: boolean;
  org_id: string | null;
  org_name: string | null;
  /** Gateway requests/minute for orgs on this plan; null = unlimited. */
  rate_limit_rpm?: number | null;
}
interface AdminPlanPatch {
  display_name?: string;
  monthly_usd_cents?: number;
  included_credits?: number;
  max_seats?: number;
  active?: boolean;
  rate_limit_rpm?: number | null;
}
interface AdminPlanPrice { id: string; stripePriceId: string; active: boolean; createdAt: string }
interface AdminUsageByUser { userId: string; email: string; name: string; requests: number; credits: number; tokens: number }
interface AdminUsageDay { day: string; credits: number; requests: number }
interface AdminUsageByRuntime {
  region: string; mode: string; tier: string;
  runtimes: number; orgs: number; users: number; requests: number; credits: number;
}
interface AdminOrgRow { id: string; name: string; tier: string; billing_status: string; member_count: number }
interface AdminOrgMember { id: string; first_name: string; last_name: string; email: string; role: string; status: string }
interface AdminOrgDetail extends AdminOrgRow {
  max_seats: number; created_at: string;
  credits: { balance: number; used: number };  // micro-credits
  members: AdminOrgMember[];
}
type AdminOrgPatch = { name?: string; tier?: string; billingStatus?: string };

// ── Transport ─────────────────────────────────────────────────────────────

interface SdkAdmin {
  models?: () => Promise<{ models: AdminModel[] }>;
  updateModel?: (provider: string, model: string, patch: AdminModelPatch) => Promise<{ model: AdminModel }>;
  createProvider?: (input: { slug: string; name: string; kind: "proxied" | "open_weight"; alias?: string | null; baseUrl?: string | null }) => Promise<unknown>;
  createModel?: (input: { id: string; providerSlug: string; name: string; kind: "proxied" | "open_weight"; modality?: string; rateUnit?: string; alias?: string | null; contextWindow?: number | null; inputCreditsPerMTok: number; outputCreditsPerMTok: number }) => Promise<unknown>;
  plans?: () => Promise<{ plans: AdminPlan[] }>;
  updatePlan?: (tier: string, patch: AdminPlanPatch) => Promise<{ plan: AdminPlan }>;
  createPlan?: (input: AdminPlanPatch & { tier: string }) => Promise<{ plan: AdminPlan }>;
  providerKeys?: (slug: string) => Promise<{ keys: AdminProviderKey[] }>;
  addProviderKey?: (slug: string, key: string, label?: string) => Promise<{ key: AdminProviderKey }>;
  setProviderKeyActive?: (id: string, active: boolean) => Promise<{ key: AdminProviderKey }>;
  removeProviderKey?: (id: string) => Promise<void>;
  planPrices?: (tier: string) => Promise<AdminPlanPrice[]>;
  addPlanPrice?: (tier: string, stripePriceId: string) => Promise<AdminPlanPrice>;
  activatePlanPrice?: (id: string) => Promise<AdminPlanPrice>;
  removePlanPrice?: (id: string) => Promise<void>;
  usageByUser?: (days?: number) => Promise<{ users: AdminUsageByUser[] }>;
  usageDaily?: (q: { from: string; to: string; tz?: string }) => Promise<{ days: AdminUsageDay[] }>;
  usageByRuntime?: (q: { from: string; to: string }) => Promise<{ runtimes: AdminUsageByRuntime[] }>;
  orgs?: (q?: { q?: string; page?: number; limit?: number }) => Promise<{ orgs: AdminOrgRow[]; total: number }>;
  org?: (id: string) => Promise<AdminOrgDetail>;
  updateOrg?: (id: string, patch: AdminOrgPatch) => Promise<AdminOrgDetail>;
  grantCredits?: (id: string, credits: number, note?: string) => Promise<{ balance: number }>;
}
interface DesktopAdminIpc {
  adminModels?: () => Promise<{ models: AdminModel[] }>;
  adminModelUpdate?: (provider: string, model: string, patch: AdminModelPatch) => Promise<{ ok: boolean; model?: AdminModel; error?: string }>;
  adminProviderCreate?: (input: Record<string, unknown>) => Promise<{ ok: boolean; provider?: unknown; error?: string }>;
  adminModelCreate?: (input: Record<string, unknown>) => Promise<{ ok: boolean; model?: unknown; error?: string }>;
  adminPlans?: () => Promise<{ plans: AdminPlan[] }>;
  adminPlanUpdate?: (tier: string, patch: AdminPlanPatch) => Promise<{ ok: boolean; plan?: AdminPlan; error?: string }>;
  adminPlanCreate?: (input: AdminPlanPatch & { tier: string }) => Promise<{ ok: boolean; plan?: AdminPlan; error?: string }>;
  adminProviderKeys?: (slug: string) => Promise<{ ok: boolean; keys?: AdminProviderKey[]; error?: string }>;
  adminProviderKeyAdd?: (slug: string, key: string, label?: string) => Promise<{ ok: boolean; key?: AdminProviderKey; error?: string }>;
  adminProviderKeyActive?: (id: string, active: boolean) => Promise<{ ok: boolean; key?: AdminProviderKey; error?: string }>;
  adminProviderKeyRemove?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  adminPlanPrices?: (tier: string) => Promise<AdminPlanPrice[]>;
  adminPlanPriceAdd?: (tier: string, priceId: string) => Promise<{ ok: boolean; price?: AdminPlanPrice; error?: string }>;
  adminPlanPriceActivate?: (id: string) => Promise<{ ok: boolean; price?: AdminPlanPrice; error?: string }>;
  adminPlanPriceRemove?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  adminUsageByUser?: (days: number) => Promise<{ users: AdminUsageByUser[] }>;
  adminUsageDaily?: (q: { from: string; to: string; tz?: string }) => Promise<{ days: AdminUsageDay[] }>;
  adminUsageByRuntime?: (q: { from: string; to: string }) => Promise<{ runtimes: AdminUsageByRuntime[] }>;
  adminOrgs?: (q: { q?: string; page?: number; limit?: number }) => Promise<{ orgs: AdminOrgRow[]; total: number }>;
  adminOrg?: (id: string) => Promise<AdminOrgDetail>;
  adminOrgUpdate?: (id: string, patch: AdminOrgPatch) => Promise<AdminOrgDetail>;
  adminOrgGrantCredits?: (id: string, credits: number, note?: string) => Promise<{ ok: boolean; balance?: number; error?: string }>;
}

const NO_TRANSPORT = "This build can't reach the admin console.";

const sdkAdmin = (): SdkAdmin | null =>
  (window as unknown as { glyphhSdk?: { admin?: SdkAdmin } }).glyphhSdk?.admin ?? null;
const ipcAdmin = (): DesktopAdminIpc =>
  (window as unknown as { glyphh?: DesktopAdminIpc }).glyphh ?? {};

type WriteResult<T> = { ok: true; data: T } | { ok: false; error: string };

const errText = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)) || "Request failed";

/** A read on whichever transport this surface has; REJECTS when neither can
 *  serve it, so panels paint an honest "couldn't load". SDK first — on web
 *  window.glyphh is a fabricating Proxy (settings-api.ts's trap). */
async function read<T>(web: (a: SdkAdmin) => Promise<T> | undefined, desk: (g: DesktopAdminIpc) => Promise<T> | undefined): Promise<T> {
  const a = sdkAdmin();
  if (a) {
    const p = web(a);
    if (p) return p;
  }
  const p = desk(ipcAdmin());
  if (p) {
    const r = await p;
    // On web, window.glyphh fabricates functions that resolve undefined — a
    // nullish answer is a MISSING transport, not an empty result.
    if (r == null) throw new Error(NO_TRANSPORT);
    return r;
  }
  throw new Error(NO_TRANSPORT);
}

/** A write on whichever transport exists — always the { ok, error } envelope
 *  (a 403 from a non-super-admin is an EXPECTED outcome a form must explain). */
async function write<T>(
  web: (a: SdkAdmin) => Promise<T> | undefined,
  desk: (g: DesktopAdminIpc) => Promise<({ ok: boolean; error?: string } & Record<string, unknown>)> | undefined,
  field: string,
): Promise<WriteResult<T>> {
  const a = sdkAdmin();
  if (a) {
    try {
      const p = web(a);
      if (p) return { ok: true, data: await p };
    } catch (err) { return { ok: false, error: errText(err) }; }
  }
  try {
    const p = desk(ipcAdmin());
    if (!p) return { ok: false, error: NO_TRANSPORT };
    const res = await p;
    if (!res || typeof res.ok !== "boolean") return { ok: false, error: NO_TRANSPORT };
    if (!res.ok) return { ok: false, error: res.error || "Request failed" };
    return { ok: true, data: res[field] as T };
  } catch (err) { return { ok: false, error: errText(err) }; }
}

// ── Small shared helpers ──────────────────────────────────────────────────

const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

const fmtInt = (n: number): string => Math.max(0, Math.round(n || 0)).toLocaleString();
const microToCredits = (micro: number | null | undefined): number => Math.round((Number(micro) || 0) / MICRO);
const fmtDate = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};

function setErr(id: string, msg: string): void {
  const el = $(id);
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

/** The super_admin gate every Platform panel shares: unknown role loads and
 *  lets the server's 403 speak; a KNOWN non-super-admin gets the honest note. */
async function isSuperAdmin(): Promise<boolean | null> {
  try {
    const info = await window.glyphh.getAccountInfo?.();
    if ((info as { isPlatformAdmin?: boolean } | null)?.isPlatformAdmin === true) return true;
    return info?.role ? info.role === "super_admin" : null;
  } catch { return null; }
}

function gatePanel(gateId: string, bodyId: string, allowed: boolean): void {
  $(gateId)?.classList.toggle("hidden", allowed);
  $(bodyId)?.classList.toggle("hidden", !allowed);
}

/** A lib-table skeleton — the SAME list grammar Skills/Loops render. */
function mkTable(headers: string[], kebab: boolean): { table: HTMLTableElement; tbody: HTMLTableSectionElement } {
  const table = document.createElement("table");
  table.className = "lib-table";
  const thead = document.createElement("thead");
  const tr = document.createElement("tr");
  for (const h of headers) {
    const th = document.createElement("th");
    th.textContent = h;
    tr.appendChild(th);
  }
  if (kebab) {
    const th = document.createElement("th");
    th.className = "lib-row-kebab-cell";
    tr.appendChild(th);
  }
  thead.appendChild(tr);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  table.appendChild(tbody);
  return { table, tbody };
}

const inputVal = (id: string): string => ($<HTMLInputElement>(id)?.value ?? "").trim();
/** "" → null, else a non-negative integer — the blank-clears convention the
 *  platform's model/plan forms used. */
const numOrNull = (s: string): number | null => (s === "" ? null : Math.max(0, Math.round(Number(s) || 0)));

// ═══════════════════════════════════════════════════════════════════════════
// Catalog (global models)
// ═══════════════════════════════════════════════════════════════════════════

let models: AdminModel[] = [];
let modelsPage = 0;
let editingModel: AdminModel | null = null;
let modelsWired = false;

const modelId = (m: AdminModel): string => `${m.provider}::${m.model}`;

function showModelEditor(on: boolean): void {
  $("pa-models-list-view")?.classList.toggle("hidden", on);
  $("pa-model-editor")?.classList.toggle("hidden", !on);
}

function paintModels(): void {
  const wrap = $("pa-models-list");
  if (!wrap) return;
  const q = inputVal("pa-models-search").toLowerCase();
  const rows = models.filter((m) =>
    !q || m.display_name.toLowerCase().includes(q) || modelId(m).toLowerCase().includes(q));
  wrap.innerHTML = "";
  if (!models.length) { wrap.innerHTML = `<div class="crud-empty">No models in the catalog yet.</div>`; return; }
  if (!rows.length) { wrap.innerHTML = `<div class="crud-empty">No models match your search.</div>`; return; }

  const { items, state } = paginate(rows, modelsPage);
  modelsPage = state.page;
  const { table, tbody } = mkTable(["Model", "Id", "Rates (cr/MTok)", "Context", "Status"], true);
  for (const m of items) {
    const tr = document.createElement("tr");
    const rates = m.input_credits_per_mtok == null && m.output_credits_per_mtok == null
      ? "BYOK / direct"
      : `${fmtInt(microToCredits(m.input_credits_per_mtok))} in · ${fmtInt(microToCredits(m.output_credits_per_mtok))} out`;
    tr.innerHTML = `
      <td class="lib-table-name"></td>
      <td class="lib-table-desc"></td>
      <td>${escapeHtml(rates)}</td>
      <td class="lib-table-dim">${m.context_window ? escapeHtml(fmtInt(m.context_window)) : "—"}</td>`;
    const status = document.createElement("td");
    status.innerHTML = m.active ? `<span class="lib-badge">Active</span>` : `<span class="lib-table-dim">Inactive</span>`;
    tr.appendChild(status);
    const nameCell = tr.querySelector(".lib-table-name");
    if (nameCell) nameCell.textContent = m.display_name;
    const idCell = tr.querySelector(".lib-table-desc");
    if (idCell) idCell.textContent = modelId(m);
    tr.addEventListener("click", () => openModelEditor(m));
    tr.appendChild(kebabCell(() => [
      { icon: ROW_MENU_ICONS.edit, label: "Edit", onClick: () => openModelEditor(m) },
      { icon: ROW_MENU_ICONS.delete, label: m.active ? "Deactivate" : "Activate", danger: m.active, onClick: () => {
        void (async () => {
          const sure = await confirmAction(m.active
            ? { title: `Deactivate ${m.display_name}?`, body: "The model disappears from every org's catalog until reactivated.", confirmLabel: "Deactivate", danger: true }
            : { title: `Activate ${m.display_name}?`, body: "Organizations can enable and use it again.", confirmLabel: "Activate" });
          if (!sure) return;
          const res = await write<AdminModel>(
            (a) => a.updateModel?.(m.provider, m.model, { active: !m.active })?.then((r) => r.model),
            (g) => g.adminModelUpdate?.(m.provider, m.model, { active: !m.active }), "model");
          if (!res.ok) { setErr("pa-models-error", res.error); return; }
          setErr("pa-models-error", "");
          await loadAdminModels();
        })();
      } },
    ]));
    tbody.appendChild(tr);
  }
  wrap.appendChild(table);
  if (state.totalPages > 1) wrap.appendChild(renderPaginationBar(state, (p) => { modelsPage = p; paintModels(); }));
}

/** The catalog's providers — real rows (GET /api/catalog/providers), searchable,
 *  click to EDIT (the create form pre-filled; POST /api/admin/providers is an
 *  upsert, so the same save updates). Platform keys are server config; never shown. */
interface CatalogProvider { slug: string; name: string; kind: string; baseUrl: string | null; alias: string | null }
let providers: CatalogProvider[] = [];
let providerSearch = "";
/** The slug being edited, or null when the form is creating a new provider. */
let editingProviderSlug: string | null = null;

async function loadProviders(): Promise<void> {
  try {
    // Web first: the raw SDK client (window.glyphh there is a fabricating
    // Proxy whose calls resolve undefined). Desktop: the models IPC.
    const sdk = (window as unknown as { glyphhSdk?: { catalog?: { providers?: () => Promise<CatalogProvider[]> } } }).glyphhSdk;
    if (sdk?.catalog?.providers) {
      providers = await sdk.catalog.providers();
    } else {
      const r = await (window.glyphh as unknown as {
        orgProvidersList?: () => Promise<{ ok: boolean; data?: CatalogProvider[] }>;
      }).orgProvidersList?.();
      if (r?.ok && Array.isArray(r.data)) providers = r.data;
    }
  } catch { /* offline — the model-derived counts still paint below */ }
  paintProviders();
}

function paintProviders(): void {
  const wrap = $("pa-providers-list");
  if (!wrap) return;
  const counts = new Map<string, { total: number; active: number }>();
  for (const m of models) {
    const cur = counts.get(m.provider) || { total: 0, active: 0 };
    cur.total += 1;
    if (m.active) cur.active += 1;
    counts.set(m.provider, cur);
  }
  // Real provider rows when the list loaded; model-derived slugs as fallback.
  const rows: CatalogProvider[] = providers.length
    ? providers
    : [...counts.keys()].map((slug) => ({ slug, name: slug, kind: "proxied", baseUrl: null, alias: null }));
  const q = providerSearch.trim().toLowerCase();
  const shown = rows
    .filter((p) => !q || p.slug.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  wrap.innerHTML = "";
  if (!shown.length) { wrap.innerHTML = `<div class="crud-empty">${q ? "No providers match." : "No providers yet."}</div>`; return; }
  const { table, tbody } = mkTable(["Provider", "Slug", "Base URL", "Models", "Active"], false);
  for (const p of shown) {
    const c = counts.get(p.slug) || { total: 0, active: 0 };
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="lib-table-name"></td>
      <td class="lib-table-desc"></td>
      <td class="lib-table-dim pa-prov-url"></td>
      <td>${fmtInt(c.total)}</td>
      <td class="lib-table-dim">${fmtInt(c.active)}</td>`;
    (tr.querySelector(".lib-table-name") as HTMLElement).textContent = p.name;
    (tr.querySelector(".lib-table-desc") as HTMLElement).textContent = p.slug;
    (tr.querySelector(".pa-prov-url") as HTMLElement).textContent = p.baseUrl || "—";
    tr.style.cursor = "pointer";
    tr.addEventListener("click", () => openProviderEditor(p));
    tbody.appendChild(tr);
  }
  wrap.appendChild(table);
}

/** The provider editor replaces the WHOLE catalog list view (the model/plan
 *  editor standard) — only the form + its ← Providers breadcrumb show. */
function showProviderEditor(on: boolean): void {
  $("pa-models-list-view")?.classList.toggle("hidden", on);
  $("pa-provider-create")?.classList.toggle("hidden", !on);
  if (!on) editingProviderSlug = null;
}

/** Open the provider form pre-filled for an EDIT (slug is identity — locked). */
function openProviderEditor(p: CatalogProvider): void {
  editingProviderSlug = p.slug;
  setErr("pa-provider-create-error", "");
  const title = $("pa-provider-title");
  if (title) title.textContent = `${p.name} · ${p.slug}`;
  const set = (id: string, v: string): void => { const el = $<HTMLInputElement>(id); if (el) el.value = v; };
  set("pa-pc-slug", p.slug);
  set("pa-pc-name", p.name);
  set("pa-pc-url", p.baseUrl || "");
  const kind = $<HTMLSelectElement>("pa-pc-kind");
  if (kind) kind.value = p.kind === "open_weight" ? "open_weight" : "proxied";
  const slug = $<HTMLInputElement>("pa-pc-slug");
  if (slug) slug.readOnly = true;
  const save = $<HTMLButtonElement>("pa-pc-save");
  if (save) save.textContent = "Save provider";
  showProviderEditor(true);
  // Platform keys exist only for a SAVED provider — the section shows on edit.
  $("pa-pc-keys-group")?.classList.remove("hidden");
  providerKeys = [];
  paintProviderKeys();
  void refreshProviderKeys();
}

// ── Platform provider keys (rotation: append + activate/deactivate) ─────────
interface AdminProviderKey { id: string; label: string; hint: string; active: boolean; createdAt: string }
let providerKeys: AdminProviderKey[] = [];

async function refreshProviderKeys(): Promise<void> {
  const slug = editingProviderSlug;
  if (!slug) return;
  // BOTH transports (the file's read() contract) — window.glyphh on web is a
  // fabricating Proxy, so an IPC-only call silently resolves undefined there.
  try {
    const r = await read(
      (a) => a.providerKeys?.(slug)?.then((x) => x.keys),
      (g) => g.adminProviderKeys?.(slug)?.then((x) => x.keys ?? []),
    );
    if (Array.isArray(r)) providerKeys = r;
    setErr("pa-provider-create-error", "");
  } catch (err) {
    setErr("pa-provider-create-error", `Couldn't load keys — ${errText(err)}`);
  }
  paintProviderKeys();
}

function paintProviderKeys(): void {
  const wrap = $("pa-pc-keys-list");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!providerKeys.length) {
    wrap.innerHTML = `<div class="crud-empty">No platform keys yet — the gateway falls back to the server's env keys.</div>`;
    return;
  }
  const { table, tbody } = mkTable(["Key", "Label", "Status", "Added"], true);
  for (const k of providerKeys) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="lib-table-name">••••${escapeHtml(k.hint)}</td><td class="lib-table-desc"></td><td></td><td class="lib-table-dim">${escapeHtml(fmtDate(k.createdAt))}</td>`;
    (tr.querySelector(".lib-table-desc") as HTMLElement).textContent = k.label || "—";
    (tr.querySelector("td:nth-child(3)") as HTMLElement).innerHTML = k.active
      ? `<span class="lib-badge">Active</span>` : `<span class="lib-table-dim">Off</span>`;
    tr.appendChild(kebabCell(() => [
      { icon: ROW_MENU_ICONS.edit, label: k.active ? "Deactivate" : "Activate", onClick: () => {
        void (async () => {
          const r = await write<AdminProviderKey>(
            (a) => a.setProviderKeyActive?.(k.id, !k.active)?.then((x) => x.key),
            (g) => g.adminProviderKeyActive?.(k.id, !k.active), "key");
          if (!r.ok) { setErr("pa-provider-create-error", r.error); return; }
          await refreshProviderKeys();
        })();
      } },
      { icon: ROW_MENU_ICONS.delete, label: "Remove", danger: true, onClick: () => {
        void (async () => {
          const sure = await confirmAction({ title: `Remove key ••••${k.hint}?`, body: "Calls stop using it immediately. This cannot be undone.", confirmLabel: "Remove", danger: true });
          if (!sure) return;
          const r = await write<unknown>(
            (a) => a.removeProviderKey?.(k.id)?.then(() => true),
            (g) => g.adminProviderKeyRemove?.(k.id), "ok");
          if (!r.ok) { setErr("pa-provider-create-error", r.error); return; }
          await refreshProviderKeys();
        })();
      } },
    ]));
    tbody.appendChild(tr);
  }
  wrap.appendChild(table);
}

async function addProviderKeyFromForm(): Promise<void> {
  const slug = editingProviderSlug;
  if (!slug) return;
  const key = inputVal("pa-pc-key-new").trim();
  if (key.length < 8) { setErr("pa-provider-create-error", "Paste the full API key."); return; }
  const label = inputVal("pa-pc-key-label").trim();
  const btn = $<HTMLButtonElement>("pa-pc-key-add");
  if (btn) btn.disabled = true;
  const r = await write<AdminProviderKey>(
    (a) => a.addProviderKey?.(slug, key, label || undefined)?.then((x) => x.key),
    (g) => g.adminProviderKeyAdd?.(slug, key, label || undefined), "key");
  if (btn) btn.disabled = false;
  if (!r.ok) { setErr("pa-provider-create-error", r.error); return; }
  setErr("pa-provider-create-error", "");
  for (const id of ["pa-pc-key-new", "pa-pc-key-label"]) { const el = $<HTMLInputElement>(id); if (el) el.value = ""; }
  await refreshProviderKeys();
}

/** The two credit-rate inputs are per-unit; the unit depends on the model's modality.
 *  Relabel them so a super-admin pricing an image model sees "per image", not "per token". */
const RATE_UNIT_TEXT: Record<string, string> = { mtok: "1M tokens", image: "image", second: "second", mchar: "1M chars", kchar: "1K chars", minute: "minute", hour: "hour", generation: "generation" };
function relabelModelRates(unit: string): void {
  const t = RATE_UNIT_TEXT[unit] ?? "unit";
  const inl = $("pa-model-in-label"); if (inl) inl.textContent = `Input credits / ${t}`;
  const outl = $("pa-model-out-label"); if (outl) outl.textContent = `Output credits / ${t}`;
}

function openModelEditor(m: AdminModel): void {
  editingModel = m;
  setErr("pa-model-form-error", "");
  const title = $("pa-model-title");
  if (title) title.textContent = `${m.display_name} · ${modelId(m)}`;
  const set = (id: string, v: string): void => { const el = $<HTMLInputElement>(id); if (el) el.value = v; };
  set("pa-model-name", m.display_name);
  set("pa-model-alias", m.alias || "");
  const modSel = $<HTMLSelectElement>("pa-model-modality"); if (modSel) modSel.value = m.modality || "chat";
  const ruSel = $<HTMLSelectElement>("pa-model-rate-unit"); if (ruSel) ruSel.value = m.rate_unit || "mtok";
  relabelModelRates(m.rate_unit || "mtok");
  set("pa-model-in", m.input_credits_per_mtok == null ? "" : String(microToCredits(m.input_credits_per_mtok)));
  set("pa-model-out", m.output_credits_per_mtok == null ? "" : String(microToCredits(m.output_credits_per_mtok)));
  set("pa-model-ctx", m.context_window == null ? "" : String(m.context_window));
  set("pa-model-max", m.max_output_tokens == null ? "" : String(m.max_output_tokens));
  const active = $<HTMLInputElement>("pa-model-active");
  if (active) active.checked = m.active;
  const defaultOn = $<HTMLInputElement>("pa-model-default-on");
  if (defaultOn) defaultOn.checked = m.default_on;
  showModelEditor(true);
}

async function saveModel(): Promise<void> {
  if (!editingModel) return;
  const name = inputVal("pa-model-name");
  if (!name) { setErr("pa-model-form-error", "The model needs a display name."); return; }
  const alias = inputVal("pa-model-alias");
  // Wire rates are MICRO-credits per MTok (the platform page's exact scale):
  // whole credits typed here × 1e6; blank clears to "not per-token priced".
  const inCr = numOrNull(inputVal("pa-model-in"));
  const outCr = numOrNull(inputVal("pa-model-out"));
  const ctx = numOrNull(inputVal("pa-model-ctx"));
  const max = numOrNull(inputVal("pa-model-max"));
  const patch: AdminModelPatch = {
    display_name: name,
    alias: alias || null,
    active: !!$<HTMLInputElement>("pa-model-active")?.checked,
    default_on: !!$<HTMLInputElement>("pa-model-default-on")?.checked,
    modality: inputVal("pa-model-modality") || "chat",
    rate_unit: inputVal("pa-model-rate-unit") || "mtok",
    input_credits_per_mtok: inCr == null ? null : inCr * MICRO,
    output_credits_per_mtok: outCr == null ? null : outCr * MICRO,
    // context_window/max_output_tokens must be POSITIVE ints on the wire —
    // 0 or blank clears to "unrecorded".
    context_window: ctx || null,
    max_output_tokens: max || null,
  };
  const btn = $<HTMLButtonElement>("pa-model-save");
  if (btn) btn.disabled = true;
  const res = await write<AdminModel>(
    (a) => a.updateModel?.(editingModel!.provider, editingModel!.model, patch)?.then((r) => r.model),
    (g) => g.adminModelUpdate?.(editingModel!.provider, editingModel!.model, patch), "model");
  if (btn) btn.disabled = false;
  if (!res.ok) { setErr("pa-model-form-error", res.error); return; }
  showModelEditor(false);
  await loadAdminModels();
}

/** The release flows — the old platform's add-provider / add-model forms. */
function wireCatalogCreate(): void {
  const toggle = (id: string, on: boolean) => $(id)?.classList.toggle("hidden", !on);
  $("pa-model-add-btn")?.addEventListener("click", () => { toggle("pa-model-create", true); showProviderEditor(false); });
  $("pa-mc-cancel")?.addEventListener("click", () => toggle("pa-model-create", false));
  // Relabel the editor's rate inputs when the modality's unit changes.
  $("pa-model-rate-unit")?.addEventListener("change", () => relabelModelRates(inputVal("pa-model-rate-unit")));
  // + Provider = CREATE mode: reset whatever an edit left in the shared form.
  $("pa-provider-add-btn")?.addEventListener("click", () => {
    editingProviderSlug = null;
    for (const id of ["pa-pc-slug", "pa-pc-name", "pa-pc-url"]) { const el = $<HTMLInputElement>(id); if (el) el.value = ""; }
    const slug = $<HTMLInputElement>("pa-pc-slug");
    if (slug) slug.readOnly = false;
    const save = $<HTMLButtonElement>("pa-pc-save");
    if (save) save.textContent = "Release provider";
    const title = $("pa-provider-title");
    if (title) title.textContent = "New provider";
    setErr("pa-provider-create-error", "");
    $("pa-pc-keys-group")?.classList.add("hidden"); // keys attach after the first save
    toggle("pa-model-create", false);
    showProviderEditor(true);
  });
  $("pa-pc-key-add")?.addEventListener("click", () => { void addProviderKeyFromForm(); });
  $("pa-pc-key-new")?.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") void addProviderKeyFromForm(); });
  $("pa-provider-back")?.addEventListener("click", () => showProviderEditor(false));
  $("pa-pc-cancel")?.addEventListener("click", () => showProviderEditor(false));
  $("pa-provider-search")?.addEventListener("input", () => {
    providerSearch = inputVal("pa-provider-search");
    paintProviders();
  });

  $("pa-pc-save")?.addEventListener("click", () => {
    void (async () => {
      const url = inputVal("pa-pc-url").trim();
      const input = {
        slug: (editingProviderSlug ?? inputVal("pa-pc-slug").trim().toLowerCase()),
        name: inputVal("pa-pc-name").trim(),
        kind: (inputVal("pa-pc-kind") || "proxied") as "proxied" | "open_weight",
        // POST /api/admin/providers upserts: omitted baseUrl KEEPS the stored
        // one, null CLEARS it — an edit that empties the field means "clear".
        ...(url ? { baseUrl: url } : editingProviderSlug ? { baseUrl: null } : {}),
      };
      if (!input.slug || !input.name) { setErr("pa-provider-create-error", "Slug and name are required."); return; }
      const res = await write(
        (a) => a.createProvider?.(input),
        (g) => g.adminProviderCreate?.(input), "provider");
      if (!res.ok) { setErr("pa-provider-create-error", res.error); return; }
      setErr("pa-provider-create-error", "");
      showProviderEditor(false);
      await Promise.all([loadAdminModelsAsync(), loadProviders()]);
    })();
  });

  $("pa-mc-save")?.addEventListener("click", () => {
    void (async () => {
      const num = (id: string): number => Number(inputVal(id).replace(/[^0-9.]/g, "")) || 0;
      const input = {
        id: inputVal("pa-mc-id").trim(),
        providerSlug: inputVal("pa-mc-provider").trim().toLowerCase(),
        name: inputVal("pa-mc-name").trim(),
        kind: (inputVal("pa-mc-kind") || "proxied") as "proxied" | "open_weight",
        modality: inputVal("pa-mc-modality") || "chat",
        rateUnit: inputVal("pa-mc-rate-unit") || "mtok",
        ...(inputVal("pa-mc-alias").trim() ? { alias: inputVal("pa-mc-alias").trim() } : {}),
        ...(num("pa-mc-ctx") ? { contextWindow: num("pa-mc-ctx") } : {}),
        inputCreditsPerMTok: num("pa-mc-in"),
        outputCreditsPerMTok: num("pa-mc-out"),
      };
      if (!input.id || !input.providerSlug || !input.name) { setErr("pa-model-create-error", "Provider, id, and name are required."); return; }
      const res = await write(
        (a) => a.createModel?.(input),
        (g) => g.adminModelCreate?.(input), "model");
      if (!res.ok) { setErr("pa-model-create-error", res.error); return; }
      setErr("pa-model-create-error", "");
      toggle("pa-model-create", false);
      await loadAdminModelsAsync();
    })();
  });
}

/** The load body, awaitable (the create flows refresh through it). */
async function loadAdminModelsAsync(): Promise<void> {
  const allowed = await isSuperAdmin();
  if (allowed === false) { gatePanel("pa-models-gate", "pa-models-body", false); return; }
  gatePanel("pa-models-gate", "pa-models-body", true);
  showModelEditor(false);
  showProviderEditor(false);
  const wrap = $("pa-models-list");
  if (wrap && !models.length) wrap.innerHTML = `<div class="crud-empty">Loading…</div>`;
  try {
    const r = await read((a) => a.models?.(), (g) => g.adminModels?.());
    models = r?.models || [];
    setErr("pa-models-error", "");
  } catch (err) {
    setErr("pa-models-error", `Couldn't load the catalog — ${errText(err)}`);
    models = [];
  }
  paintModels();
  void loadProviders(); // paints providers when the list lands (fallback inside)
}

export function loadAdminModels(): void {
  if (!modelsWired) {
    modelsWired = true;
    $("pa-models-search")?.addEventListener("input", () => { modelsPage = 0; paintModels(); });
    $("pa-model-back")?.addEventListener("click", () => { editingModel = null; showModelEditor(false); });
    $("pa-model-cancel")?.addEventListener("click", () => { editingModel = null; showModelEditor(false); });
    $("pa-model-save")?.addEventListener("click", () => { void saveModel(); });
    wireCatalogCreate();
  }
  void loadAdminModelsAsync();
}

// ═══════════════════════════════════════════════════════════════════════════
// Plans (global tiers + Stripe price history)
// ═══════════════════════════════════════════════════════════════════════════

let plans: AdminPlan[] = [];
let editingPlan: AdminPlan | null = null;
let planPrices: AdminPlanPrice[] = [];
let plansWired = false;

/** Every tier shows its Stripe price history — the old platform hid it for
 *  free/enterprise, which just read as "where do I put the price id". */
function tierIsPriced(_p: AdminPlan): boolean {
  return true;
}

/** True while the editor is CREATING a new tier (editingPlan is null then). */
let creatingPlan = false;
let plansSearch = "";

function showPlanEditor(on: boolean): void {
  $("pa-plans-list-view")?.classList.toggle("hidden", on);
  $("pa-plan-editor")?.classList.toggle("hidden", !on);
}

function paintPlans(): void {
  const wrap = $("pa-plans-list");
  if (!wrap) return;
  const q = plansSearch.trim().toLowerCase();
  const globals = plans.filter((p) => !p.org_id)
    .filter((p) => !q || p.tier.toLowerCase().includes(q) || (p.display_name || "").toLowerCase().includes(q));
  wrap.innerHTML = "";
  if (!globals.length) { wrap.innerHTML = `<div class="crud-empty">${q ? "No plans match." : "No plans yet."}</div>`; return; }
  const { table, tbody } = mkTable(["Plan", "Tier", "$ / seat / mo", "Credits / mo", "Seats", "Rpm", "Status"], true);
  for (const p of globals) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="lib-table-name"></td>
      <td class="lib-table-desc"></td>
      <td>$${fmtInt((p.monthly_usd_cents || 0) / 100)}</td>
      <td>${fmtInt(microToCredits(p.included_credits))}</td>
      <td class="lib-table-dim">${fmtInt(p.max_seats || 1)}</td>
      <td class="lib-table-dim">${p.rate_limit_rpm ? fmtInt(p.rate_limit_rpm) : "∞"}</td>`;
    const status = document.createElement("td");
    status.innerHTML = p.active ? `<span class="lib-badge">Active</span>` : `<span class="lib-table-dim">Inactive</span>`;
    tr.appendChild(status);
    const name = tr.querySelector(".lib-table-name");
    if (name) name.textContent = p.display_name || p.tier;
    const tier = tr.querySelector(".lib-table-desc");
    if (tier) tier.textContent = p.tier;
    tr.addEventListener("click", () => { void openPlanEditor(p); });
    tr.appendChild(kebabCell(() => [
      { icon: ROW_MENU_ICONS.edit, label: "Edit", onClick: () => { void openPlanEditor(p); } },
      { icon: ROW_MENU_ICONS.delete, label: p.active ? "Deactivate" : "Activate", danger: p.active, onClick: () => {
        void (async () => {
          const sure = await confirmAction(p.active
            ? { title: `Deactivate the ${p.display_name || p.tier} plan?`, body: "The plan is hidden and can no longer be subscribed to.", confirmLabel: "Deactivate", danger: true }
            : { title: `Activate the ${p.display_name || p.tier} plan?`, body: "The plan becomes selectable by organizations.", confirmLabel: "Activate" });
          if (!sure) return;
          const res = await write<AdminPlan>(
            (a) => a.updatePlan?.(p.tier, { active: !p.active })?.then((r) => r.plan),
            (g) => g.adminPlanUpdate?.(p.tier, { active: !p.active }), "plan");
          if (!res.ok) { setErr("pa-plans-error", res.error); return; }
          setErr("pa-plans-error", "");
          await refreshPlans();
        })();
      } },
    ]));
    tbody.appendChild(tr);
  }
  wrap.appendChild(table);
  paintOrgPlans();
}

/** Bespoke per-org (enterprise) plans — listed read-only; they are created and
 *  edited through the sales/provisioning flow, not this pass. */
function paintOrgPlans(): void {
  const head = $("pa-orgplans-head");
  const wrap = $("pa-orgplans-list");
  if (!wrap || !head) return;
  const bespoke = plans.filter((p) => p.org_id);
  head.classList.toggle("hidden", !bespoke.length);
  wrap.classList.toggle("hidden", !bespoke.length);
  wrap.innerHTML = "";
  if (!bespoke.length) return;
  const { table, tbody } = mkTable(["Organization", "Plan", "$ / seat / mo", "Credits / mo", "Seats"], false);
  for (const p of bespoke) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="lib-table-name"></td>
      <td class="lib-table-desc"></td>
      <td>$${fmtInt((p.monthly_usd_cents || 0) / 100)}</td>
      <td>${fmtInt(microToCredits(p.included_credits))}</td>
      <td class="lib-table-dim">${fmtInt(p.max_seats || 1)}</td>`;
    const org = tr.querySelector(".lib-table-name");
    if (org) org.textContent = p.org_name || p.org_id || "—";
    const name = tr.querySelector(".lib-table-desc");
    if (name) name.textContent = p.display_name;
    tbody.appendChild(tr);
  }
  wrap.appendChild(table);
}

function paintPlanPrices(): void {
  const group = $("pa-prices-group");
  const wrap = $("pa-prices-list");
  if (!group || !wrap || !editingPlan) return;
  const priced = tierIsPriced(editingPlan);
  group.classList.toggle("hidden", !priced);
  if (!priced) return;
  wrap.innerHTML = "";
  if (!planPrices.length) {
    wrap.innerHTML = `<div class="crud-empty">No Stripe prices yet — the first one added becomes active.</div>`;
    return;
  }
  const { table, tbody } = mkTable(["Stripe price", "Status", "Added"], true);
  for (const pr of planPrices) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="lib-table-name"></td><td></td><td class="lib-table-dim">${escapeHtml(fmtDate(pr.createdAt))}</td>`;
    const idCell = tr.querySelector(".lib-table-name");
    if (idCell) idCell.textContent = pr.stripePriceId;
    const status = tr.querySelector("td:nth-child(2)");
    if (status) status.innerHTML = pr.active ? `<span class="lib-badge">Active</span>` : `<span class="lib-table-dim">Archived</span>`;
    tr.appendChild(kebabCell(() => [
      ...(pr.active ? [] : [{ icon: ROW_MENU_ICONS.edit, label: "Make active", onClick: () => {
        void (async () => {
          const sure = await confirmAction({
            title: "Make this the active price?",
            body: `New ${editingPlan?.display_name || editingPlan?.tier || ""} checkouts will use ${pr.stripePriceId}. Existing subscriptions keep their own price.`,
            confirmLabel: "Set active",
          });
          if (!sure) return;
          const res = await write<AdminPlanPrice>(
            (a) => a.activatePlanPrice?.(pr.id), (g) => g.adminPlanPriceActivate?.(pr.id), "price");
          if (!res.ok) { setErr("pa-plan-form-error", res.error); return; }
          await refreshPlanPrices();
        })();
      } }]),
      { icon: ROW_MENU_ICONS.delete, label: "Remove", danger: true, onClick: () => {
        void (async () => {
          const sure = await confirmAction({
            title: "Remove this price?",
            body: pr.active
              ? "This price is active. Removing it leaves the tier with no active price until you set another."
              : "Subscriptions already on this price keep working; it is only removed from the history.",
            confirmLabel: "Remove",
            danger: true,
          });
          if (!sure) return;
          const res = await write<unknown>(
            (a) => a.removePlanPrice?.(pr.id), (g) => g.adminPlanPriceRemove?.(pr.id), "removed");
          if (!res.ok) { setErr("pa-plan-form-error", res.error); return; }
          await refreshPlanPrices();
        })();
      } },
    ]));
    tbody.appendChild(tr);
  }
  wrap.appendChild(table);
}

async function refreshPlanPrices(): Promise<void> {
  if (!editingPlan || !tierIsPriced(editingPlan)) { planPrices = []; paintPlanPrices(); return; }
  try {
    planPrices = (await read((a) => a.planPrices?.(editingPlan!.tier), (g) => g.adminPlanPrices?.(editingPlan!.tier))) || [];
    setErr("pa-plan-form-error", "");
  } catch (err) {
    planPrices = [];
    setErr("pa-plan-form-error", `Couldn't load the price history — ${errText(err)}`);
  }
  paintPlanPrices();
}

async function openPlanEditor(p: AdminPlan): Promise<void> {
  editingPlan = p;
  creatingPlan = false;
  $("pa-plan-tier-row")?.classList.add("hidden");
  planPrices = [];
  setErr("pa-plan-form-error", "");
  const title = $("pa-plan-title");
  if (title) title.textContent = `${p.display_name || p.tier} · ${p.tier}`;
  const set = (id: string, v: string): void => { const el = $<HTMLInputElement>(id); if (el) el.value = v; };
  set("pa-plan-name", p.display_name || "");
  set("pa-plan-price", String(Math.round((p.monthly_usd_cents || 0) / 100)));
  set("pa-plan-credits", String(microToCredits(p.included_credits)));
  set("pa-plan-seats", String(p.max_seats || 1));
  set("pa-plan-rpm", p.rate_limit_rpm != null ? String(p.rate_limit_rpm) : "");
  const active = $<HTMLInputElement>("pa-plan-active");
  if (active) active.checked = p.active;
  const priceInput = $<HTMLInputElement>("pa-price-new");
  if (priceInput) priceInput.value = "";
  showPlanEditor(true);
  paintPlanPrices();
  await refreshPlanPrices();
}

/** Open the editor EMPTY for a new tier (the tier-key field shows; Stripe
 *  prices attach after the first save, once the tier exists). */
function openPlanCreate(): void {
  editingPlan = null;
  creatingPlan = true;
  planPrices = [];
  setErr("pa-plan-form-error", "");
  const title = $("pa-plan-title");
  if (title) title.textContent = "New plan";
  const set = (id: string, v: string): void => { const el = $<HTMLInputElement>(id); if (el) el.value = v; };
  for (const id of ["pa-plan-tier", "pa-plan-name", "pa-plan-rpm"]) set(id, "");
  set("pa-plan-price", "0");
  set("pa-plan-credits", "0");
  set("pa-plan-seats", "1");
  const active = $<HTMLInputElement>("pa-plan-active");
  if (active) active.checked = true;
  $("pa-plan-tier-row")?.classList.remove("hidden");
  showPlanEditor(true);
  paintPlanPrices();
}

async function savePlan(): Promise<void> {
  if (!editingPlan && !creatingPlan) return;
  const name = inputVal("pa-plan-name");
  if (!name) { setErr("pa-plan-form-error", "The plan needs a display name."); return; }
  const patch: AdminPlanPatch = {
    display_name: name,
    monthly_usd_cents: Math.max(0, Math.round((Number(inputVal("pa-plan-price")) || 0) * 100)),
    included_credits: Math.max(0, Math.round(Number(inputVal("pa-plan-credits")) || 0)) * MICRO,
    max_seats: Math.max(1, Math.round(Number(inputVal("pa-plan-seats")) || 1)),
    active: !!$<HTMLInputElement>("pa-plan-active")?.checked,
    // Empty clears the limit (null = unlimited); 0 is treated as empty too.
    rate_limit_rpm: inputVal("pa-plan-rpm") && Number(inputVal("pa-plan-rpm")) > 0
      ? Math.round(Number(inputVal("pa-plan-rpm")))
      : null,
  };
  const btn = $<HTMLButtonElement>("pa-plan-save");
  if (btn) btn.disabled = true;
  let res: WriteResult<AdminPlan>;
  if (creatingPlan) {
    const tier = inputVal("pa-plan-tier").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(tier)) {
      if (btn) btn.disabled = false;
      setErr("pa-plan-form-error", "The tier key needs lowercase letters, digits and dashes (e.g. team).");
      return;
    }
    const input = { ...patch, tier } as AdminPlanPatch & { tier: string };
    res = await write<AdminPlan>(
      (a) => a.createPlan?.(input)?.then((r) => r.plan),
      (g) => g.adminPlanCreate?.(input), "plan");
  } else {
    res = await write<AdminPlan>(
      (a) => a.updatePlan?.(editingPlan!.tier, patch)?.then((r) => r.plan),
      (g) => g.adminPlanUpdate?.(editingPlan!.tier, patch), "plan");
  }
  if (btn) btn.disabled = false;
  if (!res.ok) { setErr("pa-plan-form-error", res.error); return; }
  showPlanEditor(false);
  editingPlan = null;
  creatingPlan = false;
  await refreshPlans();
}

async function addPrice(): Promise<void> {
  if (!editingPlan) return;
  const priceId = inputVal("pa-price-new");
  if (!priceId.startsWith("price_")) { setErr("pa-plan-form-error", "A Stripe price id starts with price_…"); return; }
  const res = await write<AdminPlanPrice>(
    (a) => a.addPlanPrice?.(editingPlan!.tier, priceId),
    (g) => g.adminPlanPriceAdd?.(editingPlan!.tier, priceId), "price");
  if (!res.ok) { setErr("pa-plan-form-error", res.error); return; }
  const input = $<HTMLInputElement>("pa-price-new");
  if (input) input.value = "";
  await refreshPlanPrices();
}

async function refreshPlans(): Promise<void> {
  try {
    const r = await read((a) => a.plans?.(), (g) => g.adminPlans?.());
    plans = r?.plans || [];
    setErr("pa-plans-error", "");
  } catch (err) {
    plans = [];
    setErr("pa-plans-error", `Couldn't load plans — ${errText(err)}`);
  }
  paintPlans();
}

export function loadAdminPlans(): void {
  if (!plansWired) {
    plansWired = true;
    $("pa-plan-back")?.addEventListener("click", () => { editingPlan = null; creatingPlan = false; showPlanEditor(false); });
    $("pa-plan-cancel")?.addEventListener("click", () => { editingPlan = null; creatingPlan = false; showPlanEditor(false); });
    $("pa-plan-save")?.addEventListener("click", () => { void savePlan(); });
    $("pa-price-add")?.addEventListener("click", () => { void addPrice(); });
    $("pa-price-new")?.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") void addPrice(); });
    $("pa-plan-add-btn")?.addEventListener("click", () => openPlanCreate());
    $("pa-plans-search")?.addEventListener("input", () => { plansSearch = inputVal("pa-plans-search"); paintPlans(); });
  }
  void (async () => {
    const allowed = await isSuperAdmin();
    if (allowed === false) { gatePanel("pa-plans-gate", "pa-plans-body", false); return; }
    gatePanel("pa-plans-gate", "pa-plans-body", true);
    showPlanEditor(false);
    const wrap = $("pa-plans-list");
    if (wrap && !plans.length) wrap.innerHTML = `<div class="crud-empty">Loading…</div>`;
    await refreshPlans();
  })();
}

// ═══════════════════════════════════════════════════════════════════════════
// Usage (platform rollups)
// ═══════════════════════════════════════════════════════════════════════════

let usageChart: { destroy: () => void } | null = null;
let usageWired = false;

const cssVar = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** "Jul 5" from a "YYYY-MM-DD" bucket (dashboard.ts's exact treatment). */
function shortDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const isoDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Per-day credits chart — the SAME Chart.js grammar as the Usage panel's
 *  loadUsageChart (dashboard.ts), single platform-wide series. */
function renderUsageChart(days: AdminUsageDay[]): void {
  const canvas = $<HTMLCanvasElement>("pa-usage-chart");
  const empty = $("pa-usage-empty");
  if (!canvas || typeof Chart === "undefined") return;
  if (usageChart) { usageChart.destroy(); usageChart = null; }
  const hasData = days.some((d) => d.credits > 0 || d.requests > 0);
  empty?.classList.toggle("hidden", hasData);
  canvas.style.visibility = hasData ? "visible" : "hidden";
  if (!hasData) return;
  const byDay = new Map(days.map((d) => [d.day, d]));
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  usageChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: days.map((d) => shortDay(d.day)),
      datasets: [{
        label: "credits",
        data: days.map((d) => microToCredits(d.credits)),
        backgroundColor: cssVar("--accent") || "#8c3bf2",
        borderRadius: 3,
        maxBarThickness: 34,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c: { parsed: { y: number }; dataIndex: number }) => {
              const cell = byDay.get(days[c.dataIndex]?.day || "");
              return `${fmtInt(c.parsed.y)} credits${cell ? ` · ${fmtInt(cell.requests)} calls` : ""}`;
            },
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: cssVar("--text-3") || "#868686", maxRotation: 0, autoSkip: true } },
        y: {
          beginAtZero: true,
          grid: { color: cssVar("--border") || "rgba(255,255,255,0.08)" },
          ticks: { color: cssVar("--text-3") || "#868686", callback: (v: number) => fmtInt(v) },
        },
      },
    },
  });
}

function paintUsageUsers(users: AdminUsageByUser[]): void {
  const wrap = $("pa-usage-users");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!users.length) { wrap.innerHTML = `<div class="crud-empty">No usage in this window.</div>`; return; }
  const { table, tbody } = mkTable(["Member", "Email", "Requests", "Credits"], false);
  for (const u of users) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="lib-table-name"></td>
      <td class="lib-table-desc"></td>
      <td class="lib-table-dim">${fmtInt(u.requests)}</td>
      <td>${fmtInt(microToCredits(u.credits))}</td>`;
    const name = tr.querySelector(".lib-table-name");
    if (name) name.textContent = u.name || "—";
    const email = tr.querySelector(".lib-table-desc");
    if (email) email.textContent = u.email || u.userId;
    tbody.appendChild(tr);
  }
  wrap.appendChild(table);
}

function paintUsageRuntimes(runtimes: AdminUsageByRuntime[]): void {
  const wrap = $("pa-usage-runtimes");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!runtimes.length) { wrap.innerHTML = `<div class="crud-empty">No runtime usage in this window.</div>`; return; }
  const { table, tbody } = mkTable(["Region", "Mode", "Tier", "Orgs", "Requests", "Credits"], false);
  for (const r of runtimes) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="lib-table-name"></td>
      <td class="lib-table-desc"></td>
      <td></td>
      <td class="lib-table-dim">${fmtInt(r.orgs)}</td>
      <td class="lib-table-dim">${fmtInt(r.requests)}</td>
      <td>${fmtInt(microToCredits(r.credits))}</td>`;
    const region = tr.querySelector(".lib-table-name");
    if (region) region.textContent = r.region;
    const mode = tr.querySelector(".lib-table-desc");
    if (mode) mode.textContent = r.mode;
    const tier = tr.querySelector("td:nth-child(3)");
    if (tier) tier.textContent = r.tier;
    tbody.appendChild(tr);
  }
  wrap.appendChild(table);
}

async function refreshAdminUsage(): Promise<void> {
  const win = parseInt($<HTMLSelectElement>("pa-usage-days")?.value || "30", 10);
  const to = new Date();
  const from = new Date();
  from.setDate(to.getDate() - (win - 1));
  const query = { from: isoDay(from), to: isoDay(to), tz: Intl.DateTimeFormat().resolvedOptions().timeZone };
  // The three rollups are independent — one failing must not blank the rest.
  const [daysRes, usersRes, runtimesRes] = await Promise.allSettled([
    read((a) => a.usageDaily?.(query), (g) => g.adminUsageDaily?.(query)),
    read((a) => a.usageByUser?.(win), (g) => g.adminUsageByUser?.(win)),
    read((a) => a.usageByRuntime?.({ from: query.from, to: query.to }), (g) => g.adminUsageByRuntime?.({ from: query.from, to: query.to })),
  ]);
  const problems: string[] = [];
  const days: AdminUsageDay[] = daysRes.status === "fulfilled" ? (daysRes.value?.days || []) : (problems.push("daily series"), []);
  const users: AdminUsageByUser[] = usersRes.status === "fulfilled" ? (usersRes.value?.users || []) : (problems.push("top spenders"), []);
  const runtimes: AdminUsageByRuntime[] = runtimesRes.status === "fulfilled" ? (runtimesRes.value?.runtimes || []) : (problems.push("runtime breakdown"), []);
  setErr("pa-usage-error", problems.length ? `Couldn't load the ${problems.join(", ")} — ${errText(
    (daysRes.status === "rejected" && daysRes.reason) ||
    (usersRes.status === "rejected" && usersRes.reason) ||
    (runtimesRes.status === "rejected" && runtimesRes.reason))}` : "");

  const credits = days.reduce((s, d) => s + microToCredits(d.credits), 0);
  const requests = days.reduce((s, d) => s + (d.requests || 0), 0);
  const set = (id: string, v: string): void => { const el = $(id); if (el) el.textContent = v; };
  set("pa-usage-credits", fmtInt(credits));
  set("pa-usage-requests", fmtInt(requests));
  set("pa-usage-active", fmtInt(users.length));
  set("pa-usage-total", `${fmtInt(credits)} credits · ${fmtInt(requests)} calls`);
  set("pa-usage-range", `last ${win} days`);
  renderUsageChart(days);
  paintUsageUsers(users);
  paintUsageRuntimes(runtimes);
}

export function loadAdminUsage(): void {
  if (!usageWired) {
    usageWired = true;
    $("pa-usage-days")?.addEventListener("change", () => { void refreshAdminUsage(); });
    $("pa-usage-refresh")?.addEventListener("click", () => { void refreshAdminUsage(); });
  }
  void (async () => {
    const allowed = await isSuperAdmin();
    if (allowed === false) { gatePanel("pa-usage-gate", "pa-usage-body", false); return; }
    gatePanel("pa-usage-gate", "pa-usage-body", true);
    await refreshAdminUsage();
  })();
}

// ═══════════════════════════════════════════════════════════════════════════
// Orgs (list + credit grants)
// ═══════════════════════════════════════════════════════════════════════════

let orgs: AdminOrgRow[] = [];
let orgsTotal = 0;
let orgsPage = 0;
let grantingOrg: AdminOrgRow | null = null;
let orgsWired = false;
let orgsSearchTimer = 0;

function showGrantForm(on: boolean): void {
  $("pa-orgs-list-view")?.classList.toggle("hidden", on);
  $("pa-org-grant")?.classList.toggle("hidden", !on);
}

function paintOrgs(): void {
  const wrap = $("pa-orgs-list");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!orgs.length) {
    wrap.innerHTML = `<div class="crud-empty">${inputVal("pa-orgs-search") ? "No organizations match your search." : "No organizations yet."}</div>`;
    return;
  }
  const { items, state } = paginate(orgs, orgsPage);
  orgsPage = state.page;
  const { table, tbody } = mkTable(["Organization", "Tier", "Billing", "Members"], true);
  for (const o of items) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="lib-table-name"></td>
      <td class="lib-table-desc"></td>
      <td></td>
      <td class="lib-table-dim">${fmtInt(o.member_count)}</td>`;
    const name = tr.querySelector(".lib-table-name");
    if (name) name.textContent = o.name;
    const tier = tr.querySelector(".lib-table-desc");
    if (tier) tier.textContent = o.tier;
    const billing = tr.querySelector("td:nth-child(3)");
    if (billing) {
      billing.innerHTML = o.billing_status === "active"
        ? `<span class="lib-badge">active</span>` : `<span class="lib-table-dim"></span>`;
      if (o.billing_status !== "active") {
        const dim = billing.querySelector(".lib-table-dim");
        if (dim) dim.textContent = o.billing_status || "—";
      }
    }
    tr.addEventListener("click", () => void openOrgDetail(o));
    tr.appendChild(kebabCell(() => [
      { icon: ROW_MENU_ICONS.edit, label: "Manage", onClick: () => void openOrgDetail(o) },
    ]));
    tbody.appendChild(tr);
  }
  wrap.appendChild(table);
  if (state.totalPages > 1) wrap.appendChild(renderPaginationBar(state, (p) => { orgsPage = p; paintOrgs(); }));
  const note = $("pa-orgs-total");
  if (note) note.textContent = orgsTotal > orgs.length ? `Showing ${fmtInt(orgs.length)} of ${fmtInt(orgsTotal)} — narrow with search.` : "";
}

function openGrantForm(o: AdminOrgRow): void {
  grantingOrg = o;
  setErr("pa-org-grant-error", "");
  const title = $("pa-org-grant-title");
  if (title) title.textContent = `Grant credits · ${o.name}`;
  const credits = $<HTMLInputElement>("pa-grant-credits");
  if (credits) credits.value = "";
  const note = $<HTMLInputElement>("pa-grant-note");
  if (note) note.value = "";
  const state = $("pa-org-grant-state");
  if (state) state.textContent = "";
  showGrantForm(true);
}

async function grantCredits(): Promise<void> {
  if (!grantingOrg) return;
  const credits = Math.round(Number(inputVal("pa-grant-credits")) || 0);
  if (credits <= 0) { setErr("pa-org-grant-error", "Enter a positive number of credits."); return; }
  const note = inputVal("pa-grant-note");
  const sure = await confirmAction({
    title: `Grant ${fmtInt(credits)} credits to ${grantingOrg.name}?`,
    body: "Admin-granted credits never expire and land on the org's balance immediately.",
    confirmLabel: "Grant credits",
  });
  if (!sure) return;
  const btn = $<HTMLButtonElement>("pa-grant-save");
  if (btn) btn.disabled = true;
  const res = await write<number>(
    (a) => a.grantCredits?.(grantingOrg!.id, credits, note || undefined).then((r) => r.balance),
    (g) => g.adminOrgGrantCredits?.(grantingOrg!.id, credits, note || undefined), "balance");
  if (btn) btn.disabled = false;
  if (!res.ok) { setErr("pa-org-grant-error", res.error); return; }
  setErr("pa-org-grant-error", "");
  const state = $("pa-org-grant-state");
  if (state) {
    state.textContent = `Granted — new balance ${fmtInt(microToCredits(res.data))} credits.`;
    state.className = "set-save-state success";
  }
  const input = $<HTMLInputElement>("pa-grant-credits");
  if (input) input.value = "";
}

// ── Org detail (full management view) ─────────────────────────────────────
let detailOrg: AdminOrgDetail | null = null;
const ORG_TIERS = ["free", "basic", "pro", "enterprise"];

/** Show exactly one of the org sub-views. */
function showOrgView(view: "list" | "detail" | "grant"): void {
  $("pa-orgs-list-view")?.classList.toggle("hidden", view !== "list");
  $("pa-org-detail")?.classList.toggle("hidden", view !== "detail");
  $("pa-org-grant")?.classList.toggle("hidden", view !== "grant");
}

async function openOrgDetail(o: AdminOrgRow): Promise<void> {
  showOrgView("detail");
  setErr("pa-org-detail-error", "");
  const body = $("pa-org-detail-body");
  if (body) body.innerHTML = `<div class="crud-empty">Loading ${escapeHtml(o.name)}…</div>`;
  try {
    const [detail, plansRes] = await Promise.all([
      read((a) => a.org?.(o.id), (g) => g.adminOrg?.(o.id)),
      read((a) => a.plans?.(), (g) => g.adminPlans?.()).catch(() => ({ plans: [] as AdminPlan[] })),
    ]);
    detailOrg = detail;
    renderOrgDetail(detail, plansRes?.plans ?? []);
  } catch (err) {
    setErr("pa-org-detail-error", `Couldn't load this organization — ${errText(err)}`);
    if (body) body.innerHTML = "";
  }
}

function renderOrgDetail(d: AdminOrgDetail, plans: AdminPlan[]): void {
  const body = $("pa-org-detail-body");
  if (!body) return;
  const owner = d.members.find((m) => m.role === "owner" || m.role === "org_admin") ?? d.members[0];
  const ownerName = owner ? (`${owner.first_name} ${owner.last_name}`.trim() || owner.email) : "—";
  const plan = plans.find((p) => p.tier === d.tier);
  const allowance = plan ? microToCredits(Number(plan.included_credits)) : null;
  body.innerHTML = `
    <h3 class="settings-subheading" style="margin-top:0;">${escapeHtml(d.name)} <span id="pa-org-detail-state" class="set-save-state"></span></h3>
    <p class="settings-hint" style="margin:-4px 0 12px;">${escapeHtml(d.id)}</p>
    <div class="pa-org-stats">
      <div class="pa-stat"><span class="pa-stat-num">${fmtInt(microToCredits(d.credits.balance))}</span><span class="pa-stat-lbl">credits balance</span></div>
      <div class="pa-stat"><span class="pa-stat-num">${fmtInt(microToCredits(d.credits.used))}</span><span class="pa-stat-lbl">credits used</span></div>
      <div class="pa-stat"><span class="pa-stat-num">${fmtInt(d.member_count)} / ${fmtInt(d.max_seats)}</span><span class="pa-stat-lbl">seats</span></div>
    </div>
    <div class="pa-kv">
      <div><span>Admin</span><b>${escapeHtml(ownerName)}</b></div>
      <div><span>Admin email</span><b>${owner ? escapeHtml(owner.email) : "—"}</b></div>
      <div><span>Billing</span><b>${escapeHtml(d.billing_status)}</b></div>
      <div><span>Plan allowance</span><b>${allowance != null ? fmtInt(allowance) + " / mo" : "—"}</b></div>
      <div><span>Created</span><b>${escapeHtml(fmtDate(d.created_at))}</b></div>
    </div>
    <h4 class="acct-row-head">Plan</h4>
    <div class="settings-inline">
      <select id="pa-org-tier" class="settings-input settings-input-md">${ORG_TIERS.map((t) => `<option value="${t}"${t === d.tier ? " selected" : ""}>${t}</option>`).join("")}</select>
      <button id="pa-org-tier-save" class="action-btn" type="button">Change plan</button>
    </div>
    <h4 class="acct-row-head">Grant credits</h4>
    <div class="settings-inline">
      <input id="pa-org-grant-amt" type="number" min="1" class="settings-input settings-input-md" placeholder="e.g. 1000" />
      <button id="pa-org-grant-go" class="action-btn primary" type="button">Grant</button>
    </div>
    <p class="settings-hint" style="margin-top:4px;">Admin-granted credits never expire and land on the balance immediately.</p>
    <h4 class="acct-row-head">Members (${fmtInt(d.members.length)})</h4>
    <div id="pa-org-members" class="mbr-list"></div>`;
  const ml = $("pa-org-members");
  if (ml) for (const m of d.members) {
    const row = document.createElement("div");
    row.className = "mbr-row";
    const nm = `${m.first_name} ${m.last_name}`.trim() || m.email;
    row.innerHTML = `<div class="mbr-main"><b></b><span class="lib-table-dim"></span></div><span class="lib-badge"></span>`;
    row.querySelector(".mbr-main b")!.textContent = nm;
    row.querySelector(".mbr-main .lib-table-dim")!.textContent = m.email;
    row.querySelector(".lib-badge")!.textContent = m.role;
    ml.appendChild(row);
  }
  $("pa-org-tier-save")?.addEventListener("click", () => void changeOrgTier());
  $("pa-org-grant-go")?.addEventListener("click", () => void grantFromDetail());
}

function detailState(msg: string): void {
  const el = $("pa-org-detail-state");
  if (el) { el.textContent = msg; el.className = "set-save-state success"; }
}

async function changeOrgTier(): Promise<void> {
  if (!detailOrg) return;
  const tier = inputVal("pa-org-tier");
  if (!tier || tier === detailOrg.tier) return;
  const sure = await confirmAction({ title: `Move “${detailOrg.name}” to ${tier}?`, body: "Changes the org's plan tier immediately.", confirmLabel: "Change plan" });
  if (!sure) return;
  try {
    const updated = await read((a) => a.updateOrg?.(detailOrg!.id, { tier }), (g) => g.adminOrgUpdate?.(detailOrg!.id, { tier }));
    detailOrg = updated;
    const plansRes = await read((a) => a.plans?.(), (g) => g.adminPlans?.()).catch(() => ({ plans: [] as AdminPlan[] }));
    renderOrgDetail(updated, plansRes?.plans ?? []);
    detailState("Plan updated ✓");
  } catch (err) { setErr("pa-org-detail-error", `Couldn't change the plan — ${errText(err)}`); }
}

async function grantFromDetail(): Promise<void> {
  if (!detailOrg) return;
  const credits = Math.round(Number(inputVal("pa-org-grant-amt")) || 0);
  if (credits <= 0) { setErr("pa-org-detail-error", "Enter a positive number of credits."); return; }
  const sure = await confirmAction({ title: `Grant ${fmtInt(credits)} credits to ${detailOrg.name}?`, body: "Admin-granted credits never expire.", confirmLabel: "Grant credits" });
  if (!sure) return;
  const res = await write<number>(
    (a) => a.grantCredits?.(detailOrg!.id, credits).then((r) => r.balance),
    (g) => g.adminOrgGrantCredits?.(detailOrg!.id, credits), "balance");
  if (!res.ok) { setErr("pa-org-detail-error", res.error); return; }
  setErr("pa-org-detail-error", "");
  detailOrg.credits.balance = res.data;
  const plansRes = await read((a) => a.plans?.(), (g) => g.adminPlans?.()).catch(() => ({ plans: [] as AdminPlan[] }));
  renderOrgDetail(detailOrg, plansRes?.plans ?? []);
  detailState(`Granted — balance now ${fmtInt(microToCredits(res.data))} credits`);
}

async function refreshOrgs(): Promise<void> {
  try {
    const r = await read(
      (a) => a.orgs?.({ q: inputVal("pa-orgs-search") || undefined, page: 1, limit: 100 }),
      (g) => g.adminOrgs?.({ q: inputVal("pa-orgs-search") || undefined, page: 1, limit: 100 }));
    orgs = r?.orgs || [];
    orgsTotal = r?.total || orgs.length;
    setErr("pa-orgs-error", "");
  } catch (err) {
    orgs = [];
    orgsTotal = 0;
    setErr("pa-orgs-error", `Couldn't load organizations — ${errText(err)}`);
  }
  orgsPage = 0;
  paintOrgs();
}

export function loadAdminOrgs(): void {
  if (!orgsWired) {
    orgsWired = true;
    $("pa-orgs-search")?.addEventListener("input", () => {
      window.clearTimeout(orgsSearchTimer);
      orgsSearchTimer = window.setTimeout(() => { void refreshOrgs(); }, 250);
    });
    $("pa-org-grant-back")?.addEventListener("click", () => { grantingOrg = null; showGrantForm(false); void refreshOrgs(); });
    $("pa-grant-cancel")?.addEventListener("click", () => { grantingOrg = null; showGrantForm(false); });
    $("pa-org-detail-back")?.addEventListener("click", () => { detailOrg = null; showOrgView("list"); void refreshOrgs(); });
    $("pa-grant-save")?.addEventListener("click", () => { void grantCredits(); });
  }
  void (async () => {
    const allowed = await isSuperAdmin();
    if (allowed === false) { gatePanel("pa-orgs-gate", "pa-orgs-body", false); return; }
    gatePanel("pa-orgs-gate", "pa-orgs-body", true);
    showOrgView("list");
    const wrap = $("pa-orgs-list");
    if (wrap && !orgs.length) wrap.innerHTML = `<div class="crud-empty">Loading…</div>`;
    await refreshOrgs();
  })();
}
