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
  input_credits_per_mtok: number | null;  // MICRO-credits per MTok on the wire
  output_credits_per_mtok: number | null;
  context_window: number | null;
  max_output_tokens: number | null;
  active: boolean;
}
interface AdminModelPatch {
  display_name?: string;
  alias?: string | null;
  active?: boolean;
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

// ── Transport ─────────────────────────────────────────────────────────────

interface SdkAdmin {
  models?: () => Promise<{ models: AdminModel[] }>;
  updateModel?: (provider: string, model: string, patch: AdminModelPatch) => Promise<{ model: AdminModel }>;
  createProvider?: (input: { slug: string; name: string; kind: "proxied" | "open_weight"; alias?: string | null; baseUrl?: string | null }) => Promise<unknown>;
  createModel?: (input: { id: string; providerSlug: string; name: string; kind: "proxied" | "open_weight"; alias?: string | null; contextWindow?: number | null; inputCreditsPerMTok: number; outputCreditsPerMTok: number }) => Promise<unknown>;
  plans?: () => Promise<{ plans: AdminPlan[] }>;
  updatePlan?: (tier: string, patch: AdminPlanPatch) => Promise<{ plan: AdminPlan }>;
  planPrices?: (tier: string) => Promise<AdminPlanPrice[]>;
  addPlanPrice?: (tier: string, stripePriceId: string) => Promise<AdminPlanPrice>;
  activatePlanPrice?: (id: string) => Promise<AdminPlanPrice>;
  removePlanPrice?: (id: string) => Promise<void>;
  usageByUser?: (days?: number) => Promise<{ users: AdminUsageByUser[] }>;
  usageDaily?: (q: { from: string; to: string; tz?: string }) => Promise<{ days: AdminUsageDay[] }>;
  usageByRuntime?: (q: { from: string; to: string }) => Promise<{ runtimes: AdminUsageByRuntime[] }>;
  orgs?: (q?: { q?: string; page?: number; limit?: number }) => Promise<{ orgs: AdminOrgRow[]; total: number }>;
  grantCredits?: (id: string, credits: number, note?: string) => Promise<{ balance: number }>;
}
interface DesktopAdminIpc {
  adminModels?: () => Promise<{ models: AdminModel[] }>;
  adminModelUpdate?: (provider: string, model: string, patch: AdminModelPatch) => Promise<{ ok: boolean; model?: AdminModel; error?: string }>;
  adminProviderCreate?: (input: Record<string, unknown>) => Promise<{ ok: boolean; provider?: unknown; error?: string }>;
  adminModelCreate?: (input: Record<string, unknown>) => Promise<{ ok: boolean; model?: unknown; error?: string }>;
  adminPlans?: () => Promise<{ plans: AdminPlan[] }>;
  adminPlanUpdate?: (tier: string, patch: AdminPlanPatch) => Promise<{ ok: boolean; plan?: AdminPlan; error?: string }>;
  adminPlanPrices?: (tier: string) => Promise<AdminPlanPrice[]>;
  adminPlanPriceAdd?: (tier: string, priceId: string) => Promise<{ ok: boolean; price?: AdminPlanPrice; error?: string }>;
  adminPlanPriceActivate?: (id: string) => Promise<{ ok: boolean; price?: AdminPlanPrice; error?: string }>;
  adminPlanPriceRemove?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  adminUsageByUser?: (days: number) => Promise<{ users: AdminUsageByUser[] }>;
  adminUsageDaily?: (q: { from: string; to: string; tz?: string }) => Promise<{ days: AdminUsageDay[] }>;
  adminUsageByRuntime?: (q: { from: string; to: string }) => Promise<{ runtimes: AdminUsageByRuntime[] }>;
  adminOrgs?: (q: { q?: string; page?: number; limit?: number }) => Promise<{ orgs: AdminOrgRow[]; total: number }>;
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

/** Distinct providers behind the catalog, derived from the model list — the
 *  server exposes no platform-key read (keys are server config; never shown). */
function paintProviders(): void {
  const wrap = $("pa-providers-list");
  if (!wrap) return;
  const byProvider = new Map<string, { total: number; active: number }>();
  for (const m of models) {
    const cur = byProvider.get(m.provider) || { total: 0, active: 0 };
    cur.total += 1;
    if (m.active) cur.active += 1;
    byProvider.set(m.provider, cur);
  }
  wrap.innerHTML = "";
  if (!byProvider.size) { wrap.innerHTML = `<div class="crud-empty">No providers yet.</div>`; return; }
  const { table, tbody } = mkTable(["Provider", "Models", "Active"], false);
  for (const [slug, c] of [...byProvider.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="lib-table-name"></td><td>${fmtInt(c.total)}</td><td class="lib-table-dim">${fmtInt(c.active)}</td>`;
    const cell = tr.querySelector(".lib-table-name");
    if (cell) cell.textContent = slug;
    tbody.appendChild(tr);
  }
  wrap.appendChild(table);
}

function openModelEditor(m: AdminModel): void {
  editingModel = m;
  setErr("pa-model-form-error", "");
  const title = $("pa-model-title");
  if (title) title.textContent = `${m.display_name} · ${modelId(m)}`;
  const set = (id: string, v: string): void => { const el = $<HTMLInputElement>(id); if (el) el.value = v; };
  set("pa-model-name", m.display_name);
  set("pa-model-alias", m.alias || "");
  set("pa-model-in", m.input_credits_per_mtok == null ? "" : String(microToCredits(m.input_credits_per_mtok)));
  set("pa-model-out", m.output_credits_per_mtok == null ? "" : String(microToCredits(m.output_credits_per_mtok)));
  set("pa-model-ctx", m.context_window == null ? "" : String(m.context_window));
  set("pa-model-max", m.max_output_tokens == null ? "" : String(m.max_output_tokens));
  const active = $<HTMLInputElement>("pa-model-active");
  if (active) active.checked = m.active;
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
  $("pa-model-add-btn")?.addEventListener("click", () => { toggle("pa-model-create", true); toggle("pa-provider-create", false); });
  $("pa-mc-cancel")?.addEventListener("click", () => toggle("pa-model-create", false));
  $("pa-provider-add-btn")?.addEventListener("click", () => { toggle("pa-provider-create", true); toggle("pa-model-create", false); });
  $("pa-pc-cancel")?.addEventListener("click", () => toggle("pa-provider-create", false));

  $("pa-pc-save")?.addEventListener("click", () => {
    void (async () => {
      const input = {
        slug: inputVal("pa-pc-slug").trim().toLowerCase(),
        name: inputVal("pa-pc-name").trim(),
        kind: (inputVal("pa-pc-kind") || "proxied") as "proxied" | "open_weight",
        ...(inputVal("pa-pc-url").trim() ? { baseUrl: inputVal("pa-pc-url").trim() } : {}),
      };
      if (!input.slug || !input.name) { setErr("pa-provider-create-error", "Slug and name are required."); return; }
      const res = await write(
        (a) => a.createProvider?.(input),
        (g) => g.adminProviderCreate?.(input), "provider");
      if (!res.ok) { setErr("pa-provider-create-error", res.error); return; }
      setErr("pa-provider-create-error", "");
      toggle("pa-provider-create", false);
      await loadAdminModelsAsync();
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
  paintProviders();
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

/** The self-serve tiers that carry a Stripe subscription price — the platform
 *  page's exact rule (enterprise is sales-led, free has no price). */
const PRICED_TIERS = new Set(["basic", "pro"]);

function showPlanEditor(on: boolean): void {
  $("pa-plans-list-view")?.classList.toggle("hidden", on);
  $("pa-plan-editor")?.classList.toggle("hidden", !on);
}

function paintPlans(): void {
  const wrap = $("pa-plans-list");
  if (!wrap) return;
  const globals = plans.filter((p) => !p.org_id);
  wrap.innerHTML = "";
  if (!globals.length) { wrap.innerHTML = `<div class="crud-empty">No plans yet.</div>`; return; }
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
  const priced = PRICED_TIERS.has(editingPlan.tier);
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
  if (!editingPlan || !PRICED_TIERS.has(editingPlan.tier)) { planPrices = []; paintPlanPrices(); return; }
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

async function savePlan(): Promise<void> {
  if (!editingPlan) return;
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
  const res = await write<AdminPlan>(
    (a) => a.updatePlan?.(editingPlan!.tier, patch)?.then((r) => r.plan),
    (g) => g.adminPlanUpdate?.(editingPlan!.tier, patch), "plan");
  if (btn) btn.disabled = false;
  if (!res.ok) { setErr("pa-plan-form-error", res.error); return; }
  showPlanEditor(false);
  editingPlan = null;
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
    $("pa-plan-back")?.addEventListener("click", () => { editingPlan = null; showPlanEditor(false); });
    $("pa-plan-cancel")?.addEventListener("click", () => { editingPlan = null; showPlanEditor(false); });
    $("pa-plan-save")?.addEventListener("click", () => { void savePlan(); });
    $("pa-price-add")?.addEventListener("click", () => { void addPrice(); });
    $("pa-price-new")?.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") void addPrice(); });
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
    tr.addEventListener("click", () => openGrantForm(o));
    tr.appendChild(kebabCell(() => [
      { icon: ROW_MENU_ICONS.edit, label: "Grant credits", onClick: () => openGrantForm(o) },
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
    $("pa-grant-save")?.addEventListener("click", () => { void grantCredits(); });
  }
  void (async () => {
    const allowed = await isSuperAdmin();
    if (allowed === false) { gatePanel("pa-orgs-gate", "pa-orgs-body", false); return; }
    gatePanel("pa-orgs-gate", "pa-orgs-body", true);
    showGrantForm(false);
    const wrap = $("pa-orgs-list");
    if (wrap && !orgs.length) wrap.innerHTML = `<div class="crud-empty">Loading…</div>`;
    await refreshOrgs();
  })();
}
