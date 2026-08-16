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
import { formatMarkdown } from "./format-markdown.js";

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

/** Doc markdown for the mini paper thumbs (small cache, first 1.5KB is plenty). */
const docThumbCache = new Map<string, string>();
async function docThumbMd(file: string): Promise<string | null> {
  const hit = docThumbCache.get(file);
  if (hit !== undefined) return hit;
  const res = await (window as unknown as { glyphh?: { gdocRead?: (f: string) => Promise<{ ok: boolean; markdown?: string }> } }).glyphh?.gdocRead?.(file);
  if (!res?.ok || typeof res.markdown !== "string") return null;
  const head = res.markdown.slice(0, 1500);
  docThumbCache.set(file, head);
  return head;
}

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
        <div class="office-toolbar">
          <input class="office-search" type="text" placeholder="Search Drive…" spellcheck="false" autocomplete="off" />
          <button class="action-btn primary office-new">＋ Folder</button>
          <button class="ws-icon-btn office-refresh" title="Refresh">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.3"/><polyline points="21 3 21 9 15 9"/></svg>
          </button>
        </div>
        <div class="gdrive-crumbs hidden"></div>
        <div class="gdrive-scroll">
          <div class="gdrive-section gdrive-recents-wrap hidden">
            <div class="gdrive-section-title">Recents</div>
            <div class="gdrive-recents"></div>
          </div>
          <div class="gdrive-section gdrive-folders-wrap hidden">
            <div class="gdrive-section-title">Folders</div>
            <div class="gdrive-folder-grid"></div>
          </div>
          <div class="gdrive-section">
            <div class="gdrive-section-title gdrive-files-title">Files</div>
            <div class="gdrive-files"></div>
          </div>
        </div>
        <div class="gdoc-empty gdrive-empty hidden"></div>
      </div>`;
    body.querySelector(".office-refresh")?.addEventListener("click", refresh);

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
      debounce = window.setTimeout(() => { query = search.value.trim(); void paint(); }, 220);
    });

    // ＋ Folder — inline name editor at the top of the folder grid.
    body.querySelector(".office-new")?.addEventListener("click", () => {
      const gridEl = body.querySelector<HTMLElement>(".gdrive-folder-grid")!;
      body.querySelector(".gdrive-folders-wrap")?.classList.remove("hidden");
      if (gridEl.querySelector(".gdrive-newfolder-input")) return;
      const input = document.createElement("input");
      input.className = "gdrive-newfolder-input";
      input.placeholder = "Folder name…";
      input.spellcheck = false;
      gridEl.prepend(input);
      input.focus();
      const done = (commit: boolean): void => {
        const name = input.value.trim();
        input.remove();
        if (!commit || !name) { void paint(); return; }
        void (async () => {
          const res = await api.gdriveMkdir?.(name, slot.folderId ?? null);
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
    });

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

      // ── Breadcrumbs — Drive › folder › subfolder (click walks up). ──
      const crumbs = body.querySelector<HTMLElement>(".gdrive-crumbs")!;
      crumbs.textContent = "";
      if (here && !query) {
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
          if (!last) b.addEventListener("click", () => { slot.folderId = id; void paint(); });
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

      const fileCard = (f: DriveEntry, compact: boolean): HTMLElement => {
        const card = document.createElement("div");
        card.className = compact ? "gdrive-card gdrive-card-compact" : "gdrive-card";
        card.innerHTML = `
          <div class="gpoint-thumb gdrive-thumb"><div class="gpoint-thumb-ph">${f.kind === "slides" ? host.icons.slides : host.icons.docs}</div></div>
          <div class="gdrive-card-row">
            <span class="gdrive-card-ic">${f.kind === "slides" ? host.icons.slides : host.icons.docs}</span>
            <span class="gdrive-card-title"></span>
            <button class="ws-icon-btn gdrive-card-kebab" title="Options">
              <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="12" cy="19" r="1.9"/></svg>
            </button>
          </div>
          <span class="gdrive-card-meta">${f.kind === "slides" ? "Slides" : "Docs"} · ${fmtSize(f.sizeBytes)}</span>`;
        (card.querySelector(".gdrive-card-title") as HTMLElement).textContent = f.title || f.file;
        // The SAME previews the libraries show: decks render slide 1 in a
        // srcdoc thumb; docs render a mini sheet of the markdown's head.
        const thumb = card.querySelector<HTMLElement>(".gdrive-thumb")!;
        if (f.kind === "slides") {
          void deckHtml(f.file).then((html) => {
            if (html && thumb.isConnected) fillThumbs([{ host: thumb, doc: staticDoc(html, 0) }]);
          });
        } else {
          void docThumbMd(f.file).then((md) => {
            if (md === null || !thumb.isConnected) return;
            const sheet = document.createElement("div");
            sheet.className = "gdrive-docthumb";
            const inner = document.createElement("div");
            inner.className = "gdrive-docthumb-inner";
            inner.innerHTML = formatMarkdown(md);
            sheet.appendChild(inner);
            thumb.appendChild(sheet);
          });
        }
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
        return card;
      };

      // ── Recents — a row across the top (root view only, like Drive). ──
      const recentsWrap = body.querySelector<HTMLElement>(".gdrive-recents-wrap")!;
      const recentsEl = body.querySelector<HTMLElement>(".gdrive-recents")!;
      recentsEl.textContent = "";
      if (!query && !here && files.length) {
        for (const f of [...files].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8)) {
          recentsEl.appendChild(fileCard(f, true));
        }
        recentsWrap.classList.remove("hidden");
      } else {
        recentsWrap.classList.add("hidden");
      }

      // ── Folders — cards (children of the current folder). ──
      const foldersWrap = body.querySelector<HTMLElement>(".gdrive-folders-wrap")!;
      const folderGrid = body.querySelector<HTMLElement>(".gdrive-folder-grid")!;
      folderGrid.textContent = "";
      const children = query ? [] : folders.filter((f) => (f.parentId ?? null) === here).sort((a, b) => a.name.localeCompare(b.name));
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
          void paint();
        });
        card.querySelector(".gdrive-card-kebab")?.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
          popMenu(r.right - 170, r.bottom + 4, [
            { label: "Open", fn: () => { slot.folderId = f.id; void paint(); } },
            { label: "Rename…", fn: () => {
              const input = document.createElement("input");
              input.className = "gdrive-newfolder-input";
              input.value = f.name;
              card.replaceWith(input);
              input.focus(); input.select();
              const done = (commit: boolean): void => {
                const next = input.value.trim();
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
          ]);
        });
        folderGrid.appendChild(card);
      }
      foldersWrap.classList.toggle("hidden", children.length === 0);

      // ── Files — the current folder's (or every match on search). ──
      const filesEl = body.querySelector<HTMLElement>(".gdrive-files")!;
      const filesTitle = body.querySelector<HTMLElement>(".gdrive-files-title")!;
      filesTitle.textContent = query ? `Results for “${query}”` : "Files";
      filesEl.textContent = "";
      const inView = query ? files : files.filter((f) => (f.folderId ?? null) === here);
      if (!inView.length) {
        const none = document.createElement("div");
        none.className = "gdoc-empty";
        none.textContent = query ? "No matches." : "Nothing here yet — the agent's decks and documents land in Drive automatically.";
        filesEl.appendChild(none);
      }
      for (const f of inView) filesEl.appendChild(fileCard(f, false));
    }

    await paint();
  }

  return { renderIntoSlot };
}
