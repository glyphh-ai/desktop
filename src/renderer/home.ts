/**
 * Home app — entry point for the home.html section panels (loaded as
 * home.html?section=<slug> for each system-app tab: Apps / Layouts / Drips /
 * Skills / Settings / About). Runs in a dedicated BrowserView with the full
 * window.glyphh API.
 */

import { initHelp, gotoSection } from "./help/index.js";
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

// ── Desktop-layout close bar ────────────────────────────────────────────────
// While a DESKTOP layout owns the screen, Glyphh docks as a strip across the
// top (screen-layout.ts, mode "top") and this bar is the way back: layout
// name + "Close layout" (app-reset: closes the layout's windows and un-docks
// this window). Hidden the rest of the time — the bar only exists while a
// desktop layout is active.
window.glyphh.onDesktopLayoutChanged?.((name) => {
  let bar = document.getElementById("desktop-layout-bar");
  if (!name) { bar?.remove(); return; }
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "desktop-layout-bar";
    bar.innerHTML = `
      <span class="dlb-name"></span>
      <button class="dlb-close" type="button">Close layout</button>`;
    bar.querySelector(".dlb-close")!.addEventListener("click", () => {
      void window.glyphh.appReset?.();
    });
    document.body.appendChild(bar);
  }
  (bar.querySelector(".dlb-name") as HTMLElement).textContent = name;
});

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
    // Standalone TOOL window (?solo=tool:<ViewKind>) — a desktop layout tiles
    // workbench tools as their own OS windows. The full home page loads, but
    // only the workbench shows, booted with exactly one slot.
    const solo = params.get("solo");
    // ATTACHED AGENT window (?solo=agent) — the real Echo agent floating over
    // ANOTHER app's window (agent-dock.ts sizes/positions this window along
    // the target's bottom edge). The full home page loads, but only the agent
    // paints, over a transparent page. The foreign app plays the role cards
    // play in Echo: the wall is permanently "covered", so the agent tucks and
    // hover-reveals exactly as it does over panels — and the lock
    // (echoAgentLock) pins it up, same control, same pref.
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
      // cards open/close, which never happens in this window. The workbench's
      // own computation (patched to respect agent-dock) keeps it set.
      document.body.classList.add("echo-wall-covered");
      gotoSection("code");
      // Click-through: this window covers the target app's bottom band — only
      // the agent's own pixels may eat the mouse. Anything else under the
      // cursor forwards events to the app beneath (setIgnoreMouseEvents with
      // forward:true still delivers mousemove, so re-entry is detected).
      // POSITIVE scope — only the agent's own surfaces take the mouse. A
      // negative test ("anything but the background") once let an invisible
      // full-window element flip this window into click-eating mode, which
      // swallowed the TARGET app's close button. Everything not listed here
      // forwards, always. (.code-menu / #code-history / .confirm-overlay are
      // the pill's popovers that mount at body level, outside .code-agent.)
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
  // Every restart lands on the COMMAND CENTER — the bare wall, no agent (his
  // rule, 2026-08-18). initCode's boot raises it (openCommandCenter); calling
  // gotoSection("agent") here would open the agent card via
  // openSectionInWorkbench("agent") → openChat, which is exactly the
  // agent-on-boot he keeps seeing. (?section / ?solo panels above are system
  // windows, not normal boots.)
  // Lift the boot veil only once the WALL is actually up — its bare first
  // paint was the flash between splash and Home.
  let veilTries = 0;
  let settled = 0;
  const lift = (): void => {
    // The launcher is UP when a page grid has rendered its icons. Wait until
    // it is present AND stable for ~10 frames so the first visible frame is
    // the settled command center, then lift.
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
