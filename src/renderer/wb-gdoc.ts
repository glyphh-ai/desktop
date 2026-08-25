/**
 * wb-gdoc.ts — the DOCS workbench panel (Glyphh Office).
 *
 * A document is MARKDOWN in the org library, rendered as PAPER — a white page
 * with a table of contents, Google-Docs-shaped. Editing is deliberately
 * minimal: the agent authors documents; a human can click one section's ✎ and
 * fix its markdown, rename via the title, or review-and-approve the agent's
 * pending suggestions. File ▾ carries Print / Export PDF / Delete.
 *
 * Library → document; all transitions re-render the panel body in place
 * (never the rails — same lesson as Slides). One module serves rail slots,
 * Echo cards, and (later) a popped-out window.
 */

import { renderDocMarkdown } from "./md-doc.js";
import { parseDocStyle } from "../shared/doc-styles.js";
import { officePager, officePage, mountDocThumb, invalidateDocThumb } from "./wb-office-ui.js";

export interface GDocMeta { file: string; title: string; size: number; folderId: string | null; mtime: number }
export interface GDocSuggestion {
  id: string; file: string; section: string; beforeMd: string; afterMd: string;
  note: string; authorKind: string; status: string; createdAt: string;
}
export interface GDocTemplate { slug: string; name: string; category: string; description: string; markdown: string }

export interface GDocSlotState {
  id: number;
  file?: string;
  title?: string;
  /** Library page — survives re-renders. */
  page?: number;
  /** Document view: the rendered paper or the raw-markdown Monaco editor. */
  mode?: "preview" | "editor";
}

export interface GDocHost {
  confirm: (opts: { title: string; body?: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>;
  /** The panel's VIEW_META glyph — list rows + empty states. */
  icon: string;
}

const gdocApi = () => (window as unknown as { glyphh?: {
  gdocList?: () => Promise<{ ok: boolean; docs: GDocMeta[]; error?: string }>;
  gdocRead?: (file: string) => Promise<{ ok: boolean; markdown?: string; title?: string; error?: string }>;
  gdocWrite?: (file: string, markdown: string) => Promise<{ ok: boolean; file?: string; title?: string; error?: string }>;
  gdocDelete?: (file: string) => Promise<{ ok: boolean; error?: string }>;
  gdocSuggestions?: (file: string, status?: string) => Promise<{ ok: boolean; suggestions: GDocSuggestion[]; error?: string }>;
  gdocSuggest?: (file: string, input: unknown) => Promise<{ ok: boolean; suggestion?: unknown; error?: string }>;
  gdocResolve?: (id: string, approve: boolean) => Promise<{ ok: boolean; error?: string }>;
  gdocTemplates?: () => Promise<{ ok: boolean; templates: GDocTemplate[]; error?: string }>;
  officeExportPdf?: (req: { kind: "slides" | "doc-html"; file?: string; title?: string; html?: string; print?: boolean }) => Promise<{ ok: boolean; error?: string }>;
} }).glyphh ?? {};

const mdCache = new Map<string, string>();
async function docMarkdown(file: string): Promise<string | null> {
  const hit = mdCache.get(file);
  if (hit !== undefined) return hit;
  const res = await gdocApi().gdocRead?.(file);
  if (!res?.ok || typeof res.markdown !== "string") return null;
  mdCache.set(file, res.markdown);
  return res.markdown;
}

// ── Section model — heading-bounded spans over the SOURCE (fence-aware) ──────
export interface GDocSection { heading: string; level: number; start: number; end: number }
export function splitSections(md: string): GDocSection[] {
  const lines = md.split("\n");
  const marks: Array<{ at: number; level: number; heading: string }> = [];
  let fence = false;
  let pos = 0;
  for (const line of lines) {
    const at = pos;
    pos += line.length + 1;
    if (/^(```|~~~)/.test(line.trim())) { fence = !fence; continue; }
    if (fence) continue;
    const m = line.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (m) marks.push({ at, level: m[1]!.length, heading: m[2]! });
  }
  const out: GDocSection[] = [];
  if (!marks.length || marks[0]!.at > 0) {
    out.push({ heading: "", level: 0, start: 0, end: marks.length ? marks[0]!.at : md.length });
  }
  for (let i = 0; i < marks.length; i++) {
    out.push({ heading: marks[i]!.heading, level: marks[i]!.level, start: marks[i]!.at, end: marks[i + 1]?.at ?? md.length });
  }
  // Drop an empty whitespace-only preamble so it never renders as a ghost block.
  return out.filter((s) => s.heading || md.slice(s.start, s.end).trim().length > 0);
}

/** Rename = rewrite the first H1 (or prepend one). Title IS the document's. */
export function retitleMarkdown(md: string, title: string): string {
  const m = md.match(/^#\s+.+$/m);
  if (m && m.index !== undefined) return md.slice(0, m.index) + `# ${title}` + md.slice(m.index + m[0].length);
  return `# ${title}\n\n${md}`;
}

// ── Monaco (raw-markdown editor mode) ────────────────────────────────────────
// The same AMD loader code-workbench.ts uses (window.require + monaco/ assets in
// dist) — duplicated here because importing it back out of code-workbench would
// be a module cycle. First call loads the editor; later calls resolve instantly.
let gdocMonacoReady: Promise<void> | null = null;
function ensureGdocMonaco(): Promise<void> {
  if (gdocMonacoReady) return gdocMonacoReady;
  gdocMonacoReady = new Promise<void>((resolve) => {
    const w = window as unknown as { monaco?: unknown; require?: { config: (cfg: unknown) => void; (deps: string[], cb: () => void): void } };
    if (w.monaco) { resolve(); return; }
    if (!w.require) { resolve(); return; }   // no AMD host (web mobile) — the textarea fallback runs
    w.require.config({ paths: { vs: "monaco" } });
    w.require(["vs/editor/editor.main"], () => resolve());
  });
  return gdocMonacoReady;
}
/** Dark editor on dark surfaces — decided by the theme's actual paint. */
function gdocMonacoTheme(): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim()
    || getComputedStyle(document.body).backgroundColor;
  let r = 255, g = 255, b = 255;
  const hex = /^#([0-9a-f]{6})$/i.exec(raw);
  const rgb = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(raw);
  if (hex) { const n = parseInt(hex[1]!, 16); r = (n >> 16) & 255; g = (n >> 8) & 255; b = n & 255; }
  else if (rgb) { r = Number(rgb[1]); g = Number(rgb[2]); b = Number(rgb[3]); }
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128 ? "vs-dark" : "vs";
}
/** The open editor-mode instance — disposed before any re-render replaces its DOM. */
let liveGdocEditor: { dispose(): void } | null = null;

const fmtDate = (ms: number): string => (ms ? new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "");

interface PopItem { label: string; danger?: boolean; fn: () => void }
function popMenu(x: number, y: number, items: PopItem[]): void {
  document.querySelectorAll(".gdoc-menu").forEach((el) => el.remove());
  const menu = document.createElement("div");
  menu.className = "ws-popover gdoc-menu";
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

export interface GDocPanel {
  renderIntoSlot: (body: HTMLElement, slot: GDocSlotState, wrap: HTMLElement) => Promise<void>;
  invalidate: (file: string) => void;
}

export function initGDocs(host: GDocHost): GDocPanel {

  async function renderIntoSlot(body: HTMLElement, slot: GDocSlotState, wrap: HTMLElement): Promise<void> {
    try {
      await renderInner(body, slot, wrap);
    } catch (err) {
      console.warn("[gdoc] render failed:", err);
      if (body.isConnected) {
        body.innerHTML = `<div class="gdoc-empty">Docs hit an error rendering this view.<br><code class="gpoint-err"></code></div>`;
        const code = body.querySelector(".gpoint-err");
        if (code) code.textContent = err instanceof Error ? err.message : String(err);
      }
    }
  }

  async function renderInner(body: HTMLElement, slot: GDocSlotState, wrap: HTMLElement): Promise<void> {
    body.classList.add("ws-gdoc-body");
    liveGdocEditor?.dispose();
    liveGdocEditor = null;
    const refresh = (): void => { if (body.isConnected) void renderIntoSlot(body, slot, wrap); };
    // Rail-slot header title tracks the open document (Echo cards just miss).
    const titleEl = wrap.querySelector(".ws-rail-slot-header .title");
    if (titleEl) titleEl.textContent = slot.file ? (slot.title || "Docs") : "Docs";
    if (!slot.file) { await renderLibrary(body, slot, refresh); return; }
    await renderDoc(body, slot, refresh);
  }

  // ── LIBRARY ────────────────────────────────────────────────────────────────

  async function renderLibrary(body: HTMLElement, slot: GDocSlotState, refresh: () => void): Promise<void> {
    body.innerHTML = `
      <div class="gdoc-lib">
        <div class="office-toolbar">
          <input class="office-search" type="text" placeholder="Search documents…" spellcheck="false" autocomplete="off" />
          <button class="action-btn primary office-new">＋ New</button>
          <button class="ws-icon-btn office-refresh" title="Refresh">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.3"/><polyline points="21 3 21 9 15 9"/></svg>
          </button>
        </div>
        <div class="office-grid"></div>
        <div class="gdoc-empty hidden">No documents yet.<br>＋ New starts from a template, or ask Glyphh — "write me a…".</div>
      </div>`;
    body.querySelector(".office-refresh")?.addEventListener("click", refresh);

    const openDoc = (d: { file: string; title: string }): void => {
      slot.file = d.file;
      slot.title = d.title;
      refresh();
    };

    body.querySelector(".office-new")?.addEventListener("click", (ev) => {
      void (async () => {
        const res = await gdocApi().gdocTemplates?.();
        const templates = res?.ok ? res.templates : [];
        const r = (ev.currentTarget as HTMLElement).getBoundingClientRect?.() ?? { left: (ev as MouseEvent).clientX, bottom: (ev as MouseEvent).clientY };
        const uniqueName = (stem: string, taken: Set<string>): string => {
          let name = stem, n = 2;
          while (taken.has(`${name}.md`)) name = `${stem}-${n++}`;
          return name;
        };
        const createFrom = async (stem: string, markdown: string): Promise<void> => {
          const list = await gdocApi().gdocList?.();
          const taken = new Set((list?.ok ? list.docs : []).map((d) => d.file));
          const name = uniqueName(stem, taken);
          const w = await gdocApi().gdocWrite?.(name, markdown);
          if (!w?.ok) { void host.confirm({ title: "Couldn't create the document", body: w?.error || "Unknown error.", confirmLabel: "OK" }); return; }
          mdCache.set(w.file || `${name}.md`, markdown);
          openDoc({ file: w.file || `${name}.md`, title: w.title || stem });
        };
        popMenu(("left" in r ? r.left : 0), ("bottom" in r ? r.bottom + 4 : 0), [
          { label: "Blank document", fn: () => void createFrom("untitled", "# Untitled\n\n") },
          ...templates.map((t) => ({ label: `${t.name} — ${t.category}`, fn: () => void createFrom(t.slug, t.markdown) })),
        ]);
      })();
    });

    const grid = body.querySelector<HTMLElement>(".office-grid")!;
    const empty = body.querySelector<HTMLElement>(".gdoc-empty");
    const res = await gdocApi().gdocList?.();
    if (!body.isConnected) return;
    if (!res || !Array.isArray(res.docs) || (!res.ok && !res.docs.length)) {
      if (empty) {
        empty.innerHTML = res && !res.ok
          ? `Couldn't load the library.<br>${res.error ?? "Unknown error."}`
          : "This surface has no document library.";
        empty.classList.remove("hidden");
      }
      return;
    }
    const docs = res.docs;

    const PER_PAGE = 18;
    const paint = (query: string): void => {
      grid.textContent = "";
      body.querySelector(".office-pager")?.remove();
      const q = query.toLowerCase();
      const matches = docs.filter((d) => !q || (d.title || "").toLowerCase().includes(q) || d.file.toLowerCase().includes(q));
      empty?.classList.toggle("hidden", matches.length > 0);
      if (!docs.length) empty?.classList.remove("hidden");
      const paged = officePage(matches, q ? 0 : (slot.page ?? 0), PER_PAGE);
      if (!q) slot.page = paged.page;
      const inView = paged.items;
      const pager = officePager(matches.length, paged.page, PER_PAGE, (pg) => { slot.page = pg; paint(query); });
      if (pager && !q) grid.parentElement?.appendChild(pager);
      for (const d of inView) {
        const card = document.createElement("div");
        card.className = "gdrive-card";
        card.innerHTML = `
          <div class="gpoint-thumb gdrive-thumb"><div class="gpoint-thumb-ph">${host.icon}</div></div>
          <div class="gdrive-card-row">
            <span class="gdrive-card-title"></span>
            <button class="ws-icon-btn office-card-kebab" title="Options">
              <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="12" cy="19" r="1.9"/></svg>
            </button>
          </div>
          <span class="gdrive-card-meta">${fmtDate(d.mtime)}</span>`;
        (card.querySelector(".gdrive-card-title") as HTMLElement).textContent = d.title || d.file;
        mountDocThumb(card.querySelector<HTMLElement>(".gdrive-thumb")!, d.file);
        card.addEventListener("click", (ev) => {
          if ((ev.target as HTMLElement).closest(".office-card-kebab")) return;
          openDoc(d);
        });
        card.querySelector(".office-card-kebab")?.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
          popMenu(r.right - 150, r.bottom + 4, [
            { label: "Open", fn: () => openDoc(d) },
            { label: "Delete…", danger: true, fn: () => void (async () => {
              const ok = await host.confirm({ title: `Delete “${d.title || d.file}”?`, body: "The document is removed for the whole org. This can't be undone.", confirmLabel: "Delete", danger: true });
              if (!ok) return;
              const del = await gdocApi().gdocDelete?.(d.file);
              if (del && !del.ok) { void host.confirm({ title: "Couldn't delete", body: del.error || "Unknown error.", confirmLabel: "OK" }); return; }
              mdCache.delete(d.file);
              refresh();
            })() },
          ]);
        });
        grid.appendChild(card);
      }
    };
    const search = body.querySelector<HTMLInputElement>(".office-search")!;
    let debounce = 0;
    search.addEventListener("keydown", (e) => e.stopPropagation());
    search.addEventListener("input", () => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => paint(search.value.trim()), 160);
    });
    paint("");
  }

  // ── DOCUMENT ───────────────────────────────────────────────────────────────

  async function renderDoc(body: HTMLElement, slot: GDocSlotState, refresh: () => void): Promise<void> {
    const file = slot.file!;
    const md = await docMarkdown(file);
    if (!body.isConnected) return;
    if (md === null) {
      slot.file = undefined; slot.title = undefined;
      await renderLibrary(body, slot, refresh);
      return;
    }
    const sections = splitSections(md);

    body.innerHTML = `
      <div class="gdoc-doc">
        <div class="gdoc-bar">
          <button class="gpoint-back gdoc-back" title="Back to Docs">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 6 9 12 15 18"/></svg>
            <span>Docs</span>
          </button>
          <input class="gpoint-reader-title gdoc-title" spellcheck="false" autocomplete="off" title="Click to rename" />
          <div class="gdoc-mode-tabs">
            <button class="app-detail-tab" data-dmode="preview" type="button">Preview</button>
            <button class="app-detail-tab" data-dmode="editor" type="button">Editor</button>
          </div>
          <span class="set-save-state gdoc-save-state"></span>
          <button class="action-btn gdoc-file-menu">File ▾</button>
        </div>
        <div class="gdoc-review hidden"></div>
        <div class="gdoc-main">
          <div class="gdoc-toc"></div>
          <div class="gdoc-scroll"><div class="gdoc-paper"></div></div>
        </div>
      </div>`;

    const saveDoc = async (next: string): Promise<boolean> => {
      const write = gdocApi().gdocWrite;
      if (!write) { void host.confirm({ title: "Can't save", body: "This surface can't write documents yet.", confirmLabel: "OK" }); return false; }
      const res = await write(file, next).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
      if (!res || !res.ok) { void host.confirm({ title: "Couldn't save the document", body: (res as { error?: string } | undefined)?.error || "Unknown error.", confirmLabel: "OK" }); return false; }
      mdCache.set(file, next);
      invalidateDocThumb(file);
      if ("title" in res && res.title) slot.title = res.title;
      return true;
    };

    // Back + rename.
    body.querySelector(".gdoc-back")?.addEventListener("click", () => {
      slot.file = undefined; slot.title = undefined;
      refresh();
    });
    const titleInput = body.querySelector<HTMLInputElement>(".gdoc-title")!;
    titleInput.value = slot.title || file;
    titleInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); titleInput.blur(); }
      else if (e.key === "Escape") { titleInput.value = slot.title || file; titleInput.blur(); }
    });
    titleInput.addEventListener("blur", () => {
      void (async () => {
        const next = titleInput.value.trim();
        if (!next || next === (slot.title || "")) { titleInput.value = slot.title || file; return; }
        if (await saveDoc(retitleMarkdown(md, next))) { slot.title = next; refresh(); }
        else titleInput.value = slot.title || file;
      })();
    });

    // File ▾ — Print, Export PDF, Delete.
    body.querySelector(".gdoc-file-menu")?.addEventListener("click", (ev) => {
      const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
      const exporter = gdocApi().officeExportPdf;
      const renderedHtml = (): string => renderDocMarkdown(mdCache.get(file) ?? md);
      popMenu(r.left, r.bottom + 4, [
        ...(exporter ? [
          { label: "Print…", fn: () => void exporter({ kind: "doc-html", title: slot.title || file, html: renderedHtml(), print: true }) },
          { label: "Export as PDF", fn: () => void (async () => {
            const res = await exporter({ kind: "doc-html", title: slot.title || file, html: renderedHtml() });
            if (!res.ok) void host.confirm({ title: "Couldn't export", body: res.error || "Unknown error.", confirmLabel: "OK" });
          })() },
        ] : []),
        { label: "Delete document…", danger: true, fn: () => void (async () => {
          const ok = await host.confirm({ title: `Delete “${slot.title || file}”?`, body: "Removed for the whole org. This can't be undone.", confirmLabel: "Delete", danger: true });
          if (!ok) return;
          await gdocApi().gdocDelete?.(file);
          mdCache.delete(file);
          slot.file = undefined; slot.title = undefined;
          refresh();
        })() },
      ]);
    });

    // ── Preview | Editor tabs (his order, 2026-08-25): the paper is the
    // default; Editor opens the WHOLE document's raw markdown in Monaco
    // (autosaving), for when section-pencil editing isn't enough. ──
    const modeNow = slot.mode === "editor" ? "editor" : "preview";
    body.querySelectorAll<HTMLElement>(".gdoc-mode-tabs .app-detail-tab").forEach((b) => {
      b.classList.toggle("active", b.dataset.dmode === modeNow);
      b.addEventListener("click", () => {
        if (b.dataset.dmode === modeNow) return;
        slot.mode = b.dataset.dmode === "editor" ? "editor" : "preview";
        refresh();
      });
    });
    if (modeNow === "editor") {
      const main = body.querySelector<HTMLElement>(".gdoc-main")!;
      main.innerHTML = `<div class="gdoc-editor-host"></div>`;
      const hostEl = main.querySelector<HTMLElement>(".gdoc-editor-host")!;
      const saveState = body.querySelector<HTMLElement>(".gdoc-save-state");
      let saveTimer = 0;
      const scheduleRawSave = (value: () => string): void => {
        window.clearTimeout(saveTimer);
        if (saveState) { saveState.textContent = "Editing…"; saveState.className = "set-save-state gdoc-save-state"; }
        saveTimer = window.setTimeout(() => {
          void (async () => {
            const okSave = await saveDoc(value());
            if (!saveState) return;
            saveState.textContent = okSave ? "Saved" : "Not saved";
            saveState.className = `set-save-state gdoc-save-state${okSave ? " success" : " error"}`;
            if (okSave) window.setTimeout(() => { if (saveState.textContent === "Saved") saveState.textContent = ""; }, 2500);
          })();
        }, 800);
      };
      await ensureGdocMonaco();
      const monaco = (window as unknown as { monaco?: {
        editor: { create: (el: HTMLElement, opts: Record<string, unknown>) => { getValue(): string; onDidChangeModelContent(cb: () => void): void; dispose(): void } };
      } }).monaco;
      if (!body.isConnected) return;
      if (monaco) {
        const ed = monaco.editor.create(hostEl, {
          value: md, language: "markdown", theme: gdocMonacoTheme(),
          automaticLayout: true, wordWrap: "on", minimap: { enabled: false },
          fontSize: 13, lineNumbers: "on", scrollBeyondLastLine: false,
        });
        ed.onDidChangeModelContent(() => scheduleRawSave(() => ed.getValue()));
        liveGdocEditor = ed;
      } else {
        // No AMD/monaco on this surface — a plain raw-markdown textarea still
        // honors the tab rather than dead-ending it.
        const ta = document.createElement("textarea");
        ta.className = "gdoc-editor-ta gdoc-raw-ta";
        ta.value = md;
        ta.spellcheck = false;
        ta.addEventListener("keydown", (e) => e.stopPropagation());
        ta.addEventListener("input", () => scheduleRawSave(() => ta.value));
        hostEl.appendChild(ta);
      }
      return;
    }

    // TOC + paper, section by section.
    const toc = body.querySelector<HTMLElement>(".gdoc-toc")!;
    const paper = body.querySelector<HTMLElement>(".gdoc-paper")!;
    // Apply the document's style directive (theme / design-system) to the paper.
    for (const decl of parseDocStyle(md).split(";")) {
      const [k, v] = decl.split(/:(.+)/);
      if (k && v && k.trim().startsWith("--doc-")) paper.style.setProperty(k.trim(), v.trim());
    }
    sections.forEach((sec, i) => {
      const block = document.createElement("div");
      block.className = "gdoc-block";
      block.dataset.sec = String(i);
      block.innerHTML = renderDocMarkdown(md.slice(sec.start, sec.end));
      const edit = document.createElement("button");
      edit.className = "ws-icon-btn gdoc-block-edit";
      edit.title = "Edit this section";
      edit.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>`;
      const comment = document.createElement("button");
      comment.className = "ws-icon-btn gdoc-block-comment";
      comment.title = "Comment on this section";
      comment.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
      block.appendChild(edit);
      block.appendChild(comment);
      comment.addEventListener("click", () => {
        // A comment is a suggestion that changes NOTHING — the note IS the
        // payload; it lands in the same review strip as agent edits.
        if (block.querySelector(".gdoc-comment-box")) return;
        const box = document.createElement("div");
        box.className = "gdoc-comment-box";
        box.innerHTML = `
          <input class="gdoc-comment-input" type="text" placeholder="Add a comment on this section…" spellcheck="true" />
          <button class="action-btn primary gdoc-comment-send">Comment</button>
          <button class="action-btn gdoc-comment-cancel">Cancel</button>`;
        block.appendChild(box);
        const input = box.querySelector<HTMLInputElement>(".gdoc-comment-input")!;
        input.focus();
        const closeBox = (): void => box.remove();
        const send = (): void => {
          const note = input.value.trim();
          if (!note) { closeBox(); return; }
          const cur = mdCache.get(file) ?? md;
          const spans = splitSections(cur);
          const span = spans[i];
          const sectionMd = span ? cur.slice(span.start, span.end) : "";
          void (async () => {
            await gdocApi().gdocSuggest?.(file, {
              section: sec.heading ?? "",
              beforeMd: sectionMd,
              afterMd: sectionMd,
              note,
              authorKind: "user",
            });
            closeBox();
            refresh();
          })();
        };
        box.querySelector(".gdoc-comment-send")?.addEventListener("click", send);
        box.querySelector(".gdoc-comment-cancel")?.addEventListener("click", closeBox);
        input.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") send();
          if (ev.key === "Escape") closeBox();
        });
      });
      edit.addEventListener("click", () => {
        // Swap the block for a section editor — the ONE sanctioned hand-edit.
        const cur = mdCache.get(file) ?? md;
        const spans = splitSections(cur);
        const span = spans[i];
        if (!span) { refresh(); return; }
        const editor = document.createElement("div");
        editor.className = "gdoc-editor";
        const ta = document.createElement("textarea");
        ta.className = "gdoc-editor-ta";
        ta.value = cur.slice(span.start, span.end);
        ta.rows = Math.min(24, Math.max(6, ta.value.split("\n").length + 1));
        const bar = document.createElement("div");
        bar.className = "gdoc-editor-bar";
        const save = document.createElement("button");
        save.className = "action-btn primary";
        save.textContent = "Save";
        const cancel = document.createElement("button");
        cancel.className = "action-btn";
        cancel.textContent = "Cancel";
        bar.append(save, cancel);
        editor.append(ta, bar);
        block.replaceWith(editor);
        ta.focus();
        cancel.addEventListener("click", refresh);
        save.addEventListener("click", () => {
          void (async () => {
            const next = cur.slice(0, span.start) + ta.value.replace(/\s*$/, "\n\n") + cur.slice(span.end);
            if (await saveDoc(next)) refresh();
          })();
        });
      });
      paper.appendChild(block);

      if (sec.heading) {
        const item = document.createElement("button");
        item.className = `gdoc-toc-item lvl${sec.level}`;
        item.textContent = sec.heading;
        // Scroll ONLY the doc's own pane. scrollIntoView walks EVERY scrollable
        // ancestor, so it also shoved the app's outer container — the whole
        // page lifted and left a gap under the composer (his bug, 2026-08-25).
        item.addEventListener("click", () => {
          const pane = body.querySelector<HTMLElement>(".gdoc-scroll");
          if (!pane) return;
          const top = block.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - 8;
          pane.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
        });
        toc.appendChild(item);
      }
    });
    if (!toc.children.length) toc.classList.add("hidden");

    // Suggestions — the review-and-approve strip.
    void (async () => {
      const res = await gdocApi().gdocSuggestions?.(file, "pending");
      if (!body.isConnected || !res?.ok || !res.suggestions.length) return;
      const strip = body.querySelector<HTMLElement>(".gdoc-review")!;
      strip.classList.remove("hidden");
      const paint = (open: boolean): void => {
        strip.innerHTML = `<button class="gdoc-review-toggle">${res.suggestions.length} pending edit${res.suggestions.length === 1 ? "" : "s"} to review ${open ? "▴" : "▾"}</button>`;
        strip.querySelector(".gdoc-review-toggle")?.addEventListener("click", () => paint(!open));
        if (!open) return;
        for (const sug of res.suggestions) {
          const card = document.createElement("div");
          card.className = "gdoc-sug";
          card.innerHTML = `
            <div class="gdoc-sug-head"><span class="gdoc-sug-sec"></span><span class="gdoc-sug-note"></span></div>
            ${sug.beforeMd ? `<pre class="gdoc-sug-before"></pre>` : ""}
            <pre class="gdoc-sug-after"></pre>
            <div class="gdoc-sug-actions">
              <button class="action-btn primary gdoc-sug-approve">Approve</button>
              <button class="action-btn gdoc-sug-reject">Reject</button>
            </div>`;
          (card.querySelector(".gdoc-sug-sec") as HTMLElement).textContent = sug.section || "Document";
          (card.querySelector(".gdoc-sug-note") as HTMLElement).textContent = sug.note;
          const before = card.querySelector(".gdoc-sug-before");
          if (before) before.textContent = sug.beforeMd;
          (card.querySelector(".gdoc-sug-after") as HTMLElement).textContent = sug.afterMd;
          const resolve = (approve: boolean): void => {
            void (async () => {
              const r = await gdocApi().gdocResolve?.(sug.id, approve);
              if (r && !r.ok) { void host.confirm({ title: "Couldn't resolve", body: r.error || "Unknown error.", confirmLabel: "OK" }); return; }
              mdCache.delete(file);
              refresh();
            })();
          };
          card.querySelector(".gdoc-sug-approve")?.addEventListener("click", () => resolve(true));
          card.querySelector(".gdoc-sug-reject")?.addEventListener("click", () => resolve(false));
          strip.appendChild(card);
        }
      };
      paint(false);
    })();
  }

  return { renderIntoSlot, invalidate: (file) => { mdCache.delete(file); } };
}
