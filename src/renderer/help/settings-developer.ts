/**
 * settings-developer.ts — Settings → Developer: the M7 developer program.
 *
 * Four areas on one page:
 *   • Signup — the org/personal developer profile, REUSING the marketplace
 *     console's machinery (renderDeveloperProfiles) rather than duplicating it.
 *   • Legal & consent — the developer agreement (a hosted legal page opened
 *     in the app's own browser panel), the current version, and the consent
 *     checkbox that commits on check (program enrollment) like any other
 *     settings toggle. Enrolled orgs see their accepted version/date and a
 *     re-consent prompt when the server reports a newer version.
 *   • Program status — none / enrolled / suspended, in plain language.
 *   • Payout — Stripe Connect onboarding state (connect / verifying / ready /
 *     restricted, all read off the program state; readiness is webhook-driven
 *     server-side so a re-read is the whole refresh), the manual account-id
 *     fallback + threshold, the earnings totals, and the payout history.
 *     Connect/Resume are genuine actions (like "Change avatar…"), and the
 *     hosted onboarding opens in the app's own browser panel — the same
 *     in-app hand-off as the developer agreement, never an external browser.
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
import { openHostedPage } from "./settings-api.js";
import { openUrlInWorkbench } from "./code.js";

const AGREEMENT_URL = "https://glyphh.ai/developer-agreement";

/** The panel's one error surface — the shared marketplace notice banner
 *  (icon + message on a quiet surface), never a raw red text row. */
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

// Stale-load guard — the panel refetches on every show and after every write.
let loadEpoch = 0;

export function initDeveloperPanel(): void {
  // The agreement is a hosted legal page but it never leaves the app: the
  // same in-app hand-off the billing pages use (a workbench browser panel on
  // desktop, a tab on web) — the settings modal closes so the panel is seen.
  document.getElementById("dev-agreement-link")?.addEventListener("click", (e) => {
    e.preventDefault();
    closeSettingsModal();
    openHostedPage("Developer agreement", AGREEMENT_URL, openUrlInWorkbench);
  });

  // Payout-heading refresh: readiness flips server-side (Stripe's webhook), so
  // "check again" is just a fresh program read — the same full-panel reload
  // every write already does. The spin stops when the newest load lands.
  document.getElementById("dev-payout-refresh")?.addEventListener("click", () => {
    document.getElementById("dev-payout-refresh")?.classList.add("spinning");
    void loadDeveloperPanel();
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
  document.getElementById("dev-payout-refresh")?.classList.remove("spinning");
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
  // The CHECKBOX is the commit, like every other settings toggle: checking it
  // records consent to the server's current version and enrolls, reporting on
  // the section heading's chip. No button row.
  const reconsent = enrolled && !current;
  body.innerHTML = `
    ${reconsent ? `<p class="settings-hint" style="margin:0 0 10px;color:var(--accent);">The developer agreement has been updated${acceptedVersion ? ` — you accepted ${escMkt(acceptedVersion)}` : ""}. Review and accept version ${escMkt(currentVersion)} to keep publishing.</p>` : ""}
    <div class="mkt-side-row"><span>Current version</span><b>${escMkt(currentVersion)}</b></div>
    <label class="settings-toggle" style="margin:10px 0 0;">
      <input type="checkbox" id="dev-consent-check" />
      <span class="toggle-switch"></span>
      I have read and agree to the Glyphh Developer Agreement (${escMkt(currentVersion)})${reconsent ? "" : " — checking enrolls you in the developer program"}
    </label>`;

  const check = body.querySelector<HTMLInputElement>("#dev-consent-check");
  check?.addEventListener("change", async () => {
    if (!check.checked) return; // nothing recorded yet — unchecking is a no-op
    check.disabled = true;
    chip("dev-legal-status", reconsent ? "Recording consent…" : "Enrolling…");
    const res = await mktProgram.enroll(handle, currentVersion);
    if (res.ok) {
      chip("dev-legal-status", reconsent ? "Consent recorded" : "Enrolled", "success");
      void loadDeveloperPanel();
      return;
    }
    check.checked = false;
    check.disabled = false;
    chip("dev-legal-status", "Not saved", "error");
    showError(res.error);
  });
}

// ── Payout ────────────────────────────────────────────────────────────────

function earningsHtml(e: MktEarningsPage): string {
  const t = e.totals;
  return `
    <h4 class="acct-row-head" style="margin-top:16px;">Earnings</h4>
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
  return `<h4 class="acct-row-head" style="margin-top:16px;">Payouts</h4>${rows}`;
}

/** The Stripe Connect state row — chip + plain-language line + (when there is
 *  something to do) ONE genuine action, seated like "Change avatar…". The
 *  states are the contract's payout shape verbatim: not connected → Connect;
 *  pending → verifying chip + Resume; ready → READY chip + the masked account;
 *  restricted → chip + Fix in Stripe (the same resume link recovers it). */
function payoutConnectionHtml(p: MktProgramState["payout"]): string {
  const masked = p.stripeConnectAccountId ? `<b>${escMkt(p.stripeConnectAccountId)}</b>` : "";
  let chipCls = "mkt-review-chip"; let chipText = ""; let explain = ""; let action = "";
  if (!p.connected) {
    explain = "No Stripe account connected yet — connect one to receive payouts. Stripe collects your details on their hosted page; they never touch Glyphh.";
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
    ${payoutConnectionHtml(state.payout)}
    <div class="acct-row">
      <div class="acct-field acct-field-wide">
        <label class="settings-label" for="dev-payout-account">Stripe Connect account ID</label>
        <input id="dev-payout-account" type="text" class="settings-input" placeholder="acct_… — blank disconnects" spellcheck="false" autocomplete="off" value="${escMkt(state.payout.stripeConnectAccountId || "")}" />
        <span class="settings-hint" style="margin:0;">The fallback if you already have a Connect account — onboarding above fills this for you.</span>
      </div>
      <div class="acct-field">
        <label class="settings-label" for="dev-payout-threshold">Payout threshold</label>
        <input id="dev-payout-threshold" type="number" min="1" step="1" class="settings-input" placeholder="1000" value="${state.payout.thresholdCredits}" />
        <span class="settings-hint" style="margin:0;">Unpaid net credits held until this balance (program default 1000).</span>
      </div>
    </div>
    ${earnings ? earningsHtml(earnings) : ""}
    ${payouts ? payoutsHtml(payouts) : ""}`;

  // Connect / Resume / Fix — one genuine action, not a form button: it asks
  // the server for a FRESH Account Link (single-use, so every click re-mints)
  // and opens it through the exact hand-off the developer agreement uses —
  // close the settings modal, then the app's own browser panel. Never an
  // external browser. The webhook flips readiness; refresh re-reads it.
  const onboardBtn = body.querySelector<HTMLButtonElement>("#dev-stripe-onboard");
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
    closeSettingsModal();
    if (!openHostedPage("Stripe onboarding", res.data, openUrlInWorkbench)) {
      chip("dev-payout-status", "Stripe sent a malformed link", "error");
    }
    onboardBtn.disabled = false;
  });

  // No Save button — the fields commit themselves (debounced while typing,
  // at once on blur), only sending what changed, reporting on the Payout
  // heading's chip. Contract field names: stripeConnectAccountId (null
  // disconnects), payoutThresholdCredits (omitted = unchanged).
  let timer = 0;
  const save = async (): Promise<void> => {
    const account = (body.querySelector("#dev-payout-account") as HTMLInputElement | null)?.value.trim() ?? "";
    const thrRaw = (body.querySelector("#dev-payout-threshold") as HTMLInputElement | null)?.value.trim() ?? "";
    const thr = thrRaw === "" ? null : Number(thrRaw);
    if (thr != null && (!Number.isInteger(thr) || thr < 1)) {
      chip("dev-payout-status", "Threshold must be a whole number, at least 1", "error");
      return;
    }
    const accountChanged = account !== (state.payout.stripeConnectAccountId || "");
    const thrChanged = thr != null && thr !== state.payout.thresholdCredits;
    if (!accountChanged && !thrChanged) { chip("dev-payout-status", ""); return; }
    chip("dev-payout-status", "Saving…");
    // Only send what changed: the field shows the MASKED id ("acct_…1234"),
    // so re-sending it untouched would overwrite the real account with the
    // mask. An edited value is a raw acct_… (the manual fallback) or blank
    // (null disconnects) — those are the only times the account crosses.
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
    if (accountChanged) void loadDeveloperPanel();
  };
  for (const id of ["dev-payout-account", "dev-payout-threshold"]) {
    const el = body.querySelector<HTMLElement>(`#${id}`);
    el?.addEventListener("input", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { void save(); }, 700);
    });
    el?.addEventListener("change", () => { window.clearTimeout(timer); void save(); });
  }
}
