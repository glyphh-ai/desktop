/**
 * Boot gate — splash screen, CC bootstrap modal, and first-time tutorial.
 *
 * Extracted from renderer.ts. All DOM queries happen internally; the caller
 * supplies callbacks so the module can drive panel visibility, theme changes,
 * and onboarding without importing renderer internals.
 */

type TabInfo = { id: string; name: string; favicon?: string; layoutFavicons?: string[]; pinned?: boolean; url?: string };

export interface BootGateCallbacks {
  /** Called once the splash dismisses and the app is ready to interact. */
  onBootReady: (data: BootData) => void;
  showPanels: () => void;
  hidePanels: () => void;
  applyTheme: (theme: string) => void;
  showOnboarding: (requiresAuth: boolean) => void;
}

export interface BootData {
  authenticated: boolean;
  status: string;
  tier?: string;
  needsOnboarding: boolean;
  hideWelcome?: boolean;
  theme?: string;
}

// ── Internal state ──────────────────────────────────────────────────────────

const splashShownAt = Date.now();
const SPLASH_MIN_MS = 1800;
let booted = false;
let bootData: BootData | null = null;
let tutorialShowing = false;
let ccModalShowing = false;

// ── Update gate ─────────────────────────────────────────────────────────────
// Hold the splash while an update downloads so the user is never dropped into
// the app mid-update. Released once the download finishes (or on error/cap).
type UpdateVerdict = "pending" | "clear" | "downloading" | "done";
const UPDATE_VERDICT_GRACE_MS = 4000;     // max wait for the update check to report in
const UPDATE_DOWNLOAD_CAP_MS = 120_000;   // max time to hold the splash for a download
let updateVerdict: UpdateVerdict = "pending";
let dismissRequested = false;
let splashRemoved = false;
// Set once the main process commits to auto-installing a downloaded update and
// restarting. The splash must then stay up (showing a stand-by message) so the
// user never gets dropped into the workspace for the instant before the restart.
let restarting = false;
let pendingGraceTimer: ReturnType<typeof setTimeout> | null = null;
let downloadCapTimer: ReturnType<typeof setTimeout> | null = null;

/** Expose read-only accessors so renderer can check state if needed. */
export function isBooted(): boolean { return booted; }
export function isTutorialShowing(): boolean { return tutorialShowing; }
export function isCcModalShowing(): boolean { return ccModalShowing; }

// The callbacks captured at initBootGate(), so the WEB boot (web/src/web-boot.js)
// can drive first-run itself instead of the desktop `hasSeenTutorial` path.
let bootCb: BootGateCallbacks | null = null;

/** WEB-ONLY: the web boot decides first-run from the SERVER's per-user `regionChosen`
 *  (see web-boot.js), NOT the per-device `hasSeenTutorial` prefs stub. It then calls
 *  one of these to either show the first-time tutorial for a new user, or just reveal
 *  the workspace for a returning one. No-ops on desktop / before initBootGate.
 *
 *  `onComplete` runs when the tutorial is dismissed — the web boot uses it to navigate
 *  to the home.html Chat front door (the real DOM landing on web; the native-panel
 *  workspace is empty in a browser). `webEnterApp` is the returning-user path, which
 *  navigates straight there via the same callback. */
export function webShowFirstRun(onComplete?: () => void): void {
  if (bootCb) showTutorial(bootCb, onComplete);
}
export function webEnterApp(onComplete?: () => void): void {
  if (bootCb) bootCb.showPanels();
  onComplete?.();
}

// ── Tutorial ────────────────────────────────────────────────────────────────

// Tutorial steps (sections/tutorial.html): Connections → Apps → Loops →
// Layouts → Command center. Visual steps (icon + copy) — the count drives
// the dots and the final "Get Started" button.
const TUTORIAL_STEPS = 5;

function showTutorial(cb: BootGateCallbacks, onWebComplete?: () => void): void {
  tutorialShowing = true;
  const overlay = document.getElementById("tutorial-overlay")!;
  overlay.classList.remove("hidden");
  // BrowserViews are native — they paint over HTML. Hide them so tutorial is visible.
  cb.hidePanels();
  let step = 0;

  function goToStep(idx: number) {
    step = idx;
    overlay.querySelectorAll(".tutorial-step").forEach((s, i) => {
      s.classList.toggle("active", i === idx);
    });
    overlay.querySelectorAll(".tutorial-nav-dot").forEach((d, i) => {
      d.classList.toggle("active", i === idx);
    });

    const nextBtn = document.getElementById("tutorial-next") as HTMLButtonElement;
    nextBtn.textContent = idx === TUTORIAL_STEPS - 1 ? "Get Started" : "Next";
  }

  document.getElementById("tutorial-next")!.addEventListener("click", () => {
    if (step < TUTORIAL_STEPS - 1) {
      goToStep(step + 1);
    } else {
      closeTutorial();
    }
  });

  document.getElementById("tutorial-close")!.addEventListener("click", closeTutorial);

  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeTutorial();
  });

  function closeTutorial() {
    tutorialShowing = false;
    window.glyphh.setPreference("hasSeenTutorial", true);
    overlay.classList.add("hidden");
    // Restore panels now that tutorial is dismissed
    cb.showPanels();
    // WEB: the native-panel workspace is empty in a browser — the real Chat front
    // door is home.html. Hand off to the web boot's completer (→ navigate to /home)
    // instead of the desktop homeGotoSection IPC. Desktop passes no callback and
    // takes the original path below, byte-identical.
    if ((window as unknown as { __GLYPHH_WEB__?: boolean }).__GLYPHH_WEB__) {
      onWebComplete?.();
      return;
    }
    // First run ends at HOME — the dashboard's starters and schedule are the
    // natural next step, not whatever section the panel restored to.
    void (window.glyphh as unknown as { homeGotoSection?: (s: string) => Promise<unknown> }).homeGotoSection?.("agent");
  }

  // Start first step
  goToStep(0);
}

// The CC-bootstrap / BYOK key modal is gone: Glyphh has no in-app agent and
// stores no LLM keys. Apps bring their own keys via per-app Config Vars.

// ── Splash dismiss ──────────────────────────────────────────────────────────

/** Paint the update progress bar onto the splash. */
function setSplashUpdate(percent: number, label: string): void {
  const wrap = document.getElementById("splash-update");
  const fill = document.getElementById("splash-update-fill");
  const lbl = document.getElementById("splash-update-label");
  const status = document.getElementById("splash-status");
  if (wrap) wrap.classList.remove("hidden");
  if (status) status.classList.add("hidden");
  if (fill) fill.style.width = `${Math.max(0, Math.min(100, Math.round(percent)))}%`;
  if (lbl && label) lbl.textContent = label;
}

/** Actually fade out and remove the splash. Idempotent. */
function finishSplash(cb: BootGateCallbacks): void {
  if (splashRemoved) return;
  // A restart is imminent — keep the splash up rather than flashing the app.
  if (restarting) return;
  splashRemoved = true;
  if (pendingGraceTimer) { clearTimeout(pendingGraceTimer); pendingGraceTimer = null; }
  if (downloadCapTimer) { clearTimeout(downloadCapTimer); downloadCapTimer = null; }
  // Show panels first (behind splash z-index:9999) so they're ready when splash fades.
  // BUT not if tutorial / CC modal / lockout gate / login overlay is up — BrowserViews paint
  // over HTML overlays. (Panels survive a renderer reload in the main process, so after a
  // logout-and-reload from the lockout screen we must NOT re-attach them over the login.)
  if (!tutorialShowing && !ccModalShowing && !accountLocked && !bootData?.needsOnboarding) cb.showPanels();
  const splash = document.getElementById("splash");
  if (splash) {
    splash.classList.add("fade-out");
    setTimeout(() => splash.remove(), 600);
  }
  if (bootData?.needsOnboarding) {
    cb.showOnboarding(!bootData.authenticated);
  }
}

/**
 * Decide whether the splash can come down yet. Boot must be ready AND no
 * update may be in flight. While an update is downloading the splash is held
 * (the update-status handler re-calls this once the download resolves); while
 * the update check verdict is still pending we wait out a short grace period.
 */
function scheduleSplashFinish(cb: BootGateCallbacks): void {
  if (splashRemoved || !dismissRequested) return;
  if (updateVerdict === "downloading") return; // held — released by onUpdateStatus
  if (updateVerdict === "pending") {
    if (!pendingGraceTimer) {
      pendingGraceTimer = setTimeout(() => {
        pendingGraceTimer = null;
        if (updateVerdict === "pending") updateVerdict = "clear";
        scheduleSplashFinish(cb);
      }, UPDATE_VERDICT_GRACE_MS);
    }
    return;
  }
  // verdict is "clear" or "done" — dismiss after the minimum splash time.
  const elapsed = Date.now() - splashShownAt;
  setTimeout(() => finishSplash(cb), Math.max(0, SPLASH_MIN_MS - elapsed));
}

function dismissSplash(cb: BootGateCallbacks): void {
  if (!booted || dismissRequested) return;
  dismissRequested = true;
  scheduleSplashFinish(cb);
}

// ── Account lockout (admin-disabled account) ────────────────────────────────

let accountLocked = false;
let manageUrl = `${window.glyphh.platformUrl}/billing`;

/** Raise the full-window lockout gate. The user keeps the titlebar (so they
 *  can quit) but everything else is sealed until the account is active. */
function showLockout(cb: BootGateCallbacks, info?: { status?: string; upgradeUrl?: string }): void {
  accountLocked = true;
  if (info?.upgradeUrl) manageUrl = info.upgradeUrl;

  // Seal the workspace: panels are native BrowserViews that paint over HTML,
  // so they must be hidden for the overlay to actually cover anything.
  cb.hidePanels();

  // The lockout overlay starts below the 38px titlebar (so window controls stay
  // clickable). That leaves the titlebar's workspace chrome — tab strip, the "+"
  // add-app button, rail toggles, downloads — visible and interactive above the
  // overlay. Seal them too; styles.css hides them while body.account-locked.
  document.body.classList.add("account-locked");

  // A locked account never sees onboarding or the tutorial.
  document.getElementById("onboarding-overlay")?.classList.add("hidden");
  document.getElementById("tutorial-overlay")?.classList.add("hidden");

  const titleEl = document.getElementById("lockout-title");
  const msgEl = document.getElementById("lockout-message");
  if (titleEl) titleEl.textContent = "Your account is inactive";
  if (msgEl) {
    msgEl.textContent =
      "This account has been deactivated. Reactivate your plan to get back into your workspace — your data is safe.";
  }
  const statusEl = document.getElementById("lockout-status");
  if (statusEl) statusEl.textContent = "";
  document.getElementById("lockout-overlay")?.classList.remove("hidden");
}

/** Account is active again — drop the gate and reveal the workspace. */
function hideLockout(cb: BootGateCallbacks): void {
  accountLocked = false;
  document.body.classList.remove("account-locked");
  document.getElementById("lockout-overlay")?.classList.add("hidden");
  cb.showPanels();
}

// ── Public init ─────────────────────────────────────────────────────────────

/**
 * Wire up all boot-gate IPC listeners and kick off the splash / tutorial /
 * CC-bootstrap flow. Call once from renderer.ts at module scope.
 */
export function initBootGate(cb: BootGateCallbacks): void {
  // Captured so the WEB boot's first-run driver (webShowFirstRun / webEnterApp) can
  // reuse the same panel/tutorial callbacks. Desktop ignores this.
  bootCb = cb;
  // Config sync status during boot
  (window as any).glyphh.onSplashStatus?.((msg: string) => {
    const el = document.getElementById("splash-status");
    if (el) {
      el.textContent = msg;
      if (msg === "ready") el.classList.add("done");
      else el.classList.remove("done");
    }
  });

  // Update gate — surface a progress bar on the splash and hold it while an
  // update downloads. Wired before onBoot so events that arrive early count.
  window.glyphh.onUpdateStatus((info) => {
    if (info.status === "available" || info.status === "downloading") {
      updateVerdict = "downloading";
      if (pendingGraceTimer) { clearTimeout(pendingGraceTimer); pendingGraceTimer = null; }
      const pct = info.percent ?? 0;
      setSplashUpdate(
        pct,
        info.status === "available"
          ? `Downloading update${info.version ? ` v${info.version}` : ""}…`
          : `Downloading update… ${Math.round(pct)}%`,
      );
      // Never trap the user on the splash if a download stalls.
      if (!downloadCapTimer) {
        downloadCapTimer = setTimeout(() => {
          downloadCapTimer = null;
          if (updateVerdict === "downloading") updateVerdict = "done";
          scheduleSplashFinish(cb);
        }, UPDATE_DOWNLOAD_CAP_MS);
      }
    } else if (info.status === "ready") {
      updateVerdict = "done";
      setSplashUpdate(100, "Update ready");
      scheduleSplashFinish(cb);
    } else if (info.status === "restarting") {
      // Main is about to quitAndInstall — hold the splash and reassure the user
      // instead of briefly dropping them into the app right before the restart.
      restarting = true;
      setSplashUpdate(100, "App will restart shortly — please stand by…");
    } else if (info.status === "error") {
      if (updateVerdict !== "done") updateVerdict = "clear";
      scheduleSplashFinish(cb);
    } else if (info.status === "none") {
      if (updateVerdict === "pending") updateVerdict = "clear";
      scheduleSplashFinish(cb);
    }
  });

  window.glyphh.onBoot((data: BootData) => {
    booted = true;
    bootData = data;
    if (data.theme) {
      cb.applyTheme(data.theme);
    }
    dismissSplash(cb);

    // Account disabled → seal the workspace behind the lockout gate. No
    // tutorial, no CC nudge — nothing until the account is active. (The
    // heartbeat is usually still in flight at boot; the account-locked IPC
    // below is the primary trigger — this catches an early heartbeat.)
    if (data.authenticated && data.status === "disabled") {
      showLockout(cb, { status: data.status });
      cb.onBootReady(data);
      return;
    }

    // Show tutorial on first launch (skip if going through onboarding — handled by yo-onboarding-done)
    if (!data.needsOnboarding) {
      window.glyphh.getPreference("hasSeenTutorial", false).then((seen) => {
        if (!seen) showTutorial(cb);
      });
    }

    cb.onBootReady(data);
  });

  // Account gate — fired by the main-process heartbeat observer the moment a
  // trial expires (or the account is disabled / reactivated), at boot or live.
  window.glyphh.onAccountLocked((info) => { showLockout(cb, info); });
  window.glyphh.onAccountUnlocked(() => { if (accountLocked) hideLockout(cb); });

  // Lockout overlay buttons.
  document.getElementById("lockout-upgrade")?.addEventListener("click", () => {
    window.glyphh.openExternal(manageUrl);
  });
  document.getElementById("lockout-recheck")?.addEventListener("click", () => {
    const statusEl = document.getElementById("lockout-status");
    const btn = document.getElementById("lockout-recheck") as HTMLButtonElement | null;
    if (statusEl) { statusEl.textContent = "Checking…"; statusEl.className = ""; }
    if (btn) btn.disabled = true;
    void window.glyphh.recheckAccount().then((r) => {
      if (btn) btn.disabled = false;
      if (r.status === "active") {
        hideLockout(cb);
      } else if (statusEl) {
        statusEl.textContent = "This account is still inactive. Once it's reactivated, try again.";
        statusEl.className = "onboarding-error";
      }
    }).catch(() => {
      if (btn) btn.disabled = false;
      if (statusEl) {
        statusEl.textContent = "Couldn't reach the server. Check your connection and try again.";
        statusEl.className = "onboarding-error";
      }
    });
  });
  document.getElementById("lockout-signout")?.addEventListener("click", () => {
    void window.glyphh.logout().then(() => window.location.reload());
  });

  window.glyphh.onThemeChanged((theme: string) => {
    cb.applyTheme(theme);
  });

  window.glyphh.onShowOnboarding(() => {
    cb.showOnboarding(true);
  });

  // After onboarding activation, show tutorial (first time only) or restore panels.
  // WEB owns its own first-run decision (server per-user `regionChosen`, driven from
  // web-boot.js via webShowFirstRun/webEnterApp) — so on web this desktop path, which
  // keys off the per-device `hasSeenTutorial` prefs (a no-op stub on web that would
  // otherwise misfire the tutorial every boot), is skipped entirely.
  window.addEventListener("yo-onboarding-done", async () => {
    if ((window as any).__GLYPHH_WEB__) return;
    const seen = await window.glyphh.getPreference("hasSeenTutorial", false);
    if (!seen) {
      showTutorial(cb);
    } else {
      cb.showPanels();
    }
  });
}
