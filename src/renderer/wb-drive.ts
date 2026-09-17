/**
 * wb-drive.ts — GLYPHH DRIVE, the workbench panel (back on the surface
 * 2026-09-17 as the Drive app from the hub).
 *
 * THE UNIVERSAL SURFACE (his rule, 2026-08-19): the left rail is FOLDERS
 * ONLY; everything the apps make — slides, designs, media, file artifacts —
 * renders as a card and associates to the same folders. Entries are
 * POINTERS — clicking one opens THAT OBJECT in the app that made it; moving
 * one repoints its folder_id; nothing here copies bytes. Folder ops are safe
 * by construction: deleting a folder re-parents its contents.
 */

import { deckHtml, staticDoc, fillThumbs } from "./wb-gpoint.js";
import { officePager, officePage, biasThumbCrop } from "./wb-office-ui.js";

export interface DriveFolder { id: string; name: string; parentId: string | null }
export type DriveKind = "slides" | "design" | "media" | "file" | "docs" | "sheets" | "music";
export interface DriveEntry {
  kind: DriveKind;
  /** The stable reference: office/design = the file name; media/music/file = the uuid. */
  ref: string;
  /** Office/design keep their file name for the editors' open-by-name APIs. */
  file?: string;
  title: string;
  sizeBytes: number;
  folderId: string | null;
  /** media: image|video|audio|voice|…; file: the files.kind bucket. */
  subkind?: string;
  mime?: string;
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
  /** Route a deck to the Slides panel. */
  openFile: (kind: "slides", file: string, title: string) => void;
  icons: { slides: string; folder: string };
}

const driveApi = () => (window as unknown as { glyphh?: {
  gdriveList?: (q?: string) => Promise<{ ok: boolean; folders: DriveFolder[]; files: DriveEntry[]; error?: string }>;
  gdriveMkdir?: (name: string, parentId?: string | null) => Promise<{ ok: boolean; error?: string }>;
  gpointNew?: (name: string, title?: string) => Promise<{ ok: boolean; file?: string; title?: string; error?: string }>;
  gdriveMove?: (kind: string, ref: string, folderId: string | null) => Promise<{ ok: boolean; error?: string }>;
  filesGet?: (id: string) => Promise<{ id: string; name: string; downloadUrl?: string } | null>;
  filesDelete?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  gdriveFolderRename?: (id: string, name: string) => Promise<{ ok: boolean; error?: string }>;
  gdriveFolderDelete?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  gpointDelete?: (file: string) => Promise<{ ok: boolean; error?: string }>;
  designDelete?: (file: string) => Promise<{ ok: boolean; error?: string }>;
  musicSongDelete?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  mediaList?: (kind?: string, q?: string) => Promise<{ ok: boolean; assets: unknown[]; error?: string }>;
  mediaUrl?: (id: string) => Promise<{ ok: boolean; url?: string; error?: string }>;
  musicSongs?: () => Promise<{ ok: boolean; songs: unknown[]; error?: string }>;
  musicArtists?: () => Promise<{ ok: boolean; artists: unknown[]; error?: string }>;
  musicInstruments?: () => Promise<{ ok: boolean; instruments: unknown[]; error?: string }>;
} }).glyphh ?? {};

// ── per-kind card icons (media/music/file kinds reuse the app glyphs) ──

const KIND_ICONS: Record<string, string> = {
  image: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
  video: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>`,
  audio: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
  band: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 3v10a3 3 0 1 1-2-2.83V6l-8 1.6V15a3 3 0 1 1-2-2.83V5z"/></svg>`,
  design: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r="2.5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.4-.3-.4-.5-.9-.5-1.4 0-1.1.9-2 2-2h2.4c3.1 0 5.6-2.5 5.6-5.6C23 5.5 18.1 2 12 2z"/></svg>`,
  file: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
};

const mediaIconFor = (subkind?: string): string =>
  subkind === "video" || subkind === "recording" ? KIND_ICONS.video!
    : subkind === "audio" || subkind === "voice" ? KIND_ICONS.audio!
    : KIND_ICONS.image!;

const openMediaBridge = (view: "gimage" | "gvideo" | "gsound" | "gband", assetId?: string, songId?: string): void => {
  (window as unknown as { __wbOpenMedia?: (v: string, a?: string, s?: string) => void }).__wbOpenMedia?.(view, assetId, songId);
};

const mediaViewFor = (subkind?: string): "gimage" | "gvideo" | "gsound" =>
  subkind === "video" || subkind === "recording" ? "gvideo"
    : subkind === "audio" || subkind === "voice" ? "gsound"
    : "gimage";

/** Bytes → a compact human size. */
function fmtSize(n: number): string {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** A small anchored menu — shared by folder rows, cards, and list rows. */
function popMenu(x: number, y: number, items: Array<{ label: string; danger?: boolean; fn: () => void }>): void {
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
  for (const it of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ws-tab-ctx-item" + (it.danger ? " danger" : "");
    btn.textContent = it.label;
    btn.addEventListener("click", () => { dismiss(); it.fn(); });
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(6, Math.min(x, window.innerWidth - r.width - 6))}px`;
  menu.style.top = `${Math.max(6, Math.min(y, window.innerHeight - r.height - 6))}px`;
  document.addEventListener("mousedown", onAway, true);
  document.addEventListener("keydown", onKey, true);
}

/** What a card says under its title. */
const kindLabel = (f: DriveEntry): string =>
  f.kind === "slides" ? "Slides" : f.kind === "sheets" ? "Sheets" : f.kind === "docs" ? "Docs"
    : f.kind === "design" ? "Design" : f.kind === "music" ? "Song"
    : f.kind === "media" ? (f.subkind ? f.subkind[0]!.toUpperCase() + f.subkind.slice(1) : "Media")
    : (f.mime === "application/pdf" ? "PDF" : "File");

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
        if (code) // The MESSAGE alone made every null-deref look identical (his report,
        // 2026-08-28) — the top stack frames name the actual line.
        code.textContent = err instanceof Error ? `${err.message}\n${(err.stack || "").split("\n").slice(1, 4).join("\n")}` : String(err);
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
      const createInto = (folderId: string | null): void => {
        void (async () => {
          const taken = new Set(files.filter((f) => f.kind === "slides").map((f) => f.file || f.ref));
          const stem = freshName(taken, "untitled", ".html");
          const w = await api.gpointNew?.(stem, "Untitled");
          if (!w?.ok || !w.file) { void host.confirm({ title: "Couldn't create the deck", body: w?.error || "Unknown error.", confirmLabel: "OK" }); return; }
          if (folderId) await api.gdriveMove?.("slides", w.file, folderId);
          (window as unknown as { __wbOpenGPoint?: (f?: string, t?: string) => void }).__wbOpenGPoint?.(w.file, w.title);
          void paint();
        })();
      };
      const plusMenu = (x: number, y: number, folderId: string | null): void => {
        popMenu(x, y, [
          { label: "New folder", fn: () => newFolderInto(folderId) },
          { label: "New Slides", fn: () => createInto(folderId) },
        ]);
      };

      /** Make an element a FOLDER DROP TARGET (null = My Drive root). */
      const wireFolderDrop = (elm: HTMLElement, folderId: string | null): void => {
        elm.addEventListener("dragover", (ev) => {
          if (!ev.dataTransfer?.types.includes("application/x-glyphh-drive")) return;
          ev.preventDefault();
          ev.dataTransfer.dropEffect = "move";
          elm.classList.add("gdrive-droptarget");
        });
        elm.addEventListener("dragleave", () => elm.classList.remove("gdrive-droptarget"));
        elm.addEventListener("drop", (ev) => {
          elm.classList.remove("gdrive-droptarget");
          const raw = ev.dataTransfer?.getData("application/x-glyphh-drive");
          if (!raw) return;
          ev.preventDefault();
          ev.stopPropagation();
          void (async () => {
            try {
              const { kind, ref } = JSON.parse(raw) as { kind: string; ref: string };
              await api.gdriveMove?.(kind, ref, folderId);
            } catch { /* malformed payload — ignore */ }
            void paint();
          })();
        });
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
      {
        const root = railRow(null, "My Drive", 0);
        wireFolderDrop(root, null);
        rail.appendChild(root);
      }
      for (const f of ordered) {
        const row = railRow(f.id, f.name, depthOf(f));
        wireFolderDrop(row, f.id);
        rail.appendChild(row);
      }

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

      /** Open THE OBJECT — never its container. */
      const openEntry = (f: DriveEntry): void => {
        const w = window as unknown as {
          __wbOpenDesign?: (file?: string, title?: string) => void;
          __wbOpenApp?: (app: { slug: string; name: string; url: string }) => void;
        };
        if (f.kind === "slides") host.openFile("slides", f.file || f.ref, f.title || f.ref);
        else if (f.kind === "design") w.__wbOpenDesign?.(f.file || f.ref, f.title || f.ref);
        else if (f.kind === "media") openMediaBridge(mediaViewFor(f.subkind), f.ref);
        else if (f.kind === "music") openMediaBridge("gband", undefined, f.ref);
        else {
          // A FILE artifact (R2) opens with the RIGHT tool for its type
          // (his rule, 2026-08-19): text/code → the EDITOR as a content tab;
          // pdf/html/images/video/audio → the Browser panel (inline render).
          void (async () => {
            const name = f.title || f.ref;
            const mime = f.mime || "";
            const ext = name.toLowerCase().slice(name.lastIndexOf(".") + 1);
            const TEXT_EXT = new Set(["txt", "md", "csv", "json", "js", "ts", "tsx", "jsx", "css", "scss", "py", "rb", "go", "rs", "java", "sh", "yml", "yaml", "toml", "xml", "sql", "log", "env", "ini"]);
            const textual = mime.startsWith("text/") || mime === "application/json" || TEXT_EXT.has(ext);
            const wm = window as unknown as {
              __wbOpenMonacoText?: (name: string, content: string) => void;
              __wbOpenApp?: (app: { slug: string; name: string; url: string }) => void;
            };
            if (textual && (driveApi() as { filesContent?: (id: string) => Promise<{ ok: boolean; content?: string }> }).filesContent) {
              const c = await (driveApi() as { filesContent?: (id: string) => Promise<{ ok: boolean; content?: string }> }).filesContent!(f.ref);
              if (c?.ok && typeof c.content === "string") { wm.__wbOpenMonacoText?.(name, c.content); return; }
            }
            const r = await api.filesGet?.(f.ref);
            if (r?.downloadUrl) wm.__wbOpenApp?.({ slug: `file-${f.ref.slice(0, 8)}`, name: f.title, url: r.downloadUrl });
          })();
        }
      };
      const iconFor = (f: DriveEntry): string =>
        f.kind === "slides" ? host.icons.slides
          : f.kind === "design" ? KIND_ICONS.design! : f.kind === "music" ? KIND_ICONS.band!
          : f.kind === "media" ? mediaIconFor(f.subkind) : KIND_ICONS.file!;

      const fileCard = (f: DriveEntry): HTMLElement => {
        const card = document.createElement("div");
        card.className = "gdrive-card";
        card.innerHTML = `
          <div class="gpoint-thumb gdrive-thumb"><div class="gpoint-thumb-ph">${iconFor(f)}</div></div>
          <div class="gdrive-card-row">
            <span class="gdrive-card-title"></span>
            <button class="ws-icon-btn gdrive-card-kebab" title="Options">
              <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="12" cy="19" r="1.9"/></svg>
            </button>
          </div>
          <span class="gdrive-card-meta">${kindLabel(f)}${f.sizeBytes ? ` · ${fmtSize(f.sizeBytes)}` : ""}</span>`;
        (card.querySelector(".gdrive-card-title") as HTMLElement).textContent = f.title || f.ref;
        // DRAG a card onto a folder (rail row or folder card) to file it.
        card.draggable = true;
        card.addEventListener("dragstart", (ev) => {
          ev.dataTransfer?.setData("application/x-glyphh-drive", JSON.stringify({ kind: f.kind, ref: f.ref }));
          ev.dataTransfer!.effectAllowed = "move";
          card.classList.add("gdrive-dragging");
        });
        card.addEventListener("dragend", () => card.classList.remove("gdrive-dragging"));
        card.addEventListener("click", (ev) => {
          if ((ev.target as HTMLElement).closest(".gdrive-card-kebab")) return;
          openEntry(f);
        });
        card.querySelector(".gdrive-card-kebab")?.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
          popMenu(r.right - 170, r.bottom + 4, fileMenuItems(f));
        });
        const thumb = card.querySelector<HTMLElement>(".gdrive-thumb")!;
        if (f.kind === "slides" && f.file) {
          void deckHtml(f.file).then((html) => {
            if (html && thumb.isConnected) fillThumbs([{ host: thumb, doc: staticDoc(html, 0) }]);
          });
        } else if (f.kind === "media" && (f.subkind === "image" || f.subkind === "avatar")) {
          void driveApi().mediaUrl?.(f.ref).then((r) => {
            if (r?.ok && r.url && thumb.isConnected) {
              thumb.style.backgroundImage = `url("${r.url.replace(/"/g, "%22")}")`;
              thumb.classList.add("gdrive-thumb-img");
              biasThumbCrop(thumb, r.url);
            }
          });
        } else if (f.kind === "file" && (f.mime || "").startsWith("image/")) {
          // File artifacts that ARE images preview like media cards — the
          // signed URL renders inline now.
          void api.filesGet?.(f.ref).then((r) => {
            if (r?.downloadUrl && thumb.isConnected) {
              thumb.style.backgroundImage = `url("${r.downloadUrl.replace(/"/g, "%22")}")`;
              thumb.classList.add("gdrive-thumb-img");
              biasThumbCrop(thumb, r.downloadUrl);
            }
          });
        }
        return card;
      };

      const fileMenuItems = (f: DriveEntry): Array<{ label: string; danger?: boolean; fn: () => void }> => {
        const items: Array<{ label: string; danger?: boolean; fn: () => void }> = [
          { label: "Open", fn: () => openEntry(f) },
          { label: "Move to root", fn: () => void (async () => { await api.gdriveMove?.(f.kind, f.ref, null); void paint(); })() },
          ...folders.map((fo) => ({
            label: `Move to ${fo.name}`,
            fn: () => void (async () => { await api.gdriveMove?.(f.kind, f.ref, fo.id); void paint(); })(),
          })),
        ];
        // EVERY kind deletes from Drive (his order, 2026-08-24): the object is
        // removed for the whole org, not merely unfiled.
        const del = f.kind === "slides" ? () => driveApi().gpointDelete?.(f.file || f.ref)
          : f.kind === "design" ? () => driveApi().designDelete?.(f.file || f.ref)
          : f.kind === "music" ? () => driveApi().musicSongDelete?.(f.ref)
          : f.kind === "media" ? () => (driveApi() as { mediaDelete?: (id: string) => Promise<unknown> }).mediaDelete?.(f.ref)
          : f.kind === "file" ? () => api.filesDelete?.(f.ref)
          : null;
        if (del) {
          items.push({ label: "Delete…", danger: true, fn: () => void (async () => {
            const ok = await host.confirm({ title: `Delete “${f.title || f.ref}”?`, body: "Removed for the whole org. This can't be undone.", confirmLabel: "Delete", danger: true });
            if (!ok) return;
            await del();
            void paint();
          })() });
        }
        return items;
      };

      const fileRow = (f: DriveEntry): HTMLElement => {
        const row = document.createElement("div");
        row.className = "gdrive-listrow";
        row.innerHTML = `
          <span class="gdrive-listrow-ic">${iconFor(f)}</span>
          <span class="gdrive-listrow-title"></span>
          <span class="gdrive-listrow-kind">${kindLabel(f)}</span>
          <span class="gdrive-listrow-size">${f.sizeBytes ? fmtSize(f.sizeBytes) : ""}</span>
          <span class="gdrive-listrow-date">${new Date(f.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
          <button class="ws-icon-btn gdrive-card-kebab" title="Options">
            <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="12" cy="19" r="1.9"/></svg>
          </button>`;
        (row.querySelector(".gdrive-listrow-title") as HTMLElement).textContent = f.title || f.ref;
        row.draggable = true;
        row.addEventListener("dragstart", (ev) => {
          ev.dataTransfer?.setData("application/x-glyphh-drive", JSON.stringify({ kind: f.kind, ref: f.ref }));
          ev.dataTransfer!.effectAllowed = "move";
        });
        row.addEventListener("click", (ev) => {
          if ((ev.target as HTMLElement).closest(".gdrive-card-kebab")) return;
          openEntry(f);
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
          wireFolderDrop(card, f.id);
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
        none.textContent = query ? "No matches." : "Nothing here yet — what the apps make lands in Drive automatically.";
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
