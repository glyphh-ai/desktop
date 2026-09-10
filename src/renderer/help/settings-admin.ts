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
  allowed_models?: string[] | null;
}
interface AdminPlanPatch {
  display_name?: string;
  monthly_usd_cents?: number;
  included_credits?: number;
  max_seats?: number;
  active?: boolean;
  rate_limit_rpm?: number | null;
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
  set("pa-plan-models", (p.allowed_models ?? []).join("\n"));
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
  for (const id of ["pa-plan-tier", "pa-plan-name", "pa-plan-rpm", "pa-plan-models"]) set(id, "");
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
    // One catalog id per line; empty clears the list (every model allowed).
    allowed_models: (() => {
      const ids = inputVal("pa-plan-models").split("\n").map((l) => l.trim()).filter(Boolean);
      return ids.length ? ids : null;
    })(),
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
// Orgs (list + plan/member management)
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
