/**
 * code-source-chip.ts — the WORKSPACE-SOURCE chip (ported from the platform's
 * RuntimeLocationChip), reimplemented in vanilla TS. It sits ABOVE the Code and
 * Work composers (never Chat) and picks where the next session RUNS + what it
 * WORKS ON. The trigger label reflects the current source; clicking opens a
 * drop-up with two sections:
 *
 *   CLOUD (remote runtime, the default)
 *     · New project (empty)  — an empty git-init'd cloud workspace, no GitHub
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
  | { kind: "cloud-new" }
  | { kind: "cloud-repo"; repo: string }
  | { kind: "local"; path: string; machineId?: string };

// ── SDK / bridge handles (both targets) ──────────────────────────────────
interface Repo { id: string; fullName: string; private: boolean; defaultBranch: string }
interface GitConnection { connected: boolean; login?: string | null }
interface GitConnectLink { url: string; state?: string }
interface AttachedMachine { id?: string; name?: string; app?: string; version?: string; capabilities?: string[] }
interface AttachStatus { attached: boolean; machines: AttachedMachine[] }
interface FsEntry { name: string; path: string; dir: boolean; git?: boolean }
interface FsListing { path: string; parent: string | null; root?: string; entries: FsEntry[] }

interface SdkHandle {
  sessions?: { list?: () => Promise<unknown[]> };
  git?: { status?: () => Promise<GitConnection>; repos?: () => Promise<Repo[]>; connect?: () => Promise<GitConnectLink> };
  attach?: { status?: () => Promise<AttachStatus>; fsList?: (path?: string) => Promise<FsListing> };
}
interface WbHandle {
  listDir?: (dir: string) => Promise<Array<{ name: string; isDir: boolean }>>;
  gitInfo?: (root: string) => Promise<{ isRepo: boolean; branch?: string }>;
  pickCwd?: (opts?: { nullOnCancel?: boolean }) => Promise<string | null>;
  getCwdExplicit?: () => Promise<string | null>;
}

const sdk = (): SdkHandle | undefined => (window as unknown as { glyphhSdk?: SdkHandle }).glyphhSdk;
const wbh = (): WbHandle | undefined => (window as unknown as { wb?: WbHandle }).wb;
const isWeb = (): boolean => !!(window as unknown as { __GLYPHH_WEB__?: boolean }).__GLYPHH_WEB__;

// ── SVG glyphs ────────────────────────────────────────────────────────────
const CHECK = `<svg class="drop-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const CHEV = `<svg class="ws-chev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>`;
const FOLDER = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;

// ── Label ─────────────────────────────────────────────────────────────────
const lastSeg = (p: string): string => p.split("/").filter(Boolean).pop() || p;
function shortId(id?: string | null): string { return id ? String(id).replace(/^.*?-/, "").slice(0, 6) : ""; }

/** The compact label the chip shows for a source. Remote → `Fly · <id> · <folder>`,
 *  local → `Desktop · <folder>`. */
export function sourceLabel(source: Source, sessionId?: string | null): string {
  if (source.kind === "local" && source.path) return `Desktop · ${lastSeg(source.path)}`;
  const folder = source.kind === "cloud-repo" && source.repo ? lastSeg(source.repo) : "workspace";
  const id = shortId(sessionId);
  if (id) return `Fly · ${id} · ${folder}`;
  return `Cloud · ${source.kind === "cloud-repo" && source.repo ? lastSeg(source.repo) : "new project"}`;
}

// ── Chip factory ────────────────────────────────────────────────────────────
type ViewName = "root" | "repos" | "local";

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

  const paintChip = (): void => {
    const s = opts.getSource();
    const dotLive = s.kind === "local" ? "" : ` data-live="1"`;
    btn.innerHTML = `<span class="cl-runtime-dot"${dotLive}></span><span class="cl-runtime-lbl"></span>${CHEV}`;
    (btn.querySelector(".cl-runtime-lbl") as HTMLElement).textContent = sourceLabel(s, opts.getSessionId());
  };

  const closeMenu = (): void => { menu?.remove(); menu = null; };

  const pick = (next: Source): void => { opts.onPick(next); paintChip(); closeMenu(); };

  const openMenu = (): void => {
    closeMenu();
    menu = document.createElement("div");
    menu.className = "code-drop-up ws-source-drop";
    wrap.appendChild(menu);
    showView("root");
    // Anchor the drop-up up-and-left of the chip (mirrors openChipDropUp).
    menu.style.left = "auto"; menu.style.right = "0px";
    const wb = wrap.getBoundingClientRect();
    menu.style.maxHeight = `${Math.max(160, Math.round(wb.top - 8 - 12))}px`;
    menu.style.overflowY = "auto";
    const mb = menu.getBoundingClientRect();
    if (mb.left < 8) { menu.style.right = "auto"; menu.style.left = `${Math.round(8 - wb.left)}px`; }
  };

  const showView = (v: ViewName): void => {
    if (!menu) return;
    menu.textContent = "";
    if (v === "root") renderRoot(menu, opts, pick, (view, m) => { if (m) selectedMachine = m; showView(view); });
    else if (v === "local") renderLocal(menu, opts, selectedMachine, pick, () => showView("root"));
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

/** The repo picker for a CLOUD source — the repository the remote agent checks
 *  out into the project workspace. Hidden on a local source (the passive
 *  branch mirror covers local); "Connect GitHub" when no account is linked
 *  (renderRepos carries the connect flow + poll). */
export function createGitChip(opts: {
  getSource: () => Source;
  onPick: (s: Source) => void;
}): { el: HTMLElement; refresh: () => void } {
  const wrap = document.createElement("div");
  wrap.className = "cl-runtime-chip-wrap";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cl-runtime-chip cl-runtime-btn";
  btn.title = "The GitHub repository this cloud workspace checks out";
  wrap.appendChild(btn);

  let menu: HTMLElement | null = null;
  const closeMenu = (): void => { menu?.remove(); menu = null; };

  const paint = (): void => {
    const s = opts.getSource();
    if (s.kind === "local") { wrap.style.display = "none"; return; }
    wrap.style.display = "";
    const label = s.kind === "cloud-repo" && s.repo ? lastSeg(s.repo) : "Connect GitHub";
    btn.innerHTML = `${BRANCH_SVG}<span class="cl-runtime-lbl"></span>${CHEV}`;
    (btn.querySelector(".cl-runtime-lbl") as HTMLElement).textContent = label;
  };

  const pick = (next: Source): void => { opts.onPick(next); paint(); closeMenu(); };

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu) { closeMenu(); return; }
    menu = document.createElement("div");
    menu.className = "code-drop-up ws-source-drop";
    wrap.appendChild(menu);
    renderRepos(menu, opts, pick, closeMenu);
    menu.style.left = "0px"; menu.style.right = "auto";
    const wb2 = wrap.getBoundingClientRect();
    menu.style.maxHeight = `${Math.max(160, Math.round(window.innerHeight - wb2.bottom - 20))}px`;
    menu.style.overflowY = "auto";
  });
  document.addEventListener("mousedown", (e) => {
    if (menu && !wrap.contains(e.target as Node)) closeMenu();
  }, true);

  paint();
  return { el: wrap, refresh: paint };
}

// ── Root view: CLOUD + LOCAL sections ────────────────────────────────────
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

  // New project (empty).
  const np = drillItem("New project (empty)", "Git-init'd in the cloud — no GitHub needed", isNew ? CHECK : "");
  np.addEventListener("click", () => pick({ kind: "cloud-new" }));
  menu.appendChild(np);

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
    machines.forEach((m, i) => {
      const name = m.name || m.app || "Glyphh desktop";
      const selected = isLocal && (s.machineId === m.id || s.machineId === undefined);
      const primary = isLocal && s.path && selected ? lastSeg(s.path) : name;
      const sub = isLocal && s.path && selected ? s.path : `A folder on ${name} · ${(m.capabilities?.length || 0)} capabilities`;
      const row = drillItem(primary, sub, CHEV);
      row.classList.add("ws-drill");
      if (selected) row.classList.add("selected");
      row.addEventListener("click", () => onView("local", m));
      machinesHost.appendChild(row);
      void i;
    });
  });
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

// ── Cloud → GitHub repo picker ───────────────────────────────────────────
function renderRepos(
  menu: HTMLElement,
  opts: { getSource: () => Source },
  pick: (s: Source) => void,
  onBack: () => void,
): void {
  backHead(menu, "GitHub repo", onBack);
  const body = document.createElement("div");
  menu.appendChild(body);
  body.insertAdjacentHTML("beforeend", `<div class="drop-empty">Loading…</div>`);

  const s = sdk();
  if (!s?.git?.status) {
    body.textContent = "";
    body.insertAdjacentHTML("beforeend",
      `<div class="ws-note"><div class="ws-note-title">GitHub repos need the web app</div><div class="ws-note-body">Connecting a GitHub repository runs against the cloud runtime — open Glyphh on the web to pick a repo, or use a local folder here.</div></div>`);
    return;
  }

  const current = opts.getSource().kind === "cloud-repo" ? (opts.getSource() as { repo: string }).repo : "";
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const paintRepos = (repos: Repo[]): void => {
    body.textContent = "";
    const list = document.createElement("div");
    list.className = "code-repo-drop-list";
    let search: HTMLInputElement | null = null;
    if (repos.length > 8) {
      search = document.createElement("input");
      search.type = "text";
      search.className = "loop-drop-search";
      search.placeholder = "Search repositories…";
      search.spellcheck = false;
      search.autocomplete = "off";
      search.addEventListener("mousedown", (ev) => ev.stopPropagation());
      body.appendChild(search);
    }
    body.appendChild(list);
    const draw = (): void => {
      list.textContent = "";
      const q = (search?.value || "").trim().toLowerCase();
      const shown = q ? repos.filter((r) => r.fullName.toLowerCase().includes(q)) : repos;
      if (!shown.length) {
        list.insertAdjacentHTML("beforeend", `<div class="drop-empty">${repos.length ? "No repositories match." : "No repositories found."}</div>`);
        return;
      }
      for (const r of shown) {
        const it = drillItem(r.fullName, `${r.private ? "private" : "public"} · ${r.defaultBranch}`, r.fullName === current ? CHECK : "");
        if (r.fullName === current) it.classList.add("selected");
        it.addEventListener("click", () => pick({ kind: "cloud-repo", repo: r.fullName }));
        list.appendChild(it);
      }
    };
    search?.addEventListener("input", draw);
    draw();
    if (search) requestAnimationFrame(() => search!.focus());
  };

  const load = async (): Promise<boolean> => {
    try {
      const st = await s.git!.status!();
      if (!st?.connected) return false;
      const repos = s.git!.repos ? await s.git!.repos() : [];
      paintRepos(Array.isArray(repos) ? repos : []);
      return true;
    } catch { return false; }
  };

  const connectRow = (): void => {
    body.textContent = "";
    const row = drillItem("Connect GitHub…", "Link your account to clone a repository", "");
    row.addEventListener("click", () => {
      if (!s.git?.connect) return;
      void s.git.connect().then((link) => {
        if (!link?.url) return;
        window.open(link.url, "glyphh-git-oauth", "width=600,height=760");
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(() => {
          void load().then((ok) => { if (ok && pollTimer) { clearInterval(pollTimer); pollTimer = null; } });
        }, 2500);
        setTimeout(() => { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }, 180000);
      });
    });
    body.appendChild(row);
  };

  void load().then((connected) => { if (!connected) connectRow(); });
}

// ── Local → attached-machine folder browser ──────────────────────────────
function renderLocal(
  menu: HTMLElement,
  opts: { getSource: () => Source },
  machine: AttachedMachine | null,
  pick: (s: Source) => void,
  onBack: () => void,
): void {
  backHead(menu, "Local folder", onBack);
  const body = document.createElement("div");
  menu.appendChild(body);
  body.insertAdjacentHTML("beforeend", `<div class="drop-empty">Checking your desktop…</div>`);

  const s = sdk();
  const startPath = opts.getSource().kind === "local" ? (opts.getSource() as { path: string }).path : undefined;
  let root: string | null = null;

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
    if (!root) root = listing.root || listing.path;
    if (listing.parent && root && listing.path !== root && listing.parent.length >= root.length) {
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
function drillItem(main: string, hint: string, trailingSvg: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "code-drop-item";
  b.innerHTML = `<span class="drop-lines"><span class="ws-main"></span>${hint ? `<span class="drop-hint"></span>` : ""}</span>${trailingSvg}`;
  (b.querySelector(".ws-main") as HTMLElement).textContent = main;
  if (hint) (b.querySelector(".drop-hint") as HTMLElement).textContent = hint;
  return b;
}

function backHead(menu: HTMLElement, title: string, onBack: () => void): void {
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
