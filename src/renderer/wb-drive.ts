/**
 * wb-drive.ts — GLYPHH DRIVE, the workbench panel.
 *
 * The index over every Office file: folders on the left, file cards on the
 * right, search across everything. Entries are POINTERS — opening one routes
 * to its own panel (Slides reader / Docs paper); moving one repoints its
 * folder_id; nothing here copies bytes. Folder ops are safe by construction:
 * deleting a folder re-parents its contents.
 */

export interface DriveFolder { id: string; name: string; parentId: string | null }
export interface DriveEntry {
  kind: "slides" | "docs";
  file: string;
  title: string;
  sizeBytes: number;
  folderId: string | null;
  updatedAt: string;
}

export interface GDriveSlotState {
  id: number;
  /** Selected folder (null/undefined = root view). */
  folderId?: string | null;
}

export interface GDriveHost {
  confirm: (opts: { title: string; body?: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>;
  /** Route an entry to its own panel (Slides / Docs). */
  openFile: (kind: "slides" | "docs", file: string, title: string) => void;
  icons: { slides: string; docs: string; folder: string };
}

const driveApi = () => (window as unknown as { glyphh?: {
  gdriveList?: (q?: string) => Promise<{ ok: boolean; folders: DriveFolder[]; files: DriveEntry[]; error?: string }>;
  gdriveMkdir?: (name: string, parentId?: string | null) => Promise<{ ok: boolean; error?: string }>;
  gdriveMove?: (kind: "slides" | "docs", file: string, folderId: string | null) => Promise<{ ok: boolean; error?: string }>;
  gdriveFolderRename?: (id: string, name: string) => Promise<{ ok: boolean; error?: string }>;
  gdriveFolderDelete?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  gpointDelete?: (file: string) => Promise<{ ok: boolean; error?: string }>;
  gdocDelete?: (file: string) => Promise<{ ok: boolean; error?: string }>;
} }).glyphh ?? {};

interface PopItem { label: string; danger?: boolean; fn: () => void }
function popMenu(x: number, y: number, items: PopItem[]): void {
  document.querySelectorAll(".gdrive-menu").forEach((el) => el.remove());
  const menu = document.createElement("div");
  menu.className = "ws-popover gdrive-menu";
  for (const it of items) {
    const b = document.createElement("button");
    b.className = "ws-popover-item" + (it.danger ? " danger" : "");
    b.textContent = it.label;
    b.addEventListener("click", () => { close(); it.fn(); });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  menu.style.top = `${Math.min(y, window.innerHeight - menu.offsetHeight - 8)}px`;
  menu.style.left = `${Math.min(x, window.innerWidth - menu.offsetWidth - 8)}px`;
  const onDoc = (ev: MouseEvent): void => { if (!menu.contains(ev.target as Node)) close(); };
  const close = (): void => { menu.remove(); document.removeEventListener("mousedown", onDoc, true); };
  document.addEventListener("mousedown", onDoc, true);
}

const fmtSize = (n: number): string => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

export interface GDrivePanel {
  renderIntoSlot: (body: HTMLElement, slot: GDriveSlotState, wrap: HTMLElement) => Promise<void>;
}

export function initGDrive(host: GDriveHost): GDrivePanel {

  async function renderIntoSlot(body: HTMLElement, slot: GDriveSlotState, wrap: HTMLElement): Promise<void> {
    try {
      await renderInner(body, slot, wrap);
    } catch (err) {
      console.warn("[gdrive] render failed:", err);
      if (body.isConnected) {
        body.innerHTML = `<div class="gdoc-empty">Drive hit an error rendering.<br><code class="gpoint-err"></code></div>`;
        const code = body.querySelector(".gpoint-err");
        if (code) code.textContent = err instanceof Error ? err.message : String(err);
      }
    }
  }

  async function renderInner(body: HTMLElement, slot: GDriveSlotState, _wrap: HTMLElement): Promise<void> {
    body.classList.add("ws-gdrive-body");
    const refresh = (): void => { if (body.isConnected) void renderIntoSlot(body, slot, _wrap); };

    body.innerHTML = `
      <div class="gdrive">
        <div class="gdrive-head">
          <span class="gdrive-title">Drive</span>
          <input class="gdrive-search" type="text" placeholder="Search Drive…" spellcheck="false" autocomplete="off" />
          <button class="action-btn primary gdrive-newfolder">＋ Folder</button>
          <button class="ws-icon-btn gdrive-refresh" title="Refresh">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.3"/><polyline points="21 3 21 9 15 9"/></svg>
          </button>
        </div>
        <div class="gdrive-main">
          <div class="gdrive-folders"></div>
          <div class="gdrive-files"></div>
        </div>
        <div class="gdoc-empty gdrive-empty hidden"></div>
      </div>`;
    body.querySelector(".gdrive-refresh")?.addEventListener("click", refresh);

    const api = driveApi();
    if (!api.gdriveList) {
      const empty = body.querySelector<HTMLElement>(".gdrive-empty")!;
      empty.textContent = "This surface has no Drive bridge.";
      empty.classList.remove("hidden");
      return;
    }

    const search = body.querySelector<HTMLInputElement>(".gdrive-search")!;
    let query = "";
    let debounce = 0;
    search.addEventListener("input", () => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => { query = search.value.trim(); void paint(); }, 220);
    });
    search.addEventListener("keydown", (e) => e.stopPropagation());

    body.querySelector(".gdrive-newfolder")?.addEventListener("click", () => {
      // Inline name editor at the top of the folder rail — no native prompt.
      const rail = body.querySelector<HTMLElement>(".gdrive-folders")!;
      if (rail.querySelector(".gdrive-newfolder-input")) return;
      const input = document.createElement("input");
      input.className = "gdrive-newfolder-input";
      input.placeholder = "Folder name…";
      input.spellcheck = false;
      rail.prepend(input);
      input.focus();
      const done = (commit: boolean): void => {
        const name = input.value.trim();
        input.remove();
        if (!commit || !name) return;
        void (async () => {
          const res = await api.gdriveMkdir?.(name, slot.folderId ?? null);
          if (res && !res.ok) { void host.confirm({ title: "Couldn't create the folder", body: res.error || "Unknown error.", confirmLabel: "OK" }); return; }
          refresh();
        })();
      };
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") done(true);
        else if (e.key === "Escape") done(false);
      });
      input.addEventListener("blur", () => done(true));
    });

    const foldersEl = body.querySelector<HTMLElement>(".gdrive-folders")!;
    const filesEl = body.querySelector<HTMLElement>(".gdrive-files")!;

    async function paint(): Promise<void> {
      const res = await api.gdriveList?.(query || undefined);
      if (!body.isConnected || !res) return;
      if (!res.ok) {
        const empty = body.querySelector<HTMLElement>(".gdrive-empty")!;
        empty.textContent = `Couldn't load Drive: ${res.error ?? "unknown error"}`;
        empty.classList.remove("hidden");
        return;
      }
      body.querySelector(".gdrive-empty")?.classList.add("hidden");
      const { folders, files } = res;

      // ── Folder rail: Everything, then the tree (indent by depth). ──
      foldersEl.textContent = "";
      const depthOf = (f: DriveFolder): number => {
        let d = 0;
        let cur = f.parentId;
        for (let hops = 0; cur && hops < 50; hops++) { d++; cur = folders.find((x) => x.id === cur)?.parentId ?? null; }
        return d;
      };
      const ordered: DriveFolder[] = [];
      const addChildren = (parentId: string | null): void => {
        for (const f of folders.filter((x) => x.parentId === parentId).sort((a, b) => a.name.localeCompare(b.name))) {
          ordered.push(f);
          addChildren(f.id);
        }
      };
      addChildren(null);
      const mkFolderRow = (id: string | null, name: string, depth: number): HTMLElement => {
        const row = document.createElement("button");
        row.className = "gdrive-folder" + ((slot.folderId ?? null) === id && !query ? " active" : "");
        row.style.paddingLeft = `${10 + depth * 14}px`;
        row.innerHTML = `<span class="gdrive-folder-ic">${id === null ? host.icons.folder : host.icons.folder}</span><span class="gdrive-folder-name"></span>`;
        (row.querySelector(".gdrive-folder-name") as HTMLElement).textContent = name;
        row.addEventListener("click", () => {
          slot.folderId = id;
          query = ""; search.value = "";
          void paint();
        });
        if (id !== null) {
          row.addEventListener("contextmenu", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            popMenu(ev.clientX, ev.clientY, [
              { label: "Rename…", fn: () => {
                const input = document.createElement("input");
                input.className = "gdrive-newfolder-input";
                input.value = name;
                row.replaceWith(input);
                input.focus(); input.select();
                const done = (commit: boolean): void => {
                  const next = input.value.trim();
                  void (async () => {
                    if (commit && next && next !== name) await api.gdriveFolderRename?.(id, next);
                    refresh();
                  })();
                };
                input.addEventListener("keydown", (e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") done(true);
                  else if (e.key === "Escape") done(false);
                });
                input.addEventListener("blur", () => done(true));
              } },
              { label: "Delete folder…", danger: true, fn: () => void (async () => {
                const ok = await host.confirm({ title: `Delete “${name}”?`, body: "Files and subfolders inside move up a level — nothing is lost.", confirmLabel: "Delete", danger: true });
                if (!ok) return;
                await api.gdriveFolderDelete?.(id);
                if (slot.folderId === id) slot.folderId = null;
                refresh();
              })() },
            ]);
          });
        }
        return row;
      };
      foldersEl.appendChild(mkFolderRow(null, "Everything", 0));
      for (const f of ordered) foldersEl.appendChild(mkFolderRow(f.id, f.name, depthOf(f)));

      // ── File cards: the selected folder's files (or every match on search). ──
      filesEl.textContent = "";
      const inView = query ? files : files.filter((f) => (f.folderId ?? null) === (slot.folderId ?? null));
      if (!inView.length) {
        const none = document.createElement("div");
        none.className = "gdoc-empty";
        none.textContent = query ? "No matches." : "Nothing here yet — the agent's decks and documents land in Drive automatically.";
        filesEl.appendChild(none);
      }
      for (const f of inView) {
        const card = document.createElement("div");
        card.className = "gdrive-card";
        card.innerHTML = `
          <span class="gdrive-card-ic">${f.kind === "slides" ? host.icons.slides : host.icons.docs}</span>
          <span class="gdrive-card-title"></span>
          <span class="gdrive-card-meta">${f.kind === "slides" ? "Slides" : "Docs"} · ${fmtSize(f.sizeBytes)}</span>
          <button class="ws-icon-btn gdrive-card-kebab" title="Options">
            <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="12" cy="19" r="1.9"/></svg>
          </button>`;
        (card.querySelector(".gdrive-card-title") as HTMLElement).textContent = f.title || f.file;
        card.addEventListener("click", (ev) => {
          if ((ev.target as HTMLElement).closest(".gdrive-card-kebab")) return;
          host.openFile(f.kind, f.file, f.title || f.file);
        });
        card.querySelector(".gdrive-card-kebab")?.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
          popMenu(r.right - 170, r.bottom + 4, [
            { label: "Open", fn: () => host.openFile(f.kind, f.file, f.title || f.file) },
            { label: "Move to root", fn: () => void (async () => { await api.gdriveMove?.(f.kind, f.file, null); void paint(); })() },
            ...folders.map((fo) => ({
              label: `Move to ${fo.name}`,
              fn: () => void (async () => { await api.gdriveMove?.(f.kind, f.file, fo.id); void paint(); })(),
            })),
            { label: "Delete…", danger: true, fn: () => void (async () => {
              const ok = await host.confirm({ title: `Delete “${f.title || f.file}”?`, body: "Removed for the whole org. This can't be undone.", confirmLabel: "Delete", danger: true });
              if (!ok) return;
              if (f.kind === "slides") await driveApi().gpointDelete?.(f.file);
              else await driveApi().gdocDelete?.(f.file);
              void paint();
            })() },
          ]);
        });
        filesEl.appendChild(card);
      }
    }

    await paint();
  }

  return { renderIntoSlot };
}
