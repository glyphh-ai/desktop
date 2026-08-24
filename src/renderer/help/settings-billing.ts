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

import { confirmAction, escapeHtml } from "./shared.js";
import { openUrlInWorkbench } from "./code.js";
import {
  accountApi, creditsForUsd, fmtDate, fmtInt, fmtMoney, MICRO, openHostedPage,
  toCredits, USD_PER_CREDIT,
  TOPUP_CREDIT_BUCKETS, topupDiscount, usdForCredits, creditsForUsdTiered,
  type Autotopup, type BillingPlan, type CreditsBreakdown, type Invoice, type Subscription,
} from "./settings-api.js";

// ── State ────────────────────────────────────────────────────────────────

let plans: BillingPlan[] = [];
let sub: Subscription | null = null;
let credits: CreditsBreakdown | null = null;
/** Auto-top-up in DISPLAY units (whole credits + USD), mirroring the platform
 *  form. Converted back to micro-credits on save. */
let autoTopup = { enabled: false, thresholdCredits: 100, packUsd: 24, monthlyCapUsd: 200 };
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
let atTimer = 0;

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

function paintCredits(): void {
  setText("billing-balance", credits ? fmtInt(toCredits(credits.balance)) : "—");
  // "Plan allowance" = what the CURRENT PLAN allocates each month, from the
  // plan catalog — NOT credits.grants, which the server computes as the sum of
  // REMAINING expiring grant credits (a burn-down that read like the balance).
  // Painted after plans + status settle in loadBilling; "—" until both known.
  const plan = plans.find((p) => p.tier === (sub?.tier || "free"));
  setText("billing-grants", plan ? fmtInt(plan.monthlyCredits || 0) : "—");
  setText("billing-purchases", credits ? fmtInt(toCredits(credits.purchases)) : "—");
}

function paintTopup(): void {
  const grid = $("billing-topup-grid");
  setText("billing-rate", `One-time credit purchases never expire. ≈ ${fmtInt(creditsForUsd(1))} credits per dollar.`);
  if (!grid || grid.childElementCount) return;   // presets are static — build once
  for (const credits of TOPUP_CREDIT_BUCKETS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "billing-topup-card";
    const save = topupDiscount(credits);
    btn.innerHTML =
      `<span class="billing-topup-price">$${usdForCredits(credits)}</span>` +
      `<span class="billing-topup-credits">${escapeHtml(fmtInt(credits))}</span>` +
      `<span class="billing-topup-unit">credits</span>` +
      (save > 0 ? `<span class="billing-topup-save">Save ${Math.round(save * 100)}%</span>` : "");
    btn.addEventListener("click", () => { void buyTopup(credits, btn); });
    grid.appendChild(btn);
  }
}

function paintAutotopup(): void {
  const on = $("billing-at-enabled") as HTMLInputElement | null;
  const threshold = $("billing-at-threshold") as HTMLInputElement | null;
  const pack = $("billing-at-pack") as HTMLInputElement | null;
  const cap = $("billing-at-cap") as HTMLInputElement | null;
  if (on) on.checked = autoTopup.enabled;
  // Never stomp a field the user is typing in.
  if (threshold && document.activeElement !== threshold) threshold.value = String(autoTopup.thresholdCredits);
  if (pack && document.activeElement !== pack) pack.value = String(autoTopup.packUsd);
  if (cap && document.activeElement !== cap) cap.value = String(autoTopup.monthlyCapUsd);
  setText("billing-at-pack-hint", `≈ ${fmtInt(creditsForUsd(autoTopup.packUsd))} credits`);
  paintAutotopupSummary();
}

/** Seats: the meter plus ONE line. The three-way explanation that used to sit
 *  under it pointed at a plan grid that no longer exists. */
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

function paintInvoices(): void {
  const empty = $("billing-invoices-empty");
  const table = $("billing-invoices-table");
  const body = $("billing-invoices-body");
  if (!empty || !table || !body) return;

  setText("billing-inv-summary", invoices === null ? "Loading…"
    : invoices.length ? `${fmtInt(invoices.length)} invoice${invoices.length === 1 ? "" : "s"}`
    : "None yet");
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
  for (const inv of invoices) {
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
        if (!openHostedPage("Invoice", url, openUrlInWorkbench)) toast("That invoice link is no longer valid.");
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
let pollBaseline: { balance: number; tier: string } | null = null;

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
  pollBaseline = { balance: credits?.balance ?? -1, tier: sub?.tier || "" };
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
    // Reads are independent: a member's 403 on the credit pool must not stop
    // the tier watch (that is exactly the post-subscribe case).
    const [c, s] = await Promise.all([api.credits().catch(() => null), api.status().catch(() => null)]);
    let changed = false;
    if (s) { changed = changed || s.tier !== pollBaseline.tier; sub = s; }
    if (c) { changed = changed || c.balance !== pollBaseline.balance; credits = c; }
    if (c || s) { paintCredits(); paintPlan(); paintSeats(); paintPlans(); }
    if (changed) { stopStripePoll(); toast("Updated — Stripe confirmed your change."); return; }
  } catch { /* transient — keep trying inside the window */ }
  pollTimer = window.setTimeout(() => { void stripePollTick(); }, POLL_EVERY_MS);
}

/** The manual refresh next to the Credits header — same on-demand re-pull the
 *  Account plan chip offers, for when the webhook outruns the poll window. */
async function refreshCredits(): Promise<void> {
  const btn = $("billing-credits-refresh");
  btn?.classList.add("spinning");
  try {
    const api = accountApi();
    const [c, s] = await Promise.all([api.credits().catch(() => null), api.status().catch(() => null)]);
    if (c) credits = c;
    if (s) sub = s;
    paintCredits();
    paintPlan();
    paintSeats();
    paintPlans();
  } finally {
    window.setTimeout(() => btn?.classList.remove("spinning"), 400);
  }
}

/** A dedicated little overlay holding ONLY the embedded checkout — the
 *  Settings page's topup cards use this so the purchase happens in place.
 *  Resolves true when it handled the purchase (mounted), false → hosted. */
async function embeddedTopupOverlay(credits: number): Promise<boolean> {
  // PRE-CHECK before any DOM shows: an overlay that appears and instantly
  // vanishes into the hosted fallback reads as a glitch ("an odd popup shows
  // then jumps"). No key or no Stripe.js → never build the overlay at all.
  const key = await publishableKey();
  if (!key) return false;
  if (!(await loadStripeJs())) return false;
  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay buy-credits-overlay";
  overlay.innerHTML = `
    <div class="confirm-box buy-credits-box">
      <div class="confirm-head"><h3>Add ${escapeHtml(fmtInt(credits))} credits — $${usdForCredits(credits)}</h3></div>
      <div class="confirm-body"><div class="bc-checkout-stage"></div></div>
      <div class="confirm-foot"><button class="action-btn" id="bc-x" type="button">Cancel</button></div>
    </div>`;
  const closeIt = (): void => overlay.remove();
  overlay.querySelector("#bc-x")!.addEventListener("click", closeIt);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) closeIt(); });
  document.body.appendChild(overlay);
  const stage = overlay.querySelector<HTMLElement>(".bc-checkout-stage")!;
  const mounted = await tryEmbeddedTopup(credits, stage, (grantSeen) => {
    if (!overlay.isConnected) return;
    stage.innerHTML = grantSeen
      ? `<div class="bc-confirming bc-done">✓ Credits added.</div>`
      : `<div class="bc-confirming">Payment received. Stripe is taking longer than usual — your credits will appear shortly.</div>`;
    void refreshCredits();
    window.setTimeout(() => { if (overlay.isConnected) closeIt(); }, 1600);
  }).catch(() => false);
  if (!mounted) closeIt();
  return mounted;
}

export async function buyTopup(credits: number, btn?: HTMLButtonElement): Promise<void> {
  const usd = usdForCredits(credits);
  if (!credits || usd < 5) { toast("Minimum top-up is $5."); return; }
  if (busy) return;
  busy = `topup-${credits}`;
  // Progress shows as a disabled control + a toast: the preset cards are built
  // from spans, so rewriting their text would eat the markup.
  if (btn) btn.disabled = true;
  try {
    // Embedded first — the purchase completes in an in-app overlay.
    if (await embeddedTopupOverlay(credits)) { repollAfterStripe(); return; }
    // topup() takes MICRO-credits; the server prices them with the same
    // volume-discount tiers this page displays.
    const res = await accountApi().topup(Math.round(credits * MICRO));
    if (!res.ok) { toast(`Could not start the top-up — ${res.error}`); return; }
    const hostedInFront = (name: string, url: string): void => {
      // The settings modal guards webviews (wb-modal-open hides them), so a
      // workbench panel opened now is INVISIBLE until settings closes. The
      // system browser is always in front; the workbench path stays for
      // callers outside the modal.
      if (document.getElementById("settings-modal")) {
        (window.glyphh as unknown as { openExternal?: (u: string) => void }).openExternal?.(url);
      } else {
        openUrlInWorkbench(name, url);
      }
    };
    if (!openHostedPage("Add credits", res.data, hostedInFront)) {
      toast("The checkout link came back malformed — try the Stripe portal below.");
      return;
    }
    toast("Finish the purchase in your browser — your credits appear here once Stripe confirms.");
    repollAfterStripe();
  } catch (err) {
    toast(`Could not start the top-up — ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    busy = "";
    if (btn) btn.disabled = false;
  }
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
 * Try the whole purchase inside `host`: mount Stripe's embedded checkout, and
 * on completion poll the balance until the webhook grant lands (or the window
 * closes). Returns false when embedded isn't available — the caller falls
 * back to the hosted page, the pre-existing path.
 */
async function tryEmbeddedTopup(
  credits: number,
  host: HTMLElement,
  onSettled: (grantSeen: boolean) => void,
): Promise<boolean> {
  const key = await publishableKey();
  if (!key) return false;
  const Stripe = await loadStripeJs();
  if (!Stripe) return false;
  const res = await accountApi().topupEmbedded(Math.round(credits * MICRO));
  if (!res.ok) return false;   // old server without embedded support → hosted

  const api = accountApi();
  const before = await api.credits().then((c) => c.balance).catch(() => -1);
  const checkout = await Stripe(key).initEmbeddedCheckout({
    clientSecret: res.data,
    onComplete: () => {
      // Paid. The credits land on the checkout.session.completed webhook —
      // swap to a confirming state and poll until the balance moves.
      checkout.destroy();
      host.innerHTML = `<div class="bc-confirming"><span class="spinner"></span> Payment received — confirming your credits…</div>`;
      const until = Date.now() + POLL_WINDOW_MS;
      const tick = async (): Promise<void> => {
        const bal = await api.credits().then((c) => c.balance).catch(() => -1);
        if (bal >= 0 && bal !== before) { onSettled(true); return; }
        if (Date.now() > until || !host.isConnected) { onSettled(false); return; }
        window.setTimeout(() => { void tick(); }, POLL_EVERY_MS);
      };
      window.setTimeout(() => { void tick(); }, 2000);
    },
  });
  host.innerHTML = "";
  checkout.mount(host);
  return true;
}

/**
 * The COMPACT "out of credits" dialog — the 402 hand-off. Buy ad-hoc credits
 * without leaving the agent: Stripe's Embedded Checkout mounts INSIDE this
 * modal (card details go to Stripe's iframe, never our DOM), completion is
 * confirmed in place, and the hosted page remains the fallback when the
 * server has no publishable key.
 */
export async function openBuyCreditsModal(): Promise<void> {
  if (document.querySelector(".buy-credits-overlay")) return;   // never stack two
  const api = accountApi();
  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay buy-credits-overlay";
  overlay.innerHTML = `
    <div class="confirm-box buy-credits-box">
      <div class="confirm-head"><h3>Add credits</h3></div>
      <div class="confirm-body">
        <p class="bc-balance">Balance: <strong id="bc-balance">—</strong> credits · one-time purchases never expire.</p>
        <div class="billing-topup-grid bc-grid" id="bc-grid"></div>
        <label class="settings-toggle" style="margin-top:18px;">
          <input type="checkbox" id="bc-autotopup" />
          <span class="toggle-switch"></span>
          Auto-top-up when I run low (keeps generations from stopping)
        </label>
        <div class="settings-error hidden" id="bc-error" style="margin-top:10px;"></div>
      </div>
      <div class="confirm-foot">
        <button class="action-btn" id="bc-manage" type="button">Manage billing</button>
        <button class="action-btn primary" id="bc-close" type="button">Close</button>
      </div>
    </div>`;
  const close = (): void => { overlay.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  const setErr = (m: string): void => { const el = overlay.querySelector<HTMLElement>("#bc-error"); if (el) { el.textContent = m; el.classList.toggle("hidden", !m); } };
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);

  // Live balance.
  void api.credits().then((c) => { const b = overlay.querySelector("#bc-balance"); if (b && c) b.textContent = fmtInt(toCredits(c.balance)); }).catch(() => { /* leave the dash */ });

  // One-time top-up cards → the SAME Stripe checkout the Billing page uses.
  const grid = overlay.querySelector<HTMLElement>("#bc-grid")!;
  for (const credits of TOPUP_CREDIT_BUCKETS) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "billing-topup-card";
    const save = topupDiscount(credits);
    card.innerHTML =
      `<span class="billing-topup-price">$${usdForCredits(credits)}</span>` +
      `<span class="billing-topup-credits">${fmtInt(credits)}</span>` +
      `<span class="billing-topup-unit">credits</span>` +
      (save > 0 ? `<span class="billing-topup-save">Save ${Math.round(save * 100)}%</span>` : "");
    card.addEventListener("click", async () => {
      if (busy) return;
      busy = `bc-${credits}`; card.disabled = true; setErr("");
      try {
        // Embedded first: the purchase completes INSIDE this modal.
        const body = overlay.querySelector<HTMLElement>(".confirm-body")!;
        const stage = document.createElement("div");
        stage.className = "bc-checkout-stage";
        const mounted = await tryEmbeddedTopup(credits, stage, (grantSeen) => {
          if (!overlay.isConnected) return;
          if (grantSeen) {
            stage.innerHTML = `<div class="bc-confirming bc-done">✓ Credits added — you're good to go.</div>`;
            void api.credits().then((c) => { const b = overlay.querySelector("#bc-balance"); if (b && c) b.textContent = fmtInt(toCredits(c.balance)); }).catch(() => {});
            window.setTimeout(() => { if (overlay.isConnected) close(); }, 1600);
          } else {
            stage.innerHTML = `<div class="bc-confirming">Payment received. Stripe is taking longer than usual — your credits will appear shortly.</div>`;
          }
        });
        if (mounted) {
          // Swap the picker for the checkout, with a way back.
          for (const el of Array.from(body.children)) (el as HTMLElement).classList.add("hidden");
          body.appendChild(stage);
          const back = document.createElement("button");
          back.type = "button";
          back.className = "action-btn bc-back";
          back.textContent = "← Back";
          back.addEventListener("click", () => {
            stage.remove(); back.remove();
            for (const el of Array.from(body.children)) (el as HTMLElement).classList.remove("hidden");
          });
          body.appendChild(back);
          return;
        }
        // No key / no Stripe.js / old server → the hosted page, as before.
        const res = await api.topup(Math.round(credits * MICRO));
        if (!res.ok) { setErr(res.error || "Could not start checkout."); return; }
        if (!openHostedPage("Add credits", res.data, openUrlInWorkbench)) { setErr("The checkout link came back malformed."); return; }
        close();   // Stripe opens; credits land via webhook and refresh on Billing.
      } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
      finally { busy = ""; card.disabled = false; }
    });
    grid.appendChild(card);
  }

  // Auto-top-up: reflect the current state, save immediately on toggle.
  const at = overlay.querySelector<HTMLInputElement>("#bc-autotopup")!;
  void api.autotopup().then((a) => { if (a) at.checked = !!a.enabled; }).catch(() => { /* default off */ });
  at.addEventListener("change", async () => {
    setErr("");
    const res = await api.setAutotopup({
      enabled: at.checked,
      thresholdCredits: Math.round((autoTopup.thresholdCredits || 100) * MICRO),
      topupCredits: Math.round(creditsForUsd(autoTopup.packUsd || 24) * MICRO),
    }).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    if (!res.ok) { setErr(res.error || "Could not save auto-top-up."); at.checked = !at.checked; }
    else autoTopup.enabled = at.checked;
  });

  overlay.querySelector("#bc-close")!.addEventListener("click", close);
  overlay.querySelector("#bc-manage")!.addEventListener("click", () => { close(); openUrlInWorkbench("Billing", ""); });
}

/** No subscription yet → a hosted Stripe Checkout, exactly the top-up shape. */
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

async function saveAutotopup(): Promise<void> {
  if (busy) return;
  busy = "autotopup";
  const statusEl = $("billing-at-status");
  if (statusEl) { statusEl.textContent = "Saving…"; statusEl.className = "set-save-state"; }
  try {
    // The SDK stores MICRO-credits: the threshold is whole credits (×1e6), and
    // the USD pack converts to credits through the display rate (×1e6).
    // Math.round both — the server schema is z.number().int(), and a typed
    // decimal (or float arithmetic on the rate) makes ×1e6 non-integral → the
    // whole write bounces with "invalid request body".
    // The 30-day cap is NOT persisted by the server yet — see the field's hint.
    const res = await accountApi().setAutotopup({
      enabled: autoTopup.enabled,
      thresholdCredits: Math.round((autoTopup.thresholdCredits || 0) * MICRO),
      topupCredits: Math.round(creditsForUsd(autoTopup.packUsd) * MICRO),
    });
    if (statusEl) {
      statusEl.textContent = res.ok ? "Saved" : res.error;
      statusEl.className = `set-save-state ${res.ok ? "success" : "error"}`;
    }
    if (res.ok) window.setTimeout(() => { if (statusEl) statusEl.textContent = ""; }, 2500);
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      statusEl.className = "set-save-state error";
    }
  } finally {
    busy = "";
    paintAutotopupSummary();
  }
}

/** Debounced commit for the auto-top-up numbers — same contract as Account:
 *  no Save button, typing settles, then it writes. */
function scheduleAutotopup(delay = 700): void {
  window.clearTimeout(atTimer);
  atTimer = window.setTimeout(() => { void saveAutotopup(); }, delay);
}

/** The fold's one-line summary, so the rule is readable while shut. */
function paintAutotopupSummary(): void {
  setText("billing-at-summary", autoTopup.enabled
    ? `On — buy $${autoTopup.packUsd} below ${fmtInt(autoTopup.thresholdCredits)} credits`
    : "Off");
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

  const custom = $("billing-topup-custom") as HTMLInputElement | null;
  custom?.addEventListener("input", () => {
    const usd = Number(custom.value);
    const c = creditsForUsdTiered(usd);
    const save = topupDiscount(c);
    setText("billing-topup-custom-hint", usd > 0
      ? `≈ ${fmtInt(c)} credits${save > 0 ? ` · Save ${Math.round(save * 100)}%` : ""}`
      : "");
  });
  $("billing-topup-buy")?.addEventListener("click", (e) => {
    void buyTopup(creditsForUsdTiered(Number(custom?.value || 0)), e.currentTarget as HTMLButtonElement);
  });

  // Auto-top-up saves itself: the toggle at once (a single decision), the
  // numbers once typing settles, so a half-typed threshold never reaches the
  // server but nobody has to find a Save button either.
  ($("billing-at-enabled") as HTMLInputElement | null)?.addEventListener("change", (e) => {
    autoTopup.enabled = (e.currentTarget as HTMLInputElement).checked;
    void saveAutotopup();
  });
  ($("billing-at-threshold") as HTMLInputElement | null)?.addEventListener("input", (e) => {
    autoTopup.thresholdCredits = Math.max(0, Number((e.currentTarget as HTMLInputElement).value) || 0);
    scheduleAutotopup();
  });
  ($("billing-at-pack") as HTMLInputElement | null)?.addEventListener("input", (e) => {
    autoTopup.packUsd = Math.max(0, Number((e.currentTarget as HTMLInputElement).value) || 0);
    setText("billing-at-pack-hint", `≈ ${fmtInt(creditsForUsd(autoTopup.packUsd))} credits`);
    scheduleAutotopup();
  });
  // The 30-day cap is local-only until the server persists it, so it stages
  // into state and deliberately does NOT trigger a write.
  ($("billing-at-cap") as HTMLInputElement | null)?.addEventListener("input", (e) => {
    autoTopup.monthlyCapUsd = Math.max(0, Number((e.currentTarget as HTMLInputElement).value) || 0);
    void window.glyphh.setPreference?.("billingMonthlyCapUsd", autoTopup.monthlyCapUsd);
  });

  $("billing-portal-btn")?.addEventListener("click", () => { void openPortal(); });
  $("billing-credits-refresh")?.addEventListener("click", () => { void refreshCredits(); });

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
    ["billing-plans-toggle", "billing-plans-body"],
    ["billing-buy-toggle", "billing-buy-body"],
    ["billing-at-toggle", "billing-at-body"],
    ["billing-inv-toggle", "billing-invoices-wrap"],
    ["org-panel-fold-toggle", "org-panel-fold-body"],
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
    if (card?.last4) {
      const brand = card.brand ? card.brand.charAt(0).toUpperCase() + card.brand.slice(1) : "Card";
      line.textContent = `${brand} •••• ${card.last4}`;
      sub.textContent = card.expMonth ? `Expires ${String(card.expMonth).padStart(2, "0")}/${card.expYear} · managed securely by Stripe` : "Managed securely by Stripe.";
    } else {
      line.textContent = "No card on file";
      sub.textContent = "Add one with Update — managed securely by Stripe.";
    }
  } catch { /* keep the static copy */ }
}

export async function loadBilling(): Promise<void> {
  initBilling();
  paintTopup();
  void paintCardOnFile();
  const api = accountApi();
  const problems: string[] = [];

  const [plansRes, statusRes, creditsRes, atRes, invRes, roleRes] = await Promise.allSettled([
    api.plans(), api.status(), api.credits(), api.autotopup(), api.invoices(),
    // Role gates the plan-change buttons (subscribe/change-plan are org_admin
    // on the server). Same source Members/Organization use.
    Promise.resolve(window.glyphh.getAccountInfo?.()).then((info) => info?.role || ""),
  ]);

  if (plansRes.status === "fulfilled") plans = plansRes.value || [];
  else problems.push("plans");

  if (statusRes.status === "fulfilled") sub = statusRes.value;
  else problems.push("subscription");

  // The org credit pool is ADMIN-ONLY — a member's 403 is not an error to
  // shout about, it just leaves the cards blank.
  credits = creditsRes.status === "fulfilled" ? creditsRes.value : null;

  if (atRes.status === "fulfilled") {
    const a: Autotopup = atRes.value;
    autoTopup = {
      enabled: !!a.enabled,
      thresholdCredits: toCredits(a.thresholdCredits),
      packUsd: Math.round(toCredits(a.topupCredits) * USD_PER_CREDIT),
      // The server does not persist a 30-day cap yet — a LOCAL preference
      // (billingMonthlyCapUsd) shared with the Usage page's spend-limit form.
      monthlyCapUsd: Number(await window.glyphh.getPreference?.("billingMonthlyCapUsd", autoTopup.monthlyCapUsd)) || autoTopup.monthlyCapUsd,
    };
  }

  invoices = invRes.status === "fulfilled" ? (invRes.value || []) : [];
  if (invRes.status === "rejected") problems.push("invoices");

  // Unknown role (signed out mid-load, old build) stays null — buttons stay
  // live and the server's 403 lands on the section's error line instead.
  const role = roleRes.status === "fulfilled" ? roleRes.value : "";
  isAdmin = role ? ["org_admin", "super_admin"].includes(role) : null;

  fail(problems.length ? `Couldn't load ${problems.join(", ")} — check your connection and try again.` : "");
  paintCredits();
  paintAutotopup();
  paintSeats();
  paintPlan();
  paintPlans();
  paintInvoices();
}
