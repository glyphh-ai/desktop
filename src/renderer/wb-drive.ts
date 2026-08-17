/**
 * wb-drive.ts — GLYPHH DRIVE, the workbench panel.
 *
 * The index over every Office file: folders on the left, file cards on the
 * right, search across everything. Entries are POINTERS — opening one routes
 * to its own panel (Slides reader / Docs paper); moving one repoints its
 * folder_id; nothing here copies bytes. Folder ops are safe by construction:
 * deleting a folder re-parents its contents.
 */

import { deckHtml, staticDoc, fillThumbs } from "./wb-gpoint.js";
import { officePager, officePage, mountDocThumb } from "./wb-office-ui.js";
import { mountSheetThumb } from "./wb-sheets.js";

export interface DriveFolder { id: string; name: string; parentId: string | null }
export interface DriveEntry {
  kind: "slides" | "docs" | "sheets";
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
  /** The folder rail — open by default, collapsible from the toolbar. */
  railOpen?: boolean;
  /** "browse" (folders + recents) or "list" (every file, newest first). */
  viewMode?: "browse" | "list";
  /** Files-grid page (browse) and list page. */
  page?: number;
  listPage?: number;
}

export interface GDriveHost {
  confirm: (opts: { title: string; body?: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>;
  /** Route an entry to its own panel (Slides / Docs). */
  openFile: (kind: "slides" | "docs" | "sheets", file: string, title: string) => void;
  icons: { slides: string; docs: string; sheets: string; folder: string };
}

const driveApi = () => (window as unknown as { glyphh?: {
  gdriveList?: (q?: string) => Promise<{ ok: boolean; folders: DriveFolder[]; files: DriveEntry[]; error?: string }>;
  gdriveMkdir?: (name: string, parentId?: string | null) => Promise<{ ok: boolean; error?: string }>;
  gpointNew?: (name: string, title?: string) => Promise<{ ok: boolean; file?: string; title?: string; error?: string }>;
  gdocWrite?: (file: string, markdown: string, folderId?: string | null) => Promise<{ ok: boolean; file?: string; title?: string; error?: string }>;
  gsheetWrite?: (file: string, title: string, workbook: unknown) => Promise<{ ok: boolean; file?: string; title?: string; error?: string }>;
  gdriveMove?: (kind: "slides" | "docs" | "sheets", file: string, folderId: string | null) => Promise<{ ok: boolean; error?: string }>;
  gsheetDelete?: (file: string) => Promise<{ ok: boolean; error?: string }>;
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
    const railOpen = slot.railOpen !== false;

    body.innerHTML = `
      <div class="gdrive">
        <div class="office-toolbar">
          <button class="ws-icon-btn gdrive-rail-toggle${railOpen ? " active" : ""}" title="${railOpen ? "Hide" : "Show"} the folder rail">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/></svg>
          </button>
          <input class="office-search" type="text" placeholder="Search Drive…" spellcheck="false" autocomplete="off" />
          <button class="ws-icon-btn office-refresh" title="Refresh">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.3"/><polyline points="21 3 21 9 15 9"/></svg>
          </button>
        </div>
        <div class="gdrive-crumbs hidden"></div>
        <div class="gdrive-body">
          <div class="gdrive-rail${railOpen ? "" : " hidden"}"></div>
          <div class="gdrive-scroll"></div>
        </div>
        <div class="gdoc-empty gdrive-empty hidden"></div>
      </div>`;
    body.querySelector(".office-refresh")?.addEventListener("click", refresh);
    body.querySelector(".gdrive-rail-toggle")?.addEventListener("click", () => {
      slot.railOpen = !(slot.railOpen !== false);
      refresh();
    });

    const api = driveApi();
    if (!api.gdriveList) {
      const empty = body.querySelector<HTMLElement>(".gdrive-empty")!;
      empty.textContent = "This surface has no Drive bridge.";
      empty.classList.remove("hidden");
      return;
    }

    const search = body.querySelector<HTMLInputElement>(".office-search")!;
    let query = "";
    let debounce = 0;
    search.addEventListener("keydown", (e) => e.stopPropagation());
    search.addEventListener("input", () => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => { query = search.value.trim(); slot.page = 0; void paint(); }, 220);
    });

    const GRID_PER = 18;
    const LIST_PER = 20;

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
      const here = slot.folderId ?? null;
      const scroll = body.querySelector<HTMLElement>(".gdrive-scroll")!;
      scroll.textContent = "";

      // ── The folder RAIL (collapsible; tree by parent). ──
      const rail = body.querySelector<HTMLElement>(".gdrive-rail")!;
      rail.textContent = "";
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
      // Create INTO a folder: the rail's ＋ is a dropdown — folder or any
      // Office file, born filed where you clicked.
      const newFolderInto = (parentId: string | null): void => {
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
          if (!commit || !name) { void paint(); return; }
          void (async () => {
            const res = await api.gdriveMkdir?.(name, parentId);
            if (res && !res.ok) { void host.confirm({ title: "Couldn't create the folder", body: res.error || "Unknown error.", confirmLabel: "OK" }); return; }
            void paint();
          })();
        };
        input.addEventListener("keydown", (e) => {
          e.stopPropagation();
          if (e.key === "Enter") done(true);
          else if (e.key === "Escape") done(false);
        });
        input.addEventListener("blur", () => done(true));
      };
      const freshName = (taken: Set<string>, stem: string, ext: string): string => {
        let name = stem, n = 2;
        while (taken.has(`${name}${ext}`)) name = `${stem}-${n++}`;
        return name;
      };
      const createInto = (kind: "docs" | "sheets" | "slides", folderId: string | null): void => {
        void (async () => {
          if (kind === "docs") {
            const taken = new Set(files.filter((f) => f.kind === "docs").map((f) => f.file));
            const stem = freshName(taken, "untitled", ".md");
            const w = await api.gdocWrite?.(stem, "# Untitled\n\nStart here.", folderId);
            if (!w?.ok || !w.file) { void host.confirm({ title: "Couldn't create the document", body: w?.error || "Unknown error.", confirmLabel: "OK" }); return; }
            (window as unknown as { __wbOpenGDoc?: (f?: string, t?: string) => void }).__wbOpenGDoc?.(w.file, w.title);
          } else if (kind === "sheets") {
            const taken = new Set(files.filter((f) => f.kind === "sheets").map((f) => f.file));
            const stem = freshName(taken, "untitled", ".json");
            const blank = { sheets: [{ name: "Sheet1", columns: [{ name: "Column 1" }, { name: "Column 2" }, { name: "Column 3" }], rows: Array.from({ length: 8 }, () => [null, null, null]) }] };
            const w = await api.gsheetWrite?.(stem, "Untitled", blank);
            if (!w?.ok || !w.file) { void host.confirm({ title: "Couldn't create the workbook", body: w?.error || "Unknown error.", confirmLabel: "OK" }); return; }
            if (folderId) await api.gdriveMove?.("sheets", w.file, folderId);
            (window as unknown as { __wbOpenGSheet?: (f?: string, t?: string) => void }).__wbOpenGSheet?.(w.file, w.title);
          } else {
            const taken = new Set(files.filter((f) => f.kind === "slides").map((f) => f.file));
            const stem = freshName(taken, "untitled", ".html");
            const w = await api.gpointNew?.(stem, "Untitled");
            if (!w?.ok || !w.file) { void host.confirm({ title: "Couldn't create the deck", body: w?.error || "Unknown error.", confirmLabel: "OK" }); return; }
            if (folderId) await api.gdriveMove?.("slides", w.file, folderId);
            (window as unknown as { __wbOpenGPoint?: (f?: string, t?: string) => void }).__wbOpenGPoint?.(w.file, w.title);
          }
          void paint();
        })();
      };
      const plusMenu = (x: number, y: number, folderId: string | null): void => {
        popMenu(x, y, [
          { label: "New folder", fn: () => newFolderInto(folderId) },
          { label: "New Doc", fn: () => createInto("docs", folderId) },
          { label: "New Sheet", fn: () => createInto("sheets", folderId) },
          { label: "New Slides", fn: () => createInto("slides", folderId) },
        ]);
      };

      const railRow = (id: string | null, name: string, depth: number): HTMLElement => {
        const row = document.createElement("button");
        row.className = "gdrive-railrow" + (here === id && !query && slot.viewMode !== "list" ? " active" : "");
        row.style.paddingLeft = `${10 + depth * 14}px`;
        row.innerHTML = `<span class="gdrive-railrow-ic">${host.icons.folder}</span><span class="gdrive-railrow-name"></span><span class="gdrive-railrow-plus" title="New in ${name.replace(/"/g, "&quot;")}…">＋</span>`;
        (row.querySelector(".gdrive-railrow-name") as HTMLElement).textContent = name;
        row.querySelector(".gdrive-railrow-plus")?.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
          plusMenu(r.left, r.bottom + 4, id);
        });
        row.addEventListener("click", () => {
          slot.folderId = id;
          slot.viewMode = "browse";
          slot.page = 0;
          query = ""; search.value = "";
          void paint();
        });
        if (id !== null) {
          row.addEventListener("contextmenu", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const f = folders.find((x) => x.id === id)!;
            popMenu(ev.clientX, ev.clientY, folderMenuItems(f));
          });
        }
        return row;
      };
      rail.appendChild(railRow(null, "My Drive", 0));
      for (const f of ordered) rail.appendChild(railRow(f.id, f.name, depthOf(f)));

      const folderMenuItems = (f: DriveFolder): Array<{ label: string; danger?: boolean; fn: () => void }> => [
        { label: "Open", fn: () => { slot.folderId = f.id; slot.viewMode = "browse"; slot.page = 0; void paint(); } },
        { label: "Rename…", fn: () => {
          const input = document.createElement("input");
          input.className = "gdrive-newfolder-input";
          input.value = f.name;
          rail.prepend(input);
          input.focus(); input.select();
          const done = (commit: boolean): void => {
            const next = input.value.trim();
            input.remove();
            void (async () => {
              if (commit && next && next !== f.name) await api.gdriveFolderRename?.(f.id, next);
              void paint();
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
          const ok = await host.confirm({ title: `Delete “${f.name}”?`, body: "Files and subfolders inside move up a level — nothing is lost.", confirmLabel: "Delete", danger: true });
          if (!ok) return;
          await api.gdriveFolderDelete?.(f.id);
          if (slot.folderId === f.id) slot.folderId = f.parentId ?? null;
          void paint();
        })() },
      ];

      const fileCard = (f: DriveEntry): HTMLElement => {
        const card = document.createElement("div");
        card.className = "gdrive-card";
        card.innerHTML = `
          <div class="gpoint-thumb gdrive-thumb"><div class="gpoint-thumb-ph">${f.kind === "slides" ? host.icons.slides : f.kind === "sheets" ? host.icons.sheets : host.icons.docs}</div></div>
          <div class="gdrive-card-row">
            <span class="gdrive-card-title"></span>
            <button class="ws-icon-btn gdrive-card-kebab" title="Options">
              <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="12" cy="19" r="1.9"/></svg>
            </button>
          </div>
          <span class="gdrive-card-meta">${f.kind === "slides" ? "Slides" : f.kind === "sheets" ? "Sheets" : "Docs"} · ${fmtSize(f.sizeBytes)}</span>`;
        (card.querySelector(".gdrive-card-title") as HTMLElement).textContent = f.title || f.file;
        card.addEventListener("click", (ev) => {
          if ((ev.target as HTMLElement).closest(".gdrive-card-kebab")) return;
          host.openFile(f.kind, f.file, f.title || f.file);
        });
        card.querySelector(".gdrive-card-kebab")?.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
          popMenu(r.right - 170, r.bottom + 4, fileMenuItems(f));
        });
        const thumb = card.querySelector<HTMLElement>(".gdrive-thumb")!;
        if (f.kind === "slides") {
          void deckHtml(f.file).then((html) => {
            if (html && thumb.isConnected) fillThumbs([{ host: thumb, doc: staticDoc(html, 0) }]);
          });
        } else if (f.kind === "sheets") {
          mountSheetThumb(thumb, f.file);
        } else {
          mountDocThumb(thumb, f.file);
        }
        return card;
      };

      const fileMenuItems = (f: DriveEntry): Array<{ label: string; danger?: boolean; fn: () => void }> => [
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
          else if (f.kind === "sheets") await driveApi().gsheetDelete?.(f.file);
          else await driveApi().gdocDelete?.(f.file);
          void paint();
        })() },
      ];

      const fileRow = (f: DriveEntry): HTMLElement => {
        const row = document.createElement("div");
        row.className = "gdrive-listrow";
        row.innerHTML = `
          <span class="gdrive-listrow-ic">${f.kind === "slides" ? host.icons.slides : f.kind === "sheets" ? host.icons.sheets : host.icons.docs}</span>
          <span class="gdrive-listrow-title"></span>
          <span class="gdrive-listrow-kind">${f.kind === "slides" ? "Slides" : f.kind === "sheets" ? "Sheets" : "Docs"}</span>
          <span class="gdrive-listrow-size">${fmtSize(f.sizeBytes)}</span>
          <span class="gdrive-listrow-date">${new Date(f.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
          <button class="ws-icon-btn gdrive-card-kebab" title="Options">
            <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="12" cy="19" r="1.9"/></svg>
          </button>`;
        (row.querySelector(".gdrive-listrow-title") as HTMLElement).textContent = f.title || f.file;
        row.addEventListener("click", (ev) => {
          if ((ev.target as HTMLElement).closest(".gdrive-card-kebab")) return;
          host.openFile(f.kind, f.file, f.title || f.file);
        });
        row.querySelector(".gdrive-card-kebab")?.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
          popMenu(r.right - 170, r.bottom + 4, fileMenuItems(f));
        });
        return row;
      };

      const sectionHead = (title: string, linkLabel?: string, onLink?: () => void): HTMLElement => {
        const head = document.createElement("div");
        head.className = "gdrive-section-head";
        const t = document.createElement("div");
        t.className = "gdrive-section-title";
        t.textContent = title;
        head.appendChild(t);
        if (linkLabel && onLink) {
          const link = document.createElement("button");
          link.className = "gdrive-viewall";
          link.textContent = linkLabel;
          link.addEventListener("click", onLink);
          head.appendChild(link);
        }
        return head;
      };

      // ── Breadcrumbs — Drive › folder › subfolder (browse mode only). ──
      const crumbs = body.querySelector<HTMLElement>(".gdrive-crumbs")!;
      crumbs.textContent = "";
      if (here && !query && slot.viewMode !== "list") {
        const chain: DriveFolder[] = [];
        let cur: string | null = here;
        for (let hops = 0; cur && hops < 50; hops++) {
          const f = folders.find((x) => x.id === cur);
          if (!f) break;
          chain.unshift(f);
          cur = f.parentId;
        }
        const mk = (label: string, id: string | null, last: boolean): void => {
          const b = document.createElement("button");
          b.className = "gdrive-crumb" + (last ? " current" : "");
          b.textContent = label;
          if (!last) b.addEventListener("click", () => { slot.folderId = id; slot.page = 0; void paint(); });
          crumbs.appendChild(b);
          if (!last) {
            const sep = document.createElement("span");
            sep.className = "gdrive-crumb-sep";
            sep.textContent = "›";
            crumbs.appendChild(sep);
          }
        };
        mk("Drive", null, false);
        chain.forEach((f, i) => mk(f.name, f.id, i === chain.length - 1));
        crumbs.classList.remove("hidden");
      } else {
        crumbs.classList.add("hidden");
      }

      // ── LIST view — every file, newest → oldest, paginated. ──
      if (slot.viewMode === "list" && !query) {
        const sec = document.createElement("div");
        sec.className = "gdrive-section";
        sec.appendChild(sectionHead("All files — newest first", "‹ Back", () => {
          slot.viewMode = "browse";
          void paint();
        }));
        const listEl = document.createElement("div");
        listEl.className = "gdrive-list";
        const sorted = [...files].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const paged = officePage(sorted, slot.listPage ?? 0, LIST_PER);
        slot.listPage = paged.page;
        for (const f of paged.items) listEl.appendChild(fileRow(f));
        sec.appendChild(listEl);
        const pager = officePager(sorted.length, paged.page, LIST_PER, (pg) => { slot.listPage = pg; void paint(); });
        if (pager) sec.appendChild(pager);
        scroll.appendChild(sec);
        return;
      }

      // ── BROWSE — Recents (top 5, root only), Folders, Files. ──
      if (!query && !here && files.length) {
        const sec = document.createElement("div");
        sec.className = "gdrive-section";
        sec.appendChild(sectionHead("Recents", "View all", () => {
          slot.viewMode = "list";
          slot.listPage = 0;
          void paint();
        }));
        const strip = document.createElement("div");
        strip.className = "gdrive-recents";
        for (const f of [...files].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5)) {
          strip.appendChild(fileCard(f));
        }
        sec.appendChild(strip);
        scroll.appendChild(sec);
      }

      const children = query ? [] : folders.filter((f) => (f.parentId ?? null) === here).sort((a, b) => a.name.localeCompare(b.name));
      if (children.length) {
        const sec = document.createElement("div");
        sec.className = "gdrive-section";
        sec.appendChild(sectionHead("Folders"));
        const grid = document.createElement("div");
        grid.className = "gdrive-folder-grid";
        for (const f of children) {
          const card = document.createElement("div");
          card.className = "gdrive-foldercard";
          card.innerHTML = `<span class="gdrive-foldercard-ic">${host.icons.folder}</span><span class="gdrive-foldercard-name"></span>
            <button class="ws-icon-btn gdrive-card-kebab" title="Options">
              <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="12" cy="19" r="1.9"/></svg>
            </button>`;
          (card.querySelector(".gdrive-foldercard-name") as HTMLElement).textContent = f.name;
          card.addEventListener("click", (ev) => {
            if ((ev.target as HTMLElement).closest(".gdrive-card-kebab")) return;
            slot.folderId = f.id;
            slot.page = 0;
            void paint();
          });
          card.querySelector(".gdrive-card-kebab")?.addEventListener("click", (ev) => {
            ev.stopPropagation();
            const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
            popMenu(r.right - 170, r.bottom + 4, folderMenuItems(f));
          });
          grid.appendChild(card);
        }
        sec.appendChild(grid);
        scroll.appendChild(sec);
      }

      const sec = document.createElement("div");
      sec.className = "gdrive-section";
      sec.appendChild(sectionHead(query ? `Results for “${query}”` : "Files", query ? undefined : "All files", query ? undefined : () => {
        slot.viewMode = "list";
        slot.listPage = 0;
        void paint();
      }));
      const filesEl = document.createElement("div");
      filesEl.className = "gdrive-files";
      const inView = query ? files : files.filter((f) => (f.folderId ?? null) === here);
      const paged = officePage(inView, query ? 0 : (slot.page ?? 0), GRID_PER);
      if (!query) slot.page = paged.page;
      if (!inView.length) {
        const none = document.createElement("div");
        none.className = "gdoc-empty";
        none.textContent = query ? "No matches." : "Nothing here yet — the agent's decks and documents land in Drive automatically.";
        filesEl.appendChild(none);
      }
      for (const f of paged.items) filesEl.appendChild(fileCard(f));
      sec.appendChild(filesEl);
      const pager = officePager(inView.length, paged.page, GRID_PER, (pg) => { slot.page = pg; void paint(); });
      if (pager && !query) sec.appendChild(pager);
      scroll.appendChild(sec);
    }

    await paint();
  }

  return { renderIntoSlot };
}
