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
 *   • Payout — Stripe Connect config + threshold, and the earnings rollup
 *     (accrued / net / paid) when the SDK exposes it.
 *
 * The program/payout SDK surface SHIPS SEPARATELY (sdk marketplace branch);
 * every read goes through mktProgram, which feature-detects the methods and
 * resolves null until they land — this panel then renders an honest "coming
 * online" state. The profile machinery (M2) is live today either way.
 */

import {
  mktProgram, escMkt, mktDate,
  type MktProgramState, type MktPayoutConfig, type MktEarnings,
} from "./marketplace-data.js";
import { renderDeveloperProfiles, openMktDeveloper } from "./marketplace-dev.js";
import { gotoSection, closeSettingsModal } from "./navigation.js";

const AGREEMENT_URL = "https://glyphh.ai/developer-agreement";

const errText = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)) || "Request failed";

function openExternalUrl(url: string): void {
  const isWeb = !!(window as unknown as { __GLYPHH_WEB__?: boolean }).__GLYPHH_WEB__;
  if (isWeb) window.open(url, "_blank", "noopener");
  else void window.glyphh.openExternal(url);
}

function showError(msg: string): void {
  const el = document.getElementById("dev-program-error");
  if (!el) return;
  el.textContent = msg;
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

  // Program state — null means the surface hasn't shipped ("coming online").
  let state: MktProgramState | null = null;
  let failed = false;
  try { state = await mktProgram.state(); }
  catch (err) { failed = true; showError(errText(err)); }
  if (epoch !== loadEpoch) return;

  renderStatus(state, failed);
  renderLegal(state, failed);
  await renderPayout(state, failed, epoch);
}

// ── Program status ────────────────────────────────────────────────────────

function renderStatus(state: MktProgramState | null, failed: boolean): void {
  const chip = document.getElementById("dev-status-chip");
  const explain = document.getElementById("dev-status-explain");
  if (!chip || !explain) return;
  if (failed) {
    chip.className = "mkt-review-chip";
    chip.textContent = "Unknown";
    explain.textContent = "Couldn't load your program status — see the error above.";
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
    explain.textContent = "You're in the developer program — publishing to the marketplace is open to you.";
  } else if (state.status === "suspended") {
    chip.className = "mkt-review-chip rejected";
    chip.textContent = "Suspended";
    explain.textContent = state.suspendedReason
      ? `Your membership is suspended (${state.suspendedReason}). Listings are paused and payouts held — contact support to resolve it.`
      : "Your membership is suspended — listings are paused and payouts held. Contact support to resolve it.";
  } else {
    chip.className = "mkt-review-chip";
    chip.textContent = "Not enrolled";
    explain.textContent = "You haven't joined the developer program yet. Create a profile and accept the developer agreement below — listing on the marketplace is gated on both.";
  }
}

// ── Legal & consent ───────────────────────────────────────────────────────

function renderLegal(state: MktProgramState | null, failed: boolean): void {
  const body = document.getElementById("dev-legal-body");
  if (!body) return;
  if (failed) {
    body.innerHTML = `<p class="settings-hint" style="margin:0;">Consent status is unavailable right now.</p>`;
    return;
  }
  if (!state) {
    body.innerHTML = `<p class="settings-hint" style="margin:0;">Consent recording comes online with the program surface — the agreement itself is ready to read above.</p>`;
    return;
  }

  const current = state.currentVersion;
  const enrolled = state.status !== "none";
  const upToDate = enrolled && (!current || state.acceptedVersion === current);
  if (upToDate) {
    body.innerHTML = `
      <div class="mkt-side-row"><span>Accepted version</span><b>${escMkt(state.acceptedVersion || "—")}</b></div>
      <div class="mkt-side-row"><span>Accepted on</span><b>${escMkt(mktDate(state.acceptedAt))}</b></div>`;
    return;
  }

  // Not enrolled, or the agreement moved on since acceptance → (re-)consent.
  const reconsent = enrolled && !upToDate;
  body.innerHTML = `
    ${reconsent ? `<p class="settings-hint" style="margin:0 0 10px;color:var(--accent);">The developer agreement has been updated${state.acceptedVersion ? ` — you accepted ${escMkt(state.acceptedVersion)}` : ""}. Review and accept ${current ? `version ${escMkt(current)}` : "the new version"} to keep publishing.</p>` : ""}
    ${current ? `<div class="mkt-side-row"><span>Current version</span><b>${escMkt(current)}</b></div>` : ""}
    <label class="settings-toggle" style="margin:10px 0;">
      <input type="checkbox" id="dev-consent-check" />
      <span class="toggle-switch"></span>
      I have read and agree to the Glyphh Developer Agreement${current ? ` (${escMkt(current)})` : ""}
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
    const res = await mktProgram.enroll(current);
    if (res.ok) { void loadDeveloperPanel(); return; }
    btn.disabled = !check.checked;
    if (status) status.textContent = "";
    showError(res.error);
  });
}

// ── Payout ────────────────────────────────────────────────────────────────

function earningsHtml(e: MktEarnings): string {
  const fmt = (n: number) => n.toLocaleString();
  return `
    <label class="settings-label" style="margin-top:16px;">Earnings</label>
    <div class="dash-grid">
      <div class="dash-card"><div class="dash-card-label">Accrued</div><div class="dash-card-value">${fmt(e.accruedCredits)}</div><div class="dash-card-sub">earned credits</div></div>
      <div class="dash-card"><div class="dash-card-label">Net</div><div class="dash-card-value">${fmt(e.netCredits)}</div><div class="dash-card-sub">after the store cut</div></div>
      <div class="dash-card"><div class="dash-card-label">Paid out</div><div class="dash-card-value">${fmt(e.paidCredits)}</div><div class="dash-card-sub">via Stripe Connect</div></div>
    </div>`;
}

async function renderPayout(state: MktProgramState | null, failed: boolean, epoch: number): Promise<void> {
  const body = document.getElementById("dev-payout-body");
  if (!body) return;
  if (failed) {
    body.innerHTML = `<p class="settings-hint" style="margin:0;">Payout configuration is unavailable right now.</p>`;
    return;
  }
  if (!state) {
    body.innerHTML = `<p class="settings-hint" style="margin:0;">Payout configuration comes online with the program surface.</p>`;
    return;
  }
  if (state.status === "none") {
    body.innerHTML = `<p class="settings-hint" style="margin:0;">Payout details unlock once you're enrolled.</p>`;
    return;
  }

  body.innerHTML = `<div class="crud-empty">Loading…</div>`;
  let config: MktPayoutConfig | null = null;
  let earnings: MktEarnings | null = null;
  try { [config, earnings] = await Promise.all([mktProgram.payout(), mktProgram.earnings()]); }
  catch (err) {
    if (epoch !== loadEpoch) return;
    body.innerHTML = `<div class="crud-form-error">${escMkt(errText(err))}</div>`;
    return;
  }
  if (epoch !== loadEpoch) return;

  body.innerHTML = `
    ${config?.connectUrl ? `<button id="dev-stripe-connect" class="action-btn primary" type="button" style="margin-bottom:12px;">Connect with Stripe</button>` : ""}
    <label class="settings-label">Stripe account ID</label>
    <input id="dev-payout-account" class="settings-input" placeholder="acct_…" spellcheck="false" autocomplete="off" value="${escMkt(config?.stripeAccountId || "")}" />
    <label class="settings-label">Payout threshold <span style="color:var(--text-2);font-weight:400;">— earned credits held until this balance; blank = the program default</span></label>
    <input id="dev-payout-threshold" class="settings-input" type="number" min="0" step="1" value="${config?.thresholdCredits ?? ""}" />
    <div class="settings-actions" style="margin-top:10px;display:flex;gap:8px;align-items:center;">
      <span id="dev-payout-status" style="flex:1;font-size:12px;color:var(--text-3);"></span>
      <button id="dev-payout-save" class="action-btn primary" type="button">Save payout details</button>
    </div>
    ${earnings ? earningsHtml(earnings) : ""}`;

  // Server-minted Stripe Connect onboarding, when the SDK hands us the link.
  const connectUrl = config?.connectUrl;
  if (connectUrl) {
    body.querySelector("#dev-stripe-connect")?.addEventListener("click", () => openExternalUrl(connectUrl));
  }

  body.querySelector("#dev-payout-save")?.addEventListener("click", async () => {
    const account = (body.querySelector("#dev-payout-account") as HTMLInputElement | null)?.value.trim() ?? "";
    const thrRaw = (body.querySelector("#dev-payout-threshold") as HTMLInputElement | null)?.value.trim() ?? "";
    const thr = thrRaw === "" ? null : Number(thrRaw);
    const status = body.querySelector<HTMLElement>("#dev-payout-status");
    if (thr != null && (!Number.isFinite(thr) || thr < 0)) {
      if (status) status.textContent = "The threshold must be 0 or more.";
      return;
    }
    if (status) status.textContent = "Saving…";
    const res = await mktProgram.setPayout({
      stripeAccountId: account || null,
      thresholdCredits: thr == null ? null : Math.round(thr),
    });
    if (status) status.textContent = res.ok ? "Saved ✓" : "";
    if (!res.ok) showError(res.error);
  });
}
