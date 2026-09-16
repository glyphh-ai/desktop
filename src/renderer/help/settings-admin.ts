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
import { icoBtn, MDL_SVG } from "./models-admin.js";

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
  /** Long-context tier: whole-request multipliers above the prompt-token
   *  threshold. Null = flat pricing. */
  long_context_threshold: number | null;
  long_context_input_mult: number | null;
  long_context_output_mult: number | null;
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
  long_context_threshold?: number | null;
  long_context_input_mult?: number | null;
  long_context_output_mult?: number | null;
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
  gateway_trial_days?: number | null;
  governance?: boolean;
  allowed_models?: string[] | null;
}
interface AdminPlanPatch {
  display_name?: string;
  monthly_usd_cents?: number;
  included_credits?: number;
  max_seats?: number;
  active?: boolean;
  rate_limit_rpm?: number | null;
  gateway_trial_days?: number | null;
  governance?: boolean;
  allowed_models?: string[] | null;
}
interface AdminPlanPrice { id: string; stripePriceId: string; active: boolean; createdAt: string }
interface AdminUsageByUser { userId: string; email: string; name: string; requests: number; credits: number; tokens: number }
interface AdminUsageDay { day: string; credits: number; requests: number; inputTokens?: number; outputTokens?: number }
/** The REVENUE rollup (his correction, 2026-09-02): Stripe = real collected
 *  cash; the lot fields are the paid-vs-free credits math. */
interface AdminRevenue {
  stripe: { totalUsdCents: number; byDay: Array<{ day: string; usdCents: number }> } | null;
  lotsInWindow: Record<string, number>;
  consumedAllTime: Record<string, number>;
}
interface AdminUsageByRuntime {
  region: string; mode: string; tier: string;
  runtimes: number; orgs: number; users: number; requests: number; credits: number;
}
interface AdminOrgRow { id: string; name: string; tier: string; billing_status: string; member_count: number; credits_purchased: number; credits_spent: number; managed_by_org_id?: string | null; managed_by_name?: string | null; managed_monthly_cap_micro?: number }
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
  createProvider?: (input: { slug: string; name: string; kind: "proxied"; alias?: string | null; baseUrl?: string | null }) => Promise<unknown>;
  createModel?: (input: { id: string; providerSlug: string; name: string; kind: "proxied"; modality?: string; rateUnit?: string; alias?: string | null; contextWindow?: number | null; inputCreditsPerMTok: number; outputCreditsPerMTok: number }) => Promise<unknown>;
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
  usageByUser?: (days?: number, filters?: { orgId?: string }) => Promise<{ users: AdminUsageByUser[] }>;
  usageDaily?: (q: { from: string; to: string; tz?: string; orgId?: string }) => Promise<{ days: AdminUsageDay[] }>;
  usageByRuntime?: (q: { from: string; to: string; orgId?: string }) => Promise<{ runtimes: AdminUsageByRuntime[] }>;
  revenue?: (q: { from: string; to: string; orgId?: string }) => Promise<AdminRevenue>;
  orgs?: (q?: { q?: string; page?: number; limit?: number }) => Promise<{ orgs: AdminOrgRow[]; total: number }>;
  createOrg?: (input: { name: string; tier?: string }) => Promise<AdminOrgRow>;
  org?: (id: string) => Promise<AdminOrgDetail>;
  updateOrg?: (id: string, patch: AdminOrgPatch) => Promise<AdminOrgDetail>;
  grantCredits?: (id: string, credits: number, note?: string) => Promise<{ balance: number }>;
  inviteOrgMember?: (id: string, email: string, role?: "org_admin" | "admin" | "user") => Promise<{ acceptUrl: string }>;
  removeOrgMember?: (id: string, userId: string) => Promise<{ ok: boolean }>;
  impersonate?: (orgId: string) => Promise<{ impersonating: { orgId: string } | null } | null>;
  stopImpersonate?: () => Promise<{ impersonating: { orgId: string } | null } | null>;
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
  adminUsageByUser?: (days: number, orgId?: string) => Promise<{ users: AdminUsageByUser[] }>;
  adminUsageDaily?: (q: { from: string; to: string; tz?: string; orgId?: string }) => Promise<{ days: AdminUsageDay[] }>;
  adminUsageByRuntime?: (q: { from: string; to: string; orgId?: string }) => Promise<{ runtimes: AdminUsageByRuntime[] }>;
  adminRevenue?: (q: { from: string; to: string; orgId?: string }) => Promise<AdminRevenue>;
  adminOrgs?: (q: { q?: string; page?: number; limit?: number }) => Promise<{ orgs: AdminOrgRow[]; total: number }>;
  adminOrgCreate?: (input: { name: string; tier?: string }) => Promise<{ ok: boolean; org?: AdminOrgRow; error?: string }>;
  adminOrg?: (id: string) => Promise<AdminOrgDetail>;
  adminOrgUpdate?: (id: string, patch: AdminOrgPatch) => Promise<AdminOrgDetail>;
  adminOrgGrantCredits?: (id: string, credits: number, note?: string) => Promise<{ ok: boolean; balance?: number; error?: string }>;
  adminOrgMemberInvite?: (id: string, email: string, role?: "org_admin" | "admin" | "user") => Promise<{ ok: boolean; acceptUrl?: string; error?: string }>;
  adminOrgMemberRemove?: (id: string, userId: string) => Promise<{ ok: boolean; error?: string }>;
  adminImpersonate?: (orgId: string | null) => Promise<{ ok: boolean; impersonating?: { orgId: string } | null; error?: string }>;
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
let editingModel: AdminModel | null = null;
let modelsWired = false;

const modelId = (m: AdminModel): string => `${m.provider}::${m.model}`;

function showModelEditor(on: boolean): void {
  $("pa-models-list-view")?.classList.toggle("hidden", on);
  $("pa-model-editor")?.classList.toggle("hidden", !on);
}

interface CatalogProvider { slug: string; name: string; kind: string; baseUrl: string | null; alias: string | null }
let providers: CatalogProvider[] = [];
/** The slug being edited, or null when the form is creating a new provider. */
let editingProviderSlug: string | null = null;

async function loadProviders(): Promise<void> {
  try {
    // ADMIN lane first (ALL providers, inactive candidates included — the
    // org catalog lane hides them); then the org lane; desktop: models IPC.
    const sdk = (window as unknown as { glyphhSdk?: { admin?: { providers?: () => Promise<{ providers: CatalogProvider[] }> }; catalog?: { providers?: () => Promise<CatalogProvider[]> } } }).glyphhSdk;
    if (sdk?.admin?.providers) {
      providers = (await sdk.admin.providers()).providers;
    } else if (sdk?.catalog?.providers) {
      providers = await sdk.catalog.providers();
    } else {
      const r = await (window.glyphh as unknown as {
        orgProvidersList?: () => Promise<{ ok: boolean; data?: CatalogProvider[] }>;
      }).orgProvidersList?.();
      if (r?.ok && Array.isArray(r.data)) providers = r.data;
    }
  } catch { /* offline — the model-derived rows still paint */ }
  paintCatalog();
}

/** True while the model editor is CREATING (provider pinned by the + row). */
let creatingModelProvider: string | null = null;
const catalogExpanded = new Set<string>();
let catalogPage = 0;

/** ONE list (his spec, 2026-08-24, same as the org Models page): the PROVIDERS,
 *  expandable to the catalog models inside each. Search matches providers AND
 *  models (a model match auto-opens its provider); paginated over providers. */
function paintCatalog(): void {
  const wrap = $("pa-catalog-list");
  if (!wrap) return;
  const q = inputVal("pa-models-search").toLowerCase();
  const counts = new Map<string, { total: number; active: number }>();
  for (const m of models) {
    const cur = counts.get(m.provider) || { total: 0, active: 0 };
    cur.total += 1;
    if (m.active) cur.active += 1;
    counts.set(m.provider, cur);
  }
  const rows: CatalogProvider[] = providers.length
    ? providers
    : [...counts.keys()].map((slug) => ({ slug, name: slug, kind: "proxied", baseUrl: null, alias: null }));
  const entries = rows
    .map((p) => ({
      p,
      autoOpen: !!q && models.some((m) => m.provider === p.slug &&
        (m.display_name.toLowerCase().includes(q) || m.model.toLowerCase().includes(q))),
    }))
    .filter((e) => !q || e.p.name.toLowerCase().includes(q) || e.p.slug.toLowerCase().includes(q) || e.autoOpen)
    .sort((a, b) => a.p.name.localeCompare(b.p.name));

  const state = { page: catalogPage, pageSize: 15, total: entries.length, totalPages: Math.max(1, Math.ceil(entries.length / 15)) };
  if (state.page >= state.totalPages) { state.page = state.totalPages - 1; catalogPage = state.page; }
  const slice = entries.slice(state.page * state.pageSize, (state.page + 1) * state.pageSize);

  wrap.innerHTML = "";
  if (!slice.length) {
    wrap.innerHTML = `<div class="crud-empty">${q ? "No providers or models match your search." : "No providers yet — add one above."}</div>`;
  }
  for (const { p, autoOpen } of slice) {
    const c = counts.get(p.slug) || { total: 0, active: 0 };
    const isOpen = catalogExpanded.has(p.slug) || autoOpen;
    const row = document.createElement("div");
    row.className = "mdl-prov-row";

    const head = document.createElement("div");
    head.className = "mdl-prov-head" + (isOpen ? " open" : "");
    const chev = document.createElement("span");
    chev.className = "mdl-prov-chevron";
    chev.innerHTML = MDL_SVG.chevron;
    const info = document.createElement("div");
    info.className = "mdl-prov-info";
    const name = document.createElement("div");
    name.className = "mdl-td-name";
    name.textContent = p.name;
    const chip = document.createElement("span");
    chip.className = "mdl-type-chip glyphh";
    chip.textContent = "Proxied";   // the only kind there is (2026-08-26)
    name.appendChild(chip);
    const sub = document.createElement("div");
    sub.className = "mdl-td-sub";
    sub.textContent = `${fmtInt(c.total)} models · ${fmtInt(c.active)} active` + (p.baseUrl ? ` · ${p.baseUrl}` : "");
    info.append(name, sub);
    head.append(chev, info);

    const add = icoBtn(MDL_SVG.plus, "Add a model");
    add.addEventListener("click", (ev) => { ev.stopPropagation(); openModelCreate(p.slug); });
    const edit = icoBtn(MDL_SVG.edit, "Edit provider");
    edit.addEventListener("click", (ev) => { ev.stopPropagation(); openProviderEditor(p); });
    head.append(add, edit);
    head.addEventListener("click", () => {
      if (catalogExpanded.has(p.slug)) catalogExpanded.delete(p.slug);
      else catalogExpanded.add(p.slug);
      paintCatalog();
    });
    row.appendChild(head);

    if (isOpen) {
      const body = document.createElement("div");
      body.className = "mdl-prov-models";
      const list = models
        .filter((m) => m.provider === p.slug)
        .sort((a, b) => a.display_name.localeCompare(b.display_name));
      if (!list.length) body.innerHTML = `<div class="crud-empty">No models yet — add one with +.</div>`;
      for (const m of list) {
        const line = document.createElement("div");
        line.className = "mdl-model-line";
        const mi = document.createElement("div");
        mi.className = "mdl-model-info";
        const mn = document.createElement("div");
        mn.className = "mdl-td-name";
        mn.textContent = m.display_name;
        const rates = m.input_credits_per_mtok == null && m.output_credits_per_mtok == null
          ? "BYOK / direct"
          : `${fmtInt(microToCredits(m.input_credits_per_mtok))}/${fmtInt(microToCredits(m.output_credits_per_mtok))} cr`;
        const ms = document.createElement("div");
        ms.className = "mdl-td-sub mono";
        ms.textContent = `${m.model} · ${rates}`;
        mi.append(mn, ms);
        const editIc = icoBtn(MDL_SVG.edit, "Edit model");
        editIc.addEventListener("click", (ev) => { ev.stopPropagation(); openModelEditor(m); });
        const lab = document.createElement("label");
        lab.className = "settings-toggle mdl-toggle";
        lab.title = "Active — visible to every organization's catalog";
        lab.innerHTML = `<input type="checkbox" ${m.active ? "checked" : ""} /><span class="toggle-switch"></span>`;
        const box = lab.querySelector("input") as HTMLInputElement;
        box.addEventListener("change", () => {
          void (async () => {
            const res = await write<AdminModel>(
              (a) => a.updateModel?.(m.provider, m.model, { active: box.checked })?.then((r) => r.model),
              (g) => g.adminModelUpdate?.(m.provider, m.model, { active: box.checked }), "model");
            if (!res.ok) { box.checked = !box.checked; setErr("pa-models-error", res.error); return; }
            m.active = box.checked;
            setErr("pa-models-error", "");
            paintCatalog();
          })();
        });
        line.append(mi, editIc, lab);
        body.appendChild(line);
      }
      row.appendChild(body);
    }
    wrap.appendChild(row);
  }

  const pager = $("pa-catalog-pager");
  if (pager) {
    pager.innerHTML = "";
    if (state.totalPages > 1) pager.appendChild(renderPaginationBar(state, (pg) => { catalogPage = pg; paintCatalog(); }));
  }
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
  creatingModelProvider = null;
  $("pa-model-identity")?.classList.add("hidden");
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
  set("pa-model-lc-threshold", m.long_context_threshold == null ? "" : String(m.long_context_threshold));
  set("pa-model-lc-in", m.long_context_input_mult == null ? "" : String(m.long_context_input_mult));
  set("pa-model-lc-out", m.long_context_output_mult == null ? "" : String(m.long_context_output_mult));
  const active = $<HTMLInputElement>("pa-model-active");
  if (active) active.checked = m.active;
  const defaultOn = $<HTMLInputElement>("pa-model-default-on");
  if (defaultOn) defaultOn.checked = m.default_on;
  showModelEditor(true);
}

/** CREATE mode — the + on a provider row. Same editor page, identity shown. */
function openModelCreate(providerSlug: string): void {
  editingModel = null;
  creatingModelProvider = providerSlug;
  setErr("pa-model-form-error", "");
  const title = $("pa-model-title");
  if (title) title.textContent = "New model";
  $("pa-model-identity")?.classList.remove("hidden");
  const set = (id: string, v: string): void => { const el = $<HTMLInputElement>(id); if (el) el.value = v; };
  set("pa-model-provider", providerSlug);
  set("pa-model-id", "");
  for (const id of ["pa-model-name", "pa-model-alias", "pa-model-in", "pa-model-out", "pa-model-ctx", "pa-model-max", "pa-model-lc-threshold", "pa-model-lc-in", "pa-model-lc-out"]) set(id, "");
  const modSel = $<HTMLSelectElement>("pa-model-modality"); if (modSel) modSel.value = "chat";
  const ruSel = $<HTMLSelectElement>("pa-model-rate-unit"); if (ruSel) ruSel.value = "mtok";
  relabelModelRates("mtok");
  const active = $<HTMLInputElement>("pa-model-active"); if (active) active.checked = true;
  const defaultOn = $<HTMLInputElement>("pa-model-default-on"); if (defaultOn) defaultOn.checked = false;
  showModelEditor(true);
}

async function saveModel(): Promise<void> {
  // CREATE: the + row pinned a provider; release into the global catalog.
  if (!editingModel && creatingModelProvider) {
    const id = inputVal("pa-model-id").trim();
    const name = inputVal("pa-model-name");
    if (!id || !name) { setErr("pa-model-form-error", "The model needs an id and a display name."); return; }
    const inCr0 = numOrNull(inputVal("pa-model-in")) ?? 0;
    const outCr0 = numOrNull(inputVal("pa-model-out")) ?? 0;
    const ctx0 = numOrNull(inputVal("pa-model-ctx"));
    const input = {
      id,
      providerSlug: creatingModelProvider,
      name,
      kind: "proxied" as const,
      modality: inputVal("pa-model-modality") || "chat",
      rateUnit: inputVal("pa-model-rate-unit") || "mtok",
      ...(inputVal("pa-model-alias").trim() ? { alias: inputVal("pa-model-alias").trim() } : {}),
      ...(ctx0 ? { contextWindow: ctx0 } : {}),
      inputCreditsPerMTok: inCr0,
      outputCreditsPerMTok: outCr0,
    };
    const btn = $<HTMLButtonElement>("pa-model-save");
    if (btn) btn.disabled = true;
    const res = await write(
      (a) => a.createModel?.(input),
      (g) => g.adminModelCreate?.(input), "model");
    if (btn) btn.disabled = false;
    if (!res.ok) { setErr("pa-model-form-error", res.error); return; }
    catalogExpanded.add(creatingModelProvider);
    creatingModelProvider = null;
    showModelEditor(false);
    await loadAdminModels();
    return;
  }
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
    // Long-context tier — blank clears back to flat pricing.
    long_context_threshold: numOrNull(inputVal("pa-model-lc-threshold")) || null,
    long_context_input_mult: numOrNull(inputVal("pa-model-lc-in")) || null,
    long_context_output_mult: numOrNull(inputVal("pa-model-lc-out")) || null,
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
    showProviderEditor(true);
  });
  $("pa-pc-key-add")?.addEventListener("click", () => { void addProviderKeyFromForm(); });
  $("pa-pc-key-new")?.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") void addProviderKeyFromForm(); });
  $("pa-provider-back")?.addEventListener("click", () => showProviderEditor(false));
  $("pa-pc-cancel")?.addEventListener("click", () => showProviderEditor(false));

  $("pa-pc-save")?.addEventListener("click", () => {
    void (async () => {
      const url = inputVal("pa-pc-url").trim();
      const input = {
        slug: (editingProviderSlug ?? inputVal("pa-pc-slug").trim().toLowerCase()),
        name: inputVal("pa-pc-name").trim(),
        kind: "proxied" as const,   // every provider is served over an API now
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
  paintCatalog();
  void loadProviders(); // repaints when the provider list lands
}

export function loadAdminModels(): void {
  if (!modelsWired) {
    modelsWired = true;
    $("pa-models-search")?.addEventListener("input", () => { catalogPage = 0; paintCatalog(); });
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
  set("pa-plan-trial", p.gateway_trial_days ? String(p.gateway_trial_days) : "");
  const gov = $<HTMLInputElement>("pa-plan-governance");
  if (gov) gov.checked = !!p.governance;
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
  for (const id of ["pa-plan-tier", "pa-plan-name", "pa-plan-rpm", "pa-plan-models", "pa-plan-trial"]) set(id, "");
  const gov = $<HTMLInputElement>("pa-plan-governance");
  if (gov) gov.checked = false;
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
    // Empty = full gateway (null); N = the trial window in days.
    gateway_trial_days: inputVal("pa-plan-trial") && Number(inputVal("pa-plan-trial")) > 0
      ? Math.round(Number(inputVal("pa-plan-trial")))
      : null,
    governance: !!$<HTMLInputElement>("pa-plan-governance")?.checked,
    // One catalog id per line; empty clears the list (every model allowed).
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
let usageFinChart: { destroy: () => void } | null = null;
let usageWired = false;

// Cost = the meter's uniform COGS basis: the catalog prices models at 62.5
// credits per vendor dollar, so one burned credit = 1/62.5 = $0.016 of vendor
// spend (matches the meter's C_MICRO_USD). Revenue is NEVER derived from
// credits (his correction, 2026-09-02: spent credits may be free grants) —
// it is Stripe's collected cash.
const USD_PER_CREDIT_COST = 0.016;

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
        backgroundColor: cssVar("--accent") || "#af5fff",
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

// Last-loaded rollups — the tab search bars filter these client-side.
let lastUsageUsers: AdminUsageByUser[] = [];
let lastUsageRuntimes: AdminUsageByRuntime[] = [];

/** Token spend + revenue + cost as LINES, same window/org as the bar chart.
 *  Revenue is REAL Stripe cash by day (empty when Stripe is unconfigured). */
function renderUsageFinChart(days: AdminUsageDay[], stripeByDay: Map<string, number>): void {
  const canvas = $<HTMLCanvasElement>("pa-usage-fin-chart");
  const empty = $("pa-usage-fin-empty");
  if (!canvas || typeof Chart === "undefined") return;
  if (usageFinChart) { usageFinChart.destroy(); usageFinChart = null; }
  const hasData = days.some((d) => d.credits > 0 || (d.inputTokens ?? 0) + (d.outputTokens ?? 0) > 0);
  empty?.classList.toggle("hidden", hasData);
  canvas.style.visibility = hasData ? "visible" : "hidden";
  if (!hasData) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const accent = cssVar("--accent") || "#af5fff";
  usageFinChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: days.map((d) => shortDay(d.day)),
      datasets: [
        {
          label: "Tokens", yAxisID: "yTok",
          data: days.map((d) => (d.inputTokens ?? 0) + (d.outputTokens ?? 0)),
          borderColor: cssVar("--text-3") || "#868686", backgroundColor: "transparent",
          borderWidth: 1.5, pointRadius: 0, tension: 0.25, borderDash: [4, 3],
        },
        {
          label: "Revenue $ (Stripe)", yAxisID: "yUsd",
          data: days.map((d) => (stripeByDay.get(d.day) ?? 0) / 100),
          borderColor: accent, backgroundColor: "transparent",
          borderWidth: 2, pointRadius: 0, tension: 0.25,
        },
        {
          label: "Cost $", yAxisID: "yUsd",
          data: days.map((d) => microToCredits(d.credits) * USD_PER_CREDIT_COST),
          borderColor: "#e5a50a", backgroundColor: "transparent",
          borderWidth: 2, pointRadius: 0, tension: 0.25,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, labels: { color: cssVar("--text-3") || "#868686", boxWidth: 14 } },
        tooltip: {
          callbacks: {
            label: (c: { dataset: { label?: string }; parsed: { y: number } }) =>
              c.dataset.label === "Tokens" ? `${fmtInt(c.parsed.y)} tokens` : `${c.dataset.label ?? ""} ${c.parsed.y.toFixed(2)}`,
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: cssVar("--text-3") || "#868686", maxRotation: 0, autoSkip: true } },
        yUsd: {
          beginAtZero: true, position: "left",
          grid: { color: cssVar("--border") || "rgba(255,255,255,0.08)" },
          ticks: { color: cssVar("--text-3") || "#868686", callback: (v: number) => `$${fmtInt(v)}` },
        },
        yTok: {
          beginAtZero: true, position: "right",
          grid: { display: false },
          ticks: { color: cssVar("--text-3") || "#868686", callback: (v: number) => fmtInt(v) },
        },
      },
    },
  });
}

function paintUsageUsers(all: AdminUsageByUser[]): void {
  const wrap = $("pa-usage-users");
  if (!wrap) return;
  lastUsageUsers = all;
  const q = inputVal("pa-usage-users-search").trim().toLowerCase();
  const users = q ? all.filter((u) => `${u.name} ${u.email}`.toLowerCase().includes(q)) : all;
  wrap.innerHTML = "";
  if (!users.length) { wrap.innerHTML = `<div class="crud-empty">${q ? "No members match your search." : "No usage in this window."}</div>`; return; }
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

function paintUsageRuntimes(all: AdminUsageByRuntime[]): void {
  const wrap = $("pa-usage-runtimes");
  if (!wrap) return;
  lastUsageRuntimes = all;
  const q = inputVal("pa-usage-runtimes-search").trim().toLowerCase();
  const runtimes = q ? all.filter((r) => `${r.region} ${r.mode} ${r.tier}`.toLowerCase().includes(q)) : all;
  wrap.innerHTML = "";
  if (!runtimes.length) { wrap.innerHTML = `<div class="crud-empty">${q ? "Nothing matches your search." : "No runtime usage in this window."}</div>`; return; }
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
  // ONE filter set drives everything (his order, 2026-09-02): the bar chart's
  // org + window scope the cards, both charts, and the other two tabs.
  const orgId = $<HTMLSelectElement>("pa-usage-org")?.value || undefined;
  const query = { from: isoDay(from), to: isoDay(to), tz: Intl.DateTimeFormat().resolvedOptions().timeZone, ...(orgId ? { orgId } : {}) };
  // The rollups are independent — one failing must not blank the rest.
  const [daysRes, usersRes, revenueRes] = await Promise.allSettled([
    read((a) => a.usageDaily?.(query), (g) => g.adminUsageDaily?.(query)),
    read((a) => a.usageByUser?.(win, orgId ? { orgId } : {}), (g) => g.adminUsageByUser?.(win, orgId)),
    read((a) => a.revenue?.({ from: query.from, to: query.to, ...(orgId ? { orgId } : {}) }), (g) => g.adminRevenue?.({ from: query.from, to: query.to, ...(orgId ? { orgId } : {}) })),
  ]);
  const problems: string[] = [];
  const days: AdminUsageDay[] = daysRes.status === "fulfilled" ? (daysRes.value?.days || []) : (problems.push("daily series"), []);
  const users: AdminUsageByUser[] = usersRes.status === "fulfilled" ? (usersRes.value?.users || []) : (problems.push("top spenders"), []);
  const runtimes: AdminUsageByRuntime[] = [];   // runtime axis retired with the cloud runtime
  setErr("pa-usage-error", problems.length ? `Couldn't load the ${problems.join(", ")} — ${errText(
    (daysRes.status === "rejected" && daysRes.reason) ||
    (usersRes.status === "rejected" && usersRes.reason) ||
    (revenueRes.status === "rejected" && revenueRes.reason))}` : "");

  const credits = days.reduce((s, d) => s + microToCredits(d.credits), 0);
  const requests = days.reduce((s, d) => s + (d.requests || 0), 0);
  const set = (id: string, v: string): void => { const el = $(id); if (el) el.textContent = v; };
  set("pa-usage-credits", fmtInt(credits));
  set("pa-usage-requests", fmtInt(requests));
  set("pa-usage-active", fmtInt(users.length));
  set("pa-usage-total", `${fmtInt(credits)} credits · ${fmtInt(requests)} calls`);
  set("pa-usage-range", `last ${win} days`);
  // REVENUE = Stripe's collected cash, never credits (his correction,
  // 2026-09-02: spent credits may be free grants). Cost stays the COGS basis.
  const revenue: AdminRevenue | null = revenueRes.status === "fulfilled" ? (revenueRes.value ?? null) : null;
  set("pa-usage-revenue", revenue?.stripe ? `$${(revenue.stripe.totalUsdCents / 100).toFixed(2)}` : "—");
  const revSub = document.querySelector("#pa-usage-revenue + .dash-card-sub");
  if (revSub) revSub.textContent = revenue?.stripe ? "collected via Stripe" : "Stripe not configured";
  const costUsd = credits * USD_PER_CREDIT_COST;
  set("pa-usage-cost", `$${costUsd.toFixed(2)}`);
  // Gross margin (his order, 2026-09-02): (Stripe cash − COGS burn) / cash.
  // Honest caveat carried in the card's sub: revenue is cash COLLECTED in the
  // window while cost is credits BURNED in it — different bases (credits
  // bought one month burn in another), so this is the cash-vs-burn margin.
  const revUsd = revenue?.stripe ? revenue.stripe.totalUsdCents / 100 : null;
  // MARGIN = profit ÷ COST (his metric, 2026-09-02: "$1.15 spent, $1,567
  // made" should read as a huge number, not a ~100%-capped gross margin).
  // Reads as a × multiple past 10x; the accountant's gross-margin-of-revenue
  // rides in the sub for reconciliation.
  if (revUsd && revUsd > 0 && costUsd > 0) {
    const markup = (revUsd - costUsd) / costUsd;
    set("pa-usage-margin", markup >= 10 ? `${fmtInt(markup)}×` : `${(markup * 100).toFixed(1)}%`);
    set("pa-usage-margin-sub", `profit ÷ cost · gross ${(((revUsd - costUsd) / revUsd) * 100).toFixed(2)}% of revenue`);
  } else {
    set("pa-usage-margin", "—");
    set("pa-usage-margin-sub", "profit ÷ cost, window");
  }
  // The paid-vs-free credits math (he asked for it explicitly): what entered
  // the window by lot kind + the exact all-time burn split.
  const mix = $("pa-usage-credit-mix");
  if (mix) {
    if (revenue) {
      const m = (v?: number): string => fmtInt(microToCredits(v ?? 0));
      const freeIn = (revenue.lotsInWindow.grant ?? 0) + (revenue.lotsInWindow.admin ?? 0);
      const freeBurn = (revenue.consumedAllTime.grant ?? 0) + (revenue.consumedAllTime.admin ?? 0);
      mix.textContent =
        `Credits added in window: ${m(revenue.lotsInWindow.purchase)} purchased · ${m(freeIn)} free/granted. ` +
        `Burned all-time: ${m(revenue.consumedAllTime.purchase)} paid · ${m(freeBurn)} free (windowed burn split isn't tracked per-debit).`;
    } else mix.textContent = "";
  }
  set("pa-usage-fin-range", `last ${win} days${orgId ? " · one org" : " · all orgs"}`);
  renderUsageChart(days);
  renderUsageFinChart(days, new Map((revenue?.stripe?.byDay ?? []).map((d) => [d.day, d.usdCents])));
  paintUsageUsers(users);
  paintUsageRuntimes(runtimes);
}

/** The one date window all three Usage tabs share — three selects, one value. */
function syncUsageDays(from: string): void {
  const v = $<HTMLSelectElement>(from)?.value || "30";
  for (const id of ["pa-usage-days", "pa-usage-days-spenders", "pa-usage-days-runtime"]) {
    const el = $<HTMLSelectElement>(id);
    if (el && el.value !== v) el.value = v;
  }
}

export function loadAdminUsage(): void {
  if (!usageWired) {
    usageWired = true;
    for (const id of ["pa-usage-days", "pa-usage-days-spenders", "pa-usage-days-runtime"]) {
      $(id)?.addEventListener("change", () => { syncUsageDays(id); void refreshAdminUsage(); });
    }
    $("pa-usage-refresh")?.addEventListener("click", () => { void refreshAdminUsage(); });
    // The All-orgs filter — populated once, drives every card/chart/tab.
    $("pa-usage-org")?.addEventListener("change", () => { void refreshAdminUsage(); });
    void read((a) => a.orgs?.({ limit: 500 }), (g) => g.adminOrgs?.({ limit: 500 }))
      .then((r) => {
        const sel = $<HTMLSelectElement>("pa-usage-org");
        if (!sel || !r?.orgs) return;
        for (const o of [...r.orgs].sort((a, b) => a.name.localeCompare(b.name))) {
          const opt = document.createElement("option");
          opt.value = o.id;
          opt.textContent = o.name;
          sel.appendChild(opt);
        }
      })
      .catch(() => { /* the select degrades to All orgs */ });
    // Tab strip (his order, 2026-09-02): one tab per section.
    document.querySelectorAll<HTMLButtonElement>("#pa-usage-tabs .app-detail-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.utab || "daily";
        document.querySelectorAll<HTMLButtonElement>("#pa-usage-tabs .app-detail-tab").forEach((b) =>
          b.classList.toggle("active", b === btn));
        $("pa-usage-tab-daily")?.classList.toggle("hidden", tab !== "daily");
        $("pa-usage-tab-spenders")?.classList.toggle("hidden", tab !== "spenders");
        $("pa-usage-tab-runtime")?.classList.toggle("hidden", tab !== "runtime");
      });
    });
    // The search bars filter the loaded rollups in place.
    $("pa-usage-users-search")?.addEventListener("input", () => paintUsageUsers(lastUsageUsers));
    $("pa-usage-runtimes-search")?.addEventListener("input", () => paintUsageRuntimes(lastUsageRuntimes));
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
  const items = orgs;
  const state = { page: orgsPage, totalPages: Math.max(1, Math.ceil(orgsTotal / ORGS_PAGE_SIZE)), total: orgsTotal, pageSize: ORGS_PAGE_SIZE };
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
      { icon: ROW_MENU_ICONS.view, label: "Impersonate", danger: true, onClick: () => { void impersonateOrg(o); } },
    ]));
    tbody.appendChild(tr);
  }
  wrap.appendChild(table);
  if (state.totalPages > 1) wrap.appendChild(renderPaginationBar(state, (p) => { orgsPage = p; void refreshOrgs(); }));
  const note = $("pa-orgs-total");
  if (note) note.textContent = "";
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
function showOrgView(view: "list" | "detail" | "grant" | "create"): void {
  $("pa-orgs-list-view")?.classList.toggle("hidden", view !== "list");
  $("pa-org-detail")?.classList.toggle("hidden", view !== "detail");
  $("pa-org-grant")?.classList.toggle("hidden", view !== "grant");
  $("pa-org-create")?.classList.toggle("hidden", view !== "create");
}

/** + New Org (his order, 2026-09-02) — the roles-page create grammar: open the
 *  inline form, create a standalone org (base workspace + free credits seeded
 *  server-side), land back on the refreshed list. */
function openOrgCreate(): void {
  setErr("pa-org-create-error", "");
  const name = $<HTMLInputElement>("pa-org-create-name");
  if (name) name.value = "";
  const tier = $<HTMLSelectElement>("pa-org-create-tier");
  if (tier) tier.innerHTML = ORG_TIERS.map((t) => `<option value="${t}"${t === "free" ? " selected" : ""}>${t}</option>`).join("");
  showOrgView("create");
  name?.focus();
}

async function createOrgFromForm(): Promise<void> {
  const name = inputVal("pa-org-create-name").trim();
  if (!name) { setErr("pa-org-create-error", "The organization needs a name."); return; }
  const tier = inputVal("pa-org-create-tier") || "free";
  const btn = $<HTMLButtonElement>("pa-org-create-save");
  if (btn) btn.disabled = true;
  const res = await write<AdminOrgRow>(
    (a) => a.createOrg?.({ name, tier }),
    (g) => g.adminOrgCreate?.({ name, tier }), "org");
  if (btn) btn.disabled = false;
  if (!res.ok) { setErr("pa-org-create-error", res.error); return; }
  showOrgView("list");
  await refreshOrgs();
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
  // The lp-sec rhythm (his spec, 2026-09-01): each section owns real air +
  // a hairline before the next; the view runs full width (lp-edit).
  // Overview | Members tabs (his order, 2026-09-01): Members mirrors the
  // regular admins' Members page — search, invite ON BEHALF, delete.
  body.innerHTML = `
    <h3 class="settings-subheading" style="margin-top:0;">${escapeHtml(d.name)} <span id="pa-org-detail-state" class="set-save-state"></span></h3>
    <p class="settings-hint" style="margin:-4px 0 12px;">${escapeHtml(d.id)}</p>

    <div class="app-detail-tabs" id="pa-org-tabs" style="margin-bottom:16px;">
      <button class="app-detail-tab${orgDetailTab === "overview" ? " active" : ""}" data-otab="overview" type="button">Overview</button>
      <button class="app-detail-tab${orgDetailTab === "members" ? " active" : ""}" data-otab="members" type="button">Members</button>
    </div>

    <div id="pa-org-tab-overview"${orgDetailTab === "members" ? ` class="hidden"` : ""}>
      <div class="lp-sec">
        <div class="pa-org-stats">
          <div class="pa-stat"><span class="pa-stat-num">${fmtInt(microToCredits(d.credits.balance))}</span><span class="pa-stat-lbl">credits balance</span></div>
          <div class="pa-stat"><span class="pa-stat-num">${fmtInt(microToCredits(d.credits.used))}</span><span class="pa-stat-lbl">credits used</span></div>
          <div class="pa-stat"><span class="pa-stat-num">${fmtInt(d.member_count)} / ${fmtInt(d.max_seats)}</span><span class="pa-stat-lbl">seats</span></div>
        </div>
        <div class="pa-kv" style="margin-top:16px;">
          <div><span>Admin</span><b>${escapeHtml(ownerName)}</b></div>
          <div><span>Admin email</span><b>${owner ? escapeHtml(owner.email) : "—"}</b></div>
          <div><span>Billing</span><b>${escapeHtml(d.billing_status)}</b></div>
          <div><span>Plan allowance</span><b>${allowance != null ? fmtInt(allowance) + " / mo" : "—"}</b></div>
          <div><span>Created</span><b>${escapeHtml(fmtDate(d.created_at))}</b></div>
        </div>
      </div>

      <div class="lp-sec">
        <h4 class="acct-row-head">Plan</h4>
        <div class="settings-inline">
          <select id="pa-org-tier" class="settings-input settings-input-md">${ORG_TIERS.map((t) => `<option value="${t}"${t === d.tier ? " selected" : ""}>${t}</option>`).join("")}</select>
          <button id="pa-org-tier-save" class="action-btn" type="button">Change plan</button>
        </div>
      </div>

      <div class="lp-sec">
        <h4 class="acct-row-head">Grant credits</h4>
        <p class="section-desc">Admin-granted credits never expire and land on the balance immediately.</p>
        <div class="settings-inline">
          <input id="pa-org-grant-amt" type="number" min="1" class="settings-input settings-input-md" placeholder="e.g. 1000" />
          <button id="pa-org-grant-go" class="action-btn primary" type="button">Grant</button>
        </div>
      </div>
    </div>

    <div id="pa-org-tab-members"${orgDetailTab === "members" ? "" : ` class="hidden"`}>
      <div class="crud-toolbar">
        <div class="search-clear-wrap"><input id="pa-org-mbr-search" type="text" class="crud-search" placeholder="Search members…" spellcheck="false" autocomplete="off" /></div>
        <button id="pa-org-mbr-invite" class="action-btn primary" type="button">+ Invite</button>
      </div>
      <div id="pa-org-invite-form" class="crud-inline-form hidden" style="margin:10px 0;">
        <label class="settings-label">Email</label>
        <input id="pa-org-invite-email" type="email" class="settings-input" placeholder="name@company.com" spellcheck="false" autocomplete="off" />
        <label class="settings-label">Role</label>
        <select id="pa-org-invite-role" class="settings-input" style="max-width:200px;">
          <option value="user">Member</option>
          <option value="admin">Admin</option>
          <option value="org_admin">Org admin</option>
        </select>
        <div id="pa-org-invite-note" class="settings-hint" style="margin-top:6px;"></div>
        <div class="settings-actions" style="margin-top:10px;">
          <button id="pa-org-invite-cancel" class="action-btn" type="button">Cancel</button>
          <button id="pa-org-invite-send" class="action-btn primary" type="button">Send invite</button>
        </div>
      </div>
      <div id="pa-org-mbr-list" class="mbr-list"></div>
      <div id="pa-org-mbr-pager"></div>
    </div>`;
  body.querySelectorAll<HTMLButtonElement>("#pa-org-tabs .app-detail-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      orgDetailTab = (btn.dataset.otab as "overview" | "members") || "overview";
      body.querySelectorAll<HTMLButtonElement>("#pa-org-tabs .app-detail-tab").forEach((b) =>
        b.classList.toggle("active", b === btn));
      $("pa-org-tab-overview")?.classList.toggle("hidden", orgDetailTab !== "overview");
      $("pa-org-tab-members")?.classList.toggle("hidden", orgDetailTab !== "members");
    });
  });
  $("pa-org-tier-save")?.addEventListener("click", () => void changeOrgTier());
  $("pa-org-grant-go")?.addEventListener("click", () => void grantFromDetail());
  wireOrgMembersTab(d);
  paintOrgMembers(d);
}

// ── Org detail › Members tab (his order, 2026-09-01): the regular Members
// page's grammar — search, the member table, invite on behalf, delete. ──────

let orgDetailTab: "overview" | "members" = "overview";
let orgMbrPage = 0;
const ORG_MBR_PAGE_SIZE = 15;

function wireOrgMembersTab(d: AdminOrgDetail): void {
  $<HTMLInputElement>("pa-org-mbr-search")?.addEventListener("input", () => { orgMbrPage = 0; paintOrgMembers(d); });
  const form = $("pa-org-invite-form");
  $("pa-org-mbr-invite")?.addEventListener("click", () => {
    form?.classList.remove("hidden");
    $<HTMLInputElement>("pa-org-invite-email")?.focus();
  });
  $("pa-org-invite-cancel")?.addEventListener("click", () => {
    form?.classList.add("hidden");
    const note = $("pa-org-invite-note");
    if (note) note.textContent = "";
  });
  $("pa-org-invite-send")?.addEventListener("click", () => void sendOrgInvite(d));
}

function paintOrgMembers(d: AdminOrgDetail): void {
  const list = $("pa-org-mbr-list");
  if (!list) return;
  const q = ($<HTMLInputElement>("pa-org-mbr-search")?.value || "").trim().toLowerCase();
  const rows = d.members.filter((m) =>
    !q || `${m.first_name} ${m.last_name}`.toLowerCase().includes(q) || m.email.toLowerCase().includes(q));
  list.innerHTML = "";
  const pagerHost = $("pa-org-mbr-pager");
  if (pagerHost) pagerHost.textContent = "";
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "crud-empty";
    empty.textContent = q ? "No members match your search." : "No members yet — invite someone above.";
    list.appendChild(empty);
    return;
  }
  const table = document.createElement("table");
  table.className = "lib-table mbr-table";
  table.innerHTML = `<thead><tr><th>Name</th><th>Email</th><th>Role</th><th class="lib-row-kebab-cell"></th></tr></thead>`;
  const tbody = document.createElement("tbody");
  const pg = paginate(rows, orgMbrPage, ORG_MBR_PAGE_SIZE);
  orgMbrPage = pg.state.page;
  for (const m of pg.items) {
    const tr = document.createElement("tr");
    const nm = `${m.first_name} ${m.last_name}`.trim() || m.email;
    tr.innerHTML = `<td class="lib-table-name"></td><td class="lib-table-dim"></td><td><span class="acct-chip"></span></td>`;
    tr.querySelector(".lib-table-name")!.textContent = nm;
    tr.querySelector(".lib-table-dim")!.textContent = m.email;
    tr.querySelector(".acct-chip")!.textContent = m.role;
    tr.appendChild(kebabCell(() => [
      { icon: ROW_MENU_ICONS.delete, label: "Delete…", danger: true, onClick: () => { void removeOrgMemberOnBehalf(d, m); } },
    ]));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  list.appendChild(table);
  if (pagerHost && pg.state.totalPages > 1) {
    pagerHost.appendChild(renderPaginationBar(pg.state, (p) => { orgMbrPage = p; paintOrgMembers(d); }));
  }
}

async function sendOrgInvite(d: AdminOrgDetail): Promise<void> {
  const email = ($<HTMLInputElement>("pa-org-invite-email")?.value || "").trim();
  const rawRole = $<HTMLSelectElement>("pa-org-invite-role")?.value || "user";
  const role = (rawRole === "org_admin" || rawRole === "admin" ? rawRole : "user") as "org_admin" | "admin" | "user";
  const note = $("pa-org-invite-note");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    if (note) note.textContent = "Enter a valid email address.";
    return;
  }
  if (note) note.textContent = "Sending…";
  const res = await write<{ acceptUrl: string }>(
    (a) => a.inviteOrgMember?.(d.id, email, role).then((r) => ({ acceptUrl: r.acceptUrl })),
    (g) => g.adminOrgMemberInvite?.(d.id, email, role), "acceptUrl");
  if (!res.ok) { if (note) note.textContent = res.error; return; }
  // The accept link is ALWAYS shown (his report, 2026-09-02): mail is
  // best-effort (dev has no mailer at all), the invite itself is real either
  // way — the admin can hand the link over directly.
  if (note) note.textContent = `Invite created for ${email} ✓ — accept link: ${res.data.acceptUrl}`;
  const emailEl = $<HTMLInputElement>("pa-org-invite-email");
  if (emailEl) emailEl.value = "";
}

async function removeOrgMemberOnBehalf(d: AdminOrgDetail, m: AdminOrgMember): Promise<void> {
  const nm = `${m.first_name} ${m.last_name}`.trim() || m.email;
  const sure = await confirmAction({
    title: `Remove ${nm} from ${d.name}?`,
    body: "They lose access to the organization; their seat frees up and any apps they own pass to an org admin.",
    confirmLabel: "Remove member",
    danger: true,
  });
  if (!sure) return;
  const res = await write<boolean>(
    (a) => a.removeOrgMember?.(d.id, m.id).then(() => true),
    (g) => g.adminOrgMemberRemove?.(d.id, m.id), "ok");
  if (!res.ok) { setErr("pa-org-detail-error", res.error); return; }
  setErr("pa-org-detail-error", "");
  // Re-read the org so counts + roster are the server's truth.
  await openOrgDetail({ ...d } as unknown as AdminOrgRow);
}

/** Impersonate an org (his order, 2026-09-01): the WHOLE surface switches to
 *  that org's view; the red banner (navigation.ts) is the way back. */
async function impersonateOrg(o: AdminOrgRow): Promise<void> {
  const sure = await confirmAction({
    title: `Impersonate ${o.name}?`,
    body: "The whole app switches to this organization's view — you act as its org admin, and everything you do is audited. A red banner stays on screen until you switch back.",
    confirmLabel: "Impersonate",
    danger: true,
  });
  if (!sure) return;
  const res = await write<{ orgId: string } | null>(
    (a) => a.impersonate?.(o.id).then((r) => r?.impersonating ?? null),
    (g) => g.adminImpersonate?.(o.id), "impersonating");
  if (!res.ok) { setErr("pa-orgs-error", res.error); return; }
  // The session is now scoped server-side — a full reload repaints every
  // surface as the impersonated org (and boots the red banner).
  window.location.reload();
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

const ORGS_PAGE_SIZE = 15;
async function refreshOrgs(): Promise<void> {
  try {
    // SERVER-side pagination — the page in view is exactly one server page;
    // the bar walks the real total.
    const query = {
      q: inputVal("pa-orgs-search") || undefined,
      page: orgsPage + 1, limit: ORGS_PAGE_SIZE,
    };
    const r = await read((a) => a.orgs?.(query), (g) => g.adminOrgs?.(query));
    orgs = r?.orgs || [];
    orgsTotal = r?.total || orgs.length;
    setErr("pa-orgs-error", "");
  } catch (err) {
    orgs = [];
    orgsTotal = 0;
    setErr("pa-orgs-error", `Couldn't load organizations — ${errText(err)}`);
  }
  paintOrgs();
}

export function loadAdminOrgs(): void {
  if (!orgsWired) {
    orgsWired = true;
    $("pa-orgs-search")?.addEventListener("input", () => {
      window.clearTimeout(orgsSearchTimer);
      orgsSearchTimer = window.setTimeout(() => { orgsPage = 0; void refreshOrgs(); }, 250);
    });
    $("pa-org-grant-back")?.addEventListener("click", () => { grantingOrg = null; showGrantForm(false); void refreshOrgs(); });
    $("pa-grant-cancel")?.addEventListener("click", () => { grantingOrg = null; showGrantForm(false); });
    $("pa-org-detail-back")?.addEventListener("click", () => { detailOrg = null; showOrgView("list"); void refreshOrgs(); });
    $("pa-grant-save")?.addEventListener("click", () => { void grantCredits(); });
    $("pa-org-new-btn")?.addEventListener("click", openOrgCreate);
    $("pa-org-create-back")?.addEventListener("click", () => showOrgView("list"));
    $("pa-org-create-cancel")?.addEventListener("click", () => showOrgView("list"));
    $("pa-org-create-save")?.addEventListener("click", () => { void createOrgFromForm(); });
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
