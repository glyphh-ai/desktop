/**
 * marketplace-program.ts — the developer PROGRAM panes of the Marketplace →
 * Developer console (moved here whole from the retired Settings → Developer
 * page, 2026-08-20):
 *
 *   • Developer Agreement pane — the hosted agreement (opened in the app's own
 *     browser panel), the current version, the consent checkbox that commits
 *     on check (program enrollment), and the program status chip.
 *   • Payouts pane — EARNINGS as usage-style stat cards (Gross / Net / Unpaid /
 *     Paid out) with the payout history table, then the PAYOUT CONNECTION:
 *     Stripe Connect onboarding state, the manual account-id fallback and the
 *     payout threshold. All autosaving, field validation inline.
 *
 * The program is HANDLE-scoped (contract DeveloperProgram): the panel resolves
 * the caller's profile first (org over personal). The #dev-program-error
 * banner is reserved for GENUINE action failures.
 */

import {
  mkt, mktProgram, escMkt, mktDate, mktCreditsFromMicro, mktErrorText, mktNoticeHtml,
  type MktProgramState, type MktEarningsPage, type MktPayout,
} from "./marketplace-data.js";
import { openHostedPage } from "./settings-api.js";
import { openUrlInWorkbench } from "./code.js";

const AGREEMENT_URL = "https://glyphh.ai/developer-agreement";

/** The panel's one error surface — the shared marketplace notice banner
 *  (icon + message on a quiet surface). GENUINE action failures only; field
 *  validation reports inline on the field instead. */
function showError(msg: string): void {
  const el = document.getElementById("dev-program-error");
  if (!el) return;
  el.innerHTML = mktNoticeHtml(msg);
  el.classList.remove("hidden");
}

/** Per-heading autosave chips (set-save-state spans in the subheadings) —
 *  the panel's only save reporting, exactly like Account/Roles. */
const chipTimers = new Map<string, number>();
function chip(id: string, msg: string, kind: "success" | "error" | "" = ""): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.className = `set-save-state${kind ? ` ${kind}` : ""}`;
  window.clearTimeout(chipTimers.get(id));
  if (kind === "success") chipTimers.set(id, window.setTimeout(() => { el.textContent = ""; }, 2500));
}

/** One field-level inline error (Apps → New grammar): `.invalid` on the input,
 *  the message in the settings-error line right under it. */
function fieldError(input: HTMLInputElement, errEl: HTMLElement | null, msg: string | null): void {
  input.classList.toggle("invalid", !!msg);
  if (!errEl) return;
  errEl.textContent = msg || "";
  errEl.classList.toggle("hidden", !msg);
}

// Stale-load guard — the panel refetches on every show and after every write.
let loadEpoch = 0;

// ── Stripe hand-off poller ────────────────────────────────────────────────
// Onboarding happens on Stripe's hosted page in the browser panel; Stripe's
// webhook flips payout readiness server-side, and nothing pushes that change
// to this pane. After the hand-off we POLL the program state (every 6s, up to
// 5 min) and repaint the moment it moves — his bug: the Payouts page "doesn't
// update on its own" after signup.
let pollTimer = 0;
function pollProgramUntilChanged(handle: string, snapshot: string): void {
  window.clearInterval(pollTimer);
  let tries = 0;
  pollTimer = window.setInterval(() => {
    if (++tries > 50 || !document.getElementById("dev-payout-body")) {
      window.clearInterval(pollTimer);
      return;
    }
    void mktProgram.state(handle).then((next) => {
      if (next && JSON.stringify(next.payout) !== snapshot) {
        window.clearInterval(pollTimer);
        void loadProgramPanes();
      }
    }).catch(() => { /* transient — next tick retries */ });
  }, 6000);
}

/** The two panes' MARKUP — the console injects these into its Agreement and
 *  Payouts tabs (ids unchanged from the retired settings panel). */
export function programPanesHtml(): { agreement: string; payouts: string } {
  return {
    agreement: `
      <h3 class="settings-subheading" style="margin-top:18px;">Developer Agreement
        <button id="dev-agreement-refresh" class="acct-chip-refresh" title="Refresh agreement and program status" aria-label="Refresh agreement and program status">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><polyline points="21 3 21 8 16 8"/></svg>
        </button>
        <span id="dev-legal-status" class="set-save-state"></span></h3>
      <div class="acct-section">
        <p class="settings-hint" style="margin:0;">Publishing means agreeing to the developer agreement: sandbox rules, no data exfiltration beyond declared capabilities, payout terms, support falls to you.</p>
        <a id="dev-agreement-link" href="${AGREEMENT_URL}">Read the developer agreement ↗</a>
        <div id="dev-legal-body"></div>
      </div>
      <h3 class="settings-subheading">Program status</h3>
      <div class="acct-section">
        <div class="dev-status-row">
          <span id="dev-status-chip" class="mkt-review-chip">—</span>
          <span id="dev-status-explain" class="settings-hint" style="margin:0;flex:1;"></span>
        </div>
      </div>`,
    payouts: `
      <h3 class="settings-subheading" style="margin-top:18px;">Earnings
        <button id="dev-payout-refresh" class="acct-chip-refresh" title="Refresh earnings and payout status" aria-label="Refresh earnings and payout status">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><polyline points="21 3 21 8 16 8"/></svg>
        </button>
        <span id="dev-payout-status" class="set-save-state"></span></h3>
      <div class="acct-section">
        <p class="settings-hint" style="margin:0;">What your apps have earned on the marketplace. Purchased or granted credits are never redeemable for cash — only earned revenue is payable, through this program.</p>
        <div id="dev-earnings-body"></div>
      </div>
      <h3 class="settings-subheading">Payout connection
        <button id="dev-connection-refresh" class="acct-chip-refresh" title="Refresh payout connection status" aria-label="Refresh payout connection status">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><polyline points="21 3 21 8 16 8"/></svg>
        </button></h3>
      <div class="acct-section">
        <p class="settings-hint" style="margin:0;">Earned marketplace revenue pays out monthly via Stripe Connect. Stripe collects your details on their hosted page; they never touch Glyphh.</p>
        <div id="dev-payout-body"></div>
      </div>`,
  };
}

export function initProgramPanes(): void {
  // The agreement is a hosted legal page but it never leaves the app — the
  // same in-app hand-off the billing pages use (a workbench browser panel).
  document.getElementById("dev-agreement-link")?.addEventListener("click", (e) => {
    e.preventDefault();
    openHostedPage("Developer agreement", AGREEMENT_URL, openUrlInWorkbench);
  });
  // Earnings refresh: readiness flips server-side (Stripe's webhook), so
  // "check again" is just a fresh program read.
  document.getElementById("dev-payout-refresh")?.addEventListener("click", () => {
    document.getElementById("dev-payout-refresh")?.classList.add("spinning");
    void loadProgramPanes();
  });
  document.getElementById("dev-connection-refresh")?.addEventListener("click", () => {
    document.getElementById("dev-connection-refresh")?.classList.add("spinning");
    void loadProgramPanes();
  });
  document.getElementById("dev-agreement-refresh")?.addEventListener("click", () => {
    document.getElementById("dev-agreement-refresh")?.classList.add("spinning");
    void loadProgramPanes();
  });
}

export async function loadProgramPanes(): Promise<void> {
  const epoch = ++loadEpoch;
  document.getElementById("dev-program-error")?.classList.add("hidden");

  // The program is HANDLE-scoped — resolve the caller's profile first (org
  // over personal: the publisher gate reads the org profile for org apps).
  // No profile → status "none" with a create-a-profile nudge; profile but no
  // program surface (old SDK bundle) → "coming online".
  let handle: string | null = null;
  let state: MktProgramState | null = null;
  let failed = false;
  try {
    const me = await mkt.devMe();
    // PERSONAL FIRST (his decision, 2026-08-20): publishing keys on YOUR
    // profile; the org profile returns with domain verification.
    handle = me.personal?.handle ?? me.org?.handle ?? null;
    if (handle) state = await mktProgram.state(handle);
  } catch (err) { failed = true; showError(mktErrorText(err)); }
  if (epoch !== loadEpoch) return;

  renderStatus(state, failed, handle);
  renderLegal(state, failed, handle);
  await renderMoney(state, failed, epoch, handle);
  for (const id of ["dev-payout-refresh", "dev-connection-refresh", "dev-agreement-refresh"]) {
    document.getElementById(id)?.classList.remove("spinning");
  }
}

// ── Program status (Developer Agreement tab) ──────────────────────────────

function renderStatus(state: MktProgramState | null, failed: boolean, handle: string | null): void {
  const chipEl = document.getElementById("dev-status-chip");
  const explain = document.getElementById("dev-status-explain");
  if (!chipEl || !explain) return;
  if (failed) {
    chipEl.className = "mkt-review-chip";
    chipEl.textContent = "Unknown";
    explain.textContent = "Couldn't load your program status — see the error above.";
    return;
  }
  if (!handle) {
    chipEl.className = "mkt-review-chip";
    chipEl.textContent = "Not enrolled";
    explain.textContent = "You haven't joined the developer program yet. Create a developer profile on the Developer tab, then accept the developer agreement above — listing on the marketplace is gated on both.";
    return;
  }
  if (!state) {
    chipEl.className = "mkt-review-chip";
    chipEl.textContent = "Coming online";
    explain.textContent = "The developer program is rolling out. Your profile is live today; enrollment, standing, and payouts light up here the moment the program surface ships.";
    return;
  }
  if (state.status === "enrolled") {
    chipEl.className = "mkt-review-chip approved";
    chipEl.textContent = "Enrolled";
    explain.textContent = state.agreement.current
      ? "You're in the developer program — publishing to the marketplace is open to you."
      : "You're enrolled, but the developer agreement has been updated — re-accept it above to keep publishing.";
  } else if (state.status === "suspended") {
    chipEl.className = "mkt-review-chip rejected";
    chipEl.textContent = "Suspended";
    explain.textContent = "Your membership is suspended — listings are paused and payouts held. Contact support to resolve it.";
  } else {
    chipEl.className = "mkt-review-chip";
    chipEl.textContent = "Not enrolled";
    explain.textContent = "You haven't joined the developer program yet. Accept the developer agreement above — listing on the marketplace is gated on it.";
  }
}

// ── Developer Agreement (consent) ─────────────────────────────────────────

function renderLegal(state: MktProgramState | null, failed: boolean, handle: string | null): void {
  const body = document.getElementById("dev-legal-body");
  if (!body) return;
  if (failed) {
    body.innerHTML = `<p class="settings-hint" style="margin:0;">Consent status is unavailable right now.</p>`;
    return;
  }

  const currentVersion = state?.agreement.currentVersion ?? "";
  const acceptedVersion = state?.agreement.acceptedVersion ?? null;
  const acceptedAt = state?.agreement.acceptedAt ?? null;
  const current = state?.agreement.current ?? false;
  const enrolled = !!state && state.status !== "none";

  if (enrolled && current) {
    body.innerHTML = `
      <div class="mkt-side-row"><span>Accepted version</span><b>${escMkt(acceptedVersion || "—")}</b></div>
      <div class="mkt-side-row"><span>Accepted on</span><b>${escMkt(mktDate(acceptedAt))}</b></div>`;
    return;
  }

  // The accept controls are ALWAYS VISIBLE (his spec, 2026-08-24) — gated,
  // not hidden: the orange notice names what's missing, the read-acknowledgment
  // is its own step, and Accept enables only when profile + acknowledgment +
  // a published version all hold.
  const reconsent = enrolled && !current;
  const blocker = !handle
    ? "Complete your developer profile on the Developer tab first — enrollment records consent for a specific profile."
    : !state
      ? "The developer program is coming online — your profile is live; consent recording lights up here shortly."
      : !currentVersion
        ? "The current agreement version hasn't been published yet — accepting opens here once it is."
        : "";
  const canAcknowledge = !!handle && !!state && !!currentVersion;
  body.innerHTML = `
    ${blocker ? mktNoticeHtml(blocker, "warn") : ""}
    ${reconsent ? `<p class="settings-hint" style="margin:0 0 10px;color:var(--accent);">The developer agreement has been updated${acceptedVersion ? ` — you accepted ${escMkt(acceptedVersion)}` : ""}. Review and accept version ${escMkt(currentVersion)} to keep publishing.</p>` : ""}
    <div class="mkt-side-row"><span>Current version</span><b>${escMkt(currentVersion || "—")}</b></div>
    <label class="settings-toggle" style="margin:10px 0 0;${canAcknowledge ? "" : "opacity:0.55;"}">
      <input type="checkbox" id="dev-consent-check" ${canAcknowledge ? "" : "disabled"} />
      <span class="toggle-switch"></span>
      I have read the Glyphh Developer Agreement${currentVersion ? ` (${escMkt(currentVersion)})` : ""}
    </label>
    <div class="settings-actions" style="margin-top:12px;">
      <div style="flex:1;"></div>
      <button id="dev-consent-accept" class="action-btn primary" type="button" disabled>${reconsent ? "Accept the updated agreement" : "Accept & enroll"}</button>
    </div>`;

  const check = body.querySelector<HTMLInputElement>("#dev-consent-check");
  const accept = body.querySelector<HTMLButtonElement>("#dev-consent-accept");
  if (!check || !accept) return;
  check.addEventListener("change", () => { accept.disabled = !(canAcknowledge && check.checked); });
  accept.addEventListener("click", async () => {
    if (!handle || !currentVersion || !check.checked) return;
    accept.disabled = true;
    check.disabled = true;
    chip("dev-legal-status", reconsent ? "Recording consent…" : "Enrolling…");
    const res = await mktProgram.enroll(handle, currentVersion);
    if (res.ok) {
      chip("dev-legal-status", reconsent ? "Consent recorded" : "Enrolled", "success");
      // Repaint EVERYTHING off the fresh read — the Payouts tab's Stripe
      // signup must appear NOW, not after leaving the marketplace (his bug).
      void loadProgramPanes();
      return;
    }
    check.checked = false;
    check.disabled = false;
    accept.disabled = true;
    chip("dev-legal-status", "Not saved", "error");
    showError(res.error);
  });
}

// ── Earnings (usage-style stat cards + payout history table) ──────────────

function earningsCardsHtml(e: MktEarningsPage | null): string {
  const t = e?.totals ?? null;
  const v = (micro: number | undefined): string => (t && micro !== undefined ? mktCreditsFromMicro(micro) : "—");
  const paidMicro = t ? t.netCreditsMicro - t.unpaidNetCreditsMicro : undefined;
  return `
    <div class="dash-grid">
      <div class="dash-card"><div class="dash-card-label">Gross</div><div class="dash-card-value">${v(t?.grossCreditsMicro)}</div><div class="dash-card-sub">earned credits</div></div>
      <div class="dash-card"><div class="dash-card-label">Net</div><div class="dash-card-value">${v(t?.netCreditsMicro)}</div><div class="dash-card-sub">after the store cut</div></div>
      <div class="dash-card"><div class="dash-card-label">Unpaid</div><div class="dash-card-value">${v(t?.unpaidNetCreditsMicro)}</div><div class="dash-card-sub">awaiting payout</div></div>
      <div class="dash-card"><div class="dash-card-label">Paid out</div><div class="dash-card-value">${v(paidMicro)}</div><div class="dash-card-sub">already paid</div></div>
    </div>`;
}

function payoutsTableHtml(payouts: MktPayout[] | null): string {
  if (!payouts?.length) {
    return `<p class="settings-hint" style="margin:10px 0 0;">No payouts yet — unpaid net credits sweep monthly once they clear your threshold.</p>`;
  }
  const rows = payouts.slice(0, 12).map((p) => `
    <tr>
      <td>${escMkt(mktDate(p.createdAt))}</td>
      <td>${mktCreditsFromMicro(p.amountCreditsMicro)} credits</td>
      <td>${escMkt(p.status)}${p.status === "failed" && p.error ? ` — ${escMkt(p.error)}` : ""}</td>
    </tr>`).join("");
  return `
    <table class="lib-table dev-payouts" style="margin-top:12px;">
      <thead><tr><th>Date</th><th>Amount</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ── Payout connection ─────────────────────────────────────────────────────

/** The Stripe Connect state row — chip + plain-language line + (when there is
 *  something to do) ONE genuine action, seated like "Change avatar…". The
 *  states are the contract's payout shape verbatim: not connected → Connect;
 *  pending → verifying chip + Resume; ready → READY chip + the masked account;
 *  restricted → chip + Fix in Stripe (the same resume link recovers it). */
function payoutConnectionHtml(p: MktProgramState["payout"]): string {
  const masked = p.stripeConnectAccountId ? `<b>${escMkt(p.stripeConnectAccountId)}</b>` : "";
  let chipCls = "mkt-review-chip"; let chipText = ""; let explain = ""; let action = "";
  if (!p.connected) {
    explain = "No Stripe account connected yet — connect one to receive payouts.";
    action = `<button id="dev-stripe-onboard" class="action-btn primary" type="button">Connect with Stripe</button>`;
  } else if (p.payoutStatus === "ready") {
    chipCls += " approved"; chipText = "Ready";
    explain = `Payouts go to ${masked}.`;
  } else if (p.payoutStatus === "restricted") {
    chipCls += " rejected"; chipText = "Restricted";
    explain = `Stripe can't pay ${masked || "this account"} yet — finish the verification they're asking for.`;
    action = `<button id="dev-stripe-onboard" class="action-btn" type="button">Fix in Stripe</button>`;
  } else {
    // connected but not yet confirmed — 'pending' (and 'none' can't be
    // connected, so anything unrecognized reads as still-verifying too).
    chipCls += " in_review"; chipText = "Verifying with Stripe…";
    explain = `${masked ? `${masked} is attached` : "Your account is attached"} — Stripe is confirming it can be paid. This updates here on its own.`;
    action = `<button id="dev-stripe-onboard" class="action-btn" type="button">Resume onboarding</button>`;
  }
  return `
    <div class="dev-status-row" style="margin:0 0 14px;">
      ${chipText ? `<span class="${chipCls}">${chipText}</span>` : ""}
      <span class="settings-hint" style="margin:0;flex:1;">${explain}</span>
      ${action}
    </div>`;
}

/** Earnings + payout connection — the Developer tab's money sections. The
 *  config itself rides on the program state; only the ledger is a fetch. */
async function renderMoney(state: MktProgramState | null, failed: boolean, epoch: number, handle: string | null): Promise<void> {
  const earningsBody = document.getElementById("dev-earnings-body");
  const payoutBody = document.getElementById("dev-payout-body");
  if (!earningsBody || !payoutBody) return;
  const hint = (msg: string): string => `<p class="settings-hint" style="margin:0;">${msg}</p>`;
  if (failed) {
    earningsBody.innerHTML = hint("Earnings are unavailable right now.");
    payoutBody.innerHTML = hint("Payout configuration is unavailable right now.");
    return;
  }
  if (!handle || !state) {
    const msg = handle
      ? "This comes online with the program surface."
      : "This unlocks once you have a profile and are enrolled.";
    earningsBody.innerHTML = hint(msg);
    payoutBody.innerHTML = hint(msg);
    return;
  }
  if (state.status === "none") {
    earningsBody.innerHTML = hint("Earnings unlock once you're enrolled — accept the developer agreement on the Developer Agreement tab.");
    payoutBody.innerHTML = hint("Payout details unlock once you're enrolled.");
    return;
  }

  earningsBody.innerHTML = `<div class="crud-empty">Loading…</div>`;
  let earnings: MktEarningsPage | null = null;
  let payouts: MktPayout[] | null = null;
  try { [earnings, payouts] = await Promise.all([mktProgram.earnings(handle), mktProgram.payouts(handle)]); }
  catch (err) {
    if (epoch !== loadEpoch) return;
    earningsBody.innerHTML = mktNoticeHtml(mktErrorText(err));
    return;
  }
  if (epoch !== loadEpoch) return;

  // Earnings: the Usage page's stat-card grid, history rows right below.
  earningsBody.innerHTML = `${earningsCardsHtml(earnings)}${payoutsTableHtml(payouts)}`;

  // Payout connection: the Stripe state row over the two config fields —
  // Apps → New field grammar, inline validation, autosave (no Save button).
  payoutBody.innerHTML = `
    ${payoutConnectionHtml(state.payout)}
    <div class="acct-row">
      <div class="acct-field acct-field-wide">
        <label class="settings-label" for="dev-payout-account">Stripe Connect account ID</label>
        <input id="dev-payout-account" type="text" class="settings-input" placeholder="acct_… — blank disconnects" spellcheck="false" autocomplete="off" value="${escMkt(state.payout.stripeConnectAccountId || "")}" />
        <span id="dev-payout-account-err" class="settings-error hidden"></span>
        <span class="settings-hint" style="margin:0;">The fallback if you already have a Connect account — onboarding above fills this for you.</span>
      </div>
      <div class="acct-field">
        <label class="settings-label" for="dev-payout-threshold">Payout threshold</label>
        <input id="dev-payout-threshold" type="number" min="1" step="1" class="settings-input" placeholder="1000" value="${state.payout.thresholdCredits}" />
        <span id="dev-payout-threshold-err" class="settings-error hidden"></span>
        <span class="settings-hint" style="margin:0;">Unpaid net credits held until this balance (program default 1000).</span>
      </div>
    </div>`;

  // Connect / Resume / Fix — one genuine action, not a form button: it asks
  // the server for a FRESH Account Link (single-use, so every click re-mints)
  // and opens it through the exact hand-off the developer agreement uses —
  // close the settings modal, then the app's own browser panel. Never an
  // external browser. The webhook flips readiness; refresh re-reads it.
  const onboardBtn = payoutBody.querySelector<HTMLButtonElement>("#dev-stripe-onboard");
  onboardBtn?.addEventListener("click", async () => {
    onboardBtn.disabled = true;
    chip("dev-payout-status", "Contacting Stripe…");
    const res = await mktProgram.startOnboarding(handle);
    if (!res.ok || !res.data) {
      onboardBtn.disabled = false;
      chip("dev-payout-status", "Couldn't start", "error");
      showError(res.ok ? "Stripe didn't return an onboarding link." : res.error);
      return;
    }
    chip("dev-payout-status", "");
    if (!openHostedPage("Stripe onboarding", res.data, openUrlInWorkbench)) {
      chip("dev-payout-status", "Stripe sent a malformed link", "error");
    } else {
      // Watch for the webhook flipping readiness while they're on Stripe's page.
      pollProgramUntilChanged(handle, JSON.stringify(state.payout));
    }
    onboardBtn.disabled = false;
  });

  // No Save button — the fields commit themselves (debounced while typing,
  // at once on blur), only sending what changed, reporting on the Earnings
  // heading's chip. Contract field names: stripeConnectAccountId (null
  // disconnects), payoutThresholdCredits (omitted = unchanged). An INVALID
  // field reports inline and never crosses the wire — the server's zod must
  // be unreachable from typing.
  const accountEl = payoutBody.querySelector<HTMLInputElement>("#dev-payout-account")!;
  const thresholdEl = payoutBody.querySelector<HTMLInputElement>("#dev-payout-threshold")!;
  const accountErr = payoutBody.querySelector<HTMLElement>("#dev-payout-account-err");
  const thresholdErr = payoutBody.querySelector<HTMLElement>("#dev-payout-threshold-err");

  // Blank disconnects; unchanged never re-sends (the field shows the MASKED
  // id — re-sending it untouched would overwrite the real account with the
  // mask); anything else must look like a raw Connect id.
  const accountError = (v: string): string | null =>
    v === "" || v === (state.payout.stripeConnectAccountId || "") || /^acct_[A-Za-z0-9]+$/.test(v)
      ? null : "Stripe Connect IDs look like acct_1ABC… — paste the whole ID.";
  const thresholdError = (v: string): string | null => {
    if (v === "") return null; // unfinished edit — wait, don't nag
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 ? null : "Must be a whole number, at least 1.";
  };

  let timer = 0;
  const save = async (): Promise<void> => {
    const account = accountEl.value.trim();
    const thrRaw = thresholdEl.value.trim();
    const accErr = accountError(account);
    const thrErr = thresholdError(thrRaw);
    fieldError(accountEl, accountErr, accErr);
    fieldError(thresholdEl, thresholdErr, thrErr);
    if (accErr || thrErr) return; // inline only — nothing sent, no banner
    const thr = thrRaw === "" ? null : Number(thrRaw);
    const accountChanged = account !== (state.payout.stripeConnectAccountId || "");
    const thrChanged = thr != null && thr !== state.payout.thresholdCredits;
    if (!accountChanged && !thrChanged) { chip("dev-payout-status", ""); return; }
    chip("dev-payout-status", "Saving…");
    const res = await mktProgram.setPayout(handle, {
      ...(accountChanged ? { stripeConnectAccountId: account || null } : {}),
      ...(thrChanged ? { payoutThresholdCredits: thr! } : {}),
    });
    if (!res.ok) { chip("dev-payout-status", "Not saved", "error"); showError(res.error); return; }
    // Reconcile the snapshot the next dirty-check measures against.
    state.payout.stripeConnectAccountId = account || null;
    if (thrChanged) state.payout.thresholdCredits = thr!;
    chip("dev-payout-status", "Saved", "success");
    // A (dis)connected account changes the connection row (a manual id parks
    // at 'pending' until the webhook confirms) — repaint off the fresh read.
    if (accountChanged) void loadProgramPanes();
  };
  // The account id commits on blur ONLY — a debounce mid-paste would ship a
  // half-typed id (valid-looking prefixes exist). It still validates live.
  accountEl.addEventListener("input", () => fieldError(accountEl, accountErr, accountError(accountEl.value.trim())));
  accountEl.addEventListener("change", () => { window.clearTimeout(timer); void save(); });
  thresholdEl.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => { void save(); }, 700);
  });
  thresholdEl.addEventListener("change", () => { window.clearTimeout(timer); void save(); });
}
