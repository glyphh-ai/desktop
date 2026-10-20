/**
 * settings-skills — Settings → Build → Skills, Apps, Tasks and Plugins (his
 * order, 2026-09-16).
 *
 * Every bundle is a FOLDER on this machine in the Agent Skills standard, read
 * straight from the CLIs' own skill directories and Glyphh's (main/skills-fs.ts).
 * The list groups them by who made them (you, Claude Code, Codex, Gemini); a
 * row opens the detail: Overview (SKILL.md rendered, the author beside it),
 * Contents (the folder's files in a Monaco viewer — preview or code, saved
 * back to disk), and whatever that kind of bundle has — its skills, tools,
 * agents, connections, and for a task its flow and runs.
 */

import { escapeHtml, confirmAction, loadingHtml } from "./shared.js";
import { onWeb } from "./web-surface.js";
import { closeSettingsModal, openSettingsModal } from "./navigation.js";
import { GLYPHH_MASCOT_SRC } from "./app-icon.js";
import { renderToolGroups } from "./settings-connections.js";
import { formatMarkdown } from "../format-markdown.js";
import { toolViewIcon } from "./tool-icons.js";
import { appIconInner } from "./app-icon.js";
import { taskGraph, renderFlow, unmountFlow } from "./lib-flow.js";
import { cronToWords, openScheduleOnLoad } from "./schedules.js";
import { renderRunList } from "./lib-runs.js";
import { renderConnectionTable, connDeps, openConnectionOnLoad, type ConnDep } from "./settings-connections.js";
import { toastOk, toastError } from "./toast.js";

type Source = "glyphh" | "app" | "plugin" | "task" | "claude" | "codex" | "gemini";
/** Every folder on this page is a skill; the TYPE says what kind of skill it
 *  is (his ruling, 2026-09-17): "this skill is an app", "this skill is a
 *  task". It is read from the bundle's own manifest (main/skills-fs.ts). */
type BundleType = "skill" | "app" | "task" | "plugin";
const TYPE_LABEL: Record<BundleType, string> = { skill: "skill", app: "app", task: "task", plugin: "plugin" };
interface SkillRow { id: string; source: Source; type: BundleType; name: string; description: string; author: string; enabled: boolean; dir: string; fileCount: number; updatedAt: string; icon?: string | null; tool?: string | null }
interface SkillFile { path: string; size: number }
interface SkillDetail extends SkillRow { frontmatter: Record<string, string>; body: string; files: SkillFile[] }
type Env<T> = { ok: boolean; data?: T; error?: string };

const SOURCE_LABEL: Record<Source, string> = { glyphh: "Created by you", app: "Created by you", plugin: "Created by you", task: "Created by you", claude: "From Claude Code", codex: "From Codex", gemini: "From Gemini" };
const SOURCE_ORDER: Source[] = ["glyphh", "app", "plugin", "task", "claude", "codex", "gemini"];
const SKILL_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>`;
const PLUGIN_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v3M15 3v3M6 6h12v5a6 6 0 0 1-12 0V6zM12 17v4"/></svg>`;
const TASK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h10M4 18h6"/><path d="m15 17 2 2 4-4"/></svg>`;
const APP_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/></svg>`;

/** ONE page, SEVERAL homes (his ruling, 2026-09-16): Skills, Apps, Tasks and
 *  Plugins share the page; an app is a skill folder plus app.json in its own home. */
export interface PageCfg {
  kind: BundleType;
  /** The homes this page lists. Defaults to its own kind; the Skills page
   *  lists tasks beside skills. */
  kinds?: BundleType[];
  /** The panel's ids: skills-* / skill-* for Skills, gapps-* / gapp-* for Apps (app-* belongs to Tabs). */
  id: (skillsId: string) => string;
  panel: string;
  noun: string;
  nouns: string;
  /** The page's mark: on every row, the detail header, and the tab. */
  icon: string;
  /** The back button's label on the detail page. */
  back: string;
}

/** The mark a bundle wears when it ships none of its own: its TYPE's, not the
 *  page's — an app among skills looks like an app (his order, 2026-09-17). */
const TYPE_ICON: Record<BundleType, string> = { skill: SKILL_ICON, app: APP_ICON, task: TASK_ICON, plugin: PLUGIN_ICON };

/** What "New …" hands the agent. The ask belongs to the KIND, not the page, so
 *  one page that lists several kinds can offer each of them. */
const NEW_PROMPT: Record<BundleType, string> = {
  skill: "Create a new Agent Skill in this folder: a new subfolder named after the skill with a SKILL.md (frontmatter name + description, then the instructions) and any scripts or references it needs. The skill should ",
  app: "Create a new Glyphh app in this folder: a new subfolder named after the app with a SKILL.md (frontmatter name + description, then what the app is for), an app.json (name, ui: ui/index.html, tools: tools/manifest.json, dependencies on connections, screenshots), the app's face in ui/index.html and its tools in tools/manifest.json ({ tools: [{ name, description }] }). The app should ",
  plugin: "Create a new Claude Code plugin in this folder: a new subfolder named after the plugin with .claude-plugin/plugin.json (name, description, version), a README.md, and any skills/<name>/SKILL.md, commands/, agents/, hooks/ or .mcp.json it needs. The plugin should ",
  task: "Create a new Glyphh task in this folder: a new subfolder named after the task with a SKILL.md (frontmatter name + description, then what the task does and when to run it), a task.json (name, program: run.js, slots the program calls agents through, dependencies on connections, an optional five-field cron schedule) and run.js exporting async function run(ctx, input) that returns the result. The program is the process: it drives the logic itself and uses ctx.agents.<slot>.run(prompt, {schema}) only where an agent is needed, ctx.connections.<app>.call(tool, args) for connections, ctx.data(repo).exec(sql, params) for app data, ctx.route(state, branches, {minConfidence, fallback}) or ctx.decide(state, questions) for a deterministic Jev decision (no prose, through GlyphhRouter) instead of asking an agent to classify, and ctx.checkpoint(key, fn) around anything worth not redoing after a restart. The task should ",
};

export function createLibraryPage(cfg: PageCfg) {
let wired = false;
let query = "";
/** List controls: filter by origin and author; sort order. */
let filterSource: Source | "" = "";
let filterAuthor = "";
/** List control: show only one type of skill (app, task, …). */
let filterType: BundleType | "" = "";
type SortKey = "edited" | "name" | "author";
let sortKey: SortKey = "edited";
const SORT_LABEL: Record<SortKey, string> = { edited: "Last edited", name: "Name", author: "Created by" };
let skills: SkillRow[] = [];
let current: SkillDetail | null = null;
let currentFile = "";
let viewMode: "preview" | "code" = "preview";
let editing = false;
/** The file text as loaded from disk; the editor is dirty when it differs. */
let loadedText = "";
let editor: { getValue(): string; setValue(v: string): void; updateOptions(o: Record<string, unknown>): void; layout(): void; dispose(): void; getModel(): unknown } | null = null;

const el = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.getElementById(cfg.id(id)) as T | null;
const api = () => window.glyphh;
/** What this page lists, and what an item IS — every per-item call rides the
 *  item's own type, never the page's (a mixed list has both). */
const KINDS: BundleType[] = cfg.kinds ?? [cfg.kind];
const typeOf = (s: { type?: BundleType } | null | undefined): BundleType => s?.type ?? cfg.kind;
/** The type reads as a chip only when it is NOT what this page is already
 *  about — a plain skill on Skills says nothing, a task among them says "task". */
const typeChip = (type: BundleType | undefined): string =>
  type && type !== cfg.kind ? `<span class="skill-type-chip">${escapeHtml(TYPE_LABEL[type])}</span>` : "";
/** Where the user finds each kind — the line a toast reads back after a write. */
const WHERE_TO_SEE: Record<BundleType, string> = {
  skill: "Settings → Build → Skills (type Skill)",
  app: "Settings → Build → Apps",
  task: "Settings → Build → Skills (type Task); put it on a clock under Customize → Schedules",
  plugin: "Settings → Build → Plugins",
};
/** The mark a bundle wears: the icon.svg it ships, else the built-in panel it
 *  IS, else its type's. The middle step matters for the work-panel apps —
 *  Design, Slides, Drive and the media panels are those panels, and many of
 *  them carry no icon.svg at all.
 *  THE GLYPHH BUNDLE WEARS THE MASCOT (his order, 2026-09-17), through the
 *  same resolver every app row uses — `appIconInner` answers the brand mark
 *  for slug "glyphh", so the skill and the app are one identity and nothing
 *  here hand-rolls a second path to that image. */
const isGlyphhBundle = (s: { id?: string; slug?: string; name?: string } | null | undefined): boolean => {
  const slug = (s?.slug || (s?.id ? s.id.slice(s.id.indexOf(":") + 1) : "") || s?.name || "").toLowerCase().trim();
  return slug === "glyphh";
};
const markOf = (s: { icon?: string | null; tool?: string | null; id?: string; slug?: string; name?: string } | null | undefined): string =>
  isGlyphhBundle(s) ? appIconInner({ slug: "glyphh" }, s?.name || "Glyphh", "skill-icon-initial")
    : (s?.icon && s.icon.includes("<svg") ? s.icon : (s?.tool ? toolViewIcon(s.tool) : ""));
const iconOf = (mark: string, type?: BundleType): string => mark || TYPE_ICON[type ?? cfg.kind];

/** The name, with the type beside it (never under it — his order, 2026-09-17). */
const setDetailName = (name: string, type?: BundleType): void => {
  const host = el("skill-detail-name");
  if (!host) return;
  host.innerHTML = `<span class="skill-detail-title"></span>${typeChip(type)}`;
  (host.querySelector(".skill-detail-title") as HTMLElement).textContent = name;
};
const setDetailIcon = (row: { icon?: string | null; tool?: string | null; type?: BundleType; id?: string; slug?: string; name?: string } | null | undefined): void => {
  const mark = markOf(row);
  document.querySelectorAll<HTMLElement>(`${cfg.panel} .skill-tile-icon.lg`).forEach((n) => {
    n.innerHTML = iconOf(mark, row?.type);
    n.classList.toggle("own", !!mark);
  });
};

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const days = (Date.now() - d.getTime()) / 86_400_000;
  if (days < 1) return "today";
  if (days < 7) return `${Math.floor(days)}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** ONE PATTERN FOR WHAT JUST HAPPENED (his order, 2026-09-17): the toast
 *  stack, top right, above the settings overlay. The page's own error row is
 *  gone — it lived under whatever the user was reading and said nothing at all
 *  when an action worked. */
function fail(msg: string): void {
  toastError(msg);
}

function notice(msg: string, opts?: { detail?: string }): void {
  toastOk(msg, opts);
}

// ── list ────────────────────────────────────────────────────────────────────
async function loadSkillsSettings(): Promise<void> {
  wire();
  el("skill-detail-view")?.classList.add("hidden");
  el("skills-list-view")?.classList.remove("hidden");
  if (!skills.length) { const h = el("skills-groups"); if (h) h.innerHTML = loadingHtml(`Loading your ${cfg.nouns}…`); }
  const r = await api().skillsList(KINDS) as Env<SkillRow[]>;
  if (!r.ok) { fail(r.error || `Couldn't read your ${cfg.nouns}.`); return; }
  skills = r.data ?? [];
  renderList();
}

type MenuItem = { label: string; danger?: boolean; checked?: boolean; onClick: () => void } | { sep: true } | { heading: string } | { label: string; children: MenuItem[] };
function row(opts: { name: string; by: string; desc: string; right: string; onOpen?: () => void; menu?: MenuItem[]; icon?: string | null; tool?: string | null; type?: BundleType }): HTMLElement {
  const mark = markOf(opts);
  const r = document.createElement("div");
  r.className = "skill-row" + (opts.onOpen ? " openable" : "");
  r.innerHTML = `<div class="skill-tile-icon${mark ? " own" : ""}">${iconOf(mark, opts.type)}</div>
    <div class="skill-row-main">
      <div class="skill-row-name"><span class="skill-row-title"></span>${typeChip(opts.type)}</div>
      <div class="skill-row-sub"><span class="skill-row-by"></span><span class="skill-row-dot">·</span><span class="skill-row-desc"></span></div>
    </div>
    <div class="skill-row-right"></div>`;
  (r.querySelector(".skill-row-title") as HTMLElement).textContent = opts.name;
  (r.querySelector(".skill-row-by") as HTMLElement).textContent = opts.by;
  (r.querySelector(".skill-row-desc") as HTMLElement).textContent = opts.desc || "No description";
  const right = r.querySelector(".skill-row-right") as HTMLElement;
  const date = document.createElement("span");
  date.className = "skill-row-date";
  date.textContent = opts.right;
  right.appendChild(date);
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
  const q = query.trim().toLowerCase();
  const hit = (s: string) => !q || s.toLowerCase().includes(q);
  const shown = skills
    .filter((s) => hit(`${s.name} ${s.description} ${s.author}`))
    .filter((s) => !filterSource || s.source === filterSource)
    .filter((s) => !filterType || s.type === filterType)
    .filter((s) => !filterAuthor || authorOf(s) === filterAuthor)
    .sort((a, b) => sortKey === "name" ? a.name.localeCompare(b.name) : sortKey === "author" ? authorOf(a).localeCompare(authorOf(b)) || a.name.localeCompare(b.name) : b.updatedAt.localeCompare(a.updatedAt));
  const count = el("skills-count"); if (count) count.textContent = `${shown.length} ${shown.length === 1 ? cfg.noun : cfg.nouns}`;
  paintControls();
  if (!shown.length) {
    host.innerHTML = `<div class="crud-empty">${q ? `No ${cfg.nouns} matching "${escapeHtml(q)}"` : `No ${cfg.nouns} yet. Add one, or import a folder or zip.`}</div>`;
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
        desc: s.description, right: when(s.updatedAt), icon: s.icon, tool: s.tool, type: s.type,
        onOpen: () => void openDetail(s.id),
        menu: [
          { label: s.enabled ? "Turn off" : "Turn on", onClick: () => void toggle(s.id, !s.enabled) },
          ...(s.source !== "glyphh" && s.source !== "app" ? [{ label: "Manage in Glyphh", onClick: () => void adopt(s.id) }] : []),
          { sep: true as const },
          { label: "Remove", danger: true, onClick: () => void remove(s.id, s.name) },
        ],
      }));
      if (!s.enabled) (g.lastElementChild as HTMLElement).classList.add("disabled");
    }
  }
}

async function toggle(id: string, on: boolean): Promise<void> {
  const r = await api().skillSetEnabled(id, on) as Env<SkillRow>;
  if (!r.ok) { fail(r.error || "Couldn't change that."); return; }
  const list = await api().skillsList(KINDS) as Env<SkillRow[]>;
  if (list.ok) skills = list.data ?? [];
  if (current && current.id === id) { current.enabled = on; const box = el<HTMLInputElement>("skill-enabled"); if (box) box.checked = on; }
  const row = (list.ok ? list.data ?? [] : []).find((x) => x.id === id);
  notice(`${row?.name ?? "That"} turned ${on ? "on" : "off"}`, on ? undefined : { detail: "The folder stays; every loop stops seeing it." });
  renderList();
}

async function remove(id: string, name: string): Promise<void> {
  const sure = await confirmAction({ title: `Remove "${name}"?`, body: "The folder is removed from this machine and from every loop that used it.", confirmLabel: "Remove", danger: true });
  if (!sure) return;
  const r = await api().skillDelete(id) as Env<boolean>;
  if (!r.ok) { fail(r.error || "Remove failed."); return; }
  notice(`${name} removed`);
  await loadSkillsSettings();
}

async function adopt(id: string): Promise<void> {
  const r = await api().skillAdopt(id) as Env<SkillRow>;
  if (!r.ok) { fail(r.error || "Couldn't move that skill."); return; }
  notice(`${r.data?.name ?? "It"} is managed by Glyphh now`, { detail: "Every loop on this machine reads it from one folder." });
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

/** A new session in the workbench: in `loop` (or the current one), rooted at
 *  `cwd` when given, with `prompt` waiting in the composer. */
function openSessionWith(opts: { loop?: string; cwd?: string; prompt: string }): void {
  closeSettingsModal();
  // On the web this page is a full-screen panel, not the modal: it must step
  // aside or the session opens behind it (his report, 2026-10-05: the plugin
  // menu's items "do nothing").
  if (onWeb()) (window as unknown as { __wbCloseWebFullPanel?: () => void }).__wbCloseWebFullPanel?.();
  const w = window as unknown as { __glyphhOpenSessionWith?: (o: { loop?: string; cwd?: string; prompt: string }) => void };
  if (!w.__glyphhOpenSessionWith) { fail("The agent isn't ready yet."); return; }
  w.__glyphhOpenSessionWith(opts);
}

function tryInChat(): void {
  if (!current) return;
  openSessionWith({ prompt: `Use the "${current.name}" skill: ${current.description || "show me what it does"}.` });
}

function editWith(): void {
  if (!current) return;
  openSessionWith({
    cwd: current.dir,
    prompt: `This folder is the "${current.name}" skill (Agent Skills format: SKILL.md with name/description frontmatter, instructions below, optional scripts and references). Read it and help me improve it. Keep the format.`,
  });
}

// ── detail ──────────────────────────────────────────────────────────────────
/** The header's actions beside the enabled switch and the ⋮: a task's Run now. */
function paintDetailChrome(): void {
  el("skill-edit")?.classList.add("hidden");
  // Resolved every time: a mixed list moves between a task and a skill, and a
  // stale Run now must not survive the move.
  let run = el<HTMLButtonElement>("skill-run-now");
  if (!run && typeOf(current) === "task") {
    run = document.createElement("button");
    run.id = cfg.id("skill-run-now");
    run.type = "button";
    run.className = "action-btn primary";
    run.textContent = "Run now";
    const self = run;
    run.addEventListener("click", () => void runNow(self));
    el("skill-enabled")?.closest(".skills-switch")?.before(run);
  }
  run?.classList.toggle("hidden", !current || typeOf(current) !== "task");
}

/** TASKS: start a run and land on its story. */
async function runNow(btn: HTMLButtonElement): Promise<void> {
  if (!current) return;
  btn.disabled = true;
  const slug = current.id.replace(/^task:/, "");
  const r = await (api() as unknown as { taskRun: (slug: string, input?: unknown) => Promise<Env<{ id: string }>> }).taskRun(slug, {}).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) })) as Env<{ id: string }>;
  btn.disabled = false;
  if (!r.ok) { fail(r.error || "Couldn't start the run."); return; }
  openRunId = r.data?.id ?? null;
  selectDetailTab("runs");
}

function parseFrontmatter(text: string): { frontmatter: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { frontmatter: {}, body: text };
  const fm: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) { const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line); if (kv) fm[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, ""); }
  return { frontmatter: fm, body: text.slice(m[0].length) };
}

/** The graph behind the Flow tab, rebuilt whenever a detail is opened. */
let flowGraph: Parameters<typeof renderFlow>[1] | null = null;
function paintFlow(): void {
  const host = el("skill-flow-host");
  if (!host) return;
  if (!flowGraph) { host.innerHTML = `<div class="crud-empty">Nothing to draw yet.</div>`; return; }
  void renderFlow(host, flowGraph);
}

/** What the bundle's manifest declares, on the tabs its kind earns: a
 *  plugin's skills; a task's flow, agents, connections, runs and schedule; an
 *  app's screenshots (on the Overview), skills, tools and connections. All of
 *  it is read from the folder. */
async function paintExtras(s: SkillDetail): Promise<void> {
  const host = el("skill-overview-extra");
  if (!host) return;
  host.textContent = "";
  const flowHost = el("skill-flow-host");
  if (flowHost) { unmountFlow(flowHost); flowHost.textContent = ""; }
  flowGraph = null;
  const type = typeOf(s);
  if (type === "skill") return;
  const read = async (rel: string): Promise<string> => {
    const r = await api().skillFileRead(s.id, rel) as Env<{ text: string; binary: boolean }>;
    return r.ok && r.data && !r.data.binary ? r.data.text : "";
  };
  void paintBundleAgents(s);
  if (type === "plugin") { await paintBundleSkills(s, read); return; }
  if (type === "task") {
    let tm: { slots?: Record<string, { label?: string; description?: string; agent?: string | null; model?: string | null }>; dependencies?: { connections?: Array<ConnDep | string> }; schedule?: string | null; program?: string; result?: unknown } = {};
    try { tm = JSON.parse(await read("task.json") || "{}"); } catch { tm = {}; }
    // The FLOW tab's picture is built from the same read: the manifest, plus
    // the program itself (lib-flow scans it for the seams it reaches through ctx).
    void read(tm.program || "run.js").then((code) => {
      flowGraph = taskGraph(s.name, tm, code || "");
      if (!el("skill-flow")?.classList.contains("hidden")) paintFlow();
    });
    await Promise.all([paintBundleAgents(s), paintBundleConnections(tm.dependencies?.connections ?? [])]);
    void paintTaskRuns(s);
    void paintTaskSchedule(s, tm.schedule ?? null);
    return;
  }
  // THE APP'S MANIFEST: manifest.json — the bundle's, inline tools — else the
  // app.json authoring form, whose `tools` names a file.
  let manifest: { screenshots?: Array<string | { path: string; caption?: string }>; dependencies?: { connections?: Array<ConnDep | string> }; connectors?: string[]; ui?: string; tools?: string | Array<{ name: string; description?: string }> } = {};
  try { manifest = JSON.parse(await read("manifest.json") || await read("app.json") || "{}"); } catch { manifest = {}; }
  const shots = (manifest.screenshots ?? []).map((x) => (typeof x === "string" ? { path: x, caption: "" } : { path: x.path, caption: x.caption || "" }));
  const fromFolder = s.files.filter((f) => /^screenshots\/.*\.(png|jpe?g|gif|webp|svg)$/i.test(f.path)).map((f) => ({ path: f.path, caption: "" }));
  const gallery = shots.length ? shots : fromFolder;
  if (gallery.length) {
    const g = document.createElement("div");
    g.className = "app-gallery";
    g.innerHTML = `<div class="skill-overview-label">Screenshots</div><div class="app-gallery-main"><img alt="" /><div class="app-gallery-caption"></div></div><div class="app-gallery-thumbs"></div>`;
    const main = g.querySelector("img") as HTMLImageElement;
    const cap = g.querySelector(".app-gallery-caption") as HTMLElement;
    const thumbs = g.querySelector(".app-gallery-thumbs") as HTMLElement;
    const urls = await Promise.all(gallery.map(async (shot) => {
      const r = await api().skillImage(s.id, shot.path) as Env<string>;
      return r.ok ? (r.data || "") : "";
    }));
    const show = (i: number): void => { main.src = urls[i]; cap.textContent = gallery[i].caption; thumbs.querySelectorAll("img").forEach((t, j) => t.classList.toggle("active", i === j)); };
    urls.forEach((u, i) => { if (!u) return; const t = document.createElement("img"); t.src = u; t.alt = gallery[i].caption; t.addEventListener("click", () => show(i)); thumbs.appendChild(t); });
    const first = urls.findIndex(Boolean);
    if (first >= 0) { show(first); host.appendChild(g); }
  }
  await Promise.all([
    paintBundleSkills(s, read),
    paintBundleTools(s, read, Array.isArray(manifest.tools) ? manifest.tools : (manifest.tools || "tools/manifest.json")),
    paintBundleConnections(manifest.dependencies?.connections ?? manifest.connectors ?? []),
  ]);
}

/**
 * TASKS: the clock, on the task itself (his question, 2026-09-17: "where is it
 * supposed to live? Where can the user change it?").
 *
 * A schedule lives in ONE place — Settings → Customize → Schedules — and that
 * page is the only thing that fires. What a task's manifest carries is an
 * INTENT, which means nothing until it is a row there, so the Overview says
 * which of the two it is and hands over the door: put it on the clock, or open
 * the page that owns it.
 */
async function paintTaskSchedule(s: SkillDetail, manifestCron: string | null): Promise<void> {
  const host = el("skill-overview-extra");
  if (!host) return;
  const slug = s.id.slice(s.id.indexOf(":") + 1);
  const r = await api().schedulesList() as Env<ScheduleRow[]>;
  const row = (r.ok ? r.data ?? [] : []).find((x) => x.kind === "task" && x.target === slug) ?? null;

  const block = document.createElement("div");
  block.className = "skill-overview-block";
  block.innerHTML = `<div class="skill-overview-label">Schedule</div><div class="skill-sched-line"><span class="skill-sched-actions"></span></div>`;
  const actions = block.querySelector(".skill-sched-actions") as HTMLElement;

  // THE SAME CONTROL AS THE AGENTS TAB (his order, 2026-09-17): one button
  // that reads the schedule and opens the same modal. Clicking the schedule
  // itself goes to its own page, where the history is.
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "action-btn";
  const words = row ? cronToWords(row.cron) : manifestCron ? cronToWords(manifestCron) : "";
  btn.textContent = row
    ? (row.enabled ? words.charAt(0).toUpperCase() + words.slice(1) : `Paused · ${words}`)
    : manifestCron ? `Asks for ${words}` : "Schedule";
  btn.title = row ? "Change when this runs" : "Put this on the clock";
  const stub: BundleAgentRow = { ref: "", name: s.name, description: "", loop: "", model: "", source: "slot" };
  btn.addEventListener("click", () => openScheduleModal(s, stub, row));
  actions.appendChild(btn);

  if (row) {
    const open = document.createElement("button");
    open.type = "button";
    open.className = "skill-sched-open";
    open.textContent = "Open schedule";
    open.title = "Its page, with every run";
    open.addEventListener("click", () => { openScheduleOnLoad(row.id); openSettingsModal("schedules"); });
    actions.appendChild(open);
  }
  host.appendChild(block);
}

/**
 * A BUNDLE'S AGENTS (his order, 2026-09-17: "slots become agents").
 *
 * One row per agent the bundle ships — `agents/*.md` per the standard, or a
 * task's slots, which are the same thing under an older name. Far left the
 * mark of what runs it, then its name and description, and on the right the
 * two things a person changes: which model, and its clock.
 */
/** Every agent runs on the Glyphh loop (2026-09-28), so every row wears the
 *  same face the agent tile does. */
const loopMark = (_id: string): string => `<img src="${GLYPHH_MASCOT_SRC}" alt="" />`;

const DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

/**
 * THE CLOCK, BUILT FROM DROPDOWNS (his order, 2026-09-17) — nobody should
 * have to write cron. How often, what time, which day; the cron is composed
 * from those three and saved as the schedule this bundle runs on.
 */
function openScheduleModal(s: SkillDetail, a: BundleAgentRow, existing: ScheduleRow | null): void {
  const slug = s.id.slice(s.id.indexOf(":") + 1);
  const isTask = typeOf(s) === "task";
  const [min0 = "0", hour0 = "9", , , dow0 = "*"] = (existing?.cron || "0 9 * * *").split(/\s+/);
  const every = existing ? (hour0 === "*" ? "hour" : dow0 === "1-5" ? "weekday" : /^[0-6]$/.test(dow0) ? "week" : "day") : "day";

  const wrap = document.createElement("div");
  wrap.className = "conn-modal skill-sched-modal";
  wrap.innerHTML = `<div class="conn-modal-backdrop"></div><div class="conn-modal-panel skill-sched-panel">
    <div class="conn-modal-header"><h3 class="conn-modal-title">Schedule ${escapeHtml(s.name)}</h3><button class="conn-modal-close" type="button">✕</button></div>
    <div class="skill-sched-form">
      <label class="skill-sched-field"><span>How often</span><select class="settings-input" data-k="every">
        <option value="hour">Every hour</option><option value="day">Every day</option>
        <option value="weekday">Every weekday</option><option value="week">Once a week</option>
      </select></label>
      <label class="skill-sched-field"><span>At</span><select class="settings-input" data-k="hour">${
        Array.from({ length: 24 }, (_, h) => `<option value="${h}">${h % 12 === 0 ? 12 : h % 12}${h < 12 ? "am" : "pm"}</option>`).join("")
      }</select></label>
      <label class="skill-sched-field"><span>Minutes past</span><select class="settings-input" data-k="min">${
        [0, 15, 30, 45].map((m) => `<option value="${m}">:${String(m).padStart(2, "0")}</option>`).join("")
      }</select></label>
      <label class="skill-sched-field" data-day><span>Day</span><select class="settings-input" data-k="dow">${
        DAYS.map((d, i) => `<option value="${i}">${d}</option>`).join("")
      }</select></label>
      <div class="skill-sched-preview"></div>
    </div>
    <div class="skill-sched-actions-row">
      ${existing ? `<button class="action-btn danger" data-a="off" type="button">Take off the clock</button>` : ""}
      <span style="flex:1"></span>
      <button class="action-btn" data-a="cancel" type="button">Cancel</button>
      <button class="action-btn primary" data-a="save" type="button">Save</button>
    </div>
  </div>`;
  document.body.appendChild(wrap);
  const q = <T extends HTMLElement = HTMLElement>(sel: string): T => wrap.querySelector(sel) as T;
  const everySel = q<HTMLSelectElement>('[data-k="every"]');
  const hourSel = q<HTMLSelectElement>('[data-k="hour"]');
  const minSel = q<HTMLSelectElement>('[data-k="min"]');
  const dowSel = q<HTMLSelectElement>('[data-k="dow"]');
  everySel.value = every;
  hourSel.value = hour0 === "*" ? "9" : hour0;
  minSel.value = /^\d+$/.test(min0) ? String(Math.min(45, Math.round(Number(min0) / 15) * 15)) : "0";
  dowSel.value = /^[0-6]$/.test(dow0) ? dow0 : "1";

  const cronOf = (): string => {
    const m = minSel.value, h = hourSel.value;
    if (everySel.value === "hour") return `${m} * * * *`;
    if (everySel.value === "weekday") return `${m} ${h} * * 1-5`;
    if (everySel.value === "week") return `${m} ${h} * * ${dowSel.value}`;
    return `${m} ${h} * * *`;
  };
  const sync = (): void => {
    q('[data-day]').classList.toggle("hidden", everySel.value !== "week");
    q<HTMLElement>('[data-k="hour"]').closest(".skill-sched-field")!.classList.toggle("hidden", everySel.value === "hour");
    const preview = q(".skill-sched-preview");
    preview.textContent = `Runs ${cronToWords(cronOf())}.`;
    preview.title = cronOf();
  };
  [everySel, hourSel, minSel, dowSel].forEach((el2) => el2.addEventListener("change", sync));
  sync();

  const close = (): void => { document.removeEventListener("keydown", onKey); wrap.remove(); };
  const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  document.addEventListener("keydown", onKey);
  q(".conn-modal-backdrop").addEventListener("click", close);
  q(".conn-modal-close").addEventListener("click", close);
  q('[data-a="cancel"]').addEventListener("click", close);
  wrap.querySelector('[data-a="off"]')?.addEventListener("click", async () => {
    if (!existing) return;
    const r = await api().scheduleDelete(existing.id) as Env<unknown>;
    if (!r.ok) { fail(r.error || "Couldn't remove the schedule."); return; }
    notice(`${s.name} is off the clock`);
    close();
    void paintBundleAgents(s);
  });
  q('[data-a="save"]').addEventListener("click", async () => {
    const cron = cronOf();
    const input: Record<string, unknown> = existing
      ? { id: existing.id, kind: existing.kind, target: existing.target, cron, name: existing.name ?? s.name, agentId: existing.agentId }
      : { kind: isTask ? "task" : "skill", target: slug, cron, name: s.name, ...(isTask ? {} : { agentId: a.loop }) };
    const r = await (api() as unknown as { scheduleSave: (i: unknown) => Promise<Env<{ id: string }>> }).scheduleSave(input)
      .catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }) as Env<{ id: string }>);
    if (!r.ok) { fail(r.error || "Couldn't save the schedule."); return; }
    notice(`${s.name} runs ${cronToWords(cron)}`, { detail: "Change or remove it here, or under Customize → Schedules." });
    close();
    void paintBundleAgents(s);
  });
}

async function paintBundleAgents(s: SkillDetail): Promise<void> {
  const host = el("skill-agents-list"); const count = el("skill-agent-count");
  if (!host) return;
  const [env, scheds, rosterEnv] = await Promise.all([
    api().skillAgents(s.id) as Promise<Env<BundleAgentRow[]>>,
    api().schedulesList() as Promise<Env<ScheduleRow[]>>,
    (api().libraryAgentsList() as Promise<Env<RosterAgentRow[]>>).catch((): Env<RosterAgentRow[]> => ({ ok: false })),
  ]);
  const agents = env.ok ? env.data ?? [] : [];
  const roster: RosterAgentRow[] = rosterEnv.ok && Array.isArray(rosterEnv.data) ? rosterEnv.data : [];
  const slug = s.id.slice(s.id.indexOf(":") + 1);
  const rows = scheds.ok ? scheds.data ?? [] : [];
  const isTask = typeOf(s) === "task";

  if (count) count.textContent = `· ${agents.length}`;
  tabHasContent("agents", agents.length);
  host.textContent = "";
  if (!agents.length) {
    host.innerHTML = `<div class="crud-empty">No agents.</div>`;
    return;
  }

  for (const a of agents) {
    const sched = isTask
      ? rows.find((x) => x.kind === "task" && x.target === slug) ?? null
      : rows.find((x) => x.kind === "skill" && x.target === slug && x.agentId === a.loop) ?? null;
    const r = document.createElement("div");
    r.className = "skill-row";
    r.innerHTML = `<div class="skill-tile-icon own">${loopMark(a.loop)}</div><div class="skill-row-main"><div class="skill-row-name"></div><div class="skill-row-sub"><span class="skill-row-desc"></span></div></div><div class="skill-row-right"></div>`;
    (r.querySelector(".skill-row-name") as HTMLElement).textContent = a.name;
    (r.querySelector(".skill-row-desc") as HTMLElement).textContent = a.description;
    const right = r.querySelector(".skill-row-right") as HTMLElement;
    // WHICH AGENT (his order, 2026-10-07: tasks define cli or glyphh agents
    // with models) — a task slot picks one of your agents, Glyphh or
    // CLI; the first option is the default Glyphh agent (an unbound slot).
    if (a.source === "slot") {
      const agentSel = document.createElement("select");
      agentSel.className = "settings-input skill-agent-select";
      agentSel.title = "Agent for this slot";
      agentSel.innerHTML = `<option value="">Default Glyphh agent</option>${a.loop ? `<option value="${escapeHtml(a.loop)}" selected>${escapeHtml(a.loop)}</option>` : ""}`;
      agentSel.addEventListener("change", () => {
        const picked = roster.find((x) => x.id === agentSel.value || x.slug === agentSel.value);
        void setAgent(s, a, { loop: agentSel.value }, `${a.name} runs as ${picked ? agentLabel(picked) : "the default Glyphh agent"}`);
      });
      right.appendChild(agentSel);
      fillAgentChoices(agentSel, a.loop, roster);
    }

    // WHICH MODEL — the slot's own; it beats the agent's.
    const modelSel = document.createElement("select");
    modelSel.className = "settings-input skill-model-select";
    modelSel.title = "Model for this agent";
    modelSel.innerHTML = `<option value="">Model: default</option>${a.model ? `<option value="${escapeHtml(a.model)}" selected>${escapeHtml(a.model)}</option>` : ""}`;
    modelSel.addEventListener("change", () => void setAgent(s, a, { model: modelSel.value }, `${a.name} uses ${modelSel.value || "the default model"}`));
    right.appendChild(modelSel);
    void fillModelChoices(modelSel, a.model);

    // ITS CLOCK.
    const schedBtn = document.createElement("button");
    schedBtn.type = "button";
    schedBtn.className = "action-btn";
    const words = sched ? cronToWords(sched.cron) : "";
    schedBtn.textContent = sched ? (sched.enabled ? words.charAt(0).toUpperCase() + words.slice(1) : `Paused · ${words}`) : "Schedule";
    schedBtn.addEventListener("click", () => openScheduleModal(s, a, sched));
    right.appendChild(schedBtn);

    host.appendChild(r);
  }
}

interface AgentModelRow { id: string; name: string; providerSlug: string }
let agentModels: Promise<AgentModelRow[]> | null = null;

function agentLabel(a: RosterAgentRow): string {
  return a.name;
}

/** Your agents (Settings → Build → Agents), each labelled by its lane. */
function fillAgentChoices(sel: HTMLSelectElement, chosen: string, roster: RosterAgentRow[]): void {
  const rows = roster.slice().sort((a, b) => a.name.localeCompare(b.name));
  const options = [`<option value="">Default Glyphh agent</option>`];
  // A binding to an agent that is gone stays visible, so the row says what it names.
  if (chosen && !rows.some((a) => a.id === chosen || a.slug === chosen)) options.push(`<option value="${escapeHtml(chosen)}" selected>${escapeHtml(chosen)} (missing)</option>`);
  for (const a of rows) options.push(`<option value="${escapeHtml(a.id)}"${a.id === chosen || a.slug === chosen ? " selected" : ""}>${escapeHtml(agentLabel(a))}</option>`);
  sel.innerHTML = options.join("");
  sel.title = "Agent for this slot";
}

/**
 * THE SAME LIST AS EVERY OTHER PICKER (his order, 2026-10-04): the models the
 * Glyphh loop can run, as main's loop-models.ts answers them, so a slot never
 * names a model the turn would then be refused on.
 */
async function fillModelChoices(sel: HTMLSelectElement, chosen: string): Promise<void> {
  if (!agentModels) {
    agentModels = Promise.resolve(api().loopModels?.("glyphh"))
      .then((r) => (r?.ok && Array.isArray(r.models) ? r.models : []))
      .catch(() => []);
  }
  const models = [...await agentModels].sort((a, b) => a.name.localeCompare(b.name));
  const options = [`<option value="">Model: default</option>`];
  // A model the agent already names survives even when the model list moved on.
  if (chosen && !models.some((m) => m.id === chosen)) options.push(`<option value="${escapeHtml(chosen)}" selected>${escapeHtml(chosen)}</option>`);
  for (const m of models) options.push(`<option value="${escapeHtml(m.id)}"${m.id === chosen ? " selected" : ""}>${escapeHtml(m.name)}</option>`);
  sel.innerHTML = options.join("");
  sel.disabled = models.length === 0 && !chosen;
  sel.title = "Model for this agent";
}

interface TaskRunRow { id: string; trigger: string; startedAt: string; durationMs: number | null; status: string; error: string | null; input: unknown; result: unknown; journal: { checkpoints: Record<string, unknown>; events: Array<Record<string, unknown> & { t: string; kind: string }> } }
let openRunId: string | null = null;

async function setAgent(s: SkillDetail, a: BundleAgentRow, patch: { loop?: string; model?: string }, said: string): Promise<void> {
  const r = await api().skillAgentSet(s.id, a.ref, patch) as Env<BundleAgentRow[]>;
  if (!r.ok) { fail(r.error || "Couldn't change that agent."); return; }
  notice(said);
  void paintBundleAgents(s);
}

async function paintTaskRuns(s: SkillDetail): Promise<void> {
  const host = el("skill-runs-list"); const count = el("skill-run-count");
  if (!host) return;
  const slug = s.id.replace(/^task:/, "");
  const r = (await (api() as unknown as { taskRuns: (slug: string) => Promise<Env<TaskRunRow[]>> }).taskRuns(slug).catch(() => ({ ok: false }))) as Env<TaskRunRow[]>;
  if (!host.isConnected || current?.id !== s.id) return;
  const runs = r.ok ? r.data ?? [] : [];
  if (count) count.textContent = runs.length ? `· ${runs.length}` : "";
  tabHasContent("runs", runs.length);
  // ONE RENDERER (lib-runs.ts): the schedule's Run history draws the same rows.
  renderRunList(host, runs, {
    empty: r.ok ? "No runs." : (r.error || "Couldn't load runs."),
    openId: openRunId,
    onToggle: (id) => { openRunId = id; },
    onCancel: async (id) => {
      await (api() as unknown as { taskRunCancel: (i: string) => Promise<Env<unknown>> }).taskRunCancel(id);
      void paintTaskRuns(s);
    },
    onOpenAgent: (prompt) => { closeSettingsModal(); openSessionWith({ cwd: s.dir, prompt }); },
    // The Connections TAB of the Customize page (his report, 2026-10-07:
    // "connections" named the older page and the pending app went stale).
    onAllowTool: (app) => { openConnectionOnLoad(app); openSettingsModal("connections-cfg"); },
  });
}

/** The app's tools (tools/manifest.json) with the same permission grammar as a connection's. */
async function paintBundleTools(s: SkillDetail, read: (rel: string) => Promise<string>, rel: string | Array<{ name: string; description?: string }>): Promise<void> {
  const host = el("skill-tools-list"); const count = el("skill-tool-count");
  if (!host) return;
  let tools: Array<{ name: string; description?: string }> = [];
  // A manifest.json carries its tools inline; app.json names a file.
  if (Array.isArray(rel)) tools = rel.filter((t) => t && t.name);
  else { try { tools = ((JSON.parse(await read(rel) || "{}") as { tools?: typeof tools }).tools ?? []).filter((t) => t && t.name); } catch { tools = []; } }
  if (count) count.textContent = `· ${tools.length}`;
  tabHasContent("tools", tools.length);
  if (!tools.length) { host.innerHTML = `<div class="crud-empty">This app exposes no tools.</div>`; return; }
  const slug = s.id.replace(/^[a-z]+:/, "");
  const hiddenPref = `appHiddenTools:${slug}`;
  const hidden = new Set<string>(((await window.glyphh.getPreference?.(hiddenPref, []).catch(() => [])) as string[]) ?? []);
  await renderToolGroups(host, {
    key: `app:${slug}`, appName: slug, tools: tools.map((t) => ({ ...t, hidden: hidden.has(t.name) })),
    persistHidden: async (list) => { await window.glyphh.setPreference?.(hiddenPref, list); },
  });
}

/** The bundle's skills: its own SKILL.md plus any under skills/<name>/. */
async function paintBundleSkills(s: SkillDetail, read: (rel: string) => Promise<string>): Promise<void> {
  const host = el("skill-skills-list"); const count = el("skill-skill-count");
  if (!host) return;
  const paths = s.files.map((f) => f.path).filter((p) => p === "SKILL.md" || /^skills\/[^/]+\/SKILL\.md$/.test(p)).sort();
  const rows = await Promise.all(paths.map(async (p) => {
    const fm = parseFrontmatter(await read(p)).frontmatter;
    return { path: p, name: fm.name || (p === "SKILL.md" ? s.name : p.split("/")[1]), description: fm.description || "" };
  }));
  if (count) count.textContent = `· ${rows.length}`;
  tabHasContent("skills", rows.length);
  host.textContent = "";
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "skill-row openable";
    row.innerHTML = `<div class="skill-tile-icon">${SKILL_ICON}</div><div class="skill-row-main"><div class="skill-row-name"></div><div class="skill-row-sub"><span class="skill-row-desc"></span></div></div>`;
    (row.querySelector(".skill-row-name") as HTMLElement).textContent = `/${r.name}`;
    (row.querySelector(".skill-row-desc") as HTMLElement).textContent = r.description || "No description in the frontmatter.";
    row.addEventListener("click", () => { selectDetailTab("contents"); void openFile(r.path); });
    host.appendChild(row);
  }
}

/** A bundle's declared accounts, as the Connections page draws them (his
 *  order, 2026-09-17): the connector's own logo, a Type column, a check
 *  when connected and a Connect button when not. The rows are
 *  rendered by that page so the two tables cannot drift. Either manifest
 *  shape is accepted, since a hand-written one carries bare slugs. */
async function paintBundleConnections(raw: Array<ConnDep | string>): Promise<void> {
  const deps = connDeps(raw);
  const host = el("skill-connections-list"); const count = el("skill-conn-count");
  if (!host) return;
  if (count) count.textContent = `· ${deps.length}`;
  tabHasContent("connections", deps.length);
  host.textContent = "";
  if (!deps.length) { host.innerHTML = `<div class="crud-empty">No connections.</div>`; return; }
  await renderConnectionTable(host, deps);
}

async function openDetail(id: string): Promise<void> {
  const r = await api().skillGet(id) as Env<SkillDetail>;
  if (!r.ok || !r.data) { fail(r.error || `Couldn't open that ${cfg.noun}.`); return; }
  current = r.data;
  currentFile = "";
  editing = false;
  el("skills-list-view")?.classList.add("hidden");
  el("skill-detail-view")?.classList.remove("hidden");
  const s = current;
  setDetailName(s.name, s.type);
  (el("skill-detail-sub") as HTMLElement).textContent = `${s.author ? `by ${s.author}` : "by you"} · updated ${when(s.updatedAt)}`;
  const box = el<HTMLInputElement>("skill-enabled"); if (box) box.checked = s.enabled;
  (el("skill-file-count") as HTMLElement).textContent = `· ${s.files.length}`;
  (el("skill-overview-desc") as HTMLElement).textContent = s.description || "No description in the frontmatter.";
  paintOverviewBody(s.body);
  setDetailIcon(s);
  void paintExtras(s);
  const local = s.source === "glyphh" || s.source === "app" || s.source === "plugin" || s.source === "task";
  (el("skill-author") as HTMLElement).textContent = s.author || (local ? "You" : SOURCE_LABEL[s.source].replace("From ", ""));
  (el("skill-author-meta") as HTMLElement).textContent = local ? "On this machine" : `Loaded by ${SOURCE_LABEL[s.source].replace("From ", "")}`;
  paintDetailChrome();
  paintDetailTabs(typeOf(s));
  tabHasContent("contents", s.files.length);
  collapsedDirs = new Set();
  selectDetailTab("overview");
  renderTree();
}

type DetailTab = "overview" | "contents" | "skills" | "tools" | "connections" | "agents" | "runs" | "flow";
/** One agent a bundle ships: agents/<name>.md, or a task's slot under the older name. */
interface BundleAgentRow { ref: string; name: string; description: string; loop: string; model: string; source: "file" | "slot" }
/** One of your agents as the slot picker lists it (library-agents-list). */
interface RosterAgentRow { id: string; slug?: string; name: string }
interface ScheduleRow { id: string; kind: string; target: string; cron: string; enabled: boolean; agentId?: string; name?: string }
/** Which tabs a type earns. Overview and Contents are every bundle's; the rest
 *  are what that kind of skill actually has. */
const TABS_FOR: Record<BundleType, DetailTab[]> = {
  skill: ["overview", "contents", "agents"],
  app: ["overview", "contents", "skills", "tools", "agents", "connections"],
  task: ["overview", "flow", "contents", "agents", "runs", "connections"],
  plugin: ["overview", "contents", "skills"],
};
/** THE PAGE IS NEVER BLANK (his order, 2026-10-07): the Overview renders the
 *  bundle's SKILL.md from the folder under the one-line description. */
function paintOverviewBody(body: string): void {
  const host = el("skill-overview-body");
  if (!host) return;
  const md = (body || "").trim();
  host.classList.toggle("hidden", !md);
  host.innerHTML = md ? formatMarkdown(md) : "";
}

/** Show only the tabs this item earns. */
function paintDetailTabs(type: BundleType): void {
  const allowed = TABS_FOR[type];
  document.querySelectorAll<HTMLButtonElement>(`${cfg.panel} .skills-tab[data-dtab]`)
    .forEach((b) => b.classList.toggle("hidden", !allowed.includes(b.dataset.dtab as DetailTab)));
}

/** A TAB WITH NOTHING IN IT IS NOT SHOWN (his order, 2026-10-07: "when an app
 *  shows no content it should not show those tabs"). The painters report what
 *  they found; an empty one hides its tab, and if it was the open tab the page
 *  falls back to the Overview. Overview itself never hides. */
const COUNTED_TABS: ReadonlySet<DetailTab> = new Set<DetailTab>(["contents", "skills", "tools", "agents", "connections", "runs"]);
function tabHasContent(tab: DetailTab, n: number): void {
  if (!COUNTED_TABS.has(tab) || !current) return;
  const earned = TABS_FOR[typeOf(current)].includes(tab);
  const b = document.querySelector<HTMLButtonElement>(`${cfg.panel} .skills-tab[data-dtab="${tab}"]`);
  if (!b) return;
  const hide = !earned || n === 0;
  b.classList.toggle("hidden", hide);
  if (hide && b.classList.contains("active")) selectDetailTab("overview");
}
function selectDetailTab(t: DetailTab): void {
  if (!TABS_FOR[typeOf(current)].includes(t)) t = "overview";
  document.querySelectorAll<HTMLButtonElement>(`${cfg.panel} .skills-tab[data-dtab]`).forEach((b) => b.classList.toggle("active", b.dataset.dtab === t));
  el("skill-overview")?.classList.toggle("hidden", t !== "overview");
  el("skill-contents")?.classList.toggle("hidden", t !== "contents");
  el("skill-skills")?.classList.toggle("hidden", t !== "skills");
  el("skill-tools")?.classList.toggle("hidden", t !== "tools");
  el("skill-connections")?.classList.toggle("hidden", t !== "connections");
  el("skill-agents")?.classList.toggle("hidden", t !== "agents");
  el("skill-runs")?.classList.toggle("hidden", t !== "runs");
  el("skill-flow")?.classList.toggle("hidden", t !== "flow");
  if (t === "runs" && current) void paintTaskRuns(current);
  if (t === "flow") paintFlow();
  if (t === "contents" && current && !currentFile) void openFile(current.files.some((f) => f.path === "SKILL.md") ? "SKILL.md" : (current.files[0]?.path ?? ""));
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
  paint(buildTree(current.files), 0);
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
  const r = await api().skillFileRead(current.id, rel) as Env<{ text: string; binary: boolean; size: number }>;
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
      value: text, language, automaticLayout: true, minimap: { enabled: false },
      fontSize: 12.5, lineNumbers: "on", scrollBeyondLastLine: false, wordWrap: "on", theme: document.documentElement.classList.contains("light") ? "vs" : "vs-dark",
    });
    (editor as unknown as { onDidChangeModelContent: (f: () => void) => void }).onDidChangeModelContent(() => {
      editing = (editor?.getValue() ?? "") !== loadedText;
      paintEditButton();
    });
  } else {
    editor.setValue(text);
    w.monaco.editor.setModelLanguage(editor.getModel(), language);
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
  if (!current || !currentFile || !editing) return;
  const text = editor?.getValue() ?? "";
  const r = await api().skillFileWrite(current.id, currentFile, text) as Env<boolean>;
  if (!r.ok) { fail(r.error || "Save failed."); return; }
  loadedText = text;
  editing = false;
  paintEditButton();
  // SKILL.md changed → the name/description/body may have too.
  if (currentFile === "SKILL.md") { const id = current.id; await openDetail(id); selectDetailTab("contents"); await openFile("SKILL.md"); }
}

function authorOf(s: SkillRow): string {
  return s.author || (s.source === "glyphh" ? "You" : SOURCE_LABEL[s.source].replace("From ", ""));
}

function paintControls(): void {
  const f = el("skills-filter"); const so = el("skills-sort");
  f?.classList.toggle("on", !!(filterSource || filterAuthor || filterType));
  const fl = f?.querySelector("span"); if (fl) fl.textContent = filterSource || filterAuthor || filterType ? `Filter · ${[filterType ? TYPE_LABEL[filterType] : "", filterSource ? SOURCE_LABEL[filterSource].replace("From ", "").replace("Created by you", "You") : "", filterAuthor].filter(Boolean).join(", ")}` : "Filter";
  const sl = so?.querySelector("span"); if (sl) sl.textContent = `Sort · ${SORT_LABEL[sortKey]}`;
}

function filterMenu(): MenuItem[] {
  const authors = [...new Set(skills.map(authorOf))].sort((a, b) => a.localeCompare(b));
  const sources = SOURCE_ORDER.filter((src) => skills.some((s) => s.source === src));
  const types = (["skill", "app", "task", "plugin"] as BundleType[]).filter((t) => skills.some((s) => s.type === t));
  return [
    { heading: "Filter by" },
    ...(types.length > 1 ? [{ label: "Type", children: [
      { label: "All", checked: !filterType, onClick: () => { filterType = ""; renderList(); } },
      ...types.map((t) => ({ label: `${TYPE_LABEL[t][0]!.toUpperCase()}${TYPE_LABEL[t].slice(1)}`, checked: filterType === t, onClick: () => { filterType = t; renderList(); } })),
    ] }] : []),
    { label: "Source", children: [
      { label: "All", checked: !filterSource, onClick: () => { filterSource = ""; renderList(); } },
      ...sources.map((src) => ({ label: src === "glyphh" ? "Glyphh" : SOURCE_LABEL[src].replace("From ", ""), checked: filterSource === src, onClick: () => { filterSource = src; renderList(); } })),
    ] },
    { label: "Created by", children: [
      { label: "All", checked: !filterAuthor, onClick: () => { filterAuthor = ""; renderList(); } },
      ...authors.map((a) => ({ label: a, checked: filterAuthor === a, onClick: () => { filterAuthor = a; renderList(); } })),
    ] },
    ...(filterSource || filterAuthor || filterType ? [{ sep: true as const }, { label: "Clear filters", onClick: () => { filterSource = ""; filterAuthor = ""; filterType = ""; renderList(); } }] : []),
  ];
}

function sortMenu(): MenuItem[] {
  return (Object.keys(SORT_LABEL) as SortKey[]).map((k) => ({ label: SORT_LABEL[k], checked: sortKey === k, onClick: () => { sortKey = k; renderList(); } }));
}

// ── wiring ──────────────────────────────────────────────────────────────────
function wire(): void {
  if (wired) return;
  wired = true;
  document.querySelectorAll<HTMLElement>(`${cfg.panel} .skill-tile-icon.lg`).forEach((n) => { n.innerHTML = cfg.icon; });
  const back = el("skill-back"); if (back) { const label = back.lastChild; if (label && label.nodeType === Node.TEXT_NODE) label.textContent = cfg.back; }
  el<HTMLInputElement>("skills-search")?.addEventListener("input", (e) => { query = (e.target as HTMLInputElement).value; renderList(); });
  el("skills-filter")?.addEventListener("click", (e) => openMenu(e.currentTarget as HTMLElement, filterMenu()));
  el("skills-sort")?.addEventListener("click", (e) => openMenu(e.currentTarget as HTMLElement, sortMenu()));
  el("skills-add")?.addEventListener("click", (e) => openMenu(e.currentTarget as HTMLElement, [
    ...KINDS.map((k) => ({ label: `New ${TYPE_LABEL[k]}`, onClick: () => void createNew(k) })),
    { label: "Import from file…", onClick: () => void importFromFile() },
  ]));
  el("skill-back")?.addEventListener("click", () => void loadSkillsSettings());
  document.querySelectorAll<HTMLButtonElement>(`${cfg.panel} .skills-tab[data-dtab]`).forEach((b) => b.addEventListener("click", () => selectDetailTab(b.dataset.dtab as DetailTab)));
  if (KINDS.includes("task")) {
    (api() as unknown as { onTaskRunsChanged?: (fn: () => void) => void }).onTaskRunsChanged?.(() => {
      if (current && el("skill-runs") && !el("skill-runs")!.classList.contains("hidden")) void paintTaskRuns(current);
    });
    (window as unknown as { __glyphhOpenTaskRun?: (slug: string, runId: string) => void }).__glyphhOpenTaskRun = (slug, runId) => {
      openRunId = runId;
      void openDetail(`task:${slug}`).then(() => selectDetailTab("runs"));
    };
  }
  el<HTMLInputElement>("skill-enabled")?.addEventListener("change", (e) => { if (current) void toggle(current.id, (e.target as HTMLInputElement).checked); });
  el("skill-kebab")?.addEventListener("click", async (e) => {
    if (!current) return;
    const anchor = e.currentTarget as HTMLElement;
    // A CONTROL THE HOST CANNOT SERVE HIDES (his rule, 2026-10-04): the
    // folder-bound items — edit in its folder, replace its files, download,
    // show in folder — are the desktop's; the web menu carries the rest.
    const machine = !onWeb();
    openMenu(anchor, [
      { label: "Try in chat", onClick: tryInChat },
      ...(machine ? [{ label: "Edit with Glyphh", onClick: () => editWith() }] : []),
      ...(machine ? [
        { label: "Replace", onClick: () => void replaceFiles() },
        { label: "Download", onClick: () => void download() },
        { label: "Show in folder", onClick: () => void api().skillReveal(current!.id) },
      ] : []),
      { sep: true as const },
      { label: "Remove", danger: true, onClick: () => void remove(current!.id, current!.name) },
    ]);
  });
  el("skill-reveal")?.addEventListener("click", () => { if (current) void api().skillReveal(current.id); });
  el("skill-edit")?.addEventListener("click", () => void onEdit());
  el("skill-view-preview")?.addEventListener("click", () => { viewMode = "preview"; void openFile(currentFile); });
  el("skill-view-code")?.addEventListener("click", () => { viewMode = "code"; void openFile(currentFile); });
}

/** New skill = a session in the default loop, rooted at Glyphh's skills home,
 *  with the ask started in the composer and the cursor waiting for the rest. */
async function createNew(kind: BundleType): Promise<void> {
  const r = await api().skillsHome(kind) as Env<string>;
  if (!r.ok || !r.data) { fail(r.error || `Couldn't find the ${TYPE_LABEL[kind]} folder.`); return; }
  openSessionWith({
    cwd: r.data,
    prompt: NEW_PROMPT[kind],
  });
}

async function importFromFile(): Promise<void> {
  const r = await api().skillImport(cfg.kind) as Env<SkillRow | null>;
  if (!r.ok) { fail(r.error || "Import failed."); return; }
  if (!r.data) return;
  notice(`${r.data.name} imported`, { detail: WHERE_TO_SEE[typeOf(r.data)] });
  await loadSkillsSettings();
  await openDetail(r.data.id);
}

  return { load: loadSkillsSettings };
}

const SKILLS_PAGE = createLibraryPage({
  kind: "skill", kinds: ["skill", "task"], id: (x) => x, panel: '.settings-panel[data-sub="skills"]', noun: "skill", nouns: "skills", icon: SKILL_ICON, back: "Skills",
});
const APPS_PAGE = createLibraryPage({
  kind: "app", id: (x) => x.replace(/^skills-/, "gapps-").replace(/^skill-/, "gapp-"), panel: '.settings-panel[data-sub="apps"]', noun: "app", nouns: "apps", icon: APP_ICON, back: "Apps",
});
const PLUGINS_PAGE = createLibraryPage({
  kind: "plugin", id: (x) => x.replace(/^skills-/, "gplugs-").replace(/^skill-/, "gplug-"), panel: '.settings-panel[data-sub="plugins"]', noun: "plugin", nouns: "plugins", icon: PLUGIN_ICON, back: "Plugins",
});
const TASKS_PAGE = createLibraryPage({
  kind: "task", id: (x) => x.replace(/^skills-/, "gtasks-").replace(/^skill-/, "gtask-"), panel: '.settings-panel[data-sub="tasks"]', noun: "task", nouns: "tasks", icon: TASK_ICON, back: "Tasks",
});
export const loadSkillsSettings = SKILLS_PAGE.load;
export const loadTasksSettings = TASKS_PAGE.load;
export const loadAppsSettings = APPS_PAGE.load;
export const loadPluginsSettings = PLUGINS_PAGE.load;
/** The Customize page's scope reaching a library tab by its settings sub;
 *  false for a sub that is not a library page (his report, 2026-10-07). The
 *  library is the folders on this machine and nothing else, so every scope
 *  ("discover" included) shows them: the answer only says whether the sub is
 *  one of these pages. */
const LIBRARY_SUBS: ReadonlySet<string> = new Set(["skills", "apps", "plugins", "tasks"]);
export function setLibraryScope(sub: string, _scope?: "mine" | "discover", _force?: boolean): boolean {
  return LIBRARY_SUBS.has(sub);
}
