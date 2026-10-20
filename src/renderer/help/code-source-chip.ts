import { escapeHtml } from "./shared.js";
import { hostHas } from "./web-surface.js";
import { LOCUS_SVG, canWalkUp, filterPickerRows, folderGranted, pickerRecent, pickerSections, type Locus } from "./session-locus.js";
import { placeMenu, type PlaceBox } from "./menu-place.js";
/**
 * code-source-chip.ts — the WORKSPACE-SOURCE chip (ported from the platform's
 * RuntimeLocationChip), reimplemented in vanilla TS. It sits ABOVE the Code and
 * Work composers (never Chat) and picks where the next session RUNS + what it
 * WORKS ON. The trigger label reflects the current source; clicking opens a
 * drop-up with two sections:
 *
 *   CLOUD (remote runtime, the default)
 *     · Cloud                 — an empty git-init'd cloud workspace, no GitHub
 *       (sessions.create({ newProject:true }) on web).
 *     · GitHub repo  →        — a repo picker over git.repos(); not connected →
 *       a Connect-GitHub row (git.connect() OAuth URL, then poll git.status()).
 *   LOCAL (connected machines)
 *     · none →                — an install prompt (local needs an attached machine).
 *     · a machine  →          — a folder browser over the machine's FS
 *       (attach.fsList), capped at the machine root.
 *
 * TRANSPORT — this renderer is BOTH desktop Electron and app-web:
 *   · web    → window.glyphhSdk exposes .sessions / .git / .attach (the SDK
 *              handle). The cloud + remote-machine paths run against it.
 *   · desktop→ window.wb exposes local FS/git (listDir/gitInfo/pickCwd). Local
 *              folder picking runs against it; the cloud SDK resources may be
 *              absent (honest "connect on web" states then).
 * Every path degrades to an honest designed state — never a fake reply.
 *
 * The picked Source is owned by code.ts (persisted + threaded into the session
 * record + glyphhRun); this module is only the control.
 */

export type Source =
  /** `environmentId` rides on the bare workspace too, so the environment pick
   *  survives while no repo is picked yet (his report, 2026-10-05). */
  | { kind: "cloud-new"; dir?: string; environmentId?: string }
  /** `environmentId` names the member's cloud environment the session runs in
   *  (his direction, 2026-10-05: personal environments); absent = Default.
   *  `branch` is the base branch of `repo` (the first pick); `repos` is the
   *  whole selection, one base branch each (help/cloud-source.ts). */
  | { kind: "cloud-repo"; repo: string; dir?: string; environmentId?: string; branch?: string; repos?: Array<{ repo: string; branch: string }> }
  /** An EXISTING cloud workspace (his ask, 2026-08-19): `space` is the thread
   *  id that keyed the pod workspace — the run + the fs panels scope to it,
   *  so a new session re-enters the same folder. `label` is display only. */
  | { kind: "cloud-space"; space: string; label?: string; dir?: string }
  /** `machineId` is the attach socket's id, minted anew on every reconnect;
   *  `machine` is the desktop's NAME (its hostname), which is how a stale id
   *  is re-resolved before a run (his report, 2026-10-08). */
  | { kind: "local"; path: string; machineId?: string; machine?: string };

// ── SDK / bridge handles (both targets) ──────────────────────────────────
interface Repo { id: string; fullName: string; private: boolean; defaultBranch: string }
interface GitConnection { connected: boolean; login?: string | null }
interface GitConnectLink { url: string; state?: string }
interface AttachedMachine { id?: string; name?: string; app?: string; version?: string; capabilities?: string[]; /** The folders it granted for remote control. */ folders?: string[] }
interface AttachStatus { attached: boolean; machines: AttachedMachine[] }
interface FsEntry { name: string; path: string; dir: boolean; git?: boolean }
interface FsListing { path: string; parent: string | null; root?: string; entries: FsEntry[] }

interface SdkHandle {
  sessions?: { list?: () => Promise<unknown[]> };
  git?: { status?: () => Promise<GitConnection>; repos?: () => Promise<Repo[]>; connect?: () => Promise<GitConnectLink>; disconnect?: () => Promise<void> };
  attach?: { status?: () => Promise<AttachStatus>; fsList?: (path?: string) => Promise<FsListing>; dispatch?: (method: string, params?: Record<string, unknown>) => Promise<unknown> };
}
interface WbHandle {
  listDir?: (dir: string) => Promise<Array<{ name: string; isDir: boolean }>>;
  gitInfo?: (root: string) => Promise<{ isRepo: boolean; branch?: string }>;
  pickCwd?: (opts?: { nullOnCancel?: boolean }) => Promise<string | null>;
  getCwdExplicit?: () => Promise<string | null>;
}

const sdk = (): SdkHandle | undefined => (window as unknown as { glyphhSdk?: SdkHandle }).glyphhSdk;
const wbh = (): WbHandle | undefined => (window as unknown as { wb?: WbHandle }).wb;
const isWeb = (): boolean =>
  !!(window as unknown as { __GLYPHH_WEB__?: boolean }).__GLYPHH_WEB__
  || (typeof document !== "undefined" && document.documentElement.classList.contains("glyphh-web"));

// ── SVG glyphs ────────────────────────────────────────────────────────────
// Exported for the web's cloud chips (help/cloud-chips.ts) — one check, one
// chevron, one row builder across every chip drop.
export const CHECK = `<svg class="drop-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
export const CHEV = `<svg class="ws-chev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>`;
const FOLDER = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;

// ── Label ─────────────────────────────────────────────────────────────────
const lastSeg = (p: string): string => p.split("/").filter(Boolean).pop() || p;
function shortId(id?: string | null): string { return id ? String(id).replace(/^.*?-/, "").slice(0, 6) : ""; }

/** The compact label the chip shows for a source. Remote → `Fly · <id> · <folder>`,
 *  local → `Desktop · <folder>`. */
export function sourceLabel(source: Source, sessionId?: string | null, machineName?: string): string {
  if (source.kind === "local") {
    // The MACHINE'S NAME only — the folder chip beside it owns the folder.
    // Cloud labels are reserved for remote runs.
    // On web a local source exists only while attach.status listed a machine
    // (code.ts's default resolution), so this reads "My desktop" there.
    return machineName || (isWeb() ? "My desktop" : "This machine");
  }
  const folder = source.kind === "cloud-repo" && source.repo ? lastSeg(source.repo)
    : source.kind === "cloud-space" ? (source.label || `space ${shortId(source.space)}`)
    : "workspace";
  const id = shortId(sessionId);
  if (id) return `Fly · ${id} · ${folder}`;
  // Plain "Cloud" with no session yet — the repo or space, when there is one,
  // is the only thing worth qualifying it with.
  if (source.kind === "cloud-repo" && source.repo) return `Cloud · ${lastSeg(source.repo)}`;
  if (source.kind === "cloud-space") return `Cloud · ${folder}`;
  return "Cloud";
}


/**
 * Is git already enabled on this folder, and on what branch?
 *
 * ONE answer on both surfaces: the desktop asks its own FS bridge, the web
 * asks the machine over the attach relay (`fs.gitInfo`). Returns null when
 * neither transport can answer — the caller shows nothing rather than
 * guessing "no repo" at a folder it never actually checked.
 */
export async function gitStateFor(path: string): Promise<{ isRepo: boolean; branch?: string } | null> {
  if (!path) return null;
  const local = wbh()?.gitInfo;
  if (local) {
    try { return await local(path); } catch { return null; }
  }
  const dispatch = sdk()?.attach?.dispatch;
  if (!dispatch) return null;
  try {
    const r = await dispatch("fs.gitInfo", { path }) as { isRepo?: boolean; branch?: string } | null;
    return r ? { isRepo: !!r.isRepo, ...(r.branch ? { branch: r.branch } : {}) } : null;
  } catch { return null; }
}

// ── Chip factory ────────────────────────────────────────────────────────────
type ViewName = "root";

interface ChipController {
  el: HTMLElement;
  setSource: (s: Source) => void;
  setSessionId: (id: string | null) => void;
}

/** Build one source chip. `getSource`/`onPick` bridge to code.ts's owned state. */
export function createSourceChip(opts: {
  getSource: () => Source;
  onPick: (s: Source) => void;
  getSessionId: () => string | null;
}): ChipController {
  const wrap = document.createElement("div");
  wrap.className = "cl-runtime-chip-wrap";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cl-runtime-chip cl-runtime-btn";
  btn.title = "Where this session runs and what it works on";
  wrap.appendChild(btn);

  let menu: HTMLElement | null = null;
  let selectedMachine: AttachedMachine | null = null;
  let known: AttachedMachine[] = [];

  const nameFor = (s: Source): string => {
    if (s.kind !== "local") return "";
    const m = (s.machineId && known.find((k) => k.id === s.machineId)) || known.find((k) => k.name) || known[0];
    return m?.name || m?.app || "";
  };
  const paintChip = (): void => {
    const s = opts.getSource();
    const dotLive = s.kind === "local" ? "" : ` data-live="1"`;
    btn.innerHTML = `<span class="cl-runtime-dot"${dotLive}></span><span class="cl-runtime-lbl"></span>${CHEV}`;
    (btn.querySelector(".cl-runtime-lbl") as HTMLElement).textContent = sourceLabel(s, opts.getSessionId(), nameFor(s));
  };
  // The attached machines' hostnames label a local source ("chris-mbp · Home") —
  // resolved per source.machineId since several desktops can be attached.
  void listMachines().then((machines) => { known = machines; paintChip(); });

  const closeMenu = (): void => { menu?.remove(); menu = null; };

  const pick = (next: Source): void => { opts.onPick(next); paintChip(); closeMenu(); };

  const openMenu = (): void => {
    closeMenu();
    closeAllDrops();
    menu = document.createElement("div");
    menu.className = "code-drop-up ws-source-drop";
    wrap.appendChild(menu);
    showView("root");
    // Side + clamping are decided by clampDropX (edge alignment, one rule).
    clampDropUp(menu, btn);
    clampDropX(menu, btn);
  };

  const showView = (v: ViewName): void => {
    if (!menu) return;
    menu.textContent = "";
    if (v === "root") renderRoot(menu, opts, pick, (view, m) => { if (m) selectedMachine = m; showView(view); });
  };

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu) { closeMenu(); return; }
    openMenu();
  });
  document.addEventListener("mousedown", (e) => {
    if (menu && !wrap.contains(e.target as Node)) closeMenu();
  }, true);

  paintChip();
  return {
    el: wrap,
    setSource: () => paintChip(),
    setSessionId: () => paintChip(),
  };
}

// ── The GIT chip (landing row, after the folder) ──────────────────────────
const BRANCH_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 8v8"/><path d="M18 10v1a4 4 0 0 1-4 4H8"/></svg>`;

/** Open the MACHINE FOLDER BROWSER as a drop anchored to `anchor` — the folder
 *  chip's web plumbing (desktop keeps the native OS picker). Resolves the
 *  source's machine (machineId) so multi-desktop picks land on the right box. */
export function openMachineFolderBrowser(anchor: HTMLElement, opts: {
  getSource: () => Source;
  onPick: (s: Source) => void;
}): void {
  const wrap = anchor.parentElement || anchor;
  wrap.querySelector(".ws-source-drop")?.remove();
  closeAllDrops();
  const menu = document.createElement("div");
  menu.className = "code-drop-up ws-source-drop ws-drop-flex";
  (wrap as HTMLElement).style.position ||= "relative";
  wrap.appendChild(menu);
  clampDropUp(menu, anchor);
  clampDropX(menu, anchor);
  const close = (): void => menu.remove();
  const pick = (next: Source): void => { opts.onPick(next); close(); };
  void listMachines().then((machines) => {
    const s = opts.getSource();
    const mid = s.kind === "local" ? s.machineId : undefined;
    const machine = (mid && machines.find((m) => m.id === mid)) || machines[0] || null;
    renderLocal(menu, opts, machine, pick, close);
  });
  const away = (e: MouseEvent): void => {
    if (!menu.contains(e.target as Node) && e.target !== anchor) { close(); document.removeEventListener("mousedown", away, true); }
  };
  document.addEventListener("mousedown", away, true);
}

/**
 * THE FOLDER CHIP'S PICKER, explicit on both surfaces (his order, 2026-10-04:
 * "how does the user choose between local and cloud for a session?"). Two
 * sections, in this order:
 *
 *   ON THIS DESKTOP (the desktop) / ON <machine> (web: the attached desktop)
 *     · THE LAST FIVE folders used there (his order, 2026-10-04) — the
 *       desktop's own recent-folder list; on the web the folders this
 *       member's desktop sessions ran in, inside the grants — then
 *       "Browse…": the OS picker on the desktop, the folder browser
 *       (fs.list over the relay) inside each granted root on the web.
 *   IN THE CLOUD
 *     · THE LAST FIVE of the member's cloud folders — the thread workspaces
 *       from GET /api/harness/fs/spaces (a worker workspace mirrored to R2)
 *       — and "New cloud folder…", a fresh workspace named by the session id
 *       the first send mints. A born cloud session also offers "Folder in
 *       this workspace…" (the pod sub-folder browser).
 *
 * A SEARCH BOX under the head filters both sections by substring (the
 * recents search's rule, session-locus.ts filterPickerRows); the Browse and
 * New rows step aside while a query is typed. A cloud row that cannot be
 * picked says why in its hint and title: the born lock, or the probe's own
 * words (probeSources) — never a bare grey.
 *
 * A session's locus is FIXED AT BIRTH ("cloud stays cloud"): with a born
 * session open, the other section's rows are shown but not pickable, and
 * say why. The sections and the default come from session-locus.ts.
 */
export function openFolderLocusPicker(anchor: HTMLElement, opts: {
  getSource: () => Source;
  onPick: (s: Source) => void;
  /** The open session's locus once it has a turn; null = nothing is born. */
  bornLocus: Locus | null;
  /** The pod workspace a cloud folder pick can browse (a space, or a born
   *  session's thread); null when there is none yet. */
  cloudScope: string | null;
  onPickCloudDir: (relDir: string) => void;
  /** The member's recently used DESKTOP folders, newest first — the web's
   *  come from its sessions (code.ts); the desktop asks main's own list. */
  recentFolders?: () => readonly string[];
}): void {
  const wrap = anchor.parentElement || anchor;
  wrap.querySelector(".ws-source-drop")?.remove();
  closeAllDrops();
  const menu = document.createElement("div");
  menu.className = "code-drop-up ws-source-drop ws-drop-flex ws-locus-drop";
  (wrap as HTMLElement).style.position ||= "relative";
  wrap.appendChild(menu);
  clampDropUp(menu, anchor);
  clampDropX(menu, anchor);
  const close = (): void => menu.remove();
  const away = (e: MouseEvent): void => {
    if (!menu.contains(e.target as Node) && e.target !== anchor) { close(); document.removeEventListener("mousedown", away, true); }
  };
  document.addEventListener("mousedown", away, true);
  const pick = (next: Source): void => { opts.onPick(next); close(); };
  const surface = isWeb() ? "web" : "desktop";
  const src = opts.getSource();
  const currentFolder = src.kind === "local" ? src.path || "" : "";
  const currentSpace = src.kind === "cloud-space" ? src.space : "";

  /** The frame: the head, the search, and the list the search filters —
   *  the drill-downs (renderLocal) replace it and come back through paintRoot. */
  const frame = (): { search: HTMLInputElement; list: HTMLElement } => {
    menu.textContent = "";
    menu.insertAdjacentHTML("beforeend", `<div class="code-drop-head"><span>Where this session works</span></div>`);
    const search = document.createElement("input");
    search.type = "text";
    search.className = "loop-drop-search repo-drop-search ws-locus-search";
    search.placeholder = "Search folders…";
    search.spellcheck = false;
    search.autocomplete = "off";
    search.addEventListener("mousedown", (ev) => ev.stopPropagation());
    menu.appendChild(search);
    const list = document.createElement("div");
    list.className = "ws-locus-list";
    menu.appendChild(list);
    return { search, list };
  };

  const paintRoot = async (): Promise<void> => {
    const { search, list } = frame();
    list.insertAdjacentHTML("beforeend", `<div class="drop-empty">Checking your places…</div>`);
    // THE DESKTOP WORKS IN LOCAL FOLDERS ONLY: there is no cloud runtime to
    // ask, so it reads no machines, cloud folders or reachability.
    const local = surface === "desktop";
    const [machines, spaces, reach] = local
      ? [[] as Awaited<ReturnType<typeof listMachines>>, [] as Awaited<ReturnType<typeof listSpaces>>, {} as Awaited<ReturnType<typeof probeSources>>]
      : await Promise.all([listMachines(), listSpaces(), probeSources()]);
    if (!menu.isConnected) return;
    const model = pickerSections({
      surface,
      machines: machines.filter(() => surface === "web").map((m) => ({ id: m.id, name: m.name || m.app || "Glyphh desktop", folders: m.folders ?? [] })),
      spaces,
      bornLocus: opts.bornLocus,
    });
    const [desk, cloud] = model.sections;
    const machine = surface === "web" ? (machines.find((m) => m.id === desk.machine?.id) ?? machines[0] ?? null) : null;
    const w = wbh() as (WbHandle & { getCwdRecents?: () => Promise<string[]> }) | undefined;
    // THE LAST FIVE (his order, 2026-10-04): the desktop's own recent-folder
    // list there; on the web the folders this member's desktop sessions ran
    // in — inside the grants, the only ones the relay will run.
    const deskRecents = surface === "desktop"
      ? (await w?.getCwdRecents?.().catch(() => [] as string[])) ?? []
      : (opts.recentFolders?.() ?? []);
    if (!menu.isConnected) return;
    const titleFor = (window as unknown as { __glyphhSessionTitleFor?: (id: string) => string }).__glyphhSessionTitleFor;
    const labelOf = (sp: { id: string; top: readonly string[] }): string =>
      (titleFor?.(sp.id) || "").trim() || (sp.top.length ? sp.top.join(" · ") : `folder ${shortId(sp.id)}`);
    const rows = pickerRecent({
      surface,
      current: currentFolder,
      recents: deskRecents,
      granted: desk.folders,
      spaces: spaces.map((sp) => ({ id: sp.id, label: labelOf(sp), updatedAt: sp.updatedAt })),
      ...(currentSpace ? { currentSpace } : {}),
    });
    // WHY a cloud row cannot be picked: the born lock first (cloud stays
    // cloud), else the probe's own words. Never a bare grey.
    const cloudWhy: string | undefined = cloud.locked ?? (reach.cloud === false ? (reach.cloudWhy || "Can't reach the cloud runtime right now") : undefined);
    const lockRow = (row: HTMLElement, why: string | undefined): boolean => {
      if (!why) return false;
      markUnreachable(row, why);
      return true;
    };
    const mid = machine?.id ? { machineId: machine.id } : {};

    const draw = (): void => {
      list.textContent = "";
      const q = search.value.trim();
      const shown = filterPickerRows(rows, q);

      // ── the desktop ────────────────────────────────────────────────────
      const deskLabel = document.createElement("div");
      deskLabel.className = "ws-sec-label";
      deskLabel.innerHTML = `${LOCUS_SVG.local}<span></span>`;
      (deskLabel.querySelector("span") as HTMLElement).textContent = desk.label;
      list.appendChild(deskLabel);
      if (desk.empty) {
        const note = drillItem(surface === "web" && desk.machine ? "No folder granted" : "No desktop attached", desk.empty, "");
        note.classList.add("ws-install");
        markUnreachable(note, desk.empty);
        list.appendChild(note);
      } else {
        for (const dir of shown.desktop) {
          const sel = !!currentFolder && dir === currentFolder;
          const row = drillItem(lastSeg(dir), dir, sel ? CHECK : "");
          row.classList.add("ws-fs-row");
          if (sel) row.classList.add("selected");
          if (!lockRow(row, desk.locked)) row.addEventListener("click", () => pick({ kind: "local", path: dir, ...mid }));
          list.appendChild(row);
        }
        if (q && !shown.desktop.length) list.insertAdjacentHTML("beforeend", `<div class="drop-empty">No desktop folder matches.</div>`);
        if (!q && surface === "desktop") {
          const choose = drillItem("Browse…", "Pick any folder on this computer", "");
          if (!lockRow(choose, desk.locked)) {
            choose.addEventListener("click", () => {
              void w?.pickCwd?.({ nullOnCancel: true }).then((dir) => { if (dir) pick({ kind: "local", path: dir }); });
            });
          }
          list.appendChild(choose);
        } else if (!q) {
          // One Browse per granted root (the relay walks nothing outside
          // them); a single grant reads as plain "Browse…".
          const one = desk.folders.length === 1;
          for (const root of desk.folders) {
            const inside = !!currentFolder && folderGranted(currentFolder, [root]);
            const browse = drillItem(one ? "Browse…" : `Browse ${lastSeg(root)}…`, root, "");
            if (!lockRow(browse, desk.locked)) {
              browse.addEventListener("click", () => {
                menu.textContent = "";
                // Start in the current folder when it is inside this grant,
                // and walk UP as far as the grant (his report, 2026-10-05): a
                // walk capped where it opened could never reach a sibling.
                renderLocal(menu, opts, machine, pick, () => { void paintRoot(); }, inside ? currentFolder : root, root);
              });
            }
            list.appendChild(browse);
          }
        }
      }

      // ── the cloud (the web only) ───────────────────────────────────────
      if (local) return;
      const cloudLabel = document.createElement("div");
      cloudLabel.className = "ws-sec-label";
      cloudLabel.innerHTML = `${LOCUS_SVG.cloud}<span></span>`;
      (cloudLabel.querySelector("span") as HTMLElement).textContent = cloud.label;
      list.appendChild(cloudLabel);
      for (const c of shown.cloud) {
        const when = c.updatedAt ? new Date(c.updatedAt).toLocaleDateString() : "";
        const sel = c.id === currentSpace;
        const row = drillItem(c.label, when ? `Cloud folder · ${when}` : "Cloud folder", sel ? CHECK : "");
        if (sel) row.classList.add("selected");
        if (!lockRow(row, cloudWhy)) row.addEventListener("click", () => pick({ kind: "cloud-space", space: c.id, label: c.label }));
        list.appendChild(row);
      }
      if (q && !shown.cloud.length) list.insertAdjacentHTML("beforeend", `<div class="drop-empty">No cloud folder matches.</div>`);
      if (q) return;
      if (src.kind !== "local" && opts.cloudScope) {
        const sub = drillItem("Folder in this workspace…", "Pick a sub-folder of the session's cloud folder", "");
        if (!lockRow(sub, reach.cloud === false ? cloudWhy : undefined)) {
          sub.addEventListener("click", () => {
            close();
            openCloudFolderBrowser(anchor, { scope: opts.cloudScope, currentDir: (src as { dir?: string }).dir, onPickDir: opts.onPickCloudDir });
          });
        }
        list.appendChild(sub);
      }
      const fresh = drillItem("New cloud folder…", "A fresh workspace, named by the new session's id and mirrored to R2", src.kind === "cloud-new" ? CHECK : "");
      if (src.kind === "cloud-new") fresh.classList.add("selected");
      if (!lockRow(fresh, cloudWhy)) fresh.addEventListener("click", () => pick({ kind: "cloud-new" }));
      list.appendChild(fresh);
    };
    search.addEventListener("input", draw);
    draw();
    clampDropUp(menu, anchor);
    clampDropX(menu, anchor);
    requestAnimationFrame(() => search.focus());
  };
  void paintRoot();
}

/** The CLOUD workspace folder browser (his ask, 2026-08-20): the folder chip
 *  on a cloud source browses the POD workspace and picks a folder INSIDE it —
 *  the run's `subdir`. Needs a scope (an existing space, or a born session's
 *  thread); a cloud-new/repo source with no workspace yet gets the honest
 *  "appears after the first message" note. */
export function openCloudFolderBrowser(anchor: HTMLElement, opts: {
  scope: string | null;
  currentDir?: string;
  onPickDir: (relDir: string) => void;
}): void {
  const wrap = anchor.parentElement || anchor;
  wrap.querySelector(".ws-source-drop")?.remove();
  closeAllDrops();
  const menu = document.createElement("div");
  menu.className = "code-drop-up ws-source-drop ws-drop-flex";
  (wrap as HTMLElement).style.position ||= "relative";
  wrap.appendChild(menu);
  clampDropUp(menu, anchor);
  clampDropX(menu, anchor);
  const close = (): void => menu.remove();
  const away = (e: MouseEvent): void => {
    if (!menu.contains(e.target as Node) && e.target !== anchor) { close(); document.removeEventListener("mousedown", away, true); }
  };
  document.addEventListener("mousedown", away, true);

  menu.insertAdjacentHTML("beforeend", `<div class="code-drop-head"><span>Cloud workspace folder</span></div>`);
  const body = document.createElement("div");
  body.className = "ws-drop-body";
  menu.appendChild(body);

  if (!opts.scope) {
    body.insertAdjacentHTML("beforeend",
      `<div class="ws-note"><div class="ws-note-title">No workspace yet</div><div class="ws-note-body">This session's cloud workspace appears after its first message — send once, then pick a folder here.</div></div>`);
    return;
  }
  body.insertAdjacentHTML("beforeend", `<div class="drop-empty">Loading the workspace…</div>`);

  const browse = async (dir?: string): Promise<{ root: string; path: string; entries: Array<{ name: string; path: string; kind: string }> } | null> => {
    try {
      if (isWeb()) {
        const h = (sdk() as { harnessViaApi?: () => { fsInfo: (o: { scope?: string }) => Promise<{ root: string }>; fsList: (o: { dir?: string; scope?: string }) => Promise<{ entries: Array<{ name: string; path: string; kind: string }> }> } })?.harnessViaApi;
        if (!h) return null;
        const hc = h();
        const info = await hc.fsInfo({ scope: opts.scope! });
        const path = dir || info.root;
        const r = await hc.fsList({ dir: path, scope: opts.scope! });
        return { root: info.root, path, entries: (r.entries ?? []).filter((e) => e.kind === "dir") };
      }
      const g = (window as unknown as { glyphh?: { cloudFsBrowse?: (scope: string, dir?: string) => Promise<{ root: string; path: string; entries: Array<{ name: string; path: string; kind: string }> } | null> } }).glyphh;
      if (typeof g?.cloudFsBrowse !== "function") return null;
      return await g.cloudFsBrowse(opts.scope!, dir);
    } catch { return null; }
  };

  const paint = (root: string, path: string, entries: Array<{ name: string; path: string }>): void => {
    body.textContent = "";
    const rel = path === root ? "" : path.startsWith(root) ? path.slice(root.length).replace(/^\/+/, "") : path;
    const pathEl = document.createElement("div");
    pathEl.className = "ws-path";
    pathEl.title = path;
    pathEl.textContent = rel ? `workspace/${rel}` : "workspace";
    body.appendChild(pathEl);
    const list = document.createElement("div");
    list.className = "code-repo-drop-list ws-fs-list";
    body.appendChild(list);
    if (rel) {
      const up = drillItem("‹ up", "", "");
      up.classList.add("ws-fs-up");
      const parent = path.replace(/\/[^/]+\/?$/, "");
      up.addEventListener("click", () => { void walk(parent.length >= root.length ? parent : root); });
      list.appendChild(up);
    }
    for (const e of entries) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "code-drop-item ws-fs-row";
      row.innerHTML = `${FOLDER}<span class="drop-lines"><span></span></span>`;
      (row.querySelector(".drop-lines span") as HTMLElement).textContent = e.name;
      row.addEventListener("click", () => { void walk(e.path); });
      list.appendChild(row);
    }
    if (!entries.length) list.insertAdjacentHTML("beforeend", `<div class="drop-empty">No sub-folders here.</div>`);
    const use = document.createElement("button");
    use.type = "button";
    use.className = "action-btn primary ws-use-folder";
    use.textContent = rel ? `Use “${rel.split("/").pop()}”` : "Use the workspace root";
    use.addEventListener("click", () => { opts.onPickDir(rel); close(); });
    body.appendChild(use);
  };

  const walk = async (dir?: string): Promise<void> => {
    const r = await browse(dir);
    if (!r) {
      body.textContent = "";
      body.insertAdjacentHTML("beforeend",
        `<div class="ws-note"><div class="ws-note-title">Can't reach the workspace</div><div class="ws-note-body">The cloud runtime didn't answer — try again in a moment.</div></div>`);
      return;
    }
    paint(r.root, r.path, r.entries);
  };
  void walk(opts.currentDir ? undefined : undefined).then(() => { /* first paint at root */ });
}

/** ONE picker at a time, anywhere: hide the composer pops, remove the
 *  source-family drops — every opener calls this before showing its own. */
export function closeAllDrops(except?: HTMLElement | null): void {
  document.querySelectorAll<HTMLElement>(".code-drop-up").forEach((m) => {
    if (except && (m === except || m.contains(except))) return;
    if (m.classList.contains("ws-source-drop")) m.remove();
    else m.classList.add("hidden");
  });
}

/** A drop-UP must fit the space ABOVE its anchor — unclamped it runs past the
 *  top of the page. */
/** The box a drop actually has to live in: the intersection of every CLIPPING
 *  ancestor, not the viewport. A chip on the landing sits inside a card whose
 *  top edge is far below y=0, so measuring against the window let a drop-up
 *  run straight off the top of that card. */
function clipBoxFor(anchor: HTMLElement): { top: number; bottom: number; left: number; right: number } {
  let top = 0;
  let bottom = window.innerHeight;
  let left = 0;
  let right = window.innerWidth;
  for (let p = anchor.parentElement; p && p !== document.body; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (/hidden|clip|auto|scroll/.test(s.overflow + s.overflowX + s.overflowY)) {
      const r = p.getBoundingClientRect();
      top = Math.max(top, r.top);
      bottom = Math.min(bottom, r.bottom);
      left = Math.max(left, r.left);
      right = Math.min(right, r.right);
    }
  }
  return { top, bottom, left, right };
}

/** The clip box as the placement box menu-place.ts reads. */
function placeBoxFor(anchor: HTMLElement): PlaceBox {
  const c = clipBoxFor(anchor);
  return { left: c.left, top: c.top, width: Math.max(0, c.right - c.left), height: Math.max(0, c.bottom - c.top) };
}

/**
 * Hang a drop from its chip and keep it inside its clip box — ONE rule
 * (menu-place.ts placeMenu), shared with the recents dropdown and the filter
 * menu. The chip's edge that faces the middle of its row is the preferred
 * edge (chips on the left hang left-to-left, chips on the right hang
 * right-to-right); when that runs off the box the menu FLIPS to the other
 * edge, and when neither fits it is clamped and its width capped. A chip
 * drop is a drop-UP and never flips below (it would cover the input): it
 * caps its height to the room above and scrolls.
 */
export function clampDropX(menu: HTMLElement, anchor: HTMLElement): void {
  const a = anchor.getBoundingClientRect();
  const wrap = (anchor.parentElement || anchor).getBoundingClientRect();
  const row = anchor.closest<HTMLElement>(".code-composer-bar, .dash-wd-chips, .code-source-slot, .code-chips");
  const rowRect = row?.getBoundingClientRect();
  const onRight = !!rowRect && a.left + a.width / 2 > rowRect.left + rowRect.width / 2;
  const m = menu.getBoundingClientRect();
  const p = placeMenu(
    { left: a.left, top: a.top, width: a.width, height: a.height },
    { width: m.width, height: m.height },
    placeBoxFor(anchor),
    { align: onRight ? "right" : "left", side: "above", gap: 8 },
  );
  // The drop is absolutely positioned inside its wrap: viewport → wrap coordinates.
  menu.style.right = "auto";
  menu.style.left = `${Math.round(p.left - wrap.left)}px`;
  menu.style.maxWidth = `${p.maxWidth}px`;
}

/** The tallest any chip drop may be — the folder picker's height. Every drop
 *  shares it so the source menu can never out-grow the files menu and spill
 *  past the top of the surface it opens in. */
const DROP_MAX_PX = 320;

/** Size a drop-UP to the room ABOVE its chip (never below — a menu that
 *  drops down covers the input the user is about to type in). When the room
 *  is short the menu gets short and SCROLLS; it never overflows. */
export function clampDropUp(menu: HTMLElement, anchor: HTMLElement, maxPx: number = DROP_MAX_PX): void {
  const a = anchor.getBoundingClientRect();
  const p = placeMenu(
    { left: a.left, top: a.top, width: a.width, height: a.height },
    { width: menu.offsetWidth, height: maxPx },
    placeBoxFor(anchor),
    { side: "above", gap: 8 },
  );
  menu.style.bottom = "";
  menu.style.top = "";
  menu.style.maxHeight = `${Math.min(maxPx, p.maxHeight)}px`;
  menu.style.overflowY = "auto";
}

/** The "+" chip: NEW FOLDER only — no browsing. Creates one directory inside
 *  the source's current folder (Home when unset) on the machine and picks it. */
export function openNewFolderDrop(anchor: HTMLElement, opts: {
  getSource: () => Source;
  onPick: (s: Source) => void;
}): void {
  const wrap = anchor.parentElement || anchor;
  wrap.querySelector(".ws-source-drop")?.remove();
  closeAllDrops();
  const menu = document.createElement("div");
  menu.className = "code-drop-up ws-source-drop";
  (wrap as HTMLElement).style.position ||= "relative";
  wrap.appendChild(menu);
  const close = (): void => menu.remove();
  const src = opts.getSource();
  const parent = src.kind === "local" && src.path ? src.path : undefined;
  // The one interpolated value is escaped above; the rule cannot see it.
  // nosemgrep: typescript.react.security.audit.react-unsanitized-method.react-unsanitized-method
  menu.insertAdjacentHTML("beforeend", `<div class="code-drop-head"><span>New folder${parent ? ` in ${escapeHtml(lastSeg(parent))}` : " in Home"}</span></div>`);
  const nf = document.createElement("div");
  nf.className = "ws-fs-newfolder";
  nf.innerHTML = `<input class="loop-drop-search repo-drop-search" placeholder="Folder name…" spellcheck="false" autocomplete="off"><button type="button" class="action-btn primary">Create</button><span class="ws-fs-newfolder-err"></span>`;
  menu.appendChild(nf);
  // Same edge rule as every other chip drop: hang from the CHIP's edge, not
  // the row's. Without these it inherited the stylesheet's `left: 0`, which is
  // the chips ROW — so the new-folder drop sat left of the + it belongs to.
  clampDropUp(menu, anchor);
  clampDropX(menu, anchor);
  const input = nf.querySelector("input") as HTMLInputElement;
  const btn = nf.querySelector("button") as HTMLButtonElement;
  const err = nf.querySelector(".ws-fs-newfolder-err") as HTMLElement;
  input.addEventListener("mousedown", (ev) => ev.stopPropagation());
  const create = (): void => {
    const name = input.value.trim();
    if (!name) return;
    btn.disabled = true; err.textContent = "";
    void (sdk()?.attach?.dispatch?.("fs.mkdir", { ...(parent ? { path: parent } : {}), name }) ?? Promise.reject(new Error("no attached machine")))
      .then((made) => {
        const mid = src.kind === "local" ? src.machineId : undefined;
        opts.onPick({ kind: "local", path: (made as { path: string }).path, ...(mid ? { machineId: mid } : {}) });
        close();
      })
      .catch((e2) => { btn.disabled = false; err.textContent = (e2 as Error).message || "could not create"; });
  };
  btn.addEventListener("click", create);
  input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") create(); });
  requestAnimationFrame(() => input.focus());
  const away = (e: MouseEvent): void => {
    if (!menu.contains(e.target as Node) && e.target !== anchor) { close(); document.removeEventListener("mousedown", away, true); }
  };
  document.addEventListener("mousedown", away, true);
}

// ── Root view: CLOUD + LOCAL sections ────────────────────────────────────

// ── Reachability ──────────────────────────────────────────────────────────
//
// A session has to START by connecting somewhere. An option you cannot reach
// is not a choice — offering it just moves the failure to the first send, so
// each one is probed and DISABLED with the reason when it is down.

/** `null` = NOT YET KNOWN (the transport isn't up), which is different from
 *  `false` = tried and failed. Conflating them made a still-booting bridge
 *  read as "Cloud unavailable". */
export interface SourceReach {
  local: boolean | null;
  cloud: boolean | null;
  /** Why the cloud is down, when it is — the failure's own words, so a
   *  greyed row can say more than "can't reach". */
  cloudWhy?: string;
}
let reachCache: { at: number; value: SourceReach } | null = null;
const REACH_TTL_MS = 15_000;

/** Did the server ANSWER? An HTTP status — 401, 403, 404, 500, anything —
 *  means we reached it. Only a transport-level failure (DNS, refused,
 *  offline, CORS) means unreachable. Treating an expired token as "the cloud
 *  is down" told the user to switch runtimes when all they needed was a
 *  refresh.
 *
 *  THE SDK'S OWN ERROR (core/errors.ts ApiError) carries the status as
 *  `httpStatus` — this read `status`/`statusCode` only, so every answered
 *  request the SDK made looked like an outage (his report, 2026-10-04: the
 *  cloud rows all greyed out on the web). */
function answered(err: unknown): boolean {
  const e = err as { status?: number; statusCode?: number; httpStatus?: number; response?: { status?: number }; message?: string };
  if (typeof e?.status === "number" || typeof e?.statusCode === "number" || typeof e?.httpStatus === "number") return true;
  if (typeof e?.response?.status === "number") return true;
  return /\b(4\d{2}|5\d{2})\b/.test(String(e?.message ?? ""));
}
const errorText = (err: unknown): string => {
  const m = (err as { message?: unknown })?.message;
  return typeof m === "string" && m.trim() ? m.trim() : String(err ?? "no answer");
};

/** Can we reach an attached machine? Web asks the relay; on the desktop the
 *  machine is this process, so the only question is whether it can list. */
async function probeLocal(): Promise<boolean | null> {
  if (!isWeb()) return !!wbh()?.listDir;
  // Call it ON its resource — `const f = sdk().attach.status; f()` detaches the
  // method and the SDK reaches for `this.http`, which throws a TypeError that
  // looks exactly like an outage. Third time this bug has bitten today.
  const attach = sdk()?.attach;
  if (!attach?.status) return null;   // SDK bridge not up yet
  // Only a SUCCESSFUL status call can say whether a machine is attached.
  // `attached: false` is a real answer; a thrown error is not — a 401 or a
  // dropped connection tells us nothing about the user's desktop, so it stays
  // UNKNOWN rather than accusing a machine that may be sitting right there.
  try { return !!(await attach.status())?.attached; } catch { return null; }
}

/**
 * Can we reach the cloud runtime surface?
 *
 * On WEB the probe is THE CALL THE CLOUD ROWS ARE MADE OF: the harness front
 * door's `fsSpaces` (GET /api/harness/fs/spaces — the member's cloud folders).
 * It used to be `sessions.list()` (GET /api/sessions), a control-plane route
 * the server no longer serves: its 404 carried no `status` field this code
 * read, so the cloud read as DOWN on every web open and every cloud row
 * greyed out (his report, 2026-10-04). Reaching the front door — any HTTP
 * answer — is reachable; only a transport failure is not. The probe goes
 * through the SDK handle and nothing else: `window.glyphh` on web is a Proxy
 * that fabricates a function for ANY name, so a desktop-style fallback looks
 * present, gets called, and fails.
 *
 * On the DESKTOP main's thread list is the cheapest authenticated call that
 * proves the same path (auth + control plane).
 */
async function probeCloud(): Promise<{ ok: boolean | null; why?: string }> {
  if (isWeb()) {
    const h = (sdk() as { harnessViaApi?: () => { fsSpaces: () => Promise<unknown> } } | undefined)?.harnessViaApi;
    if (typeof h !== "function") return { ok: null };   // bridge not up yet — unknown, not down
    try { await h().fsSpaces(); return { ok: true }; }
    catch (err) { return answered(err) ? { ok: true } : { ok: false, why: `Can't reach the cloud runtime right now (${errorText(err)})` }; }
  }
  return { ok: null };   // the desktop has no cloud runtime to reach
}

/** Probe both, cached briefly so opening the menu twice is not two round trips.
 *  An UNKNOWN result is never cached — the next paint asks again. */
export async function probeSources(force = false): Promise<SourceReach> {
  if (!force && reachCache && Date.now() - reachCache.at < REACH_TTL_MS) return reachCache.value;
  if (force) reachCache = null;
  const [local, cloud] = await Promise.all([probeLocal(), probeCloud()]);
  const value: SourceReach = { local, cloud: cloud.ok, ...(cloud.why ? { cloudWhy: cloud.why } : {}) };
  if (local !== null && cloud.ok !== null) reachCache = { at: Date.now(), value };
  return value;
}
/** Mark a row unreachable: not clickable, and it says why. */
export function markUnreachable(row: HTMLElement, why: string): void {
  row.classList.add("ws-unreachable");
  row.setAttribute("aria-disabled", "true");
  row.setAttribute("title", why);
  const sub = row.querySelector<HTMLElement>(".drop-lines span:last-child");
  if (sub) sub.textContent = why;
}

function renderRoot(
  menu: HTMLElement,
  opts: { getSource: () => Source },
  pick: (s: Source) => void,
  onView: (v: ViewName, m?: AttachedMachine) => void,
): void {
  const s = opts.getSource();
  const isNew = s.kind === "cloud-new";
  const isRepo = s.kind === "cloud-repo";
  const isLocal = s.kind === "local";

  menu.insertAdjacentHTML("beforeend", `<div class="code-drop-head"><span>Workspace source</span></div>`);
  menu.insertAdjacentHTML("beforeend", `<div class="ws-sec-label">Cloud runtime</div>`);

  // The cloud runtime itself — the chip's label and this row read the same.
  const np = drillItem("Cloud", "Git-init'd in the cloud — no GitHub needed", isNew ? CHECK : "");
  np.addEventListener("click", () => { if (!np.classList.contains("ws-unreachable")) pick({ kind: "cloud-new" }); });
  menu.appendChild(np);
  void probeSources().then((reach) => {
    if (reach.cloud === false) markUnreachable(np, reach.cloudWhy || "Can't reach the cloud runtime right now");
  });

  // ── Your existing cloud SPACES — pick one to open a session back INSIDE
  // that workspace. Labeled by the session that made it when we still have
  // it, else by what's in the folder (an orphaned space stays reachable).
  const spacesHost = document.createElement("div");
  menu.appendChild(spacesHost);
  void listSpaces().then((spaces) => {
    if (!spaces.length) return;
    spacesHost.insertAdjacentHTML("beforeend", `<div class="ws-sec-label">Your spaces</div>`);
    const titleFor = (window as unknown as { __glyphhSessionTitleFor?: (id: string) => string }).__glyphhSessionTitleFor;
    for (const sp of spaces.slice(0, 8)) {
      const label = (titleFor?.(sp.id) || "").trim() || (sp.top.length ? sp.top.join(" · ") : `space ${shortId(sp.id)}`);
      const when = sp.updatedAt ? new Date(sp.updatedAt).toLocaleDateString() : "";
      const sel = s.kind === "cloud-space" && s.space === sp.id;
      const row = drillItem(label, when ? `Cloud workspace · ${when}` : "Cloud workspace", sel ? CHECK : "");
      if (sel) row.classList.add("selected");
      row.addEventListener("click", () => pick({ kind: "cloud-space", space: sp.id, label }));
      spacesHost.appendChild(row);
    }
  }).catch(() => { /* runtime unreachable — the section simply doesn't render */ });

  menu.insertAdjacentHTML("beforeend", `<div class="ws-sec-label">Connected machines</div>`);
  const machinesHost = document.createElement("div");
  machinesHost.insertAdjacentHTML("beforeend", `<div class="drop-empty">Checking your machines…</div>`);
  menu.appendChild(machinesHost);

  void listMachines().then((machines) => {
    machinesHost.textContent = "";
    if (!machines.length) {
      const install = drillItem("No machines connected", "Open the Glyphh desktop to run in a folder on the machine", "");
      install.classList.add("ws-install");
      // On desktop the app IS the machine — offer the local folder picker directly.
      if (!isWeb() && wbh()?.pickCwd) {
        install.addEventListener("click", () => {
          void wbh()!.pickCwd!({ nullOnCancel: true }).then((dir) => { if (dir) pick({ kind: "local", path: dir }); });
        });
      }
      machinesHost.appendChild(install);
      return;
    }
    void probeSources().then((reach) => {
      if (reach.local !== false) return;
      machinesHost.querySelectorAll<HTMLElement>(".code-drop-item")
        .forEach((row) => markUnreachable(row, "This machine isn't connected right now"));
    });
    machines.forEach((m) => {
      const name = m.name || m.app || "Glyphh desktop";
      const selected = isLocal && (s.machineId === m.id || s.machineId === undefined);
      // The source chip picks WHERE only — the folder chip beside it owns the
      // folder (no browsing in here). Picking a machine keeps a folder already
      // chosen on it; otherwise the session runs from Home.
      const row = drillItem(name, "Runs sessions on this machine", selected ? CHECK : "");
      if (selected) row.classList.add("selected");
      row.addEventListener("click", () => {
        const keep = isLocal && s.machineId === m.id && s.path ? s.path : "";
        pick({ kind: "local", path: keep, ...(m.id ? { machineId: m.id } : {}) });
      });
      machinesHost.appendChild(row);
    });
  });
}

/** The caller's existing cloud workspaces. Web reaches the SDK's harness
 *  surface directly; desktop asks the main process (cloud-spaces-list). */
async function listSpaces(): Promise<Array<{ id: string; updatedAt: number; top: string[] }>> {
  try {
    if (isWeb()) {
      const h = (sdk() as { harnessViaApi?: () => { fsSpaces: () => Promise<{ spaces: Array<{ id: string; updatedAt: number; top: string[] }> }> } })?.harnessViaApi;
      if (!h) return [];
      return (await h().fsSpaces()).spaces ?? [];
    }
    const g = (window as unknown as { glyphh?: { cloudSpacesList?: () => Promise<{ spaces?: Array<{ id: string; updatedAt: number; top: string[] }> }> } }).glyphh;
    if (typeof g?.cloudSpacesList !== "function") return [];
    return (await g.cloudSpacesList())?.spaces ?? [];
  } catch { return []; }
}

/** Connected machines: the SDK attach surface (web), or the local desktop
 *  itself (desktop, synthesized from wb). */
async function listMachines(): Promise<AttachedMachine[]> {
  const s = sdk();
  if (s?.attach?.status) {
    try { const st = await s.attach.status(); return st?.attached && Array.isArray(st.machines) ? st.machines : []; }
    catch { return []; }
  }
  // Desktop with no SDK attach: the running machine IS the local one.
  if (!isWeb() && wbh()?.pickCwd) return [{ id: "local", name: "This machine", capabilities: [] }];
  return [];
}

// ── Local → attached-machine folder browser ──────────────────────────────
function renderLocal(
  menu: HTMLElement,
  opts: { getSource: () => Source },
  machine: AttachedMachine | null,
  pick: (s: Source) => void,
  onBack: () => void,
  /** Where the walk starts; defaults to the source's own folder. The locus
   *  picker hands the current folder or a granted root here. */
  startAt?: string,
  /** The ceiling of the walk — the granted root on the web. Without one the
   *  listing's own root (or the first folder listed) is the ceiling. */
  capAt?: string,
): void {
  backHead(menu, machine?.name ? `On ${machine.name}` : "Local folder", onBack);
  const body = document.createElement("div");
  body.className = "ws-drop-body";
  menu.appendChild(body);
  body.insertAdjacentHTML("beforeend", `<div class="drop-empty">Checking your desktop…</div>`);

  const s = sdk();
  const startPath = startAt || (opts.getSource().kind === "local" ? (opts.getSource() as { path: string }).path : undefined);
  let root: string | null = capAt || null;

  const paintListing = (listing: FsListing): void => {
    body.textContent = "";
    const path = document.createElement("div");
    path.className = "ws-path";
    path.title = listing.path;
    path.textContent = listing.path;
    body.appendChild(path);
    const list = document.createElement("div");
    list.className = "code-repo-drop-list ws-fs-list";
    body.appendChild(list);
    // The MACHINE's root wins whenever the listing states it — pinning root to
    // the first path listed capped the walk at wherever the picker happened to
    // open, so a session already set deep in the tree could never go up.
    if (listing.root) root = listing.root;
    else if (!root) root = listing.path;
    if (canWalkUp(listing, root)) {
      const up = drillItem("‹ up", "", "");
      up.classList.add("ws-fs-up");
      up.addEventListener("click", () => walk(listing.parent!));
      list.appendChild(up);
    }
    const dirs = listing.entries.filter((e) => e.dir);
    for (const e of dirs) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "code-drop-item ws-fs-row";
      row.innerHTML = `${FOLDER}<span class="drop-lines"><span></span></span>${e.git ? `<span class="ws-gitdot" title="git repository"></span>` : ""}`;
      (row.querySelector(".drop-lines span") as HTMLElement).textContent = e.name;
      row.addEventListener("click", () => walk(e.path));
      list.appendChild(row);
    }
    if (!dirs.length) list.insertAdjacentHTML("beforeend", `<div class="drop-empty">No sub-folders here.</div>`);
    // Browse + pick ONLY — creating a folder is the '+' chip's job
    // (openNewFolderDrop), not the picker's.
    const use = document.createElement("button");
    use.type = "button";
    use.className = "action-btn primary ws-use-folder";
    use.textContent = "Use this folder";
    use.addEventListener("click", () => pick({ kind: "local", path: listing.path, ...(machine?.id ? { machineId: machine.id } : {}) }));
    body.appendChild(use);
  };

  const walk = (path?: string): void => {
    // Web: the SDK attach fsList. Desktop-local: wb.listDir synthesized into a listing.
    if (s?.attach?.fsList) {
      void s.attach.fsList(path).then((res) => {
        if (res && Array.isArray(res.entries)) paintListing(res);
        else unsupported();
      }).catch(() => unsupported());
      return;
    }
    if (!isWeb() && wbh()?.listDir) void walkLocal(path);
    else unsupported();
  };

  // Desktop-local folder walk over wb.listDir/gitInfo — capped at the picked root.
  const walkLocal = async (path?: string): Promise<void> => {
    const w = wbh()!;
    let dir = path;
    if (!dir) dir = (await w.getCwdExplicit?.().catch(() => null)) || undefined;
    if (!dir) {
      // No current folder — offer the OS picker to establish the root.
      const picked = await w.pickCwd?.({ nullOnCancel: true }).catch(() => null);
      if (!picked) { unsupported("Pick a working folder to run a local session in."); return; }
      dir = picked;
    }
    try {
      const rows = await w.listDir!(dir);
      const parent = dir.replace(/\/[^/]+\/?$/, "") || "/";
      const entries: FsEntry[] = await Promise.all(
        rows.filter((r) => r.isDir && !r.name.startsWith(".")).map(async (r) => {
          const p = `${dir!.replace(/\/$/, "")}/${r.name}`;
          const gi = await w.gitInfo?.(p).catch(() => null);
          return { name: r.name, path: p, dir: true, git: !!gi?.isRepo };
        }),
      );
      paintListing({ path: dir, parent: parent === dir ? null : parent, root: root || dir, entries });
    } catch { unsupported(); }
  };

  const unsupported = (msg?: string): void => {
    body.textContent = "";
    body.insertAdjacentHTML("beforeend",
      `<div class="ws-note"><div class="ws-note-title">Folder browsing needs a desktop update</div><div class="ws-note-body">${msg || "This build can't list folders on the attached machine yet. Update the Glyphh desktop app to pick a local folder."}</div></div>`);
  };

  // Prime: confirm attachment (web) then walk.
  if (s?.attach?.status) {
    void s.attach.status().then((st) => {
      if (!st?.attached) {
        body.textContent = "";
        body.insertAdjacentHTML("beforeend",
          `<div class="ws-note"><div class="ws-note-title">Install the desktop app</div><div class="ws-note-body">Local sessions need your Glyphh desktop attached.</div></div>`);
        return;
      }
      walk(startPath);
    }).catch(() => walk(startPath));
  } else {
    walk(startPath);
  }
}

// ── small builders ────────────────────────────────────────────────────────
export function drillItem(main: string, hint: string, trailingSvg: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "code-drop-item";
  b.innerHTML = `<span class="drop-lines"><span class="ws-main"></span>${hint ? `<span class="drop-hint"></span>` : ""}</span>${trailingSvg}`;
  (b.querySelector(".ws-main") as HTMLElement).textContent = main;
  if (hint) (b.querySelector(".drop-hint") as HTMLElement).textContent = hint;
  return b;
}

export function backHead(menu: HTMLElement, title: string, onBack: () => void): void {
  const head = document.createElement("div");
  head.className = "code-drop-head ws-back-head";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "ws-back";
  back.title = "Back";
  back.textContent = "‹";
  back.addEventListener("click", (e) => { e.stopPropagation(); onBack(); });
  const label = document.createElement("span");
  label.textContent = title;
  head.append(back, label);
  menu.appendChild(head);
}
