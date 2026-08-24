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
import { browserErrorPage, panelStateFragment, type BrowserErrorInfo, type ErrorPalette, type PanelStateKey } from "./browser-error-page.js";
import { openRemotePty, RemotePtyError, type RemotePtyHandle } from "./remote-terminal.js";
import { resolveBrowserHome } from "../shared/browser-home.js";
import { appIconInner, appIconUrl, primeNativeIcons } from "./help/app-icon.js";
import { mountStreamedPanel, type StreamedPanelHandle } from "./panel-stream.js";
import { relaySdk } from "./relay-socket.js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";

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
  /** Git state moved (.git/index / .git/HEAD) — one coalesced signal per git
   *  operation. Optional: older preloads may not expose it yet. */
  onGitChanged?: (cb: () => void) => () => void;
  /** WEB target only (wb-relay.js / wb-pod.js): can the session's fs transport
   *  answer right now? Drives the honest offline / signed-out panel states.
   *  "runtime-offline" = a CLOUD session whose pod workspace is unreachable. */
  webFsStatus?: () => Promise<"ok" | "desktop-offline" | "signed-out" | "runtime-offline">;
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

type ViewKind = "files" | "terminal" | "diff" | "preview" | "monaco" | "plan" | "coding" | "echo" | "releases" | "tasks" | "thread" | "section" | "app";

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
  /** WEB target only: the pty running on the ATTACHED DESKTOP over the relay
   *  (remote-terminal.ts). Desktop keeps using local wb-term IPC (unset). */
  remote?: RemotePtyHandle;
}
interface TermSlot {
  id: number; view: "terminal";
  terminals: WbTerminal[];
  activeIdx: number;
  sticky?: boolean;
}
/** Files are CLOSED by default — `expanded` tracks the ones the user opened. */
interface DiffSlot { id: number; view: "diff"; expanded?: Set<string>; sticky?: boolean }
/** Releases — the release-management view for BUILT (glyphh-hosted) apps:
 *  pick an app, see its release history, cut a build, promote to live.
 *  `slug` remembers the picked app across renders/layout saves. */
interface ReleasesSlot { id: number; view: "releases"; slug?: string; sticky?: boolean }
/** Tasks — the user's SCHEDULED work in one place: every agent task, when it
 *  fires next, how the last run went, and (per task) the full run history.
 *  Deliberately NOT in TOOL_VIEWS or the layout tool list — it opens ONLY
 *  from its rail tab. `taskId` remembers an opened detail across renders. */
interface TasksSlot { id: number; view: "tasks"; taskId?: string; sticky?: boolean }
/** The Glyphh seat (internal view "coding" — persisted layouts reference the
 *  key) — HOSTS the live agent DOM (same sessions, same composer); nothing
 *  of its own beyond the header's session controls. */
interface CodingSlot { id: number; view: "coding"; sticky?: boolean }
/** The Transcript panel — HOSTS the live #code-thread DOM (renderThread()
 *  wipes it every repaint and the streamer writes into it, so it is MOVED,
 *  never cloned). Opens on demand from the collapsed bar; never persisted. */
interface ThreadSlot { id: number; view: "thread"; sticky?: boolean }
/** A whole app SECTION (Home, Apps, Settings, Drips, …) hosted as a panel —
 *  the section's singleton DOM is adopted into the slot body (the same
 *  reparenting trick the coding slot uses for the agent). */
interface SectionSlot { id: number; view: "section"; section: string; sticky?: boolean }
/** Echo — the open app panels as LIVE snapshots floating in a three.js
 *  scene, with the real agent DOM docked front-center in the space. */
interface EchoSlot { id: number; view: "echo"; sticky?: boolean }
interface PreviewTab { id: number; url?: string; html?: string; htmlLabel?: string; title?: string }
interface PreviewSlot {
  id: number; view: "preview"; url?: string; viewKey?: string; sticky?: boolean;
  /** Inline document (Glyphh build previews) — runtime-only, never persisted. */
  html?: string; htmlLabel?: string;
  /** The BROWSER TABS — runtime model; the legacy url/html fields mirror the
   *  active tab so persistence and status reads keep working. */
  tabs?: PreviewTab[]; activeTab?: number;
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
type Slot = MonacoSlot | FilesSlot | TermSlot | DiffSlot | PreviewSlot | PlanSlot | CodingSlot | ThreadSlot | EchoSlot | ReleasesSlot | TasksSlot | SectionSlot | AppSlot;

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
  preview:  { title: "Browser",  icon: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5" style="fill:#0ea5e9;stroke:none"/><path d="M2.8 12h18.4" style="fill:none;stroke:#ffffff;stroke-width:1.7"/><path d="M12 2.7c3.3 2.5 3.3 16.1 0 18.6M12 2.7c-3.3 2.5-3.3 16.1 0 18.6" style="fill:none;stroke:#e0f2fe;stroke-width:1.5"/><path d="M4.3 7.6c2.3-1.2 13.1-1.2 15.4 0M4.3 16.4c2.3 1.2 13.1 1.2 15.4 0" style="fill:none;stroke:#bae6fd;stroke-width:1.5"/></svg>` },
  monaco:   { title: "Editor",   icon: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>` },
  echo:     { title: "Echo",     icon: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="9" rx="1.5"/><path d="M5 15V6.5A1.5 1.5 0 0 1 6.5 5H17"/><path d="M2 12V3.5A1.5 1.5 0 0 1 3.5 2H14"/></svg>` },
  // ONE agent, ONE identity: the rails seat carries the same user-facing name
  // as the Echo agent card ("Glyphh") — the internal view key stays "coding"
  // (persisted layouts reference it).
  coding:   { title: "Glyphh", icon: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><polyline points="9 9 7 11 9 13"/><polyline points="15 9 17 11 15 13"/></svg>` },
  plan:     { title: "Plan",     icon: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>` },
  releases: { title: "Releases", icon: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>` },
  tasks:    { title: "Scheduled Tasks", icon: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><polyline points="9 15 11 17 15 13"/></svg>` },
  thread:   { title: "Transcript", icon: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="13" y2="13"/></svg>` },
  app:      { title: "App",      icon: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>` },
};

// ── The Echo dock — FIXED nav slots above the wall's search box.
// FULL-BLEED object silhouettes in saturated fills with white/tinted
// details — never a glyph trapped in a uniform colored square. Sections
// open as wall cards via __wbOpenSection; tools (tasks, preview) go
// through __wbOpenTool. ──
const DOCK_ITEMS: Array<{ key: string; title: string; icon: string }> = [
  { key: "marketplace", title: "Marketplace",     icon: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.2 4.6 3.5h14.8L21 8.2z" style="fill:#f97316;stroke:none"/><path d="M3 8.2h3.6v1.1a1.8 1.8 0 1 1-3.6 0z" style="fill:#ffffff;stroke:none"/><path d="M6.6 8.2h3.6v1.1a1.8 1.8 0 1 1-3.6 0z" style="fill:#fdba74;stroke:none"/><path d="M10.2 8.2h3.6v1.1a1.8 1.8 0 1 1-3.6 0z" style="fill:#ffffff;stroke:none"/><path d="M13.8 8.2h3.6v1.1a1.8 1.8 0 1 1-3.6 0z" style="fill:#fdba74;stroke:none"/><path d="M17.4 8.2h3.6v1.1a1.8 1.8 0 1 1-3.6 0z" style="fill:#ffffff;stroke:none"/><path d="M4.2 11.2h15.6v7.8a1.5 1.5 0 0 1-1.5 1.5H5.7a1.5 1.5 0 0 1-1.5-1.5z" style="fill:#fb923c;stroke:none"/><rect x="13.4" y="14" width="3.6" height="6.5" rx="0.7" style="fill:#7c2d12;stroke:none"/><rect x="6.6" y="14" width="4" height="3.4" rx="0.7" style="fill:#ffedd5;stroke:none"/></svg>` },
  { key: "connections", title: "Connections",     icon: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13.4 10.6a4.4 4.4 0 0 1 0 6.2l-2.9 2.9a4.4 4.4 0 0 1-6.2-6.2l1.7-1.7" style="fill:none;stroke:#0e7490;stroke-width:2.6"/><path d="M10.6 13.4a4.4 4.4 0 0 1 0-6.2l2.9-2.9a4.4 4.4 0 0 1 6.2 6.2l-1.7 1.7" style="fill:none;stroke:#06b6d4;stroke-width:2.6"/></svg>` },
  { key: "settings",    title: "Settings",        icon: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><g style="fill:#71717a;stroke:none"><rect x="10.6" y="1.2" width="2.8" height="21.6" rx="1.3"/><rect x="10.6" y="1.2" width="2.8" height="21.6" rx="1.3" transform="rotate(45 12 12)"/><rect x="10.6" y="1.2" width="2.8" height="21.6" rx="1.3" transform="rotate(90 12 12)"/><rect x="10.6" y="1.2" width="2.8" height="21.6" rx="1.3" transform="rotate(135 12 12)"/><circle cx="12" cy="12" r="8"/></g><circle cx="12" cy="12" r="3.2" style="fill:#ffffff;stroke:none"/></svg>` },
  { key: "logout",      title: "Sign out",        icon: `<svg class="icon" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10.2" style="fill:#f43f5e"/><path d="M8.1 8.4a5.6 5.6 0 1 0 7.8 0" style="stroke:#ffffff;stroke-width:2.4;stroke-linecap:round"/><rect x="10.7" y="4.4" width="2.6" height="7" rx="1.3" style="fill:#ffffff"/></svg>` },
];

// ── Echo wall persistence ────────────────────────────────────────────────
// The whole open arrangement — a layout, or the set of ad-hoc app/tool/section
// cards — is saved to a server-backed pref (window.glyphh.setPreference →
// /api/me/prefs, the SDK path) so the next boot reopens exactly what the user
// was looking at. Module scope so the one-shot restore survives wall remounts
// within a single app launch (but re-arms on a fresh launch).
const WALL_STATE_PREF = "echoWallState";
let wallRestored = false;
type WallCard = { kind: "app" | "tool" | "section"; slug?: string; url?: string; name?: string; section?: string; toolView?: string };
type WallState = { layout: string | null; cards: WallCard[] };

// ── Browser panel: start page + error pages ─────────────────────────────
//
// Both read state that lives OUTSIDE the workbench (the user's preferences,
// the active theme), so they sit here as plain helpers rather than being
// threaded through every webview call site.

const prefsYo = (): { getPreference?: (k: string, d?: unknown) => Promise<unknown> } =>
  (window as unknown as { glyphh?: { getPreference?: (k: string, d?: unknown) => Promise<unknown> } }).glyphh ?? {};

/**
 * The configured start page. Cached after the first read so the paint path
 * stays synchronous — `primeBrowserHome()` refreshes it whenever a Browser
 * panel renders, so a settings change lands on the next open.
 */
let browserHomeUrl = "";

async function primeBrowserHome(): Promise<string> {
  try {
    const [pref, custom] = await Promise.all([
      prefsYo().getPreference?.("browserHomepage", "claude"),
      prefsYo().getPreference?.("browserHomepageUrl", ""),
    ]);
    browserHomeUrl = resolveBrowserHome(pref as string, custom as string);
  } catch {
    // Preferences unreachable (web boot, signed out) — the built-in default
    // still beats opening a blank panel.
    browserHomeUrl = resolveBrowserHome(undefined, undefined);
  }
  return browserHomeUrl;
}

/** The start page for a tab that has nothing in it yet. */
function browserHome(): string {
  return browserHomeUrl || resolveBrowserHome(undefined, undefined);
}

/** The live theme's colours, resolved for a page that can't see our CSS. */
function themePalette(): ErrorPalette {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string): string => (cs.getPropertyValue(name) || "").trim() || fallback;
  return {
    bg: v("--bg", "#101014"),
    surface: v("--surface", "#17171c"),
    border: v("--border", "#2a2a32"),
    text: v("--text", "#e6e6ea"),
    dim: v("--text-3", "#8a8a95"),
    accent: v("--accent", "#8c3bf2"),
    danger: v("--danger", "#ef4444"),
    warning: v("--warning", "#f59e0b"),
  };
}

/** ERR_ABORTED (-3) is what a normal in-flight navigation cancel looks like —
 *  never an error page, or every fast click flashes one. */
const isRealLoadFailure = (code: number | undefined): boolean => !!code && code !== -3;

/** Point a webview at the themed error page for a failure. */
function showBrowserError(wv: { setAttribute: (n: string, v: string) => void }, info: BrowserErrorInfo): void {
  wv.setAttribute("src", browserErrorPage(info, themePalette()));
}

/** Panel titles for hosted sections (slot headers + layout minis). */
const SECTION_TITLES: Record<string, string> = {
  dashboard: "Home", connections: "Connections", apps: "Apps", marketplace: "Marketplace",
  layouts: "Workspaces",
  skills: "Skills", loops: "Loops", agents: "Agents", models: "Models",
  settings: "Settings", docs: "Docs",
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
  // Decide by the theme's ACTUAL surface, not its name — "dark" was the only
  // name that mapped to vs-dark, so every other dark scheme (high-vis,
  // matrix, …) got a white editor in a black app.
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim()
    || getComputedStyle(document.body).backgroundColor;
  let r = 255, g = 255, b = 255;
  const hex = /^#([0-9a-f]{6})$/i.exec(raw);
  const rgb = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(raw);
  if (hex) { const n = parseInt(hex[1]!, 16); r = (n >> 16) & 255; g = (n >> 8) & 255; b = n & 255; }
  else if (rgb) { r = +rgb[1]!; g = +rgb[2]!; b = +rgb[3]!; }
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128 ? "vs-dark" : "vs";
}
function isMarkdown(name: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(name);
}
/** Ink that reads on the theme's ACCENT — white on dark accents (purple,
 *  GitHub blue), black on bright ones (Matrix green, amber, high-vis
 *  yellow). Exposed as --accent-ink for CSS (the space tabs' active pill). */
function applyAccentInk(): void {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  let r = 128, g = 128, b = 128;
  const hex = /^#([0-9a-f]{6})$/i.exec(raw);
  const rgb = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(raw);
  if (hex) { const n = parseInt(hex[1]!, 16); r = (n >> 16) & 255; g = (n >> 8) & 255; b = n & 255; }
  else if (rgb) { r = +rgb[1]!; g = +rgb[2]!; b = +rgb[3]!; }
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  document.documentElement.style.setProperty("--accent-ink", lum < 140 ? "#fff" : "#000");
}
applyAccentInk();
// Monaco's theme is GLOBAL and only read at editor creation — re-apply it
// (and the accent ink) whenever the app theme flips (settings stamps
// data-theme on <html>).
new MutationObserver(() => {
  applyAccentInk();
  const w = window as unknown as { monaco?: { editor?: { setTheme?: (t: string) => void } } };
  try { w.monaco?.editor?.setTheme?.(monacoTheme()); } catch { /* monaco not loaded yet */ }
}).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

async function init(): Promise<void> {
  if (!window.wb) {
    console.error("[code-workbench] window.wb bridge missing — preload not loaded; workdir controls and rails are dead.");
    return;
  }

  let cwd = await window.wb.getCwd().catch(() => "");

  // Default address-bar visibility for app panels — a roaming pref set in
  // Settings → Appearance. New app slots inherit it; the per-panel header
  // toggle overrides. Settings dispatches an event so changes apply live.
  const yoPrefs = (window as unknown as { glyphh?: { getPreference?: (k: string, d?: unknown) => Promise<unknown> } }).glyphh;
  let appUrlBarShow = (await yoPrefs?.getPreference?.("showAppUrlBar", true)) !== false;
  const urlBarHiddenDefault = (): boolean => !appUrlBarShow;
  document.addEventListener("glyphh:app-urlbar-default", (e) => { appUrlBarShow = !!(e as CustomEvent).detail; });

  // ── Workdir bar — mirrors agent.ts ──
  const workdirBtn = document.getElementById("code-workdir-btn") as HTMLButtonElement | null;
  const workdirName = document.getElementById("code-workdir-name");
  const workdirAdd = document.getElementById("code-workdir-add") as HTMLButtonElement | null;
  const branchWrap = document.getElementById("code-workdir-branch-wrap");
  const branchEl = document.getElementById("code-workdir-branch");
  // The Work landing's copy of the same chips (dashboard.html, no git chip) —
  // painted and wired alongside the header originals.
  const dashWdBtn = document.getElementById("dash-wd-btn") as HTMLButtonElement | null;
  const dashWdName = document.getElementById("dash-wd-name");
  const dashWdAdd = document.getElementById("dash-wd-add") as HTMLButtonElement | null;
  const dashBranchWrap = document.getElementById("dash-wd-branch-wrap");
  const dashBranchEl = document.getElementById("dash-wd-branch");

  const dropdown = document.createElement("div");
  dropdown.className = "yo-workdir-menu";
  dropdown.setAttribute("role", "menu");
  document.body.appendChild(dropdown);
  const closeDropdown = () => dropdown.classList.remove("open");
  const isDropdownOpen = () => dropdown.classList.contains("open");

  async function paintWorkdirBar(dir: string): Promise<void> {
    // No explicit pick = the session's default root (the user's home dir) —
    // never a "Pick a folder" nag; picking is optional, not a gate.
    if (workdirName) workdirName.textContent = dir ? basename(dir) : "Home";
    if (workdirBtn) workdirBtn.title = dir ? `working directory: ${dir}` : "working directory: your home folder";
    if (dashWdName) dashWdName.textContent = dir ? basename(dir) : "Home";
    if (dashWdBtn) dashWdBtn.title = dir ? `working directory: ${dir}` : "working directory: your home folder";
    const setBranch = (branch: string | null): void => {
      for (const [wrap, el2] of [[branchWrap, branchEl], [dashBranchWrap, dashBranchEl]] as const) {
        if (!wrap || !el2) continue;
        if (branch) { el2.textContent = branch; (wrap as HTMLElement).style.display = ""; }
        else (wrap as HTMLElement).style.display = "none";
      }
    };
    if (!dir) { setBranch(null); return; }
    try {
      const info = await window.wb.gitInfo(dir);
      setBranch(info.isRepo && info.branch ? info.branch : null);
    } catch {
      setBranch(null);
    }
  }

  async function openDropdown(anchor: HTMLElement | null = workdirBtn): Promise<void> {
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

    if (anchor) {
      const r = anchor.getBoundingClientRect();
      dropdown.style.left = `${r.left}px`;
      // Open UP from a low anchor (the landing / composer chip rows) — the
      // source popup's direction — and down only from a header-top anchor.
      if (r.top > window.innerHeight / 2) {
        dropdown.style.top = "auto";
        dropdown.style.bottom = `${window.innerHeight - r.top + 4}px`;
      } else {
        dropdown.style.bottom = "auto";
        dropdown.style.top = `${r.bottom + 4}px`;
      }
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
  dashWdBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    isDropdownOpen() ? closeDropdown() : void openDropdown(dashWdBtn);
  });
  dashWdAdd?.addEventListener("click", (e) => {
    e.stopPropagation();
    void window.wb.pickCwd();
  });
  document.addEventListener("click", (e) => {
    if (!isDropdownOpen()) return;
    if (dropdown.contains(e.target as Node)) return;
    if (workdirBtn?.contains(e.target as Node)) return;
    if (dashWdBtn?.contains(e.target as Node)) return;
    closeDropdown();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isDropdownOpen()) closeDropdown();
  });

  // ── Focus guard ──────────────────────────────────────────────────────────
  // An Electron <webview> guest steals HOST focus whenever its page loads or
  // navigates — during an agent run the preview/app panels hot-reload on every
  // file write, so the composer kept losing the keyboard mid-word (keystrokes
  // landed in whichever panel refreshed last). A guest may only take focus
  // from a real user gesture: focus arriving on a <webview> with no recent
  // pointerdown on it snaps back to the text field it robbed.
  let lastPointerTarget: EventTarget | null = null;
  let lastPointerAt = 0;
  document.addEventListener("pointerdown", (e) => {
    lastPointerTarget = e.target;
    lastPointerAt = Date.now();
  }, true);
  document.addEventListener("focusin", (e) => {
    const t = e.target as HTMLElement | null;
    if (!t || t.tagName !== "WEBVIEW") return;
    const meant = Date.now() - lastPointerAt < 600
      && (t === lastPointerTarget || (lastPointerTarget instanceof Node && t.contains(lastPointerTarget)));
    if (meant) return;
    const robbed = (e as FocusEvent).relatedTarget as HTMLElement | null;
    if (robbed && (robbed.tagName === "TEXTAREA" || robbed.tagName === "INPUT" || robbed.isContentEditable)) {
      robbed.focus();
    }
  }, true);

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
  type LayoutRow = { name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; target?: "glyphh" | "desktop"; sessionMode?: "keep" | "new" | "last"; folder?: string | null; space?: "chat" | "cowork" | "code" | null; loop?: string | null; modelSelections?: Record<string, string>; splits: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number; sticky?: boolean; config?: { url?: string; cmd?: string; keepAlive?: boolean } }> };

  function layoutKey(): string { return `workbench:layout:${cwd || "__nohome__"}`; }
  // The NAMED layout currently arranged in the workbench. While set, every
  // geometry change (rail widths, slot heights, panel arrangement) also saves
  // under the layout's own key — so reopening the layout recalls how the user
  // left it, not the server's default placement.
  let activeLayoutName: string | null = null;
  /** The ECHO layout on stage + its sessionMode — the mode is the contract:
   *  "last" binds a session to the layout AND persists panel state; "new"
   *  starts fresh every open and persists nothing; "keep" rides along. */
  let echoActiveLayout: { name: string; mode: "keep" | "new" | "last" } | null = null;
  function namedLayoutKey(name: string): string { return `workbench:namedlayout:${name.trim().toLowerCase()}`; }
  /** The chat session last used while this named layout was active. */
  /** The layout↔session binding is PER SPACE — a layout remembers the
   *  session it rode in EACH space, so opening it from Work never resumes
   *  (or steals) its Code session. The un-suffixed legacy key is read as a
   *  fallback, validated against the space before use. */
  function activeSpace(): "chat" | "cowork" | "code" {
    const v = document.body.dataset.railSpace;
    return v === "code" ? "code" : v === "chat" ? "chat" : "cowork";
  }
  /** THE LAYOUT decides its space, not the tab it was opened from: explicit
   *  `space` wins; otherwise dev tool panels make it a Code layout, anything
   *  else is Work. One layout, one space — dual use means two layouts. */
  const DEV_PANEL_RE = /^tool:(coding|terminal|editor|diff|git)/;
  /** The rail tabs' own glyphs (24-box stroke paths) — drawn as tile badges. */
  const SPACE_GLYPHS: Record<"chat" | "cowork" | "code", string[]> = {
    chat: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"],
    cowork: [
      "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
      "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
    ],
    code: ["M16 18 L22 12 L16 6", "M8 6 L2 12 L8 18"],
  };
  /** Auto-derived space (no explicit pick) wears a sparkle, not the derived
   *  space's glyph — so "I chose Code" and "it looks like Code" read apart. */
  const AUTO_GLYPH = [
    "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z",
    "M18.5 15.5l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9z",
  ];
  function layoutSpace(row?: { space?: string | null; splits?: Array<{ panelId: string }> } | null): "chat" | "cowork" | "code" {
    const s = row?.space;
    if (s === "chat" || s === "cowork" || s === "code") return s;
    return (row?.splits ?? []).some((p) => DEV_PANEL_RE.test(String(p.panelId || ""))) ? "code" : "cowork";
  }
  /** Opening a layout activates ITS space — the rail tab follows the layout
   *  (help/code.ts listens and re-scopes lists/menus without navigating). */
  function activateLayoutSpace(row: Parameters<typeof layoutSpace>[0]): "chat" | "cowork" | "code" {
    const space = layoutSpace(row);
    window.dispatchEvent(new CustomEvent("glyphh:activate-space", { detail: space }));
    return space;
  }
  function layoutSessionKey(name: string, space: string = activeSpace()): string {
    return `workbench:layoutsession:${name.trim().toLowerCase()}:${space}`;
  }
  function layoutSessionKeyLegacy(name: string): string { return `workbench:layoutsession:${name.trim().toLowerCase()}`; }
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
        } else if (v === "coding" || v === "thread") {
          // NEVER restore an agent slot — the agent opens on demand; a stale one
          // saved by the old force-place would otherwise re-open every load.
          // The transcript panel is the same deal: it hosts live singleton DOM
          // and re-opens on demand, never from a saved layout.
          continue;
        } else if (v === "files" || v === "terminal" || v === "diff" || v === "preview" || v === "plan" || v === "echo" || v === "monaco" || v === "releases") {
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
    // ...unless the agent is ANCHORED, in which case it is a sibling that really
    // does take room. Measure the dock, not the aside: the aside is width:auto
    // (sized BY the rails), so budgeting from it would be circular. Only left/right
    // compete horizontally — in `rail` the agent is display:none, and in `center`
    // it is a full-width bottom bar that costs height, not width.
    const anchor = root?.dataset.anchor;
    let dockW = 0;
    if (root && (anchor === "left" || anchor === "right")) {
      const agent = root.querySelector<HTMLElement>(":scope > .code-agent");
      dockW = agent ? agent.getBoundingClientRect().width : 0;
    }
    return Math.max(260, rootW - dockW);
  }
  function applyResponsiveWidths(): void {
    const container = document.getElementById("code-wb-rails");
    if (!container || rails.length === 0) return;
    const containerW = railsBudget();
    // Bands span the full width and stay out of the apportioning entirely;
    // only the column rails (and their drop strips) share the budget.
    const sized = rails.filter((r) => !r.banner);
    const stripsW = 0;   // drop strips are zero-width until a drag opens them
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
    // Full-width surface: surplus spreads across ALL rails proportionally —
    // dumping it on the last rail made every freshly opened panel swallow
    // the pane (and instantly overrode that rail's own width drags).
    if (total < available && widths.length && total > 0) {
      const scale = available / total;
      for (let i = 0; i < widths.length; i++) widths[i] = Math.round(widths[i] * scale);
    }
    const railEls = container.querySelectorAll<HTMLElement>(".ws-right-rail");
    let si = 0;
    rails.forEach((r, idx) => {
      const el = railEls[idx];
      if (!el) return;
      if (r.banner) { el.style.width = ""; return; }
      el.style.width = widths[si++] + "px";
    });
  }

  /** The NEW SESSION landing stands in for the agent. It is the same seat —
   *  the session you are about to start — so it survives another panel opening
   *  and keeps its own column, exactly as the running agent does. Every other
   *  internal section is still a full-screen page. */
  const isAgentSeat = (s: Slot): boolean =>
    s.view === "coding" || (s.view === "section" && s.section === "dashboard");

  function placeSlot(slot: Slot): void {
    // Internal section panels render FULL SCREEN, period — they never share
    // the grid. Placing anything else first closes any hosted section
    // (renderRails parks its DOM back to the pen). The agent seat is exempt.
    if (slot.view !== "section") {
      for (let i = rails.length - 1; i >= 0; i--) {
        rails[i].slots = rails[i].slots.filter((sl) => sl.view !== "section" || isAgentSeat(sl));
        if (!rails[i].slots.length) rails.splice(i, 1);
      }
    }
    // Keep the agent VISIBLE when a panel opens. A DOCKED agent (anchor left/right)
    // lives on `.code-root` and stays put — leave it alone. A rail-hosted agent is
    // the overlay following its coding-seat placeholder; opening a panel without
    // its own seat would leave no placeholder for the overlay to follow (the agent
    // would park home, hidden). Give it a seat FIRST (leftmost) so the new panel
    // lands to its right and the agent stays on screen.
    for (const rail of rails) {
      // Never auto-stack under the agent seat: a rail holding it keeps its
      // column, so the first new item opens BESIDE the agent — one slot to its
      // right — not squeezed beneath it. (Deliberate drag-drop placement is a
      // different path and can still stack anywhere.)
      if (rail.slots.some(isAgentSeat)) continue;
      if (rail.slots.length < 2) { rail.slots.push(slot); renderRails(); saveLayout(); return; }
    }
    rails.push({ id: nextRailId++, slots: [slot] });
    renderRails();
    saveLayout();
  }
  /** The deep-link opener: land a payload in a tool's slot wherever the tool
   *  should live RIGHT NOW — an Echo card while the wall is up (never a rail
   *  slot that dumps the wall + agent), else the existing rail slot, else a
   *  fresh placed one. */
  function openToolWithPayload(view: Exclude<ViewKind, "app" | "echo" | "coding" | "thread">, land: (slot: Slot) => void): void {
    if (echoCtl) {
      echoCtl.openToolWith(view, land);
      return;
    }
    const existing = rails.flatMap((r) => r.slots).find((t) => t.view === view);
    if (!existing) {
      const fresh = makeSlot(view);
      land(fresh);
      placeSlot(fresh);
      return;
    }
    land(existing);
    renderRails();
  }

  function placeView(view: Exclude<ViewKind, "app">): void {
    // Echo owns the workspace while it's up — a tool opens as an ECHO CARD,
    // never as a rail slot beside it. (echo/coding/thread have their own
    // paths — Echo must never adopt the transcript and fight parkThread.)
    if (echoCtl && view !== "echo" && view !== "coding" && view !== "thread") {
      echoCtl.openTool(view as "files" | "terminal" | "monaco" | "diff" | "preview" | "plan" | "releases");
      return;
    }
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
  /** While an Echo panel is mounted, every agent/panel tool routes into
   *  Echo's own slots — set by renderEchoIntoSlot, cleared on teardown. */
  interface EchoCtlType {
    openApp(app: { slug: string; name: string; url: string; glyphh?: boolean; workbench?: boolean }): void;
    openLayout(layout: { name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; splits: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number; sticky?: boolean; config?: { url?: string; cmd?: string; keepAlive?: boolean } }> }): void;
    openSection(section: string): void;
    openAgent(): void;
    /** The agent was docked (parked out to the rail/dock) — close its now-empty
     *  Echo card WITHOUT forgetting the session it still hosts. */
    detachAgent(): void;
    /** The universal chat icon: clear the surface, load the chat alone. */
    openChat(): void;
    hasTool(view: string): boolean;
    closeTool(view: string): void;
    refreshForCwd(): void;
    reset(): void;
    openTool(view: "files" | "terminal" | "monaco" | "diff" | "preview" | "plan" | "releases"): void;
    /** Open (or re-front) a tool card and LAND a payload in its slot before the
     *  card repaints — the deep-link path (open_video("id") etc.) while Echo
     *  owns the workspace. Landing via placeSlot instead tore the wall down —
     *  and the agent card with it. */
    openToolWith(view: Exclude<ViewKind, "app" | "echo" | "coding" | "thread">, land: (slot: Slot) => void): void;
    openPreviewHtml(html: string, label?: string): void;
    openPreviewUrl(url: string): void;
    openFileTab(node: { name: string; path: string }, content: string, mode?: "preview" | "code"): void;
    list(): Array<{ slug: string; name: string }>;
    close(slug: string): boolean;
    focus(slug: string): boolean;
    closeAll(): void;
    /** ⌘W: close the top panel; false when nothing is open. */
    closeTop(): boolean;
  }
  let echoCtl: EchoCtlType | null = null;

  function openPreviewUrl(url: string): void {
    if (echoCtl) { echoCtl.openPreviewUrl(url); return; }
    const slot = rails.flatMap((r) => r.slots).find((s): s is PreviewSlot => s.view === "preview");
    if (slot) {
      addPreviewUrlTab(slot, url);
      renderRails();
    } else {
      const s = makeSlot("preview") as PreviewSlot;
      addPreviewUrlTab(s, url);
      placeSlot(s);
    }
    saveLayout();
  }
  async function openFileSmart(file: { name: string; path: string }): Promise<void> {
    // The working project's plan.md IS the Plan view's document — clicking it
    // opens (or focuses) that app rather than a Monaco tab.
    if (file.path === planFilePath()) {
      if (echoCtl) { echoCtl.openTool("plan"); return; }
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
    if (echoCtl) { echoCtl.openFileTab(node, content, mode); return; }
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
    // Leaving Echo does NOT spawn an agent session — a coding slot appears only
    // when the user actually opens the agent (the old force-place persisted into
    // the saved layout and re-opened on every load, an unclearable phantom).
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
    if (view === "thread") return { id, view };
    if (view === "echo") return { id, view };
    if (view === "releases") return { id, view };
    if (view === "tasks") return { id, view };
    if (view === "plan") return { id, view, mode: "preview" };
    return { id, view: "preview", url: "" };
  }
  /**
   * The agent seat just went away — closed by hand, or replaced by a layout
   * that has no agent in it. The session it held stops being its space's
   * resume target, so the next visit to that tab opens + New Session rather
   * than silently reopening what the user closed.
   */
  function notifySeatClosed(): void {
    if (rails.some((r) => r.slots.some(isAgentSeat))) return;
    (window as unknown as { __glyphhForgetSession?: () => void }).__glyphhForgetSession?.();
  }

  function closeSlot(slotId: number): void {
    for (let i = 0; i < rails.length; i++) {
      const r = rails[i];
      const idx = r.slots.findIndex((s) => s.id === slotId);
      if (idx >= 0) {
        const wasSection = r.slots[idx].view === "section";
        const wasEcho = r.slots[idx].view === "echo";
        const wasThread = r.slots[idx].view === "thread";
        const wasSeat = isAgentSeat(r.slots[idx]);
        r.slots.splice(idx, 1);
        if (wasSeat) queueMicrotask(notifySeatClosed);
        // The transcript goes home to the agent the moment its panel closes.
        if (wasThread) parkThread();
        if (r.slots.length === 0) rails.splice(i, 1);
        // Leaving Echo does NOT spawn an agent session (see closeAllOfView).
        void wasEcho;
        renderRails();
        saveLayout();
        // Closing an internal app panel (a section) goes back to the
        // launcher — which is ECHO now.
        if (wasSection) openEchoSurface();
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
  /**
   * Wipe the workspace. `keepAgentSeat` spares the agent seat — the running
   * agent or the + New Session landing — because "the app replaces the
   * workspace" was never meant to close the session you are in or the one you
   * are about to start. The seat keeps its own rail, so the incoming app lands
   * in the column beside it.
   */
  async function clearAllPanels(keepAgentSeat = false): Promise<boolean> {
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
    const seat = keepAgentSeat ? rails.flatMap((r) => r.slots).find(isAgentSeat) : undefined;
    rails.length = 0;
    if (seat) rails.push({ id: nextRailId++, slots: [seat] });
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

  /** A stray composer (adopted onto the Home landing whose card is going away)
   *  returns to the agent's tail — its one true home; appendChild keeps the
   *  "composer is the agent's LAST child" contract parkThread depends on. The
   *  agent node itself is never in a card now (it lives in the overlay), so
   *  only the composer can strand. */
  function rescueStrayComposer(card: HTMLElement): void {
    const comp = card.querySelector<HTMLElement>(".code-composer");
    if (comp) {
      const home = document.querySelector<HTMLElement>(".code-agent");
      if (home && comp.parentElement !== home) home.appendChild(comp);
      document.body.classList.remove("composer-on-home");
    }
  }

  /** Return the live #code-thread to its home in .code-agent (before any
   *  rails rebuild, and when the transcript panel closes). Adopt on render,
   *  park before wipe. insertBefore the composer, NEVER appendChild: the
   *  composer must stay the agent's last child. */
  function parkThread(): void {
    const thread = document.getElementById("code-thread");
    const agent = document.querySelector<HTMLElement>(".code-agent");
    if (thread && agent && thread.parentElement !== agent) {
      const composer = agent.querySelector<HTMLElement>(":scope > .code-composer");
      if (composer) agent.insertBefore(thread, composer);
      else agent.appendChild(thread);
    }
    document.querySelector(".code-root")?.classList.remove("thread-hosted");
  }

  /** Adopt the LIVE #code-thread into the transcript slot. MOVE, never clone:
   *  renderThread() wipes this element on every repaint and the streamer
   *  writes into it — a copy is stale within a frame. */
  function renderThreadIntoSlot(body: HTMLElement): void {
    const thread = document.getElementById("code-thread");
    if (!thread) { body.innerHTML = `<div class="ws-empty">The transcript is unavailable.</div>`; return; }
    body.classList.add("ws-thread-body");
    body.appendChild(thread);
    document.querySelector(".code-root")?.classList.add("thread-hosted");
  }

  /** Exactly one non-band rail holding exactly one slot — the solo panel. */
  function soloPanel(): boolean {
    return rails.length === 1 && rails[0]!.slots.length === 1 && !rails[0]!.banner;
  }

  function codingHosted(): boolean {
    return rails.some((r) => r.slots.some((s) => s.view === "coding"));
  }

  /** Return every hosted SECTION's singleton DOM to the hidden #page-body pen
   *  (before any rails rebuild, and when a section panel closes). Adopt on
   *  render, park before wipe. */
  function parkSections(): void {
    // The dashboard may hold the agent's footer — it must never ride a
    // section into the hidden pen.
    (window as unknown as { __adoptComposerHome?: () => void }).__adoptComposerHome?.();
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
    if (section === "agent" || section === "code" || section === "workspace") {
      // The agent is the PERMANENT bottom composer — there is no agent panel
      // to open or dock anymore. "agent" just focuses the input; "code"/
      // "workspace" flip back to the working surface (section slots close,
      // the workspace stays — no uninvited anything).
      let changed = false;
      for (let i = rails.length - 1; i >= 0; i--) {
        const kept = rails[i].slots.filter((sl) => sl.view !== "section");
        if (kept.length !== rails[i].slots.length) { rails[i].slots = kept; changed = true; }
        if (!rails[i].slots.length) rails.splice(i, 1);
      }
      // NOTHING changed → NOTHING re-renders. Every agent panel command runs
      // this flip first; an unconditional renderRails rebuilt Echo (and every
      // panel body) per command — open two apps, keep only the last card.
      if (changed) {
        renderRails();
        saveLayout();
      }
      if (section === "agent") (document.getElementById("code-input") as HTMLTextAreaElement | null)?.focus();
      return;
    }
    // PAGES open as Echo cards — Echo is the only surface.
    void loadSection;   // the card path runs the loader itself
    openEchoSurface();
    echoCtl?.openSection(section);
  }

  function renderRails(): void {
    const container = document.getElementById("code-wb-rails");
    if (!container) return;
    parkThread();
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
    // A LONE panel fills the page as if maximized — no drop strips, no width
    // handle, edge to edge (its expand button renders toggled-on too).
    container.classList.toggle("solo-slot", soloPanel());
    paintSectionToggles();
    // Re-apportion displayed widths after every (re)render — handles slot
    // adds/closes/DnD that change the rail count and the drop-strip total.
    applyResponsiveWidths();
    // If a slot was maximized before the re-render, keep it so.
    paintFullscreenClasses();
    // Re-arm the agent overlay: a rebuild may have added a coding-seat
    // placeholder (follow it) or removed one (park the agent home).
    scheduleAgentSync();
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
      btn.classList.toggle("active", viewIsOpen(v) || !!echoCtl?.hasTool(v));
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
    const icon = slot.view === "coding" ? "" : meta.icon;
    const wrap = document.createElement("div");
    wrap.className = "ws-rail-slot";
    wrap.dataset.slotId = String(slot.id);
    wrap.dataset.view = slot.view;
    const isMax = (slot.id === maximizedSlotId) || soloPanel();
    if (slot.id === maximizedSlotId) wrap.classList.add("fullscreen");
    const urlToggle = slot.view === "app"
      ? `<button class="ws-icon-btn slot-urltoggle${(slot as AppSlot).urlBarHidden ? "" : " active"}" title="Address bar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/></svg></button>`
      : "";
    // Pop-out: web panels (http apps, the Browser) can leave the app for a
    // standalone OS window. Glyphh apps stay — their file:// entry needs the
    // in-app webview capabilities.
    const canPopout = slot.view === "preview"
      || (slot.view === "app" && !slot.glyphh && /^https?:\/\//i.test(slot.url));
    const popoutBtn = canPopout
      ? `<button class="ws-icon-btn slot-popout" title="Pop out — its own window"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></button>`
      : "";
    wrap.innerHTML = `
      <div class="ws-rail-slot-header" draggable="true" title="Drag to rearrange">
        ${icon}
        <span class="title"></span>
        ${urlToggle}
        ${popoutBtn}
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
    wrap.querySelector(".slot-popout")?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const yo = (window as unknown as { glyphh?: { panelPopout?: (r: { kind: "url"; url?: string; title?: string }) => Promise<{ ok: boolean; error?: string }> } }).glyphh;
      if (!yo?.panelPopout) return;
      const url = slot.view === "app" ? slot.url : (slot as PreviewSlot).url || "";
      if (!/^https?:\/\//i.test(url)) return;
      void yo.panelPopout({ kind: "url", url, title });
      closeSlot(slot.id);
    });
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
    // NOT on the echo launcher: its "Close panel" would close the COMMAND
    // CENTER itself, and the tiles carry their own per-tile menus.
    wrap.addEventListener("contextmenu", (ev) => {
      if ((ev.target as HTMLElement).closest(".ws-monaco-tabs")) return;
      ev.preventDefault();
      if (slot.view === "echo") return;
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
    else if (slot.view === "releases") void renderReleasesIntoSlot(body, slot);
    else if (slot.view === "tasks") void renderTasksIntoSlot(body, slot);
    else if (slot.view === "coding") renderCodingIntoSlot(body, wrap);
    else if (slot.view === "thread") renderThreadIntoSlot(body);
    else if (slot.view === "echo") {
      // The 3D command-center wall can throw on browsers the desktop shell was
      // never meant to run in (e.g. iPad Safari via the web-served "Desktop
      // site"). Contain it: ONE surface failing must not bubble through
      // renderRail → renderRails → placeView → go and blank the whole page with
      // an uncaught-error overlay. Degrade to the flat 2D card view instead.
      try {
        renderEchoIntoSlot(body, wrap);
      } catch (err) {
        console.error("echo launcher render failed", err);
        body.classList.add("ws-echo-body", "echo-nogl");
      }
    }
    else if (slot.view === "section") renderSectionIntoSlot(body, slot);
    else if (slot.view === "app") renderAppIntoSlot(body, slot);
    return wrap;
  }

  // ── Glyphh seat (view "coding") — the SAME agent, overlaid on a placeholder ──
  // The slot holds only a .ws-agent-placeholder; the live .code-agent (thread,
  // composer, everything — one runtime, shared sessions) sits in the fixed
  // overlay layer and follows it. The agent's own head carries the session
  // controls: title on the left, history dropdown + new-session on the right.
  /**
   * Echo, phase 1 — EVERYTHING, on one three.js wall.
   *
   * A WebGL curved wall of tiles: every command-center entry (all apps —
   * Glyphh, nav, installed, web — and every layout) plus every workspace
   * panel type (Files, Terminal, Editor, Diff, Browser, Plan, Coding
   * agent). Tiles are canvas-drawn cards using the SAME icon sources the
   * command center uses (appIconUrl favicons/brand/native, nav glyphs),
   * streamed in as they load. View controls: drag pans, wheel + ± zooms,
   * ⟲ resets. That's it — ordering via layouts comes later.
   */
  function renderEchoIntoSlot(body: HTMLElement, wrap: HTMLElement): void {
    try {
    body.classList.add("ws-echo-body");
    body.innerHTML = `
      <div class="echo-stage"><div class="echo-pages"></div><div class="echo-page-dots"></div></div>
      <div class="echo-topbar echo-topbar-stacked">
        <div class="echo-wall-search"><input id="echo-wall-search-input" type="text" placeholder="Search apps…" spellcheck="false" autocomplete="off" /></div>
      </div>
      <div class="echo-veil"></div>
      <div class="echo-layout-bar hidden">
        <span class="echo-layout-bar-name"></span>
        <button class="ws-icon-btn echo-layout-close" type="button" title="Close workspace — close every panel in it">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
          <span>Close workspace</span>
        </button>
        <button class="ws-icon-btn echo-layout-cc" type="button" title="Show the command center (hold ⌃⌥)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>
        </button>
        <button class="ws-icon-btn echo-layout-save hidden" type="button" title="Save this arrangement as a workspace…">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
        </button>
      </div>
      <div class="echo-cards"></div>
`;
    const stage = body.querySelector<HTMLElement>(".echo-stage")!;
    wrap.dataset.view = "echo";

    // ── FLAT LAUNCHER (his rule, 2026-08-18: "this should feel like a damn
    // iPhone") — no WebGL, no camera. Pages of dock-sized icons in a
    // scroll-snap CAROUSEL with page dots; a set number of icons per page;
    // icons drag to reorder and TRADE between the dock and the pages (never
    // deleted from here). ──
    const pagesEl = stage.querySelector<HTMLElement>(".echo-pages")!;
    const dotsEl = stage.querySelector<HTMLElement>(".echo-page-dots")!;
    // NAV BADGES (his rule, 2026-08-20): red counts on Marketplace (pending
    // review activity) and Settings (unread support replies). nav-badges.ts
    // computes + broadcasts; this paints dock slots and page tiles.
    window.addEventListener("glyphh:nav-badges", (ev) => {
      const d = (ev as CustomEvent<{ marketplace: number; settings: number }>).detail;
      if (!d) return;
      for (const [key, n] of [["marketplace", d.marketplace], ["settings", d.settings]] as const) {
        document.querySelectorAll<HTMLElement>(`.echo-dock-btn[data-dock="${key}"], .echo-app-btn[data-nav="${key}"]`)
          .forEach((el2) => {
            if (n > 0) el2.dataset.badge = String(Math.min(99, n));
            else delete el2.dataset.badge;
          });
      }
    });
    // TINY HOVER TICK (his ask, 2026-08-19): sweeping the cursor over apps on
    // the command center clicks softly. Delegated on the whole wall body so
    // page tiles AND dock slots share it; entering a button fires once
    // (relatedTarget guard), and ui-sounds.ts floors burst rate.
    body.addEventListener("mouseover", (ev) => {
      const btn = (ev.target as HTMLElement | null)?.closest?.(".echo-app-btn, .echo-dock-btn");
      if (!btn) return;
      const from = (ev as MouseEvent).relatedTarget as HTMLElement | null;
      if (from && from.closest(".echo-app-btn, .echo-dock-btn") === btn) return;
      (window as unknown as { __uiSound?: (k: "tick" | "focus") => void }).__uiSound?.("tick");
    });
    // Page ARROWS — either side of the icon lists.
    const mkArrow = (dir: -1 | 1): HTMLButtonElement => {
      const a = document.createElement("button");
      a.type = "button";
      a.className = "echo-page-arrow " + (dir < 0 ? "prev" : "next");
      a.title = dir < 0 ? "Previous page" : "Next page";
      a.innerHTML = dir < 0
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>`;
      a.addEventListener("click", () => scrollToPage(pageIndex + dir));
      stage.appendChild(a);
      return a;
    };
    const prevArrow = mkArrow(-1);
    const nextArrow = mkArrow(1);
    /** Dots ride just UNDER the icon grid; arrows center on it. */
    function positionPageChrome(): void {
      const grid = pagesEl.querySelector<HTMLElement>(".echo-page-grid");
      const pageCount = pagesEl.children.length;
      if (!grid) { dotsEl.classList.add("hidden"); prevArrow.style.display = "none"; nextArrow.style.display = "none"; return; }
      const sr = stage.getBoundingClientRect();
      // Measure the LAST ICON, not the grid box — the grid's bottom padding
      // pushed the dots halfway down the page.
      const icons = grid.querySelectorAll<HTMLElement>(".echo-app-btn");
      const lastIcon = icons.length ? icons[icons.length - 1] : null;
      const g = (lastIcon ?? grid).getBoundingClientRect();
      const stageH = stage.clientHeight || 1;
      dotsEl.style.top = `${Math.min(Math.round(g.bottom - sr.top + 10), stageH - 26)}px`;
      dotsEl.style.bottom = "auto";
      const mid = Math.max(60, Math.min(Math.round(g.top - sr.top + g.height / 2 - 17), stageH - 80));
      prevArrow.style.top = `${mid}px`;
      nextArrow.style.top = `${mid}px`;
      const many = pageCount > 1;
      prevArrow.style.display = many && pageIndex > 0 ? "" : "none";
      nextArrow.style.display = many && pageIndex < pageCount - 1 ? "" : "none";
    }
    // SHELL RESIZE → everything reflows: page chrome repositions, the open
    // panels re-lay against the fresh band (pixel rects, so nothing tracks
    // for free), the carousel re-snaps to its page, and transitions pause so
    // cards track the resize instead of rubber-banding behind it. (The old
    // 3D wall's ResizeObserver owned this and died with it.)
    let resizeAnimT = 0;
    // The RO can fire between observe() and the closure reaching layoutCards'
    // const (TDZ throw) — hold it until the wall chrome is fully defined.
    let wallChromeReady = false;
    const chromeRo = new ResizeObserver(() => {
      if (!wallChromeReady) return;
      positionPageChrome();
      cardsLayer.classList.add("echo-no-anim");
      window.clearTimeout(resizeAnimT);
      resizeAnimT = window.setTimeout(() => cardsLayer.classList.remove("echo-no-anim"), 180);
      layoutCards();
      scrollToPage(pageIndex, false);
    });
    chromeRo.observe(stage);
    /** Icons per page — the "set number" (default 8 × 7); the Appearance
     *  slider (echoIconsPerPage) overrides it, DB-persisted like the rest. */
    let perPage = 56;

        // ── Tile cards: the command center's tiles, verbatim — 56px icon
    // square (r14, --surface-3), 9px icon inset, 6px gap, 11px --text-2
    // label; layout tiles are the CC 2×2 mini-stack of the layout's own
    // app icons. Drawn at 4× and colored from the LIVE theme variables,
    // redrawn whenever the theme changes. ──
    const TILE_PX_W = 104, TILE_PX_H = 94, TILE_SCALE = 4;
    interface EchoCell { iconUrl?: string; glyphSvg?: string; initial: string; img: HTMLImageElement | null }
    interface EchoTile { name: string; slug?: string; orderKey?: string; appId?: string; houseDefault?: boolean; layoutName?: string; url?: string; glyphh?: boolean; workbench?: boolean; sticky?: boolean; iconUrl?: string; issues?: number; glyphSvg?: string; cells?: EchoCell[]; layoutRow?: LayoutRow; kind: "app" | "layout" | "tool" | "agent" | "folder"; folderId?: string; toolView?: Exclude<ViewKind, "app">; navKey?: string; navApp?: { slug: string; name: string; url?: string | null; archetype: string; execPath?: string | null } }
    interface TileEntry { tile: EchoTile; iconEl?: HTMLElement; img: HTMLImageElement | null; card?: HTMLElement; open?: boolean; toolSlot?: Slot; memKey?: string; keepTermsAlive?: boolean;
      /** Edge-driven: this card owns its column — nothing stacks under it. */
      flowSolo?: boolean;
      /** WEB: the card's streamed-panel handle. Card teardown must dispose it
       *  or the desktop keeps casting to a removed element. */
      streamed?: StreamedPanelHandle;
      /** B1/B2: the layout open that spawned this card. Every panel a layout
       *  fans out shares one id; a standalone app open has none. A card with a
       *  layoutId hides its own X (closing is via the layout bar) and is torn
       *  down as a group by closeLayoutGroup. */
      layoutId?: string }
    const entries: TileEntry[] = [];
    let echoRows: Array<{ slug?: string; id: string; name: string; url?: string | null; appArchetype?: string | null; execPath?: string | null; iconUrl?: string | null }> = [];
    // ── Flat icons: dock-sized squares + labels, plain DOM. Glyph SVGs keep
    // currentColor, so THEMES restyle them via CSS — no rasterizing. ──
    const escAttr = (v: string): string => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    const iconSig = (t: EchoTile): string => `${t.iconUrl || ""}|${(t.glyphSvg || "").length}|${(t.cells || []).length}|${t.kind === "folder" ? (folders.find((f) => f.id === t.folderId)?.keys.join(",") ?? "") : ""}`;
    const FOLDER_GLYPH = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 6a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.6.8L12 6.4h7a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/></svg>`;
    const iconInner = (t: EchoTile): string => {
      if (t.kind === "folder") {
        const cells = (t.cells || []).slice(0, 4);
        if (!cells.length) return `<span class="echo-app-fallback echo-folder-glyph">${FOLDER_GLYPH}</span>`;
        return `<span class="echo-app-mini echo-folder-mini">` + cells.map((cl) =>
          cl.glyphSvg ? `<span class="mini">${cl.glyphSvg}</span>`
            : cl.iconUrl ? `<span class="mini"><img data-icon-src="${escAttr(cl.iconUrl)}" alt="" draggable="false"/></span>`
              : `<span class="mini"><i>${escAttr(cl.initial || "?")}</i></span>`).join("") + `</span>`;
      }
      if (t.kind === "layout") {
        const cells = (t.cells || []).slice(0, 4);
        if (!cells.length) return `<span class="echo-app-fallback">▦</span>`;
        return `<span class="echo-app-mini">` + cells.map((cl) =>
          cl.glyphSvg ? `<span class="mini">${cl.glyphSvg}</span>`
            : cl.iconUrl ? `<span class="mini"><img data-icon-src="${escAttr(cl.iconUrl)}" alt="" draggable="false"/></span>`
              : `<span class="mini"><i>${escAttr(cl.initial || "?")}</i></span>`).join("") + `</span>`;
      }
      if (t.glyphSvg) return t.glyphSvg;
      if (t.iconUrl) return `<img data-icon-src="${escAttr(t.iconUrl)}" alt="" draggable="false"/><span class="echo-app-fallback" style="display:none">${escAttr((t.name || "?").charAt(0).toUpperCase())}</span>`;
      return `<span class="echo-app-fallback">${escAttr((t.name || "?").charAt(0).toUpperCase())}</span>`;
    };
    // ── Icon HYDRATION — remote favicons ride the main process on desktop
    // (webIconFetch → data: URL, exactly like the old wall textures); the web
    // loads our CORS-open resolver directly. Failures fall to the letter. ──
    const iconYo = (window as unknown as { glyphh?: { webIconFetch?: (u: string) => Promise<string> } }).glyphh;
    const iconSrcCache = new Map<string, string>();
    const hydrateIcons = (root: HTMLElement): void => {
      root.querySelectorAll<HTMLImageElement>("img[data-icon-src]").forEach((img) => {
        const src = img.dataset.iconSrc || "";
        img.removeAttribute("data-icon-src");
        img.addEventListener("error", () => {
          img.style.display = "none";
          const fb = img.nextElementSibling as HTMLElement | null;
          if (fb?.classList.contains("echo-app-fallback")) fb.style.display = "";
        }, { once: true });
        if (!src) { img.dispatchEvent(new Event("error")); return; }
        // WEB: request in CORS mode — the resolver serves ACAO `*`, and
        // Cross-Origin-Resource-Policy only blocks NO-CORS embedding, so the
        // crossorigin attribute is what lets the browser render the bytes.
        if (isWebTarget() && /^https?:/i.test(src)) img.crossOrigin = "anonymous";
        const direct = !/^https?:/i.test(src) || isWebTarget();
        if (direct) { img.src = src; return; }
        const cached = iconSrcCache.get(src);
        if (cached) { img.src = cached; return; }
        void (iconYo?.webIconFetch?.(src) ?? Promise.resolve("")).then((u) => {
          const finalSrc = u || src;   // resolver miss → try the URL directly
          iconSrcCache.set(src, finalSrc);
          if (img.isConnected) img.src = finalSrc;
        }).catch(() => { if (img.isConnected) img.src = src; });
      });
    };
    /** (Re)paint one icon — the DOM successor of the old canvas drawTile;
     *  same name so every call site still works. */
    function drawTile(e: TileEntry): void {
      const el = e.iconEl;
      if (!el) return;
      el.classList.toggle("open", !!e.open);
      const ic = el.querySelector<HTMLElement>(".echo-app-ic");
      if (ic && ic.dataset.sig !== iconSig(e.tile)) { ic.innerHTML = iconInner(e.tile); ic.dataset.sig = iconSig(e.tile); hydrateIcons(ic); }
      const nm = el.querySelector<HTMLElement>(".echo-app-name");
      if (nm && nm.textContent !== e.tile.name) nm.textContent = e.tile.name;
      // App-health badge: unresolved required connections, red count like nav.
      if (e.tile.issues) { el.dataset.badge = String(e.tile.issues); el.title = `${e.tile.name} — ${e.tile.issues} issue${e.tile.issues === 1 ? "" : "s"} to resolve`; return; }
      if (!e.tile.navKey) delete el.dataset.badge;
      el.title = e.tile.name;
    }
    /** The key an icon orders/trades under. Tools carry tool:<view>; apps and
     *  layouts their orderKey; nav slots traded out of the dock dock:<key>. */
    const keyOf = (t: EchoTile): string | null => t.orderKey ?? (t.toolView ? `tool:${t.toolView}` : null);
    const entriesByKey = (): Map<string, TileEntry> => {
      const m = new Map<string, TileEntry>();
      for (const e of entries) { const k = keyOf(e.tile); if (k) m.set(k, e); }
      return m;
    };
    /** A nav DOCK slot rendered as a PAGE icon (traded out of the dock). */
    const navTileFor = (key: string): EchoTile | null => {
      const item = DOCK_ITEMS.find((d) => d.key === key);
      if (!item) return null;
      const imgSrc = item.icon.match(/<img[^>]*src="([^"]+)"/)?.[1];
      return { name: item.title, slug: `dock:${item.key}`, orderKey: `dock:${item.key}`, glyphSvg: item.icon.match(/<svg[\s\S]*<\/svg>/)?.[0] || undefined, iconUrl: imgSrc || undefined, kind: "tool", navKey: item.key };
    };
    /** ONE ordered list backs the pages. wallBands stays as its [single] band
     *  so the catalog-refresh path needs no rewrite. */
    let wallBands: TileEntry[][] = [[]];
    /** The dock's key order (nav keys + traded page-icon keys) — authoritative
     *  membership; persisted as echoDockOrder. Null until the pref loads. */
    let dockKeys: string[] = DOCK_ITEMS.map((d) => d.key);
    let pageIndex = 0;
    const makeTileEntry = (t: EchoTile): TileEntry => {
      const e: TileEntry = { tile: t, img: null };
      entries.push(e);
      return e;
    };
    /** Take a tile off the launcher for good (a deleted app/layout). */
    const dropTileEntry = (entry: TileEntry): void => {
      const i = entries.indexOf(entry);
      if (i >= 0) entries.splice(i, 1);
      for (const band of wallBands) {
        const j = band.indexOf(entry);
        if (j >= 0) band.splice(j, 1);
      }
      renderPages();
    };
    const persistPages = (): void => {
      const keys = (wallBands[0] ?? []).map((x) => keyOf(x.tile)).filter((k): k is string => !!k);
      void yoApi?.setPreference?.("ccIconOrder", keys);
      window.dispatchEvent(new CustomEvent("glyphh:cc-order-changed", { detail: keys }));
    };
    const persistDock = (): void => { void yoApi?.setPreference?.("echoDockOrder", dockKeys); };
    // ── FOLDERS (his rule, 2026-08-20): wall groups holding app + layout
    // icons. Drag an icon onto a folder tile to file it; the folder opens a
    // paginated modal (12/page); drag an icon onto the modal's backdrop to
    // take it back out; an EMPTY folder deletes via the standard confirm. ──
    interface WallFolder { id: string; name: string; keys: string[] }
    let folders: WallFolder[] = [];
    /** Every tile the wall knows, keyed — foldered members live here even
     *  while they are off the band (the modal renders from this). */
    let wallCatalog = new Map<string, EchoTile>();
    function persistFolders(): void { void yoApi?.setPreference?.("echoFolders", folders); };
    const folderedKeys = (): Set<string> => new Set(folders.flatMap((f) => f.keys));
    const folderCells = (f: WallFolder): EchoCell[] =>
      f.keys.slice(0, 4).map((k) => {
        const t = wallCatalog.get(k);
        return {
          iconUrl: t?.iconUrl || undefined,
          glyphSvg: t?.glyphSvg || undefined,
          initial: (t?.name || "?").charAt(0).toUpperCase(),
          img: null,
        };
      });
    const folderTileOf = (f: WallFolder): EchoTile =>
      ({ name: f.name, slug: `folder:${f.id}`, orderKey: `folder:${f.id}`, kind: "folder", folderId: f.id, cells: folderCells(f) });
    /** Repaint every folder tile's mini grid + name after membership changes. */
    const refreshFolderTiles = (): void => {
      for (const e of entries) {
        if (e.tile.kind !== "folder" || !e.tile.folderId) continue;
        const f = folders.find((x) => x.id === e.tile.folderId);
        if (!f) continue;
        e.tile.cells = folderCells(f);
        e.tile.name = f.name;
        drawTile(e);
      }
    }
    function addToFolder(key: string, folderId: string): void {
      const f = folders.find((x) => x.id === folderId);
      if (!f || key.startsWith("folder:") || f.keys.includes(key)) return;
      // The filed tile leaves the band (its EchoTile stays in the catalog).
      const entry = entriesByKey().get(key);
      if (entry) {
        const t = entry.tile;
        if (keyOf(t)) wallCatalog.set(keyOf(t)!, t);
        const band = wallBands[0] ?? [];
        const i = band.indexOf(entry);
        if (i >= 0) band.splice(i, 1);
      }
      f.keys.push(key);
      persistFolders();
      renderPages();
      persistPages();
      refreshFolderTiles();
    }
    const removeFromFolder = (key: string, folderId: string): void => {
      const f = folders.find((x) => x.id === folderId);
      if (!f) return;
      const i = f.keys.indexOf(key);
      if (i < 0) return;
      f.keys.splice(i, 1);
      persistFolders();
      moveKeyToPage(key, null);   // back onto the pages (renders + persists)
      refreshFolderTiles();
    };
    const deleteFolder = (folderId: string): void => {
      const f = folders.find((x) => x.id === folderId);
      if (!f || f.keys.length) return;   // only empty folders delete
      folders = folders.filter((x) => x.id !== folderId);
      persistFolders();
      const band = wallBands[0] ?? [];
      const entry = entriesByKey().get(`folder:${folderId}`);
      if (entry) {
        const i = band.indexOf(entry);
        if (i >= 0) band.splice(i, 1);
      }
      renderPages();
      persistPages();
    };
    const createFolderWith = (e: TileEntry): void => {
      const key = keyOf(e.tile);
      if (!key || key.startsWith("folder:")) return;
      const f: WallFolder = { id: `f${Date.now().toString(36)}`, name: "Folder", keys: [] };
      folders.push(f);
      // The folder tile takes the member's spot on the band.
      const band = wallBands[0] ?? [];
      const at = band.indexOf(e);
      const entry = makeTileEntry(folderTileOf(f));
      band.splice(at < 0 ? band.length : at, 0, entry);
      persistFolders();
      addToFolder(key, f.id);   // renders + persists
    };
    // ── EDIT MODE (press-and-hold, iPhone-style): the icons wiggle, apps and
    // layouts wear a ✕ (delete after the standard confirm); everything else
    // just moves. Click empty space or Esc to leave. ──
    let iconEditMode = false;
    function setIconEdit(on: boolean): void {
      if (iconEditMode === on) return;
      iconEditMode = on;
      pagesEl.classList.toggle("echo-edit", on);
    }
    document.addEventListener("keydown", (ev) => {
      if (!body.isConnected) return;
      if (ev.key === "Escape" && iconEditMode) { ev.stopPropagation(); setIconEdit(false); }
    }, true);
    const removableTile = (t: EchoTile): boolean => (t.kind === "app" && !!t.appId && !t.navApp) || t.houseDefault === true || (t.kind === "layout" && !!t.layoutName);
    /** Delete what an icon stands for — the app or the layout — after the
     *  standard confirm, then drop it off the launcher (and the saved order). */
    function deleteTileEntry(e: TileEntry): void {
      const t = e.tile;
      if (!removableTile(t)) return;
      void (async () => {
        const ok = await appConfirm({
          title: `Delete "${t.name}"?`,
          body: t.kind === "layout"
            ? "The workspace is removed from your library."
            : t.houseDefault
              ? "The app is removed from your command center on every device."
              : "The app is removed from your library on every device.",
          confirmLabel: "Delete",
          danger: true,
        });
        if (!ok) return;
        const yo = (window as unknown as { glyphh?: { panelAppsDelete?: (id: string) => Promise<{ ok: boolean; error?: string }>; layoutsDelete?: (n: string) => Promise<boolean>; getPreference?: (k: string, d: unknown) => Promise<unknown>; setPreference?: (k: string, v: unknown) => Promise<unknown> } }).glyphh;
        try {
          if (t.houseDefault && t.slug) {
            // A HOUSE DEFAULT has no user row to delete — hiding is a per-user
            // pref of hidden slugs the launcher filters on load.
            const cur = await yo?.getPreference?.("ccHiddenDefaults", []) ?? [];
            const list = Array.isArray(cur) ? cur.map(String) : [];
            if (!list.includes(t.slug)) list.push(t.slug);
            await yo?.setPreference?.("ccHiddenDefaults", list);
          }
          else if (t.kind === "layout" && t.layoutName) await yo?.layoutsDelete?.(t.layoutName);
          else if (t.appId) {
            const res = await yo?.panelAppsDelete?.(t.appId);
            if (res && res.ok === false) { console.warn(`[echo] delete "${t.name}" failed: ${res.error || "unknown error"}`); return; }
          }
        } catch (err) {
          console.warn(`[echo] delete "${t.name}" failed:`, err);
          return;
        }
        const k = keyOf(t);
        if (k) dockKeys = dockKeys.filter((x) => x !== k);
        dropTileEntry(e);
        persistPages();
        persistDock();
      })();
    }
    // ── Drag: reorder within the pages, and TRADE between dock and pages.
    // Nothing here deletes by dropping — a drop outside any target snaps back. ──
    let dragIconKey: string | null = null;
    /** The keys riding a group drag (a L→R selection dragged by any member). */
    let dragGroupKeys: string[] | null = null;
    function wireIconDrag(el: HTMLElement, key: string | null): void {
      if (!key) return;   // the fixed Home tile never moves
      el.draggable = true;
      el.addEventListener("dragstart", (ev) => {
        // ⇧/⌃/⌘ presses belong to multi-select, never a move.
        if (ev.shiftKey || ev.ctrlKey || ev.metaKey) { ev.preventDefault(); return; }
        dragIconKey = key;
        // Dragging a SELECTED icon moves the whole selection (folder filing).
        const selKeys = [...multiSel].map((x) => keyOf(x.tile)).filter((k): k is string => !!k);
        dragGroupKeys = selKeys.includes(key) && selKeys.length > 1 ? selKeys : null;
        applyDockZoomAt(null);
        el.classList.add("dock-dragging");
        ev.dataTransfer?.setData("text/plain", key);
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
      });
      el.addEventListener("dragend", () => { el.classList.remove("dock-dragging"); dragIconKey = null; dragGroupKeys = null; });
    }
    /** Land a dragged key ON THE PAGES at (optionally) a target entry. */
    function moveKeyToPage(key: string, at: TileEntry | null): void {
      const band = wallBands[0]!;
      let entry = entriesByKey().get(key) ?? null;
      if (!entry) {
        // A key coming OUT OF A FOLDER has no band entry — its tile waited in
        // the catalog; nav keys materialize as before.
        const t = wallCatalog.get(key) ?? navTileFor(key) ?? navTileFor(key.replace(/^dock:/, ""));
        if (!t) return;
        const existing = entriesByKey().get(keyOf(t) || "");
        entry = existing ?? makeTileEntry(t);
      }
      const k = keyOf(entry.tile);
      dockKeys = dockKeys.filter((x) => x !== key && x !== k);
      const cur = band.indexOf(entry);
      if (cur >= 0) band.splice(cur, 1);
      const idx = at ? band.indexOf(at) : -1;
      band.splice(idx < 0 ? band.length : idx, 0, entry);
      renderPages();
      persistPages();
      persistDock();
    }
    /** Land a dragged key IN THE DOCK before (optionally) a target key. */
    const moveKeyToDock = (key: string, beforeKey: string | null): void => {
      const navKey = key.startsWith("dock:") ? key.slice(5) : key;
      const dockKey = DOCK_ITEMS.some((d) => d.key === navKey) ? navKey : key;
      dockKeys = dockKeys.filter((x) => x !== dockKey);
      const at = beforeKey ? dockKeys.indexOf(beforeKey) : -1;
      dockKeys.splice(at < 0 ? dockKeys.length : at, 0, dockKey);
      // a page icon entering the dock leaves the pages
      const band = wallBands[0] ?? [];
      const entry = entriesByKey().get(key);
      if (entry) {
        const i = band.indexOf(entry);
        if (i >= 0) band.splice(i, 1);
      }
      renderPages();
      persistPages();
      persistDock();
    };
    /** Sync the DOCK DOM to dockKeys: nav buttons reorder/hide, traded page
     *  icons render as dock slots. Click routing is delegated (topbar). */
    function reconcileDock(): void {
      const dockEl = body.querySelector<HTMLElement>(".echo-dock");
      if (!dockEl) return;
      const byKey = entriesByKey();
      const have = new Map<string, HTMLElement>();
      for (const c of Array.from(dockEl.children) as HTMLElement[]) {
        const k = c.dataset.dock;
        if (k) have.set(k, c);
      }
      for (const [k, el] of have) if (!dockKeys.includes(k)) el.remove();
      let prev: HTMLElement | null = null;
      for (const k of dockKeys) {
        let el = have.get(k) ?? null;
        if (!el) {
          const item = DOCK_ITEMS.find((d) => d.key === k);
          const entry = item ? null : byKey.get(k);
          if (!item && !entry) continue;
          const mk = document.createElement("button");
          mk.type = "button";
          el = mk;
          el.className = "echo-dock-btn";
          el.dataset.dock = k;
          el.title = item ? item.title : entry!.tile.name;
          el.innerHTML = item ? item.icon : iconInner(entry!.tile);
          hydrateIcons(el);
          wireIconDrag(el, k);
          el.addEventListener("contextmenu", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            if (entry) { showTileMenu(ev, tileMenuItems(entry)); return; }
            // Fixed nav slots (the workpanel defaults): close items only, and
            // only while the panel they route to is actually open.
            const items: Array<{ label: string; onPick: () => void; danger?: boolean }> = [];
            const target = openEntryForNav(k);
            if (target) {
              items.push({ label: "Close panel", onPick: () => closeCard(target) });
              if (openList.some((x) => x.card)) items.push({ label: "Close all panels", onPick: () => { for (const x of [...openList]) closeCard(x); } });
            }
            showTileMenu(ev, items);
          });
          el.addEventListener("dragover", (ev) => { if (dragIconKey && dragIconKey !== k) ev.preventDefault(); });
          el.addEventListener("drop", (ev) => {
            ev.preventDefault(); ev.stopPropagation();
            if (dragIconKey && dragIconKey !== k) moveKeyToDock(dragIconKey, k);
          });
        }
        if (prev) prev.after(el);
        else dockEl.prepend(el);
        prev = el;
      }
    }
    // ── Per-tile context menu (his rule, 2026-08-19): apps get Edit; work-
    // spaces get Edit + Delete; the close items appear ONLY when that tile's
    // panel is actually open — a closed tile never offers "Close panel". ──
    function showTileMenu(ev: MouseEvent, items: Array<{ label: string; onPick: () => void; danger?: boolean }>): void {
      if (!items.length) return;
      document.querySelector(".ws-tab-ctx-menu")?.remove();
      const menu = document.createElement("div");
      menu.className = "ws-tab-ctx-menu";
      const dismiss = (): void => {
        menu.remove();
        document.removeEventListener("mousedown", onAway, true);
        document.removeEventListener("keydown", onEsc, true);
      };
      const onAway = (me: MouseEvent): void => { if (!menu.contains(me.target as Node)) dismiss(); };
      const onEsc = (ke: KeyboardEvent): void => { if (ke.key === "Escape") dismiss(); };
      for (const it of items) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ws-tab-ctx-item" + (it.danger ? " danger" : "");
        btn.textContent = it.label;
        btn.addEventListener("click", () => { dismiss(); it.onPick(); });
        menu.appendChild(btn);
      }
      menu.style.left = `${ev.clientX}px`;
      menu.style.top = `${ev.clientY}px`;
      document.body.appendChild(menu);
      const mr = menu.getBoundingClientRect();
      if (mr.right > window.innerWidth - 8) menu.style.left = `${window.innerWidth - mr.width - 8}px`;
      if (mr.bottom > window.innerHeight - 8) menu.style.top = `${window.innerHeight - mr.height - 8}px`;
      document.addEventListener("mousedown", onAway, true);
      document.addEventListener("keydown", onEsc, true);
    }
    /** The open panel a NAV key routes to, when it is open: section cards land
     *  as `page:<key>` pseudo-tiles, tasks/preview as tool cards. */
    const openEntryForNav = (key: string): TileEntry | undefined =>
      openList.find((x) => x.card && (x.tile.slug === `page:${key}` || (x.tile.kind === "tool" && x.tile.toolView === key)));
    const tileMenuItems = (e: TileEntry): Array<{ label: string; onPick: () => void; danger?: boolean }> => {
      const t = e.tile;
      const items: Array<{ label: string; onPick: () => void; danger?: boolean }> = [];
      if (t.kind === "folder" && t.folderId) {
        const f = folders.find((x) => x.id === t.folderId);
        items.push({ label: "Open folder", onPick: () => openFolderModal(t.folderId!) });
        if (f && !f.keys.length) {
          items.push({ label: "Delete folder", danger: true, onPick: () => {
            void (window as unknown as { __appConfirm?: (o: { title: string; body?: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean> })
              .__appConfirm?.({ title: `Delete "${f.name}"?`, body: "The folder is empty — nothing else is removed.", confirmLabel: "Delete", danger: true })
              .then((ok) => { if (ok) deleteFolder(t.folderId!); });
          } });
        }
        return items;
      }
      if (keyOf(t) && !t.sticky && t.kind !== "agent") {
        items.push({ label: "Move to new folder", onPick: () => createFolderWith(e) });
      }
      const w = window as unknown as { __glyphhEditApp?: (id: string) => void; __glyphhEditLayout?: (n: string) => void };
      if (t.kind === "app" && t.appId && !t.navApp && !t.navKey) {
        items.push({ label: "Edit", onPick: () => w.__glyphhEditApp?.(t.appId!) });
      }
      if (t.kind === "layout" && t.layoutName) {
        items.push({ label: "Edit", onPick: () => w.__glyphhEditLayout?.(t.layoutName!) });
        items.push({ label: "Delete", onPick: () => deleteTileEntry(e), danger: true });
      }
      if (t.houseDefault) {
        items.push({ label: "Delete", onPick: () => deleteTileEntry(e), danger: true });
      }
      // Open-state close items. A layout tile is "open" when ITS workspace is
      // the live one; nav tiles resolve to the section/tool card they opened.
      const layoutOpen = t.kind === "layout" && !!t.layoutName && echoLayoutName === t.layoutName && openList.some((x) => x.layoutId != null);
      const target = e.card ? e : (t.navKey ? openEntryForNav(t.navKey) : undefined);
      if (layoutOpen) {
        items.push({ label: "Close workspace", onPick: () => closeLayoutGroup() });
      } else if (target) {
        items.push({ label: "Close panel", onPick: () => closeCard(target) });
      }
      if ((layoutOpen || target) && openList.some((x) => x.card)) {
        items.push({ label: "Close all panels", onPick: () => { for (const x of [...openList]) closeCard(x); } });
      }
      return items;
    };
    // The wall search (replaced the dock, 2026-08-22): filters app tiles live.
    let wallSearch = "";
    {
      const inp = body.querySelector<HTMLInputElement>("#echo-wall-search-input");
      inp?.addEventListener("input", () => { wallSearch = inp.value.trim().toLowerCase(); renderPages(); });
    }
    // ── The pages: chunk the list, render icon grids, dots, snap scroll. ──
    function renderPages(): void {
      let list = (wallBands[0] ?? []).filter((e) => { const k = keyOf(e.tile); return !k || !dockKeys.includes(k); });
      if (wallSearch) list = list.filter((e) => (e.tile.name || "").toLowerCase().includes(wallSearch));
      const pages: TileEntry[][] = [];
      for (let i = 0; i < list.length; i += perPage) pages.push(list.slice(i, i + perPage));
      if (!pages.length) pages.push([]);
      pagesEl.innerHTML = "";
      pages.forEach((page) => {
        const p = document.createElement("div");
        p.className = "echo-page";
        const grid = document.createElement("div");
        grid.className = "echo-page-grid";
        p.appendChild(grid);
        for (const e of page) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "echo-app-btn" + (removableTile(e.tile) ? " removable" : "");
          if (e.tile.navKey) btn.dataset.nav = e.tile.navKey;
          btn.innerHTML = `<span class="echo-app-ic"></span><span class="echo-app-name"></span>`;
          if (removableTile(e.tile)) {
            const del = document.createElement("button");
            del.type = "button";
            del.className = "echo-app-del";
            del.title = `Delete ${e.tile.name}`;
            del.textContent = "✕";
            del.addEventListener("click", (ev) => { ev.stopPropagation(); deleteTileEntry(e); });
            btn.appendChild(del);
          }
          e.iconEl = btn;
          drawTile(e);
          btn.addEventListener("contextmenu", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            showTileMenu(ev, tileMenuItems(e));
          });
          // press-and-hold arms EDIT MODE (the wiggle); a normal click opens.
          let holdTimer = 0;
          btn.addEventListener("pointerdown", (ev) => {
            if (ev.button !== 0 || ev.shiftKey || ev.ctrlKey || ev.metaKey) return;
            window.clearTimeout(holdTimer);
            holdTimer = window.setTimeout(() => setIconEdit(true), 520);
          });
          for (const evName of ["pointerup", "pointerleave", "pointercancel", "dragstart"] as const) {
            btn.addEventListener(evName, () => window.clearTimeout(holdTimer));
          }
          btn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            if (suppressNextIconClick) return;   // a band-select just launched
            if (ev.ctrlKey || ev.metaKey) { toggleSel(e); return; }
            if (iconEditMode) return;   // edit mode: clicks arrange, never open
            let entry = e;
            // Terminal and Browser are MULTI-INSTANCE: every click mints a new
            // card (a fresh entry keyed off the same icon, so the zoom still
            // starts from it).
            if (entry.tile.toolView === "terminal" || entry.tile.toolView === "preview") {
              entry = { tile: { ...entry.tile }, iconEl: entry.iconEl, img: null };
            }
            activateTile(entry);
          });
          wireIconDrag(btn, e.tile.sticky ? null : keyOf(e.tile));
          btn.addEventListener("dragover", (ev) => { if (dragIconKey) ev.preventDefault(); });
          btn.addEventListener("drop", (ev) => {
            ev.preventDefault(); ev.stopPropagation();
            if (!dragIconKey || dragIconKey === keyOf(e.tile)) return;
            // Dropping ON a folder files the icon inside it (folders never
            // nest); every other target is a reorder, exactly as before.
            if (e.tile.kind === "folder" && e.tile.folderId && !dragIconKey.startsWith("folder:")) {
              const group = dragGroupKeys ?? [dragIconKey];
              for (const k of group) if (!k.startsWith("folder:")) addToFolder(k, e.tile.folderId!);
              clearSel();
              return;
            }
            moveKeyToPage(dragIconKey, e);
          });
          grid.appendChild(btn);
        }
        p.addEventListener("dragover", (ev) => { if (dragIconKey) ev.preventDefault(); });
        p.addEventListener("drop", (ev) => {
          ev.preventDefault();
          if (dragIconKey) moveKeyToPage(dragIconKey, null);
        });
        p.addEventListener("click", (ev) => {
          if (iconEditMode && ev.target === p) setIconEdit(false);
        });
        pagesEl.appendChild(p);
      });
      if (!list.length) {
        const empty = document.createElement("div");
        empty.className = "echo-wall-empty";
        empty.textContent = wallSearch
          ? "No apps match your search."
          : "No apps yet — describe one to Claude over MCP, or install from the Marketplace.";
        pagesEl.querySelector(".echo-page")?.appendChild(empty);
      }
      dotsEl.innerHTML = "";
      pages.forEach((_pg, i) => {
        const d = document.createElement("button");
        d.type = "button";
        d.className = "echo-page-dot" + (i === pageIndex ? " active" : "");
        d.title = `Page ${i + 1}`;
        d.addEventListener("click", () => scrollToPage(i));
        dotsEl.appendChild(d);
      });
      dotsEl.classList.toggle("hidden", pages.length < 2);
      // Re-arm the observer on the fresh grid: an ICON-SIZE change resizes
      // the grid, not the stage — without this the chrome never re-measured
      // ("after resizing the icons the page is not responsive").
      chromeRo.disconnect();
      chromeRo.observe(stage);
      const firstGrid = pagesEl.querySelector<HTMLElement>(".echo-page-grid");
      if (firstGrid) chromeRo.observe(firstGrid);
      requestAnimationFrame(() => { scrollToPage(Math.min(pageIndex, pages.length - 1), false); positionPageChrome(); });
      reconcileDock();
    }
    function scrollToPage(i: number, smooth = true): void {
      pageIndex = Math.max(0, Math.min(i, Math.max(0, pagesEl.children.length - 1)));
      pagesEl.scrollTo({ left: pagesEl.clientWidth * pageIndex, behavior: smooth ? "smooth" : "auto" });
      Array.from(dotsEl.children).forEach((d, j) => (d as HTMLElement).classList.toggle("active", j === pageIndex));
      positionPageChrome();
    }
    pagesEl.addEventListener("scroll", () => {
      const i = Math.round(pagesEl.scrollLeft / Math.max(1, pagesEl.clientWidth));
      if (i !== pageIndex) {
        pageIndex = i;
        Array.from(dotsEl.children).forEach((d, j) => (d as HTMLElement).classList.toggle("active", j === pageIndex));
        positionPageChrome();
      }
    });
    /** All positionWall callers re-render the pages now. */
    const positionWall = (): void => renderPages();
    // ── MULTI-SELECT LAUNCH (his rule, 2026-08-18): ⌃/⌘-click accumulates a
    // selection (opens when the modifier lifts); dragging empty page space
    // rubber-bands a SQUARE; ⇧-drag draws a LINE that selects every icon it
    // touches. Everything selected opens together on release. Layouts and
    // the Home tile are excluded (a layout open resets the surface). ──
    const multiSel = new Set<TileEntry>();
    let suppressNextIconClick = false;
    const selectable = (e: TileEntry): boolean =>
      !!e.iconEl?.isConnected && e.tile.kind !== "layout" && e.tile.slug !== "glyphh-home";
    const paintSel = (): void => {
      for (const e of entries) e.iconEl?.classList.toggle("selected", multiSel.has(e));
    };
    function clearSel(): void { multiSel.clear(); paintSel(); };
    const openSelected = (): void => {
      const picks = [...multiSel].filter(selectable);
      clearSel();
      for (const e of picks) {
        let entry = e;
        if (entry.tile.toolView === "terminal" || entry.tile.toolView === "preview") {
          entry = { tile: { ...entry.tile }, iconEl: entry.iconEl, img: null };
        }
        activateTile(entry);
      }
    }
    function toggleSel(e: TileEntry): void {
      if (!selectable(e)) return;
      if (multiSel.has(e)) multiSel.delete(e); else multiSel.add(e);
      paintSel();
    }
    // Modifier lifted with a selection → launch it.
    const onSelKeyUp = (ev: KeyboardEvent): void => {
      if (!body.isConnected) { document.removeEventListener("keyup", onSelKeyUp); return; }
      if ((ev.key === "Control" || ev.key === "Meta") && multiSel.size) openSelected();
    };
    document.addEventListener("keyup", onSelKeyUp);
    /** Segment ∩ rect via sampling — cheap and plenty for icon-sized boxes. */
    const segHitsRect = (x1: number, y1: number, x2: number, y2: number, r: DOMRect): boolean => {
      const steps = Math.max(2, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 6));
      for (let i = 0; i <= steps; i++) {
        const x = x1 + ((x2 - x1) * i) / steps, y = y1 + ((y2 - y1) * i) / steps;
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
      }
      return false;
    };
    let bandEl: HTMLDivElement | null = null;
    pagesEl.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 || iconEditMode) return;
      const onIcon = !!(ev.target as HTMLElement).closest(".echo-app-btn");
      const lineMode = ev.shiftKey;
      if (onIcon && !lineMode) return;   // plain icon press — click/drag as before
      const sr = stage.getBoundingClientRect();
      const sx = ev.clientX, sy = ev.clientY;
      let live = false;
      const iconRects = entries.filter(selectable).map((e) => ({ e, r: e.iconEl!.getBoundingClientRect() }));
      let lastX = sx;
      const move = (mv: PointerEvent): void => {
        lastX = mv.clientX;
        if (!live && Math.hypot(mv.clientX - sx, mv.clientY - sy) < 6) return;
        if (!live) {
          live = true;
          bandEl = document.createElement("div");
          bandEl.className = lineMode ? "echo-lasso-line" : "echo-marquee";
          stage.appendChild(bandEl);
        }
        multiSel.clear();
        if (lineMode) {
          const dx = mv.clientX - sx, dy = mv.clientY - sy;
          bandEl!.style.left = `${sx - sr.left}px`;
          bandEl!.style.top = `${sy - sr.top}px`;
          bandEl!.style.width = `${Math.hypot(dx, dy)}px`;
          bandEl!.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
          for (const { e, r } of iconRects) if (segHitsRect(sx, sy, mv.clientX, mv.clientY, r)) multiSel.add(e);
        } else {
          const L = Math.min(sx, mv.clientX), T = Math.min(sy, mv.clientY);
          const W = Math.abs(mv.clientX - sx), H = Math.abs(mv.clientY - sy);
          bandEl!.style.left = `${L - sr.left}px`;
          bandEl!.style.top = `${T - sr.top}px`;
          bandEl!.style.width = `${W}px`;
          bandEl!.style.height = `${H}px`;
          for (const { e, r } of iconRects) {
            if (!(r.right < L || r.left > L + W || r.bottom < T || r.top > T + H)) multiSel.add(e);
          }
        }
        paintSel();
      };
      const up = (): void => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        bandEl?.remove();
        bandEl = null;
        if (live) {
          suppressNextIconClick = true;
          setTimeout(() => { suppressNextIconClick = false; }, 0);
          if (!multiSel.size) { clearSel(); return; }
          // DIRECTION IS THE VERB (his rule, 2026-08-20): sweeping RIGHT→LEFT
          // opens the selection (the original gesture); LEFT→RIGHT only
          // SELECTS — the group stays highlighted so it can be dragged into
          // a folder in one move. Click empty space (or Esc) to clear.
          if (lastX < sx) openSelected();
          else paintSel();
        }
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    });
    // An empty-space click (no band) drops a lingering selection.
    pagesEl.addEventListener("click", (ev) => {
      if (!(ev.target as HTMLElement).closest(".echo-app-btn") && multiSel.size && !suppressNextIconClick) clearSel();
    });
        const layoutTileOf = (layoutRow: LayoutRow): EchoTile => {
      const seenIds = new Set<string>();
      const ids = (layoutRow.splits ?? [])
        .map((cell) => cell.panelId)
        .filter((id) => id && !seenIds.has(id) && (seenIds.add(id), true))
        .slice(0, 4);
      const cells: EchoCell[] = ids.map((id) => {
        const key = id.trim().toLowerCase();
        const app = echoRows.find((a) => a.id.toLowerCase() === key || (a.slug || "").toLowerCase() === key);
        if (app) {
          const icon = { slug: app.slug || app.id, url: app.url || null, execPath: app.execPath || null, appArchetype: app.appArchetype || null, connection: null, iconUrl: app.iconUrl || null };
          if (app.appArchetype === "glyphh-nav") {
            return { glyphSvg: appIconInner(icon, app.name, "x").match(/<svg[\s\S]*<\/svg>/)?.[0] || undefined, initial: (app.name || "?").charAt(0).toUpperCase(), img: null };
          }
          return { iconUrl: appIconUrl(icon) || undefined, initial: (app.name || "?").charAt(0).toUpperCase(), img: null };
        }
        const toolView = id.startsWith("tool:") ? id.slice(5) : "";
        const label = toolView ? (VIEW_META[toolView as ViewKind]?.title ?? toolView) : id;
        return { initial: (label || "?").charAt(0).toUpperCase(), img: null };
      });
      return {
        name: layoutRow.name,
        slug: `layout:${(layoutRow.name || "").toLowerCase()}`,
        layoutName: layoutRow.name,
        cells, layoutRow, kind: "layout",
      };
    };
    /** The wall tile for an APP row — shared by the first build and by apps
     *  that appear later (glyphh:apps-changed), so a Glyphh app the user
     *  creates mid-session joins the wall like a new layout does. */
    const appTileOf = (a: { slug?: string; id: string; name: string; url?: string | null; appArchetype?: string | null; execPath?: string | null; launchConfig?: Record<string, unknown> | null; connection?: { accountId?: string; pipedreamSlug: string } | null; iconUrl?: string | null; requiredConnections?: { connected: boolean }[]; owned?: boolean }): EchoTile => {
      const slug = (a.slug || a.id).toLowerCase();
      const icon = { slug: a.slug || a.id, url: a.url || null, execPath: a.execPath || null, appArchetype: a.appArchetype || null, connection: a.connection || null, iconUrl: a.iconUrl || null };
      // Unconnected required connections = ISSUES: the tile wears the same red
      // count badge the nav icons use, one per connection to resolve.
      const issues = (a.requiredConnections || []).filter((c) => !c.connected).length;
      return {
        name: a.name, slug, appId: a.id, url: a.url || undefined,
        // No id = a HOUSE DEFAULT (the glyphh launcher set, not a user row).
        houseDefault: !a.id || undefined,
        glyphh: a.appArchetype === "glyphh-app" || undefined,
        // A WORKBENCH app is a chromeless panel — no address bar, ever. An app
        // INSTALLED from the marketplace is one too (his rule, 2026-08-20):
        // the installer gets a panel, never the hosted URL in their face.
        workbench: (a.launchConfig as { workbench?: unknown } | null | undefined)?.workbench === true
          || (a.appArchetype === "glyphh-app" && a.owned === false) || undefined,
        iconUrl: appIconUrl(icon) || undefined, kind: "app",
        issues: issues || undefined,
        orderKey: `app:${slug}`,
      };
    };
    /** APPS ONLY — the wall's app filter (no self row, no nav page tiles; a
     *  glyphh app rides its archetype: it has no url until deployed). */
    const wallAppRow = (a: { url?: string | null; appArchetype?: string | null }): boolean =>
      // WORKPANEL APPS ONLY (his rule, 2026-08-21): installed/built Glyphh
      // apps. URL rows and house-default web tiles are gone — the Browser
      // tool is the one road to the web.
      a.appArchetype === "glyphh-app";
    const buildWall = (bands: EchoTile[][]): void => {
      wallBands = [bands.flat().map((t) => makeTileEntry(t))];
      renderPages();
    };

    // ── The wall's content: the command center's APPS, in its order —
    // dock first (same 10, backfilled defaults), then the saved grid
    // order, new items after — then the panel types. No Glyphh tile (the
    // agent is a workspace panel) and no layout tiles. ──
    type PanelRowLite = { slug?: string; id: string; name: string; url?: string | null; appArchetype?: string | null; execPath?: string | null; connection?: { accountId?: string; pipedreamSlug: string } | null; iconUrl?: string | null; requiredConnections?: { slug: string; actAs: string; connected: boolean }[]; owned?: boolean };
    type Yo = {
      panelAppsList?: () => Promise<PanelRowLite[]>;
      appsDefaults?: () => Promise<Array<{ id: string; slug: string; name: string; url: string | null }>>;
      layoutsList?: () => Promise<LayoutRow[]>;
      getPreference?: (k: string, d: unknown) => Promise<unknown>;
      setPreference?: (k: string, v: unknown) => Promise<unknown>;
    };
    const yoApi = (window as unknown as { glyphh?: Yo }).glyphh;
    void Promise.all([
      yoApi?.panelAppsList?.() ?? [],
      yoApi?.layoutsList?.().catch(() => []) ?? [],
      yoApi?.getPreference?.("ccIconOrder", []) ?? [],
      // Read the saved wall state HERE, atomically at boot, before the agent
      // card or anything else can schedule a save that overwrites it.
      yoApi?.getPreference?.(WALL_STATE_PREF, null) ?? null,
      yoApi?.getPreference?.("echoDockOrder", null) ?? null,
      Promise.resolve([]),
      yoApi?.getPreference?.("ccHiddenDefaults", []) ?? [],
      yoApi?.getPreference?.("echoFolders", []) ?? [],
    ]).then(([rows, layouts, orderPref, savedWall, dockPref, houseDefaults, hiddenPref, folderPref]) => {
      if (!body.isConnected) return;
      // APPS ONLY — no glyphh-nav page tiles: the left rail owns navigation.
      // The HOUSE DEFAULTS (the glyphh launcher set) join the org's own rows —
      // per-user copies are retired, so the launcher reads the canonical set.
      // A user row WINS its slug; defaults carry NO appId (id: "") so their
      // tiles are never deletable/editable, and the slug-based keys keep the
      // saved icon order working across the copy→global transition.
      const userRows = (rows || []).filter(wallAppRow);
      void houseDefaults; void hiddenPref; // defaults retired with URL apps
      const appsAll = [...userRows];
      echoRows = (rows || []);
      appsAll.sort((x, y) => (y.appArchetype === "glyphh-app" ? 1 : 0) - (x.appArchetype === "glyphh-app" ? 1 : 0));
      interface Entry { key: string; name: string; app?: PanelRowLite; layout?: LayoutRow }
      const all: Entry[] = [
        ...appsAll.map((a): Entry => ({ key: `app:${(a.slug || a.id).toLowerCase()}`, name: a.name, app: a })),
        // Layout tiles retired (LAUNCH PAD cut 2026-08-22): a layout was an
        // app pretending — real apps fill the wall now.
      ];
      void layouts; void layoutTileOf;
      const byKey = new Map(all.map((e) => [e.key, e]));
      const orderKeys = Array.isArray(orderPref) ? orderPref.map(String) : [];
      const inOrder = orderKeys.map((k) => byKey.get(k)).filter((e): e is Entry => !!e);
      const seen = new Set(inOrder.map((e) => e.key));
      const ordered = [...inOrder, ...all.filter((e) => !seen.has(e.key))];
      const toTile = (e: Entry): EchoTile => (e.layout ? layoutTileOf(e.layout) : appTileOf(e.app!));
      // ONE band: Browser, then the apps, then the layouts — nothing else.
      // Navigation pages and workspace tools live in the LEFT RAIL now.
      const browserTile: EchoTile = {
        name: VIEW_META.preview.title,
        slug: "preview",
        glyphSvg: VIEW_META.preview.icon.match(/<svg[\s\S]*<\/svg>/)?.[0] || undefined,
        kind: "tool",
        toolView: "preview",
      };
      const keyed = (e: Entry): EchoTile => ({ ...toTile(e), orderKey: e.key });
      // (The mascot HOME tile is gone from the pages — the DOCK leads with
      // the glyphh mark now; two marks was one too many.)
      // The DEV workbench tools (his rule, 2026-08-21, REVERSING 08-20): Files/
      // Terminal/Editor/Diff/Plan/Releases are OFF the wall — they live in the
      // agent composer's ⋯ developer-tools menu (help/code.ts), a development
      // surface, not the launcher. Browser stays a DOCK slot.
      void browserTile;   // Browser is a DOCK nav slot — never doubled on the pages (2026-08-20)
      // The creative-suite work-panel tiles (Slides/Docs/Sheets/Drive/Design/
      // Memory/Image/Video/Sounds/Band) are retired — the wall seeds APP
      // tiles only.
      const canonical = [...ordered.filter((x) => !x.layout).map(keyed)];
      // The dock pref decides membership (nav slots + traded icons)…
      if (Array.isArray(dockPref)) dockKeys = dockPref.map(String);
      // …and NEW nav slots shipped after the pref was saved still join it
      // (unless the user traded them onto the pages): glyphh leads, the rest
      // append.
      {
        const savedPage = Array.isArray(orderPref) ? orderPref.map(String) : [];
        for (const d of DOCK_ITEMS) {
          if (dockKeys.includes(d.key) || savedPage.includes(`dock:${d.key}`)) continue;
          dockKeys.push(d.key);
        }
        // A saved dock pref may still name retired slots (glyphh/new-session,
        // layouts, browser — LAUNCH PAD cut 2026-08-22): drop them.
        dockKeys = dockKeys.filter((k) => DOCK_ITEMS.some((d) => d.key === k));
      }
      // …and ccIconOrder decides the PAGE order across every keyed tile,
      // materializing nav slots that were traded onto the pages (dock:*).
      const byK = new Map<string, EchoTile>();
      for (const t of canonical) { const k = t.orderKey; if (k) byK.set(k, t); }
      // FOLDERS: adopt the saved set, catalog EVERY keyed tile (foldered
      // members render from the catalog, not the band), add folder tiles to
      // the orderable pool, and keep filed members off the pages.
      folders = (Array.isArray(folderPref) ? folderPref : [])
        .filter((f): f is WallFolder => !!f && typeof f === "object" && typeof (f as WallFolder).id === "string")
        .map((f) => ({ id: String(f.id), name: String(f.name || "Folder"), keys: Array.isArray(f.keys) ? f.keys.map(String) : [] }));
      wallCatalog = new Map(byK);
      const filed = folderedKeys();
      for (const f of folders) byK.set(`folder:${f.id}`, folderTileOf(f));
      const savedPageOrder = Array.isArray(orderPref) ? orderPref.map(String) : [];
      const pageTiles: EchoTile[] = [];
      const seenK = new Set<string>();
      for (const k of savedPageOrder) {
        if (filed.has(k)) continue;   // lives inside a folder, not on the pages
        const t = byK.get(k) ?? (k.startsWith("dock:") ? navTileFor(k.slice(5)) : null);
        if (!t || !t.orderKey || seenK.has(t.orderKey)) continue;
        seenK.add(t.orderKey);
        pageTiles.push(t);
      }
      const rest = [...byK.values()].filter((t) => t.orderKey && !seenK.has(t.orderKey) && !filed.has(t.orderKey))
        .concat(canonical.filter((t) => !t.orderKey));
      // With the dock gone the wall carries two STICKY nav tiles: Marketplace
      // (both targets — install is a first-class wall action) and, DESKTOP
      // ONLY, Settings (web reaches it via the rail + ← Platform).
      const isWebTarget = !!(window as unknown as { __GLYPHH_WEB__?: boolean }).__GLYPHH_WEB__;
      const navTiles = [navTileFor("marketplace"), isWebTarget ? null : navTileFor("settings")]
        .filter((t): t is EchoTile => !!t)
        .map((t) => ({ ...t, sticky: true }));
      buildWall([[...pageTiles, ...rest, ...navTiles]]);
      // echoCtl + entries + layouts are all ready now — reopen last session's wall.
      restoreWallOnce(layouts || [], savedWall as WallState | null);
    }).catch(() => buildWall([[]]));

    // ── Wall-state persistence (save + restore) ──────────────────────────────
    // Serialize the OPEN arrangement: a layout by name, else the ad-hoc app/tool/
    // section cards. The AGENT (and the fixed + front-door tile) are excluded —
    // the boot path owns the agent; replaying it would double-open it.
    let wallSaveTimer: ReturnType<typeof setTimeout> | null = null;
    function serializeWall(): WallState {
      if (echoLayoutName) return { layout: echoLayoutName, cards: [] };
      const cards: WallCard[] = [];
      for (const e of openList) {
        const t = e.tile;
        if (t.kind === "agent" || t.slug === "glyphh-home") continue;
        if (t.slug && t.slug.startsWith("page:")) cards.push({ kind: "section", section: t.slug.slice(5) });
        else if (t.kind === "tool" && t.toolView) cards.push({ kind: "tool", toolView: t.toolView });
        else if (t.kind === "app" && t.slug) cards.push({ kind: "app", slug: t.slug, url: t.url, name: t.name });
      }
      return { layout: null, cards };
    }
    function scheduleWallSave(): void {
      // Gate: never write until the boot restore has run, or the agent card
      // opening at boot would serialize an EMPTY wall and clobber the real state.
      if (!wallRestored) return;
      if (wallSaveTimer) clearTimeout(wallSaveTimer);
      wallSaveTimer = setTimeout(() => {
        wallSaveTimer = null;
        try { void yoApi?.setPreference?.(WALL_STATE_PREF, serializeWall()); } catch { /* pref unavailable */ }
      }, 400);
    }
    function restoreWallOnce(layouts: LayoutRow[], saved: WallState | null): void {
      if (wallRestored) return;
      wallRestored = true;   // arm saves + block a second restore on remount
      // BOOT RELOADS THE DB STATE (his rule, 2026-08-19, reversing 08-18's
      // bare-boot): the wall comes back exactly as it was left — the open
      // layout by name, else the ad-hoc cards. The agent is NOT part of this
      // replay: the composer restores its own session (or sits waiting fresh).
      try {
        if (!saved || !echoCtl) return;
        if (saved.layout) {
          const key = saved.layout.toLowerCase();
          const layout = layouts.find((l) => (l.name || "").toLowerCase() === key);
          if (layout) echoCtl.openLayout(layout);
          return;
        }
        for (const c of saved.cards || []) {
          if (c.kind === "section" && c.section) echoCtl.openSection(c.section);
          else if (c.kind === "tool" && c.toolView) echoCtl.openTool(c.toolView as Parameters<EchoCtlType["openTool"]>[0]);
          else if (c.kind === "app" && c.slug) echoCtl.openApp({ slug: c.slug, name: c.name || c.slug, url: c.url || "" });
        }
      } catch { /* corrupt/unavailable state — ignore */ }
    }

    // The wall outlives the Layouts page (echo stays mounted behind
    // layouts), so an edit there — e.g. the layout's SPACE — must repaint
    // the mounted tiles: refresh each layout tile's row in place and
    // redraw (the badge and the space it activates both read layoutRow).
    const onCatalogChanged = (): void => {
      if (!body.isConnected) { document.removeEventListener("glyphh:apps-changed", onCatalogChanged); return; }
      void Promise.all([
        yoApi?.layoutsList?.().catch(() => null) ?? null,
        yoApi?.panelAppsList?.().catch(() => null) ?? null,
      ]).then(([fresh, rows]) => {
        if (!body.isConnected) return;
        let shifted = false;
        if (Array.isArray(fresh)) {
          const live = new Map(fresh.map((l) => [(l.name || "").toLowerCase(), l]));
          // Existing tiles follow their row; a layout that's gone leaves the wall.
          for (const e of [...entries]) {
            if (e.tile.kind !== "layout" || !e.tile.layoutName) continue;
            const row = live.get(e.tile.layoutName.toLowerCase());
            if (!row) {
              if (!e.card) { dropTileEntry(e); shifted = true; }   // never yank an OPEN panel
              continue;
            }
            e.tile.layoutRow = row;
            drawTile(e);
          }
          // A layout made since the wall was built (a starter card, the Layouts
          // page) joins it — the wall used to be fixed at mount, so anything
          // created afterwards simply never appeared.
          const onWall = new Set(entries.filter((e) => e.tile.kind === "layout" && e.tile.layoutName)
            .map((e) => e.tile.layoutName!.toLowerCase()));
          for (const row of fresh) {
            const key = (row.name || "").toLowerCase();
            if (!key || onWall.has(key)) continue;
            const band = wallBands[wallBands.length - 1];
            if (!band) break;
            // Layout tiles retired (2026-08-22): never re-seeded (this line
            // leaked Dev/test layout tiles back onto the wall).
            void row;
          }
        }
        // APPS join and leave the wall the same way — an app the user adds
        // mid-session (the Apps page, the agent's create_app_entry) appears
        // without a restart; a deleted one leaves (never an OPEN panel).
        if (Array.isArray(rows)) {
          echoRows = rows;   // .dip / layout-cell resolution sees the fresh set too
          const liveApps = new Map(rows.filter(wallAppRow).map((a) => [(a.slug || a.id).toLowerCase(), a]));
          for (const e of [...entries]) {
            if (e.tile.kind !== "app" || !e.tile.appId) continue;   // fixed tiles (Home) have no appId
            const row = e.tile.slug ? liveApps.get(e.tile.slug) : undefined;
            if (!row) {
              if (!e.card) { dropTileEntry(e); shifted = true; }
              continue;
            }
            liveApps.delete(e.tile.slug!);   // seen — the leftovers are NEW
            // the row is the truth for name/address (a deploy fills in url)
            if (e.tile.name !== row.name || (e.tile.url || undefined) !== (row.url || undefined)) {
              e.tile = { ...e.tile, ...appTileOf(row), sticky: e.tile.sticky };
              drawTile(e);
            }
          }
          for (const a of liveApps.values()) {
            const band = wallBands[wallBands.length - 1];
            if (!band) break;
            // new apps slot in BEFORE the layout tiles, matching the build order
            const entry = makeTileEntry(appTileOf(a));
            const li = band.findIndex((x) => x.tile.kind === "layout");
            if (li >= 0) band.splice(li, 0, entry);
            else band.push(entry);
            shifted = true;
          }
        }
        if (shifted) positionWall();
      }).catch(() => { /* next visit refetches */ });
    };
    document.addEventListener("glyphh:apps-changed", onCatalogChanged);

    // ── Open panels: click a tile and its LIVE webview zooms up from the
    // tile's spot into a slot row anchored high, so the wall stays visible
    // (and pannable) beneath; close zooms it back to its spot. ──
    const cardsLayer = body.querySelector<HTMLElement>(".echo-cards")!;
    const openList: TileEntry[] = [];
    // ── DOCK AUTO-HIDE (Appearance page, SDK-persisted pref, default ON):
    // the dock stays hidden until the mouse reaches the top of the page —
    // macOS-dock style. The hotzone catches the hover; the peek class slides
    // the dock in OVER whatever is open (no relayout on hover). ──
    // ── DOCK MAGNIFICATION — a SUBTLE ARCHED zoom rippling under the cursor
    // (default 20%). Slots are RE-LAID OUT with their scaled widths, so
    // neighbours push apart and never overlap; a slight downward arc follows
    // the gaussian. Strength: the Appearance slider (echoDockZoom, 1 = off). ──
    let dockZoom = 1.2;
    let dockZoomRaf = 0;
    function applyDockZoomAt(clientX: number | null): void {
      dockZoomRaf = 0;
      const dockEl = body.querySelector<HTMLElement>(".echo-dock");
      if (!dockEl) return;
      const kids = Array.from(dockEl.children) as HTMLElement[];
      if (!kids.length) return;
      if (clientX == null || dockZoom <= 1.001) {
        for (const c of kids) { if (c.style.transform) c.style.transform = ""; }
        return;
      }
      const dockRect = dockEl.getBoundingClientRect();
      const gap = parseFloat(getComputedStyle(dockEl).columnGap || "16") || 16;
      // Base geometry ACCUMULATED from widths (transform-immune) — never from
      // live rects, which move with the transforms and fed the jitter.
      const widths0 = kids.map((c) => c.offsetWidth);
      const lefts0: number[] = [];
      { let acc = 0; for (const w0 of widths0) { lefts0.push(acc); acc += w0 + gap; } }
      const sigma = 120;
      const scales = kids.map((_c, i) => {
        const center = dockRect.left + lefts0[i]! + widths0[i]! / 2;
        const d = Math.abs(clientX - center);
        return 1 + (dockZoom - 1) * Math.exp(-(d * d) / (2 * sigma * sigma));
      });
      // Re-layout with the scaled widths, centered against the base row —
      // this is what keeps the slots from ever overlapping.
      const widths = widths0.map((w0, i) => w0 * scales[i]!);
      const total = widths.reduce((a, w) => a + w, 0) + gap * (kids.length - 1);
      const baseTotal = lefts0[lefts0.length - 1]! + widths0[widths0.length - 1]! - lefts0[0]!;
      let x = lefts0[0]! + baseTotal / 2 - total / 2;
      kids.forEach((c, i) => {
        const cx = x + widths[i]! / 2;
        const tx = cx - (lefts0[i]! + widths0[i]! / 2);
        const ty = (scales[i]! - 1) * widths0[i]! * 0.18;   // the arc — a gentle dip
        const t = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${scales[i]!.toFixed(3)})`;
        if (c.style.transform !== t) c.style.transform = t;
        x += widths[i]! + gap;
      });
    }
    function queueDockZoom(clientX: number | null): void {
      if (dockZoomRaf) return;
      dockZoomRaf = requestAnimationFrame(() => applyDockZoomAt(clientX));
    }
    // ONE pointer check drives the dock ZOOM. (The hover-peek is gone —
    // syncWallVisibility owns dock visibility now: CC showing → dock shows;
    // covered → hidden unless auto-hide is off.) Drags suspend the zoom.
    body.addEventListener("mousemove", (ev) => {
      const dragging = dragIconKey != null
        || document.body.classList.contains("wb-mouse-drag")
        || document.body.classList.contains("echo-drag");
      if (dragging) { queueDockZoom(null); return; }
      const dockEl = body.querySelector<HTMLElement>(".echo-dock");
      if (!dockEl) return;
      const bar = body.querySelector<HTMLElement>(".echo-topbar");
      if (bar && bar.style.visibility === "hidden") { queueDockZoom(null); return; }
      const r = dockEl.getBoundingClientRect();
      const near = r.width > 0 && r.bottom > 0 && ev.clientY >= r.top - 26 && ev.clientY <= r.bottom + 26;
      queueDockZoom(near ? ev.clientX : null);
    });
    body.addEventListener("mouseleave", () => { queueDockZoom(null); });
    const readAutoHide = (): void => {
      void Promise.all([
        yoApi?.getPreference?.("echoIconsPerPage", 56) ?? 56,
      ]).then(([pp]) => {
        // Dock retired (2026-08-22): the auto-hide/zoom prefs died with it.
        const ppn = Number(pp);
        const nextPp = Number.isFinite(ppn) ? Math.max(8, Math.min(120, ppn)) : 56;
        if (nextPp !== perPage) { perPage = nextPp; renderPages(); }
        syncWallVisibility();
        layoutCards();
      });
    };
    readAutoHide();
    const onAutoHideChanged = (): void => {
      if (!body.isConnected) { document.removeEventListener("glyphh:echo-autohide-changed", onAutoHideChanged); return; }
      readAutoHide();
    };
    document.addEventListener("glyphh:echo-autohide-changed", onAutoHideChanged);
    // A layout opened in Echo pins its GRID: cards sit at the layout's own
    // col/row geometry until a card outside the grid appears (then the flow
    // layout takes back over).
    // rowFracs is PER COLUMN (indexed by column): each column splits its own
    // height independently, like the old layout manager's rails — dragging
    // the seam between two stacked panels never reshapes the neighbours.
    let echoGrid: { colWidths: number[]; rowFracs: number[][]; cells: Array<{ entry: TileEntry; col: number; row: number; colSpan: number; rowSpan: number }> } | null = null;
    /** Grid slots freed by closed cards (FIFO) — the next panel opened while
     *  the layout is up fills the first hole instead of breaking to flow. */
    let gridHoles: Array<{ col: number; row: number; colSpan: number; rowSpan: number }> = [];
    // The layout whose cards are on stage — dragged/resized card geometry is
    // remembered under its name and restored on the next open.
    let echoLayoutName: string | null = null;
    // B1/B2: the id shared by every card the CURRENT layout open fanned out.
    // Minted per open in openLayoutInEchoArranged; stamped onto each entry so a
    // card knows it belongs to a layout (hide its X) and the layout bar can tear
    // the whole set down in one action.
    let activeLayoutId: string | null = null;
    const echoMemKey = (name: string): string => `echo:layout:${name.trim().toLowerCase()}`;
    /** A fingerprint of the layout's DEFINITION — grid size plus every cell's
     *  panel and slot. Remembered positions override the definition (that is
     *  what makes a user's drag stick), so memory saved against a DIFFERENT
     *  shape must be discarded: an edited layout would otherwise open with its
     *  old geometry forever, panels landing in columns that no longer exist. */
    const layoutSig = (l: { cols?: number; rows?: number; splits?: Array<{ panelId: string; col?: number; row?: number; colSpan?: number; rowSpan?: number }> }): string =>
      `${l.cols ?? 0}x${l.rows ?? 0}:` +
      (l.splits ?? [])
        .map((c) => `${(c.panelId || "").toLowerCase()}@${c.col ?? 0},${c.row ?? 0},${c.colSpan ?? 1},${c.rowSpan ?? 1}`)
        .sort()
        .join("|");
    /** The definition currently on stage — what a save fingerprints against. */
    let echoLayoutSig = "";
    /** What a layout cell was DOING, restored on the next open: the web
     *  card's last navigated page, the editor's open files, the Browser's
     *  tabs. Terminals restart (a pty can't be frozen). */
    interface EchoCellState {
      url?: string;
      files?: Array<{ name: string; path: string; mode?: "preview" | "code" }>;
      activeIdx?: number;
      tabs?: Array<{ url: string; title?: string }>;
      activeTab?: number;
    }
    const captureCellState = (e: TileEntry): EchoCellState | undefined => {
      if (e.toolSlot?.view === "monaco") {
        const m = e.toolSlot as MonacoSlot;
        if (m.tabs.length) {
          return {
            files: m.tabs.map((t) => ({ name: t.name, path: t.path, ...(t.mode ? { mode: t.mode } : {}) })),
            activeIdx: m.activeIdx,
          };
        }
        return undefined;
      }
      if (e.toolSlot?.view === "preview") {
        const pv = e.toolSlot as PreviewSlot;
        const tabs = (pv.tabs ?? []).filter((t) => t.url).map((t) => ({ url: t.url!, ...(t.title ? { title: t.title } : {}) }));
        return tabs.length ? { tabs, activeTab: pv.activeTab ?? 0 } : undefined;
      }
      if (e.tile.url && e.card) {
        // where the user actually navigated — a NotebookLM card comes back on
        // its notebook, not the app's front page (glyphh apps resolve their
        // own entry and are skipped)
        const wv = e.card.querySelector("webview") as (WebviewEl & HTMLElement) | null;
        let u = "";
        try { u = wv?.getURL?.() || ""; } catch { u = ""; }
        return /^https?:/i.test(u) ? { url: u } : undefined;
      }
      return undefined;
    };
    /** SLOT-model memory (the old layout manager's shape): the column/row
     *  fractions the dividers set, which cell each panel occupies, and what
     *  each panel was doing. */
    const saveEchoLayoutMem = (): void => {
      if (!echoLayoutName || !echoGrid) return;
      // Panel STATE persists only under the "last" contract — a "new"/"keep"
      // layout keeps its geometry memory but starts panels from the
      // definition every open. Geometry always saves.
      const keepState = echoActiveLayout?.mode === "last";
      // A degenerate save (webviews already torn down) must not WIPE state a
      // healthier save remembered — carry the old cell state forward when
      // this pass captured nothing.
      let prior: Map<string, EchoCellState> | null = null;
      if (keepState) {
        try {
          const raw = localStorage.getItem(echoMemKey(echoLayoutName));
          const old = raw ? (JSON.parse(raw) as { cells?: Array<{ key: string; state?: EchoCellState }> }) : null;
          prior = new Map((old?.cells ?? []).filter((c) => c.state).map((c) => [c.key, c.state!]));
        } catch { prior = null; }
      }
      const data = {
        sig: echoLayoutSig,
        colWidths: echoGrid.colWidths,
        rowFracs: echoGrid.rowFracs,
        cells: echoGrid.cells.filter((c) => c.entry.memKey).map((c) => {
          const state = keepState ? (captureCellState(c.entry) ?? prior?.get(c.entry.memKey!)) : undefined;
          return {
            key: c.entry.memKey!, col: c.col, row: c.row, colSpan: c.colSpan, rowSpan: c.rowSpan,
            ...(state ? { state } : {}),
          };
        }),
      };
      try { localStorage.setItem(echoMemKey(echoLayoutName), JSON.stringify(data)); } catch { /* full */ }
    };
    // Shadow can be HELD (⌃⌥) or PINNED (the composer band's CC button) — a
    // pin survives modifier keyups; opening/closing the last card or Esc
    // clears both. The pin state rides a BODY class so the composer band's
    // button (help/code.ts DOM, a different layer) can mirror it.
    let shadowPinned = false;
    // The CC's CLOSE (✕, top right — his rule 2026-08-20): visible whenever
    // the lifted command center sits over open panels; does exactly what Esc
    // does there — drop the wall back behind the cards.
    let ccCloseBtn: HTMLButtonElement | null = null;
    const syncCcClose = (on: boolean): void => {
      if (!ccCloseBtn) {
        ccCloseBtn = document.createElement("button");
        ccCloseBtn.className = "echo-cc-close hidden";
        ccCloseBtn.type = "button";
        ccCloseBtn.title = "Close the command center (Esc)";
        ccCloseBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
        ccCloseBtn.addEventListener("click", () => setShadow(false, false));
        stage.appendChild(ccCloseBtn);
      }
      ccCloseBtn.classList.toggle("hidden", !(on && openList.length > 0));
    };
    const setShadow = (on: boolean, pin: boolean): void => {
      shadowPinned = on && pin;
      cardsLayer.classList.toggle("echo-shadow", on);
      syncCcClose(on);
      document.body.classList.toggle("echo-cc-pinned", shadowPinned);
      // Body mirror for layers OUTSIDE the workbench DOM: the layout-docked
      // agent holder rides a body-level layer (z 118) that would paint OVER
      // the raised wall — it hides while the wall is lifted (⌘⇧Space).
      document.body.classList.toggle("echo-wall-lifted", on);
      // Pull focus out of any app webview so Esc reaches the document —
      // without this, Esc "didn't work" whenever an app had keyboard focus.
      if (on) {
        (document.activeElement as HTMLElement | null)?.blur?.();
        stage.focus?.();
      }
      syncWallVisibility();
      // The dock's visibility JUST changed the band's top edge — re-measure,
      // or the layout keeps the lifted-state gap after Esc drops the wall.
      layoutCards();
    };
    // The composer band's command-center button (help/code.ts) is the eye: it
    // pin-toggles the shadow so the wall shows over the open cards.
    (window as unknown as { __wbEchoShadowPin?: () => void }).__wbEchoShadowPin = () => {
      if (!openList.length) return;
      setShadow(!shadowPinned, !shadowPinned);
    };
    // ESC closes the lifted command center when apps/a layout are open behind
    // it (his rule, 2026-08-19). Deliberately DEFERS to more local Escapes:
    // an open peek, menu, or icon-edit mode eats the key first.
    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape" || !body.isConnected) return;
      if (!cardsLayer.classList.contains("echo-shadow") || !openList.length) return;
      if (document.body.classList.contains("peek-open")) return;
      if (document.querySelector(".ws-tab-ctx-menu")) return;
      if (iconEditMode) return;
      ev.stopPropagation();
      setShadow(false, false);
    }, true);
    const EXPAND_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
    const COLLAPSE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
    const collapseCard = (card: HTMLElement): void => {
      card.classList.remove("expanded");
      cardsLayer.classList.remove("has-expanded");
      card.style.zIndex = "";
      const b = card.querySelector<HTMLElement>(".echo-card-expand");
      if (b) { b.innerHTML = EXPAND_SVG; b.title = "Expand"; }
    };
    /** Reorder ACCUMULATED (flow) panels by dragging their header — up/down
     *  within a column, horizontally across columns. Hovering past another
     *  card moves the dragged entry to its position in openList and the flow
     *  reflows live (the cards' position transition carries the animation).
     *  Layout-grid cells keep their grid; controls keep their clicks. Pointer
     *  capture on the head keeps events flowing even over iframes/webviews. */
    const wireCardDrag = (e: TileEntry, card: HTMLElement, head: HTMLElement): void => {
      head.addEventListener("pointerdown", (ev) => {
        if (ev.button !== 0) return;
        const t = ev.target as HTMLElement;
        if (t.closest("button, input, .ws-app-chrome")) return;
        if (card.classList.contains("expanded")) return;
        if (gridRects()?.has(e)) return;
        if (e.tile.kind === "agent") return;   // the agent owns its column — never reflowed
        const startX = ev.clientX, startY = ev.clientY;
        let dragging = false;
        // Capture keeps the stream flowing over iframes/webviews; a pointer
        // that can't be captured (synthetic, stale id) still drags fine via
        // the head listeners + the body.echo-drag pointer-events guard.
        try { head.setPointerCapture(ev.pointerId); } catch { /* uncapturable */ }
        let lastSwapAt = 0;
        let lastSwapX = 0, lastSwapY = 0;
        let edgeIntent: "left" | "right" | null = null;
        const setEdgeIntent = (next: "left" | "right" | null): void => {
          if (edgeIntent === next) return;
          edgeIntent = next;
          stage.classList.toggle("echo-edge-left", next === "left");
          stage.classList.toggle("echo-edge-right", next === "right");
        };
        const move = (mv: PointerEvent): void => {
          if (!dragging) {
            if (Math.hypot(mv.clientX - startX, mv.clientY - startY) < 6) return;
            dragging = true;
            card.classList.add("echo-card-dragging");
            document.body.classList.add("echo-drag");
          }
          // DRIVE TO A SIDE: holding the drag inside the band's left/right
          // edge parks the card as its own flanking column on release.
          {
            const band = buildBand();
            const sr = stage.getBoundingClientRect();
            const x = mv.clientX - sr.left;
            const inBandY = mv.clientY - sr.top >= band.top && mv.clientY - sr.top <= band.top + band.height;
            setEdgeIntent(!inBandY ? null : x <= band.left + 44 ? "left" : x >= band.left + band.width - 44 ? "right" : null);
            if (edgeIntent) return;   // edge wins — no reorder while flanking
          }
          const over = document.elementsFromPoint(mv.clientX, mv.clientY)
            .find((el) => el !== card && el instanceof HTMLElement && el.classList.contains("echo-card")) as HTMLElement | undefined;
          if (!over) return;
          const target = openList.find((x) => x.card === over);
          if (!target || target.tile.kind === "agent" || gridRects()?.has(target)) return;
          const from = openList.indexOf(e);
          const to = openList.indexOf(target);
          if (from < 0 || to < 0 || from === to) return;
          // HYSTERESIS — the flip-flop killer. Right at a boundary, a swap
          // re-lays the cards so the OTHER one lands back under the cursor
          // and the next move swaps straight back (the "jerky panel"). Two
          // guards: (1) the pointer must be PAST the target's midpoint in
          // the direction of travel (dragged card → target), on the dominant
          // axis; (2) a short cooldown after each swap unless the pointer
          // has genuinely moved on.
          const now = performance.now();
          if (now - lastSwapAt < 160 && Math.hypot(mv.clientX - lastSwapX, mv.clientY - lastSwapY) < 14) return;
          const tr = over.getBoundingClientRect();
          const cr = card.getBoundingClientRect();
          const dx = (tr.left + tr.width / 2) - (cr.left + cr.width / 2);
          const dy = (tr.top + tr.height / 2) - (cr.top + cr.height / 2);
          if (Math.abs(dx) >= Math.abs(dy)) {
            const midX = tr.left + tr.width / 2;
            if (dx > 0 && mv.clientX <= midX) return;
            if (dx < 0 && mv.clientX >= midX) return;
          } else {
            const midY = tr.top + tr.height / 2;
            if (dy > 0 && mv.clientY <= midY) return;
            if (dy < 0 && mv.clientY >= midY) return;
          }
          lastSwapAt = now;
          lastSwapX = mv.clientX;
          lastSwapY = mv.clientY;
          // Re-stacking by hand releases an edge-driven column claim.
          e.flowSolo = undefined;
          openList.splice(from, 1);
          openList.splice(to, 0, e);
          layoutCards();
        };
        const up = (): void => {
          head.removeEventListener("pointermove", move);
          try { head.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
          if (dragging) {
            // Edge release: the card becomes the FIRST (left) or LAST (right)
            // flow position — with the breadth-first fill that is its own
            // side-by-side column next to the rest.
            if (edgeIntent) {
              const from = openList.indexOf(e);
              if (from >= 0) {
                openList.splice(from, 1);
                if (edgeIntent === "left") openList.unshift(e);
                else openList.push(e);
                // Driven to a side: the card owns its column now — it sits
                // NEXT TO the others until deliberately re-stacked.
                e.flowSolo = true;
              }
            }
            setEdgeIntent(null);
            card.classList.remove("echo-card-dragging");
            document.body.classList.remove("echo-drag");
            layoutCards();
          }
        };
        head.addEventListener("pointermove", move);
        head.addEventListener("pointerup", up, { once: true });
        head.addEventListener("pointercancel", up, { once: true });
      });
    };
    const setRect = (el: HTMLElement, r: { left: number; top: number; width: number; height: number }): void => {
      el.style.left = `${Math.round(r.left)}px`;
      el.style.top = `${Math.round(r.top)}px`;
      el.style.width = `${Math.round(r.width)}px`;
      el.style.height = `${Math.round(r.height)}px`;
    };
    /** The icon's CURRENT on-screen rect (stage-relative) — the zoom origin. */
    const iconRect = (e: TileEntry): { left: number; top: number; width: number; height: number } | null => {
      const el = e.iconEl;
      if (!el || !el.isConnected) return null;
      const r = el.getBoundingClientRect();
      const sr = stage.getBoundingClientRect();
      if (r.width < 4) return null;
      return { left: r.left - sr.left, top: r.top - sr.top, width: r.width, height: r.height };
    };
    /** Slot rects: up to 3 across, wrapping, anchored near the top — the
     *  wall's lower rows peek out beneath. */
    /** Loose (non-layout) cards tile like the OLD LAYOUT MANAGER's rails:
     *  a new panel opens BESIDE the others (its own column, up to 3 across),
     *  then STACKS under an existing app column (two to a column) once the
     *  row is full. The agent keeps its column to itself — nothing is ever
     *  squeezed beneath it — and it keeps the LEFT column ("agent pinned
     *  left, grid to its right"), so an app opened before OR after the agent
     *  always lands to the agent's right, never over or left of it. */
    /** Depth-first flow, full band: cards fill columns in OPEN ORDER (two to
     *  a column, then a new column right). The agent keeps its column to
     *  itself, and so does any card the user drove to a side (flowSolo —
     *  the edge-drop gesture): nothing ever stacks under those. */
    const flowColumns = (cards: TileEntry[]): TileEntry[][] => {
      const cols: TileEntry[][] = [];
      for (const e of cards) {
        const solo = e.tile.kind === "agent" || e.flowSolo === true;
        const target = solo
          ? undefined
          : cols.find((col) => col.length < 2 && !col.some((c) => c.tile.kind === "agent" || c.flowSolo === true));
        if (target) target.push(e);
        else cols.push([e]);
      }
      return cols;
    };
    // User-slid flow seams: a width fraction per column + row fractions per
    // column. Reset whenever the flow SHAPE changes (columns appear/vanish,
    // a column gains/loses a row) — a slide only lives for the shape it
    // shaped; fresh shapes go back to even splits.
    let flowColFr: number[] = [];
    const flowRowFr = new Map<number, number[]>();
    const syncFlowFracs = (cols: TileEntry[][]): void => {
      if (flowColFr.length !== cols.length) flowColFr = cols.map(() => 1);
      cols.forEach((col, ci) => {
        const fr = flowRowFr.get(ci);
        if (!fr || fr.length !== col.length) flowRowFr.set(ci, col.map(() => 1));
      });
      for (const k of [...flowRowFr.keys()]) if (k >= cols.length) flowRowFr.delete(k);
    };
    const normFr = (a: number[]): number[] => { const t = a.reduce((x, y) => x + y, 0) || 1; return a.map((v) => v / t); };
    const preFr = (a: number[], i: number): number => a.slice(0, i).reduce((x, y) => x + y, 0);
    /** The BUILD BAND — the only region open cards may occupy: below the
     *  wall's top bar (dock + search) and above the floating composer, with
     *  side margins. Cards NEVER overlap either. Stage-relative pixels,
     *  measured live so a taller composer (chips, notes) pushes the band up. */
    const buildBand = (): { left: number; top: number; width: number; height: number } => {
      const w = stage.clientWidth || 1, h = stage.clientHeight || 1;
      const stageR = stage.getBoundingClientRect();
      // The band's outer margins MATCH the 7px inter-panel gap — panels sit
      // as close to the edges as they sit to each other.
      const margin = 7;
      let top = margin;
      const bar = body.querySelector<HTMLElement>(".echo-topbar");
      if (bar && bar.style.visibility !== "hidden") {
        const r = bar.getBoundingClientRect();
        if (r.height > 0) top = Math.max(top, r.bottom - stageR.top + margin);
      }
      let bottom = h - margin;
      // Over open cards the agent is TUCKED (overlay, no reserved height); on
      // the visible command center it is seated and keeps its room.
      const agent = document.querySelector<HTMLElement>('.code-root[data-anchor="center"] > .code-agent');
      if (agent && !document.body.classList.contains("echo-wall-covered")) {
        const r = agent.getBoundingClientRect();
        if (r.height > 0) bottom = Math.min(bottom, r.top - stageR.top - margin);
      }
      // Degenerate windows (tiny stage, mid-boot measures) — keep a usable box.
      if (bottom - top < 160) { top = margin; bottom = Math.max(top + 160, h - margin); }
      const side = 7;
      return { left: side, top, width: Math.max(200, w - side * 2), height: Math.max(160, bottom - top) };
    };
    const flowRects = (cards: TileEntry[]): Map<TileEntry, { left: number; top: number; width: number; height: number }> => {
      // CENTER-SCREEN BUILD PATTERN inside the band: the first app opens as a
      // comfortable centered card; more apps BUILD outward (the existing
      // column flow), the block staying centered and never touching the top
      // bar above or the composer below. Proportional seam drags still apply.
      const band = buildBand();
      const gap = 7;
      const cols = flowColumns(cards);
      syncFlowFracs(cols);
      const cwFr = normFr(flowColFr);
      // FULL band, edge to edge (reverted to the morning-before behavior, his
      // order 2026-08-20): one app takes the whole width AND height, the next
      // stacks into the same space — nothing wasted, and the drag/resize
      // gestures (flowSolo edge-drops, column/row fractions) own geometry.
      const availW = band.width - gap * (cols.length - 1);
      const out = new Map<TileEntry, { left: number; top: number; width: number; height: number }>();
      let x = band.left;
      cols.forEach((col, ci) => {
        const colW = availW * cwFr[ci];
        const rhFr = normFr(flowRowFr.get(ci) ?? col.map(() => 1));
        const availH = band.height - gap * (col.length - 1);
        let y = band.top;
        col.forEach((e, ri) => {
          const cellH = availH * rhFr[ri];
          out.set(e, { left: x, top: y, width: Math.max(160, colW), height: Math.max(110, cellH) });
          y += cellH + gap;
        });
        x += colW + gap;
      });
      return out;
    };
    /** The layout-grid rects (or null when no grid / a stray card broke it). */
    const gridRects = (): Map<TileEntry, { left: number; top: number; width: number; height: number }> | null => {
      if (!echoGrid) return null;
      if (!echoGrid.cells.length) { echoGrid = null; return null; }
      // The grid fills the BUILD BAND (never the top bar above or the
      // composer below) — 7px seams live only BETWEEN panels; cells touching
      // a band edge touch the band edge.
      const band = buildBand();
      const gap = 7;
      const W = band.width, H = band.height;
      const norm = (a: number[]): number[] => {
        const sum = a.reduce((x, y) => x + y, 0) || 1;
        return a.map((v) => v / sum);
      };
      const cw = norm(echoGrid.colWidths);
      const pre = (a: number[], i: number): number => a.slice(0, i).reduce((x, y) => x + y, 0);
      const out = new Map<TileEntry, { left: number; top: number; width: number; height: number }>();
      for (const c of echoGrid.cells) {
        // vertical geometry from the ANCHOR column's own fractions
        const rh = norm(echoGrid.rowFracs[c.col] ?? echoGrid.rowFracs[0] ?? [1]);
        const left = band.left + pre(cw, c.col) * W + (c.col === 0 ? 0 : gap / 2);
        const right = band.left + pre(cw, c.col + c.colSpan) * W - (c.col + c.colSpan >= cw.length ? 0 : gap / 2);
        const top = band.top + pre(rh, c.row) * H + (c.row === 0 ? 0 : gap / 2);
        const bottom = band.top + pre(rh, c.row + c.rowSpan) * H - (c.row + c.rowSpan >= rh.length ? 0 : gap / 2);
        out.set(c.entry, { left, top, width: Math.max(120, right - left), height: Math.max(90, bottom - top) });
      }
      return out;
    };
    /** With a LAYOUT on stage the wall is fully invisible behind it — the
     *  cards are the surface. The ⌃⌥ / eye shadow peek brings it back. */
    function syncWallVisibility(): void {
      const layoutUp = !!echoGrid && echoGrid.cells.length > 0;
      // ANY open panel retires the launcher pages — the ⌃⌥ / eye peek lifts.
      const cardsUp = openList.some((e) => e.card);
      const shadowOn = cardsLayer.classList.contains("echo-shadow");
      const hidden = (layoutUp || cardsUp) && !shadowOn;
      pagesEl.style.visibility = hidden ? "hidden" : "";
      dotsEl.style.visibility = hidden ? "hidden" : "";
      body.querySelectorAll<HTMLElement>(".echo-page-arrow").forEach((a) => { a.style.visibility = hidden ? "hidden" : ""; });
      pagesEl.style.pointerEvents = hidden ? "none" : "";
      // THE DOCK RULE (his rule, 2026-08-18): anytime the COMMAND CENTER is
      // showing (bare wall, or the shadow peek over open panels) the dock
      // shows; when the CC is covered it hides — UNLESS auto-hide is OFF,
      // which pins it always-on.
      const bar = body.querySelector<HTMLElement>(".echo-topbar");
      const autoHideOn = document.body.classList.contains("echo-dock-autohide");
      if (bar) bar.style.visibility = (!hidden || !autoHideOn) ? "" : "hidden";
      // The CC + reset buttons live in the COMPOSER'S side band now (help/
      // code.ts DOM) — a body class carries "needed": only over LOOSE cards; a
      // live LAYOUT owns the surface (no dock, no wall reveal) and the layout
      // bar's own close is the exit there.
      document.body.classList.toggle("echo-cc-needed", cardsUp && !layoutUp);
      // The composer NEVER hides while the echo panel is showing (his rule,
      // 2026-08-19) — it tucks to the page bottom ONLY when cards fully cover
      // the wall. Lifting the wall (the CC button / ⌃⌥) reseats it.
      // (The 2026-08-20 lingering tuck was reverted with the flow layout —
      // "move back to before the changes this morning".)
      // THE LOCK does NOT change this computation (his correction, 2026-08-20:
      // "i don't want a space reserved — just leave it floating and open"):
      // covered proceeds as ever, cards take the FULL band, and the lock's
      // CSS pin (body.echo-agent-locked, !important) simply overrides the
      // tuck transform so the agent floats OVER the cards instead of hiding.
      // ?solo=agent (the attached-agent window): the foreign app beneath the
      // window IS the covering surface — covered is permanent there, and the
      // lock pin overrides the tuck exactly as it does over cards.
      const agentDock = document.documentElement.getAttribute("data-home-scope") === "agent-dock";
      const covered = agentDock || (hidden && !layoutUp);
      const wasCovered = document.body.classList.contains("echo-wall-covered");
      document.body.classList.toggle("echo-wall-covered", covered);
      // Opening a panel FROM the composer (the ⋮ menu, the source-row icons)
      // leaves focus inside the agent — :focus-within then pins it up until a
      // hover cycle releases it ("doesn't hide right away"). The moment the
      // wall becomes covered, any focus held in the composer drops so the
      // tuck starts immediately.
      if (covered && !wasCovered) {
        const active = document.activeElement as HTMLElement | null;
        // Release BUTTON focus only (the ⋮-menu case). A TEXTAREA/INPUT is the
        // user TYPING — the agent opening panels mid-run must never steal the
        // keyboard out of their hands.
        if (active && active.closest(".code-agent")
          && !(active instanceof HTMLTextAreaElement) && !(active instanceof HTMLInputElement)
          && !active.isContentEditable) active.blur();
      }
    }
    // The lock flipped mid-session: recompute the tuck + card band right away.
    window.addEventListener("glyphh:agent-lock-changed", () => { syncWallVisibility(); layoutCards(); });
    // ── Top bar: JUST the dock now (fixed nav slots, sitting high on the
    // page). The search bar is gone; drips moved onto the composer card
    // (help/code.ts wires the picker there, opening upward). ──
    {
      // The DOCK — nav slots + any icons TRADED in from the pages. Sections
      // open as wall cards; Scheduled Tasks and Browser are workbench tools;
      // Settings is the SETTINGS MODAL (navigation.ts owns it — bridged);
      // traded icons open exactly like their page selves. Slots can NEVER be
      // deleted — only MOVED (dock ⇄ pages); membership + order persist
      // (echoDockOrder, owned by the launcher's reconcileDock).
      // Dock retired (2026-08-22): its drag wiring + click handler died with
      // it. (This block once crashed setup post-removal — the "!"-asserted
      // querySelector — killing everything declared after it via TDZ.)
    }
    // B1: the layout bar — one control that closes the whole layout. Shown only
    // while a layout's cards are on stage (any open card carries a layoutId).
    // Defined ABOVE layoutCards so there is no forward reference.
    const layoutBar = body.querySelector<HTMLElement>(".echo-layout-bar")!;
    // Move the Close-layout bar OUT of the content pane and INTO the app header
    // (#shell-drag-strip, the fixed 38px top bar) so it renders centered in the header,
    // not floating in the right-hand content page. It stays referenced by `layoutBar`.
    document.getElementById("shell-drag-strip")?.appendChild(layoutBar);
    // JS-DRIVEN REVEAL (his bug, 2026-08-20, desktop-only): the tucked bar
    // relied on CSS :hover — on the desktop, once a click focused a webview
    // panel, the compositor stopped updating hover state over the drag strip
    // and the bar became unrevealable. Host-level mousemove keeps firing, so
    // the peek class drives the slide instead; the :hover rules stay as a
    // harmless fallback. Near the top = peek on; well below = off (the gap
    // between thresholds stops flutter at the boundary).
    document.addEventListener("mousemove", (ev) => {
      if (layoutBar.classList.contains("hidden")) return;
      if (ev.clientY <= 46) layoutBar.classList.add("peek");
      else if (ev.clientY > 120) layoutBar.classList.remove("peek");
    }, { passive: true });
    // These live INSIDE layoutBar, which was just re-parented into the header —
    // query them from layoutBar, NOT body, or they come back null and the
    // addEventListener below throws, killing every handler bound after it
    // (the wall renders but nothing is clickable).
    const layoutBarName = layoutBar.querySelector<HTMLElement>(".echo-layout-bar-name")!;
    layoutBar.querySelector<HTMLElement>(".echo-layout-close")!
      .addEventListener("click", () => {
        if (openList.some((e) => e.layoutId != null)) closeLayoutGroup();
        else resetEcho();   // loose panels: close everything, back to the CC
      });
    // Command center + reset ride the layout bar too (his rule, 2026-08-19):
    // right of the close — just the CC (lift the wall over the layout). The
    // RESET moved to the agent panel alone (his rule, 2026-08-20), behind a
    // confirm — two resets was one too many, and this one fired bare.
    layoutBar.querySelector<HTMLElement>(".echo-layout-cc")!
      .addEventListener("click", () => {
        (window as unknown as { __wbEchoShadowPin?: () => void }).__wbEchoShadowPin?.();
      });
    // SAVE AS WORKSPACE (his rule, 2026-08-20): loose panels only — a layout
    // already IS a saved workspace. Basics modal: name, loop, its model
    // slots, session mode.
    layoutBar.querySelector<HTMLElement>(".echo-layout-save")!
      .addEventListener("click", () => { void openSaveWorkspaceModal(); });
    let layoutBarIntro = 0;
    function paintLayoutBar(): void {
      // THE WORKSPACE BAR is on EVERY page except the bare command center
      // (his rule, 2026-08-19): a layout titles it by name; loose panels
      // title it by their names — five or more reads "Multi".
      const inLayout = openList.some((e) => e.layoutId != null);
      const cards = openList.filter((e) => e.card && e.tile.kind !== "agent");
      const show = inLayout || cards.length > 0;
      // Outer scopes (e.g. __wbNewSessionPanel) need layout-ness without
      // reaching into this closure — stamp it on the body.
      document.body.classList.toggle("echo-layout-active", inLayout);
      const wasHidden = layoutBar.classList.contains("hidden");
      layoutBar.classList.toggle("hidden", !show);
      layoutBar.querySelector(".echo-layout-save")?.classList.toggle("hidden", inLayout);
      if (inLayout) layoutBarName.textContent = echoLayoutName || "Workspace";
      else if (cards.length > 4) layoutBarName.textContent = "Multi";
      else layoutBarName.textContent = cards.map((e) => e.tile.name).join(" · ");
      // INTRO: a freshly shown bar (layout open / boot restore) stays fully
      // visible for a beat before the auto-hide tucks it — otherwise the
      // restored layout reads as having NO close pill at all.
      if (show && wasHidden) {
        layoutBar.classList.add("intro");
        window.clearTimeout(layoutBarIntro);
        layoutBarIntro = window.setTimeout(() => layoutBar.classList.remove("intro"), 2600);
      } else if (!show) {
        layoutBar.classList.remove("intro");
      }
    }
    function layoutCards(): void {
      const n = openList.length;
      // COMPOSER VISIBILITY FIRST — the band measures the composer live, so
      // this must land BEFORE any rect math. A layout HOSTING the agent
      // removes the center composer (its cells then get the full height —
      // "full screen"); without an agent cell the composer stays and the
      // layout opens in the band ABOVE it. Toggling this after the rects
      // (the old order) painted each state with the other's geometry.
      const agentInLayout = openList.some((e) => e.layoutId != null && e.tile.kind === "agent");
      document.body.classList.toggle("echo-agent-in-layout", agentInLayout);
      if (!n) { paintDividers(false); syncWallVisibility(); paintLayoutBar(); return; }   // no panels ⇒ no seams
      const grid = gridRects();
      const flow = flowRects(openList.filter((e) => !(grid && grid.has(e))));
      openList.forEach((e) => {
        if (!e.card) return;
        e.card.classList.toggle("echo-pinned", !!e.tile.sticky);
        // B2: a panel that's part of a layout hides its own X — closing happens
        // via the layout bar (B1). A standalone app (no layoutId) keeps its X.
        e.card.classList.toggle("echo-card-in-layout", e.layoutId != null);
        // MARKETPLACE opens FULL STAGE (his rule, 2026-08-22): edge to edge,
        // no reserved band under the search — the whole page is the store.
        if (e.card.querySelector('.help-section[data-section="marketplace"]')) {
          e.card.classList.add("expanded");
          setRect(e.card, { left: 0, top: 0, width: stage.clientWidth || 1, height: stage.clientHeight || 1 });
          return;
        }
        if (e.card.classList.contains("expanded")) {
          // Expanded = the whole BAND, never the whole stage — the top bar
          // and the composer stay clear.
          setRect(e.card, buildBand());
          return;
        }
        const r = grid?.get(e) ?? flow.get(e);
        if (r) setRect(e.card, r);
      });
      // A maximized card retires ALL resize seams — they sat above it and kept
      // eating clicks meant for the panel. Otherwise the grid paints the
      // layout's seams and the FLOW paints its own slideable ones.
      const anyExpanded = openList.some((e) => e.card?.classList.contains("expanded"));
      // SELF-HEAL the expanded state: closing an EXPANDED card used to strand
      // `has-expanded` on the layer, and its CSS hides every non-expanded
      // card — panels "active" in the launcher but a blank screen. layoutCards
      // is the one reconciler, so the class always mirrors reality here.
      cardsLayer.classList.toggle("has-expanded", anyExpanded);
      // A FULLSCREEN panel covers EVERYTHING — including the layout-docked
      // agent, whose holder rides a body-level layer no in-stage z-index can
      // beat (his rule, 2026-08-19). Body class, unless the agent's own cell
      // is the expanded one.
      const expandedIsAgent = openList.some((e) => e.tile.kind === "agent" && e.card?.classList.contains("expanded"));
      document.body.classList.toggle("echo-card-fullscreen", anyExpanded && !expandedIsAgent);
      if (grid) paintDividers(!anyExpanded);
      else paintFlowDividers(anyExpanded ? null : openList.filter((e) => e.card));
      syncWallVisibility();
      paintSectionToggles();   // an echo card IS the tool's open state
      paintLayoutBar();
    }
    wallChromeReady = true;
    /** DIVIDERS — draggable seams between grid columns/rows (the old rail
     *  handles): dragging one reshapes the layout by shifting the fraction
     *  between the two neighbors, and the shape is remembered. */
    // var + lazy mount: paintDividers is HOISTED (TDZ fix, 2026-08-22) and can
    // run before this line — resolve the layer on first use instead.
    let dividerLayerEl: HTMLDivElement | null = null;
    const dividerLayer = ((): HTMLDivElement => {
      if (!dividerLayerEl) {
        dividerLayerEl = document.createElement("div");
        dividerLayerEl.className = "echo-dividers";
        cardsLayer.appendChild(dividerLayerEl);
      }
      return dividerLayerEl;
    });
    function paintDividers(on: boolean): void {
      dividerLayer().innerHTML = "";
      if (!on || !echoGrid) return;
      // MUST match gridRects: the grid lives in the BUILD BAND.
      const band = buildBand();
      const x0 = band.left, y0 = band.top, W = band.width, H = band.height;
      const norm = (a: number[]): number[] => { const t = a.reduce((x, y) => x + y, 0) || 1; return a.map((v) => v / t); };
      const cw = norm(echoGrid.colWidths);
      const pre = (a: number[], i: number): number => a.slice(0, i).reduce((x, y) => x + y, 0);
      const wire = (el: HTMLElement, horiz: boolean, idx: number, colIdx: number): void => {
        el.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const startPos = horiz ? ev.clientY : ev.clientX;
          const fr = horiz ? echoGrid!.rowFracs[colIdx] : echoGrid!.colWidths;
          if (!fr) return;
          const total = fr.reduce((x, y) => x + y, 0) || 1;
          const a0 = fr[idx - 1], b0 = fr[idx];
          const span = horiz ? H : W;
          document.body.classList.add("wb-mouse-drag");
          cardsLayer.classList.add("echo-no-anim");   // live reshape, no tweening
          const onMove = (m: MouseEvent): void => {
            const d = ((horiz ? m.clientY : m.clientX) - startPos) / span * total;
            const min = total * 0.08;
            fr[idx - 1] = Math.max(min, Math.min(a0 + b0 - min, a0 + d));
            fr[idx] = a0 + b0 - fr[idx - 1];
            layoutCards();
          };
          const onUp = (): void => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            document.body.classList.remove("wb-mouse-drag");
            cardsLayer.classList.remove("echo-no-anim");
            saveEchoLayoutMem();
          };
          document.addEventListener("mousemove", onMove);
          document.addEventListener("mouseup", onUp);
        });
      };
      // Seams draw from OCCUPANCY, not the grid's dimensions — after a
      // layout panel closes, a divider with nothing on one side must go,
      // not hang in the empty space.
      const covers = (ci: number, ri: number): boolean =>
        echoGrid!.cells.some((c) => c.col <= ci && ci < c.col + c.colSpan && c.row <= ri && ri < c.row + c.rowSpan);
      const colOccupied = (ci: number): boolean =>
        echoGrid!.cells.some((c) => c.col <= ci && ci < c.col + c.colSpan);
      for (let i = 1; i < cw.length; i++) {
        if (!colOccupied(i - 1) || !colOccupied(i)) continue;
        const el = document.createElement("div");
        el.className = "echo-div echo-div-v";
        el.style.left = `${x0 + pre(cw, i) * W - 4}px`;
        el.style.top = `${y0}px`;
        el.style.height = `${H}px`;
        wire(el, false, i, 0);
        dividerLayer().appendChild(el);
      }
      // horizontal seams: one SEGMENT per column, spanning only that column —
      // a drag reshapes that column's stack and nothing else. A boundary
      // inside a row-spanning cell has no seam, and neither does one with an
      // empty side.
      echoGrid.rowFracs.forEach((fracs, ci) => {
        const rh = norm(fracs);
        const segLeft = x0 + pre(cw, ci) * W;
        const segWidth = cw[ci] * W;
        for (let i = 1; i < rh.length; i++) {
          const crossed = echoGrid!.cells.some((c) =>
            c.col <= ci && ci < c.col + c.colSpan && c.row < i && i < c.row + c.rowSpan);
          if (crossed || !covers(ci, i - 1) || !covers(ci, i)) continue;
          const el = document.createElement("div");
          el.className = "echo-div echo-div-h";
          el.style.top = `${y0 + pre(rh, i) * H - 4}px`;
          el.style.left = `${segLeft}px`;
          el.style.width = `${segWidth}px`;
          wire(el, true, i, ci);
          dividerLayer().appendChild(el);
        }
      });
    }
    /** Slideable seams for the FLOW (accumulated panels) — the grid's
     *  dividers, driving flowColFr/flowRowFr instead of the layout's fracs.
     *  Same visuals (.echo-div), same live no-anim reshape. */
    const paintFlowDividers = (cards: TileEntry[] | null): void => {
      dividerLayer().innerHTML = "";
      if (!cards || cards.length < 2) return;
      // MUST mirror flowRects EXACTLY — the seams sit in the gaps between
      // the band-placed cards, not in stage coordinates.
      const band = buildBand();
      const gap = 7;
      const cols = flowColumns(cards);
      syncFlowFracs(cols);
      const cwFr = normFr(flowColFr);
      const availW = band.width - gap * (cols.length - 1);
      const w = band.width, h = band.height;
      const wireFlow = (el: HTMLElement, horiz: boolean, idx: number, colIdx: number): void => {
        el.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const startPos = horiz ? ev.clientY : ev.clientX;
          const fr = horiz ? flowRowFr.get(colIdx) : flowColFr;
          if (!fr) return;
          const total = fr.reduce((x, y) => x + y, 0) || 1;
          const a0 = fr[idx - 1], b0 = fr[idx];
          const span = horiz ? h : w;
          document.body.classList.add("wb-mouse-drag");
          cardsLayer.classList.add("echo-no-anim");
          const onMove = (m: MouseEvent): void => {
            const d = ((horiz ? m.clientY : m.clientX) - startPos) / span * total;
            const min = total * 0.08;
            fr[idx - 1] = Math.max(min, Math.min(a0 + b0 - min, a0 + d));
            fr[idx] = a0 + b0 - fr[idx - 1];
            layoutCards();
          };
          const onUp = (): void => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            document.body.classList.remove("wb-mouse-drag");
            cardsLayer.classList.remove("echo-no-anim");
          };
          document.addEventListener("mousemove", onMove);
          document.addEventListener("mouseup", onUp);
        });
      };
      let x = band.left;
      cols.forEach((col, ci) => {
        const colW = availW * cwFr[ci];
        if (ci > 0) {
          const el = document.createElement("div");
          el.className = "echo-div echo-div-v";
          el.style.left = `${x - gap + (gap - 8) / 2}px`;
          el.style.top = `${band.top}px`;
          el.style.height = `${h}px`;
          wireFlow(el, false, ci, 0);
          dividerLayer().appendChild(el);
        }
        const rhFr = normFr(flowRowFr.get(ci) ?? col.map(() => 1));
        const availH = h - gap * (col.length - 1);
        let y = band.top;
        col.forEach((_e, ri) => {
          const cellH = availH * rhFr[ri];
          if (ri > 0) {
            const el = document.createElement("div");
            el.className = "echo-div echo-div-h";
            el.style.top = `${y - gap + (gap - 8) / 2}px`;
            el.style.left = `${x}px`;
            el.style.width = `${colW}px`;
            wireFlow(el, true, ri, ci);
            dividerLayer().appendChild(el);
          }
          y += cellH + gap;
        });
        x += colW + gap;
      });
    };
    /** Terminals PARKED when their layout let go (nav-away, replace, reset):
     *  the pty and the xterm buffer stay alive — a CLI agent mid-run keeps
     *  running — and reopening the same layout cell re-attaches instead of
     *  spawning fresh. Keyed by layout::memKey. Explicit ✕ still kills. */
    const parkedTerms = new Map<string, TermSlot>();
    /** Handoff for ONE activateTile call: the parked slot whose live
     *  terminals the fresh slot must adopt. activateTile builds the slot and
     *  renders it in the same breath, so the swap has to happen in there —
     *  setting it on the entry afterwards was too late (the shell had
     *  already spawned) and the parked pty was orphaned. */
    let pendingParkedTerms: TermSlot | null = null;
    // A layout's Browser cell carries its start URL — stamp it on the slot
    // BEFORE the preview renders (adopted below, like a parked terminal), or
    // previewTabs seeds the first tab empty and paintFrames fills it with the
    // Settings browser-home default instead of the workspace's page.
    let pendingPreviewUrl: string | null = null;
    function closeCard(e: TileEntry, opts?: { parkTerms?: boolean; keepSession?: boolean }): void {
      const card = e.card;
      if (!card) return;
      // The AGENT card IS the session. Closing it must un-current that session
      // for its space — the card path bypasses closeSlot entirely, which is
      // why closing on web left the session as the tab's resume target.
      // keepSession: the agent was DOCKED (parked out to .code-root) — the card
      // is an empty husk, the session lives on in the dock. Never forget it.
      if (!opts?.keepSession && (e.tile.kind === "agent" || card.querySelector(".ws-agent-placeholder"))) {
        (window as unknown as { __glyphhForgetSession?: () => void }).__glyphhForgetSession?.();
      }
      // The agent is NEVER inside a card now (it lives in the overlay layer and
      // only FOLLOWS a placeholder), so closing an agent card just drops the
      // placeholder — the reconciler parks the agent home on the next frame.
      // Only a stray composer (adopted onto a Home landing that is going away)
      // must be reclaimed while the card is still attached.
      if (card.querySelector(".ws-agent-placeholder")) scheduleAgentSync();
      if (card.querySelector(".code-composer")) (window as unknown as { __adoptComposerHome?: () => void }).__adoptComposerHome?.();
      e.card = undefined;
      e.open = false;
      // WEB: stop the desktop-side page + socket NOW — the card's DOM lingers
      // 380ms for the zoom-back, but the stream has no business outliving the
      // close click.
      e.streamed?.dispose();
      e.streamed = undefined;
      drawTile(e);
      const idx = openList.indexOf(e);
      if (idx >= 0) openList.splice(idx, 1);
      scheduleWallSave();   // the open set changed — persist it
      if (echoGrid) {
        // The freed slot becomes a HOLE — the next open fills it first.
        const freed = echoGrid.cells.find((c) => c.entry === e);
        if (freed) gridHoles.push({ col: freed.col, row: freed.row, colSpan: freed.colSpan, rowSpan: freed.rowSpan });
        echoGrid.cells = echoGrid.cells.filter((c) => c.entry !== e);
        if (!echoGrid.cells.length) { echoGrid = null; gridHoles = []; }
      }
      if (e.tile.slug && card.querySelector("webview")) rpaYo().rpaUnregister?.(e.tile.slug);
      notifyOpenApps();
      // zoom BACK to the tile's spot (wherever the camera has it now)
      setRect(card, iconRect(e) ?? centerRect());
      card.classList.remove("placed");
      card.style.pointerEvents = "none";
      const toolSlot = e.toolSlot;
      e.toolSlot = undefined;
      // Captured NOW — by the time the deferred teardown runs, the incoming
      // layout may already own echoLayoutName.
      const parkKey = opts?.parkTerms && echoLayoutName && e.memKey && e.keepTermsAlive !== false
        ? `${echoLayoutName.toLowerCase()}::${e.memKey}` : null;
      window.setTimeout(() => {
        // sections are SINGLETONS — park the page back to its pen before
        // the card's DOM goes away (same contract as parkSections). The
        // composer was already reclaimed synchronously above; the finally's
        // rescueStrayComposer backstops anything that re-entered since.
        try {
          const pen = document.getElementById("page-body");
          card.querySelectorAll<HTMLElement>(".help-section.wb-hosted").forEach((sec) => {
            sec.classList.remove("active", "wb-hosted");
            pen?.appendChild(sec);
          });
          if (toolSlot?.view === "terminal") {
            if (parkKey) {
              // keep pty + xterm wired (offscreen writes land in the buffer);
              // only the per-host ResizeObservers go
              for (const t of toolSlot.terminals) t.ro?.disconnect();
              parkedTerms.set(parkKey, toolSlot);
            } else {
              for (const t of toolSlot.terminals) { try { killTerminal(t); } catch { /* pty already gone */ } }
            }
          }
        } finally {
          // NEVER destroy the composer with the card — if a Home landing card
          // is going away with the footer still adopted into it, move it home
          // by direct reference (document queries go blind on a detached card).
          rescueStrayComposer(card);
          card.remove();   // NEVER leave a zombie card
        }
      }, 380);
      if (!openList.length) setShadow(false, false);
      layoutCards();
    }
    /** B1: close a LAYOUT as one unit — tear down every open card that shares
     *  the given layoutId (or the active layout's id when none is passed), then
     *  drop the grid state so the surface falls back to the command center (B4).
     *  Layout terminals with "Maintain on close" are parked, same as a nav-away.
     */
    function closeLayoutGroup(layoutId?: string): void {
      const id = layoutId ?? activeLayoutId;
      if (!id) return;
      saveEchoLayoutMem();   // a "last" layout remembers its panels through a close
      for (const x of [...openList]) {
        if (x.layoutId === id) closeCard(x, { parkTerms: true });
      }
      // If nothing outside the layout remained, the grid is gone — clear its
      // state so a fresh open starts clean and the wall/command center returns.
      if (!openList.length) {
        echoGrid = null;
        gridHoles = [];
        echoLayoutName = null;
        echoActiveLayout = null;
        activeLayoutId = null;
        setShadow(false, false);
      }
      layoutCards();
    }
    /** The card shell every open shares: head (name / expand / close), a
     *  body, the zoom-up-from-the-tile entrance. Echo is a BINARY mode —
     *  nothing opened here ever lands in the standard layout. */
    const centerRect = (): { left: number; top: number; width: number; height: number } => ({
      left: (stage.clientWidth || 300) / 2 - 60, top: (stage.clientHeight || 200) / 2 - 40, width: 120, height: 80,
    });
    const openShell = (e: TileEntry): HTMLElement | null => {
      if (e.card) { flash(e.card); return null; }
      // An EXPANDED card is full-stage at z 2 — a new card would open
      // invisibly behind it ("clicked and nothing happened"). Collapse it;
      // the surface reflows to show both.
      cardsLayer.querySelectorAll<HTMLElement>(".echo-card.expanded").forEach((c) => collapseCard(c));
      const card = document.createElement("div");
      card.className = "echo-card";
      card.innerHTML = `<div class="echo-card-head"><span></span>
          <button class="ws-icon-btn echo-card-expand" title="Expand">${EXPAND_SVG}</button>
          <button class="ws-icon-btn echo-card-close" title="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button>
        </div><div class="echo-card-body"></div>`;
      card.querySelector("span")!.textContent = e.tile.name;
      const expandBtn = card.querySelector<HTMLElement>(".echo-card-expand")!;
      expandBtn.addEventListener("click", () => {
        if (card.classList.contains("expanded")) { collapseCard(card); layoutCards(); return; }
        card.classList.add("expanded");
        // The stage belongs to this card alone now: siblings hide entirely
        // (webviews composite over any z-index — bleed-through otherwise).
        cardsLayer.classList.add("has-expanded");
        card.style.zIndex = "2";
        expandBtn.innerHTML = COLLAPSE_SVG;
        expandBtn.title = "Collapse";
        layoutCards();
      });
      card.querySelector(".echo-card-close")!.addEventListener("click", () => closeCard(e));
      // Pop-out — same rule as the rail-slot header: web panels (http apps,
      // the Browser) can leave the app for a standalone OS window.
      // Glyphh apps stay (their file:// entry needs in-app webview caps).
      const canPop = e.tile.toolView === "preview"
        || (e.tile.kind === "app" && !e.tile.glyphh && /^https?:\/\//i.test(e.tile.url || ""));
      if (canPop) {
        const popBtn = document.createElement("button");
        popBtn.className = "ws-icon-btn echo-card-popout";
        popBtn.title = "Pop out — its own window";
        popBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
        card.querySelector(".echo-card-head")!.insertBefore(popBtn, card.querySelector(".echo-card-expand"));
        popBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const yo = (window as unknown as { glyphh?: { panelPopout?: (r: { kind: "url"; url?: string; title?: string }) => Promise<{ ok: boolean; error?: string }> } }).glyphh;
          if (!yo?.panelPopout) return;
          const url = e.tile.toolView === "preview"
            ? ((e.toolSlot as PreviewSlot | undefined)?.url || "")
            : (e.tile.url || "");
          if (!/^https?:\/\//i.test(url)) return;
          void yo.panelPopout({ kind: "url", url, title: e.tile.name });
          closeCard(e);
        });
      }
      wireCardDrag(e, card, card.querySelector<HTMLElement>(".echo-card-head")!);
      card.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();   // the slot menu would close the ECHO PANEL
        document.querySelector(".ws-tab-ctx-menu")?.remove();
        const menu = document.createElement("div");
        menu.className = "ws-tab-ctx-menu";
        const dismiss = (): void => {
          menu.remove();
          document.removeEventListener("mousedown", onAway, true);
          document.removeEventListener("keydown", onEsc, true);
        };
        const onAway = (me: MouseEvent): void => { if (!menu.contains(me.target as Node)) dismiss(); };
        const onEsc = (ke: KeyboardEvent): void => { if (ke.key === "Escape") dismiss(); };
        const mkItem = (label: string, onPick: () => void): void => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "ws-tab-ctx-item";
          btn.textContent = label;
          btn.addEventListener("click", () => { dismiss(); onPick(); });
          menu.appendChild(btn);
        };
        mkItem(e.tile.sticky ? "Unpin panel" : "Pin panel (apps land here)", () => {
          e.tile.sticky = !e.tile.sticky;
          layoutCards();
        });
        mkItem("Close panel", () => closeCard(e));
        mkItem("Close all panels", () => { for (const x of [...openList]) closeCard(x); });
        menu.style.left = `${ev.clientX}px`;
        menu.style.top = `${ev.clientY}px`;
        document.body.appendChild(menu);
        const mr = menu.getBoundingClientRect();
        if (mr.right > window.innerWidth - 8) menu.style.left = `${window.innerWidth - mr.width - 8}px`;
        if (mr.bottom > window.innerHeight - 8) menu.style.top = `${window.innerHeight - mr.height - 8}px`;
        document.addEventListener("mousedown", onAway, true);
        document.addEventListener("keydown", onEsc, true);
      });
      // DRAG the card by its head into another slot — the list reorders and
      // every card animates to its new rect (the transitions do the motion).
      const head = card.querySelector<HTMLElement>(".echo-card-head")!;
      head.addEventListener("mousedown", (ev) => {
        if (ev.button !== 0) return;
        if ((ev.target as HTMLElement).closest("button")) return;
        if (card.classList.contains("expanded")) return;
        ev.preventDefault();
        const r0 = card.getBoundingClientRect();
        const stageR = stage.getBoundingClientRect();
        const offX = ev.clientX - r0.left, offY = ev.clientY - r0.top;
        let dragMoved = false;
        const onMove = (mv: MouseEvent): void => {
          if (!dragMoved && Math.abs(mv.clientX - ev.clientX) + Math.abs(mv.clientY - ev.clientY) < 5) return;
          dragMoved = true;
          card.classList.add("dragging");
          card.style.left = `${mv.clientX - stageR.left - offX}px`;
          card.style.top = `${mv.clientY - stageR.top - offY}px`;
        };
        const onUp = (mv: MouseEvent): void => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          if (!dragMoved) return;
          card.classList.remove("dragging");
          const px = mv.clientX - stageR.left, py = mv.clientY - stageR.top;
          // GRID cards live in SLOTS — dropping on another slot SWAPS the two
          // cells (the old layout manager's move); flow cards reorder.
          const grid = gridRects();
          if (grid && echoGrid && grid.has(e)) {
            let target: TileEntry | null = null;
            let bestD = Infinity;
            for (const [entry, rc] of grid) {
              if (entry === e) continue;
              const d = Math.hypot(rc.left + rc.width / 2 - px, rc.top + rc.height / 2 - py);
              if (d < bestD) { bestD = d; target = entry; }
            }
            const a = echoGrid.cells.find((c) => c.entry === e);
            const b = target ? echoGrid.cells.find((c) => c.entry === target) : null;
            if (a && b) {
              [a.col, b.col] = [b.col, a.col];
              [a.row, b.row] = [b.row, a.row];
              [a.colSpan, b.colSpan] = [b.colSpan, a.colSpan];
              [a.rowSpan, b.rowSpan] = [b.rowSpan, a.rowSpan];
              saveEchoLayoutMem();
            }
            layoutCards();
            return;
          }
          const from = openList.indexOf(e);
          const rects = [...flowRects(openList).values()];
          let to = from, best = Infinity;
          rects.forEach((rc, i) => {
            const d = Math.hypot(rc.left + rc.width / 2 - px, rc.top + rc.height / 2 - py);
            if (d < best) { best = d; to = i; }
          });
          if (from >= 0 && to !== from) openList.splice(to, 0, ...openList.splice(from, 1));
          layoutCards();
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
      setShadow(false, false);
      setRect(card, iconRect(e) ?? centerRect());   // start AT the tile
      cardsLayer.appendChild(card);
      e.card = card;
      e.open = true;
      drawTile(e);
      openList.push(e);
      // Retire the wall NOW that the card is registered — setShadow() above ran
      // before this push, so cardsUp was still false when it computed. Re-run so
      // the freshly-opened card actually hides (and de-clicks) the wall.
      syncWallVisibility();
      scheduleWallSave();   // the open set changed — persist it
      // A layout with a freed slot ADOPTS the new card into that hole —
      // an accidental close is undone by just reopening something. (Layout
      // opens assign cells explicitly; never claim during one.)
      if (echoGrid && !openingLayout && gridHoles.length) {
        const hole = gridHoles.shift()!;
        echoGrid.cells.push({ entry: e, ...hole });
      }
      notifyOpenApps();
      const place = (): void => {
        if (card.classList.contains("placed")) return;
        card.classList.add("placed");
        layoutCards();
      };
      requestAnimationFrame(place);
      // rAF starves in hidden/background-throttled windows — never leave a card
      // stranded at its entrance rect
      window.setTimeout(place, 150);
      return card;
    };
    /** The ONE agent, adopted into an Echo card — the same singleton/park
     *  contract as coding slots. If the agent is already visible (a coding
     *  panel beside Echo), this is a no-op: there is never a second agent. */
    /** Every agent adoption first sends the composer HOME — the Home page
     *  may be holding the footer (adoptComposer), and adopting the agent
     *  without it would show a chat with no input. */
    /** The agent is the bottom composer by default — no card, no seat. The
     *  old "open the agent" paths land here: make sure a session is live and
     *  focus the input. Returns null (there is no tile entry to place). */
    const openAgentCard = (): TileEntry | null => {
      (window as unknown as { __adoptComposerHome?: () => void }).__adoptComposerHome?.();
      ensureAgentSession();
      (document.getElementById("code-input") as HTMLTextAreaElement | null)?.focus();
      return null;
    };
    /** A LAYOUT's agent cell (his rule, 2026-08-18): the layout OWNS the
     *  agent — it mounts as a PANEL (an echo card holding a placeholder the
     *  overlay follows) and the CENTER composer leaves the screen while this
     *  layout is live (paintLayoutBar toggles the class). Closing the layout
     *  — or an app open that clears it (a PINNED cell captures those clicks,
     *  so pinned layouts hold on) — parks the agent home and the composer
     *  returns. */
    const openAgentPanel = (): TileEntry | null => {
      const existing = openList.find((x) => x.tile.kind === "agent");
      if (existing?.card) { ensureAgentSession(); flash(existing.card); return existing; }
      const entry = adHoc({ name: "Glyphh", slug: "glyphh-agent", kind: "agent" });
      const card = openShell(entry);
      if (!card) return null;
      card.classList.add("echo-agent-card");
      card.querySelector<HTMLElement>(".echo-card-body")!.innerHTML =
        `<div class="ws-agent-placeholder" data-agent-host="echo"></div>`;
      scheduleAgentSync();
      ensureAgentSession();
      return entry;
    };
    /** The agent NEVER lands on a blank panel. A session with real content
     *  wins, else the newest one, else a fresh session — and the thread is
     *  ALWAYS repainted, so an empty session shows the branded landing (the
     *  mark + slogan) rather than nothing.
     *
     *  The store loads async: if the bridge isn't up yet (boot opens the card
     *  first), retry instead of silently doing nothing — that race is exactly
     *  how a truly empty panel appeared. */
    type Sessions = {
      list?: () => Array<{ id: string; createdAt: number }>;
      currentId?: () => string | null;
      switch?: (id: string) => void;
      startNew?: () => void;
      repaint?: () => void;
    };
    const ensureAgentSession = (tries = 0): void => {
      const sess = (window as unknown as { __agentSessions?: Sessions }).__agentSessions;
      if (!sess?.list) {
        if (tries < 60 && body.isConnected) requestAnimationFrame(() => ensureAgentSession(tries + 1));
        return;
      }
      // With LAZY session creation an EMPTY current is a deliberate state —
      // the "new" landing; nothing exists until the user types. The card
      // only repaints. (It used to adopt the newest session with content,
      // which hijacked a pending new and cross-bred the spaces: a Work send
      // landed inside the last Chat thread.)
      sess.repaint?.();
    };
    /** A LAYOUT opened inside Echo: every cell becomes an Echo card, in the
     *  layout's reading order. The agent cell adopts the singleton (or is
     *  skipped when the agent is already on screen). */
    const openLayoutInEcho = (layout: LayoutRow): void => {
      // The layout's FOLDER leads the open — same contract as the standard
      // path: switch first, arrange after, so terminals and workspace panels
      // spawn rooted in the layout's folder instead of wherever cwd last was.
      if (layout.folder && layout.folder !== cwd) {
        const folder = layout.folder;
        void window.wb.setCwd(folder)
          .catch(() => { /* folder gone — open in place */ })
          .then(() => {
            cwd = folder;
            void paintWorkdirBar(cwd);
            openLayoutInEchoArranged(layout);
          });
        return;
      }
      openLayoutInEchoArranged(layout);
    };
    const openLayoutInEchoArranged = (layout: LayoutRow): void => {
      // The layout REPLACES the echo arrangement — cards sit at the layout's
      // own grid (colWidths/rowHeights/spans), pins carried through.
      openingLayout = true;
      // HIS RULE needs the answer BEFORE the teardown empties openList: was
      // a layout live when this switch started? (A switch FROM a layout
      // clears the whole surface, the visible agent included, below.)
      const wasInLayout = activeLayoutId != null || echoLayoutName != null || openList.some((x) => x.layoutId != null);
      try {
        // the OUTGOING layout remembers what its panels were doing (last
        // page, open files, browser tabs) — capture before the teardown
        saveEchoLayoutMem();   // the OUTGOING layout's save runs under ITS contract
        // B3: OPEN = WIPE-THEN-MOUNT — a layout open first tears down whatever
        // is up (the previous layout AND any standalone apps), so only the new
        // layout's panels remain.
        for (const x of [...openList]) closeCard(x, { parkTerms: true });
        echoLayoutName = layout.name || null;
        scheduleWallSave();   // a layout is now the wall's state — persist its name
        echoActiveLayout = echoLayoutName ? { name: echoLayoutName, mode: layout.sessionMode ?? "keep" } : null;
        // B1: mint the shared id for every panel THIS open fans out.
        activeLayoutId = `layout-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        interface EchoLayoutMem { sig?: string; colWidths?: number[]; rowFracs?: number[][]; rowHeights?: number[]; cells?: Array<{ key: string; col?: number; row?: number; colSpan?: number; rowSpan?: number; state?: EchoCellState }> }
        let mem: EchoLayoutMem | null = null;
        echoLayoutSig = layoutSig(layout);
        try {
          const raw = echoLayoutName ? localStorage.getItem(echoMemKey(echoLayoutName)) : null;
          if (raw) mem = JSON.parse(raw) as EchoLayoutMem;
          // Memory from a DIFFERENT shape is not this layout's memory. (A
          // pre-signature memory has no sig at all — treat it the same way:
          // the definition is the truth, and the next save re-earns it.)
          if (mem && mem.sig !== echoLayoutSig) mem = null;
        } catch { mem = null; }
        const seenKeys = new Map<string, number>();
        const cells = [...layout.splits].sort((a, b) => (a.row - b.row) || (a.col - b.col));
        // (The anchor battle is GONE with the anchor system — the center
        // agent stays on screen through a layout; agent cells are skipped.)
        if (wasInLayout && codingHosted()) closeAllOfView("coding");
        const gridCells: Array<{ entry: TileEntry; col: number; row: number; colSpan: number; rowSpan: number }> = [];
        for (const cell of cells) {
          const id = (cell.panelId || "").trim().toLowerCase();
          if (!id) continue;
          // the memKey this cell WILL get — the remembered state must shape
          // the card at creation (a web card mounts on its saved page)
          const pendingKey = `${id}#${(seenKeys.get(id) ?? 0) + 1}`;
          const saved = mem?.cells?.find((c) => c.key === pendingKey);
          // state only comes back under the "last" contract
          const st = (layout.sessionMode ?? "keep") === "last" ? saved?.state : undefined;
          let entry: TileEntry | null = null;
          if (id.startsWith("tool:")) {
            const v = id.slice(5) === "editor" ? "monaco" : id.slice(5);
            // The agent cell mounts the agent as a PANEL — the layout owns
            // it, and the center composer steps off screen until the layout
            // lets go.
            if (v === "coding") entry = openAgentPanel();
            else if (v === "files" || v === "terminal" || v === "monaco" || v === "diff" || v === "preview" || v === "plan" || v === "releases") {
              entry = adHoc({ name: VIEW_META[v].title, slug: v, kind: "tool", toolView: v, sticky: cell.sticky });
              // A PARKED terminal (this same layout cell, closed by nav-away)
              // re-attaches: same pty, same buffer, the CLI agent inside
              // never stopped. Fresh slots get the DEFINITION's app setup
              // (snapshots keep geometry, not configs) — the spawn is
              // rAF-deferred, so initCmd set here lands before the shell.
              const parkKey = `${(layout.name || "").toLowerCase()}::${pendingKey}`;
              const parked = v === "terminal" ? parkedTerms.get(parkKey) : undefined;
              if (parked) {
                parkedTerms.delete(parkKey);
                pendingParkedTerms = parked;   // activateTile adopts it
              }
              // the DEFINITION says whether this terminal survives the
              // layout closing ("Maintain on close", default yes)
              if (v === "terminal") entry.keepTermsAlive = cell.config?.keepAlive !== false;
              // The Browser cell's configured page must be on the slot BEFORE
              // it renders (adopted in activateTile), else the first tab seeds
              // empty and falls back to the Settings browser-home default.
              if (v === "preview" && cell.config?.url) pendingPreviewUrl = cell.config.url;
              activateTile(entry);
              pendingParkedTerms = null;   // never leak into the next cell
              pendingPreviewUrl = null;    // ditto
              if (v === "terminal" && cell.config?.cmd && !parked) {
                const ts = entry.toolSlot as unknown as { terminals?: Array<{ initCmd?: string }> } | undefined;
                if (ts?.terminals?.[0]) ts.terminals[0].initCmd = cell.config.cmd;
              }
            }
          } else {
            const wallTile = findTile(id)?.tile;
            const row = wallTile ? null : echoRows.find((a) => a.id.toLowerCase() === id || (a.slug || "").toLowerCase() === id);
            let base: EchoTile | null = wallTile
              ? { ...wallTile, sticky: cell.sticky }
              : row && (row.url || row.appArchetype === "glyphh-app")
                ? { name: row.name, slug: (row.slug || row.id).toLowerCase(), url: row.url || undefined, glyphh: row.appArchetype === "glyphh-app" || undefined, sticky: cell.sticky, kind: "app" }
                : null;
            // reopen on the page the user was on, not the app's front door
            if (base?.url && st?.url) base = { ...base, url: st.url };
            if (base) {
              entry = adHoc(base);
              activateTile(entry);
            }
          }
          if (entry?.card) {
            seenKeys.set(id, (seenKeys.get(id) ?? 0) + 1);
            entry.memKey = pendingKey;
            // B1/B2: this card belongs to the layout being opened.
            entry.layoutId = activeLayoutId ?? undefined;
            // the editor gets its files back (contents re-read from disk)
            if (st?.files?.length && entry.toolSlot?.view === "monaco") {
              const m = entry.toolSlot as MonacoSlot;
              m.tabs = st.files.map((f) => ({ name: f.name, path: f.path, content: "", ...(f.mode ? { mode: f.mode } : {}) }));
              m.activeIdx = Math.min(st.activeIdx ?? 0, m.tabs.length - 1);
              const ent = entry;
              void Promise.all(m.tabs.map(async (t) => {
                try {
                  const r = await window.wb.readFile(t.path);
                  t.content = r.error ? `// error: ${r.error}` : r.content;
                } catch { /* file gone — the tab shows empty */ }
              })).then(() => rerenderToolBody(ent));
            }
            // the Browser gets its tabs back
            if (st?.tabs?.length && entry.toolSlot?.view === "preview") {
              const pv = entry.toolSlot as PreviewSlot;
              pv.tabs = st.tabs.map((t) => ({ id: 0, url: t.url, ...(t.title ? { title: t.title } : {}) }));
              pv.activeTab = Math.min(st.activeTab ?? 0, pv.tabs.length - 1);
              pv.url = pv.tabs[pv.activeTab]?.url;
              rerenderToolBody(entry);
            }
            // remembered SLOT for this panel (swaps persist), layout default otherwise
            const g = saved && saved.col != null ? saved : null;
            gridCells.push({
              entry,
              col: g?.col ?? cell.col ?? 0,
              row: g?.row ?? cell.row ?? 0,
              colSpan: Math.max(1, g?.colSpan ?? cell.colSpan ?? 1),
              rowSpan: Math.max(1, g?.rowSpan ?? cell.rowSpan ?? 1),
            });
          }
        }
        if (gridCells.length) {
          const nCols = Math.max(layout.cols || 0, ...gridCells.map((c) => c.col + c.colSpan));
          const nRows = Math.max(layout.rows || 0, ...gridCells.map((c) => c.row + c.rowSpan));
          // every column starts from the layout's row shape, then owns its
          // fractions independently (legacy flat rowHeights memory expands)
          const baseRow: number[] = (mem?.rowHeights?.length === nRows ? mem.rowHeights.slice()
            : layout.rowHeights?.length === nRows ? layout.rowHeights.slice()
            : Array.from({ length: nRows }, () => 1));
          const memFracs = mem?.rowFracs;
          const fracsOk = Array.isArray(memFracs) && memFracs.length === nCols
            && memFracs.every((r) => Array.isArray(r) && r.length === nRows);
          gridHoles = [];
          echoGrid = {
            colWidths: mem?.colWidths?.length === nCols ? mem.colWidths.slice()
              : layout.colWidths?.length === nCols ? layout.colWidths.slice()
              : Array.from({ length: nCols }, () => 1),
            rowFracs: fracsOk ? memFracs!.map((r) => r.slice())
              : Array.from({ length: nCols }, () => baseRow.slice()),
            cells: gridCells,
          };
          layoutCards();
        }
        // The layout's SESSION contract: "new" starts fresh, "last" resumes
        // the session that rode this layout (remembered on every session
        // change below), "keep" rides whatever is current.
        {
          type SessionsApi = { list(): Array<{ id: string }>; currentId(): string | null; switch(id: string): void; startNew(): void; stampWorkdir?(dir: string): void; stampModels?(models: Record<string, string>): void; stampLoop?(loop: string): void };
          const sess = (window as unknown as { __agentSessions?: SessionsApi }).__agentSessions;
          const space = activateLayoutSpace(layout);
          const mode = layout.sessionMode ?? "keep";
          // The layout's MODEL SLOTS bind to ITS session (his rule, 2026-08-20):
          // stamped after the session resolves below, so five open layouts run
          // five independent casts — never through the shared loop store alone.
          const stampLayoutModels = (): void => {
            if (layout.loop) sess?.stampLoop?.(layout.loop);
            if (layout.modelSelections && Object.keys(layout.modelSelections).length) sess?.stampModels?.(layout.modelSelections);
          };
          if (sess && mode === "new") {
            sess.startNew();
          } else if (sess && mode === "last" && layout.name) {
            let last: string | null = null;
            try {
              last = localStorage.getItem(layoutSessionKey(layout.name, space))
                ?? localStorage.getItem(layoutSessionKeyLegacy(layout.name));
            } catch { last = null; }
            // resume ONLY a session that belongs to THIS space — the same
            // layout opened from another tab rode a different conversation
            const target = last ? sess.list().find((c) => c.id === last) : undefined;
            const spaceOfMode = (m?: string): string => (m === "code" ? "code" : m === "chat" ? "chat" : "cowork");
            if (target && spaceOfMode((target as { mode?: string }).mode) === space) {
              if (sess.currentId() !== target.id) sess.switch(target.id);
            } else {
              sess.startNew();
            }
          }
          stampLayoutModels();
          // the layout's folder rides the session, same as standard mode
          if (sess && layout.folder) sess.stampWorkdir?.(layout.folder);
        }
      } finally {
        openingLayout = false;
      }
    };
    /** Every tile opens IN ECHO: web apps as live webviews with the browser
     *  bar; tool panels as the REAL panel renderers; nav pages by adopting
     *  their section singleton (parked back on close). */
    /** A card's address bar honors the Settings default (showAppUrlBar), with
     *  the SAME per-panel header toggle the rail slots carry. Re-mounts (pin
     *  retargets) rebuild the button so its closure tracks the live chrome. */
    const wireCardUrlBar = (card: HTMLElement, chrome: HTMLElement): void => {
      chrome.style.display = urlBarHiddenDefault() ? "none" : "";
      const head = card.querySelector<HTMLElement>(".echo-card-head");
      if (!head) return;
      head.querySelector(".slot-urltoggle")?.remove();
      const btn = document.createElement("button");
      btn.className = `ws-icon-btn slot-urltoggle${urlBarHiddenDefault() ? "" : " active"}`;
      btn.title = "Address bar";
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;
      btn.addEventListener("click", () => {
        const nowHidden = chrome.style.display !== "none";
        chrome.style.display = nowHidden ? "none" : "";
        btn.classList.toggle("active", !nowHidden);
      });
      head.insertBefore(btn, head.querySelector(".echo-card-expand"));
    };
    /** Build an app's live content (webview + browser bar) into a card. */
    const mountAppIntoCard = (e: TileEntry, card: HTMLElement): void => {
      const t = e.tile;
      if (isWebTarget()) {
        // WEB: a card's <webview> is inert in a browser — the interior is a
        // STREAMED panel from the user's desktop (hosted Glyphh apps render
        // as a plain iframe). Same card, same chrome, different transport.
        const body = card.querySelector(".echo-card-body")!;
        if (t.glyphh && t.slug) {
          // A DEPLOYED Glyphh app renders in-browser from its public host. An
          // app with no deployment exists only on the user's desktop — there
          // is nothing at the hosted URL, and the old unconditional iframe
          // dead-ended in a blank rectangle with none of the state cards the
          // streamed panels show. Same family of problem → the SAME card.
          if (!t.url) { body.appendChild(mountGlyphhAppWebState(t.name)); return; }
          const frame = document.createElement("iframe");
          // SANDBOX GATE (app-runtime spec): scripts + own-origin fetches
          // only — no popups, no top navigation, no escape into the host.
          // (Content is cross-origin, so allow-same-origin can't unsandbox.)
          frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
          // The SERVER owns the app's reachable address (prodUrl): the brand
          // origin in prod, the /hosted dev route locally. Hardcoding the
          // brand origin here iframed the edge's no-match page on dev.
          const appUrl = t.url;
          frame.src = appUrl;
          frame.style.cssText = "flex:1;min-height:0;width:100%;border:0;background:var(--bg-2)";
          body.appendChild(frame);
          // Same chrome + Settings default as every other app card (the bar
          // was skipped here entirely, so the showAppUrlBar setting read as
          // ignored for glyphh apps). Cross-origin iframes can't drive
          // history, so back/forward are inert; reload re-sets src.
          const glyphhAdapter = {
            loadURL: (u: string) => { frame.src = u; },
            goBack: () => {},
            goForward: () => {},
            reload: () => { frame.src = frame.src; },
            canGoBack: () => false,
            canGoForward: () => false,
            getURL: () => appUrl,
            addEventListener: () => {},
          } as unknown as WebviewEl;
          if (!t.workbench) {
            const { chrome: gChrome, urlbar: gUrlbar } = buildAppChrome(glyphhAdapter, () => appUrl);
            gUrlbar.value = appUrl;
            card.querySelector(".echo-card-head")!.after(gChrome);
            wireCardUrlBar(card, gChrome);
          }
          return;
        }
        const url = t.url || "https://www.google.com";
        const navTarget = new EventTarget();
        const streamed = mountStreamedPanel({
          url,
          onNav: (u) => { if (u) t.url = u; navTarget.dispatchEvent(Object.assign(new Event("did-navigate"), { url: u })); },
        });
        e.streamed = streamed;
        const adapter = {
          loadURL: (u: string) => streamed.navigate(u),
          goBack: () => streamed.back(),
          goForward: () => streamed.forward(),
          reload: () => streamed.reload(),
          canGoBack: () => true,
          canGoForward: () => true,
          getURL: () => streamed.currentUrl(),
          addEventListener: (type: string, fn: EventListener) => navTarget.addEventListener(type, fn),
        } as unknown as WebviewEl;
        streamed.el.style.flex = "1";
        streamed.el.style.minHeight = "0";
        body.appendChild(streamed.el);
        const { chrome, urlbar } = buildAppChrome(adapter, () => t.url || url);
        urlbar.value = t.url || url;
        card.querySelector(".echo-card-head")!.after(chrome);
        wireCardUrlBar(card, chrome);
        return;
      }
      {
        const wv = document.createElement("webview");
        wv.setAttribute("partition", "persist:yo");
        wv.setAttribute("allowpopups", "true");
        wv.addEventListener("did-fail-load", (ev) => {
          const err = ev as unknown as { errorCode?: number; errorDescription?: string; validatedURL?: string; isMainFrame?: boolean };
          if (!isRealLoadFailure(err.errorCode) || err.isMainFrame === false) return;
          console.warn(`[echo] "${t.name}" failed to load (${err.errorCode} ${err.errorDescription || ""})`);
          showBrowserError(wv, {
            url: err.validatedURL || t.url || "",
            errorCode: err.errorCode,
            description: err.errorDescription,
          });
        });
        if (t.glyphh && t.slug) {
          // Installed Glyphh app — the SAME preview-open flow as mountAppView:
          // attach on about:blank, grant caps against the guest, load the
          // on-disk entry. A failed open SAYS SO in the panel.
          wv.setAttribute("src", "about:blank");
          let previewOpened = false;
          wv.addEventListener("dom-ready", () => {
            if (previewOpened) return;
            previewOpened = true;
            const yoG = (window as unknown as { glyphh?: { glyphhAppPreviewOpen?: (slug: string, wcId?: number) => Promise<{ ok: boolean; fileUrl?: string; error?: string }>; rpaRegister?: (slug: string, wcId: number) => void } }).glyphh;
            const wcId = (wv as unknown as WebviewEl).getWebContentsId?.();
            if (wcId !== undefined) yoG?.rpaRegister?.(t.slug!, wcId);
            void yoG?.glyphhAppPreviewOpen?.(t.slug!, wcId).then((res) => {
              if (res?.ok && res.fileUrl && wv.getAttribute("src") === "about:blank") wv.setAttribute("src", res.fileUrl);
              // No local source (a marketplace-INSTALLED app lives on the
              // developer's hosting, not this disk) → open the hosted build.
              else if (!res?.ok && t.url) wv.setAttribute("src", t.url);
              else if (!res?.ok) wv.setAttribute("src", glyphhAppErrorPage(t.name, res?.error));
            });
          });
        } else {
          wv.setAttribute("src", t.url!);
        }
        wv.addEventListener("dom-ready", () => {
          const wcId = (wv as unknown as WebviewEl).getWebContentsId?.();
          if (wcId !== undefined && t.slug) rpaYo().rpaRegister?.(t.slug, wcId);
        });
        card.querySelector(".echo-card-body")!.appendChild(wv);
        if (!t.workbench) {
          const { chrome, urlbar } = buildAppChrome(wv as unknown as WebviewEl, () => t.url || "");
          urlbar.value = t.url || "";
          card.querySelector(".echo-card-head")!.after(chrome);
          wireCardUrlBar(card, chrome);
        }
      }
    };
    /** Tear a card's content down (agent/sections park, PTYs die, RPA
     *  unhooks) WITHOUT closing the card — the pin retarget reuses it. */
    const clearCardContent = (e: TileEntry, card: HTMLElement): void => {
      // An agent placeholder just drops — the overlay parks the agent home.
      if (card.querySelector(".ws-agent-placeholder")) scheduleAgentSync();
      const pen = document.getElementById("page-body");
      card.querySelectorAll<HTMLElement>(".help-section.wb-hosted").forEach((sec) => {
        sec.classList.remove("active", "wb-hosted");
        pen?.appendChild(sec);
      });
      if (e.toolSlot?.view === "terminal") for (const t of e.toolSlot.terminals) { try { killTerminal(t); } catch { /* gone */ } }
      e.toolSlot = undefined;
      // WEB: the streamed panel must be CLOSED, not just unparented — the
      // desktop keeps rendering + casting the page otherwise.
      e.streamed?.dispose();
      e.streamed = undefined;
      if (e.tile.slug && card.querySelector("webview")) rpaYo().rpaUnregister?.(e.tile.slug);
      card.querySelector(".ws-app-chrome")?.remove();
      card.querySelector<HTMLElement>(".echo-card-body")!.replaceChildren();
    };
    /** The PIN: a sticky card is where app opens LAND — replace its content
     *  in place (same slot, same grid cell), exactly the workbench pin rule. */
    const retargetCard = (pinned: TileEntry, t: EchoTile): void => {
      const card = pinned.card;
      if (!card) return;
      setShadow(false, false);   // the pick lands VISIBLE, not behind the veil
      clearCardContent(pinned, card);
      pinned.tile = { ...t, sticky: true };
      card.querySelector(".echo-card-head span")!.textContent = t.name;
      mountAppIntoCard(pinned, card);
      flash(card);
    };
    /** Build a TOOL panel (Files/Terminal/…) inside an echo card —
     *  shared by fresh opens and pin retargets. */
    const mountToolIntoCard = (e: TileEntry, card: HTMLElement): void => {
      const t = e.tile;
      if (!t.toolView || t.toolView === "coding" || t.toolView === "echo") return;
        const body = card.querySelector<HTMLElement>(".echo-card-body")!;
        body.classList.add("ws-rail-slot-body");   // the panels' own CSS scope
        // REUSE a live slot: openToolWith LANDS its payload (file/asset) on
        // e.toolSlot and remounts — minting a fresh slot here threw the landed
        // payload away every time ("Docs opens but not the doc").
        const slot = (e.toolSlot && e.toolSlot.view === t.toolView) ? e.toolSlot : makeSlot(t.toolView);
        // Adopt a PARKED terminal here, before the renderer runs: with the
        // live pty + xterm already in the slot, renderTerminalIntoSlot takes
        // its re-attach path (same process, same scrollback) instead of
        // spawning a fresh shell.
        if (slot.view === "terminal" && pendingParkedTerms) {
          slot.terminals = pendingParkedTerms.terminals;
          slot.activeIdx = pendingParkedTerms.activeIdx;
          pendingParkedTerms = null;
        }
        // Seed the Browser cell's start page onto a FRESH preview slot before
        // it renders — a live/reused slot keeps its own tabs (its own history).
        if (slot.view === "preview" && pendingPreviewUrl && !slot.url && !slot.tabs?.length) {
          slot.url = pendingPreviewUrl;
        }
        e.toolSlot = slot;
        if (slot.view === "files") void renderFilesIntoSlot(body, slot);
        else if (slot.view === "terminal") renderTerminalIntoSlot(body, slot);
        else if (slot.view === "monaco") void renderMonacoIntoSlot(body, slot);
        else if (slot.view === "diff") void renderDiffIntoSlot(body, slot);
        else if (slot.view === "preview") void renderPreviewIntoSlot(body, slot);
        else if (slot.view === "plan") void renderPlanIntoSlot(body, slot);
        else if (slot.view === "releases") void renderReleasesIntoSlot(body, slot);
        else if (slot.view === "tasks") void renderTasksIntoSlot(body, slot);
    };

    let openingLayout = false;
    /** THE RETURN RULE: clicking the Glyphh tile / ＋ New Session while the
     *  agent is ALREADY VISIBLE OUTSIDE the wall means "get me back to my
     *  agent" — close the command center, nothing else (no wall reset churn
     *  the user can see, no second agent card, no new session). The
     *  visible-agent notion is the rail-session-click one (69383cd2): a rails
     *  coding seat is up (the overlay is following it) or the anchor is docked.
     *  An agent hosted as an Echo CARD does NOT count: that click keeps the
     *  open rule below. Callers run resetEcho() before closeEchoSurface()
     *  because a bare surface close skips closeCard — an active layout would
     *  stay in the persisted wall pref (resurrecting at next boot) and its
     *  cards would die without parking; the reset closes them properly,
     *  saves the layout's memory, and persists the now-empty wall. */
    /** THE GLYPHH CLICK (his rule, 2026-08-19, supersedes the 2026-08-18
     *  new-session tie): the mark OPENS THE AGENT — full screen when the wall
     *  is bare, into the next slot beside whatever is open — and never
     *  doubles an agent a live layout already shows (that click just focuses
     *  the composer). New sessions live on ＋ alone now. */
    const activateGlyphh = (_self?: TileEntry): void => {
      const inLayout = openList.some((x) => x.layoutId != null);
      const agentShowing = openList.some((x) => x.card && x.tile.kind === "agent");
      if (inLayout && agentShowing) {
        (document.getElementById("code-input") as HTMLTextAreaElement | null)?.focus();
        return;
      }
      void openAgentPanel();
    };
    /** SAVE AS WORKSPACE — the basics only (his rule, 2026-08-20): name,
     *  loop + its model slots, session mode. The grid is derived from the
     *  CARDS ON STAGE (the flow's own columns), so what you see is what
     *  saves; the full editor on the Layouts page remains for everything
     *  else (folder, per-cell config, spans). */
    async function openSaveWorkspaceModal(): Promise<void> {
      const cards = openList.filter((e) => e.card && e.tile.slug !== "glyphh-home");
      if (!cards.length) return;
      const yo = window.glyphh as unknown as {
        loopsList?: () => Promise<{ ok?: boolean; loops?: Array<{ id: string; name: string }> }>;
        loopRoles?: (loop: string) => Promise<{ ok?: boolean; roles?: Array<{ name: string; label: string; modelId: string | null; choices: Array<{ id: string; name: string }> }> }>;
        layoutsSaveGrid?: (g: Record<string, unknown>) => Promise<boolean | { error?: string }>;
        getPreference?: (k: string, d?: unknown) => Promise<unknown>;
      };
      const [loopsRes, prefLoop] = await Promise.all([
        yo.loopsList?.().catch(() => null) ?? null,
        yo.getPreference?.("glyphhLoop", "default").catch(() => "default") ?? "default",
      ]);
      const loops = loopsRes?.loops ?? [];
      document.querySelector(".echo-savews-overlay")?.remove();
      const overlay = document.createElement("div");
      overlay.className = "echo-folder-overlay echo-savews-overlay";
      const card = document.createElement("div");
      card.className = "echo-folder-card echo-savews-card";
      overlay.appendChild(card);
      const close = (): void => { overlay.remove(); document.removeEventListener("keydown", onKey, true); };
      const onKey = (ev: KeyboardEvent): void => { if (ev.key === "Escape") { ev.stopPropagation(); close(); } };
      document.addEventListener("keydown", onKey, true);
      overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
      card.innerHTML = `
        <div class="echo-folder-head"><span class="echo-savews-title">Save as workspace</span>
          <button class="echo-folder-close" type="button" title="Close">✕</button></div>
        <div class="echo-savews-form">
          <label>Name</label>
          <input class="echo-savews-name" type="text" maxlength="60" placeholder="Morning triage" />
          <label>Loop</label>
          <select class="echo-savews-loop"></select>
          <div class="echo-savews-roles"></div>
          <label>Session</label>
          <select class="echo-savews-session">
            <option value="keep">Keep the current session</option>
            <option value="new">Start a new session</option>
            <option value="last">Resume this workspace's last session</option>
          </select>
          <div class="echo-savews-err hidden"></div>
        </div>
        <div class="echo-savews-foot">
          <button class="echo-savews-cancel" type="button">Cancel</button>
          <button class="echo-savews-go" type="button">Save workspace</button>
        </div>`;
      card.querySelector(".echo-folder-close")?.addEventListener("click", close);
      card.querySelector(".echo-savews-cancel")?.addEventListener("click", close);
      const nameEl = card.querySelector<HTMLInputElement>(".echo-savews-name")!;
      const loopEl = card.querySelector<HTMLSelectElement>(".echo-savews-loop")!;
      const rolesEl = card.querySelector<HTMLElement>(".echo-savews-roles")!;
      const errEl = card.querySelector<HTMLElement>(".echo-savews-err")!;
      nameEl.addEventListener("keydown", (ev) => ev.stopPropagation());
      const defaultLoop = String(prefLoop || "default");
      loopEl.innerHTML = (loops.length ? loops : [{ id: "default", name: "Default" }])
        .map((l) => `<option value="${l.id}"${l.id === defaultLoop ? " selected" : ""}>${l.name}</option>`).join("");
      // The chosen loop's MODEL SLOTS — a dropdown per role, seeded with the
      // resolved pick ("Auto" leaves the slot to its default).
      const paintRoles = async (): Promise<void> => {
        rolesEl.innerHTML = "";
        const r = await yo.loopRoles?.(loopEl.value).catch(() => null);
        for (const role of r?.roles ?? []) {
          const label = document.createElement("label");
          label.textContent = role.label || role.name;
          const sel = document.createElement("select");
          sel.dataset.role = role.name;
          sel.innerHTML = `<option value="">Auto</option>` + role.choices
            .map((c) => `<option value="${c.id}"${c.id === role.modelId ? " selected" : ""}>${c.name || c.id}</option>`).join("");
          rolesEl.append(label, sel);
        }
      };
      loopEl.addEventListener("change", () => { void paintRoles(); });
      void paintRoles();
      card.querySelector(".echo-savews-go")?.addEventListener("click", () => {
        void (async () => {
          const name = nameEl.value.trim();
          if (!name) { errEl.textContent = "A name is required."; errEl.classList.remove("hidden"); nameEl.focus(); return; }
          // The stage's own columns become the grid — what you see is what saves.
          const cols = flowColumns(cards);
          const rows = Math.max(1, ...cols.map((c) => c.length));
          const cells = cols.flatMap((col, ci) => col.map((e, ri) => {
            const t = e.tile;
            const panelId = t.kind === "agent" ? "tool:coding" : t.kind === "tool" && t.toolView ? `tool:${t.toolView}` : (t.slug || "");
            return {
              panelId, col: ci, row: ri, colSpan: 1,
              // A lone card in a taller grid stretches its column.
              rowSpan: col.length < rows && ri === col.length - 1 ? rows - col.length + 1 : 1,
              ...(t.kind === "tool" && t.toolView === "preview" && t.url ? { config: { url: t.url } } : {}),
            };
          })).filter((c) => c.panelId);
          const modelSelections: Record<string, string> = {};
          rolesEl.querySelectorAll<HTMLSelectElement>("select").forEach((sel) => {
            if (sel.value && sel.dataset.role) modelSelections[sel.dataset.role] = sel.value;
          });
          const session = card.querySelector<HTMLSelectElement>(".echo-savews-session")!.value;
          const res = await yo.layoutsSaveGrid?.({
            name, cols: cols.length, rows, cells,
            folderMode: "single", target: "glyphh",
            loop: loopEl.value || null,
            ...(Object.keys(modelSelections).length ? { modelSelections } : {}),
            ...(session === "new" || session === "last" ? { sessionMode: session } : {}),
          });
          if (res !== true) {
            errEl.textContent = (res as { error?: string })?.error || "Couldn't save the workspace.";
            errEl.classList.remove("hidden");
            return;
          }
          close();
          // The wall's layout tiles refresh on this (same signal an app edit fires).
          document.dispatchEvent(new CustomEvent("glyphh:apps-changed"));
        })();
      });
      document.body.appendChild(overlay);
      nameEl.focus();
    }
    /** The FOLDER MODAL: the folder's icons, 12 to a page. Click opens the
     *  member like its wall self; drag a member onto the BACKDROP to move it
     *  back out; the title renames in place; an empty folder offers Delete
     *  (standard confirm). */
    const FOLDER_PAGE_SIZE = 12;
    function openFolderModal(folderId: string): void {
      const f = folders.find((x) => x.id === folderId);
      if (!f) return;
      document.querySelector(".echo-folder-overlay")?.remove();
      const overlay = document.createElement("div");
      overlay.className = "echo-folder-overlay";
      const card = document.createElement("div");
      card.className = "echo-folder-card";
      overlay.appendChild(card);
      let page = 0;
      const close = (): void => { overlay.remove(); document.removeEventListener("keydown", onKey, true); };
      const onKey = (ev: KeyboardEvent): void => { if (ev.key === "Escape") { ev.stopPropagation(); close(); } };
      document.addEventListener("keydown", onKey, true);
      overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
      // Backdrop = OUT: dropping a member here returns it to the pages.
      overlay.addEventListener("dragover", (ev) => { if (dragIconKey && ev.target === overlay) ev.preventDefault(); });
      overlay.addEventListener("drop", (ev) => {
        if (ev.target !== overlay) return;
        ev.preventDefault();
        const group = (dragGroupKeys ?? (dragIconKey ? [dragIconKey] : [])).filter((k) => f.keys.includes(k));
        if (group.length) { for (const k of group) removeFromFolder(k, f.id); paint(); }
      });
      const paint = (): void => {
        const pages = Math.max(1, Math.ceil(f.keys.length / FOLDER_PAGE_SIZE));
        if (page >= pages) page = pages - 1;
        const slice = f.keys.slice(page * FOLDER_PAGE_SIZE, (page + 1) * FOLDER_PAGE_SIZE);
        card.innerHTML = "";
        const head = document.createElement("div");
        head.className = "echo-folder-head";
        const title = document.createElement("input");
        title.className = "echo-folder-name";
        title.value = f.name;
        title.maxLength = 40;
        title.addEventListener("change", () => {
          f.name = title.value.trim() || "Folder";
          title.value = f.name;
          persistFolders();
          refreshFolderTiles();
        });
        title.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Enter") title.blur(); });
        head.appendChild(title);
        if (!f.keys.length) {
          const del = document.createElement("button");
          del.className = "echo-folder-delete";
          del.type = "button";
          del.textContent = "Delete folder";
          del.addEventListener("click", () => {
            void (window as unknown as { __appConfirm?: (o: { title: string; body?: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean> })
              .__appConfirm?.({ title: `Delete "${f.name}"?`, body: "The folder is empty — nothing else is removed.", confirmLabel: "Delete", danger: true })
              .then((ok) => { if (ok) { deleteFolder(f.id); close(); } });
          });
          head.appendChild(del);
        }
        const x = document.createElement("button");
        x.className = "echo-folder-close";
        x.type = "button";
        x.title = "Close";
        x.textContent = "✕";
        x.addEventListener("click", close);
        head.appendChild(x);
        card.appendChild(head);
        const grid = document.createElement("div");
        grid.className = "echo-folder-grid";
        card.appendChild(grid);
        // SAME direction verbs as the wall: sweep LEFT→RIGHT on the grid
        // background to SELECT a group (drag any member to the backdrop to
        // move them all out), RIGHT→LEFT to open the selection.
        const modalSel = new Set<string>();
        const paintModalSel = (): void => {
          grid.querySelectorAll<HTMLElement>(".echo-folder-item").forEach((b) => {
            b.classList.toggle("selected", modalSel.has(b.dataset.key || ""));
          });
        };
        grid.addEventListener("pointerdown", (ev) => {
          if (ev.button !== 0 || (ev.target as HTMLElement).closest(".echo-folder-item")) return;
          const sx = ev.clientX, sy = ev.clientY;
          let lastX = sx;
          let live = false;
          let band: HTMLDivElement | null = null;
          const rects = [...grid.querySelectorAll<HTMLElement>(".echo-folder-item")]
            .map((b) => ({ key: b.dataset.key || "", r: b.getBoundingClientRect() }));
          const move = (mv: PointerEvent): void => {
            lastX = mv.clientX;
            if (!live && Math.hypot(mv.clientX - sx, mv.clientY - sy) < 6) return;
            if (!live) {
              live = true;
              band = document.createElement("div");
              band.className = "echo-marquee";
              band.style.position = "fixed";
              document.body.appendChild(band);
            }
            const L = Math.min(sx, mv.clientX), T = Math.min(sy, mv.clientY);
            const W = Math.abs(mv.clientX - sx), H = Math.abs(mv.clientY - sy);
            band!.style.left = `${L}px`; band!.style.top = `${T}px`;
            band!.style.width = `${W}px`; band!.style.height = `${H}px`;
            modalSel.clear();
            for (const { key, r } of rects) {
              if (key && !(r.right < L || r.left > L + W || r.bottom < T || r.top > T + H)) modalSel.add(key);
            }
            paintModalSel();
          };
          const up = (): void => {
            document.removeEventListener("pointermove", move);
            document.removeEventListener("pointerup", up);
            band?.remove();
            if (!live) return;
            if (!modalSel.size) { paintModalSel(); return; }
            if (lastX < sx) {
              // R→L: open every selected member, like the wall.
              const picks = [...modalSel];
              modalSel.clear();
              close();
              for (const k of picks) { const t = wallCatalog.get(k); if (t) activateTile(makeTileEntry(t)); }
            } else {
              paintModalSel();   // L→R: hold the selection for the drag out
            }
          };
          document.addEventListener("pointermove", move);
          document.addEventListener("pointerup", up);
        });
        if (!slice.length) {
          const empty = document.createElement("div");
          empty.className = "echo-folder-empty";
          empty.textContent = "Empty — drag apps or workspaces onto the folder's icon to file them.";
          grid.appendChild(empty);
        }
        for (const key of slice) {
          const t = wallCatalog.get(key);
          const btn = document.createElement("button");
          btn.className = "echo-app-btn echo-folder-item";
          btn.type = "button";
          btn.dataset.key = key;
          btn.innerHTML = `<span class="echo-app-ic"></span><span class="echo-app-name"></span>`;
          const ic = btn.querySelector<HTMLElement>(".echo-app-ic");
          const nm = btn.querySelector<HTMLElement>(".echo-app-name");
          if (t) {
            if (ic) { ic.innerHTML = iconInner(t); hydrateIcons(ic); }
            if (nm) nm.textContent = t.name;
            btn.title = t.name;
            btn.addEventListener("click", () => { close(); activateTile(makeTileEntry(t)); });
          } else {
            // The member's app/layout no longer exists — show the honest
            // remains; dragging it out (or clicking) clears the dead key.
            if (ic) ic.innerHTML = `<span class="echo-app-fallback">?</span>`;
            if (nm) nm.textContent = key.split(":").slice(1).join(":") || key;
            btn.addEventListener("click", () => { removeFromFolder(key, f.id); paint(); });
          }
          btn.draggable = true;
          btn.addEventListener("dragstart", (ev) => {
            dragIconKey = key;
            // A selected member drags the whole selection out together.
            dragGroupKeys = modalSel.has(key) && modalSel.size > 1 ? [...modalSel] : null;
            ev.dataTransfer?.setData("text/plain", key);
            if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
          });
          btn.addEventListener("dragend", () => { dragIconKey = null; dragGroupKeys = null; });
          grid.appendChild(btn);
        }
        if (pages > 1) {
          const pager = document.createElement("div");
          pager.className = "echo-folder-pager";
          const prev = document.createElement("button");
          prev.type = "button"; prev.textContent = "‹"; prev.disabled = page === 0;
          prev.addEventListener("click", () => { page = Math.max(0, page - 1); paint(); });
          const label = document.createElement("span");
          label.textContent = `${page + 1} / ${pages}`;
          const next = document.createElement("button");
          next.type = "button"; next.textContent = "›"; next.disabled = page >= pages - 1;
          next.addEventListener("click", () => { page = Math.min(pages - 1, page + 1); paint(); });
          pager.append(prev, label, next);
          card.appendChild(pager);
        }
      };
      paint();
      document.body.appendChild(overlay);
    }
    function activateTile(e: TileEntry): void {
      const t = e.tile;
      if (t.kind === "folder" && t.folderId) { openFolderModal(t.folderId); return; }
      // A NAV tile (a dock slot traded onto the pages) routes exactly like
      // its dock self — sections, tools, settings, and the glyphh mark.
      if (t.navKey) {
        const w = window as unknown as { __wbOpenSection?: (s: string) => void; __wbOpenTool?: (v: string) => void; __glyphhOpenSettings?: (sub?: string) => void; __glyphhNewSession?: () => void };
        if (t.navKey === "glyphh") w.__glyphhNewSession?.();
        else if (t.navKey === "logout") void (window as unknown as { glyphh?: { logout?: () => Promise<void> } }).glyphh?.logout?.();
        else if (t.navKey === "settings") w.__glyphhOpenSettings?.();
        else if (t.navKey === "tasks" || t.navKey === "preview") w.__wbOpenTool?.(t.navKey);
        else w.__wbOpenSection?.(t.navKey);
        return;
      }
      // HOME — the fixed first tile — and the agent tile are ONE identity
      // (Glyphh) with ONE behavior. The wall activates tiles DIRECTLY (this
      // path), not through ctl.openApp, which is why routing it only there
      // left the tile inert.
      if (t.slug === "glyphh-home" || t.kind === "agent") { activateGlyphh(e); return; }
      if (t.layoutRow) { openLayoutInEcho(t.layoutRow); return; }
      if (t.url || t.glyphh) {
        // A DEPLOYED Glyphh app is a real website at https://<slug>.glyphh.app —
        // its tile opens that URL in the BROWSER (desktop: the OS browser via
        // openExternal; web: a new tab), the same road every external link takes.
        // NO FALLBACKS (his rule, 2026-08-22): installed = built + deployed.
        // A glyphh app tile ALWAYS opens the tab — url from the row, or
        // constructed from the slug so the EDGE's honest error page shows
        // when something is genuinely wrong. No card path for apps, ever.
        if (t.glyphh) {
          // The SERVER presents the URL (the GLOBAL public_slug — the local
          // slug can differ after collision-adjustment; never construct here).
          const url = t.url && /^https?:\/\//i.test(t.url) ? t.url : null;
          if (!url) return;
          const isWeb = !!(window as unknown as { __GLYPHH_WEB__?: boolean }).__GLYPHH_WEB__;
          const ext = (window as unknown as { glyphh?: { openExternal?: (u: string) => void } }).glyphh?.openExternal;
          if (!isWeb && ext) ext(url);
          else window.open(url, "_blank", "noopener");
          return;
        }
        // pinned card wins as the landing target (never while a layout is
        // fanning out its own cells, and a pin never retargets itself)
        const pinned = openList.find((x) => x.tile.sticky && x.card && x !== e);
        if (pinned && !openingLayout) { retargetCard(pinned, t); return; }
        // B3 (his rule, 2026-08-18): a LAYOUT is live and there is NO pinned
        // slot → the click RESETS TO THE DEFAULT VIEW — the layout clears
        // (memory saved by the reset, so "last" resumes), the composer
        // returns — and the app opens as a normal centered card in the build
        // band. Every single time. Without a layout, apps ACCUMULATE into
        // the build pattern as before. NEVER during a layout fan-out
        // (openingLayout guards the cells this same function builds).
        const layoutLive = activeLayoutId != null || echoLayoutName != null || openList.some((x) => x !== e && x.layoutId != null);
        if (!openingLayout && layoutLive) resetEcho();
        const card = openShell(e);
        if (!card) return;
        mountAppIntoCard(e, card);
        return;
      }
      if (t.toolView && t.toolView !== "coding" && t.toolView !== "echo") {
        // THE SAME open rule apps follow (his rule, everywhere): a PINNED card
        // is the landing target; otherwise an active LAYOUT clears and the
        // panel opens standalone. Tools were exempt and jammed in beside
        // layout cells — Slides/Docs/Sheets/Drive/Browser are apps to the user.
        const pinnedT = openList.find((x) => x.tile.sticky && x.card && x !== e);
        if (pinnedT && !openingLayout) {
          const card = pinnedT.card!;
          setShadow(false, false);
          clearCardContent(pinnedT, card);
          pinnedT.tile = { ...t, sticky: true };
          card.querySelector(".echo-card-head span")!.textContent = t.name;
          mountToolIntoCard(pinnedT, card);
          flash(card);
          return;
        }
        if (!openingLayout && openList.some((x) => x !== e && x.layoutId != null)) resetEcho();
        const card = openShell(e);
        if (!card) return;
        mountToolIntoCard(e, card);
        return;
      }
      if (t.navApp) {
        openSectionCard(t.navApp.slug === "home" ? "dashboard" : t.navApp.slug, t.navApp.name);
      }
    }
    /** A PAGE (Home, Apps, Settings, …) as an Echo card: adopt the section
     *  singleton, run its loader, park it back on close. One card per page. */
    const openSectionCard = (section: string, title?: string): void => {
      const sec = document.querySelector<HTMLElement>(`.help-section[data-section="${section}"]`);
      if (!sec) return;
      if (section === "dashboard") {
        // HOME is a clean landing — like the chat icon, clicking Home clears
        // whatever is up (layout memory saved by the reset) and loads the
        // Home page alone.
        const home = openList.find((x) => x.tile.slug === "page:dashboard");
        if (home?.card && openList.length === 1) { flash(home.card); return; }
        resetEcho();
      }
      const existing = openList.find((x) => x.tile.slug === `page:${section}`);
      if (existing?.card) { flash(existing.card); return; }
      // USER-FACING title from the section map first — a bare capitalize
      // leaked internal names ("layouts" → "Layouts"; the product word is
      // "Workspaces").
      const name = title || SECTION_TITLES[section] || (section === "dashboard" ? "Home" : section.charAt(0).toUpperCase() + section.slice(1));
      const entry = adHoc({ name, slug: `page:${section}`, kind: "app" });
      const card = openShell(entry);
      if (!card) return;
      const body = card.querySelector<HTMLElement>(".echo-card-body")!;
      body.classList.add("ws-section-body");
      sec.classList.add("active", "wb-hosted");
      body.appendChild(sec);
      (window as unknown as { __wbSectionLoad?: (sn: string) => void }).__wbSectionLoad?.(section);
      // HOME hosts the LIVE composer: the agent element it normally lives in is
      // parked (display:none) while a page card is up, so the landing rendered
      // with no input at all until the adoption re-ran here.
      if (section === "dashboard") {
        (window as unknown as { __adoptComposerToHome?: () => void }).__adoptComposerToHome?.();
      }
    };
    // ── The agent drives Echo too: while Echo is mounted, EVERY panel tool
    // (open / list / close / focus / clear / terminal / browser / files)
    // lands in Echo's slots — pervasive, not just clicks. ──
    const findTile = (slug: string): TileEntry | undefined => {
      const key = slug.trim().toLowerCase();
      return openList.find((x) => (x.tile.slug || "") === key) ?? entries.find((x) => (x.tile.slug || "") === key);
    };
    const adHoc = (tile: EchoTile): TileEntry => ({ tile, img: null });
    /** "Here it is" — surface a card the user just aimed at. Landing in an
     *  EXISTING card (a pinned slot, an already-open app) has to leave
     *  shadow mode just like opening a new one does, or the app they picked
     *  fills the slot behind a veil that never lifts. */
    const flash = (card: HTMLElement | undefined): void => {
      if (!card) return;
      setShadow(false, false);
      card.classList.add("flash");
      window.setTimeout(() => card.classList.remove("flash"), 600);
    };
    const getOrOpenTool = (view: "files" | "terminal" | "monaco" | "diff" | "preview" | "plan" | "releases"): TileEntry => {
      let entry = openList.find((x) => x.tile.toolView === view);
      if (!entry) {
        entry = entries.find((x) => x.tile.toolView === view)
          ?? adHoc({ name: VIEW_META[view].title, slug: view, kind: "tool", toolView: view });
        activateTile(entry);
      }
      return entry;
    };
    const rerenderToolBody = (entry: TileEntry): void => {
      const b = entry.card?.querySelector<HTMLElement>(".echo-card-body");
      const slot = entry.toolSlot;
      if (!b || !slot) return;
      b.innerHTML = "";
      if (slot.view === "preview") void renderPreviewIntoSlot(b, slot);
      else if (slot.view === "monaco") void renderMonacoIntoSlot(b, slot);
    };
    const ctl: EchoCtlType = {
      openApp: (app) => {
        const key = (app.slug || "").trim().toLowerCase();
        // The fixed GLYPHH tile is the + New Session front door, not an app.
        // ONE path with the wall's own tiles (activateGlyphh) — the two
        // entries can never disagree.
        if (key === "glyphh-home") { activateGlyphh(); return; }
        // The Browser builtin IS the tabbed Browser card — a URL open adds a
        // TAB there (it used to open a plain one-webview card and overwrite
        // its src on every open, so "open 5 sites" left one page and no tabs).
        if (key === "browser") {
          if (app.url) ctl.openPreviewUrl(app.url);
          else void getOrOpenTool("preview");
          return;
        }
        const existing = openList.find((x) => (x.tile.slug || "") === key);
        if (existing?.card) {
          // already open — a URL open navigates it
          if (app.url) existing.card.querySelector("webview")?.setAttribute("src", app.url);
          flash(existing.card);   // flash() lifts shadow too
          return;
        }
        const tile: EchoTile | undefined = findTile(key)?.tile
          ?? ((app.url || app.glyphh) ? { name: app.name || app.slug, slug: key, url: app.url || undefined, glyphh: app.glyphh, workbench: app.workbench, kind: "app" } : undefined);
        if (!tile) return;
        const pinned = openList.find((x) => x.tile.sticky && x.card);
        if (pinned) { retargetCard(pinned, tile); return; }
        // An app open ADDS to the next slot when the stage is just apps — apps
        // accumulate side by side; only a LAYOUT stage wipes. That ONE rule
        // lives in activateTile (B3), which this call lands in — the wall's
        // direct tile clicks share it, so the two paths can never disagree.
        activateTile(adHoc(tile));
      },
      openLayout: (layout) => openLayoutInEcho(layout),
      openSection: (section) => {
        // A rail destination REPLACES an open layout — the layout's seams
        // and dividers kept eating events meant for the page stacked above
        // them, and clicking a nav item reads as leaving the layout anyway.
        // The reset saves the layout's memory ("last" resumes it), same as
        // the universal chat icon.
        if (echoGrid) resetEcho();
        // SETTINGS opens ALONE, so the single card fills the wall — full
        // screen, but still a card with its own header and close.
        if (section === "settings") resetEcho();
        openSectionCard(section);
      },
      openAgent: () => { void openAgentCard(); },
      detachAgent: () => {
        // The dock already moved .code-agent out to .code-root; the leftover
        // agent card is empty. Close it, keeping the session alive.
        const x = openList.find((c) => c.tile.kind === "agent");
        if (x) closeCard(x, { keepSession: true });
      },
      openChat: () => {
        // THE universal chat move: whatever layout is up clears (its memory
        // is saved by the reset) and the permanent bottom composer gets the
        // focus — there is no agent card to open.
        if (openList.length) resetEcho();
        void openAgentCard();
      },
      reset: () => resetEcho(),
      openTool: (view) => { void getOrOpenTool(view); },
      openToolWith: (view, land) => {
        const entry = getOrOpenTool(view as Parameters<typeof getOrOpenTool>[0]);
        // A FRESHLY opened card creates its slot after mount — landing only
        // `if (toolSlot)` silently dropped the payload on every first open
        // (Docs opened, the DOC didn't). Wait for the slot, then land+remount.
        let tries = 0;
        const settle = (): void => {
          // A PINNED card retarget hosts the view on a DIFFERENT entry than
          // getOrOpenTool returned — land on whoever actually holds the slot.
          const target = entry.toolSlot ? entry
            : openList.find((x) => x.tile.toolView === view && x.toolSlot);
          if (target?.toolSlot) {
            land(target.toolSlot);
            const body = target.card?.querySelector<HTMLElement>(".echo-card-body");
            if (body && target.card) {
              body.textContent = "";
              mountToolIntoCard(target, target.card);
            }
          } else if (tries++ < 40) {
            requestAnimationFrame(settle);
          }
        };
        settle();
      },
      hasTool: (view) => openList.some((x) => x.tile.toolView === view),
      closeTool: (view) => { for (const x of openList.filter((c) => c.tile.toolView === view)) closeCard(x); },
      // A folder change re-roots the folder-backed cards IN PLACE — the echo
      // arrangement (cards, layout, wall) is never torn down for it. Files
      // re-lists from the new root; Diff and Plan re-fetch. Terminals keep
      // their live shells and Monaco its absolute-path tabs.
      refreshForCwd: () => {
        for (const x of openList) {
          const slot = x.toolSlot;
          const b = x.card?.querySelector<HTMLElement>(".echo-card-body");
          if (!slot || !b) continue;
          if (slot.view === "files") { (slot as FilesSlot).root = null; b.innerHTML = ""; void renderFilesIntoSlot(b, slot as FilesSlot); }
          else if (slot.view === "diff") { b.innerHTML = ""; void renderDiffIntoSlot(b, slot as DiffSlot); }
          else if (slot.view === "plan") { b.innerHTML = ""; void renderPlanIntoSlot(b, slot as PlanSlot); }
        }
      },
      openPreviewHtml: (html, label) => {
        const entry = getOrOpenTool("preview");
        const slot = entry.toolSlot as PreviewSlot | undefined;
        if (!slot) return;
        setPreviewTarget(slot, { html, htmlLabel: label });
        rerenderToolBody(entry);
      },
      openPreviewUrl: (url) => {
        const entry = getOrOpenTool("preview");
        const slot = entry.toolSlot as PreviewSlot | undefined;
        if (!slot) return;
        addPreviewUrlTab(slot, url);
        rerenderToolBody(entry);
        flash(entry.card);
      },
      openFileTab: (node, content, mode) => {
        const entry = getOrOpenTool("monaco");
        const slot = entry.toolSlot as MonacoSlot | undefined;
        if (!slot) return;
        const idx = slot.tabs.findIndex((tb) => tb.path === node.path);
        if (idx >= 0) slot.activeIdx = idx;
        else {
          slot.tabs.push({ name: node.name, path: node.path, content, mode });
          slot.activeIdx = slot.tabs.length - 1;
        }
        rerenderToolBody(entry);
        flash(entry.card);
      },
      list: () => openList.map((x) => ({ slug: x.tile.slug || x.tile.name.toLowerCase(), name: x.tile.name })),
      close: (slug) => {
        const x = openList.find((c) => (c.tile.slug || "") === slug.trim().toLowerCase());
        if (!x) return false;
        closeCard(x);
        return true;
      },
      focus: (slug) => {
        const x = openList.find((c) => (c.tile.slug || "") === slug.trim().toLowerCase());
        if (!x?.card) return false;
        flash(x.card);
        return true;
      },
      closeAll: () => { for (const x of [...openList]) closeCard(x); },
      closeTop: () => {
        const top = openList[openList.length - 1];
        if (!top) return false;
        closeCard(top);
        return true;
      },
    };
    echoCtl = ctl;
    notifyOpenApps();

    // (The 3D pick/pan/edit machinery is GONE — flat icons handle their own
    // clicks and HTML5 drags; the dock/pages trade instead of deleting.)
        // RESET = back to the bare wall: every panel closes (the layout lets go
    // too), shadow clears, and the camera re-fits. The rail's reset buttons
    // call the same thing through echoCtl.reset.
    const resetEcho = (): void => {
      saveEchoLayoutMem();   // "last" layouts remember their panels through a reset
      for (const x of [...openList]) closeCard(x, { parkTerms: true });
      echoGrid = null;
      gridHoles = [];
      echoLayoutName = null;
      echoActiveLayout = null;
      activeLayoutId = null;
      setShadow(false, false);
      scheduleWallSave();   // the wall was cleared — persist the empty state
    };
    // The composer band's reset button (help/code.ts DOM) — close every
    // panel, back to the bare command center.
    (window as unknown as { __wbEchoReset?: () => void }).__wbEchoReset = resetEcho;

    // Teardown: release parked terminals + our controller registration.
    const obs = new MutationObserver(() => {
      if (body.isConnected) return;
      obs.disconnect();
      // Parked terminals live in THIS surface's closure — if the surface
      // itself goes, their ptys have no way back and must not linger.
      for (const slot of parkedTerms.values()) {
        for (const t of slot.terminals) { try { killTerminal(t); } catch { /* already gone */ } }
      }
      parkedTerms.clear();
      // only OUR registration — a re-render's fresh controller must survive
      // this stale observer firing after it
      if (echoCtl === ctl) {
        echoCtl = null;
        echoActiveLayout = null;
        notifyOpenApps();
      }
    });
    obs.observe(document.getElementById("code-wb-rails") ?? document.body, { childList: true, subtree: true });
    } catch (err) { console.error("[wall-setup] FAILED:", err); throw err; }
  }

  function renderCodingIntoSlot(body: HTMLElement, wrap: HTMLElement): void {
    // The coding seat holds only a PLACEHOLDER rect — the live `.code-agent`
    // sits in the fixed `#code-agent-layer` and follows this element each frame
    // (the same mechanism app slots use). No adopt/retry, no "unavailable"
    // race: the agent is always mounted, this just tells the overlay where to
    // land. The coding panel has NO header row — the agent's own head carries
    // the session title + history/+ controls (help/code.ts wires them).
    wrap.querySelector(".ws-rail-slot-header")?.classList.add("hidden-header");
    body.classList.add("ws-coding-body");
    body.innerHTML = `<div class="ws-agent-placeholder" data-agent-host="coding"></div>`;
    scheduleAgentSync();
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
  interface AppView { holder: HTMLDivElement; webview: WebviewEl; slug: string; streamed?: StreamedPanelHandle }
  const appViews = new Map<number, AppView>();
  // ── Echo mode — while an echo slot exists it IS the workspace view. Apps
  // The RPA registration bridge on window.glyphh (slug ↔ panel webContents id).
  const rpaYo = (): { rpaRegister?: (slug: string, wcId: number) => void; rpaUnregister?: (slug: string) => void } =>
    (window as unknown as { glyphh?: { rpaRegister?: (slug: string, wcId: number) => void; rpaUnregister?: (slug: string) => void } }).glyphh ?? {};
  let appLayer: HTMLDivElement | null = null;
  let appSyncRaf = 0;

  function ensureAppLayer(): HTMLDivElement {
    if (appLayer && appLayer.isConnected) return appLayer;
    appLayer = document.createElement("div");
    appLayer.id = "code-wb-applayer";
    document.body.appendChild(appLayer);
    return appLayer;
  }

  // ── The agent overlay — the ONE .code-agent, mounted once, never re-homed ──
  // The rail coding seat and the echo agent card each render only a
  // `.ws-agent-placeholder`; the live `.code-agent` sits in a stable
  // fixed-position holder inside `#code-agent-layer` and follows whichever
  // placeholder is showing, each frame (the same mechanism app views use). It
  // is NEVER re-parented between hosts, so the composer/thread never re-mount —
  // mid-run typing, staged notes and scroll position survive by construction.
  //
  // The ONE exception is a DOCK: left/right/center/none keep the agent as a
  // `.code-root` child (its in-flow "home"), because the dock is a real flex
  // layout the dock CSS styles at that position. So the agent has exactly TWO
  // homes — the overlay holder (rail-hosted) and `.code-root` (docked/hidden) —
  // and this reconciler moves it between just those two, driven by one question:
  // is a coding-seat / echo-card placeholder visible while the anchor is `rail`?
  let agentLayer: HTMLDivElement | null = null;
  let agentHolder: HTMLDivElement | null = null;
  let agentSyncRaf = 0;

  function ensureAgentLayer(): HTMLDivElement {
    if (agentLayer && agentLayer.isConnected) return agentLayer;
    agentLayer = document.createElement("div");
    agentLayer.id = "code-agent-layer";
    agentHolder = document.createElement("div");
    agentHolder.className = "ws-agent-holder";
    agentHolder.style.display = "none";
    agentLayer.appendChild(agentHolder);
    document.body.appendChild(agentLayer);
    return agentLayer;
  }

  /** The agent's in-flow HOME: a direct child of `.code-root`, immediately
   *  before the workbench aside. Dock modes and the hidden `rail`-default state
   *  both live here (CSS decides which shows). MOVE, never clone. */
  function parkAgentHome(): void {
    const agent = document.querySelector<HTMLElement>(".code-agent");
    const aside = document.getElementById("code-workbench");
    if (agent && aside?.parentElement && agent.parentElement !== aside.parentElement) {
      aside.parentElement.insertBefore(agent, aside);
    }
  }

  /** The single visible agent placeholder (a rail coding seat or the echo agent
   *  card). At most one shows at a time; the seat wins if somehow both exist. */
  function activeAgentPlaceholder(): HTMLElement | null {
    const seat = document.querySelector<HTMLElement>(".ws-rail-slot .ws-agent-placeholder");
    const cand = seat ?? document.querySelector<HTMLElement>(".ws-agent-placeholder");
    if (!cand) return null;
    const rect = cand.getBoundingClientRect();
    if (rect.width > 24 && rect.height > 24 && cand.offsetParent !== null) return cand;
    return null;
  }

  /** Reconcile the agent overlay against the current placeholder each frame —
   *  the same rAF loop, guard var and auto-stop as `syncAppViews`. While the
   *  anchor is a dock (or nothing hosts the agent) the loop parks the agent home
   *  and stops; a fresh placeholder re-arms it via `scheduleAgentSync`. */
  function syncAgentView(): void {
    // TWO homes, no docking: a LAYOUT's agent cell hosts a placeholder the
    // overlay follows (the full agent — head, thread, composer — rides in
    // the holder over the cell); with no placeholder the agent parks home as
    // `.code-root`'s direct child, where the center CSS renders it as the
    // bottom composer (or hides it while a layout is live).
    ensureAgentLayer();
    const agent = document.querySelector<HTMLElement>(".code-agent");
    const ph = activeAgentPlaceholder();
    const seatMic = (window as unknown as { __glyphhSeatMic?: () => void }).__glyphhSeatMic;
    if (agent && ph && agentHolder) {
      if (agent.parentElement !== agentHolder) { agentHolder.appendChild(agent); seatMic?.(); }
      const rect = ph.getBoundingClientRect();
      agentHolder.style.display = "";
      agentHolder.style.left = `${Math.round(rect.left)}px`;
      agentHolder.style.top = `${Math.round(rect.top)}px`;
      agentHolder.style.width = `${Math.round(rect.width)}px`;
      agentHolder.style.height = `${Math.round(rect.height)}px`;
      agentSyncRaf = requestAnimationFrame(syncAgentView);
    } else {
      if (agentHolder) agentHolder.style.display = "none";
      parkAgentHome();
      seatMic?.();
      agentSyncRaf = 0;
    }
  }
  function scheduleAgentSync(): void {
    if (!agentSyncRaf) agentSyncRaf = requestAnimationFrame(syncAgentView);
  }
  (window as unknown as { __wbSyncAgent?: () => void }).__wbSyncAgent = scheduleAgentSync;

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

  /** A readable in-panel failure page for an installed app that would not
   *  open — a silent about:blank reads as "the app is broken with no clue". */
  function glyphhAppErrorPage(name: string, error?: string): string {
    const msg = `${name} failed to open${error ? `: ${error}` : ""}. Try Apps → the app's Releases tab, or reinstall it.`;
    return "data:text/html;charset=utf-8," + encodeURIComponent(
      `<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#101014;color:#9aa0aa;font:13px -apple-system,system-ui,sans-serif;text-align:center;padding:24px">${msg.replace(/</g, "&lt;")}</body>`);
  }

  /** Browser chrome — back / fwd / reload / address bar / download — wired
   *  to a webview. One builder for the app panels AND Echo's open cards. */
  function buildAppChrome(webview: WebviewEl, fallbackUrl: () => string): { chrome: HTMLElement; urlbar: HTMLInputElement } {
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
      const u = webview.getURL?.() || fallbackUrl();
      if (u) webview.downloadURL?.(u);
    });
    return { chrome, urlbar };
  }

  /** True when running the app-web target (no Electron <webview>). */
  function isWebTarget(): boolean {
    return !!(window as unknown as { __GLYPHH_WEB__?: boolean }).__GLYPHH_WEB__;
  }

  /**
   * WEB: the interior of a Glyphh-app panel that has NO hosted deployment.
   * The app itself is installed on the user's desktop and a file:// entry has
   * no web transport, so the panel's job is the HONEST state card the streamed
   * panels show — same panelStateFragment states, same wording family, same
   * working "Try again" — never a dead iframe pointed at a URL that serves
   * nothing. Shared by the Echo card and the rail-slot holder.
   */
  function mountGlyphhAppWebState(name: string): HTMLElement {
    const el = document.createElement("div");
    el.className = "ws-glyphh-app-state";
    el.style.cssText = "flex:1 1 auto;min-height:0;width:100%;position:relative;display:flex;align-items:center;justify-content:center;overflow:auto;padding:24px;background:var(--surface)";
    const render = (state: PanelStateKey, detail: string, retry: boolean): void => {
      el.innerHTML = panelStateFragment(state, { detail, ...(retry ? { retryAttrs: 'data-app-retry="1"' } : {}) });
      el.querySelector<HTMLButtonElement>("[data-app-retry]")?.addEventListener("click", () => { void check(); });
    };
    const check = async (): Promise<void> => {
      el.innerHTML = `<div style="color:var(--text-2);font:13px system-ui,sans-serif">Checking your desktop…</div>`;
      const client = relaySdk();
      if (!client) {
        render("signed-out", `${name} is a Glyphh app on your own account, so it needs a sign-in before this panel can say where it lives.`, true);
        return;
      }
      let attached = false;
      try { attached = (await client.attach.status()).attached; } catch { attached = false; }
      if (!el.isConnected) return;
      if (!attached) {
        render("desktop-offline", `${name} is installed on your desktop. Open the Glyphh desktop app and sign in, then try again.`, true);
        return;
      }
      // Desktop reachable, but an installed app renders from its own disk —
      // there is no web transport for it (only DEPLOYED apps render here).
      // An honest dead-end with directions beats a retry that can't succeed.
      render("failed", `${name} is installed on your desktop and isn't deployed to the web yet. Open it in the desktop app, or deploy it to use it here.`, false);
    };
    void check();
    return el;
  }

  /**
   * WEB drop-in for a GLYPHH-app rail slot. The native path's <webview> is an
   * inert unknown element in a real browser — it rendered NOTHING, not even
   * its failure page. A deployed app renders as a plain iframe (no desktop
   * needed, same as the Echo card); an undeployed one gets the state card.
   */
  function mountGlyphhAppWebView(slot: AppSlot): AppView {
    const holder = document.createElement("div");
    holder.className = "ws-app-holder entering";
    if (slot.url) {
      const frame = document.createElement("iframe");
      // Same sandbox gate as the echo-card mount (app-runtime spec).
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
      frame.src = slot.url;
      frame.style.cssText = "flex:1 1 auto;min-height:0;width:100%;border:0;background:var(--bg-2)";
      holder.appendChild(frame);
    } else {
      holder.appendChild(mountGlyphhAppWebState(slot.name));
    }
    ensureAppLayer().appendChild(holder);
    requestAnimationFrame(() => requestAnimationFrame(() => holder.classList.remove("entering")));
    const view: AppView = { holder, webview: document.createElement("div") as WebviewEl, slug: slot.slug };
    appViews.set(slot.id, view);
    return view;
  }

  /**
   * The WEB drop-in for a URL app panel: a <webview> does nothing on web, so a
   * streamed panel (canvas/WebRTC of a page rendered on the user's attached
   * desktop) takes its place. Same holder + chrome shell as the native path, so
   * syncAppViews positions it identically. Installed Glyphh apps (file:// entry)
   * aren't streamed here — their entry URL is resolved on-machine and isn't known
   * to the web client — they take mountGlyphhAppWebView (hosted iframe, or the
   * honest state card) instead.
   */
  function mountStreamedAppView(slot: AppSlot): AppView {
    const holder = document.createElement("div");
    holder.className = "ws-app-holder entering";
    // The SAME chrome as the native app panel (back/fwd/reload/urlbar) —
    // buildAppChrome is webview-shaped, so a thin adapter maps its verbs onto
    // the streamed panel and re-emits far-side navs as did-navigate events.
    const navTarget = new EventTarget();
    const streamed = mountStreamedPanel({
      url: slot.url,
      onNav: (url) => {
        if (url) slot.url = url;   // persistence follows the far page, as native does
        navTarget.dispatchEvent(Object.assign(new Event("did-navigate"), { url }));
      },
    });
    const adapter = {
      loadURL: (u: string) => streamed.navigate(u),
      goBack: () => streamed.back(),
      goForward: () => streamed.forward(),
      reload: () => streamed.reload(),
      canGoBack: () => true,
      canGoForward: () => true,
      getURL: () => streamed.currentUrl(),
      addEventListener: (type: string, fn: EventListener) => navTarget.addEventListener(type, fn),
    } as unknown as WebviewEl;
    const { chrome, urlbar } = buildAppChrome(adapter, () => slot.url);
    urlbar.value = slot.url;
    holder.appendChild(chrome);
    // Same classes as the native view so every panel rule (sizing, radius,
    // focus ring) applies identically — streamed is a transport, not a look.
    streamed.el.classList.add("ws-app-view");
    streamed.el.style.flex = "1";
    streamed.el.style.minHeight = "0";
    holder.appendChild(streamed.el);
    if (slot.urlBarHidden) holder.classList.add("urlbar-hidden");
    ensureAppLayer().appendChild(holder);
    requestAnimationFrame(() => requestAnimationFrame(() => holder.classList.remove("entering")));
    // The <webview> field is unused on this path; a permissive stub keeps the
    // AppView shape without a real Electron element.
    const view: AppView = { holder, webview: document.createElement("div") as WebviewEl, slug: slot.slug, streamed };
    appViews.set(slot.id, view);
    return view;
  }

  function mountAppView(slot: AppSlot): AppView {
    if (isWebTarget()) return slot.glyphh ? mountGlyphhAppWebView(slot) : mountStreamedAppView(slot);

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
    // Some sites refuse to embed (X-Frame-Options/CSP) — say so in the panel
    // AND in the main terminal, since it looks identical to "blank" otherwise.
    webview.addEventListener("did-fail-load", (e) => {
      const err = e as unknown as { errorCode?: number; errorDescription?: string; validatedURL?: string; isMainFrame?: boolean };
      if (!isRealLoadFailure(err.errorCode) || err.isMainFrame === false) return;
      const m = `[wb] "${slot.name}" failed to load (${err.errorCode} ${err.errorDescription || ""}) — it may block embedding.`;
      console.warn(m);
      (window as unknown as { glyphh?: { wbLog?: (s: string) => void } }).glyphh?.wbLog?.(m);
      showBrowserError(webview, {
        url: err.validatedURL || slot.url || "",
        errorCode: err.errorCode,
        description: err.errorDescription,
      });
    });

    // Browser chrome: back / fwd / reload + address bar. It lives inside the
    // holder (which persists across renderRails) so it stays wired to the
    // webview it drives.
    const { chrome, urlbar } = buildAppChrome(webview, () => slot.url);

    if (slot.glyphh) {
      // Installed Glyphh app: attach first (about:blank), then grant its caps
      // against the guest webContents and load the on-disk entry — the exact
      // preview-open flow the Apps page already uses.
      webview.setAttribute("src", "about:blank");
      webview.addEventListener("dom-ready", () => {
        const yo = (window as unknown as { glyphh?: { glyphhAppPreviewOpen?: (slug: string, wcId?: number) => Promise<{ ok: boolean; fileUrl?: string; error?: string }>; rpaRegister?: (slug: string, wcId: number) => void } }).glyphh;
        const wcId = webview.getWebContentsId?.();
        if (wcId !== undefined) yo?.rpaRegister?.(slot.slug, wcId);
        void yo?.glyphhAppPreviewOpen?.(slot.slug, wcId).then((res) => {
          if (res?.ok && res.fileUrl && webview.getAttribute("src") === "about:blank") {
            webview.setAttribute("src", res.fileUrl);
          } else if (!res?.ok) {
            webview.setAttribute("src", glyphhAppErrorPage(slot.name, res?.error));
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
        view.streamed?.dispose();
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
      if (!live.has(id)) { rpaYo().rpaUnregister?.(view.slug); view.streamed?.dispose(); view.holder.remove(); appViews.delete(id); }
    }
    notifyOpenApps();
    if (slots.length) appSyncRaf = requestAnimationFrame(syncAppViews);
    else { appSyncRaf = 0; for (const v of appViews.values()) v.streamed?.dispose(); if (appLayer) appLayer.innerHTML = ""; appViews.clear(); }
  }
  function scheduleAppSync(): void {
    if (!appSyncRaf) appSyncRaf = requestAnimationFrame(syncAppViews);
  }

  /**
   * Open an app. There is exactly ONE way: an ECHO CARD.
   *
   * Echo is the workbench, not a mode of it — if the wall is down the answer is
   * to raise it, never to open somewhere else. The old fallback opened a rail
   * slot instead, which meant two implementations of "open an app" drifting
   * apart: layouts rendered as flat slots with no grid, and the web took the
   * slot path for a `<webview>` reason that stopped being true once
   * mountAppIntoCard grew its own web branch (streamed panel / iframe — same
   * card, same chrome, different transport).
   *
   * echoCtl is published while the echo view renders, so a freshly-raised wall
   * may not have it yet; retry on the next frame rather than branching.
   */
  function openAppCard(app: WbAppRef, tries = 0): void {
    openEchoSurface();
    if (echoCtl) { echoCtl.openApp(app); return; }
    if (tries < 40) requestAnimationFrame(() => openAppCard(app, tries + 1));
  }

  let lastAppsJson = "";
  function notifyOpenApps(): void {
    const open = [...appSlots().map((s) => ({ slug: s.slug, name: s.name })), ...(echoCtl?.list() ?? [])];
    const json = JSON.stringify(open);
    if (json === lastAppsJson) return;
    lastAppsJson = json;
    (window as unknown as { glyphh?: { wbAppsChanged?: (apps: Array<{ slug: string; name: string }>) => void } }).glyphh?.wbAppsChanged?.(open);
  }

  interface WbAppRef { slug: string; name: string; url: string; glyphh?: boolean; workbench?: boolean }
  interface WbLayoutCell extends WbAppRef { col: number; row: number; span?: number; sticky?: boolean; tool?: string; config?: { url?: string; cmd?: string; keepAlive?: boolean } }
  interface WbGridLayout { cols: number; colWidths: number[]; rowHeights: number[]; cells: WbLayoutCell[] }

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

  // The legacy command center is GONE — Echo is the launcher and the layout
  // manager. Opening "the switcher" now means opening Echo.
  function openEchoSurface(): void {
    if (!viewIsOpen("echo")) placeView("echo");
  }

  /** Close the command centre wherever it is open. Picking an agent from it is
   *  a decision, not a browse — the panel gets out of the way. */
  function closeEchoSurface(): void {
    // Collect the ids FIRST: closeSlot splices `rails` when a rail empties, so
    // iterating it live would skip entries.
    const ids = rails.flatMap((r) => r.slots.filter((s) => s.view === "echo").map((s) => s.id));
    for (const id of ids) closeSlot(id);
  }

  // ── Live fs-backed panel registry ──
  // The Files / Diff / Monaco renderers mount into TWO hosts: rail slots
  // (.ws-rail-slot-body) and Echo cards (.echo-card-body). The watcher fan-in
  // used to find panels by the rail DOM selector only, so panels on the wall
  // never refreshed. Each renderer now registers its (slot, body) here on
  // mount; stale entries drop off via isConnected.
  interface LiveFsPanel { slot: Slot; body: HTMLElement }
  const liveFsPanels = new Set<LiveFsPanel>();
  function registerLiveFsPanel(slot: Slot, body: HTMLElement): void {
    for (const p of [...liveFsPanels]) {
      if (!p.body.isConnected || p.slot === slot) liveFsPanels.delete(p);
    }
    liveFsPanels.add({ slot, body });
  }
  function liveFsPanelsOf(view: ViewKind): LiveFsPanel[] {
    const out: LiveFsPanel[] = [];
    for (const p of [...liveFsPanels]) {
      if (!p.body.isConnected) { liveFsPanels.delete(p); continue; }
      if (p.slot.view === view) out.push(p);
    }
    return out;
  }

  /**
   * WEB: the Files / Diff / Monaco panels read the CURRENT SESSION's
   * filesystem — the attached desktop over the relay (wb-relay.js), or a
   * cloud session's pod workspace over the harness front door (wb-pod.js).
   * When that transport can't answer — no desktop attached, pod unreachable,
   * or signed out — paint the SAME honest state card the streamed panels and
   * remote terminal show (panelStateFragment, working "Try again") instead of
   * an empty tree / dead pane. Desktop always proceeds. Returns true when the
   * caller should mount its real renderer.
   */
  async function webFsReady(body: HTMLElement, retry: () => void): Promise<boolean> {
    if (!isWebTarget()) return true;
    const status = window.wb.webFsStatus;
    if (!status) return true; // no web wb (unexpected) — let the renderer show its own error state
    let state: "ok" | "desktop-offline" | "signed-out" | "runtime-offline" = "desktop-offline";
    try { state = await status(); } catch { state = "desktop-offline"; }
    if (!body.isConnected) return false;
    if (state === "ok") {
      // The far side just became reachable — the boot-time cwd may predate it.
      if (!cwd) cwd = (await window.wb.getCwd().catch(() => "")) || "";
      return true;
    }
    body.innerHTML = "";
    // A CLOUD source with no live pod isn't a desktop problem — the workspace
    // simply doesn't exist until the first send births the session. Quiet
    // empty state, no offline alarm, no retry theater.
    if (state === "desktop-offline") {
      const src = (window as unknown as { __glyphhActiveSource?: () => { kind?: string } }).__glyphhActiveSource?.();
      if (src && src.kind !== "local") {
        const quiet = document.createElement("div");
        quiet.style.cssText = "flex:1 1 auto;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;color:var(--text-3);font-size:12.5px;line-height:1.6;background:var(--surface)";
        quiet.textContent = "This panel fills from the session's cloud workspace — it starts with your first message.";
        body.appendChild(quiet);
        return false;
      }
    }
    const card = document.createElement("div");
    card.className = "ws-glyphh-app-state";
    card.style.cssText = "flex:1 1 auto;min-height:0;width:100%;position:relative;display:flex;align-items:center;justify-content:center;overflow:auto;padding:24px;background:var(--surface)";
    // "runtime-offline" (a cloud session's pod workspace unreachable) rides the
    // existing generic "failed" card with honest copy — no invented UI.
    card.innerHTML = panelStateFragment(state === "runtime-offline" ? "failed" : state, {
      retryAttrs: 'data-fs-retry="1"',
      ...(state === "desktop-offline"
        ? { detail: "This panel reads files on your desktop. Open the Glyphh desktop app and sign in, then try again." }
        : state === "runtime-offline"
          ? { detail: "This session's files live in its cloud workspace, which isn't reachable right now. Try again in a moment." }
          : {}),
    });
    card.querySelector<HTMLButtonElement>("[data-fs-retry]")?.addEventListener("click", retry);
    body.appendChild(card);
    return false;
  }

  // ── Files view ──
  async function renderFilesIntoSlot(body: HTMLElement, slot: FilesSlot): Promise<void> {
    registerLiveFsPanel(slot, body);
    if (!(await webFsReady(body, () => { void renderFilesIntoSlot(body, slot); }))) return;
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
    registerLiveFsPanel(slot, body);
    if (!(await webFsReady(body, () => { void renderMonacoIntoSlot(body, slot); }))) return;
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
    // True while a DISK reload is being folded into the live model — the
    // change event it fires must not mark the tab dirty (it IS the saved
    // content) or re-arm autosave paths.
    let suppressExternalReload = false;
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
      if (!slot.tabs.length) {
        // the strip otherwise reads as a bare gap
        tabsEl.innerHTML = `<span class="ws-monaco-tabs-empty">No file open</span>`;
      }
      const closeTabAt = async (i: number): Promise<void> => {
        const t = slot.tabs[i];
        if (!t) return;
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
      };
      /** RIGHT-CLICK on a tab (his rule, 2026-08-19): Save (when dirty) /
       *  Close / Close all / Save all — the dirty prompts ride the actions. */
      const openTabDropdown = (anchor: HTMLElement, i: number): void => {
        document.querySelector(".ws-tab-ctx-menu")?.remove();
        const t = slot.tabs[i];
        if (!t) return;
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
        if (t.dirty) mkItem("Save", () => { void saveActive(); });
        mkItem("Close", () => { void closeTabAt(i); });
        mkItem("Close all", () => { void closeAll(); });
        mkItem("Save all", () => { void saveAll(); });
        document.body.appendChild(menu);
        const r = anchor.getBoundingClientRect();
        menu.style.left = Math.max(6, Math.min(r.left, window.innerWidth - menu.offsetWidth - 6)) + "px";
        menu.style.top = Math.max(6, Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 6)) + "px";
        document.addEventListener("mousedown", onAway, true);
        document.addEventListener("keydown", onKey, true);
      };
      slot.tabs.forEach((t, i) => {
        const tab = document.createElement("div");
        tab.className = "ws-monaco-tab" + (i === slot.activeIdx ? " active" : "");
        tab.title = t.path;
        tab.innerHTML = `<span class="nm"></span><button class="close" title="Close tab">×</button>`;
        (tab.querySelector(".nm") as HTMLElement).textContent = t.name;
        tab.addEventListener("click", (ev) => {
          if ((ev.target as HTMLElement).closest(".close")) {
            ev.stopPropagation();
            void closeTabAt(i);
          } else if (i !== slot.activeIdx) {
            slot.activeIdx = i;
            paintTabs();
            void mountActive();
          }
        });
        tab.addEventListener("contextmenu", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();   // the strip-level menu must not double-fire
          openTabDropdown(tab, i);
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
      const pathRow = body.querySelector<HTMLElement>(".ws-monaco-path");
      if (pathRow) pathRow.style.display = tab ? "" : "none";
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
          if (suppressExternalReload) return;
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

    // DISK → EDITOR live reload: the workdir watcher saw this tab's file
    // change while the buffer is NOT dirty. Fold the new content into the
    // EXISTING model in place — never a fresh model (that would drop the
    // dirty-tracking listener and reset cursor + scroll) — and restore
    // cursor + scroll around the swap. Focus is never touched.
    (body as HTMLElement & { __wbMonacoReload?: (abs: string, content: string) => void }).__wbMonacoReload = (abs, content) => {
      const idx = slot.tabs.findIndex((t) => t.path === abs);
      if (idx < 0) return;
      const tab = slot.tabs[idx];
      if (tab.dirty) return;              // never clobber unsaved edits
      if (tab.content === content) return;
      tab.content = content;
      if (idx !== slot.activeIdx) return; // inactive tabs pick it up on switch
      const md = isMarkdown(tab.name);
      if (md && (tab.mode || "preview") === "preview") {
        const keep = mdHost.scrollTop;
        mdHost.innerHTML = formatMarkdown(content);
        mdHost.scrollTop = keep;
        return;
      }
      const h = host as unknown as { __editor?: any; __modelPath?: string };
      const editor = h.__editor;
      const model = editor?.getModel?.();
      if (!editor || !model || h.__modelPath !== abs) return;
      const pos = editor.getPosition?.();
      const scrollTop = editor.getScrollTop?.();
      const scrollLeft = editor.getScrollLeft?.();
      suppressExternalReload = true;
      try { model.setValue(content); } finally { suppressExternalReload = false; }
      try {
        if (pos) editor.setPosition(model.validatePosition ? model.validatePosition(pos) : pos);
        if (typeof scrollTop === "number") editor.setScrollTop(scrollTop);
        if (typeof scrollLeft === "number") editor.setScrollLeft(scrollLeft);
      } catch { /* the file shrank past the cursor — Monaco's clamp is enough */ }
    };

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

  // ── Releases view — release management for BUILT (glyphh-hosted) apps ──
  // Pick an app, see its release history, cut a build from the working
  // folder, promote dev → live, edit notes. Same IPC the Settings → Apps →
  // Releases tab uses; while a build is in flight the panel polls until it
  // settles (the settings tab is manual-refresh only).
  interface WbReleaseRow {
    id: string;
    version: string;
    status: "pending" | "uploading" | "building" | "ready" | "failed";
    error: string | null;
    notes: string | null;
    channel: "dev" | "live";
    promotedAt: string | null;
    createdAt: string;
    updatedAt: string;
  }
  // Structural mirror of the preload surface (remote-run.ts's discipline —
  // this bundle can't import preload types).
  interface WbReleasesIpc {
    panelAppsList?: () => Promise<Array<{ id: string; slug: string; name: string; system: boolean; appArchetype?: string | null; access?: string }>>;
    panelAppsUpdate?: (id: string, patch: { access?: string }) => Promise<{ ok?: boolean } | unknown>;
    appReleases?: (slug: string) => Promise<{ ok: boolean; releases: WbReleaseRow[]; error?: string }>;
    appReleaseNotes?: (slug: string, releaseId: string, notes: string | null) => Promise<{ ok: boolean; error?: string }>;
    appReleasePromote?: (slug: string, releaseId: string) => Promise<{ ok: boolean; error?: string }>;
    appBuildDeploy?: (slug: string) => Promise<{ ok: boolean; result?: { slug: string; version: string; url?: string }; error?: string }>;
    hostingStatus?: (slug: string) => Promise<{ ok: boolean; deployment?: { id: string; url: string | null; status: string } | null; error?: string }>;
    hostingDeploy?: (slug: string) => Promise<{ ok: boolean; deployment?: { id: string; url: string | null; status: string }; error?: string }>;
    appExport?: (appId: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
  }
  const relIpc = (): WbReleasesIpc => (window as unknown as { glyphh?: WbReleasesIpc }).glyphh ?? {};
  const REL_POLL_MS = 5000;
  const REL_BUILDING = new Set(["pending", "uploading", "building"]);
  const relEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  function relDate(iso: string | null): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  }

  async function renderReleasesIntoSlot(body: HTMLElement, slot: ReleasesSlot): Promise<void> {
    body.classList.add("ws-rel-body");
    body.innerHTML = `
      <div class="ws-rel-toolbar">
        <select class="ws-rel-app" title="Which app to manage"></select>
        <span class="ws-rel-note"></span>
        <button type="button" class="action-btn primary ws-rel-deploy" title="Package the working folder, cut a release, and deploy it">Build &amp; deploy</button>
        <button type="button" class="ws-icon-btn ws-rel-refresh" title="Refresh">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
        </button>
      </div>
      <div class="ws-rel-hosting hidden">
        <span class="ws-rel-host-status"></span>
        <select class="ws-rel-access" title="Who can reach the deployed app">
          <option value="members">Org members</option>
          <option value="public">Public</option>
        </select>
        <button type="button" class="action-btn ws-rel-host-deploy" title="Serve this app's latest build at its Glyphh address">Deploy</button>
        <button type="button" class="action-btn ws-rel-export" title="Export a standalone repo — the app no longer needs Glyphh">Export repo</button>
      </div>
      <div class="ws-rel-list"><div class="ws-rel-empty">Loading…</div></div>`;
    const sel = body.querySelector(".ws-rel-app") as HTMLSelectElement;
    const note = body.querySelector(".ws-rel-note") as HTMLElement;
    const deployBtn = body.querySelector(".ws-rel-deploy") as HTMLButtonElement;
    const hosting = body.querySelector(".ws-rel-hosting") as HTMLElement;
    const hostStatus = body.querySelector(".ws-rel-host-status") as HTMLElement;
    const accessSel = body.querySelector(".ws-rel-access") as HTMLSelectElement;
    const hostDeploy = body.querySelector(".ws-rel-host-deploy") as HTMLButtonElement;
    const exportBtn = body.querySelector(".ws-rel-export") as HTMLButtonElement;
    const list = body.querySelector(".ws-rel-list") as HTMLElement;
    let pollTimer = 0;

    // BUILT apps only (the Settings tabs' own gate: appArchetype "glyphh-app").
    // "Current folder" leads: Build & deploy reads the workdir's
    // glyphh.app.json and deploys THAT app — no pick needed.
    interface RelApp { id: string; slug: string; name: string; access?: string }
    let apps: RelApp[] = [];
    try {
      const all = (await relIpc().panelAppsList?.()) || [];
      apps = all.filter((a) => !a.system && a.appArchetype === "glyphh-app")
        .map((a) => ({ id: a.id, slug: a.slug, name: a.name, access: a.access }));
    } catch { /* offline — current-folder deploy still works */ }
    sel.innerHTML = [`<option value="">Current folder</option>`,
      ...apps.map((a) => `<option value="${relEsc(a.slug)}">${relEsc(a.name)}</option>`)].join("");
    if (slot.slug && apps.some((a) => a.slug === slot.slug)) sel.value = slot.slug;
    slot.slug = sel.value;

    const pickedApp = (): RelApp | null => apps.find((a) => a.slug === sel.value) ?? null;
    const setNote = (text: string, err = false): void => {
      note.textContent = text;
      note.classList.toggle("err", err);
    };

    async function refreshHosting(): Promise<void> {
      const app = pickedApp();
      hosting.classList.toggle("hidden", !app);
      if (!app) return;
      accessSel.value = app.access === "public" ? "public" : "members";
      hostStatus.textContent = "checking…";
      try {
        const r = await relIpc().hostingStatus?.(app.slug);
        if (!r?.ok) { hostStatus.textContent = r?.error || "Couldn't load deploy status"; return; }
        if (!r.deployment) { hostStatus.textContent = "Not deployed"; return; }
        const st = r.deployment.status || "";
        hostStatus.innerHTML = r.deployment.url
          ? `${relEsc(st)} · <a href="${relEsc(r.deployment.url)}" target="_blank" rel="noreferrer">${relEsc(r.deployment.url.replace(/^https?:\/\//, ""))}</a>`
          : relEsc(st);
      } catch { hostStatus.textContent = "Couldn't load deploy status"; }
    }

    async function refresh(): Promise<void> {
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = 0; }
      const slug = sel.value;
      void refreshHosting();
      if (!slug) {
        list.innerHTML = `<div class="ws-rel-empty">Current folder — Build &amp; deploy reads the working folder's <code>glyphh.app.json</code> and deploys that app. Pick an app above to see its release history and hosting.</div>`;
        return;
      }
      let releases: WbReleaseRow[] = [];
      try {
        const r = await relIpc().appReleases?.(slug);
        if (!r?.ok) { list.innerHTML = `<div class="ws-rel-empty">${relEsc(r?.error || "Couldn't load releases")}</div>`; return; }
        releases = r.releases || [];
      } catch (err) {
        list.innerHTML = `<div class="ws-rel-empty">${relEsc(err instanceof Error ? err.message : "Couldn't load releases")}</div>`;
        return;
      }
      if (!body.isConnected || sel.value !== slug) return; // stale — panel closed or app switched
      if (!releases.length) {
        list.innerHTML = `<div class="ws-rel-empty">No releases yet — Build &amp; deploy cuts the first one from your working folder.</div>`;
        return;
      }
      list.textContent = "";
      for (const r of releases) {
        const row = document.createElement("div");
        row.className = "ws-rel-row" + (r.status === "failed" ? " failed" : "");
        const badge = r.channel === "live"
          ? `<span class="ws-rel-badge live">live</span>`
          : `<span class="ws-rel-badge">dev</span>`;
        const state = r.status !== "ready" ? `<span class="ws-rel-state ${r.status}">${r.status}</span>` : "";
        row.innerHTML = `
          <div class="ws-rel-row-head">
            <span class="ws-rel-version">${relEsc(r.version)}</span>${badge}${state}
            <span class="ws-rel-date">${relEsc(relDate(r.promotedAt || r.createdAt))}</span>
            <span class="ws-rel-actions">
              ${r.channel === "dev" && r.status === "ready" ? `<button type="button" class="action-btn ws-rel-promote" title="Publish this release to everyone">Promote to live</button>` : ""}
              <button type="button" class="action-btn ws-rel-notes-btn" title="Release notes">Notes</button>
            </span>
          </div>
          ${r.notes ? `<div class="ws-rel-notes-preview">${relEsc(r.notes.split("\n").slice(0, 2).join(" · ").slice(0, 140))}</div>` : ""}
          ${r.status === "failed" && r.error ? `<div class="ws-rel-error">${relEsc(r.error.slice(0, 300))}</div>` : ""}`;
        row.querySelector(".ws-rel-promote")?.addEventListener("click", async (e) => {
          const btn = e.currentTarget as HTMLButtonElement;
          btn.disabled = true;
          btn.textContent = "Promoting…";
          const res = await relIpc().appReleasePromote?.(slug, r.id).catch(() => ({ ok: false, error: "promote failed" }));
          if (!res?.ok) setNote(res?.error || "Promote failed", true);
          else setNote(`v${r.version} is live`);
          void refresh();
        });
        // Notes: an inline editor under the row — save writes through, blank clears.
        row.querySelector(".ws-rel-notes-btn")?.addEventListener("click", () => {
          const openEd = row.querySelector(".ws-rel-notes-edit");
          if (openEd) { openEd.remove(); return; }
          const ed = document.createElement("div");
          ed.className = "ws-rel-notes-edit";
          ed.innerHTML = `<textarea rows="3" placeholder="What changed in ${relEsc(r.version)}…">${relEsc(r.notes || "")}</textarea><button type="button" class="action-btn">Save</button>`;
          ed.querySelector("button")!.addEventListener("click", async () => {
            const text = (ed.querySelector("textarea") as HTMLTextAreaElement).value.trim();
            const res = await relIpc().appReleaseNotes?.(slug, r.id, text || null).catch(() => ({ ok: false, error: "save failed" }));
            if (!res?.ok) { setNote(res?.error || "Couldn't save the notes", true); return; }
            setNote("Notes saved");
            void refresh();
          });
          row.appendChild(ed);
        });
        list.appendChild(row);
      }
      // A build in flight → poll until it settles; nothing owed → sleep.
      if (releases.some((r) => REL_BUILDING.has(r.status))) {
        pollTimer = window.setTimeout(() => { if (body.isConnected) void refresh(); }, REL_POLL_MS);
      }
    }

    sel.addEventListener("change", () => {
      slot.slug = sel.value;
      setNote("");
      saveLayout();
      void refresh();
    });
    body.querySelector(".ws-rel-refresh")?.addEventListener("click", () => { setNote(""); void refresh(); });
    deployBtn.addEventListener("click", async () => {
      deployBtn.disabled = true;
      setNote("Building from your working folder…");
      try {
        // Empty slug = deploy WHATEVER the working folder builds (its
        // manifest names the app); a picked app is a guard — the build
        // refuses if the folder holds a different project.
        const res = await relIpc().appBuildDeploy?.(sel.value);
        if (res?.ok) {
          setNote(`Built v${res.result?.version || "?"}${res.result?.url ? ` — live at ${res.result.url}` : ""}`);
          // A current-folder build names its app — land the picker on it so
          // the history below shows what was just cut.
          const builtSlug = res.result?.slug;
          if (!sel.value && builtSlug && apps.some((a) => a.slug === builtSlug)) {
            sel.value = builtSlug;
            slot.slug = builtSlug;
          }
        } else setNote(res?.error || "Build failed", true);
      } catch (err) {
        setNote(err instanceof Error ? err.message : "Build failed", true);
      } finally {
        deployBtn.disabled = false;
        void refresh();
      }
    });
    accessSel.addEventListener("change", async () => {
      const app = pickedApp();
      if (!app) return;
      try {
        await relIpc().panelAppsUpdate?.(app.id, { access: accessSel.value });
        app.access = accessSel.value;
        setNote(accessSel.value === "public" ? "Anyone with the link can reach it" : "Only signed-in org members can reach it");
      } catch { setNote("Couldn't change access", true); }
    });
    hostDeploy.addEventListener("click", async () => {
      const app = pickedApp();
      if (!app) return;
      hostDeploy.disabled = true;
      setNote("Deploying…");
      try {
        const r = await relIpc().hostingDeploy?.(app.slug);
        if (r?.ok) setNote(r.deployment?.url ? `Deploying — ${r.deployment.url}` : "Deploying");
        else setNote(r?.error || "Deploy failed", true);
      } catch (err) { setNote(err instanceof Error ? err.message : "Deploy failed", true); }
      finally { hostDeploy.disabled = false; void refreshHosting(); }
    });
    exportBtn.addEventListener("click", async () => {
      const app = pickedApp();
      if (!app) return;
      exportBtn.disabled = true;
      setNote("Exporting…");
      try {
        const r = await relIpc().appExport?.(app.id);
        if (r?.ok) setNote(r.path ? `Exported to ${r.path}` : "Exported");
        else setNote(r?.error || "Export failed", true);
      } catch (err) { setNote(err instanceof Error ? err.message : "Export failed", true); }
      finally { exportBtn.disabled = false; }
    });
    void refresh();
  }

  // ── Tasks view — every scheduled task, next fire, last outcome, run feed ──
  //
  // Data rides the EXISTING agent-task surface (library-agent-* IPC / the web
  // bridge's lib() mirrors) — no new endpoints. Next-run is DERIVED from the
  // cron here (nothing stores it): the 5-field expression is parsed once into
  // per-field sets, then minutes are scanned forward — worst case (a yearly
  // date) is a few hundred thousand set-lookups, well under a frame budget.
  interface WbAgentRow { id: string; slug?: string; name: string }
  interface WbTaskRow {
    id: string; name: string; kind: string; target: string; cron: string;
    enabled: boolean; lastRunAt: string | null; lastStatus: string | null; lastError: string | null;
  }
  interface WbTaskRun { id: string; startedAt: string; durationMs: number | null; status: string; error: string | null; output: string | null }
  interface WbTasksIpc {
    libraryAgentsList?: () => Promise<{ ok: boolean; data?: WbAgentRow[]; error?: string }>;
    libraryAgentTasks?: (ref: string) => Promise<{ ok: boolean; data?: WbTaskRow[]; error?: string }>;
    libraryAgentTaskRuns?: (ref: string, taskId: string) => Promise<{ ok: boolean; data?: WbTaskRun[]; error?: string }>;
    libraryAgentTaskRunNow?: (ref: string, taskId: string) => Promise<{ ok: boolean; error?: string }>;
    libraryAgentTaskUpdate?: (ref: string, taskId: string, patch: { enabled?: boolean }) => Promise<{ ok: boolean; error?: string }>;
  }
  const tasksIpc = (): WbTasksIpc => (window as unknown as { glyphh: WbTasksIpc }).glyphh;

  /** Parse a five-field cron into per-field membership sets. Null = invalid. */
  function cronSets(cron: string): Array<Set<number>> | null {
    const RANGES: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
    const fields = cron.trim().split(/\s+/);
    if (fields.length !== 5) return null;
    const out: Array<Set<number>> = [];
    for (let f = 0; f < 5; f++) {
      const [lo, hi] = RANGES[f];
      const set = new Set<number>();
      for (const part of fields[f].split(",")) {
        const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
        if (!m) return null;
        const start = m[1] === "*" ? lo : Number(m[1]);
        const end = m[1] === "*" ? hi : m[2] !== undefined ? Number(m[2]) : m[3] ? hi : start;
        const step = m[3] ? Number(m[3]) : 1;
        if (!step || start < lo || end > hi) return null;
        for (let v = start; v <= end; v += step) set.add(v);
      }
      out.push(set);
    }
    return out;
  }

  /** The next wall-clock minute the cron matches, or null (invalid / >400d out). */
  function cronNext(cron: string, from: Date): Date | null {
    const sets = cronSets(cron);
    if (!sets) return null;
    const t = new Date(from);
    t.setSeconds(0, 0);
    t.setMinutes(t.getMinutes() + 1);
    for (let i = 0; i < 400 * 24 * 60; i++) {
      if (sets[0].has(t.getMinutes()) && sets[1].has(t.getHours()) && sets[2].has(t.getDate())
        && sets[3].has(t.getMonth() + 1) && sets[4].has(t.getDay())) return t;
      t.setMinutes(t.getMinutes() + 1);
    }
    return null;
  }

  /** "every 15 min", "daily at 9:00", "Mon at 8:30" — falls back to the raw cron. */
  function cronHuman(cron: string): string {
    const f = cron.trim().split(/\s+/);
    if (f.length !== 5) return cron;
    const [min, hr, dom, mon, dow] = f;
    const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const at = (m: string, h: string) => `${h}:${m.padStart(2, "0")}`;
    if (cron === "* * * * *") return "every minute";
    if (/^\*\/(\d+)$/.test(min) && hr === "*" && dom === "*" && mon === "*" && dow === "*") return `every ${min.slice(2)} min`;
    if (/^\d+$/.test(min) && hr === "*" && dom === "*" && mon === "*" && dow === "*") return `hourly at :${min.padStart(2, "0")}`;
    if (/^\d+$/.test(min) && /^\d+$/.test(hr) && dom === "*" && mon === "*" && dow === "*") return `daily at ${at(min, hr)}`;
    if (/^\d+$/.test(min) && /^\d+$/.test(hr) && dom === "*" && mon === "*" && /^\d+$/.test(dow)) return `${DAYS[Number(dow) % 7]} at ${at(min, hr)}`;
    if (/^\d+$/.test(min) && /^\d+$/.test(hr) && /^\d+$/.test(dom) && mon === "*" && dow === "*") return `monthly on the ${dom} at ${at(min, hr)}`;
    return cron;
  }

  /** "in 3h 12m" / "2d ago" — coarse on purpose; the exact time is the title. */
  function relSpan(ms: number): string {
    const abs = Math.abs(ms);
    const m = Math.round(abs / 60000);
    const label = m < 1 ? "now" : m < 60 ? `${m}m` : m < 60 * 48 ? `${Math.floor(m / 60)}h ${m % 60 ? `${m % 60}m` : ""}`.trim() : `${Math.round(m / 1440)}d`;
    if (label === "now") return ms >= 0 ? "about now" : "just now";
    return ms >= 0 ? `in ${label}` : `${label} ago`;
  }

  /** Escape, then turn bare URLs into links — a run whose output names a built
   *  app / uploaded artifact becomes clickable without trusting any HTML. */
  function linkifyOutput(text: string): string {
    const esc = relEsc(text);
    return esc.replace(/https?:\/\/[^\s<>"')\]]+/g, (u) => `<a href="${u}" target="_blank" rel="noreferrer">${u}</a>`);
  }

  /** Load the bundled Chart.js (an IIFE → window.Chart) once. */
  let chartLibP: Promise<unknown> | null = null;
  function ensureChartJs(): Promise<unknown> {
    const w = window as unknown as { Chart?: unknown };
    if (w.Chart) return Promise.resolve(w.Chart);
    chartLibP ??= new Promise((resolve, reject) => {
      const sc = document.createElement("script");
      sc.src = "app-libs/chart.js";
      sc.onload = () => resolve(w.Chart);
      sc.onerror = () => { chartLibP = null; reject(new Error("chart lib failed to load")); };
      document.head.appendChild(sc);
    });
    return chartLibP;
  }

  async function renderTasksIntoSlot(body: HTMLElement, slot: TasksSlot): Promise<void> {
    body.classList.add("ws-tasks-body");
    // The panel header already says "Tasks" — no second heading. Layout:
    // chart (runs/day, ok vs failed) → two columns (create | recent runs) →
    // the full task list. A clicked task swaps the whole scroll to its
    // run-history detail; ‹ returns to the overview.
    body.innerHTML = `
      <div class="ws-tasks-scroll">
        <div class="ws-tasks-page">
        <h2 class="ws-tasks-title">Scheduled Tasks</h2>
        <p class="section-desc">Everything your agents run on a schedule — what fires next, how recent runs went, and a place to create more.</p>
        <div class="ws-tasks-chartwrap">
          <canvas class="ws-tasks-canvas"></canvas>
          <button type="button" class="ws-icon-btn ws-tasks-refresh" title="Refresh">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
          </button>
        </div>
        <div class="ws-tasks-cols">
          <div class="ws-tasks-col">
            <div class="ws-tasks-coltitle">Create with the agent</div>
            <div class="ws-tasks-prompts dash-starters"></div>
          </div>
          <div class="ws-tasks-col">
            <div class="ws-tasks-coltitle">Recent runs</div>
            <div class="ws-tasks-recent-list"><div class="ws-rel-empty">Loading…</div></div>
          </div>
        </div>
        <div class="ws-tasks-coltitle ws-tasks-alltitle">All tasks</div>
        <div class="ws-tasks-list"><div class="ws-rel-empty">Loading…</div></div>
        </div>
      </div>`;
    const scroll = body.querySelector(".ws-tasks-scroll") as HTMLElement;
    const list = body.querySelector(".ws-tasks-list") as HTMLElement;
    const recentsHost = body.querySelector(".ws-tasks-recent-list") as HTMLElement;
    const canRunNow = !!tasksIpc().libraryAgentTaskRunNow
      && !(window as unknown as { __GLYPHH_WEB__?: boolean }).__GLYPHH_WEB__;

    interface Row { agent: WbAgentRow; task: WbTaskRow; next: Date | null }
    interface RecentRun extends WbTaskRun { taskName: string; agentName: string }
    let rows: Row[] = [];
    let recents: RecentRun[] = [];
    let agents: WbAgentRow[] = [];

    async function load(): Promise<void> {
      const a = await tasksIpc().libraryAgentsList?.().catch(() => null);
      if (!a?.ok) { list.innerHTML = `<div class="ws-rel-empty">${relEsc(a?.error || "Couldn't load agents — sign in and try again.")}</div>`; return; }
      agents = a.data ?? [];
      const now = new Date();
      const all: Row[] = [];
      await Promise.all(agents.map(async (agent) => {
        const t = await tasksIpc().libraryAgentTasks?.(agent.id).catch(() => null);
        for (const task of t?.ok ? t.data ?? [] : []) {
          all.push({ agent, task, next: task.enabled ? cronNext(task.cron, now) : null });
        }
      }));
      all.sort((x, y) => (x.next?.getTime() ?? Infinity) - (y.next?.getTime() ?? Infinity));
      rows = all;
      // Run history for the chart + recents: the tasks that have actually run,
      // capped so a big fleet doesn't fan out dozens of reads.
      const ran = all.filter((r) => r.task.lastRunAt).slice(0, 12);
      const merged: RecentRun[] = [];
      await Promise.all(ran.map(async (r) => {
        const res = await tasksIpc().libraryAgentTaskRuns?.(r.agent.id, r.task.id).catch(() => null);
        for (const run of res?.ok ? res.data ?? [] : []) {
          merged.push({ ...run, taskName: r.task.name, agentName: r.agent.name });
        }
      }));
      merged.sort((x, y) => Date.parse(y.startedAt) - Date.parse(x.startedAt));
      recents = merged;
    }

    function paintChart(): void {
      const canvas = body.querySelector(".ws-tasks-canvas") as HTMLCanvasElement | null;
      if (!canvas) return;
      const css = getComputedStyle(document.documentElement);
      const accent = css.getPropertyValue("--accent").trim() || "#8c3bf2";
      const danger = css.getPropertyValue("--danger").trim() || "#e5534b";
      const text3 = css.getPropertyValue("--text-3").trim() || "#888";
      // Last 14 days, oldest → newest.
      const days: string[] = [];
      const keys: string[] = [];
      for (let i = 13; i >= 0; i--) {
        const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
        keys.push(d.toDateString());
        days.push(d.toLocaleDateString(undefined, { month: "short", day: "numeric" }));
      }
      const ok = new Array(14).fill(0);
      const bad = new Array(14).fill(0);
      for (const run of recents) {
        const idx = keys.indexOf(new Date(run.startedAt).toDateString());
        if (idx === -1) continue;
        if (run.status === "ok") ok[idx]++; else bad[idx]++;
      }
      void ensureChartJs().then((ChartLib) => {
        if (!body.isConnected || !ChartLib) return;
        type ChartCtor = new (el: HTMLCanvasElement, cfg: unknown) => { destroy(): void };
        const Chart = ChartLib as ChartCtor & { getChart?: (el: HTMLCanvasElement) => { destroy(): void } | undefined };
        Chart.getChart?.(canvas)?.destroy();
        new Chart(canvas, {
          type: "bar",
          data: {
            labels: days,
            datasets: [
              { label: "ok", data: ok, backgroundColor: accent, borderRadius: 3, maxBarThickness: 34 },
              { label: "failed", data: bad, backgroundColor: danger, borderRadius: 3, maxBarThickness: 34 },
            ],
          },
          options: {
            responsive: true, maintainAspectRatio: false, animation: false,
            plugins: {
              legend: { position: "bottom", labels: { color: text3, usePointStyle: true, pointStyle: "circle", boxWidth: 6, boxHeight: 6, font: { size: 11 } } },
              tooltip: { mode: "index", intersect: false },
            },
            scales: {
              x: { stacked: true, grid: { display: false }, ticks: { color: text3, maxRotation: 0, autoSkip: true } },
              y: { stacked: true, beginAtZero: true, grid: { color: css.getPropertyValue("--border").trim() || "rgba(255,255,255,0.08)" }, ticks: { color: text3, precision: 0 } },
            },
          },
        });
      }).catch(() => { /* chartless is fine — the lists still work */ });
    }

    function paintRecents(): void {
      if (!recents.length) { recentsHost.innerHTML = `<div class="ws-rel-empty">No runs yet.</div>`; return; }
      recentsHost.textContent = "";
      for (const run of recents.slice(0, 15)) {
        const el = document.createElement("div");
        el.className = "ws-task-recent" + (run.status === "ok" ? "" : " failed");
        const when = new Date(run.startedAt);
        el.innerHTML = `
          <span class="ws-task-chip ${run.status === "ok" ? "ok" : "err"}">${relEsc(run.status)}</span>
          <span class="ws-task-recent-name">${relEsc(run.taskName)}</span>
          <span class="ws-task-run-when" title="${relEsc(when.toLocaleString())}">${relEsc(relSpan(when.getTime() - Date.now()))}</span>`;
        const owner = rows.find((r) => r.task.name === run.taskName && r.agent.name === run.agentName);
        if (owner) el.addEventListener("click", () => { slot.taskId = owner.task.id; void paintDetail(owner); });
        recentsHost.appendChild(el);
      }
    }

    function paintList(): void {
      if (!body.isConnected) return;
      if (!rows.length) {
        list.innerHTML = `<div class="ws-rel-empty">No scheduled tasks yet — create one on the left, or just ask the agent.</div>`;
        return;
      }
      list.textContent = "";
      const now = Date.now();
      for (const r of rows) {
        const card = document.createElement("div");
        card.className = "ws-task-card" + (r.task.enabled ? "" : " off");
        const status = r.task.lastStatus
          ? `<span class="ws-task-chip ${r.task.lastStatus === "ok" ? "ok" : "err"}">${r.task.lastStatus === "ok" ? "ok" : "error"}</span>`
          : `<span class="ws-task-chip">never run</span>`;
        const next = r.task.enabled
          ? (r.next ? `<span class="ws-task-next" title="${relEsc(r.next.toLocaleString())}">${relEsc(relSpan(r.next.getTime() - now))}</span>` : `<span class="ws-task-next">—</span>`)
          : `<span class="ws-task-next">paused</span>`;
        card.innerHTML = `
          <div class="ws-task-head">
            <span class="ws-task-name">${relEsc(r.task.name)}</span>
            ${status}${next}
          </div>
          <div class="ws-task-sub">
            <span class="ws-task-agent">${relEsc(r.agent.name)}</span>
            <span class="ws-task-kind">${relEsc(r.task.kind.replace("_", " "))}</span>
            <span class="ws-task-target">${relEsc(r.task.target)}</span>
            <span class="ws-task-cron" title="${relEsc(r.task.cron)}">${relEsc(cronHuman(r.task.cron))}</span>
          </div>
          ${r.task.lastError ? `<div class="ws-task-lasterr">${relEsc(r.task.lastError)}</div>` : ""}`;
        card.addEventListener("click", () => { slot.taskId = r.task.id; void paintDetail(r); });
        list.appendChild(card);
      }
    }

    function paintOverview(): void {
      paintChart(); paintRecents(); paintList();
    }

    async function paintDetail(r: Row): Promise<void> {
      if (!body.isConnected) return;
      scroll.classList.add("hidden");
      let detail = body.querySelector<HTMLElement>(".ws-task-detailwrap");
      if (!detail) { detail = document.createElement("div"); detail.className = "ws-task-detailwrap"; body.appendChild(detail); }
      detail.classList.remove("hidden");
      detail.innerHTML = `
        <div class="ws-tasks-page">
        <div class="ws-task-detail-head">
          <button type="button" class="action-btn ws-task-back">‹ All tasks</button>
          <span class="ws-task-name">${relEsc(r.task.name)}</span>
          <span class="ws-task-cron">${relEsc(cronHuman(r.task.cron))}</span>
          ${canRunNow ? `<button type="button" class="action-btn primary ws-task-run">Run now</button>` : ""}
        </div>
        <div class="ws-task-runs"><div class="ws-rel-empty">Loading history…</div></div>
        </div>`;
      detail.querySelector(".ws-task-back")?.addEventListener("click", () => {
        slot.taskId = undefined;
        detail!.classList.add("hidden");
        scroll.classList.remove("hidden");
        paintOverview();
      });
      detail.querySelector(".ws-task-run")?.addEventListener("click", async (ev) => {
        const btn = ev.currentTarget as HTMLButtonElement;
        btn.disabled = true; btn.textContent = "Running…";
        try {
          const res = await tasksIpc().libraryAgentTaskRunNow?.(r.agent.id, r.task.id);
          if (!res?.ok) btn.textContent = res?.error ? "Failed" : "Run now";
        } catch { /* reported below on refresh */ }
        setTimeout(() => { if (body.isConnected && slot.taskId === r.task.id) void paintDetail(r); }, 4000);
        btn.disabled = false; btn.textContent = "Run now";
      });
      const runsHost = detail.querySelector(".ws-task-runs") as HTMLElement;
      const runs = await tasksIpc().libraryAgentTaskRuns?.(r.agent.id, r.task.id).catch(() => null);
      if (!body.isConnected || slot.taskId !== r.task.id) return;
      if (!runs?.ok) { runsHost.innerHTML = `<div class="ws-rel-empty">${relEsc(runs?.error || "Couldn't load run history")}</div>`; return; }
      if (!runs.data?.length) { runsHost.innerHTML = `<div class="ws-rel-empty">No runs yet.</div>`; return; }
      runsHost.textContent = "";
      for (const run of runs.data) {
        const el = document.createElement("div");
        el.className = "ws-task-run" + (run.status === "ok" ? "" : " failed");
        const when = new Date(run.startedAt);
        el.innerHTML = `
          <div class="ws-task-run-head">
            <span class="ws-task-chip ${run.status === "ok" ? "ok" : "err"}">${relEsc(run.status)}</span>
            <span class="ws-task-run-when" title="${relEsc(when.toLocaleString())}">${relEsc(relSpan(when.getTime() - Date.now()))}</span>
            ${run.durationMs != null ? `<span class="ws-task-run-dur">${relEsc((run.durationMs / 1000).toFixed(1))}s</span>` : ""}
          </div>
          ${run.error ? `<pre class="ws-task-run-err">${relEsc(run.error)}</pre>` : ""}
          ${run.output ? `<pre class="ws-task-run-out">${linkifyOutput(run.output)}</pre>` : ""}`;
        runsHost.appendChild(el);
      }
    }

    // ── Prompt cards — creating a scheduled task is a CONVERSATION, not a
    // form: each card seeds the composer with a prompt the agent knows how to
    // fulfil (build the skill + schedule it), then the user makes it theirs.
    const TASK_PROMPTS: Array<{ title: string; prompt: string }> = [
      { title: "Morning inbox brief", prompt: "Create a skill that checks my email every weekday at 8:00, summarizes what needs a reply, and schedule it as a daily task." },
      { title: "Daily digest", prompt: "Build a skill that runs every day at 9:00 and writes me a short digest of yesterday: what my agents did, anything that failed, anything waiting on me. Schedule it." },
      { title: "Watch a page", prompt: "Create a skill that checks a web page for changes every hour and messages me only when something meaningful changed. Ask me for the page, then schedule it." },
      { title: "Weekly report", prompt: "Create a skill that runs Mondays at 9:00 and drafts my weekly report from last week's sessions and tasks. Schedule it weekly." },
      { title: "Something else", prompt: "Help me create a scheduled task: ask me what should happen and when, then build the skill and schedule it." },
    ];
    const promptsHost = body.querySelector(".ws-tasks-prompts") as HTMLElement;
    for (const tp of TASK_PROMPTS) {
      // The + New Session landing's starter cards ARE the look — same classes,
      // so the theme styles this page for free.
      const cardEl = document.createElement("button");
      cardEl.type = "button";
      cardEl.className = "dash-starter";
      cardEl.innerHTML = `<span class="dash-starter-top"><span class="dash-starter-title">${relEsc(tp.title)}</span></span><span class="dash-starter-blurb">${relEsc(tp.prompt)}</span>`;
      cardEl.addEventListener("click", () => {
        (window as unknown as { __glyphhSeedSession?: (text: string) => void }).__glyphhSeedSession?.(tp.prompt);
      });
      promptsHost.appendChild(cardEl);
    }

    body.querySelector(".ws-tasks-refresh")?.addEventListener("click", () => { void load().then(() => { if (!slot.taskId) paintOverview(); }); });
    await load();
    const opened = slot.taskId ? rows.find((r) => r.task.id === slot.taskId) : null;
    if (opened) void paintDetail(opened); else { slot.taskId = undefined; paintOverview(); }
  }

  // ── Diff view ──
  async function renderDiffIntoSlot(body: HTMLElement, slot: DiffSlot): Promise<void> {
    registerLiveFsPanel(slot, body);
    if (!(await webFsReady(body, () => { void renderDiffIntoSlot(body, slot); }))) return;
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

    // Quiet, in-place refresh: after the first paint, keep the CURRENT diff
    // (and scroll position) on screen while the new one loads — no "loading…"
    // flash per agent write. Overlapping refreshes resolve to the newest.
    let painted = false;
    let refreshSeq = 0;
    async function refresh(): Promise<void> {
      const seq = ++refreshSeq;
      if (!painted) summary.textContent = "loading…";
      const res = cwd ? await window.wb.gitDiff(cwd) : { text: "", error: "no folder" };
      if (seq !== refreshSeq || !body.isConnected) return; // superseded / slot gone
      painted = true;
      const keepScroll = filesEl.scrollTop;
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
      // The expanded set was reapplied above — restoring scroll keeps the
      // hunk the user was reading under their eyes across a refresh.
      filesEl.scrollTop = keepScroll;
    }
    refreshBtn.addEventListener("click", refresh);
    // The workdir watcher's fs/git-changed fan-in refreshes THIS render's
    // closure (quiet + scroll-preserving) instead of poking the button.
    (body as HTMLElement & { __wbDiffRefresh?: () => void }).__wbDiffRefresh = () => { void refresh(); };
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

  let nextPreviewTabId = 1;
  /** The slot's tab model, migrating the legacy single url/html into tab 0. */
  function previewTabs(slot: PreviewSlot): PreviewTab[] {
    if (!slot.tabs || !slot.tabs.length) {
      slot.tabs = [{ id: nextPreviewTabId++, url: slot.url, html: slot.html, htmlLabel: slot.htmlLabel }];
    }
    for (const t of slot.tabs) if (!t.id) t.id = nextPreviewTabId++;
    if (slot.activeTab == null || slot.activeTab < 0 || slot.activeTab >= slot.tabs.length) slot.activeTab = 0;
    return slot.tabs;
  }
  /** Point the ACTIVE tab at a url or inline html (agent opens, build
   *  previews) and keep the legacy mirror fields in step. */
  /** Open a URL as a BROWSER TAB: reuse the tab already on it, fill an
   *  empty active tab, else ADD a tab beside the others. Programmatic opens
   *  (the agent's open_browser, file opens) used to overwrite the active
   *  tab — five opens left ONE tab showing the last URL. */
  function addPreviewUrlTab(slot: PreviewSlot, url: string): void {
    const tabs = previewTabs(slot);
    const existing = tabs.findIndex((t) => t.url === url);
    if (existing >= 0) {
      slot.activeTab = existing;
    } else {
      const a = tabs[slot.activeTab ?? 0];
      if (a && !a.url && !a.html) { a.url = url; a.title = undefined; }
      else { tabs.push({ id: nextPreviewTabId++, url }); slot.activeTab = tabs.length - 1; }
    }
    const act = tabs[slot.activeTab ?? 0];
    slot.url = act.url;
    slot.html = act.html;
    slot.htmlLabel = act.htmlLabel;
  }

  function setPreviewTarget(slot: PreviewSlot, target: { url?: string; html?: string; htmlLabel?: string }): void {
    const tabs = previewTabs(slot);
    const tab = tabs[slot.activeTab ?? 0];
    tab.url = target.url;
    tab.html = target.html;
    tab.htmlLabel = target.htmlLabel;
    tab.title = undefined;
    slot.url = target.url;
    slot.html = target.html;
    slot.htmlLabel = target.htmlLabel;
  }

  async function renderPreviewIntoSlot(body: HTMLElement, slot: PreviewSlot): Promise<void> {
    // WEB: the Browser panel is DESKTOP-ONLY — a <webview> is inert in a real
    // browser, and an iframe of an arbitrary site blanks on X-Frame-Options/
    // CSP. A workspace cell that configured a URL gets an honest error, not a
    // dead rectangle; on the desktop the same cell opens straight to its page.
    if (isWebTarget()) {
      body.innerHTML = "";
      const card = document.createElement("div");
      card.style.cssText = "flex:1 1 auto;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;color:var(--text-3);font-size:12.5px;line-height:1.6;background:var(--surface)";
      card.textContent = slot.url
        ? `The Browser panel can't open ${slot.url} on the web — browsers don't let a page embed arbitrary sites. Open this workspace on the desktop and it will open there automatically.`
        : "The Browser panel is desktop-only — open this workspace on the desktop.";
      body.appendChild(card);
      return;
    }
    // A native <webview> per TAB, NOT iframes (X-Frame-Options/CSP would blank
    // most of the web). Tabs swap by visibility — a webview reloads if its DOM
    // node moves, so every tab keeps its own guest and history.
    previewTabs(slot);
    // Re-read the start page on every open so a settings change takes effect
    // without a restart. paintFrames() below puts it in any empty tab.
    await primeBrowserHome();
    body.innerHTML = `
      <div class="ws-preview-tabs">
        <div class="wpt-list"></div>
        <button class="ws-icon-btn wpt-new" title="New tab"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
      </div>
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
        <div class="ws-preview-frames"></div>
      </div>
    `;
    const list = body.querySelector(".wpt-list") as HTMLElement;
    const newBtn = body.querySelector(".wpt-new") as HTMLButtonElement;
    const urlInput = body.querySelector(".ws-preview-input") as HTMLInputElement;
    const reloadBtn = body.querySelector(".ws-preview-reload") as HTMLButtonElement;
    const downloadBtn = body.querySelector(".ws-preview-download") as HTMLButtonElement;
    const openFileBtn = body.querySelector(".ws-preview-openfile") as HTMLButtonElement;
    const frames = body.querySelector(".ws-preview-frames") as HTMLElement;

    const views = new Map<number, WebviewEl & HTMLElement>();
    const active = (): PreviewTab => previewTabs(slot)[slot.activeTab ?? 0];
    const titleOf = (t: PreviewTab): string => {
      if (t.title) return t.title;
      if (t.html) return t.htmlLabel || "Glyphh build";
      if (t.url) { try { return new URL(t.url).hostname || t.url; } catch { return t.url; } }
      return "New tab";
    };
    /** The legacy single-target mirror follows the active tab. */
    const syncLegacy = (): void => {
      const a = active();
      slot.url = a.url;
      slot.html = a.html;
      slot.htmlLabel = a.htmlLabel;
    };
    // loadURL once the guest is attached; else the src attribute (queued until
    // attach). getWebContentsId THROWS before dom-ready — probe in try/catch.
    const setSrc = (wv: WebviewEl & HTMLElement, u: string): void => {
      try {
        if (wv.isConnected && wv.getWebContentsId?.() !== undefined) { wv.loadURL?.(u); return; }
      } catch { /* guest not attached yet */ }
      wv.setAttribute("src", u);
    };
    const ensureView = (t: PreviewTab): WebviewEl & HTMLElement => {
      const existing = views.get(t.id);
      if (existing) return existing;
      if (isWebTarget()) {
        // WEB: a tab's content is the SAME streamed renderer the web panels
        // use (a <webview> is inert in a browser). The holder div wears the
        // webview-shaped methods the tab plumbing calls (setSrc/loadURL/
        // reload/getURL), and far-side navs feed the tab title/url. Local
        // HTML previews render in a sandboxed srcdoc iframe.
        const holder = document.createElement("div") as unknown as WebviewEl & HTMLElement;
        holder.className = "ws-preview-frame";
        (holder as HTMLElement).style.display = "flex";
        let streamed: StreamedPanelHandle | null = null;
        const openUrl = (u: string): void => {
          streamed?.dispose();
          (holder as HTMLElement).innerHTML = "";
          streamed = mountStreamedPanel({
            url: u,
            onNav: (nu, title) => {
              if (nu) t.url = nu;
              if (title) { t.title = title; paintTabs(); }
              if (t.id === active().id) {
                syncLegacy();
                if (document.activeElement !== urlInput) urlInput.value = t.url || "";
              }
            },
          });
          streamed.el.style.flex = "1";
          streamed.el.style.minHeight = "0";
          (holder as HTMLElement).appendChild(streamed.el);
        };
        const h = holder as unknown as Record<string, unknown>;
        h.loadURL = (u: string) => { if (streamed) { streamed.navigate(u); t.url = u; } else openUrl(u); };
        h.getWebContentsId = () => 1;   // "guest attached" → setSrc takes the loadURL path
        h.reload = () => streamed?.reload();
        h.getURL = () => t.url || "";
        h.goBack = () => streamed?.back();
        h.goForward = () => streamed?.forward();
        const nativeSetAttr = HTMLElement.prototype.setAttribute.bind(holder as HTMLElement);
        h.setAttribute = (name: string, value: string) => {
          if (name === "src") { (h.loadURL as (u: string) => void)(value); return; }
          nativeSetAttr(name, value);
        };
        if (t.html) {
          const frame = document.createElement("iframe");
          frame.setAttribute("sandbox", "allow-scripts");
          frame.srcdoc = t.html;
          frame.style.cssText = "flex:1;min-height:0;width:100%;border:0;background:var(--bg-2)";
          (holder as HTMLElement).appendChild(frame);
        } else if (t.url) {
          openUrl(t.url);
        }
        frames.appendChild(holder as HTMLElement);
        views.set(t.id, holder);
        return holder;
      }
      const wv = document.createElement("webview") as WebviewEl & HTMLElement;
      wv.className = "ws-preview-frame";
      // DEFAULT session on purpose: glyphh-preview:// (local file/PDF/office
      // previews) is registered there only. "plugins" = native PDF viewer.
      wv.setAttribute("allowpopups", "");
      wv.setAttribute("plugins", "");
      // ── Failures become a PAGE, not a blank rectangle ──
      // Two different signals: did-fail-load means no document arrived at all,
      // so it always stands in. An HTTP 4xx/5xx did arrive — the server just
      // answered with an error — and plenty of sites serve a real page with
      // one, so that case is held until the load settles and only replaces a
      // body that turned out to be empty.
      let pendingStatus: { status: number; statusText?: string; url: string } | null = null;
      wv.addEventListener("did-start-loading", () => { pendingStatus = null; });
      wv.addEventListener("did-fail-load", (e) => {
        const err = e as unknown as { errorCode?: number; errorDescription?: string; validatedURL?: string; isMainFrame?: boolean };
        if (!isRealLoadFailure(err.errorCode) || err.isMainFrame === false) return;
        pendingStatus = null;
        (window as unknown as { glyphh?: { wbLog?: (m: string) => void } }).glyphh?.wbLog?.(
          `[wb] Browser tab failed to load (${err.errorCode} ${err.errorDescription || ""}).`);
        showBrowserError(wv, {
          url: err.validatedURL || t.url || "",
          errorCode: err.errorCode,
          description: err.errorDescription,
        });
      });
      wv.addEventListener("did-frame-navigate", (e) => {
        const r = e as unknown as { httpResponseCode?: number; httpStatusText?: string; isMainFrame?: boolean; url?: string };
        if (!r.isMainFrame || !r.httpResponseCode || r.httpResponseCode < 400) return;
        pendingStatus = { status: r.httpResponseCode, statusText: r.httpStatusText, url: r.url || t.url || "" };
      });
      wv.addEventListener("did-stop-loading", () => {
        const hit = pendingStatus;
        pendingStatus = null;
        if (!hit) return;
        // Their error page wins if they actually wrote one — replacing a real
        // 404 page with ours would hide the site's own navigation and copy.
        void wv.executeJavaScript?.("(document.body&&document.body.innerText||'').trim().length")
          .then((len) => {
            if (typeof len !== "number" || len > 40) return;
            showBrowserError(wv, { url: hit.url, status: hit.status, statusText: hit.statusText });
          })
          .catch(() => showBrowserError(wv, { url: hit.url, status: hit.status, statusText: hit.statusText }));
      });
      wv.addEventListener("did-navigate", (e) => {
        const u = (e as unknown as { url?: string }).url;
        if (!u || u === "about:blank" || u.startsWith("data:")) return;
        t.url = u;
        if (t.id === active().id) {
          syncLegacy();
          if (document.activeElement !== urlInput) urlInput.value = u;
        }
      });
      wv.addEventListener("page-title-updated", (e) => {
        const title = (e as unknown as { title?: string }).title;
        if (title) { t.title = title; paintTabs(); }
      });
      // RPA target: the panel is addressable as "preview" (its list_windows
      // slug) and always resolves to the ACTIVE tab — "save the data from
      // that page" reads the tab the user is looking at.
      wv.addEventListener("dom-ready", () => {
        if (t.id !== active().id) return;
        const wcId = (wv as WebviewEl).getWebContentsId?.();
        if (wcId !== undefined) rpaYo().rpaRegister?.("preview", wcId);
      });
      frames.appendChild(wv);
      views.set(t.id, wv);
      if (t.html) wv.setAttribute("src", "data:text/html;charset=utf-8," + encodeURIComponent(t.html));
      else if (t.url) wv.setAttribute("src", normalizePreviewUrl(t.url));
      return wv;
    };
    const paintFrames = (): void => {
      const a = active();
      // A tab with nothing in it opens the configured start page — the ONE
      // place that covers every route to an empty tab (a fresh Browser panel,
      // the + button, "close all", a layout cell with no URL), so the panel
      // always comes up on the page the user chose. This replaced a "Nothing
      // open" placeholder that no path can reach any more.
      if (!a.url && !a.html) {
        a.url = browserHome();
        a.title = undefined;
        syncLegacy();
        paintTabs();
      }
      const hasContent = !!(a.url || a.html);
      if (hasContent) {
        const wv = ensureView(a);
        // tab switches retarget RPA at the newly active tab (register overwrites)
        try {
          const wcId = (wv as WebviewEl).getWebContentsId?.();
          if (wcId !== undefined) rpaYo().rpaRegister?.("preview", wcId);
        } catch { /* guest not attached yet — the dom-ready hook registers it */ }
      }
      for (const [id, wv] of views) wv.style.visibility = id === a.id && hasContent ? "" : "hidden";
      if (document.activeElement !== urlInput) {
        urlInput.value = a.html ? a.htmlLabel || "Glyphh build" : a.url || "";
      }
    };
    const dropView = (t: PreviewTab): void => {
      const wv = views.get(t.id);
      if (wv) { wv.remove(); views.delete(t.id); }
    };
    const activate = (idx: number): void => {
      slot.activeTab = idx;
      syncLegacy();
      paintTabs();
      paintFrames();
    };
    const newTab = (): void => {
      const tabs = previewTabs(slot);
      tabs.push({ id: nextPreviewTabId++ });
      activate(tabs.length - 1);
      urlInput.focus();
    };
    const closeTab = (idx: number): void => {
      const tabs = previewTabs(slot);
      const [gone] = tabs.splice(idx, 1);
      if (gone) dropView(gone);
      if (!tabs.length) tabs.push({ id: nextPreviewTabId++ });
      const act = slot.activeTab ?? 0;
      activate(Math.min(idx < act ? act - 1 : act, tabs.length - 1));
    };
    const closeOthers = (idx: number): void => {
      const tabs = previewTabs(slot);
      for (const t of tabs.filter((_, i) => i !== idx)) dropView(t);
      slot.tabs = [tabs[idx]];
      activate(0);
    };
    const closeAll = (): void => {
      for (const t of previewTabs(slot)) dropView(t);
      slot.tabs = [{ id: nextPreviewTabId++ }];
      activate(0);
    };
    const openTabMenu = (ev: MouseEvent, idx: number): void => {
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
      mkItem("New tab", newTab);
      mkItem("Close tab", () => closeTab(idx));
      mkItem("Close other tabs", () => closeOthers(idx));
      mkItem("Close all tabs", closeAll);
      menu.style.left = `${ev.clientX}px`;
      menu.style.top = `${ev.clientY}px`;
      document.body.appendChild(menu);
      const r = menu.getBoundingClientRect();
      if (r.right > window.innerWidth - 8) menu.style.left = `${window.innerWidth - r.width - 8}px`;
      if (r.bottom > window.innerHeight - 8) menu.style.top = `${window.innerHeight - r.height - 8}px`;
      document.addEventListener("mousedown", onAway, true);
      document.addEventListener("keydown", onKey, true);
    };
    function paintTabs(): void {
      list.innerHTML = "";
      previewTabs(slot).forEach((t, i) => {
        const el = document.createElement("div");
        el.className = "ws-preview-tab" + (i === (slot.activeTab ?? 0) ? " active" : "");
        el.title = t.url || titleOf(t);
        el.innerHTML = `<span class="nm"></span><button class="close" title="Close tab">×</button>`;
        (el.querySelector(".nm") as HTMLElement).textContent = titleOf(t);
        el.addEventListener("click", (ev) => {
          if ((ev.target as HTMLElement).closest(".close")) { ev.stopPropagation(); closeTab(i); return; }
          if (i !== (slot.activeTab ?? 0)) activate(i);
        });
        el.addEventListener("contextmenu", (ev) => { ev.preventDefault(); ev.stopPropagation(); openTabMenu(ev, i); });
        list.appendChild(el);
      });
    }

    function navigate(): void {
      const u = normalizePreviewUrl(urlInput.value);
      if (!u) return;
      const a = active();
      a.html = undefined;
      a.htmlLabel = undefined;
      a.title = undefined;
      a.url = u;
      urlInput.value = u;
      syncLegacy();
      saveLayout();
      setSrc(ensureView(a), u);
      paintTabs();
      paintFrames();
    }
    urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") navigate(); });
    urlInput.addEventListener("blur", () => { if (urlInput.value.trim() && urlInput.value !== (active().url || "")) navigate(); });
    openFileBtn.addEventListener("click", async () => {
      const picked = await window.wb.pickFile();
      if (!picked) return;
      urlInput.value = picked;
      navigate();
    });
    reloadBtn.addEventListener("click", () => { views.get(active().id)?.reload?.(); });
    downloadBtn.addEventListener("click", () => {
      const wv = views.get(active().id);
      const u = wv?.getURL?.() || active().url;
      if (u && !u.startsWith("data:")) wv?.downloadURL?.(u);
    });
    newBtn.addEventListener("click", newTab);

    paintTabs();
    paintFrames();
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
    // CLOUD SESSIONS (his rule, 2026-08-19): terminals are machine-local; the
    // pod has no pty surface. Say so honestly instead of opening a local shell
    // that silently works on the WRONG filesystem.
    const src = (window as unknown as { __glyphhActiveSource?: () => { kind?: string } | null }).__glyphhActiveSource?.();
    if (src && src.kind && src.kind !== "local") {
      body.innerHTML = `<div class="ws-term-cloud-note">Terminal isn't available for cloud sessions — ask the agent to run commands in its workspace instead.</div>`;
      return;
    }
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
        // 'Glyphh Braille' is unicode-range scoped to U+2800-28FF — it only
        // ever supplies braille (the CLI's cat art); everything else falls
        // through to JetBrains Mono as before.
        fontFamily: "'Glyphh Braille', 'JetBrains Mono', 'SF Mono', 'Fira Code', Menlo, monospace",
        fontSize: 12,
        theme: terminalTheme(),
        scrollback: 10_000,
        // With the canvas renderer below, xterm draws box/block/BRAILLE
        // glyphs itself — the CLI's braille cat rendered as tofu because
        // the DOM renderer leaves those to a font chain that lacks them.
        customGlyphs: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostEl);
      try { term.loadAddon(new CanvasAddon()); }
      catch { /* canvas unavailable → DOM renderer still works, minus drawn glyphs */ }
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
      // Make sure the braille face is decoded before the renderer measures —
      // a canvas atlas built pre-load would cache tofu for those cells.
      try { void document.fonts.load("12px 'Glyphh Braille'", "⣿"); } catch { /* older engines */ }
      const doSpawn = (): void => {
        try { fit.fit(); } catch { /* noop */ }
        const { cols, rows } = term;
        if (isWebTarget()) {
          // WEB: window.wb is a no-op — the shell runs on the user's ATTACHED
          // DESKTOP over the pty relay instead (remote-terminal.ts).
          void spawnRemoteTerm(wbt, hostEl, cols, rows);
        } else {
          window.wb.termSpawn(wbt.ptyId, cwd || "", cols, rows);
          if (wbt.initCmd) {
            // The layout's slotted first command — once, after the shell boots.
            const cmd = wbt.initCmd;
            wbt.initCmd = undefined;
            setTimeout(() => window.wb.termWrite(wbt.ptyId, `${cmd}\r`), 600);
          }
        }
        // One more fit next frame — the first can land mid-reflow.
        requestAnimationFrame(() => { try { fit.fit(); } catch { /* noop */ } });
      };
      requestAnimationFrame(spawnWhenSized);
      term.onData((data) => {
        if (wbt.remote) { wbt.remote.write(data); return; }
        window.wb.termWrite(wbt.ptyId, data);
      });
      term.onResize(({ cols, rows }) => {
        if (wbt.remote) { wbt.remote.resize(cols, rows); return; }
        window.wb.termResize(wbt.ptyId, cols, rows);
      });
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
    if (t.remote) { t.remote.dispose(); t.remote = undefined; }
    else window.wb.termKill(t.ptyId);
    try { t.term?.dispose(); } catch { /* noop */ }
    t.term = undefined; t.fit = undefined; t.detach = undefined; t.ro = undefined;
  }

  // ── WEB terminal transport (remote pty on the attached desktop) ──
  /**
   * Open the relayed shell for a web Terminal tab. Failure renders the SAME
   * honest state card the streamed panel shows (desktop-offline / signed-out /
   * failed / disconnected) into the terminal host, with a retry — never a
   * dead black rectangle.
   */
  async function spawnRemoteTerm(wbt: WbTerminal, hostEl: HTMLElement, cols: number, rows: number): Promise<void> {
    const term = wbt.term;
    if (wbt.remote || !term) return;
    try {
      const remote = await openRemotePty({ cols, rows, cwd: cwd || undefined }, {
        onData: (bytes) => term.write(bytes),
        // Leave the buffer up on exit so the user can read it (local parity).
        onExit: () => { wbt.remote = undefined; },
        onDrop: () => {
          wbt.remote = undefined;
          showRemoteTermState(wbt, hostEl, "disconnected");
        },
      });
      if (wbt.term !== term) { remote.dispose(); return; } // tab killed while connecting
      wbt.remote = remote;
      hostEl.querySelector(".ws-term-offline")?.remove();
      if (wbt.initCmd) {
        // The layout's slotted first command — once, after the shell boots.
        const cmd = wbt.initCmd;
        wbt.initCmd = undefined;
        setTimeout(() => wbt.remote?.write(`${cmd}\r`), 600);
      }
      // The layout may have settled while the open round-tripped.
      if (term.cols !== cols || term.rows !== rows) remote.resize(term.cols, term.rows);
    } catch (err) {
      const state: PanelStateKey = err instanceof RemotePtyError ? err.state : "failed";
      showRemoteTermState(wbt, hostEl, state, err instanceof Error && !(err instanceof RemotePtyError) ? err.message : undefined);
    }
  }
  /** The panel-state card (mascot + badge + Try again) over the terminal host. */
  function showRemoteTermState(wbt: WbTerminal, host: HTMLElement, state: PanelStateKey, detail?: string): void {
    // The slot may have re-rendered since spawn (DnD reorder moves the xterm
    // element into a NEW host) — follow the live element, not the stale ref.
    const hostEl = (wbt.term?.element?.closest(".ws-terminal-host") as HTMLElement | null) ?? host;
    if (!hostEl.isConnected) return;
    hostEl.querySelector(".ws-term-offline")?.remove();
    if (getComputedStyle(hostEl).position === "static") hostEl.style.position = "relative";
    const overlay = document.createElement("div");
    overlay.className = "ws-term-offline";
    overlay.style.cssText = "position:absolute;inset:0;z-index:3;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;text-align:center;padding:24px;overflow:auto;background:var(--ws-bg-card,#1e1e1e);";
    overlay.innerHTML = panelStateFragment(state, {
      retryAttrs: 'data-term-retry="1"',
      ...(state === "desktop-offline"
        ? { detail: "This terminal runs a shell on your desktop. Open the Glyphh desktop app and sign in, then try again." }
        : detail ? { detail } : {}),
    });
    overlay.querySelector<HTMLButtonElement>("[data-term-retry]")?.addEventListener("click", () => {
      overlay.remove();
      const term = wbt.term;
      if (!term || wbt.remote) return;
      try { wbt.fit?.fit(); } catch { /* noop */ }
      void spawnRemoteTerm(wbt, hostEl, term.cols, term.rows);
    });
    hostEl.appendChild(overlay);
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
  // (The agent's ⋮ panel dropdown is GONE — his rule, 2026-08-20: the
  // workbench tools live on the command center as tiles, nowhere else.
  // Session actions live in the Recents list rows.)

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
  // Observe the ASIDE, not `.code-root`: the root keeps its size when the agent
  // dock is resized (dock + aside split it), so a root-only observer never sees a
  // dock drag. The aside's width tracks both, so it catches window resize too.
  const railsContainer = document.getElementById("code-workbench") ?? document.querySelector<HTMLElement>(".code-root");
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
    if (echoCtl) { echoCtl.openPreviewHtml(html, label); return; }
    let slot = rails.flatMap((r) => r.slots).find((s) => s.view === "preview") as PreviewSlot | undefined;
    if (!slot) {
      slot = makeSlot("preview") as PreviewSlot;
      setPreviewTarget(slot, { html, htmlLabel: label });
      placeSlot(slot);
      return; // placeSlot renders
    }
    setPreviewTarget(slot, { html, htmlLabel: label });
    renderRails();
  };

  // Thread → workbench bridges: the Code thread's file cards open a Monaco
  // tab; its run cards reveal (or spawn) a terminal slot.
  (window as unknown as { __wbOpenFile?: (path: string) => void }).__wbOpenFile = (path) => {
    const name = path.split(/[\\/]/).pop() || path;
    void openFileSmart({ name, path });
  };
  (window as unknown as { __wbOpenTerminal?: () => void }).__wbOpenTerminal = () => {
    if (echoCtl) { echoCtl.openTool("terminal"); return; }
    // MULTI-INSTANCE: every terminal command spawns its own panel.
    placeSlot(makeSlot("terminal"));
  };
  // Artifacts gallery (Files section) → workbench. Mount by KIND: code/text/
  // markdown open in Monaco (fetched as text from the artifact's short-lived
  // downloadUrl); image/pdf/other open in a preview panel at that url. The
  // artifact id stands in for a path so Monaco tabs dedupe per artifact.
  // Shape mirrors @glyphh/sdk FileArtifact (downloadUrl present on files.get).
  interface WbArtifact { id: string; name: string; kind: "code" | "text" | "markdown" | "image" | "pdf" | "other"; downloadUrl?: string; mime?: string }
  (window as unknown as { __wbOpenArtifact?: (a: WbArtifact) => void }).__wbOpenArtifact = (a) => {
    if (!a) return;
    const textual = a.kind === "code" || a.kind === "text" || a.kind === "markdown";
    if (textual) {
      const node = { name: a.name || a.id, path: `artifact:${a.id}` };
      if (a.downloadUrl) {
        void fetch(a.downloadUrl)
          .then((r) => r.text())
          .then((text) => openFileInMonaco(node, text))
          .catch((e) => openFileInMonaco(node, `// Couldn't load ${a.name}: ${String(e)}`));
        return;
      }
      openFileInMonaco(node, "");
      return;
    }
    // image / pdf / other — a preview panel at the short-lived download url.
    if (a.downloadUrl) { openPreviewUrl(a.downloadUrl); return; }
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
      void (window as unknown as { glyphh?: { layoutsOpen?: (n: string) => Promise<unknown> } }).glyphh?.layoutsOpen?.(layout.name);
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
    // The agent anchor is a GLOBAL setting (the agent's own picker → glyphhAnchorMode),
    // never a layout property: opening a layout leaves the agent exactly where the user
    // anchored it and just fills the available workspace.
    // Echo IS the layout manager: while it is mounted, a layout open lands
    // as Echo cards on the layout's grid (folder switching already ran).
    // A DOCKED agent is never a layout panel — openAgentCard() refuses to steal it and
    // the layout's agent cell is skipped, so the dock simply survives the open.
    if (echoCtl) { echoCtl.openLayout(layout); return; }
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
        type SessionsApi = { list(): Array<{ id: string }>; currentId(): string | null; switch(id: string): void; startNew(): void; stampWorkdir(dir: string): void; stampModels?(models: Record<string, string>): void; stampLoop?(loop: string): void };
        const sess = (window as unknown as { __agentSessions?: SessionsApi }).__agentSessions;
        const space = activateLayoutSpace(layout);
        const mode = layout.sessionMode ?? "keep";
        const stamp = (): void => {
          if (layout.folder) sess?.stampWorkdir(layout.folder);
          // The layout's loop + model slots bind to the session it just
          // resolved — this session only; others keep their own config.
          if (layout.loop) sess?.stampLoop?.(layout.loop);
          if (layout.modelSelections && Object.keys(layout.modelSelections).length) sess?.stampModels?.(layout.modelSelections);
        };
        if (!sess || mode === "keep") { stamp(); return; }
        if (mode === "new") { sess.startNew(); stamp(); return; }
        let last: string | null = null;
        try {
          last = localStorage.getItem(layoutSessionKey(layout.name, space))
            ?? localStorage.getItem(layoutSessionKeyLegacy(layout.name));
        } catch { /* no memory */ }
        const target = last ? (sess.list() as Array<{ id: string; mode?: string }>).find((c) => c.id === last) : undefined;
        const spaceOfMode = (m?: string): string => (m === "code" ? "code" : m === "chat" ? "chat" : "cowork");
        if (target && spaceOfMode(target.mode) === space) sess.switch(target.id);
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
    const hadSeat = rails.some((r) => r.slots.some(isAgentSeat));
    rails.length = 0;
    maximizedSlotId = null;
    const cols = Math.max(1, layout.cols);
    const usable = Math.max(0, railsBudget() - (cols + 1) * 6);
    const TOOL_VIEWS = new Set(["files", "terminal", "diff", "preview", "plan", "coding", "echo", "monaco", "releases"]);
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
    // A layout that carries no agent CLOSES the one that was open.
    if (hadSeat) notifySeatClosed();
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
  wbApp.__wbOpenApp = (app, _newPanel) => openAppCard(app);
  // The agent dock changes how much width the rails get, but the workbench owns
  // that math — the anchor module asks for a reflow rather than duplicating it.
  (wbApp as { __wbReflow?: () => void }).__wbReflow = () => { applyResponsiveWidths(); };
  // Re-home the agent to `.code-root`'s direct child — the ONLY DOM spot the
  // bottom-composer CSS (`.code-root[data-anchor="center"] > .code-agent`)
  // can style. applyAnchor() calls this at boot. Lightweight (no render).
  (wbApp as { __wbParkAgent?: () => void }).__wbParkAgent = () => {
    parkAgentHome();
    // Any stale Echo agent card is a placeholder husk — close it (session
    // stays alive) so the composer isn't shadowed by a blank panel.
    echoCtl?.detachAgent();
    scheduleAgentSync();
  };
  // The collapsed bar's transcript button — TOGGLES the transcript panel:
  // open it if absent, close it (parking the thread home) if present.
  (wbApp as { __wbOpenThread?: () => void }).__wbOpenThread = () => {
    const it = rails.flatMap((r) => r.slots).find((s) => s.view === "thread");
    if (it) closeSlot(it.id);
    else placeSlot(makeSlot("thread"));
  };
  // Peeking while the transcript panel is open flashes the panel instead of
  // stealing the thread out of it (code-anchor's togglePeek calls this).
  (wbApp as { __wbFlashThread?: () => void }).__wbFlashThread = () => {
    const slotEl = document.querySelector<HTMLElement>(".ws-rail-slot[data-view=\"thread\"]");
    if (!slotEl) return;
    slotEl.classList.remove("ws-thread-flash");
    // Force a restyle so back-to-back flashes re-trigger.
    void slotEl.offsetWidth;
    slotEl.classList.add("ws-thread-flash");
    window.setTimeout(() => slotEl.classList.remove("ws-thread-flash"), 900);
  };
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
        for (const a of apps) openAppCard(a);
      });
      return;
    }
    for (const a of apps) openAppCard(a);
  };
  // An anonymous grid (no name) must not write into whatever named layout was
  // active before — openLayoutInWorkbench ends in saveLayout().
  wbApp.__wbOpenLayout = (layout) => { activeLayoutName = null; openLayoutInWorkbench(layout); };
  // `.dip clear` — close all workspace panels. JUST the panels: sessions,
  // history, everything else stays untouched.
  wbApp.__wbClearPanels = () => {
    if (echoCtl) { echoCtl.closeAll(); return Promise.resolve(true); }
    return clearAllPanels();
  };
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
    const yo = (window as unknown as { glyphh?: { panelAppsList?: () => Promise<PanelAppRow[]>; layoutsList?: () => Promise<LayoutRow[]> } }).glyphh;
    const [rows, layouts] = await Promise.all([yo?.panelAppsList?.() ?? [], yo?.layoutsList?.() ?? []]).catch(() => [[], []] as [PanelAppRow[], LayoutRow[]]);
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
  wbApp.__wbListApps = () => [...appSlots().map((s) => ({ slug: s.slug, name: s.name })), ...(echoCtl?.list() ?? [])];
  wbApp.__wbCloseApp = (slug) => (echoCtl?.close(slug) || closeWbApp(slug));
  wbApp.__wbFocusApp = (slug) => {
    if (echoCtl?.focus(slug)) return true;
    const slot = appSlots().find((s) => s.slug === slug);
    if (!slot) return false;
    focusAppSlot(slot.id);
    return true;
  };
  wbApp.__wbToggleAppSwitcher = () => {
    openEchoSurface();
    // With panels open, "open the command center" means SHOW THE WALL over
    // them (the shadow pin) — and the same chord toggles back out.
    (window as unknown as { __wbEchoShadowPin?: () => void }).__wbEchoShadowPin?.();
  };
  // BOOT lands here instead (his rule, 2026-08-19): raise the surface, NO
  // shadow toggle — a boot-restored layout must come back seated, never with
  // the launcher lifted over it and no visible way down.
  (wbApp as { __wbOpenEchoHome?: () => void }).__wbOpenEchoHome = () => { openEchoSurface(); };
  // Tool panels by name (.dip plan, open_app("files"), tool-only layouts) —
  // in Echo they open as Echo cards like everything else.
  // A popup a page opened (target=_blank / window.open) — main denies the OS
  // window and routes it here so it lands in a SLOT like everything else.
  let popupSeq = 0;
  (window as unknown as { __wbOpenPopup?: (url: string) => void }).__wbOpenPopup = (url: string) => {
    if (!/^https?:/i.test(url)) return;
    let name = "Popup";
    try { name = new URL(url).hostname.replace(/^www\./, "") || "Popup"; } catch { /* keep */ }
    const ref: WbAppRef = { slug: `popup-${++popupSeq}`, name, url };
    openAppCard(ref);
  };
  // The rail's reset buttons: same move as Echo's ⟲ — everything closes,
  // the bare wall comes back.
  (window as unknown as { __wbEchoReset?: () => void }).__wbEchoReset = () => {
    openEchoSurface();
    echoCtl?.reset();
  };
  // THE NEW-SESSION POSTURE (his rule, 2026-08-18): everything that is
  // showing closes — every non-echo rails slot (seats, app panels) and every
  // Echo card/layout — leaving the bare wall and the permanent bottom
  // composer, focused and empty. newSessionInPlace calls this after it
  // empties the thread state.
  (window as unknown as { __wbNewSessionPanel?: () => void }).__wbNewSessionPanel = () => {
    // IN A LAYOUT (his rule, 2026-08-19, supersedes the no-exception posture):
    // ＋ starts the new session IN PLACE — the layout and every panel stay
    // exactly as they are; the thread state was already emptied upstream and
    // the docked agent repaints to the welcome. Only focus moves.
    if (document.body.classList.contains("echo-layout-active")) {
      document.getElementById("code-input")?.focus();
      return;
    }
    const ids = rails.flatMap((r) => r.slots.filter((s) => s.view !== "echo").map((s) => s.id));
    for (const id of ids) closeSlot(id);
    openEchoSurface();
    let tries = 0;
    const go = (): void => {
      if (!echoCtl) { if (tries++ < 40) requestAnimationFrame(go); return; }
      echoCtl.reset();
      echoCtl.openChat();   // → focuses the bottom composer
    };
    go();
  };
  // (__wbCloseAllForNewSession is gone with newSessionLanding — the ONE
  // new-session path is newSessionInPlace via __glyphhNewSession, and the
  // layout-clearing variant lives in activateGlyphh's leak-safe order.)
  // ⌘W (the menu's Close) closes the TOP PANEL first; only with nothing
  // open does it fall through to closing the window (the old behavior).
  // Esc no longer closes panels — it's real input to whatever is inside.
  (window as unknown as { glyphh?: { onCloseGesture?: (cb: () => void) => void; windowClose?: () => void } })
    .glyphh?.onCloseGesture?.(() => {
      if (echoCtl?.closeTop?.()) return;
      (window as unknown as { glyphh?: { windowClose?: () => void } }).glyphh?.windowClose?.();
    });
  (window as unknown as { __wbOpenTool?: (view: string) => void }).__wbOpenTool = (view: string) => {
    const v = view === "editor" ? "monaco" : view;
    if (!["files", "terminal", "diff", "preview", "plan", "monaco", "echo", "coding", "releases", "tasks"].includes(v)) return;
    if (echoCtl && v !== "coding" && v !== "echo" && v !== "tasks") { echoCtl.openTool(v as "files" | "terminal" | "monaco" | "diff" | "preview" | "plan" | "releases"); return; }
    if (!viewIsOpen(v as ViewKind)) placeView(v as Exclude<ViewKind, "app">);
  };
  wbApp.__wbOpenSection = (section: string) => openSectionInWorkbench(section);
  // #code-apps-btn is bound in help/code.ts initCode() via openCommandCenter so
  // it works cold (before this async init runs) and Cmd+. shares the same path.

  window.addEventListener("agent-sessions-changed", () => {
    type SessionsApi = { currentTitle(): string; currentId(): string | null };
    const sess = (window as unknown as { __agentSessions?: SessionsApi }).__agentSessions;
    // Remember which session rode this layout — "last" sessionMode resumes
    // it PER SPACE (the session's own space, so a Code conversation can
    // never become the Work binding).
    const cur = sess?.currentId?.();
    const riding = echoActiveLayout?.name ?? activeLayoutName;
    if (riding && cur) {
      type Listed = { id: string; mode?: string };
      const listed = ((sess as unknown as { list?: () => Listed[] }).list?.() ?? []).find((c) => c.id === cur);
      const space = listed?.mode === "code" ? "code" : listed?.mode === "chat" ? "chat" : "cowork";
      try { localStorage.setItem(layoutSessionKey(riding, space), cur); } catch { /* best effort */ }
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
    if (echoCtl) {
      // renderRails would DESTROY the mounted echo surface (fresh wall, no
      // cards) — refresh its folder-backed cards in place instead.
      echoCtl.refreshForCwd();
      return;
    }
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
  //  - Monaco tabs whose path matches: re-read from disk, fold into the live
  //    model in place (cursor + scroll preserved; dirty buffers untouched)
  //  - Diff slot: re-fetch quietly (expanded set + scroll preserved), also on
  //    the coalesced git-changed signal (commit/stage/checkout)
  //  - Files tree: re-list the OPEN directories in place, keeping expansion +
  //    scroll — never a from-scratch rebuild that collapses the tree.
  // Refresh ONLY the affected slots in place — never a full renderRails().
  // A folder under constant churn (a build, a dev server writing files) would
  // otherwise rebuild the entire workbench on every write, twitching the UI and
  // fighting the user's panel drags.
  async function refreshFilesSlotsInPlace(): Promise<void> {
    for (const { slot, body } of liveFsPanelsOf("files")) {
      const fslot = slot as FilesSlot;
      // Never rendered / re-rooted since — the full renderer owns first paint.
      if (!fslot.root) { void renderFilesIntoSlot(body, fslot); continue; }
      const treeEl = body.querySelector<HTMLElement>(".ws-files-tree");
      if (!treeEl) continue;
      // A live inline edit (rename / new file input) or an active search
      // outranks a background refresh — repainting would eat the user's
      // keystrokes or clobber the result list. The next change re-arms.
      if (treeEl.querySelector(".ws-files-newinput")) continue;
      const searchInput = body.querySelector<HTMLInputElement>(".file-search-input");
      if (searchInput && searchInput.value.trim()) continue;
      // Re-list every OPEN loaded directory (root included). refreshDirNode
      // merges by path, so surviving subtrees keep their expanded state.
      const refreshOpen = async (node: TreeNode): Promise<void> => {
        if (!node.loaded) return;
        await refreshDirNode(node);
        for (const c of node.children ?? []) {
          if (c.kind === "dir" && c.open && c.loaded) await refreshOpen(c);
        }
      };
      await refreshOpen(fslot.root);
      if (!treeEl.isConnected || !fslot.root) continue; // slot re-rendered mid-listing
      const keepScroll = treeEl.scrollTop;
      renderTreeRows(treeEl, fslot.root);
      treeEl.scrollTop = keepScroll;
    }
  }
  // Coalesce bursts: ONE trailing repaint per burst — an agent writing 50
  // files causes one re-list, not 50. Continuous churn repaints at most once
  // per window.
  const FS_REFRESH_DEBOUNCE_MS = 300;
  let filesRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleFilesRefresh(): void {
    if (filesRefreshTimer) return;
    filesRefreshTimer = setTimeout(() => {
      filesRefreshTimer = null;
      void refreshFilesSlotsInPlace();
    }, FS_REFRESH_DEBOUNCE_MS);
  }
  // The Diff panel shells out to git per refresh — same trailing coalescing.
  let diffRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleDiffRefresh(): void {
    if (diffRefreshTimer) return;
    diffRefreshTimer = setTimeout(() => {
      diffRefreshTimer = null;
      for (const { body } of liveFsPanelsOf("diff")) {
        (body as HTMLElement & { __wbDiffRefresh?: () => void }).__wbDiffRefresh?.();
      }
    }, FS_REFRESH_DEBOUNCE_MS);
  }

  window.wb.onFileChanged(async (abs) => {
    if (!cwd || !abs.startsWith(cwd)) return;
    // Monaco viewer tabs — re-read any matching, non-dirty tab and fold the
    // new content into the live editor via the panel's reload hook (cursor +
    // scroll preserved, dirty-tracking listener kept).
    for (const { slot, body } of liveFsPanelsOf("monaco")) {
      const mslot = slot as MonacoSlot;
      const tab = mslot.tabs.find((t) => t.path === abs);
      if (!tab || tab.dirty) continue; // never clobber unsaved edits
      const res = await window.wb.readFile(abs);
      if (res.error) continue;   // transient read race (rename/rewrite) — keep what's shown
      const hook = (body as HTMLElement & { __wbMonacoReload?: (abs: string, content: string) => void }).__wbMonacoReload;
      if (hook) hook(abs, res.content);
      else tab.content = res.content; // hook not mounted — next mount shows it
    }
    // Files tree + Diff — refresh the live panels in place, coalesced
    // (trailing debounce: a 50-file burst lands as ONE repaint each).
    if (liveFsPanelsOf("files").length) scheduleFilesRefresh();
    if (liveFsPanelsOf("diff").length) scheduleDiffRefresh();
  });
  // Git state moved without a worktree write (commit, stage, checkout) — the
  // diff is stale even though no watched file changed.
  window.wb.onGitChanged?.(() => {
    if (liveFsPanelsOf("diff").length) scheduleDiffRefresh();
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
