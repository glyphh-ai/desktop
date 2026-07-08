/**
 * Home app — entry point for the home.html section panels (loaded as
 * home.html?section=<slug> for each system-app tab: Apps / Layouts / Drips /
 * Skills / Settings / About). Runs in a dedicated BrowserView with the full
 * window.yo API.
 */

import { initHelp, openNewAppDeepLink, gotoSection } from "./help/index.js";
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
document.getElementById("page-command-center")?.addEventListener("click", () => window.yo.commandToggle());

// Pick the startup section. Priority: ?section=<slug> in the URL (system-app
// panel mounted as its own section) → the user's configured default
// ("homeStartupSection", blank = "last viewed") → the last section → dashboard.
void (async () => {
  // System-app panels (yo://apps, yo://layouts, …) load home.html with a
  // ?section=<slug> query. When set, this panel is locked to that section.
  try {
    const params = new URLSearchParams(window.location.search);
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
  const badge = document.getElementById("update-badge");
  const text = document.getElementById("update-badge-text");
  if (!badge || !text) return;
  let version = "";

  const show = async (v: string) => {
    version = v || "";
    const dismissed = await window.yo.getPreference?.(`updateDismissed:${version || "unknown"}`, false);
    if (dismissed) return;
    text.textContent = `Update ready${version ? ` — v${version}` : ""}`;
    badge.classList.remove("hidden");
  };

  document.getElementById("update-badge-restart")?.addEventListener("click", () => {
    window.yo.updateInstall?.();
  });
  document.getElementById("update-badge-dismiss")?.addEventListener("click", () => {
    badge.classList.add("hidden");
    window.yo.updateBadgeDismiss?.(version);
  });

  window.yo.onUpdateStatus?.((info) => {
    if (info.status === "ready") void show(info.version || "");
    else if (info.status === "dismissed" || info.status === "restarting" || info.status === "none") {
      badge.classList.add("hidden");
    }
  });

  // Panels mount after boot — ask main whether an update is already waiting.
  const pending = await window.yo.getUpdateStatus?.();
  if (pending?.ready) void show(pending.version);
})();
