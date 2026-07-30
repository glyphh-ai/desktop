/**
 * Code workbench — the old workbench rails, hosted in the Code section.
 *
 * Faithful port of the v4 right-rail tiling system (via the standalone
 * workbench app), mounted in the Code tab's right aside. Behavior matches:
 *   - Each rail column can hold up to 2 slots stacked vertically.
 *   - Opening a section appends to the first rail with <2 slots; once
 *     full, a new rail spawns to the right.
 *   - Click the section toggle in the header again to close ALL slots
 *     of that view.
 *   - Drag the left edge of a rail to resize its width; drag the vsep
 *     between two slots in a rail to adjust their relative heights.
 *
 * Folder picker is the same chrome as the Agent app (yo-workdir-bar) so
 * the two folder-bound apps feel identical.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { formatMarkdown } from "./format-markdown.js";
import { appIconInner, primeNativeIcons } from "./help/app-icon.js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

interface FileEntry { name: string; path: string; kind: "dir" | "file" }
interface TreeNode extends FileEntry {
  depth: number;
  open?: boolean;
  loaded?: boolean;
  children?: TreeNode[];
}

interface WbApi {
  getCwd: () => Promise<string>;
  pickCwd: () => Promise<string | null>;
  setCwd: (dir: string) => Promise<string>;
  getCwdRecents: () => Promise<string[]>;
  gitInfo: (root: string) => Promise<{ isRepo: boolean; branch?: string }>;
  onCwdChanged: (cb: (dir: string | null) => void) => () => void;
  onFileChanged: (cb: (absPath: string) => void) => () => void;
  listDir: (dir: string) => Promise<{ entries: FileEntry[]; error?: string }>;
  searchFiles: (dir: string, query: string) => Promise<{ entries: Array<{ name: string; rel: string; path: string; kind: "dir" | "file" }>; truncated?: boolean; error?: string }>;
  pickFile: () => Promise<string | null>;
  mkdir: (dirPath: string) => Promise<{ ok: boolean; error?: string }>;
  deletePath: (target: string) => Promise<{ ok: boolean; error?: string }>;
  renamePath: (oldPath: string, newPath: string) => Promise<{ ok: boolean; error?: string }>;
  platform: string;
  previewNative: (filePath: string) => Promise<{ ok: boolean; method?: string; error?: string }>;
  convertPreview: (filePath: string) => Promise<{ pdfPath?: string; error?: string }>;
  readFile: (filePath: string) => Promise<{ content: string; error?: string }>;
  writeFile: (filePath: string, content: string) => Promise<{ ok: boolean; error?: string }>;
  gitDiff: (root: string) => Promise<{ text: string; error?: string }>;
  termSpawn: (termId: string, cwd: string, cols: number, rows: number) => void;
  termWrite: (termId: string, data: string) => void;
  termResize: (termId: string, cols: number, rows: number) => void;
  termKill: (termId: string) => void;
  termOnData: (termId: string, cb: (data: string) => void) => () => void;
  termOnExit: (termId: string, cb: (code: number) => void) => () => void;
  getTheme: () => Promise<string>;
  onThemeChanged: (cb: (theme: string) => void) => () => void;
}
declare global { interface Window { wb: WbApi } }

type ViewKind = "files" | "terminal" | "diff" | "preview" | "monaco" | "plan" | "coding" | "section" | "app";

interface MonacoTab {
  name: string; path: string; content: string;
  /** For .md files: "preview" renders markdown, "code" shows raw Monaco
   *  source. Non-markdown tabs ignore this and always render code. */
  mode?: "preview" | "code";
  dirty?: boolean;
}
interface MonacoSlot { id: number; view: "monaco"; tabs: MonacoTab[]; activeIdx: number; sticky?: boolean }
interface FilesSlot { id: number; view: "files"; root?: TreeNode | null; sticky?: boolean }
interface WbTerminal {
  /** Stable id used as the IPC channel suffix (`wb-term:data:<id>`). */
  ptyId: string;
  /** A layout-slotted first command — written to the pty once, right after
   *  spawn (the working folder is already the spawn cwd). */
  initCmd?: string;
  /** xterm instance — kept alive across re-renders so scrollback survives. */
  term?: Terminal;
  fit?: FitAddon;
  /** Detach functions for IPC subscriptions. */
  detach?: () => void;
  /** Persistent host-size observer — keeps the xterm filling its container no
   *  matter when/how the host grows (solo windows, layout settle, resizes). */
  ro?: ResizeObserver;
}
interface TermSlot {
  id: number; view: "terminal";
  terminals: WbTerminal[];
  activeIdx: number;
  sticky?: boolean;
}
/** Files are CLOSED by default — `expanded` tracks the ones the user opened. */
interface DiffSlot { id: number; view: "diff"; expanded?: Set<string>; sticky?: boolean }
/** The Coding Agent tile — HOSTS the live agent DOM (same sessions, same
 *  composer); nothing of its own beyond the header's session controls. */
interface CodingSlot { id: number; view: "coding"; sticky?: boolean }
/** A whole app SECTION (Home, Apps, Settings, Drips, …) hosted as a panel —
 *  the section's singleton DOM is adopted into the slot body (the same
 *  reparenting trick the coding slot uses for the agent). */
interface SectionSlot { id: number; view: "section"; section: string; sticky?: boolean }
interface PreviewSlot {
  id: number; view: "preview"; url?: string; viewKey?: string; sticky?: boolean;
  /** Inline document (Glyphh build previews) — runtime-only, never persisted. */
  html?: string; htmlLabel?: string;
}

interface PlanSlot {
  id: number; view: "plan";
  sticky?: boolean;
  /** "preview" renders the markdown (default; Plan is markdown-first),
   *  "code" shows the raw Monaco editor for direct editing. */
  mode: "preview" | "code";
}
/** An app rendered IN the workbench — the replacement for OS app windows.
 *  The slot body is only a placeholder rectangle; the real <webview> lives in
 *  a stable overlay layer (webviews reload when reparented, and renderRails
 *  rebuilds the DOM constantly) and is position-synced onto the placeholder
 *  every frame while any app slot is open. */
interface AppSlot {
  id: number; view: "app";
  slug: string; name: string;
  /** Web apps: the URL to load. Installed Glyphh apps resolve their file://
   *  entry at mount time (glyphh-app:preview-open grants caps + returns it). */
  url: string;
  glyphh?: boolean;
  /** Runtime: the browser chrome (address bar row) is collapsed. Toggled from
   *  the panel header, applied to the overlay holder. */
  urlBarHidden?: boolean;
  /** The app-switch target: opening an app reuses THIS panel. Set when a
   *  layout designates a sticky cell; at most one app slot is sticky. */
  sticky?: boolean;
}
type Slot = MonacoSlot | FilesSlot | TermSlot | DiffSlot | PreviewSlot | PlanSlot | CodingSlot | SectionSlot | AppSlot;

interface Rail { id: number; slots: Slot[]; prefWidth?: number; banner?: "top" | "bottom"; heightFrac?: number }

function makeTermId(): string {
  return `wbt-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}
function basename(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() || p;
}
function homeShorten(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

const FOLDER_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>`;
const CHECK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
// 4 outward arrows — expand to fullscreen. 4 inward arrows — restore.
const MAXIMIZE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;
const RESTORE_SVG  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;

const VIEW_META: Record<string, { title: string; icon: string }> = {
  files:    { title: "Files",    icon: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>` },
  terminal: { title: "Terminal", icon: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>` },
  diff:     { title: "Diff",     icon: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="3" x2="12" y2="21"/><polyline points="8 7 4 11 8 15"/><polyline points="16 9 20 13 16 17"/></svg>` },
  preview:  { title: "Browser",  icon: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>` },
  monaco:   { title: "Editor",   icon: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>` },
  coding:   { title: "Coding Agent", icon: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><polyline points="9 9 7 11 9 13"/><polyline points="15 9 17 11 15 13"/></svg>` },
  plan:     { title: "Plan",     icon: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>` },
  app:      { title: "App",      icon: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>` },
};

/** Panel titles for hosted sections (slot headers + layout minis). */
const SECTION_TITLES: Record<string, string> = {
  dashboard: "Home", connections: "Connections", apps: "Apps", layouts: "Layouts",
  skills: "Skills", loops: "Loops", agents: "Agents", models: "Models",
  settings: "Settings", docs: "Docs", drips: "Drips",
};

// ── Monaco loader (AMD path: window.require + monaco/ assets in dist) ──
let monacoReady: Promise<void> | null = null;
function ensureMonaco(): Promise<void> {
  if (monacoReady) return monacoReady;
  monacoReady = new Promise<void>((resolve) => {
    const w = window as unknown as { monaco?: unknown; require: { config: (cfg: unknown) => void; (deps: string[], cb: () => void): void } };
    if (w.monaco) { resolve(); return; }
    w.require.config({ paths: { vs: "monaco" } });
    w.require(["vs/editor/editor.main"], () => resolve());
  });
  return monacoReady;
}
function languageForFile(name: string): string {
  const ext = name.toLowerCase().split(".").pop() || "";
  const map: Record<string, string> = {
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
    ts: "typescript", tsx: "typescript", json: "json", md: "markdown", mdx: "markdown",
    markdown: "markdown", yaml: "yaml", yml: "yaml", html: "html", htm: "html",
    css: "css", scss: "scss", less: "less", sh: "shell", bash: "shell", py: "python",
    rb: "ruby", go: "go", rs: "rust", toml: "ini", ini: "ini", xml: "xml", svg: "xml",
  };
  return map[ext] || "plaintext";
}
function monacoTheme(): string {
  return (document.documentElement.dataset.theme || document.body.dataset.theme) === "dark" ? "vs-dark" : "vs";
}
function isMarkdown(name: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(name);
}

async function init(): Promise<void> {
  if (!window.wb) {
    console.error("[code-workbench] window.wb bridge missing — preload not loaded; workdir controls and rails are dead.");
    return;
  }

  let cwd = await window.wb.getCwd().catch(() => "");

  // Default address-bar visibility for app panels — a roaming pref set in
  // Settings → Appearance. New app slots inherit it; the per-panel header
  // toggle overrides. Settings dispatches an event so changes apply live.
  const yoPrefs = (window as unknown as { yo?: { getPreference?: (k: string, d?: unknown) => Promise<unknown> } }).yo;
  let appUrlBarShow = (await yoPrefs?.getPreference?.("showAppUrlBar", true)) !== false;
  const urlBarHiddenDefault = (): boolean => !appUrlBarShow;
  document.addEventListener("glyphh:app-urlbar-default", (e) => { appUrlBarShow = !!(e as CustomEvent).detail; });

  // ── Workdir bar — mirrors agent.ts ──
  const workdirBtn = document.getElementById("code-workdir-btn") as HTMLButtonElement | null;
  const workdirName = document.getElementById("code-workdir-name");
  const workdirAdd = document.getElementById("code-workdir-add") as HTMLButtonElement | null;
  const branchWrap = document.getElementById("code-workdir-branch-wrap");
  const branchEl = document.getElementById("code-workdir-branch");

  const dropdown = document.createElement("div");
  dropdown.className = "yo-workdir-menu";
  dropdown.setAttribute("role", "menu");
  document.body.appendChild(dropdown);
  const closeDropdown = () => dropdown.classList.remove("open");
  const isDropdownOpen = () => dropdown.classList.contains("open");

  async function paintWorkdirBar(dir: string): Promise<void> {
    if (workdirName) workdirName.textContent = dir ? basename(dir) : "Pick a folder";
    if (workdirBtn) workdirBtn.title = dir ? `working directory: ${dir}` : "Pick a folder";
    if (!dir) {
      if (branchWrap) (branchWrap as HTMLElement).style.display = "none";
      return;
    }
    try {
      const info = await window.wb.gitInfo(dir);
      if (info.isRepo && info.branch && branchWrap && branchEl) {
        branchEl.textContent = info.branch;
        (branchWrap as HTMLElement).style.display = "";
      } else if (branchWrap) {
        (branchWrap as HTMLElement).style.display = "none";
      }
    } catch {
      if (branchWrap) (branchWrap as HTMLElement).style.display = "none";
    }
  }

  async function openDropdown(): Promise<void> {
    const recents = await window.wb.getCwdRecents().catch(() => [] as string[]);
    dropdown.innerHTML = "";
    const list = recents.length ? recents : (cwd ? [cwd] : []);
    for (const dir of list) {
      const item = document.createElement("button");
      item.className = "yo-workdir-menu-item";
      item.innerHTML =
        `<span class="check">${dir === cwd ? CHECK_SVG : ""}</span>` +
        `<span class="ic">${FOLDER_SVG}</span>` +
        `<span class="nm"></span>`;
      (item.querySelector(".nm") as HTMLElement).textContent = homeShorten(dir);
      item.title = dir;
      item.addEventListener("click", async () => {
        closeDropdown();
        if (dir !== cwd) await window.wb.setCwd(dir);
      });
      dropdown.appendChild(item);
    }
    const sep = document.createElement("div");
    sep.className = "yo-workdir-menu-sep";
    dropdown.appendChild(sep);
    const choose = document.createElement("button");
    choose.className = "yo-workdir-menu-item";
    choose.textContent = "Choose folder…";
    choose.addEventListener("click", async () => {
      closeDropdown();
      await window.wb.pickCwd();
    });
    dropdown.appendChild(choose);

    if (workdirBtn) {
      const r = workdirBtn.getBoundingClientRect();
      dropdown.style.left = `${r.left}px`;
      dropdown.style.top = `${r.bottom + 4}px`;
      dropdown.style.bottom = "auto";
    }
    dropdown.classList.add("open");
  }

  workdirBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    isDropdownOpen() ? closeDropdown() : void openDropdown();
  });
  workdirAdd?.addEventListener("click", (e) => {
    e.stopPropagation();
    void window.wb.pickCwd();
  });
  document.addEventListener("click", (e) => {
    if (!isDropdownOpen()) return;
    if (dropdown.contains(e.target as Node)) return;
    if (workdirBtn?.contains(e.target as Node)) return;
    closeDropdown();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isDropdownOpen()) closeDropdown();
  });

  // ── Rails state ──
  const rails: Rail[] = [];
  let nextRailId = 1;
  let nextSlotId = 1;

  // Drag state — set on dragstart, cleared on dragend/drop.
  let dragSlotId: number | null = null;
  // Fullscreen state — when set, the rails container hides every other rail
  // and every other slot in this slot's rail (via the .has-fullscreen +
  // .fullscreen CSS classes). Toggled by the slot-header maximize button.
  let maximizedSlotId: number | null = null;
  function toggleMaximize(slotId: number): void {
    maximizedSlotId = (maximizedSlotId === slotId) ? null : slotId;
    paintFullscreenClasses();
  }
  function paintFullscreenClasses(): void {
    const container = document.getElementById("code-wb-rails");
    if (!container) return;
    container.classList.toggle("has-fullscreen", maximizedSlotId !== null);
    // Maximize floods the whole section: the agent column collapses and the
    // rails take its width; restore puts everything back (wb-max in styles).
    document.body.classList.toggle("wb-max", maximizedSlotId !== null);
    container.querySelectorAll<HTMLElement>(".ws-right-rail").forEach((railEl) => {
      const railHasMax = !!railEl.querySelector(`.ws-rail-slot[data-slot-id="${maximizedSlotId}"]`);
      railEl.classList.toggle("rail-has-fullscreen", maximizedSlotId !== null && railHasMax);
    });
    container.querySelectorAll<HTMLElement>(".ws-rail-slot").forEach((el) => {
      el.classList.toggle("fullscreen", Number(el.dataset.slotId) === maximizedSlotId);
    });
    // Repaint each maximize button so it shows the right icon for its state.
    container.querySelectorAll<HTMLElement>(".ws-rail-slot .slot-maximize").forEach((btn) => {
      const slotId = Number((btn.closest(".ws-rail-slot") as HTMLElement)?.dataset.slotId);
      btn.innerHTML = (slotId === maximizedSlotId) ? RESTORE_SVG : MAXIMIZE_SVG;
      (btn as HTMLButtonElement).title = (slotId === maximizedSlotId) ? "Restore" : "Maximize";
    });
    // Slot sizes just changed (flood/restore) — refit live terminals so the
    // pty cols/rows track the new size.
    requestAnimationFrame(() => {
      for (const rail of rails) {
        for (const slot of rail.slots) {
          if (slot.view === "terminal") {
            const t = (slot as TermSlot).terminals[(slot as TermSlot).activeIdx];
            if (t?.fit && t.term?.element?.isConnected) {
              try { t.fit.fit(); } catch { /* noop */ }
            }
          }
        }
      }
    });
  }

  // ── Layout persistence (per-cwd) ──
  // Persists the toggleable views' positions only (Files/Terminal/Diff/Preview).
  // Monaco is spawned on demand by clicking a file in the tree — its tabs are
  // runtime state and would feel surprising to restore.
  type SavedView = ViewKind | { view: "app"; slug: string; name: string; url: string; glyphh?: boolean; sticky?: boolean } | { view: "section"; section: string };
  type SavedLayout = { rails: { width?: number; topSlotHeight?: number; banner?: "top" | "bottom"; heightFrac?: number; views: SavedView[] }[] };
  type PanelAppRow = { id: string; slug?: string; name: string; url?: string | null; isBrowser?: boolean; execPath?: string | null; appArchetype?: string | null; system?: boolean; launchConfig?: Record<string, unknown> | null };
  type LayoutRow = { name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; target?: "glyphh" | "desktop"; sessionMode?: "keep" | "new" | "last"; folder?: string | null; splits: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number; sticky?: boolean; config?: { url?: string; cmd?: string } }> };

  function layoutKey(): string { return `workbench:layout:${cwd || "__nohome__"}`; }
  // The NAMED layout currently arranged in the workbench. While set, every
  // geometry change (rail widths, slot heights, panel arrangement) also saves
  // under the layout's own key — so reopening the layout recalls how the user
  // left it, not the server's default placement.
  let activeLayoutName: string | null = null;
  function namedLayoutKey(name: string): string { return `workbench:namedlayout:${name.trim().toLowerCase()}`; }
  /** The chat session last used while this named layout was active. */
  function layoutSessionKey(name: string): string { return `workbench:layoutsession:${name.trim().toLowerCase()}`; }
  function saveLayout(): void {
    try {
      const railEls = document.querySelectorAll<HTMLElement>(".ws-right-rail");
      const topHeightByIdx = new Map<number, number>();
      railEls.forEach((el, i) => {
        const topSlot = el.querySelector(".ws-rail-slot") as HTMLElement | null;
        if (topSlot && topSlot.style.flex) {
          const m = topSlot.style.flex.match(/0 0 (\d+(?:\.\d+)?)px/);
          if (m) topHeightByIdx.set(i, parseFloat(m[1]));
        }
      });
      const data: SavedLayout = {
        rails: rails.map((r, i) => ({
          // prefWidth is the user's intended/preferred width — saved + restored
          // exactly. applyResponsiveWidths derives the *displayed* width from
          // this when the container can't fit everything at preference.
          width: r.prefWidth,
          topSlotHeight: r.slots.length === 2 ? topHeightByIdx.get(i) : undefined,
          banner: r.banner,
          heightFrac: r.heightFrac,
          // Monaco persists as the PANE only — tabs are runtime state; the
          // editor comes back empty, ready for the Files tree.
          views: r.slots.map((s): SavedView =>
            s.view === "app"
              ? { view: "app", slug: s.slug, name: s.name, url: s.url, glyphh: s.glyphh, sticky: s.sticky }
              : s.view === "section"
                ? { view: "section", section: s.section }
                : s.view),
        })).filter((r) => r.views.length > 0),
      };
      localStorage.setItem(layoutKey(), JSON.stringify(data));
      // A named layout's arrangement is ITS OWN memory.
      if (activeLayoutName && data.rails.length) {
        localStorage.setItem(namedLayoutKey(activeLayoutName), JSON.stringify(data));
      }
      if (rails.length === 0) activeLayoutName = null;
    } catch { /* localStorage may be unavailable in some contexts */ }
  }

  /** Rebuild the rails from a saved snapshot — shared by the per-folder
   *  restore (loadLayout) and named-layout recall. */
  function applySavedLayout(data: SavedLayout, postBuild?: () => void): void {
    rails.length = 0;
    for (const savedRail of data.rails || []) {
      const slots: Slot[] = [];
      for (const v of (savedRail.views || []).slice(0, 2)) {
        if (typeof v === "object" && v !== null && v.view === "app" && v.slug) {
          slots.push({ id: nextSlotId++, view: "app", slug: v.slug, name: v.name || v.slug, url: v.url || "", glyphh: v.glyphh, sticky: v.sticky, urlBarHidden: urlBarHiddenDefault() });
        } else if (typeof v === "object" && v !== null && v.view === "section" && v.section) {
          slots.push({ id: nextSlotId++, view: "section", section: v.section });
        } else if (v === "files" || v === "terminal" || v === "diff" || v === "preview" || v === "plan" || v === "coding" || v === "monaco") {
          slots.push(makeSlot(v));
        }
      }
      if (slots.length) {
        rails.push({ id: nextRailId++, slots, prefWidth: savedRail.width, banner: savedRail.banner, heightFrac: savedRail.heightFrac });
      }
    }
    postBuild?.();
    renderRails();
    requestAnimationFrame(() => {
      applyResponsiveWidths();
      const railEls = document.querySelectorAll<HTMLElement>(".ws-right-rail");
      (data.rails || []).forEach((r, i) => {
        // Never pin the CODING tile to a stale pixel height — the hosted
        // agent always flexes to fill; pins apply to the other views only.
        if (r.topSlotHeight && railEls[i] && rails[i]?.slots[0]?.view !== "coding") {
          const topSlot = railEls[i]!.querySelector(".ws-rail-slot") as HTMLElement | null;
          if (topSlot) topSlot.style.flex = `0 0 ${r.topSlotHeight}px`;
        }
      });
    });
  }
  /** First-visit layout for a folder with nothing saved: none — the rails
   *  stay closed until a view is opened from the header toggles. */
  function pushDefaultLayout(): void {
    // Intentionally empty (the old workbench seeded Files/Plan/Terminal).
  }
  function loadLayout(): void {
    rails.length = 0;
    let raw: string | null = null;
    try { raw = localStorage.getItem(layoutKey()); } catch { /* noop */ }
    if (!raw) { pushDefaultLayout(); renderRails(); return; }
    let data: SavedLayout;
    try { data = JSON.parse(raw); } catch { pushDefaultLayout(); renderRails(); return; }
    applySavedLayout(data);
    if (rails.length === 0) { pushDefaultLayout(); renderRails(); }
  }
  function railsBudget(): number {
    // 2.5.0: there is no center agent column — the rails ARE the surface.
    const root = document.querySelector<HTMLElement>(".code-root");
    const rootW = root ? root.getBoundingClientRect().width : window.innerWidth;
    return Math.max(260, rootW);
  }
  function applyResponsiveWidths(): void {
    const container = document.getElementById("code-wb-rails");
    if (!container || rails.length === 0) return;
    const containerW = railsBudget();
    // Bands span the full width and stay out of the apportioning entirely;
    // only the column rails (and their drop strips) share the budget.
    const sized = rails.filter((r) => !r.banner);
    const stripsW = (sized.length + 1) * 6;
    const available = Math.max(0, containerW - stripsW);
    const prefs = sized.map((r) => r.prefWidth ?? 320);
    const widths = prefs.slice();
    let total = widths.reduce((a, b) => a + b, 0);
    for (let i = widths.length - 1; i >= 0 && total > available; i--) {
      const slack = Math.min(widths[i] - 240, total - available);
      if (slack > 0) {
        widths[i] -= slack;
        total -= slack;
      }
    }
    // Under-full: the LAST rail absorbs the surplus so the rightmost panel
    // stays pinned to the app's right edge (prefWidths stay untouched — the
    // stretch is display-only and re-derives on every reflow). ONLY when the
    // rails must fill the root on their own (maximize, or the agent hosted
    // in a coding tile — the center pane is hidden and a gap would open).
    // With the agent visible beside the workbench the aside sizes to the
    // rails, so stretching here forced the workbench to max width and
    // snapped every edge drag right back.
    // Full-width surface: the last rail always absorbs the surplus.
    if (total < available && widths.length) widths[widths.length - 1] += available - total;
    const railEls = container.querySelectorAll<HTMLElement>(".ws-right-rail");
    let si = 0;
    rails.forEach((r, idx) => {
      const el = railEls[idx];
      if (!el) return;
      if (r.banner) { el.style.width = ""; return; }
      el.style.width = widths[si++] + "px";
    });
  }

  function placeSlot(slot: Slot): void {
    for (const rail of rails) {
      // Never auto-stack under the hosted agent: a rail holding the coding
      // tile keeps its column to itself, so the first new item opens BESIDE
      // the agent, not squeezed beneath it. (Deliberate drag-drop placement
      // is a different path and can still stack anywhere.)
      if (rail.slots.some((s) => s.view === "coding")) continue;
      if (rail.slots.length < 2) { rail.slots.push(slot); renderRails(); saveLayout(); return; }
    }
    rails.push({ id: nextRailId++, slots: [slot] });
    renderRails();
    saveLayout();
  }
  function placeView(view: Exclude<ViewKind, "app">): void {
    placeSlot(makeSlot(view));
  }
  function findMonacoSlot(): MonacoSlot | null {
    for (const r of rails) {
      for (const s of r.slots) {
        if (s.view === "monaco") return s;
      }
    }
    return null;
  }
  // The app-standard confirm modal, bridged from the help bundle (the
  // workbench bundle can't import help modules; #confirm-modal lives in
  // this document). Bridge absent → proceed, matching the old paths.
  function appConfirm(opts: { title: string; body?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }): Promise<boolean> {
    const fn = (window as unknown as { __appConfirm?: (o: unknown) => Promise<boolean> }).__appConfirm;
    return typeof fn === "function" ? fn(opts) : Promise.resolve(true);
  }

  // ── Smart file router — the ONE open-a-file entry point (Files tree,
  //    agent file cards, anything else). Routes by what can actually render
  //    it: Chromium-native types → the Browser panel; Office decks/docs →
  //    embedded LibreOffice→PDF when a converter exists, else the platform's
  //    native viewer (Quick Look on macOS, default app on Windows); text →
  //    Monaco, as ever. ──
  // html/htm are deliberately NOT here: a tree click means EDIT — they open
  // in Monaco like any source file; the browser panel is for browsing.
  const BROWSER_EXTS = new Set([
    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif",
    "pdf", "mp4", "webm", "mov", "m4v", "mp3", "wav", "ogg", "m4a", "flac",
  ]);
  const OFFICE_EXTS = new Set([
    "ppt", "pptx", "doc", "docx", "xls", "xlsx",
    "key", "pages", "numbers", "odt", "odp", "ods", "rtf",
  ]);
  function extOf(name: string): string {
    const i = name.lastIndexOf(".");
    return i < 0 ? "" : name.slice(i + 1).toLowerCase();
  }
  /** Preview URL from an absolute path. NOT file:// — Chromium refuses
   *  file:// subframe navigation, so main streams local files over the
   *  glyphh-preview:// scheme instead. Windows drive letters and
   *  backslashes normalize (C:\a\b → /C:/a/b). */
  function fileUrl(p: string): string {
    let s = p.replace(/\\/g, "/");
    if (!s.startsWith("/")) s = "/" + s;
    return "glyphh-preview://local" + s.split("/").map(encodeURIComponent).join("/");
  }
  /** Route a URL into the Browser panel — reuses the open one or places one. */
  function openPreviewUrl(url: string): void {
    const slot = rails.flatMap((r) => r.slots).find((s): s is PreviewSlot => s.view === "preview");
    if (slot) {
      slot.html = undefined;
      slot.htmlLabel = undefined;
      slot.url = url;
      renderRails();
    } else {
      const s = makeSlot("preview") as PreviewSlot;
      s.url = url;
      placeSlot(s);
    }
    saveLayout();
  }
  async function openFileSmart(file: { name: string; path: string }): Promise<void> {
    // The working project's plan.md IS the Plan view's document — clicking it
    // opens (or focuses) that app rather than a Monaco tab.
    if (file.path === planFilePath()) {
      if (!viewIsOpen("plan")) placeView("plan");
      else {
        const planSlot = rails.flatMap((r) => r.slots).find((sl) => sl.view === "plan");
        if (planSlot) focusAppSlot(planSlot.id);
      }
      return;
    }
    const ext = extOf(file.name);
    if (BROWSER_EXTS.has(ext)) {
      openPreviewUrl(fileUrl(file.path));
      return;
    }
    if (OFFICE_EXTS.has(ext)) {
      const conv = await window.wb.convertPreview(file.path).catch(() => null);
      if (conv?.pdfPath) { openPreviewUrl(fileUrl(conv.pdfPath)); return; }
      void window.wb.previewNative(file.path);
      return;
    }
    const res = await window.wb.readFile(file.path);
    // Text the editor can't hold (the 1MB cap) still deserves a viewer.
    if (res.error && /too large/i.test(res.error)) { void window.wb.previewNative(file.path); return; }
    openFileInMonaco({ name: file.name, path: file.path }, res.error ? `// error: ${res.error}` : res.content);
  }

  /** Tree-click entry point — routes the file into the existing Monaco slot
   *  (as a new tab or focuses an existing one), otherwise spawns a new
   *  Monaco slot via the standard placeSlot path. */
  function openFileInMonaco(node: { name: string; path: string }, content: string): void {
    // .md files default to rendered markdown; the user can flip to source
    // via the </> button in the tab header.
    const mode: "preview" | "code" | undefined = isMarkdown(node.name) ? "preview" : undefined;
    const existing = findMonacoSlot();
    if (existing) {
      const idx = existing.tabs.findIndex((t) => t.path === node.path);
      if (idx >= 0) existing.activeIdx = idx;
      else {
        existing.tabs.push({ name: node.name, path: node.path, content, mode });
        existing.activeIdx = existing.tabs.length - 1;
      }
      renderRails();
      return;
    }
    placeSlot({
      id: nextSlotId++,
      view: "monaco",
      tabs: [{ name: node.name, path: node.path, content, mode }],
      activeIdx: 0,
    });
  }
  function closeAllOfView(view: ViewKind): void {
    for (let i = rails.length - 1; i >= 0; i--) {
      rails[i].slots = rails[i].slots.filter((s) => s.view !== view);
      if (rails[i].slots.length === 0) rails.splice(i, 1);
    }
    renderRails();
    saveLayout();
  }
  function viewIsOpen(view: ViewKind): boolean {
    return rails.some((r) => r.slots.some((s) => s.view === view));
  }
  function makeSlot(view: Exclude<ViewKind, "app">): Slot {
    const id = nextSlotId++;
    if (view === "files") return { id, view, root: null };
    if (view === "monaco") return { id, view, tabs: [], activeIdx: 0 };
    if (view === "terminal") {
      return {
        id, view,
        terminals: [{ ptyId: makeTermId() }],
        activeIdx: 0,
      };
    }
    if (view === "diff") return { id, view };
    if (view === "coding") return { id, view };
    if (view === "plan") return { id, view, mode: "preview" };
    return { id, view: "preview", url: "" };
  }
  function closeSlot(slotId: number): void {
    for (let i = 0; i < rails.length; i++) {
      const r = rails[i];
      const idx = r.slots.findIndex((s) => s.id === slotId);
      if (idx >= 0) {
        r.slots.splice(idx, 1);
        if (r.slots.length === 0) rails.splice(i, 1);
        renderRails();
        saveLayout();
        return;
      }
    }
  }

  /** Right-click menu for a panel: close just this one, or clear them all.
   *  Reuses the .ws-tab-ctx-menu chrome the Monaco tab strip already uses. */
  function openSlotContextMenu(ev: MouseEvent, slotId: number): void {
    document.querySelector(".ws-tab-ctx-menu")?.remove();
    const menu = document.createElement("div");
    menu.className = "ws-tab-ctx-menu";
    const dismiss = (): void => {
      menu.remove();
      document.removeEventListener("mousedown", onAway, true);
      document.removeEventListener("keydown", onKey, true);
    };
    const onAway = (e: MouseEvent): void => { if (!menu.contains(e.target as Node)) dismiss(); };
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") dismiss(); };
    const mkItem = (label: string, onPick: () => void, danger = false): void => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ws-tab-ctx-item" + (danger ? " danger" : "");
      btn.textContent = label;
      btn.addEventListener("click", () => { dismiss(); onPick(); });
      menu.appendChild(btn);
    };
    mkItem("Close panel", () => {
      if (maximizedSlotId === slotId) maximizedSlotId = null;
      closeSlot(slotId);
      scheduleAppSync();
    });
    mkItem("Clear all panels", () => { void clearAllPanels(); }, true);
    document.body.appendChild(menu);
    menu.style.left = Math.max(6, Math.min(ev.clientX, window.innerWidth - menu.offsetWidth - 6)) + "px";
    menu.style.top = Math.max(6, Math.min(ev.clientY, window.innerHeight - menu.offsetHeight - 6)) + "px";
    document.addEventListener("mousedown", onAway, true);
    document.addEventListener("keydown", onKey, true);
  }

  /** Close EVERY workbench panel (the right-click "Clear all" + `.dip clear`).
   *  Guards unsaved editor work first — clearing is otherwise silent data loss. */
  async function clearAllPanels(): Promise<boolean> {
    // No flushEditorModel here — it's scoped to the Monaco renderer, and the
    // dirty FLAG is already set on the first keystroke, so the count is accurate
    // without folding the live buffer back (we're discarding content anyway).
    const dirty = rails
      .flatMap((r) => r.slots)
      .filter((s): s is MonacoSlot => s.view === "monaco")
      .reduce((n, s) => n + s.tabs.filter((t) => t.dirty).length, 0);
    if (dirty > 0) {
      const ok = await appConfirm({
        title: "Clear all panels?",
        body: dirty === 1 ? "1 file has unsaved changes." : `${dirty} files have unsaved changes.`,
        confirmLabel: "Clear all",
        danger: true,
      });
      if (!ok) return false;
    }
    rails.length = 0;
    maximizedSlotId = null;
    activeLayoutName = null;
    renderRails();
    saveLayout();
    scheduleAppSync();
    return true;
  }

  /** Locate a slot and remove it from its rail (without pruning empty rails).
   *  Used by drag-drop reorder; the caller re-inserts at the target position. */
  function detachSlot(slotId: number): { slot: Slot; railIdx: number; slotIdx: number } | null {
    for (let i = 0; i < rails.length; i++) {
      const idx = rails[i].slots.findIndex((s) => s.id === slotId);
      if (idx >= 0) {
        const [slot] = rails[i].slots.splice(idx, 1);
        return { slot, railIdx: i, slotIdx: idx };
      }
    }
    return null;
  }

  /** Insert a slot at the given rail/slot index. Honors the 2-slot-per-rail
   *  cap by spawning a new rail when the target rail is full and the source
   *  isn't the same rail (i.e. drag from one rail INTO a full rail spawns
   *  a fresh adjacent rail). */
  function insertSlotAt(slot: Slot, railIdx: number, slotIdx: number): void {
    if (railIdx >= rails.length) {
      rails.push({ id: nextRailId++, slots: [slot] });
      return;
    }
    const target = rails[railIdx];
    if (target.slots.length >= 2) {
      rails.splice(railIdx, 0, { id: nextRailId++, slots: [slot] });
      return;
    }
    target.slots.splice(Math.min(slotIdx, target.slots.length), 0, slot);
  }

  /** Drop handler: move dragSlotId into (railIdx, slotIdx). Cleans up the
   *  source rail if it becomes empty after detachment. */
  function moveSlotTo(railIdx: number, slotIdx: number): void {
    if (dragSlotId == null) return;
    const detached = detachSlot(dragSlotId);
    if (!detached) return;
    // If the source rail was the same and now empty, the target rail index
    // may have shifted left by one.
    let targetRailIdx = railIdx;
    if (detached.railIdx < railIdx && rails[detached.railIdx]?.slots.length === 0) {
      targetRailIdx = railIdx - 1;
    }
    // If we're inserting back into the same rail at a position past where we
    // detached from, the index also shifts left by one.
    let targetSlotIdx = slotIdx;
    if (rails[targetRailIdx] === rails[detached.railIdx] && slotIdx > detached.slotIdx) {
      targetSlotIdx = slotIdx - 1;
    }
    // Drop empty source rail BEFORE inserting to keep indexes consistent.
    if (rails[detached.railIdx]?.slots.length === 0) {
      rails.splice(detached.railIdx, 1);
      if (detached.railIdx < targetRailIdx) targetRailIdx--;
    }
    insertSlotAt(detached.slot, targetRailIdx, targetSlotIdx);
    renderRails();
    saveLayout();
  }

  /** "New rail" drop variant — inserts a new rail at the given index containing
   *  just the dragged slot. */
  function moveSlotToNewRail(railIdx: number): void {
    if (dragSlotId == null) return;
    const detached = detachSlot(dragSlotId);
    if (!detached) return;
    let target = railIdx;
    if (rails[detached.railIdx]?.slots.length === 0) {
      rails.splice(detached.railIdx, 1);
      if (detached.railIdx < target) target--;
    }
    rails.splice(Math.min(target, rails.length), 0, { id: nextRailId++, slots: [detached.slot] });
    renderRails();
    saveLayout();
  }

  /** Return the live agent DOM to its home column (before the workbench
   *  aside). Called before any rails rebuild and when the coding tile closes. */
  function parkAgent(): void {
    const agent = document.querySelector<HTMLElement>(".code-agent");
    const aside = document.getElementById("code-workbench");
    if (agent && aside && agent.parentElement !== aside.parentElement) {
      aside.parentElement!.insertBefore(agent, aside);
    }
    document.querySelector(".code-root")?.classList.remove("agent-hosted");
  }

  function codingHosted(): boolean {
    return rails.some((r) => r.slots.some((s) => s.view === "coding"));
  }

  /** Return every hosted SECTION's singleton DOM to the hidden #page-body pen
   *  (before any rails rebuild, and when a section panel closes). The same
   *  contract as parkAgent — adopt on render, park before wipe. */
  function parkSections(): void {
    const pen = document.getElementById("page-body");
    document.querySelectorAll<HTMLElement>(".help-section.wb-hosted").forEach((sec) => {
      sec.classList.remove("active", "wb-hosted");
      pen?.appendChild(sec);
    });
  }

  /** Adopt a section's DOM into the slot and run its loader. */
  function renderSectionIntoSlot(body: HTMLElement, slot: SectionSlot): void {
    const sec = document.querySelector<HTMLElement>(`.help-section[data-section="${slot.section}"]`);
    if (!sec) { body.innerHTML = `<div class="ws-empty">This page is unavailable.</div>`; return; }
    body.classList.add("ws-section-body");
    sec.classList.add("active", "wb-hosted");
    body.appendChild(sec);
  }

  /**
   * Navigate the workbench to a SECTION — the 2.5.0 shell's page switch.
   * Opening a section clears every other panel (with the unsaved-work
   * confirm) and renders just that panel, full width. "code" is the agent
   * surface: section panels close, the workspace stays, and a coding panel
   * is ensured so the agent is always reachable.
   */
  function openSectionInWorkbench(section: string): void {
    const loadSection = (window as unknown as { __wbSectionLoad?: (s: string) => void }).__wbSectionLoad;
    if (section === "agent") {
      // The Glyphh mark / Glyphh app: the coding agent, FULL SCREEN — the
      // workspace clears (unsaved-work confirm included) and the agent panel
      // is the only thing left.
      void clearAllPanels().then((cleared) => {
        if (!cleared) return;
        placeSlot(makeSlot("coding"));
      });
      return;
    }
    if (section === "code" || section === "workspace") {
      // Back to the working surface: section panels close, the workspace
      // stays. "code" additionally guarantees the agent panel exists;
      // "workspace" is the neutral flip used before app/layout opens (the
      // incoming panels define the view — no uninvited agent).
      for (let i = rails.length - 1; i >= 0; i--) {
        rails[i].slots = rails[i].slots.filter((sl) => sl.view !== "section");
        if (!rails[i].slots.length) rails.splice(i, 1);
      }
      if (section === "code" && !codingHosted()) { placeSlot(makeSlot("coding")); return; }   // placeSlot renders+saves
      renderRails();
      saveLayout();
      return;
    }
    const already = rails.flatMap((r) => r.slots).some((sl) => sl.view === "section" && sl.section === section);
    if (already) { loadSection?.(section); return; }
    void clearAllPanels().then((cleared) => {
      if (!cleared) return;   // the user kept unsaved work
      const slot: SectionSlot = { id: nextSlotId++, view: "section", section };
      rails.push({ id: nextRailId++, slots: [slot] });
      renderRails();
      saveLayout();
      scheduleAppSync();
      loadSection?.(section);
    });
  }

  function renderRails(): void {
    const container = document.getElementById("code-wb-rails");
    if (!container) return;
    parkAgent();
    parkSections();
    // Custom slot heights (drag-set or layout-set) live as inline flex on the
    // slot elements — a rebuild would silently reset them (e.g. opening a
    // file re-renders and the panel under the editor snapped back). Snapshot
    // by slot id and reapply after the rebuild.
    const savedFlex = new Map<string, string>();
    container.querySelectorAll<HTMLElement>(".ws-rail-slot").forEach((slotEl) => {
      if (slotEl.dataset.slotId && slotEl.style.flex) savedFlex.set(slotEl.dataset.slotId, slotEl.style.flex);
    });
    container.innerHTML = "";
    // Bands (full-width spanning rails) sit ABOVE/BELOW the column row: the
    // container flips to a column flex and the normal rails live in an inner
    // .ws-rails-row. Without bands the structure is exactly as before.
    const hasBanner = rails.some((r) => r.banner);
    container.classList.toggle("has-banner", hasBanner);
    const rowHost = hasBanner ? document.createElement("div") : container;
    if (hasBanner) rowHost.className = "ws-rails-row";
    // Divider between a band and the column row — drag it to resize the
    // band's share of the height (persisted via the rail's heightFrac).
    const wireBandResize = (sep: HTMLElement, rail: Rail, pos: "top" | "bottom"): void => {
      sep.addEventListener("mousedown", (e) => {
        e.preventDefault();
        sep.classList.add("dragging");
        document.body.classList.add("wb-mouse-drag");
        const contRect = container.getBoundingClientRect();
        const railEl = container.querySelector<HTMLElement>(`.ws-right-rail[data-rail-id="${rail.id}"]`);
        const onMove = (ev: MouseEvent) => {
          const frac = pos === "bottom"
            ? (contRect.bottom - ev.clientY) / contRect.height
            : (ev.clientY - contRect.top) / contRect.height;
          rail.heightFrac = Math.max(0.12, Math.min(0.8, frac));
          if (railEl) railEl.style.flex = `0 0 ${(rail.heightFrac * 100).toFixed(1)}%`;
        };
        const onUp = () => {
          sep.classList.remove("dragging");
          document.body.classList.remove("wb-mouse-drag");
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          saveLayout();
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    };
    const bandSep = (rail: Rail, pos: "top" | "bottom"): HTMLElement => {
      const sep = document.createElement("div");
      sep.className = "ws-band-hsep";
      wireBandResize(sep, rail, pos);
      return sep;
    };
    rails.forEach((rail, idx) => {
      if (rail.banner !== "top") return;
      container.appendChild(renderRail(rail, idx));
      container.appendChild(bandSep(rail, "top"));
    });
    if (hasBanner) container.appendChild(rowHost);
    const topCount = rails.filter((r) => r.banner === "top").length;
    let normalPos = 0;
    rails.forEach((rail, idx) => {
      if (rail.banner) return;
      rowHost.appendChild(makeRailDropStrip(topCount + normalPos));
      rowHost.appendChild(renderRail(rail, idx));
      normalPos++;
    });
    rowHost.appendChild(makeRailDropStrip(topCount + normalPos));
    rails.forEach((rail, idx) => {
      if (rail.banner !== "bottom") return;
      container.appendChild(bandSep(rail, "bottom"));
      container.appendChild(renderRail(rail, idx));
    });
    container.querySelectorAll<HTMLElement>(".ws-rail-slot").forEach((slotEl) => {
      const kept = slotEl.dataset.slotId && savedFlex.get(slotEl.dataset.slotId);
      if (kept) slotEl.style.flex = kept;
    });
    paintSectionToggles();
    // Re-apportion displayed widths after every (re)render — handles slot
    // adds/closes/DnD that change the rail count and the drop-strip total.
    applyResponsiveWidths();
    // If a slot was maximized before the re-render, keep it so.
    paintFullscreenClasses();
  }

  /** Vertical drop zone between rails (or at the far ends). Dropping a slot
   *  here creates a new rail at this index containing just the dropped slot. */
  function makeRailDropStrip(idx: number): HTMLElement {
    const strip = document.createElement("div");
    strip.className = "ws-rail-dropstrip";
    strip.dataset.railIdx = String(idx);
    strip.addEventListener("dragover", (e) => {
      if (dragSlotId == null) return;
      e.preventDefault();
      (e as DragEvent).dataTransfer!.dropEffect = "move";
      strip.classList.add("drag-over");
    });
    strip.addEventListener("dragleave", () => strip.classList.remove("drag-over"));
    strip.addEventListener("drop", (e) => {
      e.preventDefault();
      strip.classList.remove("drag-over");
      moveSlotToNewRail(idx);
    });
    return strip;
  }
  function paintSectionToggles(): void {
    document.querySelectorAll<HTMLButtonElement>(".code-view-btn[data-view]").forEach((btn) => {
      const v = btn.dataset.view as ViewKind;
      btn.classList.toggle("active", viewIsOpen(v));
    });
    // 2.5.0: the workbench IS the surface — it never collapses.
    document.getElementById("code-workbench")?.classList.remove("collapsed");
  }

  function renderRail(rail: Rail, railIdx: number): HTMLElement {
    const railEl = document.createElement("aside");
    railEl.className = "ws-right-rail" + (rail.banner ? " ws-rail-banner" : "");
    railEl.dataset.railId = String(rail.id);
    if (rail.banner) {
      // A band spans the full width; its share of the height comes from the
      // layout's rowHeights (40% default). No width handle — width is fixed.
      railEl.style.flex = `0 0 ${((rail.heightFrac ?? 0.4) * 100).toFixed(1)}%`;
    } else {
      // Width drag handle on the RIGHT edge — drag right grows the rail, drag
      // left shrinks it. Intuitive for left-to-right rails.
      const handle = document.createElement("div");
      handle.className = "ws-resize-v";
      handle.style.right = "0";
      railEl.appendChild(handle);
      wireRailWidthResize(handle, railEl);
    }
    rail.slots.forEach((slot, idx) => {
      if (idx > 0) {
        const vsep = document.createElement("div");
        vsep.className = "ws-rail-vsep";
        railEl.appendChild(vsep);
        wireSlotVerticalResize(vsep, railEl);
      }
      railEl.appendChild(renderSlot(slot, railIdx, idx));
    });
    return railEl;
  }

  function renderSlot(slot: Slot, railIdx: number, slotIdx: number): HTMLElement {
    const meta = VIEW_META[slot.view] || { title: slot.view, icon: "" };
    const title = slot.view === "app" ? slot.name
      : slot.view === "section" ? (SECTION_TITLES[slot.section] || slot.section)
      : meta.title;
    const icon = meta.icon;
    const wrap = document.createElement("div");
    wrap.className = "ws-rail-slot";
    wrap.dataset.slotId = String(slot.id);
    wrap.dataset.view = slot.view;
    const isMax = (slot.id === maximizedSlotId);
    if (isMax) wrap.classList.add("fullscreen");
    const urlToggle = slot.view === "app"
      ? `<button class="ws-icon-btn slot-urltoggle${(slot as AppSlot).urlBarHidden ? "" : " active"}" title="Address bar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/></svg></button>`
      : "";
    wrap.innerHTML = `
      <div class="ws-rail-slot-header" draggable="true" title="Drag to rearrange">
        ${icon}
        <span class="title"></span>
        ${urlToggle}
        <button class="ws-icon-btn slot-maximize" title="${isMax ? "Restore" : "Maximize"}">
          ${isMax ? RESTORE_SVG : MAXIMIZE_SVG}
        </button>
        <button class="ws-icon-btn slot-close" title="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="ws-rail-slot-body"></div>
    `;
    (wrap.querySelector(".title") as HTMLElement).textContent = title;
    wrap.querySelector(".slot-maximize")!.addEventListener("click", (ev) => {
      ev.stopPropagation();
      toggleMaximize(slot.id);
    });
    wrap.querySelector(".slot-close")!.addEventListener("click", () => {
      if (maximizedSlotId === slot.id) maximizedSlotId = null;
      closeSlot(slot.id);
    });
    // Right-click anywhere on the panel → a menu to close this one or clear all.
    // (The Monaco tab strip has its own menu; let that one win when present.)
    wrap.addEventListener("contextmenu", (ev) => {
      if ((ev.target as HTMLElement).closest(".ws-monaco-tabs")) return;
      ev.preventDefault();
      openSlotContextMenu(ev as MouseEvent, slot.id);
    });
    // App panels: the header toggle collapses/shows the browser chrome bar
    // (which lives in the overlay holder, not this rebuilt header).
    if (slot.view === "app") {
      wrap.querySelector(".slot-urltoggle")?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const s = slot as AppSlot;
        s.urlBarHidden = !s.urlBarHidden;
        appViews.get(slot.id)?.holder.classList.toggle("urlbar-hidden", !!s.urlBarHidden);
        (ev.currentTarget as HTMLElement).classList.toggle("active", !s.urlBarHidden);
      });
    }

    // ── Drag-and-drop ──
    const header = wrap.querySelector(".ws-rail-slot-header") as HTMLElement;
    header.addEventListener("dragstart", (e) => {
      dragSlotId = slot.id;
      wrap.classList.add("dragging");
      document.body.classList.add("wb-mouse-drag");
      (e as DragEvent).dataTransfer!.effectAllowed = "move";
      (e as DragEvent).dataTransfer!.setData("text/plain", String(slot.id));
    });
    header.addEventListener("dragend", () => {
      wrap.classList.remove("dragging");
      document.body.classList.remove("wb-mouse-drag");
      dragSlotId = null;
      document.querySelectorAll(".ws-rail-slot.drop-above, .ws-rail-slot.drop-below")
        .forEach((el) => el.classList.remove("drop-above", "drop-below"));
    });
    // The slot itself accepts above/below drops.
    wrap.addEventListener("dragover", (e) => {
      if (dragSlotId == null) return;
      e.preventDefault();
      (e as DragEvent).dataTransfer!.dropEffect = "move";
      const rect = wrap.getBoundingClientRect();
      const isTop = (e as DragEvent).clientY < rect.top + rect.height / 2;
      wrap.classList.toggle("drop-above", isTop);
      wrap.classList.toggle("drop-below", !isTop);
    });
    wrap.addEventListener("dragleave", (e) => {
      // Only clear when leaving the slot (not when hovering a child).
      if (!wrap.contains(e.relatedTarget as Node)) {
        wrap.classList.remove("drop-above", "drop-below");
      }
    });
    wrap.addEventListener("drop", (e) => {
      if (dragSlotId == null) return;
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const isTop = (e as DragEvent).clientY < rect.top + rect.height / 2;
      wrap.classList.remove("drop-above", "drop-below");
      moveSlotTo(railIdx, isTop ? slotIdx : slotIdx + 1);
    });

    const body = wrap.querySelector(".ws-rail-slot-body") as HTMLElement;
    if (slot.view === "files")         void renderFilesIntoSlot(body, slot);
    else if (slot.view === "terminal") renderTerminalIntoSlot(body, slot);
    else if (slot.view === "monaco")   void renderMonacoIntoSlot(body, slot);
    else if (slot.view === "diff")     void renderDiffIntoSlot(body, slot);
    else if (slot.view === "preview")  void renderPreviewIntoSlot(body, slot);
    else if (slot.view === "plan") void renderPlanIntoSlot(body, slot);
    else if (slot.view === "coding") renderCodingIntoSlot(body, wrap);
    else if (slot.view === "section") renderSectionIntoSlot(body, slot);
    else if (slot.view === "app") renderAppIntoSlot(body, slot);
    return wrap;
  }

  // ── Coding Agent view — the SAME agent, reparented into a tile ──
  // The slot hosts the live .code-agent element (thread, composer, everything
  // — one runtime, shared sessions). The header gains the session controls:
  // title on the left, history dropdown + new-session on the right.
  function renderCodingIntoSlot(body: HTMLElement, wrap: HTMLElement): void {
    const agent = document.querySelector<HTMLElement>(".code-agent");
    if (!agent) { body.innerHTML = `<div class="ws-empty">The agent is unavailable.</div>`; return; }
    body.classList.add("ws-coding-body");
    body.appendChild(agent);
    document.querySelector(".code-root")?.classList.add("agent-hosted");

    type SessionsApi = {
      list(): Array<{ id: string; title: string; createdAt: number }>;
      currentId(): string | null;
      currentTitle(): string;
      switch(id: string): void;
      startNew(): void;
    };
    // The sessions API lives in the help MODULE bundle, which loads after
    // this classic script. At boot the shell places the coding panel before
    // that module evaluates — wait for the bridge instead of silently
    // rendering a header with no history/+ controls (2.5.0 regression).
    const getSess = (): SessionsApi | undefined =>
      (window as unknown as { __agentSessions?: SessionsApi }).__agentSessions;
    const sessNow = getSess();
    if (!sessNow) {
      let tries = 0;
      const wait = (): void => {
        if (!wrap.isConnected) return;          // slot re-rendered/closed
        if (getSess()) { renderCodingHeaderControls(wrap); return; }
        if (tries++ < 200) requestAnimationFrame(wait);
      };
      requestAnimationFrame(wait);
      return;
    }
    renderCodingHeaderControls(wrap);
  }

  /** The coding slot's header extras: session title, + new session, and the
   *  history dropdown. Separate so a late-arriving sessions bridge (boot
   *  race) can attach them after the fact. */
  function renderCodingHeaderControls(wrap: HTMLElement): void {
    type SessionsApi = {
      list(): Array<{ id: string; title: string; createdAt: number }>;
      currentId(): string | null;
      currentTitle(): string;
      switch(id: string): void;
      startNew(): void;
    };
    const sess = (window as unknown as { __agentSessions?: SessionsApi }).__agentSessions;
    if (!sess || wrap.querySelector(".slot-session-new")) return;   // gone or already wired
    const titleEl = wrap.querySelector<HTMLElement>(".ws-rail-slot-header .title");
    if (titleEl) titleEl.textContent = sess.currentTitle();
    const maxBtn = wrap.querySelector(".slot-maximize");
    if (!maxBtn) return;

    // + New session — keeps the arranged layout (see __codeWorkbenchNewSession).
    const plus = document.createElement("button");
    plus.className = "ws-icon-btn slot-session-new";
    plus.title = "New session";
    plus.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
    plus.addEventListener("click", (ev) => { ev.stopPropagation(); sess.startNew(); });

    // History — the session list as a dropdown anchored under the button.
    const hist = document.createElement("button");
    hist.className = "ws-icon-btn slot-session-history";
    hist.title = "Session history";
    hist.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
    hist.addEventListener("click", (ev) => {
      ev.stopPropagation();
      document.querySelector(".wb-session-menu")?.remove();
      const menu = document.createElement("div");
      menu.className = "code-drop wb-session-menu";
      const cur = sess.currentId();
      for (const s of sess.list().slice(0, 20)) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "code-drop-item" + (s.id === cur ? " selected" : "");
        item.textContent = s.title;
        item.addEventListener("click", () => { menu.remove(); sess.switch(s.id); });
        menu.appendChild(item);
      }
      const r = hist.getBoundingClientRect();
      menu.style.position = "fixed";
      menu.style.top = `${r.bottom + 6}px`;
      menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
      document.body.appendChild(menu);
      const dismiss = (e: MouseEvent): void => {
        if (!menu.contains(e.target as Node)) { menu.remove(); document.removeEventListener("mousedown", dismiss, true); }
      };
      document.addEventListener("mousedown", dismiss, true);
    });

    maxBtn.before(hist, plus);
  }

  // ── App view — in-workbench apps (the OS-window replacement) ──
  // The slot body is a placeholder; the live <webview> sits in a stable
  // fixed-position layer and follows the placeholder's rect each frame.
  function renderAppIntoSlot(body: HTMLElement, slot: AppSlot): void {
    body.innerHTML = `<div class="ws-app-placeholder" data-app-slot="${slot.id}"></div>`;
    scheduleAppSync();
  }

  type WebviewEl = HTMLElement & {
    getWebContentsId?: () => number;
    loadURL?: (url: string) => void;
    reload?: () => void;
    goBack?: () => void;
    goForward?: () => void;
    canGoBack?: () => boolean;
    canGoForward?: () => boolean;
    getURL?: () => string;
    downloadURL?: (url: string) => void;
    executeJavaScript?: (code: string) => Promise<unknown>;
  };
  interface AppView { holder: HTMLDivElement; webview: WebviewEl; slug: string }
  const appViews = new Map<number, AppView>();
  // The RPA registration bridge on window.yo (slug ↔ panel webContents id).
  const rpaYo = (): { rpaRegister?: (slug: string, wcId: number) => void; rpaUnregister?: (slug: string) => void } =>
    (window as unknown as { yo?: { rpaRegister?: (slug: string, wcId: number) => void; rpaUnregister?: (slug: string) => void } }).yo ?? {};
  let appLayer: HTMLDivElement | null = null;
  let appSyncRaf = 0;

  function ensureAppLayer(): HTMLDivElement {
    if (appLayer && appLayer.isConnected) return appLayer;
    appLayer = document.createElement("div");
    appLayer.id = "code-wb-applayer";
    document.body.appendChild(appLayer);
    return appLayer;
  }

  function appSlots(): AppSlot[] {
    return rails.flatMap((r) => r.slots).filter((s): s is AppSlot => s.view === "app");
  }

  // Normalize a url-bar entry: pass http(s) through; localhost/IP/host.tld → a
  // URL; anything else → a Google search. (Mirrors browser.html's normalizeUrl.)
  function normalizeAppUrl(input: string): string {
    const s = input.trim();
    if (!s) return "";
    if (/^https?:\/\//i.test(s)) return s;
    if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(s)) return `http://${s}`;
    if (/^[^\s.]+\.[^\s]+$/.test(s)) return `https://${s}`;
    return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
  }
  const NAV_SVG = {
    back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`,
    forward: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`,
    reload: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`,
    download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
  };

  function mountAppView(slot: AppSlot): AppView {
    const holder = document.createElement("div");
    holder.className = "ws-app-holder entering";

    const webview = document.createElement("webview") as WebviewEl;
    webview.setAttribute("partition", "persist:yo");
    webview.setAttribute("allowpopups", "true");
    // Sites request HTML fullscreen (Google Slides' Present mode). Without
    // these the guest wedges in a half-fullscreen state the panel can't
    // leave — the browser looked dead until an app restart. Follow the guest:
    // maximize the slot on enter, restore on leave (only if WE maximized).
    let fullscreenMaximized = false;
    webview.addEventListener("enter-html-full-screen", () => {
      if (maximizedSlotId === null) {
        fullscreenMaximized = true;
        maximizedSlotId = slot.id;
        paintFullscreenClasses();
      }
    });
    webview.addEventListener("leave-html-full-screen", () => {
      if (fullscreenMaximized && maximizedSlotId === slot.id) {
        fullscreenMaximized = false;
        maximizedSlotId = null;
        paintFullscreenClasses();
      }
    });
    // Some sites refuse to embed (X-Frame-Options/CSP) — surface that (to the
    // main terminal too), since it looks identical to "blank" otherwise.
    webview.addEventListener("did-fail-load", (e) => {
      const err = e as unknown as { errorCode?: number; errorDescription?: string };
      if (err.errorCode && err.errorCode !== -3) {
        const m = `[wb] "${slot.name}" failed to load (${err.errorCode} ${err.errorDescription || ""}) — it may block embedding.`;
        console.warn(m);
        (window as unknown as { yo?: { wbLog?: (s: string) => void } }).yo?.wbLog?.(m);
      }
    });

    // @-mention summon inside app webviews: inject a matcher on every load
    // ("@<provider>-<model> prompt…" + Enter → clear the input, message out),
    // and route matches to the ghost overlay. A per-injection token keeps page
    // scripts from forging the console message.
    const yoApi = (window as unknown as { yo?: { mentionCatalog?: () => Promise<{ ok: boolean; pairs?: Record<string, string> }>; ghostSummon?: (m: string, p: string) => Promise<unknown> } }).yo;
    const mentionToken = `t${Math.random().toString(36).slice(2)}`;
    webview.addEventListener("dom-ready", () => {
      void yoApi?.mentionCatalog?.().then((r) => {
        if (!r?.ok || !r.pairs) return;
        const js = `(function(){
          if(window.__yoMention)return;window.__yoMention=true;
          var P=${JSON.stringify(r.pairs)},TK=${JSON.stringify(mentionToken)};
          var RE=/^@([^\\s-]+)-(\\S+)(?:\\s+([\\s\\S]*))?$/;
          document.addEventListener('keydown',function(e){
            if(e.key!=='Enter'||e.shiftKey)return;
            var a=document.activeElement;if(!a)return;
            var field=a.tagName==='INPUT'||a.tagName==='TEXTAREA';
            if(!field&&!a.isContentEditable)return;
            var t=(field?a.value:(a.innerText||a.textContent||'')).trim();
            var m=t.match(RE);if(!m)return;
            var id=P[(m[1]+'-'+m[2]).toLowerCase()];if(!id)return;
            e.preventDefault();e.stopImmediatePropagation();e.stopPropagation();
            if(field){a.value='';a.dispatchEvent(new Event('input',{bubbles:true}));}
            else{a.textContent='';}
            console.log('__YO_MENTION__'+JSON.stringify({t:TK,model:id,prompt:(m[3]||'').trim()}));
          },true);
        })();`;
        void webview.executeJavaScript?.(js);
      }).catch(() => { /* signed out / offline — no mentions this load */ });
    });
    webview.addEventListener("console-message", (e) => {
      const msg = (e as unknown as { message?: string }).message;
      if (typeof msg !== "string" || !msg.startsWith("__YO_MENTION__")) return;
      try {
        const d = JSON.parse(msg.slice("__YO_MENTION__".length)) as { t?: string; model?: string; prompt?: string };
        if (d.t !== mentionToken || !d.model) return;
        void yoApi?.ghostSummon?.(String(d.model), String(d.prompt || "").slice(0, 4000));
      } catch { /* malformed — ignore */ }
    });

    // Browser chrome: back / fwd / reload + address bar + hide toggle. It lives
    // inside the holder (which persists across renderRails) so it stays wired to
    // the webview it drives.
    const chrome = document.createElement("div");
    chrome.className = "ws-app-chrome";
    const navBtn = (svg: string, title: string, extra = ""): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ws-app-nav" + (extra ? ` ${extra}` : "");
      b.title = title;
      b.innerHTML = svg;
      return b;
    };
    const backBtn = navBtn(NAV_SVG.back, "Back");
    const fwdBtn = navBtn(NAV_SVG.forward, "Forward");
    const reloadBtn = navBtn(NAV_SVG.reload, "Reload");
    const urlbar = document.createElement("input");
    urlbar.className = "ws-app-urlbar";
    urlbar.spellcheck = false;
    urlbar.placeholder = "Enter a URL or search";
    const downloadBtn = navBtn(NAV_SVG.download, "Download this page", "ws-app-download");
    chrome.append(backBtn, fwdBtn, reloadBtn, urlbar, downloadBtn);

    const updateNav = (): void => {
      backBtn.toggleAttribute("disabled", !webview.canGoBack?.());
      fwdBtn.toggleAttribute("disabled", !webview.canGoForward?.());
    };
    const setUrl = (u?: string): void => {
      if (u && u !== "about:blank" && document.activeElement !== urlbar) urlbar.value = u;
    };
    webview.addEventListener("did-navigate", (e) => { setUrl((e as unknown as { url?: string }).url); updateNav(); });
    webview.addEventListener("did-navigate-in-page", (e) => {
      const ev = e as unknown as { url?: string; isMainFrame?: boolean };
      if (ev.isMainFrame) setUrl(ev.url);
      updateNav();
    });
    webview.addEventListener("did-stop-loading", updateNav);
    backBtn.addEventListener("click", () => webview.goBack?.());
    fwdBtn.addEventListener("click", () => webview.goForward?.());
    reloadBtn.addEventListener("click", () => webview.reload?.());
    urlbar.addEventListener("focus", () => urlbar.select());
    urlbar.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key !== "Enter") return;
      const target = normalizeAppUrl(urlbar.value);
      if (target) { webview.loadURL?.(target); urlbar.blur(); }
    });
    downloadBtn.addEventListener("click", () => {
      const u = webview.getURL?.() || slot.url;
      if (u) webview.downloadURL?.(u);
    });

    if (slot.glyphh) {
      // Installed Glyphh app: attach first (about:blank), then grant its caps
      // against the guest webContents and load the on-disk entry — the exact
      // preview-open flow the Apps page already uses.
      webview.setAttribute("src", "about:blank");
      webview.addEventListener("dom-ready", () => {
        const yo = (window as unknown as { yo?: { glyphhAppPreviewOpen?: (slug: string, wcId?: number) => Promise<{ ok: boolean; fileUrl?: string; error?: string }>; rpaRegister?: (slug: string, wcId: number) => void } }).yo;
        const wcId = webview.getWebContentsId?.();
        if (wcId !== undefined) yo?.rpaRegister?.(slot.slug, wcId);
        void yo?.glyphhAppPreviewOpen?.(slot.slug, wcId).then((res) => {
          if (res?.ok && res.fileUrl && webview.getAttribute("src") === "about:blank") {
            webview.setAttribute("src", res.fileUrl);
          }
        });
      }, { once: true });
    } else {
      webview.setAttribute("src", slot.url);
      urlbar.value = slot.url;
    }

    // RPA target registration for EVERY app panel (URL apps included; the
    // glyphh branch also registers early for its cap grant). Re-fires on each
    // dom-ready so a navigated/reloaded guest keeps a valid webContents id.
    webview.addEventListener("dom-ready", () => {
      const wcId = webview.getWebContentsId?.();
      if (wcId !== undefined) rpaYo().rpaRegister?.(slot.slug, wcId);
    });

    holder.append(chrome, webview);
    if (slot.urlBarHidden) holder.classList.add("urlbar-hidden");
    ensureAppLayer().appendChild(holder);
    // Slide in (left → right), then settle.
    requestAnimationFrame(() => requestAnimationFrame(() => holder.classList.remove("entering")));
    const view: AppView = { holder, webview, slug: slot.slug };
    appViews.set(slot.id, view);
    return view;
  }

  /** Reconcile the overlay layer against the current app slots and mirror
   *  each placeholder's rect. Runs as a rAF loop only while app slots exist —
   *  a handful of getBoundingClientRect calls per frame at most. */
  function syncAppViews(): void {
    const slots = appSlots();
    const live = new Set<number>();
    for (const slot of slots) {
      live.add(slot.id);
      let view = appViews.get(slot.id);
      if (view && view.slug !== slot.slug) {   // switched app in place
        rpaYo().rpaUnregister?.(view.slug);
        view.holder.remove();
        appViews.delete(slot.id);
        view = undefined;
      }
      if (!view) view = mountAppView(slot);
      const ph = document.querySelector<HTMLElement>(`.ws-app-placeholder[data-app-slot="${slot.id}"]`);
      const rect = ph?.getBoundingClientRect();
      const visible = !!rect && rect.width > 24 && rect.height > 24 && ph!.offsetParent !== null;
      view.holder.style.display = visible ? "" : "none";
      if (visible && rect) {
        // Leave a 7px gutter on the right so the rail's width-resize handle
        // (.ws-resize-v, absolute at right:0) isn't buried under the webview —
        // otherwise the app can't be resized. The between-slot handle
        // (.ws-rail-vsep) already sits in the gap between placeholders.
        view.holder.style.left = `${Math.round(rect.left)}px`;
        view.holder.style.top = `${Math.round(rect.top)}px`;
        view.holder.style.width = `${Math.max(0, Math.round(rect.width) - 7)}px`;
        view.holder.style.height = `${Math.round(rect.height)}px`;
      }
    }
    for (const [id, view] of appViews) {
      if (!live.has(id)) { rpaYo().rpaUnregister?.(view.slug); view.holder.remove(); appViews.delete(id); }
    }
    notifyOpenApps();
    if (slots.length) appSyncRaf = requestAnimationFrame(syncAppViews);
    else { appSyncRaf = 0; if (appLayer) appLayer.innerHTML = ""; appViews.clear(); }
  }
  function scheduleAppSync(): void {
    if (!appSyncRaf) appSyncRaf = requestAnimationFrame(syncAppViews);
  }

  let lastAppsJson = "";
  function notifyOpenApps(): void {
    const open = appSlots().map((s) => ({ slug: s.slug, name: s.name }));
    const json = JSON.stringify(open);
    if (json === lastAppsJson) return;
    lastAppsJson = json;
    (window as unknown as { yo?: { wbAppsChanged?: (apps: Array<{ slug: string; name: string }>) => void } }).yo?.wbAppsChanged?.(open);
  }

  interface WbAppRef { slug: string; name: string; url: string; glyphh?: boolean }
  interface WbLayoutCell extends WbAppRef { col: number; row: number; span?: number; sticky?: boolean; tool?: string; config?: { url?: string; cmd?: string } }
  interface WbGridLayout { cols: number; colWidths: number[]; rowHeights: number[]; cells: WbLayoutCell[] }

  /** Open an app in the workbench. Default = STACK a new panel, so apps
   *  accumulate. The switch (reuse one panel) is the EXCEPTION, and happens only
   *  when a layout PINNED a section (a sticky slot — that section is the
   *  designated swap target) or the caller asks to switch the active panel
   *  (`replaceActive`, e.g. `.dip .`). newPanel forces a fresh slot even past a pin. */
  function openAppInWorkbench(app: WbAppRef, opts: { newPanel?: boolean; replaceActive?: boolean; replaceWorkspace?: boolean } = {}): void {
    const existing = appSlots().find((s) => s.slug === app.slug);
    if (existing) { focusAppSlot(existing.id); return; }
    // Opening an individual app means the workbench is no longer "the named
    // layout" — stop writing geometry into that layout's memory.
    activeLayoutName = null;
    // A pinned (sticky) section always wins as the swap target — on ANY slot
    // kind: a pinned Browser band means "apps land here". Absent a pin,
    // switch the active panel ONLY when asked (.dip .); otherwise stack.
    const pinned = rails.flatMap((r) => r.slots).find((s) => s.sticky);
    // Command-bar semantics: the app REPLACES the workspace — unless a layout
    // pinned a landing section (the pin wins, below) or the caller stacks.
    if (opts.replaceWorkspace && !opts.newPanel && !pinned) {
      void clearAllPanels().then((cleared) => {
        if (!cleared) return;   // the user kept unsaved work — abort the open
        const slot: AppSlot = { id: nextSlotId++, view: "app", slug: app.slug, name: app.name, url: app.url, glyphh: app.glyphh, urlBarHidden: urlBarHiddenDefault() };
        placeSlot(slot);
        scheduleAppSync();
      });
      return;
    }
    const target = opts.newPanel ? undefined : (pinned ?? (opts.replaceActive ? appSlots()[0] : undefined));
    if (target && target.view !== "app") {
      // A pinned TOOL panel is REPLACED by the app at the same spot, pin
      // carried over so the NEXT open lands here too.
      for (const rail of rails) {
        const idx = rail.slots.indexOf(target);
        if (idx < 0) continue;
        rail.slots[idx] = {
          id: nextSlotId++, view: "app", slug: app.slug, name: app.name, url: app.url,
          glyphh: app.glyphh, sticky: true, urlBarHidden: urlBarHiddenDefault(),
        };
        renderRails();
        saveLayout();
        scheduleAppSync();
        return;
      }
    }
    if (target && target.view === "app") {
      const view = appViews.get(target.id);
      const apply = (): void => {
        target.slug = app.slug;
        target.name = app.name;
        target.url = app.url;
        target.glyphh = app.glyphh;
        renderRails();   // header title; syncAppViews swaps the webview
        saveLayout();
        scheduleAppSync();
      };
      if (view) {
        view.holder.classList.add("leaving");   // slide out (→ left)
        setTimeout(apply, 150);
      } else apply();
      return;
    }
    const slot: AppSlot = { id: nextSlotId++, view: "app", slug: app.slug, name: app.name, url: app.url, glyphh: app.glyphh, urlBarHidden: urlBarHiddenDefault() };
    placeSlot(slot);
    scheduleAppSync();
  }

  function focusAppSlot(slotId: number): void {
    if (maximizedSlotId !== null && maximizedSlotId !== slotId) {
      maximizedSlotId = null;
      paintFullscreenClasses();
    }
    const el = document.querySelector<HTMLElement>(`.ws-rail-slot[data-slot-id="${slotId}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    el?.classList.add("flash");
    setTimeout(() => el?.classList.remove("flash"), 700);
  }

  function closeWbApp(slug: string): boolean {
    const slot = appSlots().find((s) => s.slug === slug);
    if (!slot) return false;
    if (maximizedSlotId === slot.id) maximizedSlotId = null;
    closeSlot(slot.id);
    scheduleAppSync();
    return true;
  }

  // ── Command center — the full-screen apps/layouts launcher ──
  // Faithful rebuild of the removed command-center overlay (was its own
  // always-on-top window opening OS windows); now an in-renderer overlay on
  // <body> (above the z-120 webview layer) that opens apps into workbench
  // panels and layouts into the workbench grid.
  let switcherEl: HTMLDivElement | null = null;
  function closeSwitcher(): void { switcherEl?.remove(); switcherEl = null; }
  function toggleAppSwitcher(): void {
    if (switcherEl) { closeSwitcher(); return; }

    type CcYo = {
      panelAppsList?: () => Promise<PanelAppRow[]>;
      layoutsList?: () => Promise<LayoutRow[]>;
      panelAppsDelete?: (id: string) => Promise<{ ok: boolean; error?: string }>;
      layoutsDelete?: (name: string) => Promise<boolean>;
      getPreference?: (k: string, d: unknown) => Promise<unknown>;
      setPreference?: (k: string, v: unknown) => Promise<unknown>;
      dripsList?: () => Promise<Array<{ name: string; recipe: string }>>;
      dripsBuiltinEffects?: () => Promise<string[]>;
      dripsPreview?: (recipe: string) => Promise<string>;
      adaRecall?: (q: string, k?: number) => Promise<Array<{ content: string; score: number }>>;
    };
    const yo = (window as unknown as { yo?: CcYo }).yo;

    // ONE grid: apps and layouts together, iOS-launcher style. Glyphh is
    // always first; a saved order (long-press → drag) covers everything else.
    const PER_PAGE = 30;
    interface CcEntry { key: string; name: string; app?: PanelAppRow; layout?: LayoutRow }
    let appRows: PanelAppRow[] = [];
    let layouts: LayoutRow[] = [];
    let entries: CcEntry[] = [];
    let entryByKey = new Map<string, CcEntry>();
    let orderKeys: string[] = [];
    // The DOCK — sticky slots above the search bar. Slot 0 is ALWAYS Glyphh;
    // empty slots render as dotted outlines and accept dragged tiles.
    const DOCK_N = 8;
    const GLYPHH_KEY = "app:glyphh";
    const DOCK_DEFAULTS = [GLYPHH_KEY, "app:home", "app:connections", "app:apps", "app:layouts", "app:drips", "app:settings", "app:docs"];
    let dockKeys: string[] = DOCK_DEFAULTS.slice();
    let query = "";
    let page = 0;
    let editMode = false;
    let dragKey: string | null = null;

    const toRef = (a: PanelAppRow): WbAppRef => ({ slug: a.slug || a.id, name: a.name, url: a.url || "", glyphh: a.appArchetype === "glyphh-app" });
    /** Open a library row RESPECTING its declared type: native rows and rows
     *  whose browser choice isn't the Glyphh Panel route through app-launch
     *  (main decides: native launch / external browser); only Glyphh Panel
     *  rows open as workbench panels here. */
    const openRow = (a: PanelAppRow, opts: { newPanel?: boolean; replaceWorkspace?: boolean } = {}): void => {
      const browser = typeof a.launchConfig?.browser === "string" && a.launchConfig.browser ? (a.launchConfig.browser as string) : "glyphh-panel";
      // Nav apps route through main (goto-section), never into a panel.
      const external = a.isBrowser === false || !!a.execPath || a.appArchetype === "glyphh-nav" || (browser !== "glyphh-panel" && a.appArchetype !== "glyphh-app");
      if (external) {
        void (window as unknown as { yo?: { appLaunch?: (s: unknown) => Promise<unknown> } }).yo?.appLaunch?.({
          slug: a.slug || a.id, name: a.name, url: a.url,
          isBrowser: a.isBrowser, execPath: a.execPath,
          appArchetype: a.appArchetype, launchConfig: a.launchConfig,
        });
        return;
      }
      openAppInWorkbench(toRef(a), opts);
    };
    const iconApp = (a: PanelAppRow): { slug: string; url: string | null; execPath: string | null; appArchetype: string | null } => ({ slug: a.slug || a.id, url: a.url || null, execPath: a.execPath || null, appArchetype: a.appArchetype || null });
    const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] || c));
    const matches = (name: string): boolean => !query || name.toLowerCase().includes(query);

    const el = document.createElement("div");
    el.id = "command-center";
    el.className = "command-center";
    el.innerHTML = `
      <div class="cc-inner">
        <div class="cc-dock"></div>
        <div class="cc-header">
          <input id="cc-input" class="cc-input" type="text" autocomplete="off" autocorrect="off" spellcheck="false"
                 placeholder="Search apps and layouts — Enter opens the top match" />
          <div class="cc-drip-wrap">
            <button class="cc-drip-btn" title="Play a drip effect">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.7 6.6 9.2a6.6 6.6 0 1 0 10.8 0z"/></svg>
            </button>
            <div class="cc-drip-menu hidden"></div>
          </div>
          <button class="cc-overlay-btn" title="Overlay the whole desktop">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          </button>
          <button class="cc-close" title="Close (Esc)">&times;</button>
        </div>
        <div class="cc-apps"></div>
        <div class="cc-apps-pager cc-pager"></div>
        <div class="cc-empty hidden">No apps yet — add one from the Apps tab.</div>
      </div>`;
    document.body.appendChild(el);
    switcherEl = el;

    const input = el.querySelector<HTMLInputElement>("#cc-input")!;
    const dockEl = el.querySelector<HTMLElement>(".cc-dock")!;
    const gridEl = el.querySelector<HTMLElement>(".cc-apps")!;
    const pagerEl = el.querySelector<HTMLElement>(".cc-apps-pager")!;
    const emptyEl = el.querySelector<HTMLElement>(".cc-empty")!;
    input.focus();

    // Close: Esc, the × button, and clicking the darkened backdrop.
    el.querySelector(".cc-close")?.addEventListener("click", () => closeSwitcher());

    // Desktop-overlay toggle: when ON, the command center opens as a
    // transparent fullscreen window over the whole desktop (any monitor app).
    const ovBtn = el.querySelector<HTMLElement>(".cc-overlay-btn")!;
    const ccWin = window as unknown as {
      __ccOverlayHost?: boolean;
      yo?: { getPreference?: (k: string, d: unknown) => Promise<unknown>; setPreference?: (k: string, v: unknown) => Promise<unknown>; ccOverlayOpen?: () => Promise<unknown> };
    };
    void ccWin.yo?.getPreference?.("ccDesktopOverlay", false).then((v) => { if (v) ovBtn.classList.add("on"); }).catch(() => {});
    ovBtn.addEventListener("click", () => {
      const on = !ovBtn.classList.contains("on");
      ovBtn.classList.toggle("on", on);
      void ccWin.yo?.setPreference?.("ccDesktopOverlay", on);
      if (on && !ccWin.__ccOverlayHost) { closeSwitcher(); void ccWin.yo?.ccOverlayOpen?.(); }
      else if (!on && ccWin.__ccOverlayHost) window.close();
    });
    input.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      if (editMode) exitEdit(); else closeSwitcher();
    });
    el.addEventListener("mousedown", (ev) => {
      const t = ev.target as HTMLElement;
      if (t === el || t.classList.contains("cc-inner")) { if (editMode) exitEdit(); else closeSwitcher(); }
      else if (!t.closest(".cc-drip-wrap")) dripMenu.classList.add("hidden");
    });

    function paginate<T>(items: T[], page: number, size: number): { items: T[]; page: number; totalPages: number } {
      const totalPages = Math.max(1, Math.ceil(items.length / size));
      const p = Math.max(0, Math.min(page, totalPages - 1));
      return { items: items.slice(p * size, (p + 1) * size), page: p, totalPages };
    }
    function pager(page: number, totalPages: number, onPage: (p: number) => void): HTMLElement {
      const bar = document.createElement("div");
      bar.className = "pagination-bar";
      if (totalPages <= 1) return bar;
      const nav = document.createElement("div");
      nav.className = "pagination-nav";
      const mk = (label: string, to: number, disabled: boolean): HTMLButtonElement => {
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

    const resolveCell = (panelId: string): PanelAppRow | undefined => {
      const key = panelId.trim().toLowerCase();
      return appRows.find((a) => a.id.toLowerCase() === key || (a.slug || "").toLowerCase() === key);
    };
    const openLayout = (layout: LayoutRow): void => openLayoutRow(layout, appRows);

    // ── The unified grid: Glyphh first, then the saved order, new items after.
    function buildEntries(): void {
      const apps: CcEntry[] = appRows.map((a) => ({ key: `app:${(a.slug || a.id).toLowerCase()}`, name: a.name, app: a }));
      const ls: CcEntry[] = layouts.map((l) => ({ key: `layout:${(l.name || "").toLowerCase()}`, name: l.name, layout: l }));
      const all = [...apps, ...ls];
      const self = all.find((e) => e.app?.appArchetype === "glyphh-self");
      const byKey = new Map(all.map((e) => [e.key, e]));
      const ordered: CcEntry[] = [];
      const used = new Set<string>();
      for (const k of orderKeys) {
        const e = byKey.get(k);
        if (e && e !== self && !used.has(k)) { ordered.push(e); used.add(k); }
      }
      for (const e of all) if (e !== self && !used.has(e.key)) { ordered.push(e); used.add(e.key); }
      entries = self ? [self, ...ordered] : ordered;
      entryByKey = new Map(entries.map((e) => [e.key, e]));
    }

    /** The icon element for an entry — app icon, or a layout's mini stack. */
    function entryIcon(e: CcEntry): HTMLElement {
      const icon = document.createElement("div");
      if (e.layout) {
        icon.className = "tile-icon tile-layout";
        const seen = new Set<string>();
        const ids = e.layout.splits
          .map((c) => c.panelId)
          .filter((id) => id && !seen.has(id) && (seen.add(id), true))
          .slice(0, 4);
        icon.innerHTML = ids.length
          ? ids.map((id) => {
              const app = resolveCell(id);
              if (app) return `<span class="mini">${appIconInner(iconApp(app), app.name, "tile-mini-initial")}</span>`;
              const toolView = id.startsWith("tool:") ? id.slice(5) : "";
              const label = toolView ? (VIEW_META[toolView]?.title ?? toolView) : id;
              return `<span class="mini"><span class="tile-mini-initial">${esc(label.charAt(0).toUpperCase())}</span></span>`;
            }).join("")
          : `<span class="tile-initial">▦</span>`;
      } else {
        icon.className = "tile-icon";
        icon.innerHTML = appIconInner(iconApp(e.app!), e.name, "tile-initial");
      }
      return icon;
    }

    function openEntry(e: CcEntry, alt: boolean): void {
      if (e.layout) { openLayout(e.layout); closeSwitcher(); return; }
      openRow(e.app!, { newPanel: alt, replaceWorkspace: !alt });
      closeSwitcher();
    }

    function persistDock(): void {
      dockKeys[0] = GLYPHH_KEY;   // Glyphh owns the top-left, always
      void yo?.setPreference?.("ccDock", dockKeys);
    }

    /** The sticky dock: filled slots are normal tiles, empty ones dotted
     *  outlines. Static across search/pagination. Drops assign; in edit
     *  mode a × clears any slot but Glyphh's. */
    function renderDock(): void {
      dockKeys[0] = GLYPHH_KEY;
      dockEl.innerHTML = "";
      for (let i = 0; i < DOCK_N; i++) {
        const e = dockKeys[i] ? entryByKey.get(dockKeys[i]) : undefined;
        const slot = document.createElement("button");
        slot.type = "button";
        if (e) {
          slot.className = "cc-tile cc-dock-tile";
          slot.title = e.layout ? `${e.name} (layout)` : e.name;
          const nm = document.createElement("span");
          nm.className = "tile-name";
          nm.textContent = e.name;
          slot.append(entryIcon(e), nm);
          slot.addEventListener("click", (ev) => { if (!editMode) openEntry(e, (ev as MouseEvent).altKey); });
          if (editMode && i > 0) {
            slot.classList.add("cc-jiggle");
            const del = document.createElement("span");
            del.className = "cc-del";
            del.title = "Clear slot";
            del.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
            del.addEventListener("mousedown", (ev) => ev.stopPropagation());
            del.addEventListener("click", (ev) => { ev.stopPropagation(); dockKeys[i] = ""; persistDock(); renderDock(); });
            slot.appendChild(del);
          }
        } else {
          slot.className = "cc-dock-slot";
          slot.title = "Drag an app here";
        }
        // Slot 0 is Glyphh's — never a drop target.
        if (i > 0) {
          slot.addEventListener("dragover", (ev) => {
            if (!dragKey) return;
            ev.preventDefault();
            slot.classList.add("drag-over");
          });
          slot.addEventListener("dragleave", () => slot.classList.remove("drag-over"));
          slot.addEventListener("drop", (ev) => {
            ev.preventDefault();
            slot.classList.remove("drag-over");
            if (!dragKey || dragKey === GLYPHH_KEY) return;
            const from = dockKeys.indexOf(dragKey);
            if (from > 0) dockKeys[from] = "";   // moving within the dock
            dockKeys[i] = dragKey;
            persistDock();
            renderDock();
          });
        }
        dockEl.appendChild(slot);
      }
    }

    function persistOrder(): void {
      orderKeys = entries.filter((e) => e.app?.appArchetype !== "glyphh-self").map((e) => e.key);
      void yo?.setPreference?.("ccIconOrder", orderKeys);
    }

    const enterEdit = (): void => { if (!editMode) { editMode = true; renderAll(); } };
    const exitEdit = (): void => { if (editMode) { editMode = false; persistOrder(); renderAll(); } };

    /** Live-reorder during a drag: mutate `entries` AND move the DOM node —
     *  a full re-render mid-drag would cancel the native drag session. */
    function moveEntry(fromKey: string, toKey: string): void {
      const fi = entries.findIndex((e) => e.key === fromKey);
      const ti = entries.findIndex((e) => e.key === toKey);
      if (fi < 0 || ti < 0 || fi === ti) return;
      const [m] = entries.splice(fi, 1);
      entries.splice(ti, 0, m);
      const fromEl = gridEl.querySelector(`[data-key="${CSS.escape(fromKey)}"]`);
      const toEl = gridEl.querySelector(`[data-key="${CSS.escape(toKey)}"]`);
      if (fromEl && toEl) { if (fi < ti) toEl.after(fromEl); else toEl.before(fromEl); }
    }

    async function deleteEntry(e: CcEntry): Promise<void> {
      const ok = await appConfirm({
        title: `Delete "${e.name}"?`,
        body: e.layout ? "The layout is removed from your library." : "The app is uninstalled from your library.",
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
      try {
        if (e.layout) await yo?.layoutsDelete?.(e.layout.name);
        else if (e.app) await yo?.panelAppsDelete?.(e.app.id);
      } catch { /* reload below re-syncs to server truth either way */ }
      await reload();
      document.dispatchEvent(new CustomEvent("glyphh:apps-changed"));
    }

    function renderAll(): void {
      const all = entries.filter((e) => matches(e.name) || matches(e.app?.slug || ""));
      const { items, page: p, totalPages } = paginate(all, page, PER_PAGE);
      page = p;
      gridEl.innerHTML = "";
      gridEl.classList.toggle("cc-editing", editMode);
      renderDock();
      const openSlugs = new Set(appSlots().map((sl) => sl.slug));
      items.forEach((e, i) => {
        const fixed = e.app?.appArchetype === "glyphh-self";   // Glyphh: no move, no delete
        const deletable = !!e.layout || !!(e.app && !e.app.system && e.app.appArchetype !== "glyphh-nav");
        const tile = document.createElement("button");
        tile.type = "button";
        tile.className = "cc-tile" + (e.app && openSlugs.has(e.app.slug || e.app.id) ? " open" : "");
        tile.dataset.key = e.key;
        tile.title = e.layout ? `${e.name} (layout)` : e.name;
        const nm = document.createElement("span");
        nm.className = "tile-name";
        nm.textContent = e.name;
        tile.append(entryIcon(e), nm);

        // Always draggable — a tile can be dropped on a DOCK slot any time;
        // grid REORDER stays an edit-mode behavior (dragover below).
        if (!fixed) {
          tile.draggable = true;
          tile.addEventListener("dragstart", (ev) => {
            dragKey = e.key;
            ev.dataTransfer?.setData("text/plain", e.key);
            tile.classList.add("dragging");
          });
          tile.addEventListener("dragend", () => {
            tile.classList.remove("dragging");
            dragKey = null;
            if (editMode) { persistOrder(); renderAll(); }
          });
        }

        if (editMode && !fixed) {
          tile.classList.add("cc-jiggle");
          tile.style.animationDelay = `${(i % 5) * -0.07}s`;
          if (deletable) {
            const del = document.createElement("span");
            del.className = "cc-del";
            del.title = `Delete ${e.name}`;
            del.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
            del.addEventListener("mousedown", (ev) => ev.stopPropagation());
            del.addEventListener("click", (ev) => { ev.stopPropagation(); void deleteEntry(e); });
            tile.appendChild(del);
          }
          tile.addEventListener("dragover", (ev) => {
            ev.preventDefault();
            if (editMode && dragKey && dragKey !== e.key) moveEntry(dragKey, e.key);
          });
        }

        tile.addEventListener("click", (ev) => {
          if (editMode) return;   // jiggle mode: taps rearrange, never launch
          openEntry(e, (ev as MouseEvent).altKey);
        });
        // iOS-style: left-click and HOLD enters jiggle mode.
        tile.addEventListener("mousedown", (ev) => {
          if (ev.button !== 0 || editMode) return;
          const x0 = ev.clientX, y0 = ev.clientY;
          const timer = window.setTimeout(() => { cleanup(); enterEdit(); }, 550);
          const onMove = (m: MouseEvent): void => { if (Math.hypot(m.clientX - x0, m.clientY - y0) > 6) cleanup(); };
          const cleanup = (): void => {
            window.clearTimeout(timer);
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", cleanup);
          };
          document.addEventListener("mousemove", onMove);
          document.addEventListener("mouseup", cleanup);
        });
        gridEl.appendChild(tile);
      });
      pagerEl.innerHTML = "";
      if (totalPages > 1) pagerEl.appendChild(pager(page, totalPages, (pp) => { page = pp; renderAll(); }));
      emptyEl.classList.toggle("hidden", all.length > 0);
      renderAda();
    }

    // Ada fallback — nothing matched by name → surface fact-memory hits; a hit
    // naming an open_app("x")/open_layout("y") we recognize becomes clickable.
    let adaSeq = 0;
    function renderAda(): void {
      el.querySelector(".cc-ada")?.remove();
      const shown = gridEl.children.length > 0;
      if (!query || shown || !yo?.adaRecall) return;
      const seq = ++adaSeq;
      void yo.adaRecall(query, 4).then((hits) => {
        if (seq !== adaSeq || !switcherEl || !hits?.length) return;
        const wrap = document.createElement("div");
        wrap.className = "cc-ada";
        for (const h of hits) {
          const row = document.createElement("button");
          row.type = "button";
          row.className = "cc-ada-hit";
          row.textContent = h.content.length > 110 ? `${h.content.slice(0, 110)}…` : h.content;
          const m = /open_(?:app|layout)\("([^"]+)"\)/.exec(h.content);
          const ref = m?.[1];
          const app = ref ? resolveCell(ref) : undefined;
          const layout = ref ? layouts.find((l) => l.name.toLowerCase() === ref.toLowerCase()) : undefined;
          if (app) row.addEventListener("click", () => { openRow(app, { replaceWorkspace: true }); closeSwitcher(); });
          else if (layout) row.addEventListener("click", () => { openLayout(layout); closeSwitcher(); });
          else row.disabled = true;
          wrap.appendChild(row);
        }
        gridEl.after(wrap);
      }).catch(() => { /* quiet */ });
    }

    // Filter as you type; Enter opens the top match (app or layout).
    input.addEventListener("input", () => {
      query = input.value.trim().toLowerCase();
      page = 0;
      renderAll();
    });
    input.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      const e = entries.find((x) => matches(x.name) || matches(x.app?.slug || ""));
      if (!e) return;
      if (e.layout) openLayout(e.layout);
      else openRow(e.app!, { replaceWorkspace: true });
      closeSwitcher();
    });

    // Drip control — the built-in effects + the user's saved presets, played
    // through the main-process drip engine (window.yo.dripsPreview).
    const dripBtn = el.querySelector<HTMLButtonElement>(".cc-drip-btn")!;
    const dripMenu = el.querySelector<HTMLElement>(".cc-drip-menu")!;
    const DRIP_EMOJI: Record<string, string> = { fireworks: "🎆", hearts: "❤️", confetti: "🎊", stars: "⭐", rain: "🌧️", bubbles: "🫧", sparkle: "✨", spiral: "🌀", wave: "🌊", matrix: "🟩", aurora: "🌌", nebula: "💜", plasma: "🔮", fireflies: "🪲", starfield: "🌠", peace: "☮️", cat: "🐱", thumbsup: "👍" };
    let dripsLoaded = false;
    async function populateDrips(): Promise<void> {
      if (dripsLoaded) return;
      dripsLoaded = true;
      const [customs, builtins] = await Promise.all([
        yo?.dripsList?.().catch(() => []) ?? [],
        yo?.dripsBuiltinEffects?.().catch(() => []) ?? [],
      ]);
      dripMenu.innerHTML = "";
      const addRow = (label: string, cmd: string, emoji: string): void => {
        const row = document.createElement("button");
        row.className = "cc-drip-item";
        row.innerHTML = `<span class="cc-drip-emoji">${emoji}</span><span></span>`;
        (row.querySelector("span:last-child") as HTMLElement).textContent = label;
        row.addEventListener("click", () => { dripMenu.classList.add("hidden"); void yo?.dripsPreview?.(cmd); });
        dripMenu.appendChild(row);
      };
      if (customs.length) {
        const l = document.createElement("div"); l.className = "cc-drip-label"; l.textContent = "My drips"; dripMenu.appendChild(l);
        for (const d of customs) addRow(d.name, d.name, "💧");
        const l2 = document.createElement("div"); l2.className = "cc-drip-label"; l2.textContent = "Effects"; dripMenu.appendChild(l2);
      }
      for (const name of builtins) addRow(name, name, DRIP_EMOJI[name] || "💧");
    }
    dripBtn.addEventListener("click", (e) => { e.stopPropagation(); void populateDrips(); dripMenu.classList.toggle("hidden"); });

    // Load apps + layouts into the ONE grid, paint, then stream icons in.
    async function reload(): Promise<void> {
      try {
        const [rows, ls] = await Promise.all([yo?.panelAppsList?.() ?? [], yo?.layoutsList?.() ?? []]);
        appRows = (rows || []).filter((a) => a.url || a.appArchetype === "glyphh-app" || a.appArchetype === "glyphh-self" || a.appArchetype === "glyphh-nav");
        // Default order (before any saved drag order): built-in Glyphh, the
        // nav apps, installed glyphh-apps, web apps, then layouts. (sort is
        // stable — nav apps keep their seeded order.)
        const weight = (a: PanelAppRow): number =>
          a.appArchetype === "glyphh-self" ? 3 : a.appArchetype === "glyphh-nav" ? 2 : a.appArchetype === "glyphh-app" ? 1 : 0;
        appRows.sort((x, y) => weight(y) - weight(x));
        layouts = ls || [];
      } catch { appRows = []; layouts = []; }
      buildEntries();
      renderAll();
      void primeNativeIcons(appRows.map((a) => ({ execPath: a.execPath || null })), renderAll);
    }
    void (async () => {
      try {
        const saved = await yo?.getPreference?.("ccIconOrder", []);
        orderKeys = Array.isArray(saved) ? saved.map(String) : [];
      } catch { orderKeys = []; }
      try {
        const dock = await yo?.getPreference?.("ccDock", null);
        if (Array.isArray(dock) && dock.length) {
          dockKeys = Array.from({ length: DOCK_N }, (_, i) => String(dock[i] ?? ""));
        }
      } catch { /* defaults stand */ }
      dockKeys[0] = GLYPHH_KEY;
      await reload();
    })();
  }

  // ── Files view ──
  async function renderFilesIntoSlot(body: HTMLElement, slot: FilesSlot): Promise<void> {
    body.innerHTML = `
      <div class="ws-file-search">
        <input class="file-search-input" type="text" placeholder="Search files…" spellcheck="false" autocomplete="off" />
        <button class="ws-icon-btn ws-file-add ws-file-add-file" title="New file">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="12" x2="12" y2="18"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
        </button>
        <button class="ws-icon-btn ws-file-add ws-file-add-dir" title="New folder">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/><line x1="12" y1="10" x2="12" y2="16"/><line x1="9" y1="13" x2="15" y2="13"/></svg>
        </button>
      </div>
      <div class="ws-files-tree"></div>
    `;
    const treeEl = body.querySelector(".ws-files-tree") as HTMLElement;
    const searchInput = body.querySelector(".file-search-input") as HTMLInputElement;
    if (!cwd) {
      treeEl.innerHTML = `<div style="padding:14px;color:var(--text-faint);font-size:12px;">Pick a working folder to see files.</div>`;
      body.querySelectorAll<HTMLButtonElement>(".ws-file-add").forEach((b) => { b.disabled = true; });
      return;
    }
    // + file / + folder create at the working-folder ROOT; per-directory
    // creation lives on the tree rows' right-click menu.
    (body.querySelector(".ws-file-add-file") as HTMLButtonElement).addEventListener("click", () => {
      if (slot.root) startCreate(treeEl, slot.root, slot.root, "file", null);
    });
    (body.querySelector(".ws-file-add-dir") as HTMLButtonElement).addEventListener("click", () => {
      if (slot.root) startCreate(treeEl, slot.root, slot.root, "dir", null);
    });
    if (!slot.root) {
      const res = await window.wb.listDir(cwd);
      slot.root = {
        name: basename(cwd), path: cwd, kind: "dir", depth: -1, open: true, loaded: true,
        children: res.entries.map((e) => ({ ...e, depth: 0 })),
      };
    }
    renderTreeRows(treeEl, slot.root);
    // REAL search: the old handler only filtered rows already rendered, so a
    // file inside any collapsed (or never-expanded) folder was unfindable.
    // A query now walks the whole working folder in main and renders a flat
    // result list (rel paths, click-to-open); clearing it restores the tree.
    // oninput (assignment) so slot re-renders never stack duplicate handlers.
    let searchSeq = 0;
    searchInput.oninput = () => {
      const q = searchInput.value.trim();
      const seq = ++searchSeq;
      if (!q) { if (slot.root) renderTreeRows(treeEl, slot.root); return; }
      void window.wb.searchFiles(cwd, q).then((res) => {
        if (seq !== searchSeq || !slot.root) return; // stale response / slot gone
        treeEl.innerHTML = "";
        const hits = res.entries ?? [];
        if (!hits.length) {
          const empty = document.createElement("div");
          empty.style.cssText = "padding:14px;color:var(--text-faint);font-size:12px;";
          empty.textContent = `No files match "${q}".`;
          treeEl.appendChild(empty);
          return;
        }
        for (const e of hits) {
          const node: TreeNode = { name: e.rel, path: e.path, kind: e.kind, depth: 0, open: false, loaded: false, children: [] };
          treeEl.appendChild(renderTreeRow(node, treeEl, slot.root));
        }
        if (res.truncated) {
          const more = document.createElement("div");
          more.style.cssText = "padding:8px 14px;color:var(--text-faint);font-size:11px;";
          more.textContent = "More matches exist — narrow the search.";
          treeEl.appendChild(more);
        }
      }).catch(() => { /* search is best-effort; the tree returns on clear */ });
    };
  }

  function renderTreeRows(treeEl: HTMLElement, root: TreeNode): void {
    treeEl.innerHTML = "";
    function walk(node: TreeNode): void {
      if (node.depth >= 0) treeEl.appendChild(renderTreeRow(node, treeEl, root));
      if ((node.open || node.depth < 0) && node.children) {
        for (const c of node.children) walk(c);
      }
    }
    walk(root);
  }

  /** Re-list a dir node from disk, KEEPING each surviving child's expanded
   *  subtree (matched by path) so a create/delete doesn't collapse the tree. */
  async function refreshDirNode(node: TreeNode): Promise<void> {
    const res = await window.wb.listDir(node.path);
    const old = new Map((node.children ?? []).map((c) => [c.path, c]));
    node.children = res.entries.map((e) => old.get(e.path) ?? { ...e, depth: node.depth + 1 });
    node.loaded = true;
  }

  /** The dir node whose children contain `target` (root when top-level). */
  function findParentDir(root: TreeNode, target: TreeNode): TreeNode {
    let found: TreeNode = root;
    const walk = (n: TreeNode): void => {
      for (const c of n.children ?? []) {
        if (c === target) { found = n; return; }
        if (c.kind === "dir") walk(c);
      }
    };
    walk(root);
    return found;
  }

  /** Inline name-entry row for New file / New folder. Anchored after
   *  `afterRow` (or at the top of the tree when null, for the header +).
   *  Enter creates inside `dir`; Escape or empty cancels. */
  function startCreate(treeEl: HTMLElement, root: TreeNode, dir: TreeNode, kind: "file" | "dir", afterRow: HTMLElement | null): void {
    treeEl.querySelector(".ws-files-newrow")?.remove();
    const row = document.createElement("div");
    row.className = "ws-files-row ws-files-newrow";
    const depth = dir.depth < 0 ? 0 : dir.depth + 1;
    row.style.paddingLeft = (8 + depth * 12) + "px";
    const input = document.createElement("input");
    input.className = "ws-files-newinput";
    input.placeholder = kind === "file" ? "new-file.ts" : "folder name";
    input.spellcheck = false;
    row.appendChild(input);
    let done = false;
    const finish = (commit: boolean): void => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      row.remove();
      if (!commit || !name || /[\\/]/.test(name)) return;
      void (async () => {
        const target = `${dir.path}/${name}`;
        if (kind === "file") {
          // writeFile OVERWRITES — never let "create" truncate an existing file.
          const existing = await window.wb.readFile(target);
          if (!existing.error || /too large/i.test(existing.error)) {
            void appConfirm({ title: `${name} already exists`, body: "Pick a different name.", confirmLabel: "OK" });
            return;
          }
        }
        const res = kind === "file" ? await window.wb.writeFile(target, "") : await window.wb.mkdir(target);
        if (!res.ok) { void appConfirm({ title: `Couldn't create ${name}`, body: res.error || "Unknown error.", confirmLabel: "OK" }); return; }
        dir.open = true;
        await refreshDirNode(dir);
        renderTreeRows(treeEl, root);
        if (kind === "file") void openFileSmart({ name, path: target });
      })();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
    if (afterRow) afterRow.after(row);
    else treeEl.prepend(row);
    input.focus();
  }

  function renderTreeRow(node: TreeNode, treeEl: HTMLElement, root: TreeNode): HTMLElement {
    const row = document.createElement("div");
    row.className = "ws-files-row";
    row.style.paddingLeft = (8 + node.depth * 12) + "px";
    row.innerHTML = `
      <span class="ws-files-caret ${node.kind === "dir" ? (node.open ? "open" : "") : "leaf"}">▸</span>
      <svg class="ws-files-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        ${node.kind === "dir"
          ? '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>'
          : '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'}
      </svg>
      <span class="ws-files-name"></span>
    `;
    const nameEl = row.querySelector(".ws-files-name") as HTMLElement;
    nameEl.textContent = node.name;
    row.addEventListener("click", async () => {
      if (node.kind === "dir") {
        if (!node.loaded) {
          const res = await window.wb.listDir(node.path);
          node.children = res.entries.map((e) => ({ ...e, depth: node.depth + 1 }));
          node.loaded = true;
        }
        node.open = !node.open;
        renderTreeRows(treeEl, root);
        return;
      }
      void openFileSmart({ name: node.name, path: node.path });
    });

    // Inline rename — swaps the name for an input in place (no tree rebuild
    // until commit, so the click that lands elsewhere isn't eaten).
    const startRename = (): void => {
      const input = document.createElement("input");
      input.className = "ws-files-newinput";
      input.value = node.name;
      input.spellcheck = false;
      input.addEventListener("click", (ev) => ev.stopPropagation());
      let done = false;
      const finish = (commit: boolean): void => {
        if (done) return;
        done = true;
        const name = input.value.trim();
        input.replaceWith(nameEl);
        if (!commit || !name || name === node.name || /[\\/]/.test(name)) return;
        void (async () => {
          const newPath = node.path.slice(0, node.path.length - node.name.length) + name;
          const res = await window.wb.renamePath(node.path, newPath);
          if (!res.ok) { void appConfirm({ title: `Couldn't rename ${node.name}`, body: res.error || "Unknown error.", confirmLabel: "OK" }); return; }
          await refreshDirNode(findParentDir(root, node));
          renderTreeRows(treeEl, root);
        })();
      };
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
        else if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
      });
      input.addEventListener("blur", () => finish(true));
      nameEl.replaceWith(input);
      input.focus();
      input.select();
    };

    // Right-click menu: dirs get creation; everything gets Rename + Delete.
    row.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      document.querySelector(".ws-tab-ctx-menu")?.remove();
      const menu = document.createElement("div");
      menu.className = "ws-tab-ctx-menu";
      const dismiss = (): void => {
        menu.remove();
        document.removeEventListener("mousedown", onAway, true);
        document.removeEventListener("keydown", onKey, true);
      };
      const onAway = (e: MouseEvent): void => { if (!menu.contains(e.target as Node)) dismiss(); };
      const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") dismiss(); };
      const mkItem = (label: string, onPick: () => void): void => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ws-tab-ctx-item";
        btn.textContent = label;
        btn.addEventListener("click", () => { dismiss(); onPick(); });
        menu.appendChild(btn);
      };
      if (node.kind === "dir") {
        mkItem("New file", () => startCreate(treeEl, root, node, "file", row));
        mkItem("New folder", () => startCreate(treeEl, root, node, "dir", row));
      }
      mkItem("Rename", startRename);
      mkItem("Delete", () => {
        void (async () => {
          const ok = await appConfirm({
            title: `Delete ${node.name}?`,
            body: node.kind === "dir" ? "The folder and everything in it move to the Trash." : "The file moves to the Trash.",
            confirmLabel: "Delete",
            danger: true,
          });
          if (!ok) return;
          const res = await window.wb.deletePath(node.path);
          if (!res.ok) { void appConfirm({ title: `Couldn't delete ${node.name}`, body: res.error || "Unknown error.", confirmLabel: "OK" }); return; }
          await refreshDirNode(findParentDir(root, node));
          renderTreeRows(treeEl, root);
        })();
      });
      document.body.appendChild(menu);
      menu.style.left = Math.max(6, Math.min(ev.clientX, window.innerWidth - menu.offsetWidth - 6)) + "px";
      menu.style.top  = Math.max(6, Math.min(ev.clientY, window.innerHeight - menu.offsetHeight - 6)) + "px";
      document.addEventListener("mousedown", onAway, true);
      document.addEventListener("keydown", onKey, true);
    });
    return row;
  }

  // ── Monaco viewer (tabbed) ──
  // Tabs along the top, real Monaco editor below. Routes from the Files
  // tree's openFileInMonaco. Persists editor instance across re-renders by
  // keying off the slot id and re-attaching the DOM host.
  async function renderMonacoIntoSlot(body: HTMLElement, slot: MonacoSlot): Promise<void> {
    body.innerHTML = `
      <div class="ws-monaco-tabs"></div>
      <div class="ws-monaco-path">
        <span class="ws-monaco-path-text"></span>
        <span class="ws-monaco-path-spacer"></span>
        <button class="ws-monaco-mode-btn ws-monaco-mode-preview" title="Rendered">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
        <button class="ws-monaco-mode-btn ws-monaco-mode-code" title="Source">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
        </button>
        <button class="ws-monaco-save hidden" title="Save (⌘S)">Save</button>
      </div>
      <div class="ws-monaco-host"></div>
      <div class="ws-monaco-md-host"></div>
    `;
    const tabsEl   = body.querySelector(".ws-monaco-tabs") as HTMLElement;
    const pathText = body.querySelector(".ws-monaco-path-text") as HTMLElement;
    const previewBtn = body.querySelector(".ws-monaco-mode-preview") as HTMLButtonElement;
    const codeBtn    = body.querySelector(".ws-monaco-mode-code") as HTMLButtonElement;
    const host    = body.querySelector(".ws-monaco-host") as HTMLElement;
    const mdHost  = body.querySelector(".ws-monaco-md-host") as HTMLElement;
    const saveBtn = body.querySelector(".ws-monaco-save") as HTMLButtonElement;

    const paintSave = () => {
      const tab = slot.tabs[slot.activeIdx];
      saveBtn.classList.toggle("hidden", !tab?.dirty);
    };
    async function saveActive(): Promise<void> {
      const tab = slot.tabs[slot.activeIdx];
      const editor = (host as unknown as { __editor?: { getValue: () => string } }).__editor;
      if (!tab || !tab.dirty || !editor) return;
      const value = editor.getValue();
      const res = await window.wb.writeFile(tab.path, value);
      if (!(res as { error?: string })?.error) {
        tab.content = value;
        tab.dirty = false;
        saveBtn.textContent = "Saved";
        setTimeout(() => { saveBtn.textContent = "Save"; paintSave(); }, 900);
      }
      paintSave();
    }
    saveBtn.addEventListener("click", () => { void saveActive(); });

    // Only the ACTIVE tab lives in the Monaco model — fold the live buffer
    // back into its tab (matched by path, not index, so it's safe after
    // activeIdx has already moved) so switches/save-all/close-all see the
    // real content instead of the last-saved snapshot.
    function flushEditorModel(): void {
      const h = host as unknown as { __editor?: { getValue: () => string }; __modelPath?: string };
      if (!h.__editor || !h.__modelPath) return;
      const t = slot.tabs.find((x) => x.path === h.__modelPath);
      if (t && t.dirty) t.content = h.__editor.getValue();
    }

    async function saveAll(): Promise<void> {
      flushEditorModel();
      for (const t of slot.tabs) {
        if (!t.dirty) continue;
        const res = await window.wb.writeFile(t.path, t.content);
        if (!(res as { error?: string })?.error) t.dirty = false;
      }
      paintSave();
    }

    async function closeAll(): Promise<void> {
      flushEditorModel();
      const dirty = slot.tabs.filter((t) => t.dirty).length;
      if (dirty > 0) {
        const ok = await appConfirm({
          title: "Close all tabs?",
          body: dirty === 1 ? "1 file has unsaved changes." : `${dirty} files have unsaved changes.`,
          confirmLabel: "Close without saving",
          danger: true,
        });
        if (!ok) return;
      }
      slot.tabs = [];
      slot.activeIdx = 0;
      // Same rule as closing the last tab: empty the editor, keep the panel.
      paintTabs();
      void mountActive();
    }

    // Right-click on the tab strip → Save all / Close all.
    tabsEl.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      document.querySelector(".ws-tab-ctx-menu")?.remove();
      const menu = document.createElement("div");
      menu.className = "ws-tab-ctx-menu";
      const dismiss = (): void => {
        menu.remove();
        document.removeEventListener("mousedown", onAway, true);
        document.removeEventListener("keydown", onKey, true);
      };
      const onAway = (e: MouseEvent): void => { if (!menu.contains(e.target as Node)) dismiss(); };
      const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") dismiss(); };
      const mkItem = (label: string, onPick: () => void): void => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ws-tab-ctx-item";
        btn.textContent = label;
        btn.addEventListener("click", () => { dismiss(); onPick(); });
        menu.appendChild(btn);
      };
      mkItem("Save all", () => { void saveAll(); });
      mkItem("Close all", () => { void closeAll(); });
      document.body.appendChild(menu);
      menu.style.left = Math.max(6, Math.min(ev.clientX, window.innerWidth - menu.offsetWidth - 6)) + "px";
      menu.style.top  = Math.max(6, Math.min(ev.clientY, window.innerHeight - menu.offsetHeight - 6)) + "px";
      document.addEventListener("mousedown", onAway, true);
      document.addEventListener("keydown", onKey, true);
    });

    function paintTabs(): void {
      tabsEl.innerHTML = "";
      slot.tabs.forEach((t, i) => {
        const tab = document.createElement("div");
        tab.className = "ws-monaco-tab" + (i === slot.activeIdx ? " active" : "");
        tab.title = t.path;
        tab.innerHTML = `<span class="nm"></span><button class="close" title="Close tab">×</button>`;
        (tab.querySelector(".nm") as HTMLElement).textContent = t.name;
        tab.addEventListener("click", (ev) => {
          if ((ev.target as HTMLElement).closest(".close")) {
            ev.stopPropagation();
            void (async () => {
              flushEditorModel();
              if (t.dirty) {
                const ok = await appConfirm({
                  title: `Close ${t.name}?`,
                  body: "This tab has unsaved changes.",
                  confirmLabel: "Close without saving",
                  danger: true,
                });
                if (!ok) return;
              }
              slot.tabs.splice(i, 1);
              // The panel STAYS when the last tab closes — mountActive() paints
              // the landing state. Tearing the pane out from under the user cost
              // them their workbench slot for what reads as "I closed a file".
              if (slot.activeIdx >= slot.tabs.length) slot.activeIdx = Math.max(0, slot.tabs.length - 1);
              paintTabs();
              void mountActive();
            })();
          } else if (i !== slot.activeIdx) {
            slot.activeIdx = i;
            paintTabs();
            void mountActive();
          }
        });
        tabsEl.appendChild(tab);
      });
    }

    async function mountActive(): Promise<void> {
      // Fold the outgoing model's edits back into its tab before the new
      // one takes the editor — without this, switching tabs silently
      // reverts unsaved work to the last-saved snapshot.
      flushEditorModel();
      const tab = slot.tabs[slot.activeIdx];
      if (!tab) {
        pathText.textContent = "";
        // The landing: the website hero's gradient with the ghost mark
        // overlaid — full pane. The md host is flex:1 and would otherwise
        // take half the height, so it drops out entirely while empty.
        host.innerHTML = `
          <div class="ws-monaco-landing">
            <div class="wsml-inner">
              <img class="wsml-mark" src="brand/glyphh-mark.png" alt="" />
              <div class="wsml-hint">Open a file from the Files panel — it lands here.</div>
            </div>
          </div>`;
        mdHost.innerHTML = "";
        mdHost.style.display = "none";
        host.style.display = "";
        previewBtn.style.display = "none"; codeBtn.style.display = "none";
        // No tab ⇒ nothing to save; otherwise the last dirty tab's Save lingers
        // over the landing screen.
        paintSave();
        return;
      }
      mdHost.style.display = "";
      pathText.textContent = tab.path;
      const md = isMarkdown(tab.name);
      // Mode buttons only visible for markdown files. Non-md tabs always
      // render as source.
      previewBtn.style.display = md ? "" : "none";
      codeBtn.style.display    = md ? "" : "none";
      const mode = md ? (tab.mode || "preview") : "code";
      previewBtn.classList.toggle("active", md && mode === "preview");
      codeBtn.classList.toggle("active", !md || mode === "code");

      if (md && mode === "preview") {
        host.style.display = "none";
        mdHost.style.display = "";
        mdHost.innerHTML = formatMarkdown(tab.content);
        return;
      }
      mdHost.style.display = "none";
      host.style.display = "";
      await ensureMonaco();
      const w = window as unknown as { monaco: any };
      const existing = (host as unknown as { __editor?: any }).__editor;
      const wireModel = (editor: { setModel: (m: unknown) => void }) => {
        const model = w.monaco.editor.createModel(tab.content, languageForFile(tab.name));
        // Record which tab owns the live model so flushEditorModel can fold
        // its buffer back into the right tab.
        (host as unknown as { __modelPath?: string }).__modelPath = tab.path;
        model.onDidChangeContent(() => {
          const t = slot.tabs[slot.activeIdx];
          if (t && !t.dirty) { t.dirty = true; paintSave(); }
        });
        editor.setModel(model);
        paintSave();
      };
      if (existing) {
        wireModel(existing);
      } else {
        const editor = w.monaco.editor.create(host, {
          value: tab.content,
          language: languageForFile(tab.name),
          theme: monacoTheme(),
          readOnly: false,
          fontSize: 12,
          fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', Menlo, monospace",
          minimap: { enabled: false },
          wordWrap: "on",
          automaticLayout: true,
          padding: { top: 8 },
          scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
        });
        (host as unknown as { __editor?: any }).__editor = editor;
        editor.addCommand(w.monaco.KeyMod.CtrlCmd | w.monaco.KeyCode.KeyS, () => { void saveActive(); });
        wireModel(editor);
      }
    }

    previewBtn.addEventListener("click", () => {
      const tab = slot.tabs[slot.activeIdx];
      if (!tab || !isMarkdown(tab.name)) return;
      tab.mode = "preview";
      void mountActive();
    });
    codeBtn.addEventListener("click", () => {
      const tab = slot.tabs[slot.activeIdx];
      if (!tab || !isMarkdown(tab.name)) return;
      tab.mode = "code";
      void mountActive();
    });

    paintTabs();
    await mountActive();
  }

  // ── Diff view ──
  async function renderDiffIntoSlot(body: HTMLElement, slot: DiffSlot): Promise<void> {
    body.innerHTML = `
      <div class="ws-diff-toolbar">
        <span class="ws-diff-summary">loading…</span>
        <button class="ws-icon-btn ws-diff-expand" title="Expand all">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
        <button class="ws-icon-btn ws-diff-collapse" title="Collapse all">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="18 15 12 9 6 15"/>
          </svg>
        </button>
        <button class="ws-icon-btn ws-diff-refresh" title="Refresh">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
        </button>
      </div>
      <div class="ws-diff-files"></div>
    `;
    const summary = body.querySelector(".ws-diff-summary") as HTMLElement;
    const filesEl = body.querySelector(".ws-diff-files") as HTMLElement;
    const refreshBtn = body.querySelector(".ws-diff-refresh") as HTMLButtonElement;
    const expandBtn = body.querySelector(".ws-diff-expand") as HTMLButtonElement;
    const collapseBtn = body.querySelector(".ws-diff-collapse") as HTMLButtonElement;
    if (!slot.expanded) slot.expanded = new Set();
    expandBtn.addEventListener("click", () => {
      body.querySelectorAll<HTMLElement>(".ws-diff-file").forEach((el) => {
        const name = el.querySelector(".ws-diff-file-name")?.textContent || "";
        if (name) { slot.expanded!.add(name); el.classList.remove("collapsed"); }
      });
    });
    collapseBtn.addEventListener("click", () => {
      slot.expanded = new Set();
      body.querySelectorAll<HTMLElement>(".ws-diff-file").forEach((el) => el.classList.add("collapsed"));
    });

    async function refresh(): Promise<void> {
      summary.textContent = "loading…";
      const res = cwd ? await window.wb.gitDiff(cwd) : { text: "", error: "no folder" };
      if (res.error) {
        summary.textContent = "error";
        filesEl.innerHTML = `<div class="ws-diff-empty">${res.error}</div>`;
        return;
      }
      const files = parseUnifiedDiff(res.text);
      if (files.length === 0) {
        summary.textContent = "no changes";
        filesEl.innerHTML = `<div class="ws-diff-empty">Working tree is clean.</div>`;
        return;
      }
      const totalAdd = files.reduce((s, f) => s + f.additions, 0);
      const totalDel = files.reduce((s, f) => s + f.deletions, 0);
      summary.innerHTML = "";
      summary.appendChild(document.createTextNode(`${files.length} file${files.length === 1 ? "" : "s"}`));
      const addEl = document.createElement("span"); addEl.className = "add"; addEl.textContent = `+${totalAdd}`;
      const delEl = document.createElement("span"); delEl.className = "del"; delEl.textContent = `−${totalDel}`;
      summary.appendChild(addEl); summary.appendChild(delEl);
      filesEl.innerHTML = "";
      for (const f of files) {
        const fileEl = document.createElement("div");
        fileEl.className = "ws-diff-file";
        if (!slot.expanded!.has(f.path)) fileEl.classList.add("collapsed");
        fileEl.innerHTML = `
          <div class="ws-diff-file-header">
            <span class="ws-diff-caret">▸</span>
            <span class="ws-diff-file-name"></span>
            <span class="ws-diff-stat"><span class="add"></span><span class="del"></span></span>
          </div>
          <div class="ws-diff-file-body"></div>
        `;
        (fileEl.querySelector(".ws-diff-file-name") as HTMLElement).textContent = f.path;
        (fileEl.querySelector(".ws-diff-stat .add") as HTMLElement).textContent = `+${f.additions}`;
        (fileEl.querySelector(".ws-diff-stat .del") as HTMLElement).textContent = `−${f.deletions}`;
        fileEl.querySelector(".ws-diff-file-header")!.addEventListener("click", () => {
          const collapsed = fileEl.classList.toggle("collapsed");
          if (collapsed) slot.expanded!.delete(f.path);
          else slot.expanded!.add(f.path);
        });
        const lineWrap = fileEl.querySelector(".ws-diff-file-body") as HTMLElement;
        for (const ln of f.lines) {
          const lineEl = document.createElement("div");
          lineEl.className = "ws-diff-line " + ln.kind;
          lineEl.textContent = ln.text;
          lineWrap.appendChild(lineEl);
        }
        filesEl.appendChild(fileEl);
      }
    }
    refreshBtn.addEventListener("click", refresh);
    void refresh();
  }

  function parseUnifiedDiff(text: string): Array<{ path: string; additions: number; deletions: number; lines: { kind: string; text: string }[] }> {
    const files: Array<{ path: string; additions: number; deletions: number; lines: { kind: string; text: string }[] }> = [];
    let current: typeof files[number] | null = null;
    text.split("\n").forEach((line) => {
      if (line.startsWith("diff --git")) {
        const m = line.match(/diff --git a\/(.+?) b\/(.+)$/);
        current = { path: m ? m[2] : "(unknown)", additions: 0, deletions: 0, lines: [] };
        files.push(current);
        return;
      }
      if (!current) return;
      if (line.startsWith("@@")) current.lines.push({ kind: "hunk", text: line });
      else if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("index ") ||
               line.startsWith("new file") || line.startsWith("deleted file") ||
               line.startsWith("similarity ") || line.startsWith("rename ") ||
               line.startsWith("Binary ") || line.startsWith("\\ No newline")) {
        // metadata — skip
      } else if (line.startsWith("+")) { current.lines.push({ kind: "add", text: line }); current.additions++; }
      else if (line.startsWith("-")) { current.lines.push({ kind: "del", text: line }); current.deletions++; }
      else current.lines.push({ kind: "context", text: line });
    });
    return files;
  }

  // ── Plan view ──
  // THE plan is <cwd>/plan.md — the file planning skills write at the project
  // root. Writable Monaco editor with eye/code toggle so preview/source flips
  // inline. The workdir file watcher re-reads silently when the file changes
  // on disk (e.g. the agent wrote it). One plan doc, no phases, no dotdir.
  function planFilePath(): string {
    return `${cwd.replace(/\/+$/, "")}/plan.md`;
  }
  async function renderPlanIntoSlot(body: HTMLElement, slot: PlanSlot): Promise<void> {
    body.innerHTML = `
      <div class="ws-plan-timeline hidden">
        <div class="ws-plan-timeline-title">Glyphh — run timeline</div>
        <div class="ws-plan-timeline-rows"></div>
      </div>
      <div class="ws-plan-status">
        <span class="ws-plan-path"></span>
        <span class="ws-plan-savestate plan-saved">saved</span>
        <button class="ws-monaco-mode-btn ws-plan-mode-preview" title="Rendered">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
        <button class="ws-monaco-mode-btn ws-plan-mode-code" title="Source">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
        </button>
      </div>
      <div class="ws-plan-host"></div>
      <div class="ws-plan-md-host"></div>
    `;
    // Live run timeline — the Code surface broadcasts glyphh-agent:timeline
    // (steps + running); the strip shows during/after runs, hides when a
    // new session starts clean.
    const tlWrap = body.querySelector(".ws-plan-timeline") as HTMLElement;
    const tlRows = body.querySelector(".ws-plan-timeline-rows") as HTMLElement;
    const onTimeline = (e: Event) => {
      if (!body.isConnected) { document.removeEventListener("glyphh-agent:timeline", onTimeline); return; }
      const d = (e as CustomEvent).detail as { steps: string[]; running: boolean };
      const steps = Array.isArray(d?.steps) ? d.steps : [];
      tlWrap.classList.toggle("hidden", steps.length === 0);
      tlWrap.classList.toggle("running", !!d?.running);
      tlRows.textContent = "";
      for (const s of steps) {
        const row = document.createElement("div");
        row.className = "ws-plan-timeline-row" + (s.startsWith("✕") ? " failed" : "");
        row.textContent = s;
        tlRows.appendChild(row);
      }
      tlRows.scrollTop = tlRows.scrollHeight;
    };
    document.addEventListener("glyphh-agent:timeline", onTimeline);
    const pathEl = body.querySelector(".ws-plan-path") as HTMLElement;
    const saveStateEl = body.querySelector(".ws-plan-savestate") as HTMLElement;
    const host = body.querySelector(".ws-plan-host") as HTMLElement;
    const mdHost = body.querySelector(".ws-plan-md-host") as HTMLElement;
    const previewBtn = body.querySelector(".ws-plan-mode-preview") as HTMLButtonElement;
    const codeBtn = body.querySelector(".ws-plan-mode-code") as HTMLButtonElement;

    let editor: any = null;
    let suppressChange = false;
    let saveTimer: number | null = null;

    function setSave(state: "saved" | "dirty" | "saving" | "error"): void {
      saveStateEl.textContent = state;
      saveStateEl.className = "ws-plan-savestate " + (state === "saved" ? "plan-saved" : "plan-dirty");
    }
    async function ensureEditor(): Promise<void> {
      if (editor) return;
      await ensureMonaco();
      const w = window as unknown as { monaco: any };
      editor = w.monaco.editor.create(host, {
        value: "",
        language: "markdown",
        theme: monacoTheme(),
        readOnly: false,
        fontSize: 13,
        fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', Menlo, monospace",
        minimap: { enabled: false },
        wordWrap: "on",
        automaticLayout: true,
        padding: { top: 10 },
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
        lineNumbers: "off",
        glyphMargin: false,
        folding: false,
      });
      editor.onDidChangeModelContent(() => {
        if (suppressChange) return;
        setSave("dirty");
        if (saveTimer != null) window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => { saveTimer = null; void saveActive(); }, 800);
        // Keep the (possibly hidden) markdown host in sync with the
        // editor contents so a mode flip is instant.
        paintMarkdown();
      });
    }
    /** Paint the mode buttons' active state and toggle which body host
     *  is visible. Editor stays mounted when hidden so any in-flight
     *  edits / cursor position survives a mode flip. */
    function paintMode(): void {
      previewBtn.classList.toggle("active", slot.mode === "preview");
      codeBtn.classList.toggle("active", slot.mode === "code");
      mdHost.style.display = slot.mode === "preview" ? "" : "none";
      host.style.display = slot.mode === "code" ? "" : "none";
    }
    /** Re-render the markdown host from whatever the editor currently
     *  has in its model. Called on load + on every change so flipping
     *  to preview always shows the latest content. */
    function paintMarkdown(): void {
      const m = editor?.getModel?.();
      mdHost.innerHTML = formatMarkdown(m ? m.getValue() : "");
    }

    let activePath = planFilePath();
    async function loadActive(): Promise<void> {
      if (!cwd) { pathEl.textContent = "Pick a working folder."; return; }
      await ensureEditor();
      activePath = planFilePath();
      pathEl.textContent = activePath;
      setSave("saved");
      const res = await window.wb.readFile(activePath);
      const text = res.error ? "" : (res.content || "");
      suppressChange = true;
      const w = window as unknown as { monaco: any };
      const model = w.monaco.editor.createModel(text, "markdown");
      editor.setModel(model);
      suppressChange = false;
      paintMarkdown();
      paintMode();
    }
    async function saveActive(): Promise<void> {
      if (!cwd || !editor) return;
      const m = editor.getModel();
      if (!m) return;
      setSave("saving");
      const res = await window.wb.writeFile(activePath, m.getValue());
      setSave(res.ok ? "saved" : "error");
      if (!res.ok && res.error) saveStateEl.title = res.error;
    }

    previewBtn.addEventListener("click", () => { slot.mode = "preview"; paintMarkdown(); paintMode(); });
    codeBtn.addEventListener("click", () => { slot.mode = "code"; paintMode(); });

    // External writes (the right-rail Yo writing the plan) — reload from disk
    // unless the user is actively editing (dirty buffer). The watcher is on
    // the workdir; filter to plan.md only.
    // Accept any path that looks like the plan file. fs.watch on macOS can
    // fire with slightly normalized paths (resolved symlinks, trailing
    // segments) so a strict equality check sometimes misses — endsWith is
    // robust and the only plan files we care about are these two.
    function isPlanPath(abs: string): boolean {
      const root = cwd.replace(/\/+$/, "");
      // Exact match first; the suffix form covers fs.watch's occasionally
      // symlink-normalized paths without catching nested */plan.md files.
      const base = root.split("/").pop() || "";
      return abs === `${root}/plan.md` || (!!base && abs.endsWith(`/${base}/plan.md`));
    }
    const unsubscribeWatch = window.wb.onFileChanged(async (abs: string) => {
      if (!cwd) return;
      if (!isPlanPath(abs)) return;
      if (saveStateEl.classList.contains("plan-dirty")) return;
      activePath = planFilePath();
      pathEl.textContent = activePath;
      const res = await window.wb.readFile(activePath);
      if (res.error) return;
      const m = editor?.getModel?.();
      if (!m) return;
      suppressChange = true;
      m.setValue(res.content || "");
      suppressChange = false;
      paintMarkdown();
    });
    body.addEventListener("DOMNodeRemoved", () => { try { unsubscribeWatch(); } catch { /* */ } }, { once: true });

    await loadActive();
  }

  // ── Preview view (stub — real dev-server preview can come later) ──
  // Normalize a user-typed address into a loadable URL (default to http://).
  function normalizePreviewUrl(raw: string): string {
    const u = raw.trim();
    if (!u) return "";
    // An absolute path (typed or picked) loads straight from disk —
    // unix (/...) and windows (C:\... or C:/...) forms both. Legacy
    // file:// URLs (persisted slots, pasted) re-route through the scheme.
    if (u.startsWith("/") || /^[A-Za-z]:[\\/]/.test(u)) return fileUrl(u);
    if (/^file:\/\//i.test(u)) return fileUrl(decodeURIComponent(u.replace(/^file:\/\//i, "")));
    // Full scheme grammar — [a-z]+ alone missed hyphenated schemes, so
    // glyphh-preview:// got "http://" prepended and died on DNS.
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : "http://" + u;
  }

  async function renderPreviewIntoSlot(body: HTMLElement, slot: PreviewSlot): Promise<void> {
    // A native <webview>, NOT an <iframe>. An iframe is refused by any site that
    // sends X-Frame-Options / CSP frame-ancestors (most of the real web), so the
    // Browser panel could only ever show localhost + local files — it stayed
    // blank on actual web pages. A <webview> is a top-level guest that ignores
    // those headers, renders PDFs/images/the glyphh-preview:// scheme natively,
    // and (via the persist:yo session) routes downloads through will-download →
    // the downloads dropdown. It still lays out in-flow, so it clips/scrolls
    // with the workbench exactly as the iframe did.
    body.innerHTML = `
      <div class="ws-preview-url">
        <input class="ws-preview-input" type="text" value="" spellcheck="false" placeholder="https:// or http://localhost:..." />
        <button class="ws-icon-btn ws-preview-openfile" title="Open a file from disk">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>
        </button>
        <button class="ws-icon-btn ws-preview-reload" title="Reload">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        </button>
        <button class="ws-icon-btn ws-preview-download" title="Download this page">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </button>
      </div>
      <div class="ws-preview-body">
        <!-- DEFAULT session (no partition) on purpose: glyphh-preview:// (local
             file/PDF/office previews) is registered there only; persist:yo is
             deliberately walled off from local files. Same session the old
             iframe used. "plugins" enables the native PDF viewer in a webview. -->
        <webview class="ws-preview-frame" allowpopups plugins hidden></webview>
        <div class="ws-preview-stub">
          <div class="ws-preview-stub-title">Nothing open</div>
          <div class="ws-preview-stub-sub">Enter a URL above — e.g. http://localhost:3000 — or open a file from disk.</div>
        </div>
      </div>
    `;
    const urlInput = body.querySelector(".ws-preview-input") as HTMLInputElement;
    const reloadBtn = body.querySelector(".ws-preview-reload") as HTMLButtonElement;
    const downloadBtn = body.querySelector(".ws-preview-download") as HTMLButtonElement;
    const frame = body.querySelector(".ws-preview-frame") as WebviewEl & HTMLElement;
    const stub = body.querySelector(".ws-preview-stub") as HTMLElement;
    urlInput.value = slot.url || "";

    // loadURL once the guest is attached; else the src attribute, which the
    // webview queues until it is. getWebContentsId THROWS before dom-ready
    // (it doesn't return undefined), so the probe must be try/caught — an
    // uncaught throw here left the panel permanently blank.
    const setSrc = (u: string): void => {
      try {
        if (frame.isConnected && frame.getWebContentsId?.() !== undefined) { frame.loadURL?.(u); return; }
      } catch { /* guest not attached yet — fall through to the attribute */ }
      frame.setAttribute("src", u);
    };

    function loadHtml(html: string, label: string): void {
      stub.hidden = true;
      frame.hidden = false;
      // A webview has no srcdoc — carry the inline build HTML as a data: URL.
      setSrc("data:text/html;charset=utf-8," + encodeURIComponent(html));
      urlInput.value = label;
    }

    function load(u: string): void {
      if (!u) {
        frame.hidden = true;
        frame.removeAttribute("src");
        stub.hidden = false;
        return;
      }
      stub.hidden = true;
      frame.hidden = false;
      setSrc(u);
    }

    // A blocked/failed load looks identical to "blank" — surface it. -3 is the
    // benign ABORTED that fires on a normal re-navigation.
    frame.addEventListener("did-fail-load", (e) => {
      const err = e as unknown as { errorCode?: number; errorDescription?: string };
      if (err.errorCode && err.errorCode !== -3) {
        (window as unknown as { yo?: { wbLog?: (s: string) => void } }).yo?.wbLog?.(
          `[wb] Browser panel failed to load (${err.errorCode} ${err.errorDescription || ""}).`);
      }
    });
    // Keep the address bar in step with real navigations (not the data: build
    // previews, and never while the user is typing).
    frame.addEventListener("did-navigate", (e) => {
      const u = (e as unknown as { url?: string }).url;
      if (u && u !== "about:blank" && !u.startsWith("data:") && document.activeElement !== urlInput) urlInput.value = u;
    });

    // Initial paint: inline build preview wins; else the persisted URL.
    if (slot.html) loadHtml(slot.html, slot.htmlLabel || "Glyphh build");
    else if (slot.url) load(normalizePreviewUrl(slot.url));

    function navigate(): void {
      const u = normalizePreviewUrl(urlInput.value);
      if (!u) return;
      urlInput.value = u;
      slot.url = u;
      saveLayout();
      load(u);
    }
    urlInput.addEventListener("keydown", (e) => {
      if (slot.html) { slot.html = undefined; slot.htmlLabel = undefined; } if (e.key === "Enter") navigate(); });
    urlInput.addEventListener("blur", () => navigate());
    const openFileBtn = body.querySelector(".ws-preview-openfile") as HTMLButtonElement;
    openFileBtn.addEventListener("click", async () => {
      const picked = await window.wb.pickFile();
      if (!picked) return;
      slot.html = undefined; slot.htmlLabel = undefined;
      urlInput.value = picked;
      navigate();
    });
    reloadBtn.addEventListener("click", () => { frame.reload?.(); });
    // Site-initiated downloads already flow through will-download; this button
    // downloads the current page itself (e.g. a viewed PDF or file).
    downloadBtn.addEventListener("click", () => {
      const u = frame.getURL?.() || slot.url;
      if (u && !u.startsWith("data:")) frame.downloadURL?.(u);
    });
  }

  // ── Terminal view (real xterm + pty over wb-term:* IPCs) ──
  // Each tab owns a single pty (ptyId). xterm instances are kept on the
  // WbTerminal across re-renders so scrollback persists when the slot is
  // re-rendered (e.g. after DnD reorder). The xterm DOM element is moved
  // back into the new body via appendChild so the editor isn't torn down.
  function terminalTheme(): Record<string, string> {
    const styles = getComputedStyle(document.body);
    const bg = styles.getPropertyValue("--ws-bg-card").trim() || "#1e1e1e";
    const fg = styles.getPropertyValue("--ws-text").trim() || "#d4d4d4";
    const accent = styles.getPropertyValue("--ws-accent").trim() || "#a855f7";
    return {
      background: bg,
      foreground: fg,
      cursor: accent,
      cursorAccent: bg,
      selectionBackground: accent + "33",
    };
  }
  function renderTerminalIntoSlot(body: HTMLElement, slot: TermSlot): void {
    body.innerHTML = `
      <div class="ws-terminal">
        <div class="ws-terminal-tabs"></div>
        <div class="ws-terminal-host"></div>
      </div>
    `;
    const tabsEl = body.querySelector(".ws-terminal-tabs") as HTMLElement;
    const hostEl = body.querySelector(".ws-terminal-host") as HTMLElement;
    paintTermTabs(tabsEl, hostEl, slot);
    mountTerminal(hostEl, slot);
  }
  function paintTermTabs(tabsEl: HTMLElement, hostEl: HTMLElement, slot: TermSlot): void {
    tabsEl.innerHTML = "";
    slot.terminals.forEach((t, i) => {
      const tab = document.createElement("div");
      tab.className = "ws-terminal-tab" + (i === slot.activeIdx ? " active" : "");
      tab.innerHTML = `<span class="name"></span><button class="close" title="Close terminal">×</button>`;
      (tab.querySelector(".name") as HTMLElement).textContent = `${i + 1}. zsh`;
      tab.addEventListener("click", (ev) => {
        if ((ev.target as HTMLElement).closest(".close")) {
          ev.stopPropagation();
          killTerminal(t);
          slot.terminals.splice(i, 1);
          if (slot.terminals.length === 0) slot.terminals.push({ ptyId: makeTermId() });
          if (slot.activeIdx >= slot.terminals.length) slot.activeIdx = slot.terminals.length - 1;
          paintTermTabs(tabsEl, hostEl, slot);
          mountTerminal(hostEl, slot);
        } else if (i !== slot.activeIdx) {
          slot.activeIdx = i;
          paintTermTabs(tabsEl, hostEl, slot);
          mountTerminal(hostEl, slot);
        }
      });
      tabsEl.appendChild(tab);
    });
    const add = document.createElement("button");
    add.className = "ws-terminal-new";
    add.textContent = "+";
    add.title = "New terminal";
    add.addEventListener("click", () => {
      slot.terminals.push({ ptyId: makeTermId() });
      slot.activeIdx = slot.terminals.length - 1;
      paintTermTabs(tabsEl, hostEl, slot);
      mountTerminal(hostEl, slot);
    });
    tabsEl.appendChild(add);
  }
  function mountTerminal(hostEl: HTMLElement, slot: TermSlot): void {
    hostEl.innerHTML = "";
    const wbt = slot.terminals[slot.activeIdx];
    if (!wbt) return;
    if (!wbt.term) {
      const term = new Terminal({
        cursorBlink: true,
        fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', Menlo, monospace",
        fontSize: 12,
        theme: terminalTheme(),
        scrollback: 10_000,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostEl);
      // Spawn ONLY once the host has real dimensions. A layout-open renders
      // terminals before the rails have laid out (or while the section is
      // hidden): fit() at zero size computes garbage cols/rows, the pty
      // spawns wedged and narrow, and the tab looks dead until recreated.
      const spawnWhenSized = (): void => {
        if (!hostEl.isConnected) return;
        const r = hostEl.getBoundingClientRect();
        if (r.width < 40 || r.height < 40) {
          if (typeof ResizeObserver !== "undefined") {
            const ro = new ResizeObserver(() => {
              if (!hostEl.isConnected) { ro.disconnect(); return; }
              const rr = hostEl.getBoundingClientRect();
              if (rr.width >= 40 && rr.height >= 40) { ro.disconnect(); doSpawn(); }
            });
            ro.observe(hostEl);
          } else {
            setTimeout(spawnWhenSized, 150);
          }
          return;
        }
        doSpawn();
      };
      const doSpawn = (): void => {
        try { fit.fit(); } catch { /* noop */ }
        const { cols, rows } = term;
        window.wb.termSpawn(wbt.ptyId, cwd || "", cols, rows);
        if (wbt.initCmd) {
          // The layout's slotted first command — once, after the shell boots.
          const cmd = wbt.initCmd;
          wbt.initCmd = undefined;
          setTimeout(() => window.wb.termWrite(wbt.ptyId, `${cmd}\r`), 600);
        }
        // One more fit next frame — the first can land mid-reflow.
        requestAnimationFrame(() => { try { fit.fit(); } catch { /* noop */ } });
      };
      requestAnimationFrame(spawnWhenSized);
      term.onData((data) => window.wb.termWrite(wbt.ptyId, data));
      term.onResize(({ cols, rows }) => window.wb.termResize(wbt.ptyId, cols, rows));
      const off1 = window.wb.termOnData(wbt.ptyId, (data) => term.write(data));
      const off2 = window.wb.termOnExit(wbt.ptyId, () => { /* leave the buffer up so the user can read it */ });
      wbt.term = term;
      wbt.fit = fit;
      wbt.detach = () => { off1(); off2(); };
    } else {
      // Re-attach existing xterm instance to the new host element.
      hostEl.appendChild(wbt.term.element!);
      requestAnimationFrame(() => { try { wbt.fit?.fit(); } catch { /* noop */ } });
    }
    // Persistent host observer: whenever the host changes size the xterm
    // re-fits, so the terminal always fills its full height — including the
    // cases the .code-root observers miss (a solo tool window, the layout
    // settling after open, chrome being hidden). Re-created here each mount so
    // it tracks the CURRENT host element; the previous one is dropped first.
    wbt.ro?.disconnect();
    if (typeof ResizeObserver !== "undefined") {
      let raf = 0;
      wbt.ro = new ResizeObserver(() => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          const r = hostEl.getBoundingClientRect();
          if (r.width >= 40 && r.height >= 40) { try { wbt.fit?.fit(); } catch { /* noop */ } }
        });
      });
      wbt.ro.observe(hostEl);
    }
    wbt.term.focus();
  }
  function killTerminal(t: WbTerminal): void {
    t.detach?.();
    t.ro?.disconnect();
    window.wb.termKill(t.ptyId);
    try { t.term?.dispose(); } catch { /* noop */ }
    t.term = undefined; t.fit = undefined; t.detach = undefined; t.ro = undefined;
  }

  // ── Resizers ──
  function wireRailWidthResize(handle: HTMLElement, railEl: HTMLElement): void {
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      handle.classList.add("dragging");
      document.body.classList.add("wb-mouse-drag");
      const startX = e.clientX;
      const startW = railEl.getBoundingClientRect().width;
      // Resolve which rail this handle belongs to so we can update its
      // preferred width in the model on drag end.
      const railId = Number(railEl.dataset.railId);
      const rail = rails.find((r) => r.id === railId);
      const container = document.getElementById("code-wb-rails");
      // Compute how much room is available for THIS rail: the rails container's
      // width minus the widths of every OTHER rail and the inter-rail drop
      // strips. This naturally tracks the workbench's BrowserView viewport so
      // when the right-rail .Yo panel is open (panel narrower) the drag
      // stops earlier, and when closed it can grow to the full app width.
      const containerW = railsBudget();
      let otherRailsW = 0;
      let stripW = 0;
      if (container) {
        container.querySelectorAll<HTMLElement>(".ws-right-rail").forEach((el) => {
          if (el !== railEl) otherRailsW += el.getBoundingClientRect().width;
        });
        container.querySelectorAll<HTMLElement>(".ws-rail-dropstrip").forEach((el) => {
          stripW += el.getBoundingClientRect().width;
        });
      }
      const maxW = Math.max(240, containerW - otherRailsW - stripW);
      // When ANOTHER rail follows this one, the handle is the divider BETWEEN
      // them and must resize BOTH: left grows exactly as much as right shrinks.
      // Moving only this rail's width left the neighbor's explicit width
      // untouched — the pair fell out of sync and "only one side resized".
      const nextRailEl = (() => {
        let el = railEl.nextElementSibling;
        while (el && !el.classList.contains("ws-right-rail")) el = el.nextElementSibling;
        return el as HTMLElement | null;
      })();
      const nextRail = nextRailEl ? rails.find((r) => r.id === Number(nextRailEl.dataset.railId)) : undefined;
      const startNextW = nextRailEl?.getBoundingClientRect().width ?? 0;
      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        if (nextRailEl) {
          // Paired: clamp so NEITHER side collapses below the minimum.
          const d = Math.max(240 - startW, Math.min(startNextW - 240, dx));
          railEl.style.width = `${startW + d}px`;
          nextRailEl.style.width = `${startNextW - d}px`;
        } else {
          // Last rail: the old free-edge behavior against the container budget.
          const w = Math.max(240, Math.min(maxW, startW + dx));
          railEl.style.width = w + "px";
        }
      };
      const onUp = () => {
        handle.classList.remove("dragging");
        document.body.classList.remove("wb-mouse-drag");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        // Persist the user's intent (preferred width) — BOTH sides of a
        // paired drag. applyResponsiveWidths derives display widths from this.
        if (rail) rail.prefWidth = parseInt(railEl.style.width, 10) || rail.prefWidth;
        if (nextRail && nextRailEl) nextRail.prefWidth = parseInt(nextRailEl.style.width, 10) || nextRail.prefWidth;
        saveLayout();
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }
  function wireSlotVerticalResize(vsep: HTMLElement, railEl: HTMLElement): void {
    vsep.addEventListener("mousedown", (e) => {
      e.preventDefault();
      vsep.classList.add("dragging");
      document.body.classList.add("wb-mouse-drag");
      const rect = railEl.getBoundingClientRect();
      const topSlot = railEl.querySelector(".ws-rail-slot") as HTMLElement;
      const onMove = (ev: MouseEvent) => {
        const h = Math.max(120, Math.min(rect.height - 120, ev.clientY - rect.top));
        topSlot.style.flex = `0 0 ${h}px`;
      };
      const onUp = () => {
        vsep.classList.remove("dragging");
        document.body.classList.remove("wb-mouse-drag");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        saveLayout();
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  // ── Section toggle wiring ──
  // Only the real view toggles carry a data-view. The Apps/command button
  // (#code-apps-btn) shares the .code-view-btn class for styling but has NO
  // data-view — without this [data-view] guard it fell through to
  // placeView(undefined) → makeSlot's default "preview" slot, so every launcher
  // click also spawned a blank preview panel.
  // ⋮ overflow for the less-used panel toggles.
  const moreBtn = document.getElementById("code-view-more");
  const moreMenu = document.getElementById("code-view-more-menu");
  moreBtn?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    moreMenu?.classList.toggle("hidden");
  });
  document.addEventListener("click", (ev) => {
    if (moreMenu && !moreMenu.classList.contains("hidden")
        && !moreMenu.contains(ev.target as Node) && ev.target !== moreBtn) {
      moreMenu.classList.add("hidden");
    }
  });

  document.querySelectorAll<HTMLButtonElement>(".code-view-btn[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      // The header toggles cover every view except Monaco (spawned by the
      // Files tree, never toggled directly).
      const v = btn.dataset.view as Exclude<ViewKind, "app">;
      if (viewIsOpen(v)) closeAllOfView(v);
      else placeView(v);
      moreMenu?.classList.add("hidden");
    });
  });

  // ── Whole-workbench edge drag ── dragging the aside's left edge scales
  // every rail proportionally (the aside itself is width:auto).
  const edge = document.getElementById("code-wb-edge");
  edge?.addEventListener("mousedown", (e) => {
    e.preventDefault();
    if (rails.length === 0) return;
    edge.classList.add("dragging");
    document.body.classList.add("wb-mouse-drag");
    const startX = e.clientX;
    const railEls = Array.from(document.querySelectorAll<HTMLElement>("#code-wb-rails .ws-right-rail"));
    const startW = railEls.map((r) => r.getBoundingClientRect().width);
    const totalStart = startW.reduce((a, b) => a + b, 0) || 1;
    const budget = railsBudget();
    const onMove = (ev: MouseEvent) => {
      // Dragging LEFT grows the rails (the aside sits at the right edge).
      const dx = startX - ev.clientX;
      const scale = Math.max(0.2, (totalStart + dx) / totalStart);
      railEls.forEach((railEl, i) => {
        const w = Math.max(240, Math.min(budget, Math.round(startW[i] * scale)));
        railEl.style.width = w + "px";
      });
    };
    const onUp = () => {
      edge.classList.remove("dragging");
      document.body.classList.remove("wb-mouse-drag");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      for (const railEl of railEls) {
        const rail = rails.find((r) => r.id === Number(railEl.dataset.railId));
        if (rail) rail.prefWidth = parseInt(railEl.style.width, 10) || rail.prefWidth;
      }
      saveLayout();
      applyResponsiveWidths();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // ── Container resize: reflow rails when the workbench panel itself is
  // resized (right-rail .Yo opens/closes, left-rail opens/closes, window
  // resize). The user's preferred widths are preserved; we only adjust
  // displayed widths to fit the new container size, then snap back when
  // space is restored. ──
  const railsContainer = document.querySelector<HTMLElement>(".code-root");
  if (railsContainer && typeof ResizeObserver !== "undefined") {
    let scheduled = false;
    const ro = new ResizeObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        applyResponsiveWidths();
        // Re-fit every live xterm so the pty's cols/rows track the slot size.
        for (const rail of rails) {
          for (const slot of rail.slots) {
            if (slot.view === "terminal") {
              const t = (slot as TermSlot).terminals[(slot as TermSlot).activeIdx];
              if (t?.fit && t.term?.element?.isConnected) {
                try { t.fit.fit(); } catch { /* noop */ }
              }
            }
          }
        }
      });
    });
    ro.observe(railsContainer);
  }

  // ── Initial paint + cwd change subscription ──
  void paintWorkdirBar(cwd);
  loadLayout();

  // New session: close every rail and reset the folder selection (visual
  // reset only — each folder's saved layout is untouched).
  // Glyphh build previews: show generated HTML in a Preview slot (opens
  // one if none), live across repair attempts. Runtime-only content.
  (window as unknown as { __wbPreviewHtml?: (html: string, label?: string) => void }).__wbPreviewHtml = (html, label) => {
    let slot = rails.flatMap((r) => r.slots).find((s) => s.view === "preview") as PreviewSlot | undefined;
    if (!slot) {
      slot = makeSlot("preview") as PreviewSlot;
      slot.html = html;
      slot.htmlLabel = label;
      placeSlot(slot);
      return; // placeSlot renders
    }
    slot.html = html;
    slot.htmlLabel = label;
    renderRails();
  };

  // Thread → workbench bridges: the Code thread's file cards open a Monaco
  // tab; its run cards reveal (or spawn) a terminal slot.
  (window as unknown as { __wbOpenFile?: (path: string) => void }).__wbOpenFile = (path) => {
    const name = path.split(/[\\/]/).pop() || path;
    void openFileSmart({ name, path });
  };
  (window as unknown as { __wbOpenTerminal?: () => void }).__wbOpenTerminal = () => {
    const existing = rails.flatMap((r) => r.slots).find((s) => s.view === "terminal");
    if (existing) { renderRails(); return; }
    placeSlot(makeSlot("terminal"));
  };

  // App bridges — the OS-window replacement surface. main (glyphh agent tools,
  // relay panels_*, the Apps/Layouts pages' IPC) drives these through
  // help/code.ts, which also flips the UI to the Code section first.
  // ── Open a saved layout as a workbench grid (agent stays pinned left) ──
  // The workbench is already a row of columns (rails) of stacked slots, so a
  // layout maps straight in: each grid COLUMN becomes a rail (width from
  // colWidths), and the cells in that column (ordered by row) become the
  // rail's stacked slots (heights from rowHeights). Spanning cells land in
  // their start column — the rail model has no true cell-merge, so a first
  // faithful cut treats every cell as a single-column slot.
  /** THE layout-open used everywhere a user opens a layout by intent — the
   *  switcher's click and `.dip <layout>` run THIS, so the two can never
   *  behave differently again. ALWAYS opens the layout's own grid (panel
   *  composition comes from the layout definition, never from a snapshot);
   *  the saved snapshot contributes GEOMETRY ONLY — the widths and heights
   *  the user dragged to last time. */
  function openLayoutRow(layout: LayoutRow, appRows: PanelAppRow[]): void {
    // A DESKTOP-target layout never panels — main opens it on the desktop
    // (native launches + external browsers), same as .dip and the agent.
    if (layout.target === "desktop") {
      void (window as unknown as { yo?: { layoutsOpen?: (n: string) => Promise<unknown> } }).yo?.layoutsOpen?.(layout.name);
      return;
    }
    // The layout's FOLDER leads the whole open: arrange only once the switch
    // landed, so every workspace app roots itself in the right place from its
    // first render. cwd is stamped locally too — the working-dir-changed
    // event round trip must not race the arrangement's spawns.
    if (layout.folder && layout.folder !== cwd) {
      const folder = layout.folder;
      void window.wb.setCwd(folder)
        .catch(() => { /* folder gone — open in place */ })
        .then(() => {
          cwd = folder;
          lastCwd = folder;
          void paintWorkdirBar(cwd);
          openLayoutRowArranged(layout, appRows);
        });
      return;
    }
    openLayoutRowArranged(layout, appRows);
  }

  function openLayoutRowArranged(layout: LayoutRow, appRows: PanelAppRow[]): void {
    const resolveCell = (panelId: string): PanelAppRow | undefined => {
      const key = panelId.trim().toLowerCase();
      return appRows.find((a) => a.id.toLowerCase() === key || (a.slug || "").toLowerCase() === key);
    };
    const cells = layout.splits.map((c): WbLayoutCell | null => {
      if (c.panelId?.startsWith("tool:")) return { slug: c.panelId, name: c.panelId.slice(5), url: "", col: c.col ?? 0, row: c.row ?? 0, span: c.colSpan ?? 1, sticky: c.sticky, tool: c.panelId.slice(5), config: c.config };
      const app = resolveCell(c.panelId);
      return app?.url ? { slug: app.slug || app.id, name: app.name, url: app.url, col: c.col ?? 0, row: c.row ?? 0, span: c.colSpan ?? 1, sticky: c.sticky } : null;
    }).filter((c): c is WbLayoutCell => c !== null);
    if (!cells.length) return;
    let saved: SavedLayout | null = null;
    try {
      const raw = localStorage.getItem(namedLayoutKey(layout.name));
      if (raw) saved = JSON.parse(raw) as SavedLayout;
    } catch { /* no remembered geometry */ }
    activeLayoutName = layout.name;
    // FULL-arrangement recall: when the remembered arrangement holds exactly
    // the same panels as the definition, rebuild wholesale from the memory —
    // slot order, rail grouping, widths, heights, everything the user dragged.
    // (The width-patch path below only recalled rail widths + one slot height,
    // so every re-open snapped back to the pristine definition.) A memory with
    // different panels is stale (the layout was edited) — definition wins.
    const viewKey = (v: SavedView): string =>
      typeof v === "string" ? v : v.view === "section" ? `section:${v.section}` : `app:${(v.slug || "").toLowerCase()}`;
    const savedKeys = (saved?.rails || []).flatMap((r) => (r.views || []).map(viewKey)).sort().join("|");
    const defKeys = cells.map((c) => (c.tool ? c.tool : `app:${c.slug.toLowerCase()}`)).sort().join("|");
    // Session behavior applies after the panels land; the FOLDER applied
    // before them (openLayoutRow is entered through switchFolderFirst) so
    // every workspace app — terminal pty cwd, Files tree, Diff repo, Plan
    // file — comes up rooted in the layout's folder, not the previous one.
    const applyFolderAndSession = (): void => {
      void (async () => {
        type SessionsApi = { list(): Array<{ id: string }>; currentId(): string | null; switch(id: string): void; startNew(): void; stampWorkdir(dir: string): void };
        const sess = (window as unknown as { __agentSessions?: SessionsApi }).__agentSessions;
        const mode = layout.sessionMode ?? "keep";
        const stamp = (): void => { if (layout.folder) sess?.stampWorkdir(layout.folder); };
        if (!sess || mode === "keep") { stamp(); return; }
        if (mode === "new") { sess.startNew(); stamp(); return; }
        let last: string | null = null;
        try { last = localStorage.getItem(layoutSessionKey(layout.name)); } catch { /* no memory */ }
        if (last && sess.list().some((c) => c.id === last)) sess.switch(last);
        else sess.startNew();
        stamp();
      })();
    };
    // App setup (Browser URL / Terminal command) comes from the DEFINITION —
    // snapshots persist geometry, not configs. Applied to rails BEFORE render
    // so the Browser loads the right page and the Terminal's spawn sees its
    // first command.
    const applyCellConfigs = (): void => {
      const claimed = new Set<Slot>();
      for (const c of cells) {
        if (!c.tool || !c.config || (!c.config.url && !c.config.cmd)) continue;
        const view = c.tool === "preview" ? "preview" : c.tool === "terminal" ? "terminal" : null;
        if (!view) continue;
        const slot = rails.flatMap((r) => r.slots).find((sl) => sl.view === view && !claimed.has(sl));
        if (!slot) continue;
        claimed.add(slot);
        if (slot.view === "preview" && c.config.url) slot.url = c.config.url;
        if (slot.view === "terminal" && c.config.cmd) slot.terminals[0]!.initCmd = c.config.cmd;
      }
    };
    if (saved && savedKeys && savedKeys === defKeys) {
      maximizedSlotId = null;
      applySavedLayout(saved, applyCellConfigs);
      // The PIN comes from the DEFINITION, never the snapshot — a memory
      // saved before the layout gained (or moved) its sticky cell would
      // otherwise erase the pin, and every .dip/app open stops swapping.
      // Keyed off the RAW panelIds: builtin cells ("browser") don't resolve
      // through the app library, and resolving first wiped their pins. A
      // definition with NO sticky cell leaves the snapshot's pins alone.
      const defSticky = layout.splits
        .filter((c) => c.sticky)
        .map((c) => { const id = c.panelId.trim().toLowerCase(); return id.startsWith("tool:") ? id.slice(5) : id; });
      if (defSticky.length) {
        const stickyKeys = new Set(defSticky);
        const claimed = new Set<string>();
        rails.flatMap((r) => r.slots).forEach((sl) => {
          // App slots match by slug; TOOL slots by their view name (the
          // tool: tail — "preview" is the Browser). First match claims the
          // key so twin tools can't both go sticky.
          const key = sl.view === "app" ? sl.slug.toLowerCase() : sl.view;
          const want = stickyKeys.has(key) && !claimed.has(key);
          sl.sticky = want;
          if (want) claimed.add(key);
        });
      }
      // No saveLayout() here: nothing changed — the memory stays as the user
      // left it, and the next drag re-saves anyway.
      applyFolderAndSession();
      return;
    }
    openLayoutInWorkbench({ cols: layout.cols || 2, colWidths: layout.colWidths || [], rowHeights: layout.rowHeights || [], cells });
    applyFolderAndSession();
    // Geometry recall: only when the remembered shape still matches this
    // layout's rail count — anything else is stale and gets overwritten by
    // the save that openLayoutInWorkbench just made.
    const savedRails = saved?.rails || [];
    if (savedRails.length !== rails.length) return;
    rails.forEach((r, i) => { const w = savedRails[i]?.width; if (w) r.prefWidth = Math.max(240, w); });
    requestAnimationFrame(() => {
      applyResponsiveWidths();
      const railEls = document.querySelectorAll<HTMLElement>("#code-wb-rails .ws-right-rail");
      savedRails.forEach((sr, i) => {
        if (sr.topSlotHeight && rails[i]?.slots.length === 2 && railEls[i]
            && rails[i]!.slots[0]!.view !== "coding") {
          const topSlot = railEls[i]!.querySelector(".ws-rail-slot") as HTMLElement | null;
          if (topSlot) topSlot.style.flex = `0 0 ${sr.topSlotHeight}px`;
        }
      });
      saveLayout();
    });
  }

  function openLayoutInWorkbench(layout: WbGridLayout): void {
    rails.length = 0;
    maximizedSlotId = null;
    const cols = Math.max(1, layout.cols);
    const usable = Math.max(0, railsBudget() - (cols + 1) * 6);
    const TOOL_VIEWS = new Set(["files", "terminal", "diff", "preview", "plan", "coding", "monaco"]);
    const toSlot = (c: WbLayoutCell): Slot => {
      if (c.tool && TOOL_VIEWS.has(c.tool)) {
        const slot = makeSlot(c.tool as Exclude<ViewKind, "app">);
        slot.sticky = c.sticky;   // a TOOL cell can be the pin (Browser band)
        // Layout-slotted app setup: the Browser opens AT the layout's URL,
        // the Terminal runs the layout's first command once its shell is up.
        if (slot.view === "preview" && c.config?.url) slot.url = c.config.url;
        if (slot.view === "terminal" && c.config?.cmd) slot.terminals[0]!.initCmd = c.config.cmd;
        return slot;
      }
      return { id: nextSlotId++, view: "app" as const, slug: c.slug, name: c.name, url: c.url, glyphh: c.glyphh, sticky: c.sticky, urlBarHidden: urlBarHiddenDefault() };
    };
    // A cell spanning EVERY column can't live inside the column rails — it
    // renders as a full-width BAND above/below them (the one span shape real
    // layouts use). Partial spans still fall back to their anchor column.
    const spanning = cols > 1 ? layout.cells.filter((c) => (c.span ?? 1) >= cols) : [];
    const columnar = layout.cells.filter((c) => !spanning.includes(c));
    const minRow = columnar.length ? Math.min(...columnar.map((c) => c.row)) : 0;
    const rowFrac = (row: number): number | undefined => {
      const f = layout.rowHeights[row];
      return typeof f === "number" && f > 0 && f < 1 ? f : undefined;
    };
    // rails[] stays in DOM order — top bands, columns, bottom bands — so every
    // positional railEls lookup keeps lining up.
    const railCells: WbLayoutCell[][] = [];
    for (const c of spanning.filter((b) => b.row <= minRow)) {
      rails.push({ id: nextRailId++, slots: [toSlot(c)], banner: "top", heightFrac: rowFrac(c.row) });
      railCells.push([c]);
    }
    for (let col = 0; col < cols; col++) {
      const colCells = columnar.filter((c) => c.col === col).sort((a, b) => a.row - b.row);
      if (!colCells.length) continue;
      const slots: Slot[] = colCells.map(toSlot);
      const frac = layout.colWidths[col] ?? 1 / cols;
      rails.push({ id: nextRailId++, slots, prefWidth: Math.max(240, Math.round(usable * frac)) });
      railCells.push(colCells);
    }
    for (const c of spanning.filter((b) => b.row > minRow)) {
      rails.push({ id: nextRailId++, slots: [toSlot(c)], banner: "bottom", heightFrac: rowFrac(c.row) });
      railCells.push([c]);
    }
    renderRails();
    // Proportion the stacked slot heights per rowHeights (post-render so the
    // slot elements exist).
    requestAnimationFrame(() => {
      const railEls = document.querySelectorAll<HTMLElement>("#code-wb-rails .ws-right-rail");
      rails.forEach((rail, ri) => {
        const el = railEls[ri];
        if (!el || rail.banner) return;   // a band's single slot always fills it
        const colCells = railCells[ri] ?? [];
        // NORMALIZE the rail's grow factors to sum to 1. Flexbox only fills
        // the container when grows sum to >= 1 — a rail holding one slot of a
        // [0.6, 0.4] layout would otherwise take 60% and leave 40% EMPTY,
        // which is exactly how every panel came up short on layout render.
        const slotEls = Array.from(el.querySelectorAll<HTMLElement>(".ws-rail-slot"));
        const fracs = slotEls.map((_s, si) => layout.rowHeights[colCells[si]?.row ?? si] ?? 1 / rail.slots.length);
        const totalFrac = fracs.reduce((a, b) => a + b, 0);
        slotEls.forEach((slotEl, si) => {
          const grow = totalFrac > 0 ? fracs[si]! / totalFrac : 1 / slotEls.length;
          slotEl.style.flex = `${grow || 1} 1 0`;
        });
      });
      scheduleAppSync();
    });
    saveLayout();
  }

  const wbApp = window as unknown as {
    __wbOpenApp?: (app: WbAppRef, newPanel?: boolean) => void;
    __wbOpenApps?: (apps: WbAppRef[]) => void;
    __wbOpenLayoutByName?: (name: string) => Promise<boolean>;
    __wbOpenLayout?: (layout: WbGridLayout) => void;
    __wbClearPanels?: () => Promise<boolean>;
    __wbGridPanels?: () => boolean;
    __wbListApps?: () => Array<{ slug: string; name: string }>;
    __wbCloseApp?: (slug: string) => boolean;
    __wbFocusApp?: (slug: string) => boolean;
    __wbToggleAppSwitcher?: () => void;
    __wbOpenSection?: (section: string) => void;
  };
  wbApp.__wbOpenApp = (app, newPanel) => openAppInWorkbench(app, { newPanel });
  wbApp.__wbOpenApps = (apps, layoutName?: string) => {
    // A NAMED layout comes up through the grid path — its definition plus the
    // user's remembered geometry — never as a flat stack. The old fallback
    // stacked panels flat and then SAVED that stack under the layout's name,
    // which is why every re-open lost the user's arrangement.
    if (layoutName) {
      void wbApp.__wbOpenLayoutByName!(layoutName).then((ok) => {
        if (ok) return;
        // Unknown name (deleted layout?) — flat open, but write no named memory.
        activeLayoutName = null;
        for (const a of apps) openAppInWorkbench(a, { newPanel: true });
      });
      return;
    }
    for (const a of apps) openAppInWorkbench(a, { newPanel: true });
  };
  // An anonymous grid (no name) must not write into whatever named layout was
  // active before — openLayoutInWorkbench ends in saveLayout().
  wbApp.__wbOpenLayout = (layout) => { activeLayoutName = null; openLayoutInWorkbench(layout); };
  // `.dip clear` — close all workspace panels. JUST the panels: sessions,
  // history, everything else stays untouched.
  wbApp.__wbClearPanels = () => clearAllPanels();
  // `.dip grid` — re-flow every open panel into an even grid: rails of two
  // stacked slots, equal widths, equal heights.
  wbApp.__wbGridPanels = (): boolean => {
    const slots = rails.flatMap((r) => r.slots);
    if (!slots.length) return false;
    maximizedSlotId = null;
    const cols = Math.ceil(slots.length / 2);
    const usable = Math.max(0, railsBudget() - (cols + 1) * 6);
    rails.length = 0;
    for (let col = 0; col < cols; col++) {
      const pair = slots.slice(col * 2, col * 2 + 2);
      if (pair.length) rails.push({ id: nextRailId++, slots: pair, prefWidth: Math.max(240, Math.round(usable / cols)) });
    }
    renderRails();
    requestAnimationFrame(() => {
      document.querySelectorAll<HTMLElement>("#code-wb-rails .ws-rail-slot").forEach((slotEl) => { slotEl.style.flex = "1 1 0"; });
      scheduleAppSync();
    });
    saveLayout();
    return true;
  };
  wbApp.__wbOpenLayoutByName = async (name: string): Promise<boolean> => {
    const yo = (window as unknown as { yo?: { panelAppsList?: () => Promise<PanelAppRow[]>; layoutsList?: () => Promise<LayoutRow[]> } }).yo;
    const [rows, layouts] = await Promise.all([yo?.panelAppsList?.() ?? [], yo?.layoutsList?.() ?? []]);
    const key = name.trim().toLowerCase();
    // Match like the switcher's search does — exact, then prefix, then
    // SUBSTRING — so anything findable in the switcher is .dip-able too.
    const layout = layouts.find((l) => l.name.toLowerCase() === key)
      ?? layouts.find((l) => l.name.toLowerCase().startsWith(key))
      ?? layouts.find((l) => l.name.toLowerCase().includes(key));
    if (!layout) return false;
    openLayoutRow(layout, rows);
    return true;
  };
  wbApp.__wbListApps = () => appSlots().map((s) => ({ slug: s.slug, name: s.name }));
  wbApp.__wbCloseApp = (slug) => closeWbApp(slug);
  wbApp.__wbFocusApp = (slug) => {
    const slot = appSlots().find((s) => s.slug === slug);
    if (!slot) return false;
    focusAppSlot(slot.id);
    return true;
  };
  wbApp.__wbToggleAppSwitcher = () => toggleAppSwitcher();
  wbApp.__wbOpenSection = (section: string) => openSectionInWorkbench(section);
  // #code-apps-btn is bound in help/code.ts initCode() via openCommandCenter so
  // it works cold (before this async init runs) and Cmd+. shares the same path.

  window.addEventListener("agent-sessions-changed", () => {
    type SessionsApi = { currentTitle(): string; currentId(): string | null };
    const sess = (window as unknown as { __agentSessions?: SessionsApi }).__agentSessions;
    const titleEl = document.querySelector<HTMLElement>('.ws-rail-slot[data-view="coding"] .ws-rail-slot-header .title');
    if (titleEl && sess) titleEl.textContent = sess.currentTitle();
    // Remember which session rode this layout — "last" sessionMode resumes it.
    const cur = sess?.currentId?.();
    if (activeLayoutName && cur) {
      try { localStorage.setItem(layoutSessionKey(activeLayoutName), cur); } catch { /* best effort */ }
    }
  });

  (window as unknown as { __codeWorkbenchNewSession?: () => void }).__codeWorkbenchNewSession = () => {
    // A new session KEEPS the workbench — every arrangement was built
    // deliberately; the folder-backed views follow the folder, not the
    // session. (This used to close all rails unless a layout was active.)
    void paintWorkdirBar(cwd);
  };

  let lastCwd = cwd;
  window.wb.onCwdChanged((dir) => {
    const next = dir || "";
    if (next === lastCwd) return;
    // Persist the current rails to the OLD folder's key before switching
    // (so the user's arrangement is preserved per-folder), then load the
    // NEW folder's saved layout — or its default if none exists.
    if (lastCwd) {
      const prevCwd = cwd;
      cwd = lastCwd;
      try { saveLayout(); } catch { /* noop */ }
      cwd = prevCwd;
    }
    cwd = next;
    lastCwd = next;
    void paintWorkdirBar(cwd);
    // KEEP the user's arrangement — a folder change re-roots the
    // folder-backed views in place (Files re-lists, Diff re-fetches, Plan
    // reloads on render). Tearing the workbench down and rebuilding from the
    // new folder's snapshot reset panels the user had deliberately arranged.
    for (const rail of rails) {
      for (const slot of rail.slots) {
        if (slot.view === "files") (slot as FilesSlot).root = null;
      }
    }
    renderRails();
  });

  // ── Live file updates ──
  // When anything writes under the cwd (commonly the agent during a spec
  // workflow), refresh whatever views are affected:
  //  - Monaco tabs whose path matches: re-read content, swap model
  //  - Diff slot: re-fetch (anything in the tree might have moved)
  //  - Files tree: invalidate loaded children of the dir containing the
  //    changed path so the next render re-lists; lightweight repaint.
  // Refresh ONLY the Files slot trees in place — never a full renderRails().
  // A folder under constant churn (a build, a dev server writing files) would
  // otherwise rebuild the entire workbench on every write, twitching the UI and
  // fighting the user's panel drags.
  function refreshFilesSlotsInPlace(): void {
    for (const rail of rails) {
      for (const slot of rail.slots) {
        if (slot.view !== "files") continue;
        (slot as FilesSlot).root = null;
        const body = document.querySelector<HTMLElement>(`.ws-rail-slot[data-slot-id="${slot.id}"] .ws-rail-slot-body`);
        if (body) void renderFilesIntoSlot(body, slot as FilesSlot);
      }
    }
  }
  // Throttle: at most one refresh per window, with a trailing run for changes
  // that arrive mid-window — caps the refresh rate no matter how fast files churn.
  const FILES_REFRESH_MS = 1500;
  let filesRefreshAt = 0;
  let filesRefreshPending = false;
  let filesRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleFilesRefresh(): void {
    const now = Date.now();
    if (now - filesRefreshAt >= FILES_REFRESH_MS) {
      filesRefreshAt = now;
      refreshFilesSlotsInPlace();
    } else {
      filesRefreshPending = true;
      if (!filesRefreshTimer) {
        filesRefreshTimer = setTimeout(() => {
          filesRefreshTimer = null;
          if (filesRefreshPending) { filesRefreshPending = false; filesRefreshAt = Date.now(); refreshFilesSlotsInPlace(); }
        }, FILES_REFRESH_MS - (now - filesRefreshAt));
      }
    }
  }
  window.wb.onFileChanged(async (abs) => {
    if (!cwd || !abs.startsWith(cwd)) return;
    // Monaco viewer tabs — re-read any tab whose path matches.
    for (const rail of rails) {
      for (const slot of rail.slots) {
        if (slot.view !== "monaco") continue;
        const mslot = slot as MonacoSlot;
        const tabIdx = mslot.tabs.findIndex((t) => t.path === abs);
        if (tabIdx < 0) continue;
        if (mslot.tabs[tabIdx].dirty) continue; // never clobber unsaved edits
        const res = await window.wb.readFile(abs);
        const newContent = res.error ? `// error: ${res.error}` : res.content;
        mslot.tabs[tabIdx].content = newContent;
        // Only repaint the Monaco editor if this is the active tab — the
        // others will pick up the new content on tab switch via setModel.
        if (tabIdx === mslot.activeIdx) {
          const slotEl = document.querySelector<HTMLElement>(`.ws-rail-slot[data-slot-id="${mslot.id}"]`);
          const host = slotEl?.querySelector<HTMLElement>(".ws-monaco-host");
          const existing = host && (host as unknown as { __editor?: any }).__editor;
          if (existing) {
            const w = window as unknown as { monaco: any };
            existing.setModel(w.monaco.editor.createModel(newContent, languageForFile(mslot.tabs[tabIdx].name)));
          }
        }
      }
    }
    // Files tree — refresh just the Files slot(s) in place, throttled.
    const filesAffected = rails.some((r) => r.slots.some((s) => s.view === "files"));
    if (filesAffected) scheduleFilesRefresh();
    // Diff — if open, refresh.
    for (const rail of rails) {
      for (const slot of rail.slots) {
        if (slot.view !== "diff") continue;
        const slotEl = document.querySelector<HTMLElement>(`.ws-rail-slot[data-slot-id="${slot.id}"]`);
        const btn = slotEl?.querySelector<HTMLButtonElement>(".ws-diff-refresh");
        btn?.click();
      }
    }
  });
}

// Exposed as a global — help/code.ts calls this when the Code section first
// loads (this bundle is a plain script that runs before the home.js module).
let inited = false;
(window as unknown as { __initCodeWorkbench?: () => void }).__initCodeWorkbench = () => {
  if (inited) return;
  inited = true;
  void init();
};
