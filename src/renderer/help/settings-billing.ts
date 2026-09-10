/**
 * settings-billing.ts — Settings › Billing.
 *
 * Ported from the platform's /billing page and its shared data layer
 * (platform/app/lib/billing/hooks.js): the credit balance and its plan-
 * allowance / purchased split, one-time top-ups, the auto-top-up rule, seat
 * usage, the invoice table, and the Stripe customer-portal hand-off.
 *
 * The plan picker lives HERE now — there is no external pricing page to send
 * anyone to anymore. The catalog is pure server DATA (api.plans(): price,
 * credits, seats, SSO per tier), so nothing static can drift; only the
 * upgrade/downgrade semantics are code, ported from the platform's
 * lib/billing/hooks.js changePlan(): no subscription → hosted checkout;
 * live subscription → confirm, then an in-app change-plan (Stripe prorates),
 * except cancel-to-free which lives in the Stripe portal. Every call goes
 * through settings-api.ts — SDK on web, main-process SDK over IPC on desktop.
 *
 * Everything Stripe does is asynchronous on its side: crediting and card
 * capture land on a webhook that can lag several seconds. Coming back from a
 * hosted page therefore re-polls a couple of times rather than claiming a
 * result it hasn't seen.
 */

import { confirmAction, escapeHtml, paginate, renderPaginationBar } from "./shared.js";
import { openUrlInWorkbench } from "./code.js";
import {
  accountApi, fmtDate, fmtInt, fmtMoney, openHostedPage,
  type BillingPlan, type Invoice, type Subscription,
} from "./settings-api.js";

// ── State ────────────────────────────────────────────────────────────────

let plans: BillingPlan[] = [];
let sub: Subscription | null = null;
let invoices: Invoice[] | null = null;
/** Role gate for the money moves (subscribe / change-plan are org_admin-only
 *  on the server). `null` = unknown — leave controls live and let the server's
 *  403 speak; `false` = a KNOWN member, disable with an honest note. */
let isAdmin: boolean | null = null;
/** The id of the control currently mid-request — disables it and nothing else. */
let busy = "";
let wired = false;
let toastTimer = 0;
/** Debounce for the auto-top-up numbers (no Save button any more). */

const $ = (id: string): HTMLElement | null => document.getElementById(id);

function setText(id: string, text: string): void {
  const el = $(id);
  if (el) el.textContent = text;
}

/** A transient success/notice line above the panel. */
function toast(msg: string): void {
  const el = $("billing-toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
  window.clearTimeout(toastTimer);
  if (msg) toastTimer = window.setTimeout(() => { el.textContent = ""; el.classList.add("hidden"); }, 4000);
}

/** The panel-level failure banner — shown INSTEAD of pretending the numbers
 *  loaded. Cleared by the next successful load. */
function fail(msg: string): void {
  const el = $("billing-error");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

// ── Painters ─────────────────────────────────────────────────────────────

function paintSeats(): void {
  if (!sub) { setText("billing-seats-count", "—"); return; }
  const used = sub.seats ?? 0;
  const max = Math.max(1, sub.maxSeats ?? 1);
  const fillEl = $("billing-seats-fill");
  if (fillEl) {
    fillEl.style.width = `${Math.min(100, Math.round((used / max) * 100))}%`;
    fillEl.classList.toggle("full", used >= max);
  }
  const tail = used >= max ? " — all in use" : "";
  setText("billing-seats-count", `${fmtInt(used)} of ${fmtInt(max)} ${max === 1 ? "seat" : "seats"} used${tail}`);
}

/**
 * The Plan bar: what you're on, from server data only. Changing it happens in
 * the plan picker folded right below (paintPlans).
 */
function paintPlan(): void {
  const current = plans.find((p) => p.tier === (sub?.tier || "free"));
  setText("billing-plan-name", current?.displayName || sub?.tier || "—");
  const bits: string[] = [];
  if (current?.monthlyCredits) bits.push(`${fmtInt(current.monthlyCredits)} credits / month`);
  if (sub?.billingStatus && sub.billingStatus !== "active") bits.push(sub.billingStatus);
  setText("billing-plan-sub", bits.join(" · ") || "No monthly allowance");
}

// ── The plan picker ──────────────────────────────────────────────────────
// Ported from the platform's /billing plan grid (lib/billing/hooks.js): the
// tiers are server data; only the change semantics below are code.

/** Tier order — decides whether a move reads as an upgrade or a downgrade. */
const RANK: Record<string, number> = { free: 0, basic: 1, pro: 2, enterprise: 3 };
/** Self-serve paid tiers. Enterprise is sales-led — never self-serve. */
const PAID = new Set(["basic", "pro"]);
const SALES_EMAIL = "sales@glyphh.ai";

/** The plans section's own error line — a failed change must say so HERE,
 *  next to the button that failed, never silently no-op. */
function planFail(msg: string): void {
  const el = $("billing-plans-error");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

/** Price line for a card. A GENERIC enterprise row is sales-led ("Custom");
 *  a bespoke row is a real invoiced deal — show its actual price. Prefers the
 *  TRUE active Stripe price (activeUsdCents) over the list price. */
function planPrice(p: BillingPlan): { amount: string; period: string } {
  if (p.tier === "enterprise" && !p.bespoke) return { amount: "Custom", period: "contact sales" };
  const usd = Math.round(((p.activeUsdCents ?? p.monthlyUsdCents) || 0) / 100);
  if (p.tier === "free") return { amount: "$0", period: "forever" };
  return { amount: `$${usd}`, period: p.bespoke ? "invoiced monthly" : "per seat / month" };
}

function contactSales(): void {
  const href = `mailto:${SALES_EMAIL}?subject=${encodeURIComponent("Glyphh Enterprise")}`;
  const isWeb = !!(window as unknown as { __GLYPHH_WEB__?: boolean }).__GLYPHH_WEB__;
  if (isWeb) window.open(href, "_blank", "noopener");
  else void window.glyphh.openExternal(href);
}

/** The card's one action, per the platform's rules: current → marked + inert;
 *  bespoke org → everything else is sales-managed; generic enterprise →
 *  contact sales; live subscription → in-app change; otherwise → checkout. */
function planActionButton(
  p: BillingPlan,
  ctx: { isCurrent: boolean; generic: boolean; subscribed: boolean; currentIsBespoke: boolean; currentTier: string },
): HTMLButtonElement | null {
  const mk = (label: string, primary: boolean, disabled: boolean, title = ""): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `action-btn${primary ? " primary" : ""} billing-plan-btn`;
    b.textContent = label;
    b.disabled = disabled;
    if (title) b.title = title;
    return b;
  };

  if (ctx.isCurrent) return mk("Current plan", false, true);
  if (ctx.currentIsBespoke) return mk("Managed by sales", false, true, "Your plan is a provisioned deal — talk to sales to change it.");
  if (ctx.generic) {
    const b = mk("Contact sales", true, false);
    b.addEventListener("click", contactSales);
    return b;
  }

  // The money moves are org_admin-gated on the server — a KNOWN member gets
  // a disabled button plus the note above the grid, not a doomed click.
  const gated = isAdmin === false;
  const gateTitle = gated ? "Only an organization admin can change the plan." : "";

  if (ctx.subscribed) {
    const up = (RANK[p.tier] ?? 0) > (RANK[ctx.currentTier] ?? 0);
    const label = p.tier === "free" ? "Downgrade to Free" : up ? "Upgrade" : "Downgrade";
    const b = mk(label, up, gated, gateTitle);
    b.addEventListener("click", () => { void doChangePlan(p, b); });
    return b;
  }
  if (PAID.has(p.tier)) {
    const b = mk("Subscribe", true, gated, gateTitle);
    b.addEventListener("click", () => { void doSubscribe(p, b); });
    return b;
  }
  return null; // the free card while unsubscribed IS the current plan
}

/** The grid of plan cards — rebuilt on every load so the buttons always match
 *  the live subscription state. */
function paintPlans(): void {
  const grid = $("billing-plan-grid");
  if (!grid) return;
  $("billing-plans-note")?.classList.toggle("hidden", isAdmin !== false);
  grid.innerHTML = "";
  const currentTier = sub?.tier || "free";
  const subscribed = sub?.billingStatus === "active";
  const currentIsBespoke = !!plans.find((x) => x.tier === currentTier)?.bespoke;

  for (const p of plans) {
    const generic = p.tier === "enterprise" && !p.bespoke;
    const isCurrent = p.tier === currentTier;
    // The generic "Custom — contact sales" card is NOT an option a user can
    // choose (his order, 2026-08-25) — only a real bespoke plan (the org's
    // own provisioned deal) earns a card here.
    if (generic && !isCurrent) continue;
    const { amount, period } = planPrice(p);
    const seatsLine = p.tier === "free" ? "1 seat"
      : generic ? `${fmtInt(p.maxSeats || 1)}+ seats`
      : `Up to ${fmtInt(p.maxSeats || 1)} seats`;
    const card = document.createElement("div");
    card.className = `billing-plan-card${isCurrent ? " current" : ""}`;
    card.innerHTML =
      `<div class="billing-plan-head">` +
        `<span class="billing-plan-name">${escapeHtml(p.displayName || p.tier)}</span>` +
        (isCurrent ? `<span class="acct-chip">Current plan</span>`
          : p.bespoke ? `<span class="acct-chip">Custom deal</span>` : "") +
      `</div>` +
      `<div class="billing-plan-price"><span class="billing-plan-amount">${escapeHtml(amount)}</span> <span class="billing-plan-period">${escapeHtml(period)}</span></div>` +
      `<div class="billing-plan-line">${generic ? "Volume credits" : `${escapeHtml(fmtInt(p.monthlyCredits || 0))} credits / month`}</div>` +
      `<div class="billing-plan-line">${escapeHtml(seatsLine)}${p.sso ? ` <span class="billing-plan-sso">SSO</span>` : ""}</div>`;
    const btn = planActionButton(p, { isCurrent, generic, subscribed, currentIsBespoke, currentTier });
    if (btn) card.appendChild(btn);
    grid.appendChild(card);
  }
}

const INV_PAGE_SIZE = 10;
let invPage = 0;

function paintInvoices(): void {
  const empty = $("billing-invoices-empty");
  const table = $("billing-invoices-table");
  const body = $("billing-invoices-body");
  const pager = $("billing-inv-pager");
  if (!empty || !table || !body) return;

  setText("billing-inv-summary", invoices === null ? "Loading…"
    : invoices.length ? `${fmtInt(invoices.length)} invoice${invoices.length === 1 ? "" : "s"}`
    : "None yet");
  if (pager) pager.textContent = "";
  if (invoices === null) {
    empty.textContent = "Loading…";
    empty.classList.remove("hidden");
    table.classList.add("hidden");
    return;
  }
  if (!invoices.length) {
    empty.textContent = "No invoices yet. They appear here after your first paid charge.";
    empty.classList.remove("hidden");
    table.classList.add("hidden");
    return;
  }
  empty.classList.add("hidden");
  table.classList.remove("hidden");
  body.innerHTML = "";
  const pg = paginate(invoices, invPage, INV_PAGE_SIZE);
  invPage = pg.state.page;
  if (pager && pg.state.totalPages > 1) {
    pager.appendChild(renderPaginationBar(pg.state, (p) => { invPage = p; paintInvoices(); }));
  }
  for (const inv of pg.items) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${escapeHtml(fmtDate(inv.created))}</td>` +
      `<td class="lib-table-name">${escapeHtml(inv.number || "—")}</td>` +
      `<td>${escapeHtml(fmtMoney(inv.amountPaid || inv.amountDue))}</td>` +
      `<td><span class="lib-run-badge ${inv.status === "paid" ? "ok" : "running"}">${escapeHtml(inv.status || "—")}</span></td>` +
      `<td class="billing-invoice-link"></td>`;
    if (inv.hostedUrl) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "action-btn";
      btn.textContent = "View";
      const url = inv.hostedUrl;
      btn.addEventListener("click", () => {
        const direct = (_n: string, u: string): void => {
          (window.glyphh as unknown as { openExternal?: (u: string) => void }).openExternal?.(u);
        };
        if (!openHostedPage("Invoice", url, direct)) toast("That invoice link is no longer valid.");
      });
      tr.querySelector(".billing-invoice-link")!.appendChild(btn);
    }
    body.appendChild(tr);
  }
}

// ── Actions ──────────────────────────────────────────────────────────────

// Stripe credits/updates the org on a WEBHOOK, so the numbers lag the redirect
// by seconds-to-a-minute. After ANY hosted hand-off (top-up, checkout, plan
// change, portal) poll credits+status every few seconds for up to two minutes,
// stopping the moment the balance or tier actually moves — never assert a
// number the server hasn't confirmed. The poll pauses while the tab is hidden
// (Stripe checkout has the focus) and resumes on visibility; it dies with the
// panel.
const POLL_EVERY_MS = 4000;
const POLL_WINDOW_MS = 120_000;
let pollTimer = 0;
let pollUntil = 0;
let pollPaused = false;
let pollBaseline: { tier: string } | null = null;

/** The Billing panel only lives inside the settings modal — gone means stop. */
function billingPanelVisible(): boolean {
  const panel = document.querySelector('.settings-panel[data-sub="billing"]');
  return !!panel && panel.classList.contains("active") && !!panel.closest("#settings-modal");
}

function stopStripePoll(): void {
  window.clearTimeout(pollTimer);
  pollTimer = 0;
  pollPaused = false;
  pollBaseline = null;
}

function repollAfterStripe(): void {
  pollBaseline = { tier: sub?.tier || "" };
  pollUntil = Date.now() + POLL_WINDOW_MS;
  pollPaused = false;
  window.clearTimeout(pollTimer);
  pollTimer = window.setTimeout(() => { void stripePollTick(); }, POLL_EVERY_MS);
}

async function stripePollTick(): Promise<void> {
  if (!pollBaseline || Date.now() > pollUntil || !billingPanelVisible()) { stopStripePoll(); return; }
  if (document.hidden) { pollPaused = true; return; }   // resumes on visibilitychange
  try {
    const api = accountApi();
    const s = await api.status().catch(() => null);
    let changed = false;
    if (s) { changed = s.tier !== pollBaseline.tier; sub = s; paintPlan(); paintSeats(); paintPlans(); }
    if (changed) { stopStripePoll(); toast("Updated — Stripe confirmed your change."); return; }
  } catch { /* transient — keep trying inside the window */ }
  pollTimer = window.setTimeout(() => { void stripePollTick(); }, POLL_EVERY_MS);
}

// ── Embedded Checkout ────────────────────────────────────────────────────
// Stripe's payment UI mounted INSIDE our own modal (ui_mode:"embedded") — the
// user pays without ever leaving the app, and completion fires an in-page
// callback instead of a redirect nobody handles. Requires the server's public
// key (GET /api/billing/config); anything missing → the hosted page, as before.

type StripeEmbedded = { mount(el: HTMLElement): void; destroy(): void };
type StripeCtor = (key: string) => { initEmbeddedCheckout(opts: { clientSecret: string; onComplete?: () => void }): Promise<StripeEmbedded> };

let stripeJsLoad: Promise<StripeCtor | null> | null = null;
function loadStripeJs(): Promise<StripeCtor | null> {
  const w = window as unknown as { Stripe?: StripeCtor };
  if (w.Stripe) return Promise.resolve(w.Stripe);
  if (stripeJsLoad) return stripeJsLoad;
  stripeJsLoad = new Promise((resolve) => {
    const el = document.createElement("script");
    el.src = "https://js.stripe.com/v3/";
    el.async = true;
    el.onload = () => resolve(w.Stripe ?? null);
    el.onerror = () => { stripeJsLoad = null; resolve(null); };   // offline → retry next attempt
    document.head.appendChild(el);
  });
  return stripeJsLoad;
}

/** null = the server has no publishable key → embedded is off. Cached for the
 *  session; a key change is a deploy, not a runtime event. */
let pubKeyCache: Promise<string | null> | null = null;
function publishableKey(): Promise<string | null> {
  if (!pubKeyCache) pubKeyCache = accountApi().billingConfig().catch(() => null);
  return pubKeyCache;
}

/**
 * THE PURGE: credits are gone — "need more usage" doors (the composer's
 * out-of-credits prompts) now just open the Billing tab, where the license
 * subscription lives.
 */
export async function openBuyCreditsModal(): Promise<void> {
  const { openSettingsModal } = await import("./index.js");
  openSettingsModal("billing");
}

async function doSubscribe(p: BillingPlan, btn: HTMLButtonElement): Promise<void> {
  if (busy) return;
  busy = `plan-${p.tier}`;
  const was = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Redirecting…";
  try {
    const res = await accountApi().subscribe(p.tier);
    if (!res.ok) { planFail(`Couldn't start checkout — ${res.error}`); return; }
    if (!openHostedPage("Subscribe", res.data, openUrlInWorkbench)) {
      planFail("The checkout link came back malformed — try again, or use the Stripe portal.");
      return;
    }
    planFail("");
    toast("Finish checkout in the hosted page — your plan updates here once Stripe confirms.");
    repollAfterStripe();
  } catch (err) {
    planFail(`Couldn't start checkout — ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    busy = "";
    btn.disabled = false;
    btn.textContent = was;
  }
}

/**
 * Live subscription → change it in place, the platform's semantics verbatim:
 * confirm first (price, credits, seats, and what proration does); paid → paid
 * goes through changePlan (a `url` in the answer means Stripe still needs a
 * hosted page — redirect; otherwise it applied immediately); target Free is a
 * scheduled CANCEL and lives in the Stripe portal, not in-app change-plan.
 * One rule the platform never had: a downgrade whose seat ceiling is below the
 * seats already in use is BLOCKED here with a clear message — the server can't
 * shrink an org below its members, so the click was doomed anyway.
 */
async function doChangePlan(p: BillingPlan, btn: HTMLButtonElement): Promise<void> {
  if (busy) return;
  const currentTier = sub?.tier || "free";
  const current = plans.find((x) => x.tier === currentTier);
  const up = (RANK[p.tier] ?? 0) > (RANK[currentTier] ?? 0);
  const { amount, period } = planPrice(p);
  const seatsInUse = sub?.seats ?? 0;

  if (!up && p.tier !== "free" && seatsInUse > (p.maxSeats || 1)) {
    planFail(`You're using ${fmtInt(seatsInUse)} seats but ${p.displayName} allows ${fmtInt(p.maxSeats || 1)} — remove members in Manage → Members first.`);
    return;
  }
  planFail("");

  if (p.tier === "free") {
    // Cancel-to-free is scheduled at period end (so seats stay valid until
    // then) and is executed in the Stripe portal — the platform's exact path.
    const freeCredits = plans.find((x) => x.tier === "free")?.monthlyCredits || 0;
    const ok = await confirmAction({
      title: "Cancel your subscription?",
      body: `You keep ${current?.displayName || "your plan"} until the period ends, then drop to Free — ${fmtInt(freeCredits)} credits a month, single seat. Cancelling happens in the Stripe portal that opens next.`,
      confirmLabel: "Open Stripe portal",
      danger: true,
    });
    if (ok) await openPortal();   // openPortal starts the post-Stripe poll itself
    return;
  }

  const details = `${amount} ${period} · ${fmtInt(p.monthlyCredits || 0)} credits / month · up to ${fmtInt(p.maxSeats || 1)} seats`;
  const ok = await confirmAction(up
    ? {
        title: `Upgrade to ${p.displayName}?`,
        body: `${details}. Stripe prorates the difference on your next invoice; seats and credits update right away.`,
        confirmLabel: "Upgrade",
      }
    : {
        title: `Downgrade to ${p.displayName}?`,
        body: `${details}. Stripe credits the prorated difference on your next invoice.`,
        confirmLabel: "Downgrade",
      });
  if (!ok) return;

  busy = `plan-${p.tier}`;
  const was = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Updating…";
  try {
    const res = await accountApi().changePlan(p.tier);
    if (!res.ok) { planFail(`Couldn't change the plan — ${res.error}`); return; }
    if (res.data?.url) {
      // effect "checkout" — Stripe still needs a hosted page (e.g. no card yet).
      if (!openHostedPage("Change plan", res.data.url, openUrlInWorkbench)) {
        planFail("The Stripe link came back malformed — try again.");
        return;
      }
      toast("Finish in the hosted page — your plan updates here once Stripe confirms.");
    } else {
      // Applied immediately server-side; the webhook still settles the details.
      toast(`Plan updated to ${p.displayName}.`);
      void loadBilling();
    }
    repollAfterStripe();
  } catch (err) {
    planFail(`Couldn't change the plan — ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    busy = "";
    btn.disabled = false;
    btn.textContent = was;
  }
}

async function openPortal(): Promise<void> {
  const statusEl = $("billing-portal-status");
  const btn = $("billing-portal-btn") as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  if (statusEl) { statusEl.textContent = "Opening…"; statusEl.className = "settings-hint"; }
  try {
    const res = await accountApi().portal();
    if (!res.ok) {
      if (statusEl) { statusEl.textContent = res.error; statusEl.className = "settings-error"; }
      return;
    }
    if (!openHostedPage("Stripe portal", res.data, openUrlInWorkbench)) {
      if (statusEl) { statusEl.textContent = "The portal link came back malformed."; statusEl.className = "settings-error"; }
      return;
    }
    if (statusEl) statusEl.textContent = "";
    repollAfterStripe();
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      statusEl.className = "settings-error";
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Wiring + load ────────────────────────────────────────────────────────

export function initBilling(): void {
  if (wired) return;
  wired = true;

  // The pricing-table link: a real tab on web; the system browser on desktop
  // (an anchor inside the Electron shell would navigate the app window).
  $("billing-pricing-link")?.addEventListener("click", (e) => {
    const g = window.glyphh as unknown as { openExternal?: (u: string) => void };
    if (g.openExternal && !(window as unknown as { __GLYPHH_WEB__?: boolean }).__GLYPHH_WEB__) {
      e.preventDefault();
      g.openExternal("https://glyphh.ai/pricing");
    }
  });

  // Adjust plan → its own in-tab form; the plan cards act on their own, so
  // the footer is just Cancel.
  const closePlansForm = (): void => {
    $("billing-plans-form")?.classList.add("hidden");
    $("billing-main")?.classList.remove("hidden");
  };
  $("billing-plans-toggle")?.addEventListener("click", () => {
    $("billing-main")?.classList.add("hidden");
    $("billing-plans-form")?.classList.remove("hidden");
  });
  $("billing-plans-back")?.addEventListener("click", closePlansForm);
  $("billing-plans-cancel")?.addEventListener("click", closePlansForm);

  $("billing-portal-btn")?.addEventListener("click", () => { void openPortal(); });

  // A hidden tab pauses the post-Stripe poll (the checkout has the focus);
  // coming back resumes it if its two-minute window is still open.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && pollPaused && pollBaseline) {
      pollPaused = false;
      void stripePollTick();
    }
  });

  // The plan picker + the folded Organization group (the retired Organization
  // tab) share the same disclosure wiring as Auto top-up / Invoices.
  for (const [btn, body] of [
    ["billing-inv-toggle", "billing-invoices-wrap"],
  ]) {
    $(btn)?.addEventListener("click", () => {
      const open = $(btn)?.getAttribute("aria-expanded") !== "true";
      $(btn)?.setAttribute("aria-expanded", String(open));
      $(body)?.classList.toggle("hidden", !open);
    });
  }
}

/**
 * Load every billing surface. Each read stands alone: a member without billing
 * visibility (403 on the org pool) still gets their plan catalog and seats, and
 * anything that genuinely failed says so instead of showing zeros.
 */
/** The card on file — brand + last4 from Stripe, best-effort. */
async function paintCardOnFile(): Promise<void> {
  const line = document.getElementById("billing-card-line");
  const sub = document.getElementById("billing-card-sub");
  if (!line || !sub) return;
  try {
    const api = window.glyphh as unknown as {
      billingPaymentMethod?: () => Promise<{ brand: string; last4: string; expMonth: number; expYear: number } | null>;
    };
    const card = await api.billingPaymentMethod?.();
    if (card?.brand) {
      // A wallet method (Stripe Link, etc.) has no card digits to show.
      const brand = card.brand === "link" ? "Stripe Link"
        : card.brand.charAt(0).toUpperCase() + card.brand.slice(1);
      line.textContent = card.last4 ? `${brand} •••• ${card.last4}` : brand;
      sub.textContent = card.expMonth ? `Expires ${String(card.expMonth).padStart(2, "0")}/${card.expYear} · managed securely by Stripe` : "Managed securely by Stripe.";
    } else {
      line.textContent = "No card on file";
      sub.textContent = "Add one with Update — managed securely by Stripe.";
    }
  } catch { /* keep the static copy */ }
}

export async function loadBilling(): Promise<void> {
  // Entering the tab always lands on the page, not a form left open.
  $("billing-plans-form")?.classList.add("hidden");
  initBilling();
  void paintCardOnFile();
  const api = accountApi();
  const problems: string[] = [];

  const [plansRes, statusRes, invRes, roleRes] = await Promise.allSettled([
    api.plans(), api.status(), api.invoices(),
    // Role gates the plan-change buttons (subscribe/change-plan are org_admin
    // on the server). Same source Members/Organization use.
    Promise.resolve(window.glyphh.getAccountInfo?.()).then((info) => info?.role || ""),
  ]);

  if (plansRes.status === "fulfilled") plans = plansRes.value || [];
  else problems.push("plans");

  if (statusRes.status === "fulfilled") sub = statusRes.value;
  else problems.push("subscription");

  invoices = invRes.status === "fulfilled" ? (invRes.value || []) : [];
  if (invRes.status === "rejected") problems.push("invoices");

  // Unknown role (signed out mid-load, old build) stays null — buttons stay
  // live and the server's 403 lands on the section's error line instead.
  const role = roleRes.status === "fulfilled" ? roleRes.value : "";
  isAdmin = role ? ["org_admin", "super_admin"].includes(role) : null;

  fail(problems.length ? `Couldn't load ${problems.join(", ")} — check your connection and try again.` : "");
  paintSeats();
  paintPlan();
  paintPlans();
  paintInvoices();
}
