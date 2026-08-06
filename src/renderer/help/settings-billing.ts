/**
 * settings-billing.ts — Settings › Billing.
 *
 * Ported from the platform's /billing page and its shared data layer
 * (platform/app/lib/billing/hooks.js): the credit balance and its plan-
 * allowance / purchased split, one-time top-ups, the auto-top-up rule, seat
 * usage, the invoice table, and the Stripe customer-portal hand-off.
 *
 * What is deliberately NOT here: the plan catalogue. Prices, tiers and feature
 * lists are the web's copy to own — a second pricing table in the app is a
 * second thing to keep in sync, and it drifted. The Plan bar names the current
 * plan (server data) and links out for everything else. Every call goes through
 * settings-api.ts — SDK on web, main-process SDK over IPC on desktop.
 *
 * Everything Stripe does is asynchronous on its side: crediting and card
 * capture land on a webhook that can lag several seconds. Coming back from a
 * hosted page therefore re-polls a couple of times rather than claiming a
 * result it hasn't seen.
 */

import { escapeHtml, platformUrl } from "./shared.js";
import { openUrlInWorkbench } from "./code.js";
import {
  accountApi, creditsForUsd, fmtDate, fmtInt, fmtMoney, MICRO, openHostedPage,
  toCredits, TOPUP_PRESETS, USD_PER_CREDIT,
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
  setText("billing-grants", credits ? fmtInt(toCredits(credits.grants)) : "—");
  setText("billing-purchases", credits ? fmtInt(toCredits(credits.purchases)) : "—");
}

function paintTopup(): void {
  const grid = $("billing-topup-grid");
  setText("billing-rate", `One-time credit purchases never expire. ≈ ${fmtInt(creditsForUsd(1))} credits per dollar.`);
  if (!grid || grid.childElementCount) return;   // presets are static — build once
  for (const usd of TOPUP_PRESETS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "billing-topup-card";
    btn.dataset.usd = String(usd);
    btn.innerHTML =
      `<span class="billing-topup-credits">${escapeHtml(fmtInt(creditsForUsd(usd)))}</span>` +
      `<span class="billing-topup-unit">credits</span>` +
      `<span class="billing-topup-price">$${usd}</span>`;
    btn.addEventListener("click", () => { void buyTopup(usd, btn); });
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
 * The Plan bar: what you're on, from server data only. Changing it happens on
 * the web — see the module header on why the catalogue doesn't live here.
 */
function paintPlan(): void {
  const current = plans.find((p) => p.tier === (sub?.tier || "free"));
  setText("billing-plan-name", current?.displayName || sub?.tier || "—");
  const bits: string[] = [];
  if (current?.monthlyCredits) bits.push(`${fmtInt(current.monthlyCredits)} credits / month`);
  if (sub?.billingStatus && sub.billingStatus !== "active") bits.push(sub.billingStatus);
  setText("billing-plan-sub", bits.join(" · ") || "No monthly allowance");
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

/** Stripe credits the org on a WEBHOOK, so the balance lags the redirect by a
 *  few seconds. Re-poll rather than assert a number we haven't been told. */
function repollAfterStripe(): void {
  window.setTimeout(() => { void loadBilling(); }, 2500);
  window.setTimeout(() => { void loadBilling(); }, 6000);
}

async function buyTopup(usd: number, btn?: HTMLButtonElement): Promise<void> {
  if (!usd || usd < 5) { toast("Minimum top-up is $5."); return; }
  if (busy) return;
  busy = `topup-${usd}`;
  // Progress shows as a disabled control + a toast: the preset cards are built
  // from spans, so rewriting their text would eat the markup.
  if (btn) btn.disabled = true;
  try {
    // topup() takes MICRO-credits; the USD amount converts through the display rate.
    const res = await accountApi().topup(creditsForUsd(usd) * MICRO);
    if (!res.ok) { toast(`Could not start the top-up — ${res.error}`); return; }
    if (!openHostedPage("Add credits", res.data, openUrlInWorkbench)) {
      toast("The checkout link came back malformed — try the Stripe portal below.");
      return;
    }
    toast("Finish the purchase in the checkout page — your credits appear here once Stripe confirms.");
    repollAfterStripe();
  } catch (err) {
    toast(`Could not start the top-up — ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    busy = "";
    if (btn) btn.disabled = false;
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
    // The 30-day cap is NOT persisted by the server yet — see the field's hint.
    const res = await accountApi().setAutotopup({
      enabled: autoTopup.enabled,
      thresholdCredits: (autoTopup.thresholdCredits || 0) * MICRO,
      topupCredits: creditsForUsd(autoTopup.packUsd) * MICRO,
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
    setText("billing-topup-custom-hint", usd > 0 ? `≈ ${fmtInt(creditsForUsd(usd))} credits` : "");
  });
  $("billing-topup-buy")?.addEventListener("click", (e) => {
    void buyTopup(Number(custom?.value || 0), e.currentTarget as HTMLButtonElement);
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
  });

  // Plan changes are the web's — this panel never learned the prices.
  $("billing-plans-web")?.addEventListener("click", () => {
    const base = platformUrl();
    if (base) openUrlInWorkbench("Plans & pricing", `${base}/billing`);
  });
  $("billing-portal-btn")?.addEventListener("click", () => { void openPortal(); });

  for (const [btn, body] of [["billing-at-toggle", "billing-at-body"], ["billing-inv-toggle", "billing-invoices-wrap"]]) {
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
export async function loadBilling(): Promise<void> {
  initBilling();
  paintTopup();
  const api = accountApi();
  const problems: string[] = [];

  const [plansRes, statusRes, creditsRes, atRes, invRes] = await Promise.allSettled([
    api.plans(), api.status(), api.credits(), api.autotopup(), api.invoices(),
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
      // The server does not persist a 30-day cap yet — the field is a local
      // guard rail only, so it keeps whatever the user last typed this session.
      monthlyCapUsd: autoTopup.monthlyCapUsd,
    };
  }

  invoices = invRes.status === "fulfilled" ? (invRes.value || []) : [];
  if (invRes.status === "rejected") problems.push("invoices");

  fail(problems.length ? `Couldn't load ${problems.join(", ")} — check your connection and try again.` : "");
  paintCredits();
  paintAutotopup();
  paintSeats();
  paintPlan();
  paintInvoices();
}
