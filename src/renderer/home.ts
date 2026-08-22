/**
 * Home app — entry point for the home.html section panels (loaded as
 * home.html?section=<slug> for each system-app tab: Apps / Layouts / Drips /
 * Skills / Settings / About). Runs in a dedicated BrowserView with the full
 * window.glyphh API.
 */

import { initHelp, gotoSection, openSettingsModal } from "./help/index.js";
import { seedNewSession } from "./help/code.js";
import { initSearchClears } from "./search-clear.js";
import { installAutofillGuard } from "./autofill-guard.js";

// Theme: the inline script in home.html applied localStorage theme synchronously.
// Here we re-fetch the authoritative value from main and keep localStorage in sync.
function applyTheme(theme: string) {
  const resolved = theme === "system"
    ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
    : theme;
  document.documentElement.setAttribute("data-theme", resolved);
  try { localStorage.setItem("yoTheme", theme); } catch {}
}

window.glyphh.getTheme?.().then(applyTheme).catch(() => {});
window.glyphh.onThemeChanged?.(applyTheme);

// React to system dark/light changes when theme = "system"
window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", async () => {
  try {
    const theme = await window.glyphh.getTheme();
    if (theme === "system") applyTheme(theme);
  } catch {}
});

initHelp();
initSearchClears();
installAutofillGuard();
window.glyphh.refreshAuth?.().catch(() => {});

// Full-bleed chrome — the panel covers the titlebar strip, so it owns the
// window controls and the command button (page-top, left of which sits the
// rail toggle wired by code.ts).
document.getElementById("panel-btn-close")?.addEventListener("click", () => window.glyphh.windowClose());
document.getElementById("panel-btn-minimize")?.addEventListener("click", () => window.glyphh.windowMinimize());
document.getElementById("panel-btn-maximize")?.addEventListener("click", () => window.glyphh.windowMaximize());
// Pick the startup section. Priority: ?section=<slug> in the URL (system-app
// panel mounted as its own section) → the user's configured default
// ("homeStartupSection", blank = "last viewed") → the last section → dashboard.
void (async () => {
  // System-app panels (yo://apps, yo://layouts, …) load home.html with a
  // ?section=<slug> query. When set, this panel is locked to that section.
  try {
    const params = new URLSearchParams(window.location.search);
    // MCP OAuth CONSENT SCREEN (web-only — app-web's /settings/mcp route serves
    // home.html; Electron's pathname is a file path so this never matches there).
    // This is the "connect Claude to Glyphh" step: Claude's server /oauth/authorize
    // 302-redirects the browser here carrying the PKCE params, and this page
    // completes the flow (GET /oauth/client/:id to render, POST /oauth/consent to
    // approve → redirect back to Claude with the code). Self-contained: owns its
    // own auth handling (the login-first wall in bridge.js does NOT touch this path).
    if (/^\/settings\/mcp\/?$/.test(window.location.pathname)) {
      await renderMcpConsent(params);
      return;
    }
    // PLATFORM shell (web-only — platform.glyphh.ai's /platform route serves
    // home.html; Electron loads home.html from disk, so this pathname never
    // matches there and the branch is inert on desktop). The workbench/echo
    // never shows: the existing settings surface opens as THE PAGE — the
    // settings modal, restyled full-bleed by body.platform-shell (rail left
    // with a collapse toggle, content right, no close/backdrop — styles.css
    // "Platform shell (web)"). All panel loaders, the org-admin gating and
    // the super-admin (gateAdminSubs) nav-gating run untouched inside it.
    if (/^\/platform\/?$/.test(window.location.pathname)) {
      document.documentElement.setAttribute("data-home-scope", "platform");
      document.body.classList.add("platform-shell");
      const style = document.createElement("style");
      style.textContent = `
        [data-home-scope] #app-rail, [data-home-scope] #code-rail-splitter, [data-home-scope] #page-top, [data-home-scope] #panel-wc, [data-home-scope] #shell-drag-strip { display: none !important; }
        [data-home-scope="platform"] #help-overlay { display: none !important; }`;
      document.head.appendChild(style);
      document.title = "Platform — Glyphh";
      // The boot veil (body.wb-booting) is lifted by the wall-settle loop in
      // the DEFAULT boot path, which this branch returns before — drop it now
      // or this page keeps the opaque booting state forever.
      document.body.classList.remove("wb-booting");
      // Rail collapse state persists per browser (chevron toggle below).
      try {
        if (localStorage.getItem("glyphhPlatformRail") === "collapsed") {
          document.body.classList.add("platform-rail-collapsed");
        }
      } catch { /* private mode — starts expanded */ }
      // Open the settings surface as the page. ?sub=<panel> deep-links a
      // specific panel (billing, members, padmin-orgs, …); default General.
      openSettingsModal(params.get("sub") || "usage");
      // Rail collapse chevron — pinned to the rail's top edge of the shell.
      const railBtn = document.createElement("button");
      railBtn.type = "button";
      railBtn.id = "platform-rail-toggle";
      railBtn.className = "settings-modal-close";
      // The RAIL icon (his spec, 2026-08-22) — same glyph both states, like
      // every sidebar toggle; only the tooltip flips.
      const railSvg = () =>
        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><line x1="9.5" y1="4" x2="9.5" y2="20"/></svg>`;
      const paintRailBtn = () => {
        const collapsed = document.body.classList.contains("platform-rail-collapsed");
        railBtn.innerHTML = railSvg();
        railBtn.setAttribute("aria-label", collapsed ? "Expand navigation" : "Collapse navigation");
        railBtn.title = collapsed ? "Expand navigation" : "Collapse navigation";
      };
      paintRailBtn();
      railBtn.addEventListener("click", () => {
        const collapsed = document.body.classList.toggle("platform-rail-collapsed");
        try { localStorage.setItem("glyphhPlatformRail", collapsed ? "collapsed" : "open"); } catch { /* */ }
        paintRailBtn();
      });
      // Rail HEADER (his spec, 2026-08-21): top-left of the rail — a TEXT-ONLY
      // wordmark, then the surface switch as plain buttons. No fixed top-right
      // tabs on the platform (mountSurfaceTabs skips this page).
      // Build the head ONCE, then keep it mounted as the nav's PREVIOUS
      // SIBLING (in the rail container, not inside .settings-nav). The
      // org-admin gating (gateAdminSubs) rebuilds the nav's children async —
      // anything INSIDE the nav gets wiped a beat after insert (the bug: it
      // showed then vanished). A sibling survives that; an observer re-mounts
      // it if the whole nav element is ever replaced.
      const buildRailHead = (): HTMLElement => {
        const head = document.createElement("div");
        head.id = "platform-rail-head";
        head.innerHTML = `<img id="platform-brand" src="brand/glyphh-logo-text-black.png" alt="Glyphh" draggable="false" /><img id="platform-brand-mark" src="brand/glyphh-mark.png" alt="Glyphh" draggable="false" />`;
        head.appendChild(railBtn);   // same row, right of the logo
        // Surface buttons retired (his call, 2026-08-22): the nav's Apps
        // entry IS the road to the wall; the wall carries "← Platform" back.

        return head;
      };
      // The Apps nav entry OPENS THE WALL (his call, 2026-08-22): the wall IS
      // Apps. Capture-phase so the settings panel switch never fires.
      document.addEventListener("click", (ev) => {
        const item = (ev.target as HTMLElement).closest('.settings-nav-item[data-sub="apps"]');
        if (!item || !document.body.classList.contains("platform-shell")) return;
        ev.preventDefault();
        ev.stopPropagation();
        window.location.assign("/home");
      }, true);
      const railHead = buildRailHead();
      // MUST scope to #settings-modal: the document holds a SECOND
      // .settings-nav inside #help-overlay, which this page force-hides — a
      // bare querySelector(".settings-nav") finds THAT one first and the head
      // mounts into an invisible tree (the bug: everything "worked" headless,
      // rendered 0×0 on screen).
      const platformNav = (): Element | null =>
        document.querySelector("#settings-modal .settings-nav");
      const mountRailHead = (): boolean => {
        const nav = platformNav();
        if (!nav || !nav.parentElement) return false;
        if (railHead.isConnected) return true;
        // FIRST CHILD of the nav — the nav's parent (.settings-layout) is a
        // flex ROW, so a sibling there sat BESIDE the menu and shoved it
        // right. Inside the nav it stacks above the groups. (gateAdminSubs
        // only toggles .hidden — it never rebuilds children, so this is safe.)
        nav.insertBefore(railHead, nav.firstChild);
        return true;
      };
      let railTries = 0;
      const railGo = (): void => {
        if (mountRailHead()) {
          // Keep it mounted across nav rebuilds / replacement.
          const nav = platformNav();
          if (nav) new MutationObserver(() => { if (!railHead.isConnected) mountRailHead(); }).observe(nav, { childList: true });
          return;
        }
        if (railTries++ < 120) requestAnimationFrame(railGo);
      };
      railGo();
      return;
    }
    // Standalone TOOL window (?solo=tool:<ViewKind>) — a desktop layout tiles
    // workbench tools as their own OS windows. The full home page loads, but
    // only the workbench shows, booted with exactly one slot.
    const solo = params.get("solo");
    // ATTACHED AGENT window (?solo=agent) — the real Echo agent floating over
    // ANOTHER window's bottom band (agent-dock.ts sizes/positions this window;
    // the native helper tracks the frontmost window). The full home page
    // loads, but only the agent paints, over a transparent page. The foreign
    // window plays the role cards play in Echo: the wall is permanently
    // "covered", so the agent tucks and hover-reveals exactly as it does over
    // panels — and the lock (echoAgentLock) pins it up, same control, same pref.
    if (solo === "agent") {
      document.documentElement.setAttribute("data-home-scope", "agent-dock");
      const style = document.createElement("style");
      style.textContent = `
        [data-home-scope] #app-rail, [data-home-scope] #code-rail-splitter, [data-home-scope] #page-top, [data-home-scope] #panel-wc, [data-home-scope] #shell-drag-strip { display: none !important; }
        [data-home-scope="agent-dock"] .code-root > :not(.code-agent) { display: none !important; }
        [data-home-scope="agent-dock"], [data-home-scope="agent-dock"] body,
        [data-home-scope="agent-dock"] #home-root, [data-home-scope="agent-dock"] #help-overlay,
        [data-home-scope="agent-dock"] #help-layout, [data-home-scope="agent-dock"] #help-content,
        [data-home-scope="agent-dock"] #page-body, [data-home-scope="agent-dock"] .help-section,
        [data-home-scope="agent-dock"] #section-code, [data-home-scope="agent-dock"] .code-root {
          background: transparent !important; box-shadow: none !important; }`;
      document.head.appendChild(style);
      document.title = "Glyphh";
      // The boot veil (body.wb-booting) is lifted by the wall-settle loop in
      // the DEFAULT boot path, which this branch returns before — drop it now
      // or this window keeps the opaque booting state forever.
      document.body.classList.remove("wb-booting");
      // Assert the covered state NOW — syncWallVisibility only re-runs when
      // cards open/close, which never happens in this window.
      document.body.classList.add("echo-wall-covered");
      gotoSection("code");
      // Click-through: only the agent's own surfaces take the mouse — a
      // POSITIVE scope; everything else forwards to the app beneath.
      // (.code-menu / #code-history / .confirm-overlay are the pill's
      // popovers that mount at body level, outside .code-agent.)
      const HIT = ".code-agent, .code-menu, #code-history, .confirm-overlay, dialog";
      let ignoring = true;
      document.addEventListener("mousemove", (e) => {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const interactive = !!el && !!(el as HTMLElement).closest(HIT);
        if (interactive === ignoring) {
          ignoring = !interactive;
          window.glyphh.agentDockIgnoreMouse?.(ignoring);
        }
      }, { passive: true });
      return;
    }
    // Standalone TOOL window (?solo=tool:<ViewKind>) — a desktop layout tiles
    // workbench tools as their own OS windows.
    if (solo && solo.startsWith("tool:")) {
      document.documentElement.setAttribute("data-home-scope", "solo-tool");
      const style = document.createElement("style");
      // NOTE: hide only the agent at its HOME position (.code-root > …) — the
      // Coding Agent slot REPARENTS the live .code-agent into the workbench,
      // and it must stay visible there. The workbench takes the full window.
      style.textContent = `
        [data-home-scope] #app-rail, [data-home-scope] #code-rail-splitter, [data-home-scope] #page-top, [data-home-scope] #panel-wc, [data-home-scope] #shell-drag-strip { display: none !important; }
        [data-home-scope="solo-tool"] .code-root > .code-agent, [data-home-scope="solo-tool"] #code-wb-edge { display: none !important; }
        [data-home-scope="solo-tool"] .code-workbench { flex: 1 1 auto !important; border-left: none !important; }
        [data-home-scope="solo-tool"] .ws-right-rails { width: 100% !important; }
        [data-home-scope="solo-tool"] .ws-right-rail { flex: 1 1 auto !important; width: auto !important; }`;
      document.head.appendChild(style);
      gotoSection("code");
      const SOLO_LABELS: Record<string, string> = {
        preview: "Browser", coding: "Glyphh", diff: "Diff", monaco: "Editor",
        files: "Files", plan: "Plan", terminal: "Terminal",
      };
      const kind = solo.slice(5);
      const soloLabel = SOLO_LABELS[kind] || kind;
      // The agent's own window is just "Glyphh" — never "Glyphh — Glyphh".
      document.title = soloLabel === "Glyphh" ? "Glyphh" : `${soloLabel} — Glyphh`;
      const payload = {
        cols: 1, colWidths: [], rowHeights: [],
        cells: [{ slug: solo, name: SOLO_LABELS[kind] || kind, url: "", glyphh: false, col: 0, row: 0, tool: kind }],
      };
      // The workbench boots on the code section's first load — poll for it
      // (same pattern as openLayoutInWorkbench).
      const w = window as unknown as { __wbOpenLayout?: (l: typeof payload) => void };
      let tries = 0;
      const go = () => {
        if (w.__wbOpenLayout) w.__wbOpenLayout(payload);
        else if (tries++ < 40) requestAnimationFrame(go);
      };
      go();
      return;
    }
    const urlSection = params.get("section");
    if (urlSection) {
      document.documentElement.setAttribute("data-home-scope", urlSection);
      // Hide the left rail when this panel is locked to a single section —
      // it's mounted as its own app (yo://<slug>), so no in-rail switching.
      const style = document.createElement("style");
      // Locked panels sit below the real titlebar — hide the full-bleed
      // chrome (rail, splitter, page-top strip, panel window controls).
      style.textContent = `[data-home-scope] #app-rail, [data-home-scope] #code-rail-splitter, [data-home-scope] #page-top, [data-home-scope] #panel-wc, [data-home-scope] #shell-drag-strip { display: none !important; }`;
      document.head.appendChild(style);
      gotoSection(urlSection);
      return;
    }
  } catch { /* fall through */ }
  // LAUNCH PAD (decided 2026-08-22, PLAN cut #1): the default boot — web /home
  // AND the desktop app — raises the WALL as the org's Launch Pad: app tiles +
  // the dock, nothing else. The agent/sessions/dev-tools never mount (initCode
  // is unbooted — navigation.ts); the workbench boots only to render the wall
  // and its cards. Building happens in any MCP client.
  {
    const w = window as unknown as { __initCodeWorkbench?: () => void; __wbOpenEchoHome?: () => void };
    w.__initCodeWorkbench?.();
    let raiseTries = 0;
    const raise = (): void => {
      if (w.__wbOpenEchoHome) { w.__wbOpenEchoHome(); return; }
      if (raiseTries++ < 120) requestAnimationFrame(raise);
    };
    raise();
  }
  // "← Platform" — the wall's one nav affordance back to the admin surface
  // (web only; the desktop has no /platform route).
  if ((window as unknown as { __GLYPHH_WEB__?: boolean }).__GLYPHH_WEB__ && !document.getElementById("wall-platform-link")) {
    const back = document.createElement("button");
    back.type = "button";
    back.id = "wall-platform-link";
    back.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg><span>Platform</span>`;
    back.addEventListener("click", () => window.location.assign("/platform"));
    document.body.appendChild(back);
  }
  // Lift the boot veil only once the wall is actually up — its bare first
  // paint was the flash between splash and Home.
  let veilTries = 0;
  let settled = 0;
  const lift = (): void => {
    const wall = document.querySelector(".echo-pages .echo-page-grid");
    const up = !!wall && wall.getClientRects().length > 0;
    settled = up ? settled + 1 : 0;
    if (settled >= 10 || veilTries++ > 360) {
      document.body.classList.remove("wb-booting");
      return;
    }
    requestAnimationFrame(lift);
  };
  lift();
})();

// Surface tabs retired (his call, 2026-08-22): the platform nav's Apps entry
// opens the wall; the wall's top-left "← Platform" link goes back. No floating
// top-right switcher on any surface.

// ── Pending-update badge (bottom-right, every page) ─────────────────────────
// Shows once an update has downloaded; stays until the user restarts into it
// or dismisses it. Dismissal is per version and main rebroadcasts it, so
// dismissing in one panel hides it in all of them.
void (async () => {
  const btn = document.getElementById("app-rail-relaunch");
  const text = document.getElementById("app-rail-relaunch-text");
  if (!btn || !text) return;

  const show = (v: string) => {
    text.textContent = v ? `Relaunch to update — v${v}` : "Relaunch to update";
    btn.title = v ? `Relaunch to finish updating to v${v}` : "Relaunch to finish updating";
    btn.classList.remove("hidden");
  };

  btn.addEventListener("click", () => { window.glyphh.updateInstall?.(); });

  window.glyphh.onUpdateStatus?.((info) => {
    if (info.status === "ready") show(info.version || "");
    else if (info.status === "restarting" || info.status === "none") btn.classList.add("hidden");
  });

  // Panels mount after boot — ask main whether an update is already waiting.
  const pending = await window.glyphh.getUpdateStatus?.();
  if (pending?.ready) show(pending.version);
})();

// ── MCP OAuth CONSENT SCREEN (web-only, /settings/mcp) ──────────────────────
// The "connect Claude to Glyphh" step. Claude's server /oauth/authorize 302s the
// browser here with the PKCE params; this page renders a consent card, and on
// Approve POSTs /oauth/consent → redirects the browser back to Claude with the
// authorization code. See the early-return branch in the main IIFE above.
//
// Envelope: the control plane wraps successes as `{ data: … }` (server
// http/respond.ts `ok()`), NOT `{ ok, data }` — so we unwrap `.data`.

/** localStorage key holding the full consent URL (path+query) to return to
 *  after a signed-out visitor logs in. web-boot.js reads + clears it post-login
 *  and location.replace()s back here with the params intact.
 *  MUST be localStorage, not sessionStorage: magic-link logins complete in a
 *  NEW tab, and sessionStorage is per-tab — the stash vanished and the user
 *  landed on /home instead of back on consent. Stored as JSON {t, ts} so the
 *  reader can expire a stale stash. */
const MCP_CONSENT_RETURN_KEY = "glyphhMcpConsentReturn";

/** Stash the current consent URL for the post-login return hook. */
function stashMcpConsentReturn(): void {
  try {
    const t = window.location.pathname + window.location.search;
    localStorage.setItem(MCP_CONSENT_RETURN_KEY, JSON.stringify({ t, ts: Date.now() }));
  } catch { /* private mode — the return hook simply won't fire */ }
}

interface McpConsentClient {
  clientId: string;
  clientName?: string;
  redirectUris?: string[];
  logoUri?: string;
  clientUri?: string;
}

/** The raw @glyphh/sdk handle the web bridge exposes (window.glyphhSdk). */
function mcpSdk(): { token(): Promise<string | null> } | null {
  return (window as unknown as { glyphhSdk?: { token(): Promise<string | null> } }).glyphhSdk ?? null;
}

/** The API origin the web target boots against (bridge stamps it before us). */
function mcpApiUrl(): string {
  const w = window as unknown as { __GLYPHH_API_URL__?: string };
  return (w.__GLYPHH_API_URL__ || "https://api.glyphh.ai").replace(/\/$/, "");
}

async function renderMcpConsent(params: URLSearchParams): Promise<void> {
  document.documentElement.setAttribute("data-home-scope", "mcp-consent");
  document.title = "Connect to Glyphh";
  // Hide the workbench chrome + the help overlay — this page owns the viewport.
  const style = document.createElement("style");
  style.textContent = `
    [data-home-scope] #app-rail, [data-home-scope] #code-rail-splitter, [data-home-scope] #page-top, [data-home-scope] #panel-wc, [data-home-scope] #shell-drag-strip { display: none !important; }
    [data-home-scope="mcp-consent"] #help-overlay { display: none !important; }`;
  document.head.appendChild(style);
  // CRITICAL: the boot veil (body.wb-booting) is lifted by the wall-settle loop
  // in the DEFAULT boot path, which this branch returns before — drop it now or
  // the page stays blank (opaque booting state forever).
  document.body.classList.remove("wb-booting");

  // The OAuth params Claude forwarded through /oauth/authorize.
  const clientId = params.get("client_id") || "";
  const redirectUri = params.get("redirect_uri") || "";
  const codeChallenge = params.get("code_challenge") || "";
  const codeChallengeMethod = params.get("code_challenge_method") || "S256";
  const state = params.get("state") || "";
  const scope = params.get("scope") || "mcp";
  const resource = params.get("resource") || "";

  // Mount a root the CSS scopes to (styles.css ".mcp-consent-root" block).
  const root = document.createElement("div");
  root.className = "mcp-consent-root";
  document.body.appendChild(root);

  const card = document.createElement("div");
  card.className = "mcp-consent-card";
  root.appendChild(card);

  const setBusy = (busy: boolean) => root.classList.toggle("is-busy", busy);
  const el = (tag: string, cls?: string, text?: string): HTMLElement => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  /** A terminal error state — a readable message, never a blank/spinner. */
  const showError = (title: string, detail: string) => {
    card.innerHTML = "";
    card.append(
      el("h1", "mcp-consent-title", title),
      el("p", "mcp-consent-lede", detail),
    );
    // Offer a way back to Claude if we have a trusted redirect target and it was
    // the client (not the redirect) that is the problem. When we can't trust the
    // redirect_uri, only a plain dismiss (close the tab) is safe.
    setBusy(false);
  };

  // Spinner while we resolve auth + fetch the client.
  card.append(el("div", "mcp-consent-spinner"));

  // ── AUTH ──────────────────────────────────────────────────────────────────
  // Signed-out (no SDK yet / token() throws or is empty): stash THIS full URL and
  // send the user to the login funnel, returning here (params intact) after login.
  const sdk = mcpSdk();
  let token: string | null = null;
  try {
    token = sdk ? await sdk.token() : null;
  } catch {
    token = null;
  }
  if (!token) {
    stashMcpConsentReturn();
    // '/' is the login shell; web-boot's post-login hand-off (goHome) checks the
    // stash and location.replace()s back to this exact URL with params intact.
    window.location.replace("/");
    return;
  }

  const api = mcpApiUrl();
  const authHeader = { Authorization: `Bearer ${token}` };

  // Missing the essentials → nothing to consent to. Don't bounce to a random
  // redirect; show a readable message.
  if (!clientId || !redirectUri || !codeChallenge) {
    showError(
      "Invalid connection request",
      "This link is missing information needed to connect. Start again from the app you are connecting.",
    );
    return;
  }

  // ── FETCH the client to render ──────────────────────────────────────────────
  let client: McpConsentClient | null = null;
  try {
    const res = await fetch(`${api}/oauth/client/${encodeURIComponent(clientId)}`, {
      headers: authHeader,
      cache: "no-store",
    });
    if (res.status === 401) {
      // Session died between the cookie check and here — re-run the signed-out path.
      stashMcpConsentReturn();
      window.location.replace("/");
      return;
    }
    if (res.status === 404) {
      showError("Unknown application", "This application is not registered with Glyphh, so it can't be connected.");
      return;
    }
    if (!res.ok) {
      showError("Couldn’t load this request", `The server returned an error (${res.status}). Please try again.`);
      return;
    }
    // Envelope unwrap: { data: { clientId, clientName, … } }.
    const body = (await res.json()) as { data?: McpConsentClient } | McpConsentClient;
    client = (body && typeof body === "object" && "data" in body ? body.data : body) as McpConsentClient;
  } catch {
    showError("Couldn’t reach the server", "Check your connection and try again.");
    return;
  }
  if (!client) {
    showError("Unknown application", "This application is not registered with Glyphh.");
    return;
  }

  // ── RENDER the consent card ─────────────────────────────────────────────────
  const name = (client.clientName || "An application").trim();
  card.innerHTML = "";

  if (client.logoUri) {
    const logo = document.createElement("img");
    logo.className = "mcp-consent-logo";
    logo.src = client.logoUri;
    logo.alt = "";
    logo.referrerPolicy = "no-referrer";
    logo.addEventListener("error", () => logo.remove());
    card.appendChild(logo);
  }

  const title = el("h1", "mcp-consent-title");
  const strong = el("strong", undefined, name);
  title.append(strong, document.createTextNode(" wants to access your Glyphh account"));
  card.appendChild(title);

  if (client.clientUri) {
    const link = el("a", "mcp-consent-clienturi", client.clientUri.replace(/^https?:\/\//, ""));
    (link as HTMLAnchorElement).href = client.clientUri;
    (link as HTMLAnchorElement).target = "_blank";
    (link as HTMLAnchorElement).rel = "noreferrer noopener";
    card.appendChild(link);
  }

  const scopeBox = el("div", "mcp-consent-scope");
  scopeBox.append(
    el("div", "mcp-consent-scope-name", "mcp"),
    el("div", "mcp-consent-scope-desc", "Your Glyphh tools, apps, loops, and connections."),
  );
  card.appendChild(scopeBox);

  const err = el("p", "mcp-consent-error");
  err.style.display = "none";
  card.appendChild(err);

  const actions = el("div", "mcp-consent-actions");
  const cancelBtn = el("button", "btn btn-secondary mcp-consent-cancel", "Cancel") as HTMLButtonElement;
  cancelBtn.type = "button";
  const approveBtn = el("button", "btn btn-primary mcp-consent-approve", "Approve") as HTMLButtonElement;
  approveBtn.type = "button";
  actions.append(cancelBtn, approveBtn);
  card.appendChild(actions);

  // ── CANCEL → the OAuth deny response back to the client ─────────────────────
  cancelBtn.addEventListener("click", () => {
    try {
      const to = new URL(redirectUri);
      to.searchParams.set("error", "access_denied");
      if (state) to.searchParams.set("state", state);
      window.location.assign(to.toString());
    } catch {
      // redirect_uri isn't a valid URL — nothing safe to bounce to; just say so.
      showError("Connection cancelled", "You declined this connection. You can close this tab.");
    }
  });

  // ── APPROVE → mint the code, then hand the browser back to Claude ───────────
  approveBtn.addEventListener("click", async () => {
    approveBtn.disabled = true;
    cancelBtn.disabled = true;
    approveBtn.textContent = "Connecting…";
    err.style.display = "none";
    setBusy(true);
    try {
      const res = await fetch(`${api}/oauth/consent`, {
        method: "POST",
        headers: { ...authHeader, "content-type": "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          code_challenge_method: codeChallengeMethod,
          state,
          scope,
          resource,
        }),
      });
      if (!res.ok) {
        let msg = `The server returned an error (${res.status}).`;
        try {
          const j = (await res.json()) as { error?: { message?: string }; message?: string };
          msg = j?.error?.message || j?.message || msg;
        } catch { /* keep the status message */ }
        throw new Error(msg);
      }
      const body = (await res.json()) as { data?: { redirectTo?: string }; redirectTo?: string };
      const redirectTo = (body && "data" in body ? body.data?.redirectTo : body?.redirectTo) || "";
      if (!redirectTo) throw new Error("The server did not return a destination.");
      window.location.assign(redirectTo);
    } catch (ex) {
      approveBtn.disabled = false;
      cancelBtn.disabled = false;
      approveBtn.textContent = "Approve";
      setBusy(false);
      err.textContent = (ex instanceof Error && ex.message) || "Could not complete the connection. Please try again.";
      err.style.display = "";
    }
  });

  setBusy(false);
}
