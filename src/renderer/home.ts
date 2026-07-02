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
      style.textContent = `[data-home-scope] .files-rail { display: none !important; } [data-home-scope] .help-main { margin-left: 0 !important; }`;
      document.head.appendChild(style);
      gotoSection(urlSection);
      return;
    }
  } catch { /* fall through */ }
  const def = ((await window.yo.getPreference?.("homeStartupSection", "")) as string) || "";
  const lastSec = ((await window.yo.getPreference?.("homeLastSection", "")) as string) || "";
  const lastSub = ((await window.yo.getPreference?.("homeLastSub", "")) as string) || "";
  const sec = def || lastSec || "dashboard";
  gotoSection(sec, sec === lastSec ? (lastSub || undefined) : undefined);
})();

// "Create App" from a browser tab routes here — open the New App form prefilled.
window.yo.onOpenNewApp?.((data) => openNewAppDeepLink(data));
