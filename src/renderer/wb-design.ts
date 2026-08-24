/**
 * wb-design.ts — the GLYPHH DESIGN workbench panel: the org's design systems.
 *
 * Library → studio. The studio is shots.so-shaped: one big LIVE SHOT rendered
 * entirely FROM the document (gradient scene, sample app card in the system's
 * own surface/radius/shadow, type specimens in its fonts, the palette strip)
 * with a control rail beside it — Colors, Typography, Styles, Brand, Assets,
 * Sources. Every control mutates the in-memory document, repaints the shot,
 * and saves on a trailing debounce; the panel never re-renders the rails.
 *
 * The chrome is the WORKBENCH THEME (var(--accent) etc.) — the design being
 * edited paints ONLY inside the shot. Don't stray.
 */

import { officePager, officePage } from "./wb-office-ui.js";

// ── document shape (mirror of the SDK contract; structural, no import) ──────
interface DFont { family: string; fallback?: string; weights?: number[]; source?: string }
interface DColor { name: string; hex: string; role?: string }
interface DAsset { id: string; kind: string; title: string; contentType: string; sizeBytes: number }
interface DSource { type: string; ref: string; note?: string; extractedAt: string }
interface DImagery { assetId: string; kind: "image" | "video"; title: string; role?: string }
interface DesignDoc {
  version: 1;
  name: string;
  brand?: { tagline?: string; tone?: string[] };
  colors: { primary: string; accent?: string; background: string; surface?: string; text: string; muted?: string; palette?: DColor[] };
  fonts: { display: DFont; body: DFont; mono?: DFont };
  type?: { baseSize?: number; scale?: number; headingWeight?: number; letterSpacing?: number };
  styles?: { radius?: number; borderWidth?: number; shadow?: string; density?: string; gradient?: { from: string; to: string; angle?: number } };
  assets?: DAsset[];
  imagery?: DImagery[];
  canvas?: { rail?: number; view?: { x: number; y: number; scale: number }; items?: Record<string, { x: number; y: number; w?: number }> };
  sources?: DSource[];
}

export interface DesignMeta { file: string; title: string; size: number; mtime: number }

export interface DesignSlotState {
  id: number;
  file?: string;
  title?: string;
  page?: number;
}

export interface DesignHost {
  confirm: (opts: { title: string; body?: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>;
  icon: string;
}

const api = () => (window as unknown as { glyphh?: {
  designList?: () => Promise<{ ok: boolean; designs: DesignMeta[]; error?: string }>;
  designRead?: (file: string) => Promise<{ ok: boolean; title?: string; document?: unknown; error?: string }>;
  designWrite?: (file: string, document: unknown) => Promise<{ ok: boolean; file?: string; title?: string; error?: string }>;
  designDelete?: (file: string) => Promise<{ ok: boolean; error?: string }>;
  designAssetUpload?: (file: string, input: unknown) => Promise<{ ok: boolean; asset?: DAsset; error?: string }>;
  designAssetUrl?: (file: string, assetId: string) => Promise<{ ok: boolean; url?: string; error?: string }>;
  designAssetDelete?: (file: string, assetId: string) => Promise<{ ok: boolean; error?: string }>;
  mediaList?: (kind?: string, q?: string) => Promise<{ ok: boolean; assets: Array<{ id: string; kind: string; title: string; mime: string; status: string }>; error?: string }>;
  mediaUrl?: (id: string) => Promise<{ ok: boolean; url?: string; error?: string }>;
} }).glyphh ?? {};

const docCache = new Map<string, DesignDoc>();
async function loadDoc(file: string): Promise<DesignDoc | null> {
  const hit = docCache.get(file);
  if (hit) return hit;
  const res = await api().designRead?.(file);
  if (!res?.ok || !res.document) return null;
  const doc = res.document as DesignDoc;
  docCache.set(file, doc);
  return doc;
}

const SHADOWS: Record<string, string> = {
  none: "none",
  soft: "0 2px 10px rgba(0,0,0,0.10)",
  medium: "0 8px 28px rgba(0,0,0,0.18)",
  bold: "0 18px 50px rgba(0,0,0,0.30)",
};
const stack = (f: DFont | undefined, generic: string): string =>
  f ? `"${f.family}"${f.fallback ? `, "${f.fallback}"` : ""}, ${generic}` : generic;
const HEX_OK = /^#[0-9a-f]{6}$/i;

/** A fresh, tasteful starter system — the ＋New document. */
function starterDoc(name: string): DesignDoc {
  return {
    version: 1,
    name,
    brand: { tagline: "Your brand, everywhere your org builds.", tone: ["confident", "modern"] },
    colors: {
      primary: "#af5fff", accent: "#ec4899", background: "#0e0e12",
      surface: "#17171d", text: "#f5f5f7", muted: "#9a9aa4",
      palette: [
        { name: "Primary", hex: "#af5fff", role: "actions" },
        { name: "Accent", hex: "#ec4899", role: "highlights" },
        { name: "Success", hex: "#10b981", role: "positive" },
      ],
    },
    fonts: {
      display: { family: "Sora", fallback: "Helvetica Neue", weights: [600, 800], source: "google" },
      body: { family: "Inter", fallback: "Helvetica Neue", weights: [400, 600], source: "google" },
      mono: { family: "JetBrains Mono", fallback: "Menlo", source: "google" },
    },
    type: { baseSize: 16, scale: 1.25, headingWeight: 750, letterSpacing: -0.02 },
    styles: { radius: 14, borderWidth: 1, shadow: "medium", density: "comfortable", gradient: { from: "#af5fff", to: "#ec4899", angle: 135 } },
    sources: [{ type: "prompt", ref: "＋ New starter", extractedAt: new Date().toISOString() }],
  };
}

// ── the live SHOT — everything inside paints from the document ───────────────

function paintShot(shot: HTMLElement, d: DesignDoc): void {
  const c = d.colors;
  const st = d.styles ?? {};
  const grad = st.gradient;
  const radius = st.radius ?? 12;
  const heading = d.type?.headingWeight ?? 700;
  const ls = `${d.type?.letterSpacing ?? 0}em`;
  shot.style.background = grad
    ? `linear-gradient(${grad.angle ?? 135}deg, ${grad.from}, ${grad.to})`
    : c.primary;
  shot.innerHTML = `
    <div class="gdz-card">
      <div class="gdz-card-top">
        <span class="gdz-dot"></span><span class="gdz-dot"></span><span class="gdz-dot"></span>
      </div>
      <div class="gdz-kicker"></div>
      <h2 class="gdz-h"></h2>
      <p class="gdz-p"></p>
      <div class="gdz-btns">
        <button class="gdz-btn-primary" type="button">Get started</button>
        <button class="gdz-btn-ghost" type="button">Learn more</button>
      </div>
      <div class="gdz-swatches"></div>
    </div>
    <div class="gdz-specimen">
      <div class="gdz-spec-display">Aa</div>
      <div class="gdz-spec-meta"></div>
    </div>`;
  const card = shot.querySelector<HTMLElement>(".gdz-card")!;
  card.style.background = c.surface ?? c.background;
  card.style.color = c.text;
  card.style.borderRadius = `${radius + 4}px`;
  card.style.border = `${st.borderWidth ?? 1}px solid ${c.muted ?? c.text}33`;
  card.style.boxShadow = SHADOWS[st.shadow ?? "soft"] ?? SHADOWS.soft!;
  card.style.fontFamily = stack(d.fonts.body, "sans-serif");
  const kicker = shot.querySelector<HTMLElement>(".gdz-kicker")!;
  kicker.textContent = (d.brand?.tone?.length ? d.brand.tone.join(" · ") : d.name).toUpperCase();
  kicker.style.color = c.accent ?? c.primary;
  kicker.style.fontFamily = stack(d.fonts.mono ?? d.fonts.body, "monospace");
  const h = shot.querySelector<HTMLElement>(".gdz-h")!;
  h.textContent = d.brand?.tagline || d.name;
  h.style.fontFamily = stack(d.fonts.display, "sans-serif");
  h.style.fontWeight = String(heading);
  h.style.letterSpacing = ls;
  const p = shot.querySelector<HTMLElement>(".gdz-p")!;
  p.textContent = "This card is drawn by the system itself — surface, radius, shadow, type and color all come from the document.";
  p.style.color = c.muted ?? c.text;
  const btnP = shot.querySelector<HTMLElement>(".gdz-btn-primary")!;
  btnP.style.background = c.primary;
  btnP.style.color = c.background;
  btnP.style.borderRadius = `${radius}px`;
  btnP.style.fontFamily = stack(d.fonts.body, "sans-serif");
  const btnG = shot.querySelector<HTMLElement>(".gdz-btn-ghost")!;
  btnG.style.color = c.text;
  btnG.style.border = `1px solid ${c.muted ?? c.text}66`;
  btnG.style.borderRadius = `${radius}px`;
  btnG.style.fontFamily = stack(d.fonts.body, "sans-serif");
  shot.querySelectorAll<HTMLElement>(".gdz-dot").forEach((el, i) => {
    el.style.background = [c.primary, c.accent ?? c.primary, c.muted ?? c.text][i] ?? c.primary;
  });
  const swatches = shot.querySelector<HTMLElement>(".gdz-swatches")!;
  for (const sw of [
    { hex: c.primary }, ...(c.accent ? [{ hex: c.accent }] : []),
    ...(c.palette ?? []).filter((x) => x.hex !== c.primary && x.hex !== c.accent),
  ].slice(0, 8)) {
    const chip = document.createElement("span");
    chip.className = "gdz-swatch";
    chip.style.background = sw.hex;
    swatches.appendChild(chip);
  }
  const spec = shot.querySelector<HTMLElement>(".gdz-specimen")!;
  spec.style.background = `${c.background}cc`;
  spec.style.color = c.text;
  spec.style.borderRadius = `${radius}px`;
  const specD = shot.querySelector<HTMLElement>(".gdz-spec-display")!;
  specD.style.fontFamily = stack(d.fonts.display, "sans-serif");
  specD.style.fontWeight = String(heading);
  const specM = shot.querySelector<HTMLElement>(".gdz-spec-meta")!;
  specM.textContent = `${d.fonts.display.family} / ${d.fonts.body.family}`;
  specM.style.fontFamily = stack(d.fonts.body, "sans-serif");
  specM.style.color = c.muted ?? c.text;
}

// ── library thumbnails — palette + type, straight from the cached doc ────────

const thumbQueue = new Map<string, Array<(d: DesignDoc | null) => void>>();
export function mountDesignThumb(thumb: HTMLElement, file: string): void {
  const paint = (d: DesignDoc | null): void => {
    if (!d || !thumb.isConnected) return;
    const c = d.colors;
    const g = d.styles?.gradient;
    thumb.innerHTML = `
      <div class="gdz-thumb" style="background:${g ? `linear-gradient(${g.angle ?? 135}deg, ${g.from}, ${g.to})` : c.primary}">
        <div class="gdz-thumb-ag" style="color:${c.text};font-family:${stack(d.fonts.display, "sans-serif")};font-weight:${d.type?.headingWeight ?? 700}">Ag</div>
        <div class="gdz-thumb-row"></div>
      </div>`;
    const row = thumb.querySelector<HTMLElement>(".gdz-thumb-row")!;
    for (const sw of [c.primary, c.accent, c.surface ?? c.background, ...(c.palette ?? []).map((x) => x.hex)].filter((x): x is string => !!x).slice(0, 5)) {
      const chip = document.createElement("span");
      chip.style.background = sw;
      row.appendChild(chip);
    }
  };
  const cached = docCache.get(file);
  // Cache hits still defer — the card may not be attached yet (same detached-
  // node timing the doc thumbs hit).
  if (cached) { queueMicrotask(() => paint(cached)); return; }
  const waiting = thumbQueue.get(file);
  if (waiting) { waiting.push(paint); return; }
  thumbQueue.set(file, [paint]);
  void loadDoc(file).then((d) => {
    const fns = thumbQueue.get(file) ?? [];
    thumbQueue.delete(file);
    fns.forEach((fn) => fn(d));
  });
}
export function invalidateDesignThumb(file: string): void {
  docCache.delete(file);
}

// ── panel ────────────────────────────────────────────────────────────────────

export interface DesignPanel {
  renderIntoSlot: (body: HTMLElement, slot: DesignSlotState, wrap: HTMLElement) => Promise<void>;
  invalidate: (file: string) => void;
}

export function initDesign(host: DesignHost): DesignPanel {
  async function renderIntoSlot(body: HTMLElement, slot: DesignSlotState, wrap: HTMLElement): Promise<void> {
    try {
      await renderInner(body, slot, wrap);
    } catch (err) {
      console.warn("[gdesign] render failed:", err);
      if (body.isConnected) {
        body.innerHTML = `<div class="gdoc-empty">Design hit an error rendering.<br><code class="gpoint-err"></code></div>`;
        const code = body.querySelector(".gpoint-err");
        if (code) code.textContent = err instanceof Error ? err.message : String(err);
      }
    }
  }

  async function renderInner(body: HTMLElement, slot: DesignSlotState, wrap: HTMLElement): Promise<void> {
    body.classList.add("ws-gdesign-body");
    const refresh = (): void => { if (body.isConnected) void renderIntoSlot(body, slot, wrap); };
    const titleEl = wrap.querySelector(".ws-rail-slot-header .title");
    if (titleEl) titleEl.textContent = slot.file ? (slot.title || "Design") : "Design";
    if (!slot.file) { await renderLibrary(body, slot, refresh); return; }
    await renderStudio(body, slot, refresh);
  }

  // ── library ────────────────────────────────────────────────────────────────

  async function renderLibrary(body: HTMLElement, slot: DesignSlotState, refresh: () => void): Promise<void> {
    body.innerHTML = `
      <div class="gdoc-lib">
        <div class="office-toolbar">
          <input class="office-search" type="text" placeholder="Search designs…" spellcheck="false" autocomplete="off" />
          <button class="action-btn primary office-new">＋ New</button>
          <button class="ws-icon-btn office-refresh" title="Refresh">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.3"/><polyline points="21 3 21 9 15 9"/></svg>
          </button>
        </div>
        <div class="office-grid"></div>
        <div class="gdoc-empty hidden">No design systems yet.<br>＋ New starts one, or ask Glyphh — "extract our brand from acme.com".</div>
      </div>`;
    body.querySelector(".office-refresh")?.addEventListener("click", refresh);

    const openDesign = (m: { file: string; title: string }): void => {
      slot.file = m.file;
      slot.title = m.title;
      refresh();
    };

    body.querySelector(".office-new")?.addEventListener("click", () => {
      void (async () => {
        const list = await api().designList?.();
        const taken = new Set((list?.ok ? list.designs : []).map((m) => m.file));
        let stem = "untitled", n = 2;
        while (taken.has(`${stem}.json`)) stem = `untitled-${n++}`;
        const doc = starterDoc("Untitled");
        const w = await api().designWrite?.(stem, doc);
        if (!w?.ok) { void host.confirm({ title: "Couldn't create the design", body: w?.error || "Unknown error.", confirmLabel: "OK" }); return; }
        docCache.set(w.file || `${stem}.json`, doc);
        openDesign({ file: w.file || `${stem}.json`, title: w.title || "Untitled" });
      })();
    });

    const grid = body.querySelector<HTMLElement>(".office-grid")!;
    const empty = body.querySelector<HTMLElement>(".gdoc-empty");
    const res = await api().designList?.();
    if (!body.isConnected) return;
    if (!res || !Array.isArray(res.designs) || (!res.ok && !res.designs.length)) {
      if (empty) {
        empty.innerHTML = res && !res.ok ? `Couldn't load the library.<br>${res.error ?? "Unknown error."}` : "This surface has no design library.";
        empty.classList.remove("hidden");
      }
      return;
    }
    const designs = res.designs;
    const PER_PAGE = 18;
    const paint = (query: string): void => {
      grid.textContent = "";
      body.querySelector(".office-pager")?.remove();
      const q = query.toLowerCase();
      const matches = designs.filter((m) => !q || m.title.toLowerCase().includes(q) || m.file.toLowerCase().includes(q));
      empty?.classList.toggle("hidden", matches.length > 0 || designs.length === 0);
      if (!designs.length) empty?.classList.remove("hidden");
      const paged = officePage(matches, q ? 0 : (slot.page ?? 0), PER_PAGE);
      if (!q) slot.page = paged.page;
      const pager = officePager(matches.length, paged.page, PER_PAGE, (pg) => { slot.page = pg; paint(query); });
      if (pager && !q) grid.parentElement?.appendChild(pager);
      for (const m of paged.items) {
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
          <span class="gdrive-card-meta">design system</span>`;
        (card.querySelector(".gdrive-card-title") as HTMLElement).textContent = m.title || m.file;
        mountDesignThumb(card.querySelector<HTMLElement>(".gdrive-thumb")!, m.file);
        card.addEventListener("click", (ev) => {
          if ((ev.target as HTMLElement).closest(".office-card-kebab")) return;
          openDesign(m);
        });
        card.querySelector(".office-card-kebab")?.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
          popMenu(r.left, r.bottom + 4, [
            { label: "Open", fn: () => openDesign(m) },
            { label: "Delete…", danger: true, fn: () => {
              void (async () => {
                const yes = await host.confirm({ title: `Delete "${m.title || m.file}"?`, body: "This removes the design system and its assets for the whole org.", confirmLabel: "Delete", danger: true });
                if (!yes) return;
                await api().designDelete?.(m.file);
                docCache.delete(m.file);
                refresh();
              })();
            } },
          ]);
        });
        grid.appendChild(card);
      }
    };
    paint("");
    body.querySelector<HTMLInputElement>(".office-search")?.addEventListener("input", (ev) => {
      paint((ev.target as HTMLInputElement).value.trim());
    });
  }

  // ── studio ─────────────────────────────────────────────────────────────────

  async function renderStudio(body: HTMLElement, slot: DesignSlotState, refresh: () => void): Promise<void> {
    const file = slot.file!;
    const doc = await loadDoc(file);
    if (!body.isConnected) return;
    if (!doc) {
      body.innerHTML = `<div class="gdoc-empty">Couldn't load this design.<br><button class="action-btn gdz-back">‹ Designs</button></div>`;
      body.querySelector(".gdz-back")?.addEventListener("click", () => { delete slot.file; delete slot.title; refresh(); });
      return;
    }

    body.innerHTML = `
      <div class="gdz-studio">
        <div class="gdz-topbar">
          <button class="action-btn gdz-back">‹ Designs</button>
          <input class="gdz-name" spellcheck="false" autocomplete="off" />
          <span class="gdz-savestate" title="All changes save automatically"></span>
        </div>
        <div class="gdz-split">
          <div class="gdz-stage gdz-canvas">
            <div class="gdz-world">
              <div class="gdz-art" data-art="shot" style="left:0;top:0;width:560px"><div class="gdz-art-grip">Hero shot</div><div class="gdz-shot"></div></div>
              <div class="gdz-art" data-art="type" style="left:620px;top:0;width:360px"><div class="gdz-art-grip">Type specimen</div><div class="gdz-spec-sheet"></div></div>
              <div class="gdz-art" data-art="palette" style="left:620px;top:330px;width:360px"><div class="gdz-art-grip">Palette</div><div class="gdz-pal-sheet"></div></div>
              <div class="gdz-art" data-art="ui" style="left:0;top:460px;width:560px"><div class="gdz-art-grip">UI kit</div><div class="gdz-ui-sheet"></div></div>
            </div>
            <div class="gdz-canvas-hint">drag canvas pans · wheel zooms · drag a card's title to move it</div>
          </div>
          <div class="gdz-rail-grip" title="Drag to resize"></div>
          <div class="gdz-rail"></div>
        </div>
      </div>`;
    body.querySelector(".gdz-back")?.addEventListener("click", () => { delete slot.file; delete slot.title; refresh(); });

    const rail = body.querySelector<HTMLElement>(".gdz-rail")!;
    // The rail is DRAGGABLE: grab the grip, resize; the width persists.
    if (doc.canvas?.rail) rail.style.width = `${doc.canvas.rail}px`;
    const grip = body.querySelector<HTMLElement>(".gdz-rail-grip");
    if (grip) {
      let railDrag: { x: number; w: number } | null = null;
      grip.addEventListener("mousedown", (ev) => {
        railDrag = { x: ev.clientX, w: rail.getBoundingClientRect().width };
        ev.preventDefault();
      });
      window.addEventListener("mousemove", (ev) => {
        if (!railDrag) return;
        const w = Math.min(560, Math.max(220, railDrag.w - (ev.clientX - railDrag.x)));
        rail.style.width = `${w}px`;
      });
      window.addEventListener("mouseup", () => {
        if (!railDrag) return;
        railDrag = null;
        doc.canvas ??= {};
        doc.canvas.rail = Math.round(rail.getBoundingClientRect().width);
        touched();
      });
    }
    const saveState = body.querySelector<HTMLElement>(".gdz-savestate")!;
    const nameInput = body.querySelector<HTMLInputElement>(".gdz-name")!;
    nameInput.value = doc.name;

    // Local-first: mutate → repaint the shot → trailing save. Never a rebuild.
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    let saving = false, dirtyWhileSaving = false;
    const save = async (): Promise<void> => {
      if (saving) { dirtyWhileSaving = true; return; }
      saving = true;
      saveState.textContent = "Saving…";
      const res = await api().designWrite?.(file, doc);
      saving = false;
      saveState.textContent = res?.ok ? "Saved" : `⚠ ${res?.error ?? "save failed"}`;
      if (res?.ok) { slot.title = res.title || doc.name; const t = document.querySelector(".ws-rail-slot-header .title"); void t; }
      if (dirtyWhileSaving) { dirtyWhileSaving = false; void save(); }
    };
    const touched = (): void => {
      paintAll(body, doc, file);
      saveState.textContent = "…";
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { void save(); }, 700);
    };
    nameInput.addEventListener("change", () => {
      doc.name = nameInput.value.trim() || doc.name;
      nameInput.value = doc.name;
      touched();
    });

    paintAll(body, doc, file);
    wireCanvas(body.querySelector<HTMLElement>(".gdz-canvas")!, body.querySelector<HTMLElement>(".gdz-world")!, doc, touched);
    buildRail(rail, doc, file, touched);
    body.addEventListener("gdz-imagery-changed", () => touched());
  }

  // ── the canvas + its artifacts ─────────────────────────────────────────────

  function paintAll(body: HTMLElement, doc: DesignDoc, file: string): void {
    const world = body.querySelector<HTMLElement>(".gdz-world");
    if (world) { paintImagery(world, doc); paintUploadCards(world, doc, file); }
    const shot = body.querySelector<HTMLElement>(".gdz-shot");
    if (shot) paintShot(shot, doc);
    const spec = body.querySelector<HTMLElement>(".gdz-spec-sheet");
    if (spec) paintTypeSheet(spec, doc);
    const pal = body.querySelector<HTMLElement>(".gdz-pal-sheet");
    if (pal) paintPaletteSheet(pal, doc);
    const ui = body.querySelector<HTMLElement>(".gdz-ui-sheet");
    if (ui) paintUiSheet(ui, doc);
  }

  function paintTypeSheet(el: HTMLElement, d: DesignDoc): void {
    const c = d.colors;
    const w = d.type?.headingWeight ?? 700;
    const scale = d.type?.scale ?? 1.25;
    const base = d.type?.baseSize ?? 16;
    el.style.background = c.surface ?? c.background;
    el.style.color = c.text;
    el.innerHTML = "";
    const sizes = [3, 2, 1, 0].map((n) => Math.round(base * Math.pow(scale, n)));
    sizes.forEach((px, i) => {
      const row = document.createElement("div");
      row.className = "gdz-spec-row";
      row.style.fontFamily = stack(i < 3 ? d.fonts.display : d.fonts.body, "sans-serif");
      row.style.fontWeight = i < 3 ? String(w) : "400";
      row.style.fontSize = `${px}px`;
      row.textContent = i < 3 ? "The quick brown fox" : "Body — the quick brown fox jumps over the lazy dog, 0123456789.";
      const tag = document.createElement("span");
      tag.className = "gdz-spec-tag";
      tag.style.color = c.muted ?? c.text;
      tag.textContent = `${px}px`;
      row.prepend(tag);
      el.appendChild(row);
    });
    if (d.fonts.mono) {
      const mono = document.createElement("div");
      mono.className = "gdz-spec-row";
      mono.style.fontFamily = stack(d.fonts.mono, "monospace");
      mono.style.fontSize = `${Math.max(11, base - 3)}px`;
      mono.style.color = c.muted ?? c.text;
      mono.textContent = "mono · const brand = { ready: true };";
      el.appendChild(mono);
    }
  }

  function paintPaletteSheet(el: HTMLElement, d: DesignDoc): void {
    const c = d.colors;
    el.style.background = c.surface ?? c.background;
    el.innerHTML = "";
    const entries: DColor[] = [
      { name: "Primary", hex: c.primary, role: "actions" },
      ...(c.accent ? [{ name: "Accent", hex: c.accent, role: "highlights" }] : []),
      { name: "Background", hex: c.background },
      ...(c.surface ? [{ name: "Surface", hex: c.surface }] : []),
      { name: "Text", hex: c.text },
      ...(c.muted ? [{ name: "Muted", hex: c.muted }] : []),
      ...(c.palette ?? []),
    ];
    for (const sw of entries.slice(0, 12)) {
      const row = document.createElement("div");
      row.className = "gdz-pal-swatch";
      row.innerHTML = `<i></i><b></b><em></em><u></u>`;
      (row.querySelector("i") as HTMLElement).style.background = sw.hex;
      (row.querySelector("b") as HTMLElement).textContent = sw.name;
      (row.querySelector("b") as HTMLElement).style.color = c.text;
      (row.querySelector("em") as HTMLElement).textContent = sw.hex;
      (row.querySelector("em") as HTMLElement).style.color = c.muted ?? c.text;
      (row.querySelector("u") as HTMLElement).textContent = sw.role ?? "";
      (row.querySelector("u") as HTMLElement).style.color = c.muted ?? c.text;
      el.appendChild(row);
    }
  }

  function paintUiSheet(el: HTMLElement, d: DesignDoc): void {
    const c = d.colors;
    const st = d.styles ?? {};
    const radius = st.radius ?? 12;
    el.style.background = c.background;
    el.style.color = c.text;
    el.style.fontFamily = stack(d.fonts.body, "sans-serif");
    el.innerHTML = `
      <div class="gdz-ui-row">
        <button type="button" class="gdz-ui-primary">Primary</button>
        <button type="button" class="gdz-ui-secondary">Secondary</button>
        <button type="button" class="gdz-ui-ghost">Ghost</button>
        <span class="gdz-ui-chip">chip</span>
      </div>
      <div class="gdz-ui-row">
        <input type="text" class="gdz-ui-input" value="An input" readonly />
        <span class="gdz-ui-toggle"><i></i></span>
      </div>
      <div class="gdz-ui-card">
        <b>Card title</b>
        <span>Surface, border, radius and shadow — all the system's.</span>
      </div>`;
    const r = `${radius}px`;
    const shadow = SHADOWS[st.shadow ?? "soft"] ?? "none";
    const q = <T extends HTMLElement>(sel: string): T => el.querySelector(sel) as T;
    const primary = q<HTMLElement>(".gdz-ui-primary");
    primary.style.cssText = `background:${c.primary};color:${c.background};border:none;border-radius:${r};padding:7px 16px;font-weight:600;font-family:inherit`;
    q<HTMLElement>(".gdz-ui-secondary").style.cssText = `background:${c.accent ?? c.primary}22;color:${c.text};border:1px solid ${c.accent ?? c.primary};border-radius:${r};padding:7px 16px;font-family:inherit`;
    q<HTMLElement>(".gdz-ui-ghost").style.cssText = `background:none;color:${c.text};border:1px solid ${c.muted ?? c.text}55;border-radius:${r};padding:7px 16px;font-family:inherit`;
    q<HTMLElement>(".gdz-ui-chip").style.cssText = `background:${c.surface ?? c.background};color:${c.muted ?? c.text};border:1px solid ${c.muted ?? c.text}44;border-radius:100px;padding:4px 12px;font-size:12px`;
    q<HTMLElement>(".gdz-ui-input").style.cssText = `background:${c.surface ?? c.background};color:${c.text};border:1px solid ${c.muted ?? c.text}55;border-radius:${r};padding:7px 12px;flex:1;font-family:inherit`;
    q<HTMLElement>(".gdz-ui-toggle").style.cssText = `background:${c.primary};border-radius:100px;width:38px;height:22px;display:inline-flex;align-items:center;justify-content:flex-end;padding:2px`;
    (q<HTMLElement>(".gdz-ui-toggle").querySelector("i") as HTMLElement).style.cssText = `width:18px;height:18px;border-radius:50%;background:${c.background};display:block`;
    q<HTMLElement>(".gdz-ui-card").style.cssText = `background:${c.surface ?? c.background};border:1px solid ${c.muted ?? c.text}33;border-radius:${r}px;box-shadow:${shadow};padding:14px 16px;display:flex;flex-direction:column;gap:5px`;
    q<HTMLElement>(".gdz-ui-card").style.borderRadius = r;
  }

  /** Canvas physics: wheel zooms toward the cursor, dragging empty canvas
   *  pans, dragging a card's grip moves that card in world space. The VIEW
   *  and every card's coords persist onto the document (debounced). */
  function wireCanvas(stage: HTMLElement, world: HTMLElement, doc: DesignDoc, touched: () => void): void {
    doc.canvas ??= {};
    const v = doc.canvas.view;
    let scale = v?.scale ?? 0.9, tx = v?.x ?? 40, ty = v?.y ?? 30;
    const apply = (): void => { world.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`; };
    apply();
    // Saved coords land on their cards (built-ins + imagery share the keying).
    const applySaved = (): void => {
      for (const el of world.querySelectorAll<HTMLElement>(".gdz-art")) {
        const key = el.dataset.assetId ? `img:${el.dataset.assetId}` : (el.dataset.art ?? "");
        const pos = doc.canvas?.items?.[key];
        if (pos) {
          el.style.left = `${pos.x}px`;
          el.style.top = `${pos.y}px`;
          if (pos.w) el.style.width = `${pos.w}px`;
        }
      }
    };
    applySaved();
    new MutationObserver(applySaved).observe(world, { childList: true });

    let viewTimer: ReturnType<typeof setTimeout> | null = null;
    const persistView = (): void => {
      if (viewTimer) clearTimeout(viewTimer);
      viewTimer = setTimeout(() => {
        doc.canvas ??= {};
        doc.canvas.view = { x: Math.round(tx), y: Math.round(ty), scale: Math.round(scale * 100) / 100 };
        touched();
      }, 500);
    };
    stage.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      const rect = stage.getBoundingClientRect();
      const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
      const next = Math.min(2.5, Math.max(0.25, scale * (ev.deltaY > 0 ? 0.92 : 1 / 0.92)));
      tx = px - ((px - tx) / scale) * next;
      ty = py - ((py - ty) / scale) * next;
      scale = next;
      apply();
      persistView();
    }, { passive: false });
    // EVERY canvas item drags on its own — grab a card ANYWHERE (not just the
    // grip) and only that card moves; the empty stage pans the view. The
    // corner handle resizes (width; images keep their aspect).
    let drag: { x: number; y: number; art?: HTMLElement; ax?: number; ay?: number; aw?: number; resize?: boolean } | null = null;
    stage.addEventListener("mousedown", (ev) => {
      const target = ev.target as HTMLElement;
      const rz = target.closest<HTMLElement>(".gdz-art-resize");
      const art = target.closest<HTMLElement>(".gdz-art") ?? undefined;
      if (!rz && target.closest("input, button, select, textarea")) return;
      drag = art
        ? {
            x: ev.clientX, y: ev.clientY, art,
            ax: parseFloat(art.style.left) || 0,
            ay: parseFloat(art.style.top) || 0,
            aw: parseFloat(art.style.width) || art.offsetWidth,
            resize: !!rz,
          }
        : { x: ev.clientX, y: ev.clientY };
      ev.preventDefault();
    });
    const onMove = (ev: MouseEvent): void => {
      if (!drag) return;
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (drag.art && drag.resize) {
        drag.art.style.width = `${Math.max(160, Math.min(2400, (drag.aw ?? 560) + dx / scale))}px`;
      } else if (drag.art) {
        drag.art.style.left = `${(drag.ax ?? 0) + dx / scale}px`;
        drag.art.style.top = `${(drag.ay ?? 0) + dy / scale}px`;
      } else {
        tx += dx; ty += dy;
        drag.x = ev.clientX; drag.y = ev.clientY;
        apply();
      }
    };
    const onUp = (): void => {
      if (drag?.art) {
        // The card came to rest — its coords join the document.
        const el = drag.art;
        const key = el.dataset.assetId ? `img:${el.dataset.assetId}` : (el.dataset.art ?? "");
        if (key) {
          doc.canvas ??= {};
          doc.canvas.items ??= {};
          doc.canvas.items[key] = {
            x: Math.round(parseFloat(el.style.left) || 0),
            y: Math.round(parseFloat(el.style.top) || 0),
            ...(el.style.width ? { w: Math.round(parseFloat(el.style.width)) } : {}),
          };
          touched();
        }
      } else if (drag) {
        persistView();
      }
      drag = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  /** Imagery cards on the canvas — one draggable artifact per adopted media
   *  asset, laid out below the built-in sheets; removal lives on the grip. */
  function paintImagery(world: HTMLElement, doc: DesignDoc): void {
    const want = new Set((doc.imagery ?? []).map((m) => m.assetId));
    world.querySelectorAll<HTMLElement>(".gdz-art-imagery").forEach((el) => {
      if (!want.has(el.dataset.assetId ?? "")) el.remove();
    });
    (doc.imagery ?? []).forEach((m, i) => {
      if (world.querySelector(`.gdz-art-imagery[data-asset-id="${m.assetId}"]`)) return;
      const card = document.createElement("div");
      card.className = "gdz-art gdz-art-imagery";
      card.dataset.assetId = m.assetId;
      card.style.left = `${(i % 2) * 620}px`;
      card.style.top = `${760 + Math.floor(i / 2) * 300}px`;
      card.style.width = "560px";
      card.innerHTML = `
        <div class="gdz-art-grip"><span class="gdz-img-role"></span><button class="ws-icon-btn gdz-img-x" title="Remove from the system">✕</button></div>
        <div class="gdz-img-frame"></div>
        <span class="gdz-art-resize" title="Resize"></span>`;
      (card.querySelector(".gdz-img-role") as HTMLElement).textContent = `${m.title}${m.role ? ` · ${m.role}` : ""}`;
      const removeFromDesign = (): void => {
        doc.imagery = (doc.imagery ?? []).filter((x) => x.assetId !== m.assetId);
        if (!doc.imagery.length) delete doc.imagery;
        // The saved canvas position goes with it — a re-adopted asset starts fresh.
        delete doc.canvas?.items?.[`img:${m.assetId}`];
        card.dispatchEvent(new CustomEvent("gdz-imagery-changed", { bubbles: true }));
        card.remove();
      };
      card.querySelector(".gdz-img-x")?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        removeFromDesign();
      });
      card.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        popMenu(ev.clientX, ev.clientY, [
          { label: "Remove from design", danger: true, fn: removeFromDesign },
        ]);
      });
      const frame = card.querySelector<HTMLElement>(".gdz-img-frame")!;
      void api().mediaUrl?.(m.assetId).then((r) => {
        if (!r?.ok || !r.url || !frame.isConnected) { frame.textContent = "unavailable"; return; }
        if (m.kind === "video") {
          const v = document.createElement("video");
          v.src = r.url; v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true;
          frame.appendChild(v);
        } else {
          const img = document.createElement("img");
          img.src = r.url;
          frame.appendChild(img);
        }
      });
      world.appendChild(card);
    });
  }

  /** Uploaded design assets are canvas citizens too — one draggable card per
   *  upload, keyed `asset:<id>` in canvas.items (data-art carries the key).
   *  Removal lives in the Uploads modal (it deletes the upload itself). */
  function paintUploadCards(world: HTMLElement, doc: DesignDoc, file: string): void {
    const want = new Set((doc.assets ?? []).map((a) => a.id));
    world.querySelectorAll<HTMLElement>(".gdz-art-upload").forEach((el) => {
      if (!want.has(el.dataset.uploadId ?? "")) el.remove();
    });
    (doc.assets ?? []).forEach((a, i) => {
      if (world.querySelector(`.gdz-art-upload[data-upload-id="${a.id}"]`)) return;
      const card = document.createElement("div");
      card.className = "gdz-art gdz-art-imagery gdz-art-upload";
      card.dataset.art = `asset:${a.id}`;
      card.dataset.uploadId = a.id;
      card.style.left = `${(i % 2) * 620}px`;
      card.style.top = `${2160 + Math.floor(i / 2) * 300}px`;
      card.style.width = "560px";
      card.innerHTML = `
        <div class="gdz-art-grip"><span class="gdz-img-role"></span></div>
        <div class="gdz-img-frame"></div>
        <span class="gdz-art-resize" title="Resize"></span>`;
      (card.querySelector(".gdz-img-role") as HTMLElement).textContent = `${a.title} · upload`;
      card.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        popMenu(ev.clientX, ev.clientY, [
          { label: "Remove from design", danger: true, fn: () => {
            void (async () => {
              const yes = await host.confirm({ title: `Remove "${a.title}"?`, body: "Deletes the upload from the system and the canvas.", confirmLabel: "Remove", danger: true });
              if (!yes) return;
              await api().designAssetDelete?.(file, a.id);
              doc.assets = (doc.assets ?? []).filter((x) => x.id !== a.id);
              if (!doc.assets.length) delete doc.assets;
              delete doc.canvas?.items?.[`asset:${a.id}`];
              card.dispatchEvent(new CustomEvent("gdz-imagery-changed", { bubbles: true }));
              card.remove();
            })();
          } },
        ]);
      });
      const frame = card.querySelector<HTMLElement>(".gdz-img-frame")!;
      void api().designAssetUrl?.(file, a.id).then((r) => {
        if (!r?.ok || !r.url || !frame.isConnected) { frame.textContent = "unavailable"; return; }
        const img = document.createElement("img");
        img.src = r.url;
        frame.appendChild(img);
      });
      world.appendChild(card);
    });
  }

  // ── centered modal — Uploads / Imagery / Sources browse here: room to SEE
  //    the images, an expand toggle, and pagination. One at a time. ──────────

  function gdzModal(title: string): { body: HTMLElement; close: () => void } {
    document.querySelectorAll(".gdz-modal-veil").forEach((el) => el.remove());
    const veil = document.createElement("div");
    veil.className = "gdz-modal-veil";
    veil.innerHTML = `
      <div class="gdz-modal">
        <div class="gdz-modal-head">
          <span class="gdz-modal-title"></span>
          <span class="gdz-modal-tools">
            <button class="ws-icon-btn gdz-modal-grow" title="Expand">⤢</button>
            <button class="ws-icon-btn gdz-modal-x" title="Close">✕</button>
          </span>
        </div>
        <div class="gdz-modal-body"></div>
      </div>`;
    (veil.querySelector(".gdz-modal-title") as HTMLElement).textContent = title;
    const onKey = (ev: KeyboardEvent): void => { if (ev.key === "Escape") close(); };
    const close = (): void => { veil.remove(); document.removeEventListener("keydown", onKey); };
    veil.addEventListener("mousedown", (ev) => { if (ev.target === veil) close(); });
    veil.querySelector(".gdz-modal-x")?.addEventListener("click", close);
    veil.querySelector(".gdz-modal-grow")?.addEventListener("click", () => {
      veil.querySelector(".gdz-modal")?.classList.toggle("expanded");
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(veil);
    return { body: veil.querySelector<HTMLElement>(".gdz-modal-body")!, close };
  }

  /** Modal scaffold: a search box that survives repaints + grid + pager. */
  function modalGrid(body: HTMLElement, placeholder: string, paint: (q: string, page: number, grid: HTMLElement, foot: HTMLElement, go: (p: number) => void) => void): () => void {
    body.textContent = "";
    const search = document.createElement("input");
    search.className = "office-search gdz-modal-search";
    search.type = "text";
    search.placeholder = placeholder;
    search.spellcheck = false;
    const grid = document.createElement("div");
    grid.className = "gdz-modal-grid";
    const foot = document.createElement("div");
    foot.className = "gdz-modal-foot";
    body.append(search, grid, foot);
    let page = 0;
    const go = (p: number): void => { page = p; repaint(); };
    const repaint = (): void => {
      grid.textContent = "";
      foot.textContent = "";
      paint(search.value.trim().toLowerCase(), page, grid, foot, go);
    };
    search.addEventListener("input", () => { page = 0; repaint(); });
    repaint();
    search.focus();
    return repaint;
  }

  // ── the control rail ───────────────────────────────────────────────────────

  function section(rail: HTMLElement, title: string, open = true): HTMLElement {
    const sec = document.createElement("details");
    sec.className = "gdz-sec";
    sec.open = open;
    sec.innerHTML = `<summary>${title}</summary><div class="gdz-sec-body"></div>`;
    rail.appendChild(sec);
    return sec.querySelector<HTMLElement>(".gdz-sec-body")!;
  }

  function colorRow(parent: HTMLElement, label: string, get: () => string | undefined, set: (v: string | undefined) => void, clearable = false): void {
    const row = document.createElement("div");
    row.className = "gdz-row";
    row.innerHTML = `
      <span class="gdz-row-label">${label}</span>
      <input type="color" class="gdz-color" />
      <input type="text" class="gdz-hex" spellcheck="false" maxlength="7" />
      ${clearable ? '<button class="ws-icon-btn gdz-clear" title="Unset">✕</button>' : ""}`;
    const colorIn = row.querySelector<HTMLInputElement>(".gdz-color")!;
    const hexIn = row.querySelector<HTMLInputElement>(".gdz-hex")!;
    const paint = (): void => {
      const v = get();
      colorIn.value = v && HEX_OK.test(v) ? v : "#000000";
      hexIn.value = v ?? "";
      row.classList.toggle("unset", !v);
    };
    colorIn.addEventListener("input", () => { set(colorIn.value); paint(); });
    hexIn.addEventListener("change", () => {
      const v = hexIn.value.trim().toLowerCase();
      if (HEX_OK.test(v)) set(v);
      paint();
    });
    row.querySelector(".gdz-clear")?.addEventListener("click", () => { set(undefined); paint(); });
    parent.appendChild(row);
    paint();
  }

  function sliderRow(parent: HTMLElement, label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void): void {
    const row = document.createElement("div");
    row.className = "gdz-row";
    row.innerHTML = `
      <span class="gdz-row-label">${label}</span>
      <input type="range" class="gdz-range" min="${min}" max="${max}" step="${step}" />
      <span class="gdz-range-val"></span>`;
    const range = row.querySelector<HTMLInputElement>(".gdz-range")!;
    const val = row.querySelector<HTMLElement>(".gdz-range-val")!;
    const paint = (): void => { range.value = String(get()); val.textContent = String(get()); };
    range.addEventListener("input", () => { set(Number(range.value)); val.textContent = range.value; });
    parent.appendChild(row);
    paint();
  }

  function selectRow(parent: HTMLElement, label: string, options: string[], get: () => string, set: (v: string) => void): void {
    const row = document.createElement("div");
    row.className = "gdz-row";
    row.innerHTML = `<span class="gdz-row-label">${label}</span><select class="gdz-select"></select>`;
    const sel = row.querySelector<HTMLSelectElement>(".gdz-select")!;
    for (const o of options) {
      const opt = document.createElement("option");
      opt.value = o; opt.textContent = o;
      sel.appendChild(opt);
    }
    sel.value = get();
    sel.addEventListener("change", () => set(sel.value));
    parent.appendChild(row);
  }

  const CURATED_FONTS = [
    "Inter", "Sora", "Space Grotesk", "Manrope", "Outfit", "DM Sans", "Plus Jakarta Sans",
    "Playfair Display", "Fraunces", "Lora", "Source Serif 4",
    "IBM Plex Sans", "IBM Plex Serif", "JetBrains Mono", "IBM Plex Mono", "Space Mono",
    "Helvetica Neue", "Georgia", "Menlo",
  ];

  function fontRow(parent: HTMLElement, label: string, get: () => DFont | undefined, set: (f: DFont) => void): void {
    const row = document.createElement("div");
    row.className = "gdz-row";
    const listId = `gdz-fonts-${Math.random().toString(36).slice(2, 8)}`;
    row.innerHTML = `
      <span class="gdz-row-label">${label}</span>
      <input type="text" class="gdz-font" list="${listId}" spellcheck="false" />
      <datalist id="${listId}">${CURATED_FONTS.map((f) => `<option value="${f}">`).join("")}</datalist>`;
    const input = row.querySelector<HTMLInputElement>(".gdz-font")!;
    input.value = get()?.family ?? "";
    input.style.fontFamily = stack(get(), "sans-serif");
    input.addEventListener("change", () => {
      const family = input.value.trim();
      if (!family) { input.value = get()?.family ?? ""; return; }
      const cur = get();
      set({ ...(cur ?? {}), family });
      input.style.fontFamily = stack(get(), "sans-serif");
    });
    parent.appendChild(row);
  }

  function chipsRow(parent: HTMLElement, get: () => string[], set: (v: string[]) => void, placeholder: string): void {
    const wrap = document.createElement("div");
    wrap.className = "gdz-chips";
    const paint = (): void => {
      wrap.textContent = "";
      for (const [i, word] of get().entries()) {
        const chip = document.createElement("span");
        chip.className = "gdz-chip";
        chip.textContent = word;
        const x = document.createElement("button");
        x.textContent = "✕";
        x.addEventListener("click", () => { const next = [...get()]; next.splice(i, 1); set(next); paint(); });
        chip.appendChild(x);
        wrap.appendChild(chip);
      }
      const input = document.createElement("input");
      input.className = "gdz-chip-input";
      input.placeholder = placeholder;
      input.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter") return;
        const v = input.value.trim();
        if (v) { set([...get(), v]); paint(); }
      });
      wrap.appendChild(input);
    };
    parent.appendChild(wrap);
    paint();
  }

  function buildRail(rail: HTMLElement, doc: DesignDoc, file: string, touched: () => void): void {
    rail.textContent = "";

    // — Colors —
    const colors = section(rail, "Colors");
    const c = doc.colors;
    colorRow(colors, "Primary", () => c.primary, (v) => { if (v) c.primary = v; touched(); });
    colorRow(colors, "Accent", () => c.accent, (v) => { if (v === undefined) delete c.accent; else c.accent = v; touched(); }, true);
    colorRow(colors, "Background", () => c.background, (v) => { if (v) c.background = v; touched(); });
    colorRow(colors, "Surface", () => c.surface, (v) => { if (v === undefined) delete c.surface; else c.surface = v; touched(); }, true);
    colorRow(colors, "Text", () => c.text, (v) => { if (v) c.text = v; touched(); });
    colorRow(colors, "Muted", () => c.muted, (v) => { if (v === undefined) delete c.muted; else c.muted = v; touched(); }, true);

    const palWrap = document.createElement("div");
    palWrap.className = "gdz-palette";
    colors.appendChild(palWrap);
    const paintPalette = (): void => {
      palWrap.textContent = "";
      const head = document.createElement("div");
      head.className = "gdz-pal-head";
      head.innerHTML = `<span>Palette</span><button class="ws-icon-btn gdz-pal-add" title="Add color">＋</button>`;
      head.querySelector(".gdz-pal-add")?.addEventListener("click", () => {
        c.palette = [...(c.palette ?? []), { name: `Color ${(c.palette?.length ?? 0) + 1}`, hex: c.primary }];
        touched(); paintPalette();
      });
      palWrap.appendChild(head);
      for (const [i, entry] of (c.palette ?? []).entries()) {
        const row = document.createElement("div");
        row.className = "gdz-pal-row";
        row.innerHTML = `
          <input type="color" class="gdz-color" value="${HEX_OK.test(entry.hex) ? entry.hex : "#000000"}" />
          <input type="text" class="gdz-pal-name" spellcheck="false" />
          <input type="text" class="gdz-pal-role" spellcheck="false" placeholder="role" />
          <button class="ws-icon-btn gdz-pal-x" title="Remove">✕</button>`;
        const [colorIn, nameIn, roleIn] = [
          row.querySelector<HTMLInputElement>(".gdz-color")!,
          row.querySelector<HTMLInputElement>(".gdz-pal-name")!,
          row.querySelector<HTMLInputElement>(".gdz-pal-role")!,
        ];
        nameIn.value = entry.name;
        roleIn.value = entry.role ?? "";
        colorIn.addEventListener("input", () => { entry.hex = colorIn.value; touched(); });
        nameIn.addEventListener("change", () => { entry.name = nameIn.value.trim() || entry.name; touched(); });
        roleIn.addEventListener("change", () => {
          const v = roleIn.value.trim();
          if (v) entry.role = v; else delete entry.role;
          touched();
        });
        row.querySelector(".gdz-pal-x")?.addEventListener("click", () => {
          c.palette?.splice(i, 1);
          if (!c.palette?.length) delete c.palette;
          touched(); paintPalette();
        });
        palWrap.appendChild(row);
      }
    };
    paintPalette();

    // — Typography —
    const type = section(rail, "Typography");
    fontRow(type, "Display", () => doc.fonts.display, (f) => { doc.fonts.display = f; touched(); });
    fontRow(type, "Body", () => doc.fonts.body, (f) => { doc.fonts.body = f; touched(); });
    fontRow(type, "Mono", () => doc.fonts.mono, (f) => { doc.fonts.mono = f; touched(); });
    doc.type ??= {};
    sliderRow(type, "Heading weight", 300, 900, 50, () => doc.type?.headingWeight ?? 700, (v) => { doc.type!.headingWeight = v; touched(); });
    sliderRow(type, "Base size", 12, 22, 1, () => doc.type?.baseSize ?? 16, (v) => { doc.type!.baseSize = v; touched(); });
    sliderRow(type, "Scale", 1.1, 1.5, 0.05, () => doc.type?.scale ?? 1.25, (v) => { doc.type!.scale = Math.round(v * 100) / 100; touched(); });

    // — Styles —
    const styles = section(rail, "Styles");
    doc.styles ??= {};
    const st = doc.styles;
    sliderRow(styles, "Radius", 0, 32, 1, () => st.radius ?? 12, (v) => { st.radius = v; touched(); });
    sliderRow(styles, "Border", 0, 4, 1, () => st.borderWidth ?? 1, (v) => { st.borderWidth = v; touched(); });
    selectRow(styles, "Shadow", ["none", "soft", "medium", "bold"], () => st.shadow ?? "soft", (v) => { st.shadow = v; touched(); });
    selectRow(styles, "Density", ["compact", "comfortable", "spacious"], () => st.density ?? "comfortable", (v) => { st.density = v; touched(); });
    const gradOn = document.createElement("div");
    gradOn.className = "gdz-row";
    gradOn.innerHTML = `<span class="gdz-row-label">Gradient</span><input type="checkbox" class="gdz-grad-on" />`;
    const gradBox = document.createElement("div");
    gradBox.className = "gdz-grad-box";
    const gradToggle = gradOn.querySelector<HTMLInputElement>(".gdz-grad-on")!;
    const paintGrad = (): void => {
      gradToggle.checked = !!st.gradient;
      gradBox.textContent = "";
      gradBox.classList.toggle("hidden", !st.gradient);
      if (!st.gradient) return;
      const g = st.gradient;
      colorRow(gradBox, "From", () => g.from, (v) => { if (v) g.from = v; touched(); });
      colorRow(gradBox, "To", () => g.to, (v) => { if (v) g.to = v; touched(); });
      sliderRow(gradBox, "Angle", 0, 360, 5, () => g.angle ?? 135, (v) => { g.angle = v; touched(); });
    };
    gradToggle.addEventListener("change", () => {
      if (gradToggle.checked) st.gradient = { from: c.primary, to: c.accent ?? c.primary, angle: 135 };
      else delete st.gradient;
      touched(); paintGrad();
    });
    styles.appendChild(gradOn);
    styles.appendChild(gradBox);
    paintGrad();

    // — Brand —
    const brand = section(rail, "Brand", false);
    doc.brand ??= {};
    const tagRow = document.createElement("div");
    tagRow.className = "gdz-row gdz-row-wide";
    tagRow.innerHTML = `<span class="gdz-row-label">Tagline</span><input type="text" class="gdz-tagline" spellcheck="false" />`;
    const tagIn = tagRow.querySelector<HTMLInputElement>(".gdz-tagline")!;
    tagIn.value = doc.brand.tagline ?? "";
    tagIn.addEventListener("change", () => {
      const v = tagIn.value.trim();
      if (v) doc.brand!.tagline = v; else delete doc.brand!.tagline;
      touched();
    });
    brand.appendChild(tagRow);
    const toneLabel = document.createElement("div");
    toneLabel.className = "gdz-pal-head";
    toneLabel.innerHTML = "<span>Tone</span>";
    brand.appendChild(toneLabel);
    chipsRow(brand, () => doc.brand?.tone ?? [], (v) => {
      if (v.length) doc.brand!.tone = v; else delete doc.brand!.tone;
      touched();
    }, "add a tone word…");

    // — Assets — uploads browse in a CENTERED MODAL (room to actually see
    //   them, expandable, paginated); every upload also lands on the canvas
    //   as its own draggable card (paintUploadCards via touched).
    const assets = section(rail, "Assets", false);
    const upBtn = document.createElement("button");
    upBtn.className = "action-btn gdz-asset-up";
    upBtn.textContent = "＋ Upload image";
    const fileIn = document.createElement("input");
    fileIn.type = "file";
    fileIn.accept = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml";
    fileIn.style.display = "none";
    upBtn.addEventListener("click", () => fileIn.click());
    const browseUp = document.createElement("button");
    browseUp.className = "action-btn gdz-source-add";
    const paintUpCount = (): void => { browseUp.textContent = `Browse uploads (${(doc.assets ?? []).length})`; };
    fileIn.addEventListener("change", () => {
      const f = fileIn.files?.[0];
      fileIn.value = "";
      if (!f) return;
      void (async () => {
        const buf = new Uint8Array(await f.arrayBuffer());
        let bin = "";
        for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]!);
        const res = await api().designAssetUpload?.(file, {
          kind: /logo/i.test(f.name) ? "logo" : "image",
          title: f.name.replace(/\.[^.]+$/, ""),
          contentType: f.type || "image/png",
          dataBase64: btoa(bin),
        });
        if (!res?.ok) { void host.confirm({ title: "Upload failed", body: res?.error || "Unknown error.", confirmLabel: "OK" }); return; }
        doc.assets = [...(doc.assets ?? []).filter((a) => a.id !== res.asset!.id), res.asset!];
        touched();   // the canvas card appears with the save
        paintUpCount();
      })();
    });
    browseUp.addEventListener("click", () => {
      const m = gdzModal("Uploads");
      const repaint = modalGrid(m.body, "Search uploads…", (q, page, grid, foot, go) => {
        const pool = (doc.assets ?? []).filter((a) => !q || a.title.toLowerCase().includes(q));
        const { items, page: p } = officePage(pool, page, 12);
        for (const a of items) {
          const tile = document.createElement("div");
          tile.className = "gdz-modal-tile";
          tile.innerHTML = `<div class="gdz-modal-img"></div><div class="gdz-modal-row"><span class="gdz-modal-name"></span><button class="ws-icon-btn gdz-modal-del" title="Delete upload"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></button></div>`;
          (tile.querySelector(".gdz-modal-name") as HTMLElement).textContent = a.title;
          void api().designAssetUrl?.(file, a.id).then((r) => {
            const box = tile.querySelector<HTMLElement>(".gdz-modal-img");
            if (r?.ok && r.url && box?.isConnected) box.style.backgroundImage = `url("${r.url.replace(/"/g, "%22")}")`;
          });
          tile.querySelector(".gdz-modal-del")?.addEventListener("click", () => {
            void (async () => {
              const yes = await host.confirm({ title: `Delete "${a.title}"?`, body: "Removes the upload from the system and the canvas.", confirmLabel: "Delete", danger: true });
              if (!yes) return;
              await api().designAssetDelete?.(file, a.id);
              doc.assets = (doc.assets ?? []).filter((x) => x.id !== a.id);
              if (!doc.assets.length) delete doc.assets;
              touched();
              paintUpCount();
              repaint();
            })();
          });
          grid.appendChild(tile);
        }
        if (!pool.length) grid.innerHTML = `<div class="gdz-modal-empty">No uploads yet — ＋ Upload image adds one.</div>`;
        const pager = officePager(pool.length, p, 12, go);
        if (pager) foot.appendChild(pager);
      });
    });
    assets.appendChild(upBtn);
    assets.appendChild(fileIn);
    assets.appendChild(browseUp);
    paintUpCount();

    // — Imagery — media-library adoptions: generated icons, site images,
    //   brand motion. Pointers into the org media library; the canvas shows
    //   each one as its own draggable card.
    const imagery = section(rail, "Imagery", false);
    const browseImg = document.createElement("button");
    browseImg.className = "action-btn gdz-source-add";
    const paintImgCount = (): void => { browseImg.textContent = `Browse imagery (${(doc.imagery ?? []).length})`; };
    browseImg.addEventListener("click", () => {
      const m = gdzModal("Imagery");
      const repaint = modalGrid(m.body, "Search imagery…", (q, page, grid, foot, go) => {
        const pool = (doc.imagery ?? []).filter((x) => !q || x.title.toLowerCase().includes(q) || (x.role ?? "").toLowerCase().includes(q));
        const { items, page: p } = officePage(pool, page, 12);
        for (const x of items) {
          const tile = document.createElement("div");
          tile.className = "gdz-modal-tile";
          tile.innerHTML = `
            <div class="gdz-modal-img"><span class="gdz-img-picker-tag">${x.kind === "video" ? "▶" : ""}</span></div>
            <div class="gdz-modal-row">
              <span class="gdz-modal-name"></span>
              <input type="text" class="gdz-pal-role gdz-modal-role" spellcheck="false" placeholder="role (icon, hero…)" />
              <button class="ws-icon-btn gdz-modal-del" title="Remove from the system">✕</button>
            </div>`;
          (tile.querySelector(".gdz-modal-name") as HTMLElement).textContent = x.title;
          void api().mediaUrl?.(x.assetId).then((r) => {
            const box = tile.querySelector<HTMLElement>(".gdz-modal-img");
            if (r?.ok && r.url && box?.isConnected) box.style.backgroundImage = `url("${r.url.replace(/"/g, "%22")}")`;
          });
          const roleIn = tile.querySelector<HTMLInputElement>(".gdz-modal-role")!;
          roleIn.value = x.role ?? "";
          roleIn.addEventListener("change", () => {
            const v = roleIn.value.trim();
            if (v) x.role = v; else delete x.role;
            touched();
          });
          tile.querySelector(".gdz-modal-del")?.addEventListener("click", () => {
            doc.imagery = (doc.imagery ?? []).filter((y) => y.assetId !== x.assetId);
            if (!doc.imagery.length) delete doc.imagery;
            touched();
            paintImgCount();
            repaint();
          });
          grid.appendChild(tile);
        }
        if (!pool.length) grid.innerHTML = `<div class="gdz-modal-empty">No imagery adopted yet — ＋ From library adds some.</div>`;
        const pager = officePager(pool.length, p, 12, go);
        if (pager) foot.appendChild(pager);
      });
    });
    const addImg = document.createElement("button");
    addImg.className = "action-btn gdz-source-add";
    addImg.textContent = "＋ From library";
    addImg.addEventListener("click", () => {
      void (async () => {
        const [imgs, vids] = await Promise.all([api().mediaList?.("image"), api().mediaList?.("video")]);
        const all = [...(imgs?.ok ? imgs.assets : []), ...(vids?.ok ? vids.assets : [])].filter((x) => x.status === "ready");
        const m = gdzModal("Add from the library");
        const repaint = modalGrid(m.body, "Search the library…", (q, page, grid, foot, go) => {
          const pool = all
            .filter((x) => !(doc.imagery ?? []).some((m2) => m2.assetId === x.id))
            .filter((x) => !q || x.title.toLowerCase().includes(q));
          const { items, page: p } = officePage(pool, page, 12);
          for (const x of items) {
            const cell = document.createElement("button");
            cell.className = "gdz-modal-tile gdz-modal-pick";
            cell.title = x.title;
            cell.innerHTML = `<div class="gdz-modal-img"><span class="gdz-img-picker-tag">${x.kind === "video" ? "▶" : ""}</span></div><div class="gdz-modal-row"><span class="gdz-modal-name"></span></div>`;
            (cell.querySelector(".gdz-modal-name") as HTMLElement).textContent = x.title;
            if (x.mime.startsWith("image/")) {
              void api().mediaUrl?.(x.id).then((r) => {
                const box = cell.querySelector<HTMLElement>(".gdz-modal-img");
                if (r?.ok && r.url && box?.isConnected) box.style.backgroundImage = `url("${r.url.replace(/"/g, "%22")}")`;
              });
            }
            cell.addEventListener("click", () => {
              // Adopt it — the canvas card appears with the save; the modal
              // stays up so several can be added in one visit.
              doc.imagery = [...(doc.imagery ?? []), { assetId: x.id, kind: x.kind === "video" ? "video" : "image", title: x.title }];
              touched();
              paintImgCount();
              repaint();
            });
            grid.appendChild(cell);
          }
          if (!pool.length) grid.innerHTML = `<div class="gdz-modal-empty">Nothing left to add — the library has no other ready images or video.</div>`;
          const pager = officePager(pool.length, p, 12, go);
          if (pager) foot.appendChild(pager);
        });
      })();
    });
    imagery.appendChild(browseImg);
    imagery.appendChild(addImg);
    paintImgCount();

    // — Sources (provenance) — fully editable: the user records where the
    //   system came from and steers future extractions from right here.
    const sources = section(rail, "Sources", false);
    doc.sources ??= [];
    const editSrc = document.createElement("button");
    editSrc.className = "action-btn gdz-source-add";
    const paintSrcCount = (): void => { editSrc.textContent = `Edit sources (${(doc.sources ?? []).length})`; };
    editSrc.addEventListener("click", () => {
      const m = gdzModal("Sources");
      const repaint = modalGrid(m.body, "Search sources…", (q, page, grid, foot, go) => {
        grid.classList.add("gdz-modal-rows");
        const pool = (doc.sources ?? []).filter((s) => !q || s.ref.toLowerCase().includes(q) || (s.note ?? "").toLowerCase().includes(q) || s.type.includes(q));
        const { items, page: p } = officePage(pool, page, 10);
        for (const src of items) {
          const row = document.createElement("div");
          row.className = "gdz-source-row";
          row.innerHTML = `
            <select class="gdz-select gdz-source-kind">
              <option value="prompt">prompt</option>
              <option value="site">site</option>
              <option value="image">image</option>
            </select>
            <input type="text" class="gdz-source-ref-in" spellcheck="false" placeholder="url, file, or the words used…" />
            <input type="text" class="gdz-source-note-in" spellcheck="false" placeholder="note" />
            <button class="ws-icon-btn gdz-source-x" title="Remove">✕</button>`;
          const kind = row.querySelector<HTMLSelectElement>(".gdz-source-kind")!;
          const refIn = row.querySelector<HTMLInputElement>(".gdz-source-ref-in")!;
          const noteIn = row.querySelector<HTMLInputElement>(".gdz-source-note-in")!;
          kind.value = src.type;
          refIn.value = src.ref;
          noteIn.value = src.note ?? "";
          kind.addEventListener("change", () => { src.type = kind.value; touched(); });
          refIn.addEventListener("change", () => { src.ref = refIn.value.trim(); touched(); });
          noteIn.addEventListener("change", () => {
            const v = noteIn.value.trim();
            if (v) src.note = v; else delete src.note;
            touched();
          });
          row.querySelector(".gdz-source-x")?.addEventListener("click", () => {
            const i = doc.sources?.indexOf(src) ?? -1;
            if (i >= 0) doc.sources?.splice(i, 1);
            touched();
            paintSrcCount();
            repaint();
          });
          grid.appendChild(row);
        }
        const add = document.createElement("button");
        add.className = "action-btn gdz-source-add";
        add.textContent = "＋ Add source";
        add.addEventListener("click", () => {
          doc.sources = [...(doc.sources ?? []), { type: "prompt", ref: "", extractedAt: new Date().toISOString() }];
          touched();
          paintSrcCount();
          repaint();
        });
        grid.appendChild(add);
        const pager = officePager(pool.length, p, 10, go);
        if (pager) foot.appendChild(pager);
      });
    });
    sources.appendChild(editSrc);
    paintSrcCount();
  }

  // (shared with the other office panels' pattern — a scoped popover)
  interface PopItem { label: string; danger?: boolean; fn: () => void }
  function popMenu(x: number, y: number, items: PopItem[]): void {
    document.querySelectorAll(".gdesign-menu").forEach((el) => el.remove());
    const menu = document.createElement("div");
    menu.className = "ws-popover gdesign-menu";
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

  return {
    renderIntoSlot,
    invalidate: (file: string) => { docCache.delete(file); },
  };
}
