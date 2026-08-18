/**
 * settings-developer.ts — Settings → Developer: the M7 developer program.
 *
 * Four areas on one page:
 *   • Signup — the org/personal developer profile, REUSING the marketplace
 *     console's machinery (renderDeveloperProfiles) rather than duplicating it.
 *   • Legal & consent — the developer agreement (web legal page), the current
 *     version, and the explicit accept-checkbox + button that records consent
 *     (program enrollment). Enrolled orgs see their accepted version/date and
 *     a re-consent prompt when the server reports a newer version.
 *   • Program status — none / enrolled / suspended, in plain language.
 *   • Payout — Stripe Connect config + threshold (both live INSIDE the
 *     program state), the earnings totals, and the payout history.
 *
 * The program is HANDLE-scoped (contract DeveloperProgram): a PROFILE holds
 * enrollment/consent/payout, so the panel resolves the caller's profile first
 * (org over personal — the publisher gate's profile for org apps). mktProgram
 * still resolves null when the SDK bundle in front of us predates the surface
 * — this panel then renders an honest "coming online" state.
 */

import {
  mkt, mktProgram, escMkt, mktDate, mktCreditsFromMicro, mktErrorText, mktNoticeHtml,
  type MktProgramState, type MktEarningsPage, type MktPayout,
} from "./marketplace-data.js";
import { renderDeveloperProfiles, openMktDeveloper } from "./marketplace-dev.js";
import { gotoSection, closeSettingsModal } from "./navigation.js";

const AGREEMENT_URL = "https://glyphh.ai/developer-agreement";

function openExternalUrl(url: string): void {
  const isWeb = !!(window as unknown as { __GLYPHH_WEB__?: boolean }).__GLYPHH_WEB__;
  if (isWeb) window.open(url, "_blank", "noopener");
  else void window.glyphh.openExternal(url);
}

/** The panel's one error surface — the shared marketplace notice banner
 *  (icon + message on a quiet surface), never a raw red text row. */
function showError(msg: string): void {
  const el = document.getElementById("dev-program-error");
  if (!el) return;
  el.innerHTML = mktNoticeHtml(msg);
  el.classList.remove("hidden");
}

// Stale-load guard — the panel refetches on every show and after every write.
let loadEpoch = 0;

export function initDeveloperPanel(): void {
  // The agreement is a WEB legal page — open it outside the app.
  document.getElementById("dev-agreement-link")?.addEventListener("click", (e) => {
    e.preventDefault();
    openExternalUrl(AGREEMENT_URL);
  });
}

export async function loadDeveloperPanel(): Promise<void> {
  const epoch = ++loadEpoch;
  document.getElementById("dev-program-error")?.classList.add("hidden");

  // Signup — the shared M2 profile section (create/edit, avatar, view page).
  const profilesHost = document.getElementById("dev-profiles-host");
  if (profilesHost) {
    void renderDeveloperProfiles(profilesHost, {
      onChange: () => void loadDeveloperPanel(),
      onView: (handle) => {
        // The public profile is a marketplace page — leave Settings for it.
        closeSettingsModal();
        gotoSection("marketplace");
        void openMktDeveloper(handle);
      },
    });
  }

  // The program is HANDLE-scoped — resolve the caller's profile first (org
  // over personal: the publisher gate reads the org profile for org apps).
  // No profile → status "none" with a create-a-profile nudge; profile but no
  // program surface (old SDK bundle) → "coming online".
  let handle: string | null = null;
  let state: MktProgramState | null = null;
  let failed = false;
  try {
    const me = await mkt.devMe();
    handle = me.org?.handle ?? me.personal?.handle ?? null;
    if (handle) state = await mktProgram.state(handle);
  } catch (err) { failed = true; showError(mktErrorText(err)); }
  if (epoch !== loadEpoch) return;

  renderStatus(state, failed, handle);
  renderLegal(state, failed, handle);
  await renderPayout(state, failed, epoch, handle);
}

// ── Program status ────────────────────────────────────────────────────────

function renderStatus(state: MktProgramState | null, failed: boolean, handle: string | null): void {
  const chip = document.getElementById("dev-status-chip");
  const explain = document.getElementById("dev-status-explain");
  if (!chip || !explain) return;
  if (failed) {
    chip.className = "mkt-review-chip";
    chip.textContent = "Unknown";
    explain.textContent = "Couldn't load your program status — see the error above.";
    return;
  }
  if (!handle) {
    chip.className = "mkt-review-chip";
    chip.textContent = "Not enrolled";
    explain.textContent = "You haven't joined the developer program yet. Create a developer profile below, then accept the developer agreement — listing on the marketplace is gated on both.";
    return;
  }
  if (!state) {
    chip.className = "mkt-review-chip";
    chip.textContent = "Coming online";
    explain.textContent = "The developer program is rolling out. Your profile below is live today; enrollment, standing, and payouts light up here the moment the program surface ships.";
    return;
  }
  if (state.status === "enrolled") {
    chip.className = "mkt-review-chip approved";
    chip.textContent = "Enrolled";
    explain.textContent = state.agreement.current
      ? "You're in the developer program — publishing to the marketplace is open to you."
      : "You're enrolled, but the developer agreement has been updated — re-accept it below to keep publishing.";
  } else if (state.status === "suspended") {
    chip.className = "mkt-review-chip rejected";
    chip.textContent = "Suspended";
    explain.textContent = "Your membership is suspended — listings are paused and payouts held. Contact support to resolve it.";
  } else {
    chip.className = "mkt-review-chip";
    chip.textContent = "Not enrolled";
    explain.textContent = "You haven't joined the developer program yet. Accept the developer agreement below — listing on the marketplace is gated on it.";
  }
}

// ── Legal & consent ───────────────────────────────────────────────────────

function renderLegal(state: MktProgramState | null, failed: boolean, handle: string | null): void {
  const body = document.getElementById("dev-legal-body");
  if (!body) return;
  if (failed) {
    body.innerHTML = `<p class="settings-hint" style="margin:0;">Consent status is unavailable right now.</p>`;
    return;
  }
  if (!handle) {
    body.innerHTML = `<p class="settings-hint" style="margin:0;">Create a developer profile above first — enrollment records consent for a specific profile.</p>`;
    return;
  }
  if (!state) {
    body.innerHTML = `<p class="settings-hint" style="margin:0;">Consent recording comes online with the program surface — the agreement itself is ready to read above.</p>`;
    return;
  }

  const { currentVersion, acceptedVersion, acceptedAt, current } = state.agreement;
  const enrolled = state.status !== "none";
  if (enrolled && current) {
    body.innerHTML = `
      <div class="mkt-side-row"><span>Accepted version</span><b>${escMkt(acceptedVersion || "—")}</b></div>
      <div class="mkt-side-row"><span>Accepted on</span><b>${escMkt(mktDate(acceptedAt))}</b></div>`;
    return;
  }

  // Not enrolled, or the agreement moved on since acceptance → (re-)consent.
  // The server only accepts consent to ITS current version, so the button
  // always submits `currentVersion` verbatim.
  const reconsent = enrolled && !current;
  body.innerHTML = `
    ${reconsent ? `<p class="settings-hint" style="margin:0 0 10px;color:var(--accent);">The developer agreement has been updated${acceptedVersion ? ` — you accepted ${escMkt(acceptedVersion)}` : ""}. Review and accept version ${escMkt(currentVersion)} to keep publishing.</p>` : ""}
    <div class="mkt-side-row"><span>Current version</span><b>${escMkt(currentVersion)}</b></div>
    <label class="settings-toggle" style="margin:10px 0;">
      <input type="checkbox" id="dev-consent-check" />
      <span class="toggle-switch"></span>
      I have read and agree to the Glyphh Developer Agreement (${escMkt(currentVersion)})
    </label>
    <div class="settings-actions" style="display:flex;gap:8px;align-items:center;">
      <span id="dev-consent-status" style="flex:1;font-size:12px;color:var(--text-3);"></span>
      <button id="dev-consent-btn" class="action-btn primary" type="button" disabled>${reconsent ? "Accept updated agreement" : "Accept &amp; enroll"}</button>
    </div>`;

  const check = body.querySelector<HTMLInputElement>("#dev-consent-check");
  const btn = body.querySelector<HTMLButtonElement>("#dev-consent-btn");
  const status = body.querySelector<HTMLElement>("#dev-consent-status");
  if (!check || !btn) return;
  check.addEventListener("change", () => { btn.disabled = !check.checked; });
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    if (status) status.textContent = reconsent ? "Recording consent…" : "Enrolling…";
    const res = await mktProgram.enroll(handle, currentVersion);
    if (res.ok) { void loadDeveloperPanel(); return; }
    btn.disabled = !check.checked;
    if (status) status.textContent = "";
    showError(res.error);
  });
}

// ── Payout ────────────────────────────────────────────────────────────────

function earningsHtml(e: MktEarningsPage): string {
  const t = e.totals;
  return `
    <label class="settings-label" style="margin-top:16px;">Earnings</label>
    <div class="dash-grid">
      <div class="dash-card"><div class="dash-card-label">Gross</div><div class="dash-card-value">${mktCreditsFromMicro(t.grossCreditsMicro)}</div><div class="dash-card-sub">earned credits</div></div>
      <div class="dash-card"><div class="dash-card-label">Net</div><div class="dash-card-value">${mktCreditsFromMicro(t.netCreditsMicro)}</div><div class="dash-card-sub">after the store cut</div></div>
      <div class="dash-card"><div class="dash-card-label">Unpaid</div><div class="dash-card-value">${mktCreditsFromMicro(t.unpaidNetCreditsMicro)}</div><div class="dash-card-sub">awaiting payout</div></div>
    </div>`;
}

function payoutsHtml(payouts: MktPayout[]): string {
  if (!payouts.length) return "";
  const rows = payouts.slice(0, 10).map((p) => `
    <div class="mkt-side-row">
      <span>${escMkt(mktDate(p.createdAt))}</span>
      <b>${mktCreditsFromMicro(p.amountCreditsMicro)} credits — ${escMkt(p.status)}${p.status === "failed" && p.error ? ` (${escMkt(p.error)})` : ""}</b>
    </div>`).join("");
  return `<label class="settings-label" style="margin-top:16px;">Payouts</label>${rows}`;
}

async function renderPayout(state: MktProgramState | null, failed: boolean, epoch: number, handle: string | null): Promise<void> {
  const body = document.getElementById("dev-payout-body");
  if (!body) return;
  if (failed) {
    body.innerHTML = `<p class="settings-hint" style="margin:0;">Payout configuration is unavailable right now.</p>`;
    return;
  }
  if (!handle || !state) {
    body.innerHTML = `<p class="settings-hint" style="margin:0;">${handle ? "Payout configuration comes online with the program surface." : "Payout details unlock once you have a profile and are enrolled."}</p>`;
    return;
  }
  if (state.status === "none") {
    body.innerHTML = `<p class="settings-hint" style="margin:0;">Payout details unlock once you're enrolled.</p>`;
    return;
  }

  // The config itself rides on the program state; only the ledger is a fetch.
  body.innerHTML = `<div class="crud-empty">Loading…</div>`;
  let earnings: MktEarningsPage | null = null;
  let payouts: MktPayout[] | null = null;
  try { [earnings, payouts] = await Promise.all([mktProgram.earnings(handle), mktProgram.payouts(handle)]); }
  catch (err) {
    if (epoch !== loadEpoch) return;
    body.innerHTML = mktNoticeHtml(mktErrorText(err));
    return;
  }
  if (epoch !== loadEpoch) return;

  body.innerHTML = `
    <label class="settings-label">Stripe Connect account ID</label>
    <input id="dev-payout-account" class="settings-input" placeholder="acct_…" spellcheck="false" autocomplete="off" value="${escMkt(state.payout.stripeConnectAccountId || "")}" />
    <label class="settings-label">Payout threshold <span style="color:var(--text-2);font-weight:400;">— unpaid net credits held until this balance; blank keeps the current setting (program default 1000)</span></label>
    <input id="dev-payout-threshold" class="settings-input" type="number" min="1" step="1" placeholder="1000" value="${state.payout.thresholdCredits}" />
    <div class="settings-actions" style="margin-top:10px;display:flex;gap:8px;align-items:center;">
      <span id="dev-payout-status" style="flex:1;font-size:12px;color:var(--text-3);"></span>
      <button id="dev-payout-save" class="action-btn primary" type="button">Save payout details</button>
    </div>
    ${earnings ? earningsHtml(earnings) : ""}
    ${payouts ? payoutsHtml(payouts) : ""}`;

  body.querySelector("#dev-payout-save")?.addEventListener("click", async () => {
    const account = (body.querySelector("#dev-payout-account") as HTMLInputElement | null)?.value.trim() ?? "";
    const thrRaw = (body.querySelector("#dev-payout-threshold") as HTMLInputElement | null)?.value.trim() ?? "";
    const thr = thrRaw === "" ? null : Number(thrRaw);
    const status = body.querySelector<HTMLElement>("#dev-payout-status");
    if (thr != null && (!Number.isInteger(thr) || thr < 1)) {
      if (status) status.textContent = "The threshold must be a whole number, at least 1.";
      return;
    }
    if (status) status.textContent = "Saving…";
    // Contract field names: stripeConnectAccountId (null disconnects) and
    // payoutThresholdCredits (omitted = unchanged — the server COALESCEs).
    const res = await mktProgram.setPayout(handle, {
      stripeConnectAccountId: account || null,
      ...(thr == null ? {} : { payoutThresholdCredits: thr }),
    });
    if (status) status.textContent = res.ok ? "Saved ✓" : "";
    if (!res.ok) showError(res.error);
  });
}
