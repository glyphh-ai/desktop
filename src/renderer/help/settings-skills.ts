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

import { escapeHtml, confirmAction, loadingHtml } from "./shared.js";
import { closeSettingsModal, openSettingsModal } from "./navigation.js";
import { openAppInWorkbench, openWorkPanelInWorkbench } from "./code.js";
import { renderToolGroups } from "./settings-connections.js";
import { formatMarkdown } from "../format-markdown.js";
import { toolViewIcon } from "./layouts.js";
import { appIconInner } from "./app-icon.js";
import { taskGraph, renderFlow, unmountFlow } from "./lib-flow.js";
import { cronToWords, openScheduleOnLoad } from "./schedules.js";
import { renderConnectionTable, connDeps, type ConnDep } from "./settings-connections.js";
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
interface DiscoverRow { ref: string; from: "org" | "glyphh"; id: string; slug: string; name: string; description: string; author: string; version: number | null; installed: boolean; installs: number; updatedAt: string; createdAt: string; categories: string[]; icon?: string | null; tool?: string | null; type?: BundleType }
type Env<T> = { ok: boolean; data?: T; error?: string };

const SOURCE_LABEL: Record<Source, string> = { glyphh: "Created by you", app: "Created by you", plugin: "Created by you", task: "Created by you", claude: "From Claude Code", codex: "From Codex", gemini: "From Gemini" };
const SOURCE_ORDER: Source[] = ["glyphh", "app", "plugin", "task", "claude", "codex", "gemini"];
const SKILL_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>`;
const PLUGIN_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v3M15 3v3M6 6h12v5a6 6 0 0 1-12 0V6zM12 17v4"/></svg>`;
const TASK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h10M4 18h6"/><path d="m15 17 2 2 4-4"/></svg>`;
const APP_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/></svg>`;

/** ONE page, TWO homes (his ruling, 2026-09-16): Skills and Apps share the
 *  page; an app is a skill folder plus app.json, its own home, its own hub kind. */
export interface PageCfg {
  kind: BundleType;
  /** The homes this page lists. Defaults to its own kind; the Skills page
   *  lists apps beside skills while the Apps page still stands. */
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

/** What "New …" hands the agent. The ask belongs to the KIND, not the page, so
 *  one page that lists several kinds can offer each of them. */
/** The mark a bundle wears when it ships none of its own: its TYPE's, not the
 *  page's — an app among skills looks like an app (his order, 2026-09-17). */
const TYPE_ICON: Record<BundleType, string> = { skill: SKILL_ICON, app: APP_ICON, task: TASK_ICON, plugin: PLUGIN_ICON };

const NEW_PROMPT: Record<BundleType, string> = {
  skill: "Create a new Agent Skill in this folder: a new subfolder named after the skill with a SKILL.md (frontmatter name + description, then the instructions) and any scripts or references it needs. The skill should ",
  app: "Create a new Glyphh app in this folder: a new subfolder named after the app with a SKILL.md (frontmatter name + description, then how an agent works the app), an app.json (name, ui entry, tools manifest, data schema, dependencies on connections, screenshots), ui/index.html as the face, tools/manifest.json for the tools it exposes, and data/schema.sql if it keeps data. The app should ",
  plugin: "Create a new Claude Code plugin in this folder: a new subfolder named after the plugin with .claude-plugin/plugin.json (name, description, version), a README.md, and any skills/<name>/SKILL.md, commands/, agents/, hooks/ or .mcp.json it needs. The plugin should ",
  task: "Create a new Glyphh task in this folder: a new subfolder named after the task with a SKILL.md (frontmatter name + description, then what the task does and when to run it), a task.json (name, program: run.js, slots the program calls agents through, dependencies on connections, an optional five-field cron schedule) and run.js exporting async function run(ctx, input) that returns the result. The program is the process: it drives the logic itself and uses ctx.agents.<slot>.run(prompt, {schema}) only where an agent is needed, ctx.connections.<app>.call(tool, args) for connections, ctx.data(repo).exec(sql, params) for app data, and ctx.checkpoint(key, fn) around anything worth not redoing after a restart. The task should ",
};

export function createLibraryPage(cfg: PageCfg) {
let wired = false;
let tab: "mine" | "discover" = "mine";
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
let discoverRows: DiscoverRow[] = [];
/** Installed bundles the catalog has moved past, by folder id. */
let updates: Record<string, { have: number; latest: number; name: string }> = {};
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
/** The Discover item on the detail page (read-only, Add instead of Share), or null for a local skill. */
let hubItem: DiscoverRow | null = null;
let editor: { getValue(): string; setValue(v: string): void; updateOptions(o: Record<string, unknown>): void; layout(): void; dispose(): void; getModel(): unknown } | null = null;

const el = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.getElementById(cfg.id(id)) as T | null;
const api = () => window.glyphh;
/** What this page lists, and what an item IS — every per-item call rides the
 *  item's own type, never the page's (a mixed list has both). */
const KINDS: BundleType[] = cfg.kinds ?? [cfg.kind];
const typeOf = (s: { type?: BundleType } | null | undefined): BundleType => s?.type ?? cfg.kind;
/** The type reads as a chip only when it is NOT what this page is already
 *  about — a plain skill on Skills says nothing, an app among them says "app". */
const typeChip = (type: BundleType | undefined): string =>
  type && type !== cfg.kind ? `<span class="skill-type-chip">${escapeHtml(TYPE_LABEL[type])}</span>` : "";
/** The mark a bundle wears: the icon.svg it ships, else the built-in panel it
 *  IS, else its type's. The middle step matters for the work-panel apps —
 *  Design, Slides, Drive and the media panels are those panels, and the ones
 *  installed before the catalog shipped icons carry no icon.svg at all. */
/** THE GLYPHH BUNDLE WEARS THE MASCOT (his order, 2026-09-17), through the
 *  same resolver every app row uses — `appIconInner` answers the brand mark
 *  for slug "glyphh", so the skill and the app are one identity and nothing
 *  here hand-rolls a second path to that image. */
/** Where the user finds each kind — the line a toast reads back after a write. */
const WHERE_TO_SEE: Record<BundleType, string> = {
  skill: "Settings → Build → Skills (type Skill)",
  app: "Settings → Build → Skills (type App) and the Apps work panel",
  task: "Settings → Build → Skills (type Task); put it on a clock under Customize → Schedules",
  plugin: "Settings → Build → Plugins",
};
const isGlyphhBundle = (s: { id?: string; slug?: string; name?: string } | null | undefined): boolean => {
  const slug = (s?.slug || (s?.id ? s.id.slice(s.id.indexOf(":") + 1) : "") || s?.name || "").toLowerCase().trim();
  return slug === "glyphh";
};
const markOf = (s: { icon?: string | null; tool?: string | null; id?: string; slug?: string; name?: string } | null | undefined): string =>
  isGlyphhBundle(s) ? appIconInner({ slug: "glyphh" }, s?.name || "Glyphh", "skill-icon-initial")
    : (s?.icon && s.icon.includes("<svg") ? s.icon : (s?.tool ? toolViewIcon(s.tool) : ""));
const iconOf = (mark: string, type?: BundleType): string => mark || TYPE_ICON[type ?? cfg.kind];
/** The shelves a shared bundle sits on, and the door to change them. Nothing
 *  to show until it has been shared — an unshared folder is on no shelf. */
function paintCategories(): void {
  const block = el("skill-cats-block"); const host = el("skill-cats");
  if (!block || !host) return;
  block.classList.toggle("hidden", !shareItem || !!hubItem);
  if (!shareItem || hubItem) return;
  host.textContent = "";
  const chosen = shareItem.categories;
  for (const id of chosen) {
    const c = document.createElement("span");
    c.className = "skill-cat-chip";
    c.textContent = catLabel(id);
    host.appendChild(c);
  }
  if (!chosen.length) {
    const none = document.createElement("span");
    none.className = "skill-cat-none";
    none.textContent = "On no shelf yet";
    host.appendChild(none);
  }
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "skill-cat-edit";
  edit.textContent = "Edit";
  edit.addEventListener("click", () => {
    if (!hubCategories.length) { void api().hubCategories().then((c) => { const e = c as Env<Array<{ id: string; label: string }>>; if (e.ok) hubCategories = e.data ?? []; openCategoryMenu(edit); }); return; }
    openCategoryMenu(edit);
  });
  host.appendChild(edit);
}

function openCategoryMenu(anchor: HTMLElement): void {
  if (!shareItem) return;
  const chosen = new Set(shareItem.categories);
  openMenu(anchor, [
    { heading: "On these shelves" },
    ...hubCategories.map((c) => ({
      label: c.label,
      checked: chosen.has(c.id),
      onClick: () => {
        const next = chosen.has(c.id) ? shareItem!.categories.filter((x) => x !== c.id) : [...shareItem!.categories, c.id];
        void saveCategories(next);
      },
    })),
  ]);
}

async function saveCategories(ids: string[]): Promise<void> {
  if (!shareItem) return;
  const item = shareItem;
  const r = await (api() as unknown as { skillCategoriesSet: (id: string, kind: string, ids: string[]) => Promise<Env<string[]>> })
    .skillCategoriesSet(item.id, item.kind, ids)
    .catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }) as Env<string[]>);
  if (!r.ok) { fail(r.error || "Couldn't change the categories. An org admin can."); return; }
  shareItem = { ...item, categories: r.data ?? ids };
  paintCategories();
  discoverRows = [];
}

/** Where this bundle stands with the org's hub, beside its name: waiting on the
 *  review desk, or live at a version. A share that vanishes into a button label
 *  is not a confirmation (his report, 2026-09-17). */
function paintShareChip(): void {
  const host = el("skill-detail-name");
  if (!host) return;
  host.querySelector(".skill-share-chip")?.remove();
  if (hubItem) return;
  const { head, pending } = shareState;
  const label = pending ? `in review · v${pending}` : head ? `shared · v${head}` : "";
  if (!label) return;
  const chip = document.createElement("span");
  chip.className = `skill-type-chip skill-share-chip${pending ? " pending" : ""}`;
  chip.textContent = label;
  chip.title = pending
    ? "Waiting on your organization's review desk. An admin decides; sharing again replaces it."
    : "Live on your organization's hub. Members install it from Discover.";
  host.appendChild(chip);
}

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
 *  when an install worked. */
function fail(msg: string): void {
  toastError(msg);
}

function notice(msg: string, opts?: { detail?: string }): void {
  toastOk(msg, opts);
}

/** WHERE EACH BUNDLE CAME FROM (his report, 2026-09-17: "there is no update
 *  mechanism"). The detail page says the source and the version even when
 *  nothing is newer, and the ⋮ can always check or re-pull. */
interface Standing { from: "org" | "glyphh"; sourceName: string; name: string; have: number; latest: number }
let standings: Record<string, Standing> = {};

async function refreshStandings(): Promise<void> {
  const r = await (api() as unknown as { skillStandings: () => Promise<Env<Record<string, Standing>>> }).skillStandings()
    .catch(() => ({ ok: false } as Env<Record<string, Standing>>));
  standings = r.ok ? r.data ?? {} : {};
  if (current) paintSource(current.id);
}

/** The Overview's source line: a folder from a hub says so and names its version. */
function paintSource(id: string): void {
  const st = standings[id];
  const authorEl = el("skill-author"); const metaEl = el("skill-author-meta");
  if (!st || !authorEl || !metaEl) return;
  authorEl.textContent = st.from === "org" ? "Your organization's hub" : "Glyphh";
  metaEl.textContent = st.have ? `Installed from ${st.sourceName} · v${st.have}${st.latest > st.have ? ` · v${st.latest} available` : " · up to date"}` : `From ${st.sourceName}`;
}

/** Ask the hub what has moved on. Never blocks the list; repaints if it finds any. */
async function refreshUpdates(): Promise<void> {
  const r = await (api() as unknown as { skillUpdates: () => Promise<Env<typeof updates>> }).skillUpdates().catch(() => ({ ok: false } as Env<typeof updates>));
  const next = r.ok ? r.data ?? {} : {};
  const changed = Object.keys(next).join() !== Object.keys(updates).join();
  updates = next;
  void refreshStandings();
  if (changed && el("skills-groups")) renderList();
  if (changed && current) paintDetailChrome();
}

/** ALWAYS A DOOR: ask the hub now and say what came back, whether or not
 *  anything moved. Without this a bundle that was current looked like a
 *  bundle with no update mechanism at all. */
async function checkForUpdates(): Promise<void> {
  if (!current) return;
  const id = current.id, name = current.name;
  await refreshUpdates();
  await refreshStandings();
  paintDetailChrome();
  const up = updates[id]; const st = standings[id];
  if (up) notice(`${name} can go to v${up.latest}`, { detail: `You are on v${up.have}. Update is in the header.` });
  else if (st) notice(`${name} is up to date`, { detail: `v${st.have} from ${st.sourceName}` });
  else notice(`${name} isn't on a hub`, { detail: "Nothing to update from. Share it to put it on your organization's hub." });
}

/** Take the hub's copy again even when the versions match — the way back from
 *  a local edit. */
async function reinstall(): Promise<void> {
  if (!current) return;
  const st = standings[current.id];
  if (!st) { fail("This one isn't on a hub, so there is nothing to reinstall from."); return; }
  const sure = await confirmAction({
    title: `Reinstall "${current.name}"?`,
    body: `The hub's v${st.latest} is written over this copy. Files you added stay; files the hub dropped go.`,
    confirmLabel: "Reinstall",
  });
  if (!sure) return;
  const id = current.id;
  const r = await (api() as unknown as { skillUpdate: (id: string) => Promise<Env<{ version: number }>> }).skillUpdate(id)
    .catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }) as Env<{ version: number }>);
  if (!r.ok) { fail(r.error || "Couldn't reinstall."); return; }
  notice(`${current.name} reinstalled at v${r.data?.version ?? st.latest}`);
  delete updates[id];
  await loadSkillsSettings();
  await openDetail(id);
}

/** Take the catalog's version over this copy. */
async function updateNow(id: string, btn?: HTMLButtonElement): Promise<void> {
  const up = updates[id];
  if (!up) return;
  if (btn) { btn.disabled = true; btn.textContent = "Updating…"; }
  const r = await (api() as unknown as { skillUpdate: (id: string) => Promise<Env<{ version: number }>> }).skillUpdate(id)
    .catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }) as Env<{ version: number }>);
  if (!r.ok) { if (btn) { btn.disabled = false; btn.textContent = "Update"; } fail(r.error || "Couldn't update."); return; }
  delete updates[id];
  notice(`${up.name} updated to v${r.data?.version ?? up.latest}`);
  const wasOpen = current?.id === id;
  await loadSkillsSettings();
  if (wasOpen) await openDetail(id);
}

// ── list ────────────────────────────────────────────────────────────────────
async function loadSkillsSettings(): Promise<void> {
  wire();
  el("skill-detail-view")?.classList.add("hidden");
  el("skills-list-view")?.classList.remove("hidden");
  if (!skills.length) { const h = el("skills-groups"); if (h) h.innerHTML = loadingHtml(`Loading your ${cfg.nouns}…`); }
  void refreshUpdates();
  const r = await api().skillsList(KINDS) as Env<SkillRow[]>;
  if (!r.ok) { fail(r.error || `Couldn't read your ${cfg.nouns}.`); return; }
  skills = r.data ?? [];
  if (tab === "discover") await loadDiscover();
  renderList();
}

async function loadDiscover(): Promise<void> {
  if (!discoverRows.length) { const h = el("skills-groups"); if (h) h.innerHTML = loadingHtml("Loading the hub…"); }
  const [r, c] = await Promise.all([api().skillsDiscover(KINDS) as Promise<Env<DiscoverRow[]>>, api().hubCategories() as Promise<Env<Array<{ id: string; label: string }>>>]);
  if (!r.ok) { fail(r.error || "The hub didn't answer."); discoverRows = []; return; }
  discoverRows = r.data ?? [];
  hubCategories = c.ok ? (c.data ?? []) : [];
  discoverView = { kind: "home" };
}

type MenuItem = { label: string; danger?: boolean; checked?: boolean; onClick: () => void } | { sep: true } | { heading: string } | { label: string; children: MenuItem[] };
function row(opts: { name: string; by: string; desc: string; right: string; onOpen?: () => void; menu?: MenuItem[]; action?: HTMLElement; icon?: string | null; tool?: string | null; type?: BundleType }): HTMLElement {
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
  document.querySelectorAll<HTMLButtonElement>(`${cfg.panel} .skills-tab[data-tab]`).forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  const q = query.trim().toLowerCase();
  const hit = (s: string) => !q || s.toLowerCase().includes(q);

  if (tab === "mine") {
    const shown = skills
      .filter((s) => hit(`${s.name} ${s.description} ${s.author}`))
      .filter((s) => !filterSource || s.source === filterSource)
      .filter((s) => !filterType || s.type === filterType)
      .filter((s) => !filterAuthor || authorOf(s) === filterAuthor)
      .sort((a, b) => sortKey === "name" ? a.name.localeCompare(b.name) : sortKey === "author" ? authorOf(a).localeCompare(authorOf(b)) || a.name.localeCompare(b.name) : b.updatedAt.localeCompare(a.updatedAt));
    const count = el("skills-count"); if (count) count.textContent = `${shown.length} ${shown.length === 1 ? cfg.noun : cfg.nouns}`;
    paintControls();
    if (!shown.length) {
      host.innerHTML = `<div class="crud-empty">${q ? `No ${cfg.nouns} matching "${escapeHtml(q)}"` : `No ${cfg.nouns} yet. Add one, or install from Discover.`}</div>`;
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
        const up = updates[s.id];
        g.appendChild(row({
          name: s.name, by: s.author ? `by ${s.author}` : "by you",
          desc: s.description, right: when(s.updatedAt), icon: s.icon, tool: s.tool, type: s.type,
          onOpen: () => void openDetail(s.id),
          action: up ? updateButton(s.id, up.latest) : undefined,
          menu: [
            { label: s.enabled ? "Turn off" : "Turn on", onClick: () => void toggle(s.id, !s.enabled) },
            { label: "Share", onClick: async () => { await openDetail(s.id); await share(); } },
            ...(s.source !== "glyphh" && s.source !== "app" ? [{ label: "Manage in Glyphh", onClick: () => void adopt(s.id) }] : []),
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

/** "Update" on a row whose catalog version has moved past this copy. */
function updateButton(id: string, latest: number): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "action-btn skill-update-btn";
  b.textContent = "Update";
  b.title = `Version ${latest} is on the hub`;
  b.addEventListener("click", (e) => { e.stopPropagation(); void updateNow(id, b); });
  return b;
}

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
  const mark = markOf(d);
  c.innerHTML = `<div class="skill-tile-icon${mark ? " own" : ""}">${mark || glyph(d.categories[0] || "productivity", 18)}</div><div class="disc-card-main"><div class="disc-card-name"><span class="disc-card-title"></span>${typeChip(d.type)}</div><div class="disc-card-desc"></div><div class="disc-card-meta"><span class="disc-card-metatext"></span></div></div>`;
  (c.querySelector(".disc-card-title") as HTMLElement).textContent = d.name;
  (c.querySelector(".disc-card-desc") as HTMLElement).textContent = d.description || "No description";
  (c.querySelector(".disc-card-metatext") as HTMLElement).textContent = `from ${d.author || "your org"} · ${d.installs ? `${fmtInstalls(d.installs)} installs` : isNew(d) ? `added ${when(d.createdAt)}` : `v${d.version ?? 1}`}`;
  c.appendChild(addButton(d));
  c.classList.add("openable");
  c.addEventListener("click", () => void openHubDetail(d));
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
    f.classList.add("openable");
    f.addEventListener("click", () => void openHubDetail(featured));
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
    title = v.id === "new" ? "New" : v.id === "top" ? "Most installed" : `All ${cfg.nouns}`;
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
    // The category being browsed leads the chips; the rest fold into +N.
    const lead = v.kind === "category" && d.categories.includes(v.id) ? v.id : d.categories[0];
    titleEl.insertAdjacentHTML("beforeend", typeChip(d.type));
    const chips: string[] = [];
    if (isNew(d)) chips.push("New");
    if (lead) chips.push(catLabel(lead));
    if (d.categories.length > 1) chips.push(`+${d.categories.length - 1}`);
    for (const c of chips) { const s = document.createElement("span"); s.className = "disc-chip" + (c === "New" ? " new" : ""); s.textContent = c; titleEl.appendChild(s); }
    (r.querySelector(".disc-row-sub") as HTMLElement).textContent = `by ${d.author || "your org"} · ${d.description || "No description"}`;
    (r.querySelector(".disc-row-installs") as HTMLElement).textContent = d.installs ? `${fmtInstalls(d.installs)} installs` : "";
    r.appendChild(addButton(d, true));
    r.classList.add("openable");
    r.addEventListener("click", () => void openHubDetail(d));
    host.appendChild(r);
  }
}

async function installFrom(d: DiscoverRow, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  btn.textContent = "…";
  const r = await api().skillInstall(d.ref, d.type ?? cfg.kind) as Env<{ id: string }>;
  if (!r.ok) { btn.disabled = false; btn.textContent = btn.classList.contains("skill-add-wide") ? "Add" : "+"; fail(r.error || "Install failed."); return; }
  d.installed = true;
  const list = await api().skillsList(KINDS) as Env<SkillRow[]>;
  if (list.ok) skills = list.data ?? [];
  const installed = (list.ok ? list.data ?? [] : []).find((s) => s.name === d.name || s.id.endsWith(`:${d.slug ?? ""}`));
  notice(`${d.name} installed`, installed ? { detail: `${TYPE_LABEL[typeOf(installed)]} · ${WHERE_TO_SEE[typeOf(installed)]}` } : undefined);
  if (hubItem && hubItem.ref === d.ref) { paintDetailChrome(); return; }
  renderList();
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
  const sure = await confirmAction({ title: `Remove "${name}"?`, body: "The folder is removed from this machine and from every loop that used it. A shared copy on your organization's hub stays.", confirmLabel: "Remove", danger: true });
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
/** A Discover item: the same detail page, read from the hub, with Add in place
 *  of Share. Back returns to Discover exactly where the user left it. */
async function openHubDetail(d: DiscoverRow): Promise<void> {
  const r = await api().skillHubFiles(d.ref, d.type ?? cfg.kind) as Env<Record<string, string>>;
  if (!r.ok || !r.data) { fail(r.error || `Couldn't open that ${cfg.noun}.`); return; }
  const files = r.data;
  const { frontmatter, body } = parseFrontmatter(files["SKILL.md"] || "");
  hubItem = d;
  current = {
    id: `hub:${d.ref}`, source: "glyphh", type: d.type ?? cfg.kind, name: d.name, description: d.description || frontmatter.description || "", author: d.author,
    enabled: true, dir: "", fileCount: Object.keys(files).length, updatedAt: d.updatedAt, frontmatter, body,
    files: Object.keys(files).sort().map((p) => ({ path: p, size: files[p].length })),
  };
  viewedVersion = { itemId: d.id, version: d.version ?? 1, files };
  currentFile = "";
  editing = false;
  el("skills-list-view")?.classList.add("hidden");
  el("skill-detail-view")?.classList.remove("hidden");
  setDetailName(d.name, d.type);
  (el("skill-detail-sub") as HTMLElement).textContent = `from ${d.author || "your organization"} · ${d.installs ? `${fmtInstalls(d.installs)} installs · ` : ""}added ${when(d.createdAt)}`;
  (el("skill-file-count") as HTMLElement).textContent = `· ${current.files.length}`;
  (el("skill-overview-desc") as HTMLElement).textContent = current.description || "No description in the frontmatter.";
  setDetailIcon({ icon: d.icon, tool: d.tool, type: d.type, slug: d.slug, name: d.name });
  void paintExtras(current, files);
  (el("skill-author") as HTMLElement).textContent = d.author || "Your organization";
  (el("skill-author-meta") as HTMLElement).textContent = d.from === "glyphh" ? "On the Glyphh catalog" : "On your organization's hub";
  paintDetailChrome();
  paintDetailTabs(typeOf(current));
  collapsedDirs = new Set();
  const sel = el<HTMLSelectElement>("skill-version");
  if (sel) { sel.innerHTML = `<option value="${d.version ?? 1}">${escapeHtml(d.name)} · v${d.version ?? 1}</option>`; sel.disabled = true; sel.title = "The version on the hub"; }
  selectDetailTab("overview");
  renderTree();
}

/** Share / enabled / ⋮ for a local skill; one Add button for a hub item. */
function paintDetailChrome(): void {
  const hub = !!hubItem;
  el("skill-share")?.classList.toggle("hidden", hub);
  el("skill-enabled")?.closest(".skills-switch")?.classList.toggle("hidden", hub);
  el("skill-kebab")?.classList.toggle("hidden", hub);
  el("skill-edit")?.classList.add("hidden");
  let add = el<HTMLButtonElement>("skill-hub-add");
  if (!add) {
    add = document.createElement("button");
    add.id = cfg.id("skill-hub-add");
    add.type = "button";
    add.className = "action-btn primary";
    add.addEventListener("click", () => { if (hubItem) void installFrom(hubItem, add!); });
    el("skill-share")?.before(add);
  }
  add.classList.toggle("hidden", !hub);
  if (hub) { add.textContent = hubItem!.installed ? "Added" : "Add"; add.disabled = hubItem!.installed; }
  // The detail's actions, resolved every time: a mixed list moves between an
  // app and a skill, and a stale Open must not survive the move.
  const action = (id: string, label: string, primary: boolean, onClick: (b: HTMLButtonElement) => void): HTMLButtonElement => {
    let b = el<HTMLButtonElement>(id);
    if (!b) {
      b = document.createElement("button");
      b.id = cfg.id(id);
      b.type = "button";
      b.className = primary ? "action-btn primary" : "action-btn";
      b.textContent = label;
      const self = b;
      b.addEventListener("click", () => onClick(self));
      el("skill-share")?.before(b);
    }
    return b;
  };
  const up = current ? updates[current.id] : undefined;
  const upBtn = action("skill-update", "Update", false, (b) => { if (current) void updateNow(current.id, b); });
  upBtn.classList.toggle("hidden", hub || !up);
  if (up) { upBtn.textContent = `Update to v${up.latest}`; upBtn.disabled = false; }
  const type = typeOf(current);
  if (type === "app" || el("skill-open-tab")) action("skill-open-tab", "Open", true, (b) => void openAsTab(b)).classList.toggle("hidden", hub || !current || type !== "app");
  if (type === "task" || el("skill-run-now")) action("skill-run-now", "Run now", true, (b) => void runNow(b)).classList.toggle("hidden", hub || !current || type !== "task");
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

/** The app opens as a tab beside the agent: registered on first open, then the workbench door. */
async function openAsTab(btn: HTMLButtonElement): Promise<void> {
  if (!current) return;
  btn.disabled = true;
  type TabEnv = { ok: boolean; data?: { slug: string; name: string; tool?: string }; error?: string };
  const r: TabEnv = await window.glyphh.skillTab(current.id).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  btn.disabled = false;
  const tab = r.data;
  if (!r.ok || !tab) { fail(r.error || "Couldn't open the app."); return; }
  closeSettingsModal();
  // A tool-backed app (Design, Slides, Images, Video, Audio) opens its built-in
  // panel. Both doors go through the cold-safe openers, which boot the
  // workbench and wait for its bridge — calling the bridge directly was a
  // silent no-op whenever the workbench had not mounted yet.
  if (tab.tool) { openWorkPanelInWorkbench("__wbOpenTool", tab.tool); return; }
  openAppInWorkbench({ slug: tab.slug, name: tab.name, url: "", glyphh: true });
}

function parseFrontmatter(text: string): { frontmatter: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { frontmatter: {}, body: text };
  const fm: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) { const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line); if (kv) fm[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, ""); }
  return { frontmatter: fm, body: text.slice(m[0].length) };
}

/** APPS ONLY: the Overview gains what app.json declares — screenshots as a
 *  gallery and the dependencies (connections, as member or org). Local apps
 *  read the manifest and images from the folder; a hub item carries them in
 *  its files (screenshots as data URLs). */
/** The graph behind the Flow tab, rebuilt whenever a detail is opened. */
let flowGraph: Parameters<typeof renderFlow>[1] | null = null;
/** What the org's hub holds for the open bundle: the live version, and the one
 *  still on the review desk. Null until loadVersions answers. */
let shareState: { head: number | null; pending: number | null } = { head: null, pending: null };
/** The shared item behind the open bundle: what it is on the org's hub, and
 *  the shelves it sits on. Promote guesses the shelves from the payload, so
 *  this is where a person corrects the guess (his report, 2026-09-17). */
let shareItem: { id: string; kind: BundleType; categories: string[] } | null = null;
function paintFlow(): void {
  const host = el("skill-flow-host");
  if (!host) return;
  if (!flowGraph) { host.innerHTML = `<div class="crud-empty">Nothing to draw yet.</div>`; return; }
  void renderFlow(host, flowGraph);
}

async function paintExtras(s: SkillDetail, hubFiles: Record<string, string> | null): Promise<void> {
  const host = el("skill-overview-extra");
  if (!host) return;
  host.textContent = "";
  const flowHost = el("skill-flow-host");
  if (flowHost) { unmountFlow(flowHost); flowHost.textContent = ""; }
  flowGraph = null;
  const type = typeOf(s);
  if (type === "skill") return;
  const read = async (rel: string): Promise<string> => {
    if (hubFiles) return hubFiles[rel] ?? "";
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
    if (!hubItem) { void paintTaskRuns(s); void paintTaskSchedule(s, tm.schedule ?? null); }
    return;
  }
  let manifest: { screenshots?: Array<string | { path: string; caption?: string }>; dependencies?: { connections?: Array<ConnDep | string> }; ui?: string; tools?: string } = {};
  try { manifest = JSON.parse(await read("app.json") || "{}"); } catch { manifest = {}; }
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
      if (hubFiles) return hubFiles[shot.path] || "";
      const r = await api().skillImage(s.id, shot.path) as Env<string>;
      return r.ok ? (r.data || "") : "";
    }));
    const show = (i: number): void => { main.src = urls[i]; cap.textContent = gallery[i].caption; thumbs.querySelectorAll("img").forEach((t, j) => t.classList.toggle("active", i === j)); };
    urls.forEach((u, i) => { if (!u) return; const t = document.createElement("img"); t.src = u; t.alt = gallery[i].caption; t.addEventListener("click", () => show(i)); thumbs.appendChild(t); });
    const first = urls.findIndex(Boolean);
    if (first >= 0) { show(first); host.appendChild(g); }
  }
  await Promise.all([paintBundleSkills(s, read), paintBundleTools(s, read, manifest.tools || "tools/manifest.json"), paintBundleConnections(manifest.dependencies?.connections ?? [])]);
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
 * three things a person changes: what it runs on, which model, and its clock.
 */
const LOOP_FAVICON: Record<string, string> = {
  claude: "https://claude.ai/favicon.ico",
  codex: "https://openai.com/favicon.ico",
  gemini: "https://www.google.com/s2/favicons?domain=gemini.google.com&sz=64",
  copilot: "https://github.com/favicon.ico",
  cursor: "https://cursor.com/favicon.ico",
};
let loopRows: LoopRow[] = [];

/** A fixed loop's id IS its CLI (claude, codex, gemini…), which is what the
 *  dock keys its marks on, so the row wears the same face as the agent tile. */
const loopMark = (id: string): string => {
  const url = LOOP_FAVICON[String(id || "").toLowerCase()];
  return url ? `<img src="${url}" alt="" />` : AGENT_ICON;
};

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
  const [env, loops, scheds] = await Promise.all([
    api().skillAgents(s.id) as Promise<Env<BundleAgentRow[]>>,
    (api() as unknown as { cliAgentsList?: () => Promise<{ ok: boolean; agents: LoopRow[] }> }).cliAgentsList?.().catch(() => ({ ok: false, agents: [] })) ?? Promise.resolve({ ok: false, agents: [] as LoopRow[] }),
    api().schedulesList() as Promise<Env<ScheduleRow[]>>,
  ]);
  const agents = env.ok ? env.data ?? [] : [];
  loopRows = loops.ok ? loops.agents ?? [] : [];
  const slug = s.id.slice(s.id.indexOf(":") + 1);
  const rows = scheds.ok ? scheds.data ?? [] : [];
  const isTask = typeOf(s) === "task";

  if (count) count.textContent = `· ${agents.length}`;
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
    if (hubItem) {
      const chip = document.createElement("span");
      chip.className = "app-conn-state";
      chip.textContent = "Set after Add";
      right.appendChild(chip);
      host.appendChild(r);
      continue;
    }

    // WHAT IT RUNS ON.
    const modelSel = document.createElement("select");
    const loopSel = document.createElement("select");
    loopSel.className = "settings-input skill-slot-select";
    loopSel.title = "What this agent runs on";
    loopSel.innerHTML = `<option value="">Default</option>` + loopRows.map((l) => `<option value="${escapeHtml(l.id)}"${l.id === a.loop ? " selected" : ""}>${escapeHtml(l.name)}</option>`).join("");
    loopSel.addEventListener("change", () => {
      // The models follow immediately; the write and the repaint come after.
      void fillModelChoices(modelSel, loopSel.value, a.model);
      void setAgent(s, a, { loop: loopSel.value }, `${a.name} runs on ${loopRows.find((l) => l.id === loopSel.value)?.name ?? "the default"}`);
    });
    right.appendChild(loopSel);

    // WHICH MODEL — the loop's own choices, so nothing offers a model it can't run.
    modelSel.className = "settings-input skill-model-select";
    modelSel.title = "Model for this agent";
    modelSel.innerHTML = `<option value="">Model: default</option>${a.model ? `<option value="${escapeHtml(a.model)}" selected>${escapeHtml(a.model)}</option>` : ""}`;
    modelSel.addEventListener("change", () => void setAgent(s, a, { model: modelSel.value }, `${a.name} uses ${modelSel.value || "the default model"}`));
    right.appendChild(modelSel);
    void fillModelChoices(modelSel, a.loop || loopRows[0]?.id || "", a.model);

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

/** Which provider a loop can actually run. A CLI speaks its own vendor's
 *  models; anything else (a custom loop) gets the whole catalog. */
const LOOP_PROVIDER: Record<string, string> = {
  claude: "anthropic", codex: "openai", gemini: "google", copilot: "openai", cursor: "anthropic",
};
interface CatalogModel { id: string; name: string; providerSlug: string; active: boolean }
let modelCatalog: CatalogModel[] | null = null;

/**
 * THE MODEL LIST FOLLOWS THE LOOP (his report, 2026-09-17: "the model dropdown
 * never changes"). It was asking loop-roles, whose choices are AGENTS, not
 * models, so it always came back with nothing and kept the one default entry.
 * The org's model catalog is the list, narrowed to what the chosen loop runs.
 */
async function fillModelChoices(sel: HTMLSelectElement, loop: string, chosen: string): Promise<void> {
  if (!modelCatalog) {
    const all = await (window.glyphh as unknown as { catalogModels?: () => Promise<CatalogModel[]> }).catalogModels?.().catch(() => []);
    modelCatalog = Array.isArray(all) ? all : [];
  }
  const provider = LOOP_PROVIDER[String(loop || "").toLowerCase()];
  const models = modelCatalog
    .filter((m) => m.active !== false)
    .filter((m) => !provider || m.providerSlug === provider)
    .sort((a, b) => a.name.localeCompare(b.name));
  const options = [`<option value="">Model: default</option>`];
  // A model the agent already names survives even when the catalog moved on.
  if (chosen && !models.some((m) => m.id === chosen)) options.push(`<option value="${escapeHtml(chosen)}" selected>${escapeHtml(chosen)}</option>`);
  for (const m of models) options.push(`<option value="${escapeHtml(m.id)}"${m.id === chosen ? " selected" : ""}>${escapeHtml(m.name)}</option>`);
  sel.innerHTML = options.join("");
  sel.disabled = models.length === 0 && !chosen;
  sel.title = provider ? `Models ${loop} can run` : "Model for this agent";
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
  host.textContent = "";
  if (!runs.length) { host.innerHTML = `<div class="crud-empty">${r.ok ? "No runs." : escapeHtml(r.error || "Couldn't load runs.")}</div>`; return; }
  const rel = (ms: number): string => { const a = Math.abs(ms); const u = a < 60_000 ? ["s", 1000] as const : a < 3_600_000 ? ["m", 60_000] as const : a < 86_400_000 ? ["h", 3_600_000] as const : ["d", 86_400_000] as const; return `${Math.round(a / u[1])}${u[0]} ago`; };
  for (const run of runs) {
    const e = document.createElement("div");
    e.className = "ws-task-run" + (run.status === "ok" ? "" : run.status === "running" ? " running" : " failed") + (openRunId === run.id ? " open" : "");
    const when = new Date(run.startedAt);
    e.innerHTML = `<div class="ws-task-run-head"><span class="ws-task-chip ${run.status === "ok" ? "ok" : run.status === "running" ? "" : "err"}">${escapeHtml(run.status)}</span><span class="ws-task-run-trigger">${escapeHtml(run.trigger)}</span><span class="ws-task-run-when" title="${escapeHtml(when.toLocaleString())}">${escapeHtml(rel(when.getTime() - Date.now()))}</span>${run.durationMs != null ? `<span class="ws-task-run-dur">${(run.durationMs / 1000).toFixed(1)}s</span>` : ""}<span class="ws-task-run-count">${run.journal.events.length} events</span>${run.status === "running" ? `<button class="action-btn ws-task-cancel" type="button">Cancel</button>` : ""}</div><div class="task-story hidden"></div>`;
    const head = e.querySelector(".ws-task-run-head") as HTMLElement;
    const story = e.querySelector(".task-story") as HTMLElement;
    head.addEventListener("click", (ev) => {
      if ((ev.target as HTMLElement).closest(".ws-task-cancel")) return;
      openRunId = openRunId === run.id ? null : run.id;
      e.classList.toggle("open", openRunId === run.id);
      story.classList.toggle("hidden", openRunId !== run.id);
      if (openRunId === run.id && !story.childElementCount) paintStory(story, run);
    });
    e.querySelector(".ws-task-cancel")?.addEventListener("click", async () => {
      await (api() as unknown as { taskRunCancel: (id: string) => Promise<Env<unknown>> }).taskRunCancel(run.id);
      void paintTaskRuns(s);
    });
    if (openRunId === run.id) paintStory(story, run);
    host.appendChild(e);
  }
}

function paintStory(host: HTMLElement, run: TaskRunRow): void {
  host.textContent = "";
  const line = (kind: string, title: string, body?: string, cls = ""): void => {
    const d = document.createElement("div");
    d.className = `task-event task-event-${kind}${cls ? ` ${cls}` : ""}`;
    d.innerHTML = `<div class="task-event-head"><span class="task-event-kind">${escapeHtml(kind)}</span><span class="task-event-title"></span></div>${body ? `<pre class="task-event-body"></pre>` : ""}`;
    (d.querySelector(".task-event-title") as HTMLElement).textContent = title;
    const pre = d.querySelector(".task-event-body") as HTMLElement | null; if (pre) pre.textContent = body || "";
    host.appendChild(d);
  };
  const show = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v, null, 2));
  if (run.input && Object.keys(run.input as object).length) line("input", "what it got", show(run.input));
  for (const ev of run.journal.events) {
    const t = new Date(ev.t).toLocaleTimeString();
    if (ev.kind === "agent") line("agent", `${t} · ${ev.agent || ev.slot} took the ${ev.slot} slot${ev.error ? " · failed" : ""}`, `${show(ev.prompt)}\n\n→ ${ev.error ? show(ev.error) : show(ev.json ?? ev.output)}`, ev.error ? "failed" : "");
    else if (ev.kind === "connection") line("connection", `${t} · ${ev.app} · ${ev.tool}${ev.error ? " · failed" : ""}`, `${show(ev.args)}\n\n→ ${ev.error ? show(ev.error) : show(ev.result)}`, ev.error ? "failed" : "");
    else if (ev.kind === "data") line("data", `${t} · ${ev.repo}${ev.rows != null ? ` · ${ev.rows} rows` : ev.changes != null ? ` · ${ev.changes} changed` : ""}${ev.error ? " · failed" : ""}`, `${show(ev.sql)}${ev.error ? `\n\n→ ${show(ev.error)}` : ""}`, ev.error ? "failed" : "");
    else if (ev.kind === "checkpoint") line("checkpoint", `${t} · ${ev.key}${ev.replayed ? " · replayed" : ""}`);
    else if (ev.kind === "log") line("log", `${t} · ${show(ev.message)}`, ev.detail != null ? show(ev.detail) : undefined);
    else if (ev.kind === "resume") line("resume", `${t} · picked up after a restart`);
  }
  if (run.error) line("failed", run.error, undefined, "failed");
  if (run.status === "ok") line("result", "what it returned", show(run.result));
}

const AGENT_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 3v4M9 12h.01M15 12h.01M9 16h6"/></svg>`;

/** The app's tools (tools/manifest.json) with the same permission grammar as a connection's. */
async function paintBundleTools(s: SkillDetail, read: (rel: string) => Promise<string>, rel: string): Promise<void> {
  const host = el("skill-tools-list"); const count = el("skill-tool-count");
  if (!host) return;
  let tools: Array<{ name: string; description?: string }> = [];
  try { tools = ((JSON.parse(await read(rel) || "{}") as { tools?: typeof tools }).tools ?? []).filter((t) => t && t.name); } catch { tools = []; }
  if (count) count.textContent = `· ${tools.length}`;
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
 *  order, 2026-09-17): the connector's own logo, a Type column, the Shared
 *  badge, a check when connected and a Connect button when not. The rows are
 *  rendered by that page so the two tables cannot drift. Either manifest
 *  shape is accepted, since a hand-written one carries bare slugs. */
async function paintBundleConnections(raw: Array<ConnDep | string>): Promise<void> {
  const deps = connDeps(raw);
  const host = el("skill-connections-list"); const count = el("skill-conn-count");
  if (!host) return;
  if (count) count.textContent = `· ${deps.length}`;
  host.textContent = "";
  if (!deps.length) { host.innerHTML = `<div class="crud-empty">No connections.</div>`; return; }
  await renderConnectionTable(host, deps);
}

async function openDetail(id: string): Promise<void> {
  const r = await api().skillGet(id) as Env<SkillDetail>;
  if (!r.ok || !r.data) { fail(r.error || `Couldn't open that ${cfg.noun}.`); return; }
  hubItem = null;
  current = r.data;
  currentFile = "";
  editing = false;
  el("skills-list-view")?.classList.add("hidden");
  el("skill-detail-view")?.classList.remove("hidden");
  const s = current;
  setDetailName(s.name, s.type);
  (el("skill-detail-sub") as HTMLElement).textContent = `${s.author ? `by ${s.author}` : "by you"} · updated ${when(s.updatedAt)}`;
  const box = el<HTMLInputElement>("skill-enabled"); if (box) box.checked = s.enabled;
  const share = el<HTMLButtonElement>("skill-share"); if (share) { share.textContent = "Share"; share.disabled = false; }
  (el("skill-file-count") as HTMLElement).textContent = `· ${s.files.length}`;
  (el("skill-overview-desc") as HTMLElement).textContent = s.description || "No description in the frontmatter.";
  setDetailIcon(s);
  void paintExtras(s, null);
  const local = s.source === "glyphh" || s.source === "app" || s.source === "plugin" || s.source === "task";
  (el("skill-author") as HTMLElement).textContent = s.author || (local ? "You" : SOURCE_LABEL[s.source].replace("From ", ""));
  (el("skill-author-meta") as HTMLElement).textContent = local ? "On this machine" : `Loaded by ${SOURCE_LABEL[s.source].replace("From ", "")}`;
  paintSource(s.id);
  viewedVersion = null;
  shareState = { head: null, pending: null };
  shareItem = null;
  paintCategories();
  paintDetailChrome();
  paintDetailTabs(typeOf(s));
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
  const r = await api().skillVersions(id) as Env<{ itemId: string | null; kind?: BundleType; versions: Array<{ version: number; notes: string; createdAt: string }>; head?: number | null; pending?: number | null; categories?: string[] }>;
  if (!current || current.id !== id) return;
  versionItemId = r.ok ? (r.data?.itemId ?? null) : null;
  shareState = { head: r.ok ? r.data?.head ?? null : null, pending: r.ok ? r.data?.pending ?? null : null };
  shareItem = r.ok && r.data?.itemId
    ? { id: r.data.itemId, kind: r.data.kind ?? typeOf(current), categories: r.data.categories ?? [] }
    : null;
  paintShareChip();
  paintCategories();
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
    const r = await api().skillVersionFiles(versionItemId, Number(value), typeOf(current)) as Env<Record<string, string>>;
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

type DetailTab = "overview" | "contents" | "skills" | "tools" | "connections" | "agents" | "runs" | "flow";
/** One agent a bundle ships: agents/<name>.md, or a task's slot under the older name. */
interface BundleAgentRow { ref: string; name: string; description: string; loop: string; model: string; source: "file" | "slot" }
interface ScheduleRow { id: string; kind: string; target: string; cron: string; enabled: boolean; agentId?: string; name?: string }
/** Which tabs a type earns. Overview and Contents are every bundle's; the rest
 *  are what that kind of skill actually has. */
const TABS_FOR: Record<BundleType, DetailTab[]> = {
  skill: ["overview", "contents", "agents"],
  app: ["overview", "contents", "skills", "tools", "agents", "connections"],
  task: ["overview", "flow", "contents", "agents", "runs", "connections"],
  plugin: ["overview", "contents", "skills"],
};
/** Show only the tabs this item earns. */
function paintDetailTabs(type: BundleType): void {
  const allowed = TABS_FOR[type];
  document.querySelectorAll<HTMLButtonElement>(`${cfg.panel} .skills-tab[data-dtab]`)
    .forEach((b) => b.classList.toggle("hidden", !allowed.includes(b.dataset.dtab as DetailTab)));
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
  if (t === "runs" && current && !hubItem) void paintTaskRuns(current);
  if (t === "flow") paintFlow();
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
  const v = r.data?.version;
  const approved = r.data?.status === "approved";
  shareState = approved ? { head: v ?? null, pending: null } : { head: shareState.head, pending: v ?? null };
  paintShareChip();
  paintCategories();
  notice(approved
    ? `"${current.name}" is live on your organization's hub as v${v}. Members install it from Discover.`
    : `"${current.name}" v${v} went to your organization's review desk. An org admin decides; sharing again replaces it.`);
  void loadVersions();
}

function authorOf(s: SkillRow): string {
  return s.author || (s.source === "glyphh" ? "You" : SOURCE_LABEL[s.source].replace("From ", ""));
}

function paintControls(): void {
  const f = el("skills-filter"); const so = el("skills-sort");
  const mine = tab === "mine";
  f?.classList.toggle("hidden", !mine); so?.classList.toggle("hidden", !mine);
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
  document.querySelectorAll<HTMLButtonElement>(`${cfg.panel} .skills-tab[data-tab]`).forEach((b) => b.addEventListener("click", async () => {
    tab = b.dataset.tab as "mine" | "discover";
    discoverView = { kind: "home" };
    if (tab === "discover") await loadDiscover();
    renderList();
  }));
  el("skills-filter")?.addEventListener("click", (e) => openMenu(e.currentTarget as HTMLElement, filterMenu()));
  el("skills-sort")?.addEventListener("click", (e) => openMenu(e.currentTarget as HTMLElement, sortMenu()));
  el("skills-add")?.addEventListener("click", (e) => openMenu(e.currentTarget as HTMLElement, [
    ...KINDS.map((k) => ({ label: `New ${TYPE_LABEL[k]}`, onClick: () => void createNew(k) })),
    { label: "Import from file…", onClick: () => void importFromFile() },
    { label: "Install from Discover", onClick: async () => { tab = "discover"; await loadDiscover(); renderList(); } },
  ]));
  el("skill-back")?.addEventListener("click", () => {
    if (hubItem) {
      hubItem = null; viewedVersion = null; current = null;
      el("skill-detail-view")?.classList.add("hidden");
      el("skills-list-view")?.classList.remove("hidden");
      renderList();
      return;
    }
    void loadSkillsSettings();
  });
  document.querySelectorAll<HTMLButtonElement>(`${cfg.panel} .skills-tab[data-dtab]`).forEach((b) => b.addEventListener("click", () => selectDetailTab(b.dataset.dtab as DetailTab)));
  if (KINDS.includes("task")) {
    (api() as unknown as { onTaskRunsChanged?: (fn: () => void) => void }).onTaskRunsChanged?.(() => {
      if (current && !hubItem && el("skill-runs") && !el("skill-runs")!.classList.contains("hidden")) void paintTaskRuns(current);
    });
    (window as unknown as { __glyphhOpenTaskRun?: (slug: string, runId: string) => void }).__glyphhOpenTaskRun = (slug, runId) => {
      openRunId = runId;
      void openDetail(`task:${slug}`).then(() => selectDetailTab("runs"));
    };
  }
  el<HTMLInputElement>("skill-enabled")?.addEventListener("change", (e) => { if (current) void toggle(current.id, (e.target as HTMLInputElement).checked); });
  el("skill-share")?.addEventListener("click", () => void share());
  el("skill-kebab")?.addEventListener("click", async (e) => {
    if (!current) return;
    const anchor = e.currentTarget as HTMLElement;
    const loops = await configuredLoops();
    openMenu(anchor, [
      { label: "Try in chat", onClick: tryInChat },
      ...loops.map((l) => ({ label: `Edit with ${l.name}`, onClick: () => editWith(l) })),
      { label: "Check for updates", onClick: () => void checkForUpdates() },
      ...(standings[current.id] ? [{ label: `Reinstall v${standings[current.id]!.latest} from the hub`, onClick: () => void reinstall() }] : []),
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
  kind: "skill", kinds: ["skill", "app", "task"], id: (x) => x, panel: '.settings-panel[data-sub="skills"]', noun: "skill", nouns: "skills", icon: SKILL_ICON, back: "Skills",
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
