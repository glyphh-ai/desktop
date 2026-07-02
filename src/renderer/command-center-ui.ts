/**
 * Command overlay UI — the full-screen launcher (command-center.html).
 * Lists the user's apps (Apps page / /api/panel-apps) + saved layouts, using
 * the exact same icons as the Apps and Layouts pages (shared app-icon module).
 * A ".dip" command input opens by name; apps and layouts paginate. Selecting
 * one opens it as real OS windows via the main process.
 */

import { appIconInner, primeConnectedIcons, primeNativeIcons } from "./help/app-icon.js";

type App = {
  id: string;
  name: string;
  slug?: string;
  url?: string | null;
  isBrowser?: boolean;
  execPath?: string | null;
  connection?: { accountId?: string; pipedreamSlug: string } | null;
};
type Layout = {
  name: string;
  cols: number;
  rows: number;
  splits: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }>;
};

// The overlay's own preload surface (command-preload.ts).
interface OverlayApi {
  panelAppsList: () => Promise<App[]>;
  layoutsList: () => Promise<Layout[]>;
  commandOpenApp: (ref: string) => Promise<{ ok: boolean; error?: string }>;
  commandOpenLayout: (name: string) => Promise<{ ok: boolean; error?: string }>;
  commandExec: (text: string) => Promise<{ ok: boolean; error?: string }>;
  commandClose: () => void;
  onCommandRefresh: (cb: (theme: string) => void) => void;
}
const api = (window as unknown as { yo: OverlayApi }).yo;

const root = document.getElementById("command-center")!;
const inputEl = document.getElementById("cc-input") as HTMLInputElement;
const appsEl = document.getElementById("cc-apps")!;
const appsPagerEl = document.getElementById("cc-apps-pager")!;
const layoutsWrapEl = document.getElementById("cc-layouts-wrap")!;
const layoutsEl = document.getElementById("cc-layouts")!;
const layoutsPagerEl = document.getElementById("cc-layouts-pager")!;
const emptyEl = document.getElementById("cc-empty")!;

const APPS_PER_PAGE = 14;
const LAYOUTS_PER_PAGE = 8;

// Built-in apps live outside the server library but open the same way.
const BUILTINS: App[] = [
  { id: "browser", name: "Browser", url: null },
  { id: "terminal", name: "Terminal", url: null },
];

let apps: App[] = [];
let layouts: Layout[] = [];
let query = "";
let appsPage = 0;
let layoutsPage = 0;

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] || c));
}
function close(): void { api.commandClose(); }

/** Slice `items` to `page` at `size`, clamping the page in-range. */
function paginate<T>(items: T[], page: number, size: number): { items: T[]; page: number; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.max(0, Math.min(page, totalPages - 1));
  return { items: items.slice(p * size, (p + 1) * size), page: p, totalPages };
}

/** Prev/●●●/Next bar (reuses the app's .pagination-* styling). */
function pager(page: number, totalPages: number, onPage: (p: number) => void): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "pagination-bar";
  if (totalPages <= 1) return bar;
  const nav = document.createElement("div");
  nav.className = "pagination-nav";
  const mk = (label: string, to: number, disabled: boolean) => {
    const b = document.createElement("button");
    b.className = "pagination-btn";
    b.textContent = label;
    b.disabled = disabled;
    b.addEventListener("click", () => onPage(to));
    return b;
  };
  nav.appendChild(mk("‹ Prev", page - 1, page === 0));
  const info = document.createElement("span");
  info.className = "pagination-info";
  info.textContent = `${page + 1} / ${totalPages}`;
  nav.appendChild(info);
  nav.appendChild(mk("Next ›", page + 1, page >= totalPages - 1));
  bar.appendChild(nav);
  return bar;
}

function matchesQuery(name: string): boolean {
  return !query || name.toLowerCase().includes(query);
}

/** Resolve a layout cell's app (server library or built-in) for its icon. */
function resolveCellApp(panelId: string): App | undefined {
  const key = panelId.trim().toLowerCase();
  return [...BUILTINS, ...apps].find((a) => a.id.toLowerCase() === key || (a.slug || "").toLowerCase() === key);
}

function renderApps(): void {
  // Exactly the Apps page list (server /api/panel-apps) — no built-ins.
  const all = apps.filter((a) => matchesQuery(a.name));
  const { items, page, totalPages } = paginate(all, appsPage, APPS_PER_PAGE);
  appsPage = page;
  appsEl.innerHTML = "";
  for (const app of items) {
    const card = document.createElement("button");
    card.className = "cc-card";
    card.innerHTML = `
      <div class="cc-card-shot">${appIconInner(app, app.name, "cc-card-initial")}</div>
      <span class="cc-card-name">${esc(app.name)}</span>`;
    card.addEventListener("click", () => { void api.commandOpenApp(app.id); });
    appsEl.appendChild(card);
  }
  appsPagerEl.innerHTML = "";
  if (totalPages > 1) appsPagerEl.appendChild(pager(page, totalPages, (p) => { appsPage = p; renderApps(); }));
  emptyEl.classList.toggle("hidden", all.length > 0 || layouts.length > 0);
}

function renderLayouts(): void {
  const all = layouts.filter((l) => matchesQuery(l.name));
  layoutsEl.innerHTML = "";
  layoutsPagerEl.innerHTML = "";
  if (all.length === 0) { layoutsWrapEl.classList.add("hidden"); return; }
  layoutsWrapEl.classList.remove("hidden");
  const { items, page, totalPages } = paginate(all, layoutsPage, LAYOUTS_PER_PAGE);
  layoutsPage = page;
  for (const layout of items) {
    const cells = layout.splits.map((c) => {
      const left = (c.col / layout.cols) * 100;
      const top = (c.row / layout.rows) * 100;
      const w = (c.colSpan / layout.cols) * 100;
      const h = (c.rowSpan / layout.rows) * 100;
      const app = resolveCellApp(c.panelId);
      const ico = app
        ? `<span class="cc-mini-ico">${appIconInner(app, app.name, "cc-mini-initial")}</span>`
        : "";
      return `<div class="cc-mini-cell" style="left:${left}%;top:${top}%;width:${w}%;height:${h}%">${ico}</div>`;
    }).join("");
    const card = document.createElement("button");
    card.className = "cc-layout-card";
    card.innerHTML = `<div class="cc-mini">${cells}</div><span class="cc-card-name">${esc(layout.name)}</span>`;
    card.addEventListener("click", () => { void api.commandOpenLayout(layout.name); });
    layoutsEl.appendChild(card);
  }
  if (totalPages > 1) layoutsPagerEl.appendChild(pager(page, totalPages, (p) => { layoutsPage = p; renderLayouts(); }));
}

function renderAll(): void { renderApps(); renderLayouts(); }

async function refresh(): Promise<void> {
  query = "";
  appsPage = 0;
  layoutsPage = 0;
  if (inputEl) inputEl.value = "";
  try {
    const [a, l] = await Promise.all([api.panelAppsList(), api.layoutsList()]);
    // Match the Apps page: web apps (have a url) + native apps (isBrowser false).
    apps = (a || []).filter((x) => x.url || x.isBrowser === false);
    layouts = l || [];
  } catch { apps = []; layouts = []; }
  renderAll();
  // Pipedream catalog icons + native-app OS icons land async, then re-render —
  // same as the Apps page.
  void primeConnectedIcons(apps, renderAll);
  void primeNativeIcons(apps, renderAll);
  inputEl?.focus();
}

// ── Input: filter as you type, Enter runs a .dip command ─────────────────────
inputEl?.addEventListener("input", () => {
  query = inputEl.value.trim().toLowerCase();
  appsPage = 0;
  layoutsPage = 0;
  renderAll();
});
inputEl?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const text = inputEl.value.trim();
    if (text) void api.commandExec(text);
  }
});

document.getElementById("cc-close")?.addEventListener("click", () => close());
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } });
// Click the darkened backdrop (not a card/input) to dismiss.
root.addEventListener("mousedown", (e) => {
  const t = e.target as HTMLElement;
  if (t === root || t.classList.contains("cc-inner")) close();
});

api.onCommandRefresh((theme) => {
  if (theme) document.documentElement.setAttribute("data-theme", theme);
  void refresh();
});
void refresh();
