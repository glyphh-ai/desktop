/**
 * Onboarding — the sign-in gate, styled to match the platform auth-shell
 * (clean centered card on a black background). Sign-in is the SDK device
 * flow: the default browser opens on the platform's approval page, this
 * screen shows the confirmation code, and the gate clears when the main
 * process's poll lands the session. New accounts are created on the
 * platform during the same browser round-trip.
 */

// ── Onboarding UI logic ──────────────────────────────────
// The onboarding HTML only exists in index.html (main renderer) — NOT in home.html.
// Guard the top-level bindings so this module is safely importable from home.ts.

const overlay = document.getElementById("onboarding-overlay");
const stepAuth = document.getElementById("onboarding-step-auth");
const statusEl = document.getElementById("onboarding-status");

const ONBOARDING_AVAILABLE = !!overlay;

const TERMS_URL = "https://glyphh.ai/terms";
const PRIVACY_URL = "https://glyphh.ai/privacy";
const REFUND_URL = "https://glyphh.ai/refund";

const closeBtn = document.getElementById("onboarding-close");
if (closeBtn) {
  closeBtn.addEventListener("click", () => {
    window.yo.windowClose();
  });
}

export function showOnboarding(_needsAuth?: boolean) {
  if (!overlay || !stepAuth) return;
  overlay.classList.remove("hidden");
  renderAuthStep();
}

export function hideOnboarding() {
  if (!overlay) return;
  overlay.classList.add("hidden");
}

function setStatus(msg: string, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.className = isError ? "onboarding-error" : "onboarding-success";
}

function completeOnboarding() {
  setStatus("All set!");
  setTimeout(() => {
    hideOnboarding();
    window.yo.onboardingComplete();
    window.dispatchEvent(new Event("yo-onboarding-done"));
  }, 600);
}

// ── DOM builders that emit the platform auth-shell structure ──

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function title(text: string): HTMLHeadingElement {
  return el("h1", "auth-shell-title", text);
}

function lede(text: string): HTMLParagraphElement {
  return el("p", "auth-shell-lede", text);
}

function primaryButton(label: string): HTMLButtonElement {
  const b = el("button", "btn btn-primary btn-lg btn-full", label);
  b.type = "button";
  return b;
}

function actions(...children: HTMLElement[]): HTMLDivElement {
  const wrap = el("div", "auth-shell-actions");
  wrap.append(...children);
  return wrap;
}

function formError(): { el: HTMLParagraphElement; show: (msg: string) => void; clear: () => void } {
  const p = el("p", "auth-shell-error");
  p.style.display = "none";
  return {
    el: p,
    show: (msg: string) => { p.textContent = msg; p.style.display = ""; },
    clear: () => { p.textContent = ""; p.style.display = "none"; },
  };
}

function legal(): HTMLParagraphElement {
  const p = el("p", "auth-shell-legal");
  p.append(document.createTextNode("By signing in, you agree to our "));
  const mk = (text: string, url: string) => {
    const a = el("a", undefined, text);
    a.href = "#";
    a.addEventListener("click", (e) => { e.preventDefault(); window.yo.openExternal(url); });
    return a;
  };
  p.append(
    mk("Terms of Service", TERMS_URL),
    document.createTextNode(", "),
    mk("Privacy Policy", PRIVACY_URL),
    document.createTextNode(", and "),
    mk("Refund Policy", REFUND_URL),
    document.createTextNode("."),
  );
  return p;
}

// ── Device-flow sign-in ──────────────────────────────────────

interface DevicePromptInfo { userCode: string; verificationUri: string; verificationUriComplete?: string }

// The prompt arrives while startDeviceLogin() is still pending — the display
// hook is registered once and routes into whichever screen is live.
let showPrompt: ((prompt: DevicePromptInfo) => void) | null = null;
if (ONBOARDING_AVAILABLE) {
  window.yo.onDeviceLoginPrompt((prompt) => {
    try { showPrompt?.(prompt); } catch { /* display is best-effort */ }
  });
}

/** The confirmation code as square tiles (a separator dash between groups). */
function renderCodeTiles(grid: HTMLDivElement, userCode: string): void {
  grid.innerHTML = "";
  for (const ch of userCode) {
    if (ch === "-" || ch === " ") grid.append(el("span", "device-code-sep", "–"));
    else grid.append(el("span", "device-code-tile", ch));
  }
}

function renderAuthStep(): void {
  if (!stepAuth) return;
  setStatus("");
  stepAuth.innerHTML = "";

  stepAuth.append(title("Sign in to Glyphh"));
  stepAuth.append(lede("Sign-in happens in your browser — approve this device and you're in. New here? The same flow creates your account."));

  const err = formError();

  // Confirmation code — shown once the device grant starts, so the user can
  // verify the browser page is really this sign-in.
  const codeWrap = el("div", "device-code-wrap");
  codeWrap.style.display = "none";
  const codeLabel = el("p", "auth-shell-lede", "Confirm this code in your browser:");
  const codeGrid = el("div", "device-code-grid");
  // The approval-page link, in case the browser hand-off didn't land.
  const openLink = el("p", "auth-shell-meta");
  const openA = el("a", undefined, "Browser didn't open? Open the approval page");
  openA.href = "#";
  openLink.append(openA);
  codeWrap.append(codeLabel, codeGrid, openLink);

  const btn = primaryButton("Continue in browser");
  const retry = el("button", "btn btn-secondary btn-lg btn-full", "Get a new code");
  retry.type = "button";
  retry.style.display = "none";

  let approvalUrl = "";
  openA.addEventListener("click", (e) => {
    e.preventDefault();
    if (approvalUrl) void window.yo.openDeviceApproval(approvalUrl);
  });

  // Restarting replaces the in-flight grant: the superseded attempt resolves
  // as cancelled and must not touch the UI — the newest attempt owns it.
  let attempt = 0;
  const start = async () => {
    const mine = ++attempt;
    err.clear();
    btn.disabled = true;
    btn.textContent = "Waiting for approval…";
    showPrompt = (prompt) => {
      if (mine !== attempt) return;
      approvalUrl = prompt.verificationUriComplete || prompt.verificationUri;
      renderCodeTiles(codeGrid, prompt.userCode);
      codeWrap.style.display = "";
      retry.style.display = "";
    };
    const r = await window.yo.startDeviceLogin();
    if (mine !== attempt) return; // superseded by "Get a new code"
    showPrompt = null;
    if (r.ok) {
      completeOnboarding();
      return;
    }
    btn.disabled = false;
    btn.textContent = "Continue in browser";
    codeWrap.style.display = "none";
    retry.style.display = "none";
    if (r.error !== "cancelled") {
      err.show(r.error ? `Sign-in failed: ${r.error}` : "Sign-in wasn't completed — try again.");
    }
  };

  btn.addEventListener("click", () => { void start(); });
  retry.addEventListener("click", () => { void start(); });

  stepAuth.append(actions(btn), codeWrap, actions(retry), err.el);
  stepAuth.append(legal());
}
