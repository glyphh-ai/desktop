/**
 * wb-gpoint.ts — the gPoint workbench panel (Glyphh power points).
 *
 * Decks are self-contained HTML files in ~/.glyphh/gpoints (the marketing
 * frame format: a 1920×1080 #stage that scales itself to the viewport,
 * <section class="slide"> pages, .frag/data-step build steps, built-in
 * keyboard/click nav). The panel is a LIBRARY of cards → a READER (slide
 * rail + stage) → a PRESENTER overlay that floods the whole app until Esc.
 *
 * Decks render in same-origin srcdoc iframes: the parent can drive slides
 * directly, and a deck's inlined fonts/scripts need no network access or
 * file:// subframes (which Chromium refuses). There are NO edit affordances
 * anywhere — the agent builds decks (create_gpoint / delete_gpoint).
 *
 * code-workbench.ts owns the slot machinery; everything gPoint-shaped lives
 * here behind initGPoint()'s small host contract.
 */

// The presenter overlay is a DOM layer over the whole app — the same
// BrowserView freeze/hide dance every DOM modal needs (panels paint above).
import { hidePanelsForModal, restorePanelsForModal } from "./yo-modal.js";
import { officePager, officePage } from "./wb-office-ui.js";

export interface GPointDeck { file: string; title: string; slides: number; mtime: number; size: number }

/** The slice of the workbench's GPointSlot this module reads/writes. */
export interface GPointSlotState {
  id: number;
  file?: string;
  title?: string;
  slideIdx?: number;
  /** Reader slide-rail width (px) — set by the drag handle, survives re-renders. */
  railWidth?: number;
  /** Library page — survives re-renders. */
  page?: number;
}

/** What the workbench lends the panel: its confirm modal and a live-slot
 *  lookup (slots are rebuilt on every rail render — never hold one). The panel
 *  NEVER asks the workbench to repaint: in the Echo shell the whole card wall
 *  is one slot, so a rails rebuild tears down the very card being used. All
 *  internal transitions re-render the panel's own body in place. */
export interface GPointHost {
  confirm: (opts: { title: string; body?: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>;
  slotById: (id: number) => GPointSlotState | undefined;
  /** The panel's VIEW_META glyph — thumbnail placeholder. */
  icon: string;
}

const gpointApi = () => (window as unknown as { glyphh?: {
  gpointList?: () => Promise<{ ok: boolean; decks: GPointDeck[]; error?: string }>;
  gpointRead?: (file: string) => Promise<{ ok: boolean; content?: string; error?: string }>;
  gpointDelete?: (file: string) => Promise<{ ok: boolean; error?: string }>;
  gpointWrite?: (file: string, html: string) => Promise<{ ok: boolean; error?: string }>;
  officeExportPdf?: (req: { kind: "slides" | "doc-html"; file?: string; title?: string; html?: string }) => Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
} }).glyphh ?? {};

/** Deck HTML by filename — decks are a few hundred KB and re-render on every
 *  rail drag; one IPC read per deck per session is plenty. */
const htmlCache = new Map<string, string>();
export async function deckHtml(file: string): Promise<string | null> {
  const hit = htmlCache.get(file);
  if (hit) return hit;
  const res = await gpointApi().gpointRead?.(file);
  if (!res?.ok || !res.content) return null;
  htmlCache.set(file, res.content);
  return res.content;
}

const slideCount = (html: string): number =>
  (html.match(/<section[^>]*class="[^"]*\bslide\b[^"]*"/gi) ?? []).length;

// ── Per-slide surgery — STRING level, never a DOM round-trip (parsing and
// re-serializing a hand-authored deck could mangle it). A slide's span runs
// from its <section class="slide"> open tag to the first </section> after it
// (the format never nests sections). `data-gp-hidden` on the open tag is the
// persisted hide flag — it travels with the deck to every surface.
interface SlideSpan { start: number; openEnd: number; end: number; hidden: boolean }
function slideSpans(html: string): SlideSpan[] {
  const re = /<section[^>]*class="[^"]*\bslide\b[^"]*"[^>]*>/gi;
  const spans: SlideSpan[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const close = html.indexOf("</section>", re.lastIndex);
    if (close < 0) break;
    spans.push({ start: m.index, openEnd: m.index + m[0].length, end: close + "</section>".length, hidden: /\bdata-gp-hidden\b/.test(m[0]) });
    re.lastIndex = close;
  }
  return spans;
}
function removeSlideAt(html: string, i: number): string {
  const s = slideSpans(html)[i];
  return s ? html.slice(0, s.start) + html.slice(s.end) : html;
}
/** Speaker notes per slide (data-notes on the section), decoded for display.
 *  Parallel to slideSpans — index N is slide N. Empty string when a slide has
 *  no notes. */
function slideNotes(html: string): string[] {
  const dec = (s: string): string => s
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return slideSpans(html).map((sp) =>
    dec(html.slice(sp.start, sp.openEnd).match(/\sdata-notes="([^"]*)"/i)?.[1] ?? ""));
}
/** The first slide's readable title (for the next-slide cue). */
function slideTitle(html: string, i: number): string {
  const sp = slideSpans(html)[i];
  if (!sp) return "";
  const inner = html.slice(sp.openEnd, sp.end);
  const m = inner.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/i);
  return (m?.[1] ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
function toggleHiddenAt(html: string, i: number): string {
  const s = slideSpans(html)[i];
  if (!s) return html;
  const open = html.slice(s.start, s.openEnd);
  const next = s.hidden
    ? open.replace(/\s*data-gp-hidden(="[^"]*")?/i, "")
    : open.replace(/^<section/i, '<section data-gp-hidden="1"');
  return html.slice(0, s.start) + next + html.slice(s.openEnd);
}
/** The presenter never sees hidden slides — their sections are stripped from
 *  the document before it mounts, so the deck's own nav simply skips them. */
function stripHidden(html: string): string {
  const hidden = slideSpans(html).filter((s) => s.hidden);
  for (let i = hidden.length - 1; i >= 0; i--) {
    html = html.slice(0, hidden[i]!.start) + html.slice(hidden[i]!.end);
  }
  return html;
}

/** A deck frozen onto ONE fully-revealed slide — thumbnail document. The
 *  tail-appended nodes are hoisted into <body> and run before
 *  DOMContentLoaded, after the deck's own init. */
export function staticDoc(html: string, slide: number): string {
  return html
    + `<style>*{transition:none!important;animation:none!important}</style>`
    + `<script>addEventListener("DOMContentLoaded",()=>{document.querySelectorAll(".slide").forEach((s,k)=>{`
    + `s.classList.toggle("on",k===${slide});`
    + `if(k===${slide})s.querySelectorAll(".frag").forEach(f=>f.classList.add("show"));});});</script>`;
}

/** The READER document: the deck plus a capture-phase driver that replaces
 *  its frag-by-frag nav with whole-slide paging (reader = every slide fully
 *  revealed), reports slide changes to the panel, and exposes __gpGoto for
 *  the slide rail. Capture on window fires before the deck's own bubble
 *  handlers, so stopImmediatePropagation retires them cleanly. */
function readerDoc(html: string, slotId: number, start: number): string {
  return html + `<script>(()=>{const slides=[...document.querySelectorAll(".slide")];if(!slides.length)return;`
    + `const prog=document.getElementById("prog");let cur=0;`
    + `function apply(i){i=Math.max(0,Math.min(slides.length-1,i));`
    + `slides.forEach((s,k)=>s.classList.toggle("on",k===i));`
    + `slides[i].querySelectorAll(".frag").forEach(f=>f.classList.add("show"));`
    + `cur=i;if(prog&&slides.length>1)prog.style.width=(i/(slides.length-1)*100)+"%";`
    + `try{parent.__gpSlideChanged&&parent.__gpSlideChanged(${slotId},i)}catch(e){}}`
    + `addEventListener("keydown",e=>{e.stopImmediatePropagation();`
    + `if(["ArrowRight"," ","PageDown","Enter","ArrowDown"].includes(e.key)){e.preventDefault();apply(cur+1);}`
    + `else if(["ArrowLeft","PageUp","Backspace","ArrowUp"].includes(e.key)){e.preventDefault();apply(cur-1);}`
    + `else if(e.key==="Home")apply(0);else if(e.key==="End")apply(slides.length-1);},true);`
    + `addEventListener("click",e=>{e.stopImmediatePropagation();},true);`
    + `window.__gpGoto=apply;apply(${start});})();</script>`;
}

/** A presenter deck that OPENS on a given slide: the deck reads its start
 *  slide from location.hash at init, so plant the hash before its script
 *  parses (hash-opened slides reveal every frag — right for resuming). */
function startAt(html: string, slide: number): string {
  if (slide <= 0) return html;
  const tag = `<script>try{location.hash="s${slide + 1}"}catch(e){}</script>`;
  const m = html.match(/<body[^>]*>/i);
  return m ? html.replace(m[0], m[0] + tag) : tag + html;
}

/** Thumbnails render 2 per frame — a rail drag re-renders the panel and a
 *  deck is a whole document per thumb; a burst would jank the drag. */
export function fillThumbs(jobs: Array<{ host: HTMLElement; doc: string }>): void {
  let i = 0;
  const step = (): void => {
    if (i >= jobs.length || !jobs.some((j) => j.host.isConnected)) return;
    for (const job of jobs.slice(i, i + 2)) {
      if (!job.host.isConnected) continue;
      const frame = document.createElement("iframe");
      frame.setAttribute("tabindex", "-1");
      frame.srcdoc = job.doc;
      job.host.appendChild(frame);
    }
    i += 2;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

interface PopMenuItem { label: string; danger?: boolean; fn: () => void }
function openPopMenu(x: number, y: number, items: PopMenuItem[]): void {
  document.querySelectorAll(".gpoint-menu").forEach((el) => el.remove());
  const menu = document.createElement("div");
  menu.className = "ws-popover gpoint-menu";
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
function openCardMenu(anchor: HTMLElement, onOpen: () => void, onDelete: () => void): void {
  const r = anchor.getBoundingClientRect();
  openPopMenu(r.right - 150, r.bottom + 4, [
    { label: "Open", fn: onOpen },
    { label: "Delete…", danger: true, fn: onDelete },
  ]);
}

export interface GPointPanel {
  /** Render the panel into a slot body (library, or reader when slot.file). */
  renderIntoSlot: (body: HTMLElement, slot: GPointSlotState, wrap: HTMLElement) => Promise<void>;
  /** Drop a cached deck (the agent rebuilt it) so the next render re-reads. */
  invalidate: (file: string) => void;
}

export function initGPoint(host: GPointHost): GPointPanel {
  // The reader frame calls up here on every slide change — keep the slot and
  // its slide rail in sync without re-rendering anything.
  (window as unknown as { __gpSlideChanged?: (slotId: number, i: number) => void }).__gpSlideChanged = (slotId, i) => {
    const slot = host.slotById(slotId);
    if (!slot) return;
    slot.slideIdx = i;
    const el = document.querySelector(`.ws-rail-slot[data-slot-id="${slotId}"]`);
    el?.querySelectorAll<HTMLElement>(".gpoint-side-item").forEach((it, k) => {
      it.classList.toggle("active", k === i);
      if (k === i) it.scrollIntoView({ block: "nearest" });
    });
    const count = el?.querySelector(".gpoint-reader-count");
    if (count) count.textContent = `${i + 1} / ${count.getAttribute("data-total") || "?"}`;
  };

  // ── Presenter mode: the deck floods the ENTIRE app, no chrome, driven by
  // the deck's own nav (frag steps, click/arrows) exactly like PowerPoint.
  // Esc exits and hands the last slide back to the reader.
  let presenterUp = false;
  async function openPresenter(html: string, startSlide: number, onExit: (lastSlide: number) => void): Promise<void> {
    if (presenterUp) return;
    presenterUp = true;
    const panelsWereHidden = await hidePanelsForModal();
    const overlay = document.createElement("div");
    overlay.className = "gpoint-presenter";
    const frame = document.createElement("iframe");
    frame.className = "gpoint-presenter-frame";
    frame.srcdoc = startAt(html, startSlide);
    const hint = document.createElement("div");
    hint.className = "gpoint-presenter-hint";
    hint.textContent = "Esc to exit · S for speaker notes";
    overlay.appendChild(frame);
    overlay.appendChild(hint);
    // ── Speaker view: notes + timer + next-slide cue, toggled with S. Reads
    // the deck's #sN hash (the shell writes it on every nav) to track position.
    const notes = slideNotes(html);
    const total = slideSpans(html).length;
    const speaker = document.createElement("div");
    speaker.className = "gpoint-speaker";
    speaker.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:10;display:none;"
      + "padding:22px 30px;background:rgba(10,10,14,.92);color:#f1f1f1;border-top:1px solid #2a2a31;"
      + "font:400 20px/1.5 Inter,-apple-system,system-ui,sans-serif;backdrop-filter:blur(8px);max-height:34vh;overflow:auto";
    speaker.innerHTML = '<div class="gp-sp-meta" style="display:flex;gap:22px;color:#8e8e9c;font-size:16px;margin-bottom:10px;letter-spacing:.02em"></div>'
      + '<div class="gp-sp-notes" style="font-size:23px;line-height:1.5;white-space:pre-wrap"></div>';
    overlay.appendChild(speaker);
    const startedAt = Date.now();
    let speakerOn = false;
    const curSlide = (): number => {
      try {
        const m = frame.contentWindow?.location.hash.match(/^#s(\d+)/);
        if (m) return Math.max(0, Math.min(total - 1, Number(m[1]) - 1));
      } catch { /* srcdoc access — keep 0 */ }
      return 0;
    };
    const paintSpeaker = (): void => {
      if (!speakerOn) return;
      const i = curSlide();
      const secs = Math.floor((Date.now() - startedAt) / 1000);
      const clock = `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
      const nextTitle = i + 1 < total ? slideTitle(html, i + 1) : "";
      const meta = speaker.querySelector(".gp-sp-meta");
      const body = speaker.querySelector(".gp-sp-notes");
      if (meta) meta.textContent = `Slide ${i + 1} / ${total}   ·   ${clock}${nextTitle ? `   ·   Next: ${nextTitle}` : "   ·   Last slide"}`;
      if (body) body.textContent = notes[i] || "— no notes for this slide —";
    };
    const speakerTimer = window.setInterval(paintSpeaker, 500);
    document.body.appendChild(overlay);
    // In a POPPED-OUT window (data-gp-popout) presenting takes the whole
    // screen — real HTML fullscreen; leaving fullscreen IS the exit, so the
    // one Esc does both.
    const popout = document.body.hasAttribute("data-gp-popout");
    const onFsChange = (): void => { if (!document.fullscreenElement) exit(); };
    if (popout) {
      document.addEventListener("fullscreenchange", onFsChange);
      void overlay.requestFullscreen?.().catch(() => { /* windowed presenting still works */ });
    }
    const exit = (): void => {
      if (!presenterUp) return;
      presenterUp = false;
      let last = startSlide;
      try {
        const m = frame.contentWindow?.location.hash.match(/^#s(\d+)/);
        if (m) last = Number(m[1]) - 1;
      } catch { /* keep the start slide */ }
      if (popout) {
        document.removeEventListener("fullscreenchange", onFsChange);
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => { /* window close mid-present */ });
      }
      window.clearInterval(speakerTimer);
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      restorePanelsForModal(panelsWereHidden);
      onExit(last);
    };
    const toggleSpeaker = (): void => {
      speakerOn = !speakerOn;
      speaker.style.display = speakerOn ? "block" : "none";
      if (speakerOn) paintSpeaker();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); exit(); }
      else if (e.key === "s" || e.key === "S") { e.preventDefault(); e.stopPropagation(); toggleSpeaker(); }
    };
    document.addEventListener("keydown", onKey, true);
    frame.addEventListener("load", () => {
      // Focus lives INSIDE the iframe while presenting — catch Esc there too
      // (same-origin srcdoc, so the child window takes our listener).
      try {
        frame.contentWindow?.addEventListener("keydown", ((e: KeyboardEvent) => {
          if (e.key === "Escape") { e.preventDefault(); exit(); }
          else if (e.key === "s" || e.key === "S") { e.preventDefault(); toggleSpeaker(); }
        }) as EventListener, true);
        frame.contentWindow?.focus();
      } catch { /* the parent's capture listener still exits */ }
    });
    setTimeout(() => hint.classList.add("faded"), 2500);
  }

  async function present(slot: GPointSlotState, refresh: () => void): Promise<void> {
    if (!slot.file) return;
    const html = await deckHtml(slot.file);
    if (!html) {
      void host.confirm({ title: "Couldn't open the deck", body: "The deck could not be read.", confirmLabel: "OK" });
      return;
    }
    // Hidden slides never present. Indices shift when they're stripped, so map
    // the reader's slide into VISIBLE space (and back on exit): the start is
    // the count of visible slides before it — which, when the current slide is
    // itself hidden, lands on the next visible one.
    const spans = slideSpans(html);
    const visible = spans.filter((s) => !s.hidden);
    if (!visible.length) {
      void host.confirm({ title: "Every slide is hidden", body: "Unhide at least one slide (right-click it in the rail) to present.", confirmLabel: "OK" });
      return;
    }
    const full = Math.max(0, Math.min(spans.length - 1, slot.slideIdx ?? 0));
    const startVisible = Math.min(visible.length - 1, spans.slice(0, full).filter((s) => !s.hidden).length);
    void openPresenter(stripHidden(html), startVisible, (lastVisible) => {
      // Back to FULL-deck space: the nth visible slide's real index.
      const target = Math.max(0, Math.min(visible.length - 1, lastVisible));
      slot.slideIdx = spans.findIndex((s) => !s.hidden && visible.indexOf(s) === target);
      refresh();
    });
  }

  async function renderLibrary(body: HTMLElement, slot: GPointSlotState, refresh: () => void): Promise<void> {
    body.innerHTML = `
      <div class="gpoint-lib">
        <div class="office-toolbar">
          <input class="office-search" type="text" placeholder="Search decks…" spellcheck="false" autocomplete="off" />
          <button class="action-btn primary office-new">＋ New</button>
          <button class="ws-icon-btn office-refresh" title="Refresh">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.3"/><polyline points="21 3 21 9 15 9"/></svg>
          </button>
        </div>
        <div class="gpoint-grid"></div>
        <div class="gpoint-empty hidden">No decks yet.<br>＋ New starts one, or ask Glyphh — "make me a slide deck about…".</div>
      </div>`;
    body.querySelector(".office-refresh")?.addEventListener("click", refresh);
    const grid = body.querySelector<HTMLElement>(".gpoint-grid")!;
    const empty = body.querySelector<HTMLElement>(".gpoint-empty");
    const showEmpty = (html: string): void => {
      if (empty) { empty.innerHTML = html; empty.classList.remove("hidden"); }
    };

    const openDeck = (deck: GPointDeck): void => {
      slot.file = deck.file;
      slot.title = deck.title;
      slot.slideIdx = 0;
      refresh();
    };

    // ＋ New: a one-slide starter through the MAIN-side canonical shell —
    // hidden on surfaces without that bridge (the agent path still works).
    const api = gpointApi() as ReturnType<typeof gpointApi> & { gpointNew?: (name: string, title?: string) => Promise<{ ok: boolean; file?: string; title?: string; error?: string }> };
    const newBtn = body.querySelector<HTMLElement>(".office-new");
    if (!(window as unknown as { glyphh?: { gpointNew?: unknown } }).glyphh?.gpointNew) newBtn?.remove();
    else newBtn?.addEventListener("click", () => {
      void (async () => {
        const list = await api.gpointList?.();
        const taken = new Set((list?.ok ? list.decks : []).map((d) => d.file));
        let stem = "untitled", n = 2;
        while (taken.has(`${stem}.html`)) stem = `untitled-${n++}`;
        const res = await (window as unknown as { glyphh: { gpointNew: (name: string, title?: string) => Promise<{ ok: boolean; file?: string; title?: string; error?: string }> } }).glyphh.gpointNew(stem, "Untitled");
        if (!res.ok) { void host.confirm({ title: "Couldn't create the deck", body: res.error || "Unknown error.", confirmLabel: "OK" }); return; }
        openDeck({ file: res.file || `${stem}.html`, title: res.title || "Untitled", slides: 1, mtime: 0, size: 0 });
      })();
    });

    // NEVER leave the body dark and silent: a missing bridge, a dead handler
    // and a real list failure each paint their own message. The web Proxy
    // fallback fakes unknown methods as async no-ops returning undefined, so
    // the shape guard stays load-bearing for a stale web bundle.
    const list = gpointApi().gpointList;
    if (!list) {
      showEmpty("Slides' bridge isn't loaded in this session.");
      return;
    }
    let res: { ok: boolean; decks: GPointDeck[]; error?: string } | undefined;
    try {
      res = await list();
    } catch (err) {
      console.warn("[gpoint] list failed:", err);
      if (body.isConnected) showEmpty("Slides' backend isn't running in this session.");
      return;
    }
    if (!body.isConnected) return;
    if (!res || typeof res.ok !== "boolean") {
      showEmpty("This surface has no deck store.<br>Slides runs in the desktop app.");
      return;
    }
    if (!res.ok) {
      showEmpty(`Couldn't read the deck library.<br>${res.error ?? "Unknown error."}`);
      return;
    }
    const decks = Array.isArray(res.decks) ? res.decks : [];

    const deleteDeck = async (deck: GPointDeck): Promise<void> => {
      const ok = await host.confirm({
        title: `Delete “${deck.title}”?`,
        body: "The deck is removed from the org library. This can't be undone.",
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
      const r = await gpointApi().gpointDelete?.(deck.file);
      if (r && !r.ok) {
        void host.confirm({ title: "Couldn't delete", body: r.error || "Unknown error.", confirmLabel: "OK" });
        return;
      }
      htmlCache.delete(deck.file);
      if (body.isConnected) void renderLibrary(body, slot, refresh);
    };

    const PER_PAGE = 18;
    const paint = (query: string): void => {
      grid.textContent = "";
      body.querySelector(".office-pager")?.remove();
      const q = query.toLowerCase();
      const matches = decks.filter((d) => !q || d.title.toLowerCase().includes(q) || d.file.toLowerCase().includes(q));
      empty?.classList.toggle("hidden", matches.length > 0 || decks.length === 0);
      if (!decks.length) empty?.classList.remove("hidden");
      const paged = officePage(matches, q ? 0 : (slot.page ?? 0), PER_PAGE);
      if (!q) slot.page = paged.page;
      const inView = paged.items;
      const pager = officePager(matches.length, paged.page, PER_PAGE, (pg) => { slot.page = pg; paint(query); });
      if (pager && !q) grid.parentElement?.appendChild(pager);
      for (const deck of inView) {
        const card = document.createElement("div");
        card.className = "gpoint-card";
        card.innerHTML = `
          <div class="gpoint-thumb"><div class="gpoint-thumb-ph">${host.icon}</div></div>
          <div class="gpoint-card-row">
            <div class="gpoint-card-meta">
              <div class="gpoint-card-title"></div>
              <div class="gpoint-card-sub">${deck.slides} slide${deck.slides === 1 ? "" : "s"}</div>
            </div>
            <button class="ws-icon-btn gpoint-kebab" title="Options">
              <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="12" cy="19" r="1.9"/></svg>
            </button>
          </div>`;
        (card.querySelector(".gpoint-card-title") as HTMLElement).textContent = deck.title;
        card.addEventListener("click", (ev) => {
          if ((ev.target as HTMLElement).closest(".gpoint-kebab")) return;
          openDeck(deck);
        });
        card.querySelector(".gpoint-kebab")?.addEventListener("click", (ev) => {
          ev.stopPropagation();
          openCardMenu(ev.currentTarget as HTMLElement, () => openDeck(deck), () => void deleteDeck(deck));
        });
        grid.appendChild(card);
        const host_ = card.querySelector<HTMLElement>(".gpoint-thumb")!;
        void deckHtml(deck.file).then((html) => {
          if (html && host_.isConnected) fillThumbs([{ host: host_, doc: staticDoc(html, 0) }]);
        });
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

  /** Contain every failure: renderSlot void-calls this, so an uncaught throw
   *  would leave the slot body dark and silent — the one thing it must never do. */
  async function renderIntoSlot(body: HTMLElement, slot: GPointSlotState, wrap: HTMLElement): Promise<void> {
    try {
      await renderIntoSlotInner(body, slot, wrap);
    } catch (err) {
      console.warn("[gpoint] render failed:", err);
      if (body.isConnected) {
        body.innerHTML = `<div class="gpoint-empty">Slides hit an error rendering this view.<br><code class="gpoint-err"></code></div>`;
        const code = body.querySelector(".gpoint-err");
        if (code) // The MESSAGE alone made every null-deref look identical (his report,
        // 2026-08-28) — the top stack frames name the actual line.
        code.textContent = err instanceof Error ? `${err.message}\n${(err.stack || "").split("\n").slice(1, 4).join("\n")}` : String(err);
      }
    }
  }

  async function renderIntoSlotInner(body: HTMLElement, slot: GPointSlotState, wrap: HTMLElement): Promise<void> {
    body.classList.add("ws-gpoint-body");
    // Repaint THIS panel in place — never the rails (see GPointHost note).
    const refresh = (): void => {
      if (body.isConnected) void renderIntoSlot(body, slot, wrap);
    };
    // Rail-slot chrome tracks the open deck in place: the header title shows
    // the deck, and the Present control appears beside maximize. Echo cards
    // have no .ws-rail-slot-header — both lookups simply miss there.
    const headerEl = wrap.querySelector(".ws-rail-slot-header");
    const titleEl = headerEl?.querySelector(".title");
    if (titleEl) titleEl.textContent = slot.file ? (slot.title || "Slides") : "Slides";
    if (!slot.file) headerEl?.querySelector(".slot-present")?.remove();
    if (slot.file && headerEl && !headerEl.querySelector(".slot-present")) {
      const btn = document.createElement("button");
      btn.className = "ws-icon-btn slot-present";
      btn.title = "Present — fills the app; Esc exits";
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 4 20 12 6 20 6 4"/></svg>`;
      btn.addEventListener("click", (ev) => { ev.stopPropagation(); void present(slot, refresh); });
      headerEl.insertBefore(btn, headerEl.querySelector(".slot-maximize"));
    }
    if (!slot.file) { await renderLibrary(body, slot, refresh); return; }

    const html = await deckHtml(slot.file);
    if (!body.isConnected) return;
    if (!html) {
      // The deck vanished under us (deleted on disk) — fall back to the library.
      slot.file = undefined; slot.title = undefined; slot.slideIdx = 0;
      await renderLibrary(body, slot, refresh);
      return;
    }
    const spans = slideSpans(html);
    const total = spans.length;
    const start = Math.max(0, Math.min(total - 1, slot.slideIdx ?? 0));
    body.innerHTML = `
      <div class="gpoint-reader">
        <div class="gpoint-reader-bar">
          <button class="gpoint-back" title="Back to the library">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 6 9 12 15 18"/></svg>
            <span>Slides</span>
          </button>
          <input class="gpoint-reader-title" spellcheck="false" autocomplete="off" title="Click to rename" />
          <span class="gpoint-reader-count" data-total="${total}">${start + 1} / ${total}</span>
          <button class="ws-icon-btn gpoint-pdf" title="Export as PDF">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
          <button class="action-btn primary gpoint-present" title="Fills the whole app — Esc exits">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 4 20 12 6 20 6 4"/></svg>
            <span>Present</span>
          </button>
        </div>
        <div class="gpoint-reader-main">
          <div class="gpoint-side"></div>
          <div class="gpoint-side-resize" title="Drag to resize the slide rail"></div>
          <div class="gpoint-stage"></div>
        </div>
      </div>`;
    body.querySelector(".gpoint-back")?.addEventListener("click", () => {
      slot.file = undefined; slot.title = undefined; slot.slideIdx = 0;
      refresh();
    });
    // In-bar Present: hosts without a rail-slot header (Echo cards) keep the
    // feature; in rail slots it simply doubles the header button.
    body.querySelector(".gpoint-present")?.addEventListener("click", () => { void present(slot, refresh); });
    // PDF export is DESKTOP machinery (offscreen capture in main) — the button
    // only exists where the bridge does.
    const pdfBtn = body.querySelector<HTMLElement>(".gpoint-pdf");
    const exportPdf = gpointApi().officeExportPdf;
    if (!exportPdf) pdfBtn?.remove();
    else pdfBtn?.addEventListener("click", () => {
      void (async () => {
        if (!slot.file) return;
        const res = await exportPdf({ kind: "slides", file: slot.file }).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
        if (!res.ok) void host.confirm({ title: "Couldn't export the PDF", body: ("error" in res ? res.error : undefined) || "Unknown error.", confirmLabel: "OK" });
      })();
    });
    const stage = body.querySelector<HTMLElement>(".gpoint-stage")!;
    const frame = document.createElement("iframe");
    frame.className = "gpoint-frame";
    frame.srcdoc = readerDoc(html, slot.id, start);
    frame.addEventListener("load", () => { try { frame.contentWindow?.focus(); } catch { /* keys engage on click */ } });
    stage.appendChild(frame);
    const side = body.querySelector<HTMLElement>(".gpoint-side")!;
    // The rail is width-driven: thumbs are aspect-ratio boxes at 100% width, so
    // dragging the handle scales every thumbnail live (the decks re-fit
    // themselves on the iframe resize). Width rides the slot across re-renders.
    const setRail = (w: number): void => {
      side.style.flex = `0 0 ${w}px`;
      side.style.width = `${w}px`;
    };
    if (slot.railWidth) setRail(slot.railWidth);
    const grip = body.querySelector<HTMLElement>(".gpoint-side-resize")!;
    grip.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = side.getBoundingClientRect().width;
      const max = Math.max(220, body.getBoundingClientRect().width * 0.5);
      const onMove = (ev: MouseEvent): void => {
        const w = Math.round(Math.max(84, Math.min(max, startW + (ev.clientX - startX))));
        slot.railWidth = w;
        setRail(w);
      };
      const onUp = (): void => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.classList.remove("gpoint-col-drag");
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      // While dragging, the stage iframe must not swallow mouse events.
      document.body.classList.add("gpoint-col-drag");
    });
    // ── Deck writes: rename, per-slide hide/unhide, per-slide delete. Every
    // one re-saves the WHOLE document (decks stay agent-authored; this is
    // surgery, not an editor) and repaints the reader in place.
    const saveDeck = async (next: string): Promise<boolean> => {
      if (!slot.file) return false;
      const write = gpointApi().gpointWrite;
      if (!write) {
        void host.confirm({ title: "Can't save", body: "This surface can't write decks yet.", confirmLabel: "OK" });
        return false;
      }
      const res = await write(slot.file, next).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      if (!res || !res.ok) {
        void host.confirm({ title: "Couldn't save the deck", body: res?.error || "Unknown error.", confirmLabel: "OK" });
        return false;
      }
      htmlCache.set(slot.file, next);
      return true;
    };
    const mutateDeck = async (fn: (h: string, n: number) => string, i: number): Promise<void> => {
      if (!slot.file) return;
      const cur = await deckHtml(slot.file);
      if (!cur) return;
      const next = fn(cur, i);
      if (next !== cur && (await saveDeck(next))) refresh();
    };

    // The deck NAME is the document's <title> — click the bar name to edit;
    // Enter/blur commits (and re-saves the deck), Esc restores. The file name
    // stays put: it's the stable reference every surface addresses.
    const titleInput = body.querySelector<HTMLInputElement>(".gpoint-reader-title")!;
    titleInput.value = slot.title || slot.file;
    titleInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); titleInput.blur(); }
      else if (e.key === "Escape") { titleInput.value = slot.title || slot.file || ""; titleInput.blur(); }
    });
    titleInput.addEventListener("blur", () => {
      void (async () => {
        const next = titleInput.value.trim();
        if (!slot.file || !next || next === (slot.title || "")) {
          titleInput.value = slot.title || slot.file || "";
          return;
        }
        const cur = await deckHtml(slot.file);
        if (!cur) return;
        const esc = next.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const updated = /<title[^>]*>[\s\S]*?<\/title>/i.test(cur)
          ? cur.replace(/<title[^>]*>[\s\S]*?<\/title>/i, `<title>${esc}</title>`)
          : cur.replace(/<head[^>]*>/i, (m) => `${m}<title>${esc}</title>`);
        if (await saveDeck(updated)) {
          slot.title = next;
          refresh();
        } else {
          titleInput.value = slot.title || slot.file || "";
        }
      })();
    });
    const deleteSlideAt = async (i: number): Promise<void> => {
      if (total <= 1) {
        void host.confirm({ title: "Can't delete the last slide", body: "A deck needs at least one slide — delete the whole deck from the library instead.", confirmLabel: "OK" });
        return;
      }
      const ok = await host.confirm({
        title: `Delete slide ${i + 1}?`,
        body: "The slide is removed from the deck for the whole org. This can't be undone.",
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
      if ((slot.slideIdx ?? 0) >= i && (slot.slideIdx ?? 0) > 0) slot.slideIdx = (slot.slideIdx ?? 0) - 1;
      await mutateDeck(removeSlideAt, i);
    };

    const jobs: Array<{ host: HTMLElement; doc: string }> = [];
    for (let i = 0; i < total; i++) {
      const item = document.createElement("div");
      item.className = "gpoint-side-item" + (i === start ? " active" : "") + (spans[i]!.hidden ? " gpoint-hidden" : "");
      item.innerHTML = `<span class="gpoint-side-num">${i + 1}</span>` + (spans[i]!.hidden ? `<span class="gpoint-hidden-badge">hidden</span>` : "");
      item.addEventListener("click", () => {
        try {
          (frame.contentWindow as unknown as { __gpGoto?: (n: number) => void })?.__gpGoto?.(i);
        } catch { /* frame still loading — the rail highlights on the next report */ }
      });
      item.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openPopMenu(ev.clientX, ev.clientY, [
          { label: spans[i]!.hidden ? "Unhide" : "Hide", fn: () => void mutateDeck(toggleHiddenAt, i) },
          { label: "Delete…", danger: true, fn: () => void deleteSlideAt(i) },
        ]);
      });
      side.appendChild(item);
      jobs.push({ host: item, doc: staticDoc(html, i) });
    }
    fillThumbs(jobs);
  }

  return { renderIntoSlot, invalidate: (file) => { htmlCache.delete(file); } };
}
