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

let dismissRequested = false;
let splashRemoved = false;

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
  // 2026-08-27: the static card tutorial is retired as the first-run door —
  // (the wall tour that once followed it went with the wall, 2026-10-08).
  // First run just enters the
  // app; the tour fires once the wall paints. (showTutorial stays for any
  // explicit re-entry point — hidden, not deleted.)
  webEnterApp(onComplete);
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

/** Actually fade out and remove the splash. Idempotent. */
function finishSplash(cb: BootGateCallbacks): void {
  if (splashRemoved) return;
  splashRemoved = true;
  // Show panels first (behind splash z-index:9999) so they're ready when splash fades.
  // BUT not if tutorial / CC modal / login overlay is up — BrowserViews paint
  // over HTML overlays.
  if (!tutorialShowing && !ccModalShowing && !bootData?.needsOnboarding) cb.showPanels();
  const splash = document.getElementById("splash");
  if (splash) {
    splash.classList.add("fade-out");
    setTimeout(() => splash.remove(), 600);
  }
  if (bootData?.needsOnboarding) {
    cb.showOnboarding(!bootData.authenticated);
  }
}

/** Bring the splash down once boot is ready, after the minimum splash time. */
function scheduleSplashFinish(cb: BootGateCallbacks): void {
  if (splashRemoved || !dismissRequested) return;
  const elapsed = Date.now() - splashShownAt;
  setTimeout(() => finishSplash(cb), Math.max(0, SPLASH_MIN_MS - elapsed));
}

function dismissSplash(cb: BootGateCallbacks): void {
  if (!booted || dismissRequested) return;
  dismissRequested = true;
  scheduleSplashFinish(cb);
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

  window.glyphh.onBoot((data: BootData) => {
    booted = true;
    bootData = data;
    if (data.theme) {
      cb.applyTheme(data.theme);
    }
    dismissSplash(cb);

    // FIRST RUN IS THE WALL TOUR, ON EVERY SURFACE (his report, 2026-08-29:
    // "the old flow showed up again on desktop — are there two flows?"). Yes,
    // there were: web moved to the wall tour on 2026-08-27 while desktop kept
    // calling the static card carousel here, keyed off the per-DEVICE
    // hasSeenTutorial pref. (The wall tour that once followed is gone,
    // 2026-10-08.) The tutorial pref follows the
    // account across machines. Desktop now enters the app like web does.

    cb.onBootReady(data);
  });

  window.glyphh.onThemeChanged((theme: string) => {
    cb.applyTheme(theme);
  });

  // After onboarding activation, show tutorial (first time only) or restore panels.
  // WEB owns its own first-run decision (server per-user `regionChosen`, driven from
  // web-boot.js via webShowFirstRun/webEnterApp) — so on web this desktop path, which
  // keys off the per-device `hasSeenTutorial` prefs (a no-op stub on web that would
  // otherwise misfire the tutorial every boot), is skipped entirely.
  window.addEventListener("yo-onboarding-done", () => {
    if ((window as unknown as { __GLYPHH_WEB__?: boolean }).__GLYPHH_WEB__) return;
    // Straight into the workspace — the wall tour takes it from here.
    cb.showPanels();
  });
}
