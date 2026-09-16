/**
 * settings-skills — Settings → Build → Skills (his order, 2026-09-16).
 *
 * Skills are FOLDERS in the Agent Skills standard, read straight from the
 * CLIs' own skill directories and Glyphh's (main/skills-fs.ts). Two tabs:
 *   Your skills — grouped by where they live (yours, Claude Code, Codex, Gemini)
 *   Discover    — the org's hub + the Glyphh catalog the org allowed
 * A row opens the detail: Overview (SKILL.md rendered, the author beside it)
 * and Contents (the folder's files with a Monaco viewer — preview or code).
 */

import { escapeHtml, confirmAction } from "./shared.js";
import { closeSettingsModal } from "./navigation.js";
import { formatMarkdown } from "../format-markdown.js";

type Source = "glyphh" | "claude" | "codex" | "gemini";
interface SkillRow { id: string; source: Source; name: string; description: string; author: string; enabled: boolean; dir: string; fileCount: number; updatedAt: string }
interface SkillFile { path: string; size: number }
interface SkillDetail extends SkillRow { frontmatter: Record<string, string>; body: string; files: SkillFile[] }
interface DiscoverRow { ref: string; from: "org" | "glyphh"; id: string; slug: string; name: string; description: string; author: string; version: number | null; installed: boolean; installs: number; updatedAt: string; createdAt: string; categories: string[] }
type Env<T> = { ok: boolean; data?: T; error?: string };

const SOURCE_LABEL: Record<Source, string> = { glyphh: "Created by you", claude: "From Claude Code", codex: "From Codex", gemini: "From Gemini" };
const SOURCE_ORDER: Source[] = ["glyphh", "claude", "codex", "gemini"];
const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>`;

let wired = false;
let tab: "mine" | "discover" = "mine";
let query = "";
/** List controls: filter by origin and author; sort order. */
let filterSource: Source | "" = "";
let filterAuthor = "";
type SortKey = "edited" | "name" | "author";
let sortKey: SortKey = "edited";
const SORT_LABEL: Record<SortKey, string> = { edited: "Last edited", name: "Name", author: "Created by" };
let skills: SkillRow[] = [];
let discoverRows: DiscoverRow[] = [];
let hubCategories: Array<{ id: string; label: string }> = [];
/** Discover drill-down: the home, one category, or one shelf ("new" / "top" / "all"). */
let discoverView: { kind: "home" } | { kind: "category"; id: string } | { kind: "shelf"; id: "new" | "top" | "all" } = { kind: "home" };
let showAllCategories = false;
let current: SkillDetail | null = null;
let currentFile = "";
let viewMode: "preview" | "code" = "preview";
let editing = false;
/** The file text as loaded from disk; the editor is dirty when it differs. */
let loadedText = "";
/** A hub version being viewed read-only (null = the folder on disk). */
let viewedVersion: { itemId: string; version: number; files: Record<string, string> } | null = null;
let editor: { getValue(): string; setValue(v: string): void; updateOptions(o: Record<string, unknown>): void; layout(): void; dispose(): void; getModel(): unknown } | null = null;

const el = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;
const api = () => window.glyphh;

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const days = (Date.now() - d.getTime()) / 86_400_000;
  if (days < 1) return "today";
  if (days < 7) return `${Math.floor(days)}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fail(msg: string): void {
  const e = el("skills-error");
  if (!e) return;
  e.textContent = msg;
  e.classList.remove("hidden");
}

// ── list ────────────────────────────────────────────────────────────────────
export async function loadSkillsSettings(): Promise<void> {
  wire();
  el("skill-detail-view")?.classList.add("hidden");
  el("skills-list-view")?.classList.remove("hidden");
  el("skills-error")?.classList.add("hidden");
  const r = await api().skillsList() as Env<SkillRow[]>;
  if (!r.ok) { fail(r.error || "Couldn't read your skills."); return; }
  skills = r.data ?? [];
  if (tab === "discover") await loadDiscover();
  renderList();
}

async function loadDiscover(): Promise<void> {
  const [r, c] = await Promise.all([api().skillsDiscover() as Promise<Env<DiscoverRow[]>>, api().hubCategories() as Promise<Env<Array<{ id: string; label: string }>>>]);
  if (!r.ok) { fail(r.error || "The hub didn't answer."); discoverRows = []; return; }
  discoverRows = r.data ?? [];
  hubCategories = c.ok ? (c.data ?? []) : [];
  discoverView = { kind: "home" };
}

type MenuItem = { label: string; danger?: boolean; checked?: boolean; onClick: () => void } | { sep: true } | { heading: string } | { label: string; children: MenuItem[] };
function row(opts: { name: string; by: string; desc: string; right: string; onOpen?: () => void; menu?: MenuItem[]; action?: HTMLElement }): HTMLElement {
  const r = document.createElement("div");
  r.className = "skill-row" + (opts.onOpen ? " openable" : "");
  r.innerHTML = `<div class="skill-tile-icon">${ICON}</div>
    <div class="skill-row-main">
      <div class="skill-row-name"></div>
      <div class="skill-row-sub"><span class="skill-row-by"></span><span class="skill-row-dot">·</span><span class="skill-row-desc"></span></div>
    </div>
    <div class="skill-row-right"></div>`;
  (r.querySelector(".skill-row-name") as HTMLElement).textContent = opts.name;
  (r.querySelector(".skill-row-by") as HTMLElement).textContent = opts.by;
  (r.querySelector(".skill-row-desc") as HTMLElement).textContent = opts.desc || "No description";
  const right = r.querySelector(".skill-row-right") as HTMLElement;
  const date = document.createElement("span");
  date.className = "skill-row-date";
  date.textContent = opts.right;
  right.appendChild(date);
  if (opts.action) right.appendChild(opts.action);
  if (opts.menu?.length) {
    const kb = document.createElement("button");
    kb.className = "skills-kebab";
    kb.type = "button";
    kb.textContent = "⋮";
    kb.addEventListener("click", (e) => { e.stopPropagation(); openMenu(kb, opts.menu!); });
    right.appendChild(kb);
  }
  if (opts.onOpen) r.addEventListener("click", opts.onOpen);
  return r;
}

let menuEl: HTMLElement | null = null;
let subMenuEl: HTMLElement | null = null;
function closeMenu(): void { subMenuEl?.remove(); subMenuEl = null; menuEl?.remove(); menuEl = null; }

const CHECK = `<svg class="menu-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7"/></svg>`;
const ARROW = `<svg class="menu-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>`;

function fillMenu(m: HTMLElement, items: MenuItem[]): void {
  for (const it of items) {
    if ("sep" in it) { const d = document.createElement("div"); d.className = "code-menu-sep"; m.appendChild(d); continue; }
    if ("heading" in it) { const d = document.createElement("div"); d.className = "code-menu-label"; d.textContent = it.heading; m.appendChild(d); continue; }
    const b = document.createElement("button");
    b.type = "button";
    if ("children" in it) {
      b.className = "code-menu-item";
      b.innerHTML = `<span></span>${ARROW}`;
      (b.querySelector("span") as HTMLElement).textContent = it.label;
      const open = (): void => {
        subMenuEl?.remove();
        const sub = document.createElement("div");
        sub.className = "code-menu skills-menu";
        fillMenu(sub, it.children);
        document.body.appendChild(sub);
        const r = b.getBoundingClientRect();
        const left = r.right + 4 + sub.offsetWidth > window.innerWidth - 8 ? r.left - sub.offsetWidth - 4 : r.right + 4;
        sub.style.left = `${Math.max(8, left)}px`;
        sub.style.top = `${Math.min(r.top - 4, window.innerHeight - sub.offsetHeight - 8)}px`;
        subMenuEl = sub;
      };
      b.addEventListener("mouseenter", open);
      b.addEventListener("click", open);
      m.appendChild(b);
      continue;
    }
    b.className = "code-menu-item" + (it.danger ? " danger" : "") + (it.checked ? " checked" : "");
    b.innerHTML = `<span></span>${CHECK}`;
    (b.querySelector("span") as HTMLElement).textContent = it.label;
    b.addEventListener("click", () => { closeMenu(); it.onClick(); });
    m.appendChild(b);
  }
}
function openMenu(anchor: HTMLElement, items: MenuItem[]): void {
  closeMenu();
  const m = document.createElement("div");
  m.className = "code-menu skills-menu";
  fillMenu(m, items);
  document.body.appendChild(m);
  const rect = anchor.getBoundingClientRect();
  m.style.left = `${Math.max(8, Math.min(rect.right - m.offsetWidth, window.innerWidth - m.offsetWidth - 8))}px`;
  m.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - m.offsetHeight - 8)}px`;
  menuEl = m;
  const dismiss = (e: MouseEvent): void => {
    if ((menuEl && menuEl.contains(e.target as Node)) || (subMenuEl && subMenuEl.contains(e.target as Node))) return;
    document.removeEventListener("mousedown", dismiss, true);
    closeMenu();
  };
  setTimeout(() => document.addEventListener("mousedown", dismiss, true), 0);
}

function group(host: HTMLElement, label: string, count: number): HTMLElement {
  const g = document.createElement("div");
  g.className = "skill-group";
  g.innerHTML = `<div class="skill-group-head"><span></span><span class="skill-group-count"></span></div>`;
  (g.querySelector(".skill-group-head > span") as HTMLElement).textContent = label;
  (g.querySelector(".skill-group-count") as HTMLElement).textContent = `· ${count}`;
  host.appendChild(g);
  return g;
}

function renderList(): void {
  const host = el("skills-groups");
  if (!host) return;
  host.textContent = "";
  document.querySelectorAll<HTMLButtonElement>(".skills-panel .skills-tab[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  const q = query.trim().toLowerCase();
  const hit = (s: string) => !q || s.toLowerCase().includes(q);

  if (tab === "mine") {
    const shown = skills
      .filter((s) => hit(`${s.name} ${s.description} ${s.author}`))
      .filter((s) => !filterSource || s.source === filterSource)
      .filter((s) => !filterAuthor || authorOf(s) === filterAuthor)
      .sort((a, b) => sortKey === "name" ? a.name.localeCompare(b.name) : sortKey === "author" ? authorOf(a).localeCompare(authorOf(b)) || a.name.localeCompare(b.name) : b.updatedAt.localeCompare(a.updatedAt));
    const count = el("skills-count"); if (count) count.textContent = `${shown.length} skill${shown.length === 1 ? "" : "s"}`;
    paintControls();
    if (!shown.length) {
      host.innerHTML = `<div class="crud-empty">${q ? `No skills matching "${escapeHtml(q)}"` : "No skills yet. Add one, or install from Discover."}</div>`;
      return;
    }
    // Groups by author, like Claude's: yours first, then each named author.
    const groups = new Map<string, SkillRow[]>();
    for (const s of shown) { const k = s.author ? s.author : ""; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(s); }
    const keys = [...groups.keys()].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
    for (const k of keys) {
      const rows = groups.get(k)!;
      const g = group(host, k ? `From ${k}` : "Created by you", rows.length);
      for (const s of rows) {
        g.appendChild(row({
          name: s.name, by: s.author ? `by ${s.author}` : "by you",
          desc: s.description, right: when(s.updatedAt),
          onOpen: () => void openDetail(s.id),
          menu: [
            { label: s.enabled ? "Turn off" : "Turn on", onClick: () => void toggle(s.id, !s.enabled) },
            { label: "Share", onClick: async () => { await openDetail(s.id); await share(); } },
            ...(s.source !== "glyphh" ? [{ label: "Manage in Glyphh", onClick: () => void adopt(s.id) }] : []),
            { sep: true as const },
            { label: "Remove", danger: true, onClick: () => void remove(s.id, s.name) },
          ],
        }));
        if (!s.enabled) (g.lastElementChild as HTMLElement).classList.add("disabled");
      }
    }
    return;
  }

  const shown = discoverRows.filter((d) => hit(`${d.name} ${d.description} ${d.author}`));
  const count = el("skills-count"); if (count) count.textContent = `${shown.length} available`;
  paintControls();
  if (!shown.length) {
    host.innerHTML = `<div class="crud-empty">${q ? `Nothing matching "${escapeHtml(q)}"` : "Nothing to discover yet — your organization hasn't published skills, and Glyphh's catalog has none your org allows."}</div>`;
    return;
  }
  if (q || discoverView.kind !== "home") { renderDiscoverList(host, shown); return; }
  renderDiscoverHome(host, shown);
}

// ── Discover ────────────────────────────────────────────────────────────────
const CATEGORY_GLYPHS: Record<string, string> = {
  apis: `<path d="M8 4H6a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v3a2 2 0 0 0 2 2h2M16 4h2a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2 2 2 0 0 0-2 2v3a2 2 0 0 1-2 2h-2"/>`,
  data: `<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10M15 10v10"/>`,
  engineering: `<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 14l2 2-2 2M12 18h4"/>`,
  code: `<path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 4l-4 16"/>`,
  files: `<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>`,
  contacts: `<circle cx="12" cy="8" r="3.5"/><path d="M4 20a8 8 0 0 1 16 0"/>`,
  pipelines: `<circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M7 6h10M6 8l5 8M18 8l-5 8"/>`,
  databases: `<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>`,
  design: `<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m3 16 5-5 4 4 3-3 6 6"/><circle cx="16" cy="9" r="1.5"/>`,
  sales: `<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>`,
  marketing: `<path d="M3 11v2a1 1 0 0 0 1 1h2l6 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M16 9a3 3 0 0 1 0 6M18 6a7 7 0 0 1 0 12"/>`,
  finance: `<path d="M12 3v18M17 7H9.5a2.5 2.5 0 0 0 0 5h5a2.5 2.5 0 0 1 0 5H7"/>`,
  legal: `<path d="M12 3v18M5 7h14M7 7l-3 7a3 3 0 0 0 6 0zM17 7l-3 7a3 3 0 0 0 6 0z"/>`,
  product: `<path d="M12 3 3 8l9 5 9-5zM3 8v8l9 5 9-5V8"/>`,
  research: `<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5M9 11h4M11 9v4"/>`,
  productivity: `<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>`,
  security: `<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>`,
  support: `<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 0 1 5 0c0 1.5-2.5 2-2.5 3.5M12 17h.01"/>`,
  memory: `<path d="M12 3a5 5 0 0 0-5 5v1a4 4 0 0 0-2 7v1a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-1a4 4 0 0 0-2-7V8a5 5 0 0 0-5-5z"/><path d="M12 8v12"/>`,
  apps: `<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/>`,
};
const glyph = (id: string, size = 20): string => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${CATEGORY_GLYPHS[id] ?? CATEGORY_GLYPHS.productivity}</svg>`;
const catLabel = (id: string): string => hubCategories.find((c) => c.id === id)?.label ?? id;
const fmtInstalls = (n: number): string => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
const isNew = (d: DiscoverRow): boolean => Date.now() - Date.parse(d.createdAt || d.updatedAt) < 14 * 864e5;

function addButton(d: DiscoverRow, wide = false): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = wide ? "action-btn skill-add-wide" : "action-btn skill-add-btn";
  b.textContent = d.installed ? (wide ? "Added" : "✓") : (wide ? "Add" : "+");
  b.disabled = d.installed;
  b.title = d.installed ? "Already in your skills" : "Add to your skills";
  b.addEventListener("click", (e) => { e.stopPropagation(); void installFrom(d, b); });
  return b;
}

function discoverCard(d: DiscoverRow): HTMLElement {
  const c = document.createElement("div");
  c.className = "disc-card";
  c.innerHTML = `<div class="skill-tile-icon">${glyph(d.categories[0] || "productivity", 18)}</div><div class="disc-card-main"><div class="disc-card-name"></div><div class="disc-card-desc"></div><div class="disc-card-meta"></div></div>`;
  (c.querySelector(".disc-card-name") as HTMLElement).textContent = d.name;
  (c.querySelector(".disc-card-desc") as HTMLElement).textContent = d.description || "No description";
  (c.querySelector(".disc-card-meta") as HTMLElement).textContent = `from ${d.author || "your org"} · ${d.installs ? `${fmtInstalls(d.installs)} installs` : isNew(d) ? `added ${when(d.createdAt)}` : `v${d.version ?? 1}`}`;
  c.appendChild(addButton(d));
  return c;
}

function shelf(host: HTMLElement, title: string, rows: DiscoverRow[], seeAll: (() => void) | null, limit = 8): void {
  if (!rows.length) return;
  const sec = document.createElement("section");
  sec.className = "disc-shelf";
  const head = document.createElement("div");
  head.className = "disc-shelf-head";
  head.innerHTML = `<span></span>`;
  (head.querySelector("span") as HTMLElement).textContent = title;
  if (seeAll && rows.length > limit) {
    const b = document.createElement("button"); b.type = "button"; b.className = "disc-link"; b.textContent = "See all ›";
    b.addEventListener("click", seeAll); head.appendChild(b);
  }
  const grid = document.createElement("div");
  grid.className = "disc-grid";
  rows.slice(0, limit).forEach((d) => grid.appendChild(discoverCard(d)));
  sec.append(head, grid);
  host.appendChild(sec);
}

function renderDiscoverHome(host: HTMLElement, rows: DiscoverRow[]): void {
  // FEATURED: the newest Glyphh catalog pick, else the org's newest share.
  const featured = [...rows].sort((a, b) => (a.from === b.from ? b.createdAt.localeCompare(a.createdAt) : a.from === "glyphh" ? -1 : 1))[0];
  if (featured) {
    const f = document.createElement("div");
    f.className = "disc-featured";
    f.innerHTML = `<div class="disc-featured-main"><div class="disc-featured-from"></div><div class="disc-featured-name"></div><div class="disc-featured-desc"></div></div><div class="disc-featured-art">${glyph(featured.categories[0] || "productivity", 96)}</div>`;
    (f.querySelector(".disc-featured-from") as HTMLElement).textContent = `From ${featured.author || "your organization"}`;
    (f.querySelector(".disc-featured-name") as HTMLElement).textContent = featured.name;
    (f.querySelector(".disc-featured-desc") as HTMLElement).textContent = featured.description;
    (f.querySelector(".disc-featured-main") as HTMLElement).appendChild(addButton(featured, true));
    host.appendChild(f);
  }
  const byInstalls = [...rows].sort((a, b) => b.installs - a.installs || b.createdAt.localeCompare(a.createdAt));
  shelf(host, "For you", byInstalls.filter((d) => !d.installed), () => { discoverView = { kind: "shelf", id: "all" }; renderList(); }, 6);

  // BROWSE BY CATEGORY — counts over what this member can see; "Show all" opens the rest.
  const counts = new Map<string, number>();
  for (const d of rows) for (const c of d.categories) counts.set(c, (counts.get(c) ?? 0) + 1);
  const cats = hubCategories.filter((c) => counts.get(c.id)).sort((a, b) => (counts.get(b.id)! - counts.get(a.id)!) || a.label.localeCompare(b.label));
  if (cats.length) {
    const sec = document.createElement("section");
    sec.className = "disc-shelf";
    const head = document.createElement("div");
    head.className = "disc-shelf-head";
    head.innerHTML = `<span>Browse by category</span>`;
    if (cats.length > 9) {
      const b = document.createElement("button"); b.type = "button"; b.className = "disc-link";
      b.textContent = showAllCategories ? "Show fewer ⌃" : `Show all ${cats.length} ⌄`;
      b.addEventListener("click", () => { showAllCategories = !showAllCategories; renderList(); });
      head.appendChild(b);
    }
    const grid = document.createElement("div");
    grid.className = "disc-cat-grid";
    for (const c of showAllCategories ? cats : cats.slice(0, 9)) {
      const t = document.createElement("button");
      t.type = "button";
      t.className = "disc-cat";
      t.innerHTML = `<span class="disc-cat-icon">${glyph(c.id, 22)}</span><span class="disc-cat-label"></span><span class="disc-cat-count"></span>`;
      (t.querySelector(".disc-cat-label") as HTMLElement).textContent = c.label;
      (t.querySelector(".disc-cat-count") as HTMLElement).textContent = String(counts.get(c.id));
      t.addEventListener("click", () => { discoverView = { kind: "category", id: c.id }; renderList(); });
      grid.appendChild(t);
    }
    sec.append(head, grid);
    host.appendChild(sec);
  }
  shelf(host, "New", [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), () => { discoverView = { kind: "shelf", id: "new" }; renderList(); });
  shelf(host, "Most installed", byInstalls.filter((d) => d.installs > 0), () => { discoverView = { kind: "shelf", id: "top" }; renderList(); });
}

function renderDiscoverList(host: HTMLElement, rows: DiscoverRow[]): void {
  const v = discoverView;
  let list = rows;
  let title = "Results";
  if (v.kind === "category") { list = rows.filter((d) => d.categories.includes(v.id)); title = catLabel(v.id); }
  else if (v.kind === "shelf") {
    title = v.id === "new" ? "New" : v.id === "top" ? "Most installed" : "All skills";
    list = v.id === "new" ? [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [...rows].sort((a, b) => b.installs - a.installs || a.name.localeCompare(b.name));
  }
  if (v.kind !== "home") {
    const back = document.createElement("button");
    back.type = "button";
    back.className = "disc-back";
    back.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg><span>Discover</span>`;
    back.addEventListener("click", () => { discoverView = { kind: "home" }; renderList(); });
    host.appendChild(back);
  }
  const h = document.createElement("div");
  h.className = "disc-shelf-head";
  h.innerHTML = `<span></span>`;
  (h.querySelector("span") as HTMLElement).textContent = title;
  host.appendChild(h);
  if (!list.length) { host.insertAdjacentHTML("beforeend", `<div class="crud-empty">Nothing here yet.</div>`); return; }
  for (const d of list) {
    const r = document.createElement("div");
    r.className = "disc-row";
    r.innerHTML = `<div class="skill-tile-icon">${glyph(d.categories[0] || "productivity", 18)}</div><div class="disc-row-main"><div class="disc-row-title"><span class="disc-row-name"></span></div><div class="disc-row-sub"></div></div><div class="disc-row-installs"></div>`;
    (r.querySelector(".disc-row-name") as HTMLElement).textContent = d.name;
    const titleEl = r.querySelector(".disc-row-title") as HTMLElement;
    const chips: string[] = [];
    if (isNew(d)) chips.push("New");
    if (d.categories[0]) chips.push(catLabel(d.categories[0]));
    if (d.categories.length > 1) chips.push(`+${d.categories.length - 1}`);
    for (const c of chips) { const s = document.createElement("span"); s.className = "disc-chip" + (c === "New" ? " new" : ""); s.textContent = c; titleEl.appendChild(s); }
    (r.querySelector(".disc-row-sub") as HTMLElement).textContent = `by ${d.author || "your org"} · ${d.description || "No description"}`;
    (r.querySelector(".disc-row-installs") as HTMLElement).textContent = d.installs ? `${fmtInstalls(d.installs)} installs` : "";
    r.appendChild(addButton(d, true));
    host.appendChild(r);
  }
}

async function installFrom(d: DiscoverRow, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  btn.textContent = "…";
  const r = await api().skillInstall(d.ref) as Env<{ id: string }>;
  if (!r.ok) { btn.disabled = false; btn.textContent = btn.classList.contains("skill-add-wide") ? "Add" : "+"; fail(r.error || "Install failed."); return; }
  d.installed = true;
  const list = await api().skillsList() as Env<SkillRow[]>;
  if (list.ok) skills = list.data ?? [];
  renderList();
}

async function toggle(id: string, on: boolean): Promise<void> {
  const r = await api().skillSetEnabled(id, on) as Env<SkillRow>;
  if (!r.ok) { fail(r.error || "Couldn't change that."); return; }
  const list = await api().skillsList() as Env<SkillRow[]>;
  if (list.ok) skills = list.data ?? [];
  if (current && current.id === id) { current.enabled = on; const box = el<HTMLInputElement>("skill-enabled"); if (box) box.checked = on; }
  renderList();
}

async function remove(id: string, name: string): Promise<void> {
  const sure = await confirmAction({ title: `Remove "${name}"?`, body: "The folder is removed from this machine and from every loop that used it. A shared copy on your organization's hub stays.", confirmLabel: "Remove", danger: true });
  if (!sure) return;
  const r = await api().skillDelete(id) as Env<boolean>;
  if (!r.ok) { fail(r.error || "Remove failed."); return; }
  await loadSkillsSettings();
}

async function adopt(id: string): Promise<void> {
  const r = await api().skillAdopt(id) as Env<SkillRow>;
  if (!r.ok) { fail(r.error || "Couldn't move that skill."); return; }
  await loadSkillsSettings();
  if (r.data) await openDetail(r.data.id);
}

async function replaceFiles(): Promise<void> {
  if (!current || current.source !== "glyphh") { fail("Only skills managed by Glyphh can be replaced. Use Manage in Glyphh first."); return; }
  const sure = await confirmAction({ title: `Replace "${current.name}"?`, body: "Pick a folder with a SKILL.md. Every file in this skill is replaced by that folder's files.", confirmLabel: "Choose folder" });
  if (!sure) return;
  const r = await api().skillReplace(current.id) as Env<SkillRow | null>;
  if (!r.ok) { fail(r.error || "Replace failed."); return; }
  if (r.data) await openDetail(current.id);
}

async function download(): Promise<void> {
  if (!current) return;
  const r = await api().skillDownload(current.id) as Env<string | null>;
  if (!r.ok) fail(r.error || "Download failed.");
}

type LoopRow = { id: string; name: string; icon?: string };
async function configuredLoops(): Promise<LoopRow[]> {
  const r = await (window.glyphh as unknown as { cliAgentsList?: () => Promise<{ ok: boolean; agents?: LoopRow[] }> }).cliAgentsList?.().catch(() => null);
  return r?.ok && r.agents ? r.agents : [];
}

/** A new session in the workbench: in `loop` (or the current one), rooted at
 *  `cwd` when given, with `prompt` waiting in the composer. */
function openSessionWith(opts: { loop?: string; cwd?: string; prompt: string }): void {
  closeSettingsModal();
  const w = window as unknown as { __glyphhOpenSessionWith?: (o: { loop?: string; cwd?: string; prompt: string }) => void };
  if (!w.__glyphhOpenSessionWith) { fail("The agent isn't ready yet."); return; }
  w.__glyphhOpenSessionWith(opts);
}

function tryInChat(): void {
  if (!current) return;
  openSessionWith({ prompt: `Use the "${current.name}" skill: ${current.description || "show me what it does"}.` });
}

function editWith(loop: LoopRow): void {
  if (!current) return;
  openSessionWith({
    loop: loop.id, cwd: current.dir,
    prompt: `This folder is the "${current.name}" skill (Agent Skills format: SKILL.md with name/description frontmatter, instructions below, optional scripts and references). Read it and help me improve it. Keep the format.`,
  });
}

// ── detail ──────────────────────────────────────────────────────────────────
async function openDetail(id: string): Promise<void> {
  const r = await api().skillGet(id) as Env<SkillDetail>;
  if (!r.ok || !r.data) { fail(r.error || "Couldn't open that skill."); return; }
  current = r.data;
  currentFile = "";
  editing = false;
  el("skills-list-view")?.classList.add("hidden");
  el("skill-detail-view")?.classList.remove("hidden");
  const s = current;
  (el("skill-detail-name") as HTMLElement).textContent = s.name;
  (el("skill-detail-sub") as HTMLElement).textContent = `${s.author ? `by ${s.author}` : "by you"} · updated ${when(s.updatedAt)}`;
  const box = el<HTMLInputElement>("skill-enabled"); if (box) box.checked = s.enabled;
  const share = el<HTMLButtonElement>("skill-share"); if (share) { share.textContent = "Share"; share.disabled = false; }
  (el("skill-file-count") as HTMLElement).textContent = `· ${s.files.length}`;
  (el("skill-overview-desc") as HTMLElement).textContent = s.description || "No description in the frontmatter.";
  (el("skill-author") as HTMLElement).textContent = s.author || (s.source === "glyphh" ? "You" : SOURCE_LABEL[s.source].replace("From ", ""));
  (el("skill-author-meta") as HTMLElement).textContent = s.source === "glyphh" ? "On this machine" : `Loaded by ${SOURCE_LABEL[s.source].replace("From ", "")}`;
  viewedVersion = null;
  collapsedDirs = new Set();
  paintVersions([]);
  void loadVersions();
  selectDetailTab("overview");
  renderTree();
}

function paintVersions(rows: Array<{ version: number; notes: string; createdAt: string }>): void {
  const sel = el<HTMLSelectElement>("skill-version");
  if (!sel || !current) return;
  const name = current.name;
  sel.innerHTML = [`<option value="current">${escapeHtml(name)} · current</option>`]
    .concat(rows.map((r) => `<option value="${r.version}">${escapeHtml(name)} · v${r.version}${r.createdAt ? ` · ${escapeHtml(when(r.createdAt))}` : ""}</option>`))
    .join("");
  sel.value = viewedVersion ? String(viewedVersion.version) : "current";
  sel.disabled = rows.length === 0;
  sel.title = rows.length ? "Shared versions on your organization's hub" : "Not shared yet — the folder is the only version";
}

let versionItemId: string | null = null;
async function loadVersions(): Promise<void> {
  if (!current) return;
  const id = current.id;
  const r = await api().skillVersions(id) as Env<{ itemId: string | null; versions: Array<{ version: number; notes: string; createdAt: string }> }>;
  if (!current || current.id !== id) return;
  versionItemId = r.ok ? (r.data?.itemId ?? null) : null;
  paintVersions(r.ok ? (r.data?.versions ?? []) : []);
}

async function chooseVersion(value: string): Promise<void> {
  if (!current) return;
  if (editing && !(await leaveEditing())) { paintVersionsKeep(); return; }
  if (value === "current" || !versionItemId) {
    viewedVersion = null;
    const fresh = await api().skillGet(current.id) as Env<SkillDetail>;
    if (fresh.ok && fresh.data) current = fresh.data;
  } else {
    const r = await api().skillVersionFiles(versionItemId, Number(value)) as Env<Record<string, string>>;
    if (!r.ok || !r.data) { fail(r.error || "Couldn't load that version."); return; }
    viewedVersion = { itemId: versionItemId, version: Number(value), files: r.data };
  }
  currentFile = "";
  renderTree();
  const first = filesNow().some((f) => f.path === "SKILL.md") ? "SKILL.md" : (filesNow()[0]?.path ?? "");
  await openFile(first);
}
function paintVersionsKeep(): void { const sel = el<HTMLSelectElement>("skill-version"); if (sel) sel.value = viewedVersion ? String(viewedVersion.version) : "current"; }
/** The files being browsed: the hub version's, or the folder's. */
function filesNow(): SkillFile[] {
  if (viewedVersion) return Object.keys(viewedVersion.files).sort().map((p) => ({ path: p, size: viewedVersion!.files[p].length }));
  return current?.files ?? [];
}

function selectDetailTab(t: "overview" | "contents"): void {
  document.querySelectorAll<HTMLButtonElement>(".skills-panel .skills-tab[data-dtab]").forEach((b) => b.classList.toggle("active", b.dataset.dtab === t));
  el("skill-overview")?.classList.toggle("hidden", t !== "overview");
  el("skill-contents")?.classList.toggle("hidden", t !== "contents");
  if (t === "contents" && current && !currentFile) void openFile(filesNow().some((f) => f.path === "SKILL.md") ? "SKILL.md" : (filesNow()[0]?.path ?? ""));
  if (t === "contents") editor?.layout();
}

/** Folders the user closed in this skill's tree (paths like "assets/fonts"). */
let collapsedDirs = new Set<string>();

type TreeNode = { name: string; path: string; dirs: Map<string, TreeNode>; files: SkillFile[] };
function buildTree(files: SkillFile[]): TreeNode {
  const root: TreeNode = { name: "", path: "", dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { name: part, path: node.path ? `${node.path}/${part}` : part, dirs: new Map(), files: [] });
      node = node.dirs.get(part)!;
    }
    node.files.push(f);
  }
  return root;
}

const CHEVRON = `<svg class="skill-tree-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;
const FOLDER = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>`;

function renderTree(): void {
  const host = el("skill-tree");
  if (!host || !current) return;
  host.textContent = "";
  const paint = (node: TreeNode, depth: number): void => {
    // SKILL.md first at the root, then folders, then the rest of the files.
    const files = [...node.files].sort((a, b) => (a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path.localeCompare(b.path)));
    const lead = depth === 0 ? files.filter((f) => f.path === "SKILL.md") : [];
    const rest = depth === 0 ? files.filter((f) => f.path !== "SKILL.md") : files;
    const file = (f: SkillFile): void => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "skill-tree-file" + (f.path === currentFile ? " active" : "");
      b.style.paddingLeft = `${10 + depth * 18}px`;
      b.textContent = f.path.slice(f.path.lastIndexOf("/") + 1);
      b.addEventListener("click", () => void openFile(f.path));
      host.appendChild(b);
    };
    lead.forEach(file);
    for (const dir of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const open = !collapsedDirs.has(dir.path);
      const h = document.createElement("button");
      h.type = "button";
      h.className = "skill-tree-dir" + (open ? " open" : "");
      h.style.paddingLeft = `${8 + depth * 18}px`;
      h.innerHTML = `${FOLDER}<span></span>${CHEVRON}`;
      (h.querySelector("span") as HTMLElement).textContent = dir.name;
      h.addEventListener("click", () => {
        if (collapsedDirs.has(dir.path)) collapsedDirs.delete(dir.path); else collapsedDirs.add(dir.path);
        renderTree();
      });
      host.appendChild(h);
      if (open) paint(dir, depth + 1);
    }
    rest.forEach(file);
  };
  paint(buildTree(filesNow()), 0);
}

function langFor(name: string): string {
  const ext = name.toLowerCase().split(".").pop() || "";
  const map: Record<string, string> = { js: "javascript", mjs: "javascript", ts: "typescript", json: "json", md: "markdown", yaml: "yaml", yml: "yaml", html: "html", css: "css", sh: "shell", py: "python", toml: "ini", xml: "xml", svg: "xml" };
  return map[ext] || "plaintext";
}

let monacoReady: Promise<void> | null = null;
function ensureMonaco(): Promise<void> {
  if (monacoReady) return monacoReady;
  monacoReady = new Promise<void>((resolve) => {
    const w = window as unknown as { monaco?: unknown; require: { config: (c: unknown) => void; (deps: string[], cb: () => void): void } };
    if (w.monaco) { resolve(); return; }
    w.require.config({ paths: { vs: "monaco" } });
    w.require(["vs/editor/editor.main"], () => resolve());
  });
  return monacoReady;
}

async function openFile(rel: string): Promise<void> {
  if (!current || !rel) return;
  if (editing) { const ok = await leaveEditing(); if (!ok) return; }
  currentFile = rel;
  (el("skill-file-path") as HTMLElement).textContent = `/${rel}`;
  renderTree();
  const r = viewedVersion
    ? { ok: true, data: { text: viewedVersion.files[rel] ?? "", binary: false, size: (viewedVersion.files[rel] ?? "").length } }
    : await api().skillFileRead(current.id, rel) as Env<{ text: string; binary: boolean; size: number }>;
  if (!r.ok || !r.data) { fail(r.error || "Couldn't read that file."); return; }
  const isMd = /\.(md|markdown)$/i.test(rel);
  document.querySelector<HTMLElement>(".skill-view-toggle")?.classList.toggle("hidden", !isMd);
  if (r.data.binary) {
    viewMode = "preview";
    (el("skill-file-preview") as HTMLElement).innerHTML = `<div class="crud-empty">Binary file · ${Math.round(r.data.size / 1024)} KB</div>`;
    showView("preview");
    return;
  }
  if (isMd && viewMode === "preview") {
    const { body } = splitFrontmatter(r.data.text);
    (el("skill-file-preview") as HTMLElement).innerHTML = formatMarkdown(body);
    showView("preview");
  } else {
    await ensureMonaco();
    mountEditor(r.data.text, langFor(rel));
    showView("code");
  }
}

function splitFrontmatter(text: string): { body: string } {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return { body: m ? text.slice(m[0].length) : text };
}

function showView(mode: "preview" | "code"): void {
  el("skill-file-preview")?.classList.toggle("hidden", mode !== "preview");
  el("skill-file-editor")?.classList.toggle("hidden", mode !== "code");
  el("skill-view-preview")?.classList.toggle("active", mode === "preview");
  el("skill-view-code")?.classList.toggle("active", mode === "code");
  if (mode === "code") editor?.layout();
}

function mountEditor(text: string, language: string): void {
  const host = el("skill-file-editor");
  if (!host) return;
  const w = window as unknown as { monaco: { editor: { create: (h: HTMLElement, o: Record<string, unknown>) => typeof editor; createModel: (v: string, l: string) => unknown; setModelLanguage: (m: unknown, l: string) => void }; Uri?: unknown } };
  if (!editor) {
    editor = w.monaco.editor.create(host, {
      value: text, language, readOnly: !!viewedVersion, automaticLayout: true, minimap: { enabled: false },
      fontSize: 12.5, lineNumbers: "on", scrollBeyondLastLine: false, wordWrap: "on", theme: document.documentElement.classList.contains("light") ? "vs" : "vs-dark",
    });
    (editor as unknown as { onDidChangeModelContent: (f: () => void) => void }).onDidChangeModelContent(() => {
      if (viewedVersion) return;
      editing = (editor?.getValue() ?? "") !== loadedText;
      paintEditButton();
    });
  } else {
    editor.setValue(text);
    w.monaco.editor.setModelLanguage(editor.getModel(), language);
    editor.updateOptions({ readOnly: !!viewedVersion });
  }
  loadedText = text;
  editing = false;
  paintEditButton();
}

async function leaveEditing(): Promise<boolean> {
  if (!editing) return true;
  const sure = await confirmAction({ title: "Discard changes?", body: "You have unsaved edits in this file.", confirmLabel: "Discard", danger: true });
  if (!sure) return false;
  editing = false;
  paintEditButton();
  return true;
}

/** The one button: hidden until the file differs from disk, then "Save". */
function paintEditButton(): void {
  const b = el<HTMLButtonElement>("skill-edit");
  if (!b) return;
  b.textContent = "Save";
  b.classList.toggle("hidden", !editing);
}

async function onEdit(): Promise<void> {
  if (!current || !currentFile || viewedVersion || !editing) return;
  const text = editor?.getValue() ?? "";
  const r = await api().skillFileWrite(current.id, currentFile, text) as Env<boolean>;
  if (!r.ok) { fail(r.error || "Save failed."); return; }
  loadedText = text;
  editing = false;
  paintEditButton();
  // SKILL.md changed → the name/description/body may have too.
  if (currentFile === "SKILL.md") { const id = current.id; await openDetail(id); selectDetailTab("contents"); await openFile("SKILL.md"); }
}

async function share(): Promise<void> {
  if (!current) return;
  const sure = await confirmAction({
    title: `Share "${current.name}" with your organization?`,
    body: "Its SKILL.md and files go to your organization's hub. An org admin's share goes live at once; anyone else's waits on the review desk. Members install it from Discover.",
    confirmLabel: "Share",
  });
  if (!sure) return;
  const btn = el<HTMLButtonElement>("skill-share");
  if (btn) btn.disabled = true;
  const r = await api().skillPublish(current.id) as Env<{ version: number; status: string }>;
  if (btn) btn.disabled = false;
  if (!r.ok) { fail(r.error || "Couldn't share."); return; }
  if (btn) btn.textContent = r.data?.status === "approved" ? `Shared · v${r.data.version}` : `Sent for review · v${r.data?.version}`;
}

function authorOf(s: SkillRow): string {
  return s.author || (s.source === "glyphh" ? "You" : SOURCE_LABEL[s.source].replace("From ", ""));
}

function paintControls(): void {
  const f = el("skills-filter"); const so = el("skills-sort");
  const mine = tab === "mine";
  f?.classList.toggle("hidden", !mine); so?.classList.toggle("hidden", !mine);
  f?.classList.toggle("on", !!(filterSource || filterAuthor));
  const fl = f?.querySelector("span"); if (fl) fl.textContent = filterSource || filterAuthor ? `Filter · ${[filterSource ? SOURCE_LABEL[filterSource].replace("From ", "").replace("Created by you", "You") : "", filterAuthor].filter(Boolean).join(", ")}` : "Filter";
  const sl = so?.querySelector("span"); if (sl) sl.textContent = `Sort · ${SORT_LABEL[sortKey]}`;
}

function filterMenu(): MenuItem[] {
  const authors = [...new Set(skills.map(authorOf))].sort((a, b) => a.localeCompare(b));
  const sources = SOURCE_ORDER.filter((src) => skills.some((s) => s.source === src));
  return [
    { heading: "Filter by" },
    { label: "Source", children: [
      { label: "All", checked: !filterSource, onClick: () => { filterSource = ""; renderList(); } },
      ...sources.map((src) => ({ label: src === "glyphh" ? "Glyphh" : SOURCE_LABEL[src].replace("From ", ""), checked: filterSource === src, onClick: () => { filterSource = src; renderList(); } })),
    ] },
    { label: "Created by", children: [
      { label: "All", checked: !filterAuthor, onClick: () => { filterAuthor = ""; renderList(); } },
      ...authors.map((a) => ({ label: a, checked: filterAuthor === a, onClick: () => { filterAuthor = a; renderList(); } })),
    ] },
    ...(filterSource || filterAuthor ? [{ sep: true as const }, { label: "Clear filters", onClick: () => { filterSource = ""; filterAuthor = ""; renderList(); } }] : []),
  ];
}

function sortMenu(): MenuItem[] {
  return (Object.keys(SORT_LABEL) as SortKey[]).map((k) => ({ label: SORT_LABEL[k], checked: sortKey === k, onClick: () => { sortKey = k; renderList(); } }));
}

// ── wiring ──────────────────────────────────────────────────────────────────
function wire(): void {
  if (wired) return;
  wired = true;
  el<HTMLInputElement>("skills-search")?.addEventListener("input", (e) => { query = (e.target as HTMLInputElement).value; renderList(); });
  document.querySelectorAll<HTMLButtonElement>(".skills-panel .skills-tab[data-tab]").forEach((b) => b.addEventListener("click", async () => {
    tab = b.dataset.tab as "mine" | "discover";
    discoverView = { kind: "home" };
    if (tab === "discover") await loadDiscover();
    renderList();
  }));
  el("skills-filter")?.addEventListener("click", (e) => openMenu(e.currentTarget as HTMLElement, filterMenu()));
  el("skills-sort")?.addEventListener("click", (e) => openMenu(e.currentTarget as HTMLElement, sortMenu()));
  el("skills-add")?.addEventListener("click", (e) => openMenu(e.currentTarget as HTMLElement, [
    { label: "New skill", onClick: () => void createNew() },
    { label: "Import from file…", onClick: () => void importFromFile() },
    { label: "Install from Discover", onClick: async () => { tab = "discover"; await loadDiscover(); renderList(); } },
  ]));
  el("skill-back")?.addEventListener("click", () => void loadSkillsSettings());
  document.querySelectorAll<HTMLButtonElement>(".skills-panel .skills-tab[data-dtab]").forEach((b) => b.addEventListener("click", () => selectDetailTab(b.dataset.dtab as "overview" | "contents")));
  el<HTMLInputElement>("skill-enabled")?.addEventListener("change", (e) => { if (current) void toggle(current.id, (e.target as HTMLInputElement).checked); });
  el("skill-share")?.addEventListener("click", () => void share());
  el("skill-kebab")?.addEventListener("click", async (e) => {
    if (!current) return;
    const anchor = e.currentTarget as HTMLElement;
    const loops = await configuredLoops();
    openMenu(anchor, [
      { label: "Try in chat", onClick: tryInChat },
      ...loops.map((l) => ({ label: `Edit with ${l.name}`, onClick: () => editWith(l) })),
      { label: "Replace", onClick: () => void replaceFiles() },
      { label: "Download", onClick: () => void download() },
      { label: "Show in folder", onClick: () => void api().skillReveal(current!.id) },
      { sep: true as const },
      { label: "Remove", danger: true, onClick: () => void remove(current!.id, current!.name) },
    ]);
  });
  el("skill-reveal")?.addEventListener("click", () => { if (current) void api().skillReveal(current.id); });
  el<HTMLSelectElement>("skill-version")?.addEventListener("change", (e) => void chooseVersion((e.target as HTMLSelectElement).value));
  el("skill-edit")?.addEventListener("click", () => void onEdit());
  el("skill-view-preview")?.addEventListener("click", () => { viewMode = "preview"; void openFile(currentFile); });
  el("skill-view-code")?.addEventListener("click", () => { viewMode = "code"; void openFile(currentFile); });
}

/** New skill = a session in the default loop, rooted at Glyphh's skills home,
 *  with the ask started in the composer and the cursor waiting for the rest. */
async function createNew(): Promise<void> {
  const r = await api().skillsHome() as Env<string>;
  if (!r.ok || !r.data) { fail(r.error || "Couldn't find the skills folder."); return; }
  openSessionWith({
    cwd: r.data,
    prompt: `Create a new Agent Skill in this folder: a new subfolder named after the skill with a SKILL.md (frontmatter name + description, then the instructions) and any scripts or references it needs. The skill should `,
  });
}

async function importFromFile(): Promise<void> {
  const r = await api().skillImport() as Env<SkillRow | null>;
  if (!r.ok) { fail(r.error || "Import failed."); return; }
  if (!r.data) return;
  await loadSkillsSettings();
  await openDetail(r.data.id);
}

export function loadPluginsSettings(): void {
  // Plugins land right after Skills; the panel carries its own copy for now.
}
