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
interface DesignDoc {
  version: 1;
  name: string;
  brand?: { tagline?: string; tone?: string[] };
  colors: { primary: string; accent?: string; background: string; surface?: string; text: string; muted?: string; palette?: DColor[] };
  fonts: { display: DFont; body: DFont; mono?: DFont };
  type?: { baseSize?: number; scale?: number; headingWeight?: number; letterSpacing?: number };
  styles?: { radius?: number; borderWidth?: number; shadow?: string; density?: string; gradient?: { from: string; to: string; angle?: number } };
  assets?: DAsset[];
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
      primary: "#8c3bf2", accent: "#ec4899", background: "#0e0e12",
      surface: "#17171d", text: "#f5f5f7", muted: "#9a9aa4",
      palette: [
        { name: "Primary", hex: "#8c3bf2", role: "actions" },
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
    styles: { radius: 14, borderWidth: 1, shadow: "medium", density: "comfortable", gradient: { from: "#8c3bf2", to: "#ec4899", angle: 135 } },
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
          <div class="gdz-rail"></div>
        </div>
      </div>`;
    body.querySelector(".gdz-back")?.addEventListener("click", () => { delete slot.file; delete slot.title; refresh(); });

    const rail = body.querySelector<HTMLElement>(".gdz-rail")!;
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
      paintAll(body, doc);
      saveState.textContent = "…";
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { void save(); }, 700);
    };
    nameInput.addEventListener("change", () => {
      doc.name = nameInput.value.trim() || doc.name;
      nameInput.value = doc.name;
      touched();
    });

    paintAll(body, doc);
    wireCanvas(body.querySelector<HTMLElement>(".gdz-canvas")!, body.querySelector<HTMLElement>(".gdz-world")!);
    buildRail(rail, doc, file, touched);
  }

  // ── the canvas + its artifacts ─────────────────────────────────────────────

  function paintAll(body: HTMLElement, doc: DesignDoc): void {
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
   *  pans, dragging a card's grip moves that card in world space. */
  function wireCanvas(stage: HTMLElement, world: HTMLElement): void {
    let scale = 0.9, tx = 40, ty = 30;
    const apply = (): void => { world.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`; };
    apply();
    stage.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      const rect = stage.getBoundingClientRect();
      const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
      const next = Math.min(2.5, Math.max(0.25, scale * (ev.deltaY > 0 ? 0.92 : 1 / 0.92)));
      tx = px - ((px - tx) / scale) * next;
      ty = py - ((py - ty) / scale) * next;
      scale = next;
      apply();
    }, { passive: false });
    let drag: { x: number; y: number; art?: HTMLElement; ax?: number; ay?: number } | null = null;
    stage.addEventListener("mousedown", (ev) => {
      const grip = (ev.target as HTMLElement).closest<HTMLElement>(".gdz-art-grip");
      const art = grip?.closest<HTMLElement>(".gdz-art") ?? undefined;
      // Controls inside artifacts (color inputs etc.) keep their clicks.
      if (!art && (ev.target as HTMLElement).closest("input, button, select, textarea")) return;
      drag = art
        ? { x: ev.clientX, y: ev.clientY, art, ax: parseFloat(art.style.left) || 0, ay: parseFloat(art.style.top) || 0 }
        : { x: ev.clientX, y: ev.clientY };
      ev.preventDefault();
    });
    const onMove = (ev: MouseEvent): void => {
      if (!drag) return;
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (drag.art) {
        drag.art.style.left = `${(drag.ax ?? 0) + dx / scale}px`;
        drag.art.style.top = `${(drag.ay ?? 0) + dy / scale}px`;
      } else {
        tx += dx; ty += dy;
        drag.x = ev.clientX; drag.y = ev.clientY;
        apply();
      }
      if (drag.art) return;
    };
    const onUp = (): void => { drag = null; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
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

    // — Assets —
    const assets = section(rail, "Assets", false);
    const assetGrid = document.createElement("div");
    assetGrid.className = "gdz-assets";
    const upBtn = document.createElement("button");
    upBtn.className = "action-btn gdz-asset-up";
    upBtn.textContent = "＋ Upload image";
    const fileIn = document.createElement("input");
    fileIn.type = "file";
    fileIn.accept = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml";
    fileIn.style.display = "none";
    upBtn.addEventListener("click", () => fileIn.click());
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
        paintAssets();
      })();
    });
    const paintAssets = (): void => {
      assetGrid.textContent = "";
      for (const a of doc.assets ?? []) {
        const tile = document.createElement("div");
        tile.className = "gdz-asset";
        tile.innerHTML = `<div class="gdz-asset-img"></div><span class="gdz-asset-name"></span><button class="ws-icon-btn gdz-asset-x" title="Remove">✕</button>`;
        (tile.querySelector(".gdz-asset-name") as HTMLElement).textContent = a.title;
        void api().designAssetUrl?.(file, a.id).then((r) => {
          const box = tile.querySelector<HTMLElement>(".gdz-asset-img");
          if (r?.ok && r.url && box?.isConnected) box.style.backgroundImage = `url("${r.url}")`;
        });
        tile.querySelector(".gdz-asset-x")?.addEventListener("click", () => {
          void (async () => {
            const yes = await host.confirm({ title: `Remove "${a.title}"?`, confirmLabel: "Remove", danger: true });
            if (!yes) return;
            await api().designAssetDelete?.(file, a.id);
            doc.assets = (doc.assets ?? []).filter((x) => x.id !== a.id);
            if (!doc.assets.length) delete doc.assets;
            paintAssets();
          })();
        });
        assetGrid.appendChild(tile);
      }
    };
    assets.appendChild(upBtn);
    assets.appendChild(fileIn);
    assets.appendChild(assetGrid);
    paintAssets();

    // — Sources (provenance) — fully editable: the user records where the
    //   system came from and steers future extractions from right here.
    const sources = section(rail, "Sources", false);
    doc.sources ??= [];
    const srcWrap = document.createElement("div");
    srcWrap.className = "gdz-sources";
    sources.appendChild(srcWrap);
    const paintSources = (): void => {
      srcWrap.textContent = "";
      for (const [i, src] of (doc.sources ?? []).entries()) {
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
          doc.sources?.splice(i, 1);
          touched(); paintSources();
        });
        srcWrap.appendChild(row);
      }
      const add = document.createElement("button");
      add.className = "action-btn gdz-source-add";
      add.textContent = "＋ Add source";
      add.addEventListener("click", () => {
        doc.sources = [...(doc.sources ?? []), { type: "prompt", ref: "", extractedAt: new Date().toISOString() }];
        touched(); paintSources();
      });
      srcWrap.appendChild(add);
    };
    paintSources();
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
