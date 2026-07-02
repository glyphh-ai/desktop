/**
 * Command overlay UI — the full-screen launcher (command-center.html).
 * Lists the user's apps (Apps page / /api/panel-apps) + saved layouts, using
 * the exact same icons as the Apps and Layouts pages (shared app-icon module).
 * Selecting one opens it as real OS windows via the main process.
 */

import { appIconInner, primeConnectedIcons } from "./help/app-icon.js";

type App = {
  id: string;
  name: string;
  slug?: string;
  url?: string | null;
  isBrowser?: boolean;
  connection?: { accountId?: string; pipedreamSlug: string } | null;
};
type Layout = {
  name: string;
  cols: number;
  rows: number;
  splits: Array<{ col: number; row: number; colSpan: number; rowSpan: number }>;
};

// The overlay's own preload surface (command-preload.ts).
interface OverlayApi {
  panelAppsList: () => Promise<App[]>;
  layoutsList: () => Promise<Layout[]>;
  commandOpenApp: (ref: string) => Promise<{ ok: boolean; error?: string }>;
  commandOpenLayout: (name: string) => Promise<{ ok: boolean; error?: string }>;
  commandClose: () => void;
  onCommandRefresh: (cb: (theme: string) => void) => void;
}
const api = (window as unknown as { yo: OverlayApi }).yo;

const root = document.getElementById("command-center")!;
const appsEl = document.getElementById("cc-apps")!;
const layoutsWrapEl = document.getElementById("cc-layouts-wrap")!;
const layoutsEl = document.getElementById("cc-layouts")!;
const emptyEl = document.getElementById("cc-empty")!;

// Built-in apps live outside the server library but open the same way.
const BUILTINS: App[] = [
  { id: "browser", name: "Browser", url: null },
  { id: "terminal", name: "Terminal", url: null },
];

let apps: App[] = [];
let layouts: Layout[] = [];

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] || c));
}

function close(): void { api.commandClose(); }

function renderApps(): void {
  const all = [...BUILTINS, ...apps];
  appsEl.innerHTML = "";
  for (const app of all) {
    const card = document.createElement("button");
    card.className = "cc-card";
    card.innerHTML = `
      <div class="cc-card-shot">${appIconInner(app, app.name, "cc-card-initial")}</div>
      <span class="cc-card-name">${esc(app.name)}</span>`;
    card.addEventListener("click", () => { void api.commandOpenApp(app.id); });
    appsEl.appendChild(card);
  }
  emptyEl.classList.toggle("hidden", all.length > 0);
}

function renderLayouts(): void {
  layoutsEl.innerHTML = "";
  if (layouts.length === 0) { layoutsWrapEl.classList.add("hidden"); return; }
  layoutsWrapEl.classList.remove("hidden");
  for (const layout of layouts) {
    const cells = layout.splits.map((c) => {
      const left = (c.col / layout.cols) * 100;
      const top = (c.row / layout.rows) * 100;
      const w = (c.colSpan / layout.cols) * 100;
      const h = (c.rowSpan / layout.rows) * 100;
      return `<div class="cc-mini-cell" style="left:${left}%;top:${top}%;width:${w}%;height:${h}%"></div>`;
    }).join("");
    const card = document.createElement("button");
    card.className = "cc-layout-card";
    card.innerHTML = `<div class="cc-mini">${cells}</div><span class="cc-card-name">${esc(layout.name)}</span>`;
    card.addEventListener("click", () => { void api.commandOpenLayout(layout.name); });
    layoutsEl.appendChild(card);
  }
}

async function refresh(): Promise<void> {
  try {
    const [a, l] = await Promise.all([api.panelAppsList(), api.layoutsList()]);
    // Match the Apps page: web apps (have a url) + native apps (isBrowser false).
    apps = (a || []).filter((x) => x.url || x.isBrowser === false);
    layouts = l || [];
  } catch { apps = []; layouts = []; }
  renderApps();
  renderLayouts();
  // Pipedream catalog icons land async, then re-render — same as the Apps page.
  void primeConnectedIcons(apps, renderApps);
}

document.getElementById("cc-close")?.addEventListener("click", () => close());
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } });
// Click the darkened backdrop (not a card) to dismiss.
root.addEventListener("mousedown", (e) => { if (e.target === root || (e.target as HTMLElement).classList.contains("cc-inner")) close(); });

api.onCommandRefresh((theme) => {
  if (theme) document.documentElement.setAttribute("data-theme", theme);
  void refresh();
});
void refresh();
