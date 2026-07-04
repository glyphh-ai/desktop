/**
 * Per-app window shell (5b) — drives app-window.html. Self-contained: all
 * navigation happens on the <webview> renderer-side, no IPC. The window's
 * identity (name + start URL) arrives via query params from
 * app-window-manager.ts.
 */

declare global {
  interface Window {
    glyphhWin?: { reportWebview: (slug: string, wcId: number) => void };
  }
}

type AppWebview = HTMLElement & {
  src: string;
  getURL: () => string;
  getWebContentsId: () => number;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  loadURL: (url: string) => Promise<void>;
};

const params = new URLSearchParams(window.location.search);
const appSlug = params.get("slug") || "";
const appName = params.get("name") || "App";
const startUrl = params.get("url") || "about:blank";

const view = document.getElementById("view") as AppWebview;
const titleEl = document.getElementById("title")!;
const fav = document.getElementById("fav") as HTMLImageElement;
const favInitial = document.getElementById("fav-initial")!;
const btnUrl = document.getElementById("btn-url")!;
const ubBack = document.getElementById("ub-back") as HTMLButtonElement;
const ubFwd = document.getElementById("ub-fwd") as HTMLButtonElement;
const ubReload = document.getElementById("ub-reload") as HTMLButtonElement;
const ubInput = document.getElementById("ub-input") as HTMLInputElement;

document.title = appName;
titleEl.textContent = appName;
favInitial.textContent = appName.charAt(0).toUpperCase();
favInitial.style.display = "flex";

// URL row hidden by default; the globe control top-right toggles it.
btnUrl.addEventListener("click", () => {
  const open = document.body.classList.toggle("urlbar-open");
  btnUrl.classList.toggle("active", open);
  if (open) { ubInput.value = safeUrl(); ubInput.select(); }
});

function safeUrl(): string {
  try { return view.getURL(); } catch { return ""; }
}

function syncNav(): void {
  try {
    ubBack.disabled = !view.canGoBack();
    ubFwd.disabled = !view.canGoForward();
  } catch { /* webview not ready yet */ }
  if (document.body.classList.contains("urlbar-open") && document.activeElement !== ubInput) {
    ubInput.value = safeUrl();
  }
}

ubBack.addEventListener("click", () => { try { view.goBack(); } catch { /* */ } });
ubFwd.addEventListener("click", () => { try { view.goForward(); } catch { /* */ } });
ubReload.addEventListener("click", () => { try { view.reload(); } catch { /* */ } });
ubInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const raw = ubInput.value.trim();
  if (!raw) return;
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw
    : /^[^\s]+\.[^\s]{2,}$/.test(raw)
      ? `https://${raw}`
      : `https://www.google.com/search?q=${encodeURIComponent(raw)}`;
  void view.loadURL(url).catch(() => {});
  ubInput.blur();
});

view.addEventListener("dom-ready", () => {
  // Register this webview with main (keyed by slug) so the MCP relay's RPA
  // tools can drive the app by name.
  if (appSlug) {
    try { window.glyphhWin?.reportWebview(appSlug, view.getWebContentsId()); } catch { /* */ }
  }
});
view.addEventListener("did-navigate", syncNav);
view.addEventListener("did-navigate-in-page", syncNav);
view.addEventListener("did-finish-load", syncNav);
view.addEventListener("page-favicon-updated", (e) => {
  const icons = (e as unknown as { favicons: string[] }).favicons;
  if (icons?.[0]) {
    fav.src = icons[0];
    fav.classList.remove("hidden");
    favInitial.style.display = "none";
    fav.onerror = () => { fav.classList.add("hidden"); favInitial.style.display = "flex"; };
  }
});

view.src = startUrl;

export {};
