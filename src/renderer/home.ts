/**
 * Home app — entry point for the home.html section panels (loaded as
 * home.html?section=<slug> for each system-app tab: Apps / Layouts / Drips /
 * Skills / Settings / About). Runs in a dedicated BrowserView with the full
 * window.yo API.
 */

import { initHelp, openNewAppDeepLink, gotoSection } from "./help/index.js";
import { openCommandCenter } from "./help/code.js";
import { initSearchClears } from "./search-clear.js";

// Theme: the inline script in home.html applied localStorage theme synchronously.
// Here we re-fetch the authoritative value from main and keep localStorage in sync.
function applyTheme(theme: string) {
  const resolved = theme === "system"
    ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
    : theme;
  document.documentElement.setAttribute("data-theme", resolved);
  try { localStorage.setItem("yoTheme", theme); } catch {}
}

window.yo.getTheme?.().then(applyTheme).catch(() => {});
window.yo.onThemeChanged?.(applyTheme);

// React to system dark/light changes when theme = "system"
window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", async () => {
  try {
    const theme = await window.yo.getTheme();
    if (theme === "system") applyTheme(theme);
  } catch {}
});

initHelp();
initSearchClears();
window.yo.refreshAuth?.().catch(() => {});

// Full-bleed chrome — the panel covers the titlebar strip, so it owns the
// window controls and the command button (page-top, left of which sits the
// rail toggle wired by code.ts).
document.getElementById("panel-btn-close")?.addEventListener("click", () => window.yo.windowClose());
document.getElementById("panel-btn-minimize")?.addEventListener("click", () => window.yo.windowMinimize());
document.getElementById("panel-btn-maximize")?.addEventListener("click", () => window.yo.windowMaximize());
// Pick the startup section. Priority: ?section=<slug> in the URL (system-app
// panel mounted as its own section) → the user's configured default
// ("homeStartupSection", blank = "last viewed") → the last section → dashboard.
void (async () => {
  // System-app panels (yo://apps, yo://layouts, …) load home.html with a
  // ?section=<slug> query. When set, this panel is locked to that section.
  try {
    const params = new URLSearchParams(window.location.search);
    // Standalone TOOL window (?solo=tool:<ViewKind>) — a desktop layout tiles
    // workbench tools as their own OS windows. The full home page loads, but
    // only the workbench shows, booted with exactly one slot.
    const solo = params.get("solo");
    // Command-center DESKTOP OVERLAY host (?solo=cc): a transparent
    // fullscreen window whose only content is the command center.
    if (solo === "cc") {
      document.documentElement.setAttribute("data-home-scope", "solo-cc");
      (window as unknown as { __ccOverlayHost?: boolean }).__ccOverlayHost = true;
      const style = document.createElement("style");
      style.textContent = `
        [data-home-scope] #app-rail, [data-home-scope] #code-rail-splitter, [data-home-scope] #page-top, [data-home-scope] #panel-wc { display: none !important; }
        [data-home-scope="solo-cc"] .code-root { display: none !important; }
        :root[data-home-scope="solo-cc"], [data-home-scope="solo-cc"] body { background: transparent !important; }
        [data-home-scope="solo-cc"] .command-center { background: rgba(0,0,0,.45); }`;
      document.head.appendChild(style);
      openCommandCenter();
      // The overlay lives exactly as long as the switcher: Esc or picking an
      // item removes #command-center from the DOM — close the window with it.
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") window.close(); });
      let seen = false;
      const mo = new MutationObserver(() => {
        if (document.getElementById("command-center")) seen = true;
        else if (seen) { mo.disconnect(); window.close(); }
      });
      mo.observe(document.body, { childList: true });
      return;
    }
    // GHOST MODE (?solo=ghost): the coding agent as a translucent overlay over
    // whatever app is in front — a floating glass card on a dim, blurred backdrop
    // that lets the app behind show through. A global hotkey toggles the window;
    // Esc or a backdrop click asks main to dismiss it.
    if (solo === "ghost") {
      document.documentElement.setAttribute("data-home-scope", "solo-tool");
      document.documentElement.setAttribute("data-ghost", "1");
      const style = document.createElement("style");
      style.textContent = `
        [data-home-scope] #app-rail, [data-home-scope] #code-rail-splitter, [data-home-scope] #page-top, [data-home-scope] #panel-wc { display: none !important; }
        [data-home-scope="solo-tool"] .code-root > .code-agent, [data-home-scope="solo-tool"] #code-wb-edge { display: none !important; }
        [data-home-scope="solo-tool"] .code-workbench { flex: 1 1 auto !important; border-left: none !important; }
        [data-home-scope="solo-tool"] .ws-right-rails { width: 100% !important; }
        [data-home-scope="solo-tool"] .ws-right-rail { flex: 1 1 auto !important; width: auto !important; }
        /* Ghost chrome: transparent window, dim blurred backdrop, one floating card. */
        :root[data-ghost="1"], [data-ghost="1"] body { background: transparent !important; overflow: hidden !important; }
        #ghost-backdrop { position: fixed; inset: 0; z-index: 0; background: rgba(6, 4, 12, 0.34); -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px); }
        [data-ghost="1"] .code-root {
          position: fixed; z-index: 1; left: 50%; top: 50%; transform: translate(-50%, -50%);
          width: min(920px, 92vw); height: min(72vh, 760px);
          border-radius: 16px; overflow: hidden;
          border: 1px solid rgba(255, 255, 255, 0.12);
          background: var(--bg, #0e0b16);
          box-shadow: 0 40px 120px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.05) inset;
          animation: ghost-in 0.18s ease both;
        }
        @keyframes ghost-in { from { opacity: 0; transform: translate(-50%, -46%) scale(0.985); } to { opacity: 1; transform: translate(-50%, -50%) scale(1); } }`;
      document.head.appendChild(style);
      const close = () => (window.yo as unknown as { ghostClose?: () => void }).ghostClose?.();
      const backdrop = document.createElement("div");
      backdrop.id = "ghost-backdrop";
      backdrop.addEventListener("mousedown", close);
      document.body.appendChild(backdrop);
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } });
      document.title = "Glyphh Ghost";
      gotoSection("code");
      const payload = {
        cols: 1, colWidths: [], rowHeights: [],
        cells: [{ slug: "tool:coding", name: "Coding Agent", url: "", glyphh: false, col: 0, row: 0, tool: "coding" }],
      };
      const w = window as unknown as { __wbOpenLayout?: (l: typeof payload) => void };
      let tries = 0;
      const go = () => { if (w.__wbOpenLayout) w.__wbOpenLayout(payload); else if (tries++ < 40) requestAnimationFrame(go); };
      go();
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
        [data-home-scope] #app-rail, [data-home-scope] #code-rail-splitter, [data-home-scope] #page-top, [data-home-scope] #panel-wc { display: none !important; }
        [data-home-scope="solo-tool"] .code-root > .code-agent, [data-home-scope="solo-tool"] #code-wb-edge { display: none !important; }
        [data-home-scope="solo-tool"] .code-workbench { flex: 1 1 auto !important; border-left: none !important; }
        [data-home-scope="solo-tool"] .ws-right-rails { width: 100% !important; }
        [data-home-scope="solo-tool"] .ws-right-rail { flex: 1 1 auto !important; width: auto !important; }`;
      document.head.appendChild(style);
      gotoSection("code");
      const SOLO_LABELS: Record<string, string> = {
        preview: "Browser", coding: "Coding Agent", diff: "Diff", monaco: "Editor",
        files: "Files", plan: "Plan", terminal: "Terminal",
      };
      const kind = solo.slice(5);
      document.title = `${SOLO_LABELS[kind] || kind} — Glyphh`;
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
      style.textContent = `[data-home-scope] #app-rail, [data-home-scope] #code-rail-splitter, [data-home-scope] #page-top, [data-home-scope] #panel-wc { display: none !important; }`;
      document.head.appendChild(style);
      gotoSection(urlSection);
      return;
    }
  } catch { /* fall through */ }
  const def = ((await window.yo.getPreference?.("homeStartupSection", "")) as string) || "";
  const lastSec = ((await window.yo.getPreference?.("homeLastSection", "")) as string) || "";
  const lastSub = ((await window.yo.getPreference?.("homeLastSub", "")) as string) || "";
  let sec = def || lastSec || "code";
  // A remembered section may have been removed since (e.g. the old Skills
  // page) — fall back rather than landing on a blank pane.
  if (!document.querySelector(`.help-section[data-section="${sec}"]`)) sec = "code";
  gotoSection(sec, sec === lastSec ? (lastSub || undefined) : undefined);
})();

// "Create App" from a browser tab routes here — open the New App form prefilled.
window.yo.onOpenNewApp?.((data) => openNewAppDeepLink(data));

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

  btn.addEventListener("click", () => { window.yo.updateInstall?.(); });

  window.yo.onUpdateStatus?.((info) => {
    if (info.status === "ready") show(info.version || "");
    else if (info.status === "restarting" || info.status === "none") btn.classList.add("hidden");
  });

  // Panels mount after boot — ask main whether an update is already waiting.
  const pending = await window.yo.getUpdateStatus?.();
  if (pending?.ready) show(pending.version);
})();
