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

import { escapeHtml, confirmAction, promptAction } from "./shared.js";
import { closeSettingsModal } from "./navigation.js";
import { formatMarkdown } from "../format-markdown.js";

type Source = "glyphh" | "claude" | "codex" | "gemini";
interface SkillRow { id: string; source: Source; name: string; description: string; author: string; enabled: boolean; dir: string; fileCount: number; updatedAt: string }
interface SkillFile { path: string; size: number }
interface SkillDetail extends SkillRow { frontmatter: Record<string, string>; body: string; files: SkillFile[] }
interface DiscoverRow { ref: string; from: "org" | "glyphh"; id: string; slug: string; name: string; description: string; author: string; version: number | null; installed: boolean; updatedAt: string }
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
  const r = await api().skillsDiscover() as Env<DiscoverRow[]>;
  if (!r.ok) { fail(r.error || "The hub didn't answer."); discoverRows = []; return; }
  discoverRows = r.data ?? [];
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
    for (const src of SOURCE_ORDER) {
      const rows = shown.filter((s) => s.source === src);
      if (!rows.length) continue;
      const g = group(host, SOURCE_LABEL[src], rows.length);
      for (const s of rows) {
        g.appendChild(row({
          name: s.name, by: s.source === "glyphh" ? (s.author ? `by ${s.author}` : "by you") : `from ${s.author || SOURCE_LABEL[src].replace("From ", "")}`,
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
  if (!shown.length) {
    host.innerHTML = `<div class="crud-empty">${q ? `Nothing matching "${escapeHtml(q)}"` : "Nothing to discover yet — your organization hasn't published skills, and Glyphh's catalog has none your org allows."}</div>`;
    return;
  }
  for (const from of ["org", "glyphh"] as const) {
    const rows = shown.filter((d) => d.from === from);
    if (!rows.length) continue;
    const g = group(host, from === "org" ? "From your organization" : "From Glyphh", rows.length);
    for (const d of rows) {
      const action = document.createElement("button");
      action.className = "action-btn skill-add-btn";
      action.type = "button";
      action.textContent = d.installed ? "Installed" : "+";
      action.disabled = d.installed;
      action.title = d.installed ? "Already in your skills" : "Install";
      action.addEventListener("click", (e) => { e.stopPropagation(); void installFrom(d, action); });
      g.appendChild(row({ name: d.name, by: `from ${d.author || "your org"}`, desc: d.description, right: d.version ? `v${d.version}` : "", action }));
    }
  }
}

async function installFrom(d: DiscoverRow, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  btn.textContent = "…";
  const r = await api().skillInstall(d.ref) as Env<{ id: string }>;
  if (!r.ok) { btn.disabled = false; btn.textContent = "+"; fail(r.error || "Install failed."); return; }
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
  (el("skill-detail-sub") as HTMLElement).textContent = `${s.source === "glyphh" ? (s.author ? `by ${s.author}` : "by you") : `from ${s.author || SOURCE_LABEL[s.source].replace("From ", "")}`} · updated ${when(s.updatedAt)}`;
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
    if (tab === "discover") await loadDiscover();
    renderList();
  }));
  el("skills-filter")?.addEventListener("click", (e) => openMenu(e.currentTarget as HTMLElement, filterMenu()));
  el("skills-sort")?.addEventListener("click", (e) => openMenu(e.currentTarget as HTMLElement, sortMenu()));
  el("skills-add")?.addEventListener("click", (e) => openMenu(e.currentTarget as HTMLElement, [
    { label: "New skill", onClick: () => void createNew() },
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

async function createNew(): Promise<void> {
  const name = await promptAction("New skill — a folder name, lowercase; it becomes the skill's id.", "", "my-skill", "Create");
  if (!name) return;
  const r = await api().skillCreate(name) as Env<SkillRow>;
  if (!r.ok || !r.data) { fail(r.error || "Couldn't create it."); return; }
  const list = await api().skillsList() as Env<SkillRow[]>;
  if (list.ok) skills = list.data ?? [];
  await openDetail(r.data.id);
  selectDetailTab("contents");
}

export function loadPluginsSettings(): void {
  // Plugins land right after Skills; the panel carries its own copy for now.
}
