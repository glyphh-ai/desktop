/**
 * wb-media.ts — ONE library panel, three apps: Glyphh IMAGE, VIDEO and SOUNDS.
 * The same grid-and-viewer over the org media library, parameterized by kind:
 * Image shows generations/uploads as thumbnails, Video shows clips (and screen
 * recordings) with durations, Sounds shows music/effects/speech with players.
 *
 * Library → viewer. Playback URLs come from the main process (presigned when
 * the store can, tmp-cached file:// when it can't) — no bearer in here. A
 * generating job strip sits above the grid and polls itself to done.
 */

import { officePager, officePage } from "./wb-office-ui.js";
import { biasThumbCrop } from "./wb-drive.js";


export interface MediaAssetLite {
  id: string;
  kind: string;
  title: string;
  mime: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  status: string;
  meta: Record<string, unknown>;
  updatedAt: string;
}
interface MediaJobLite { id: string; status: string; model: string; assetId: string | null; error: string | null; creditsCharged: number }

export type MediaView = "gimage" | "gvideo" | "gsound";

export interface MediaSlotState {
  id: number;
  view: MediaView;
  assetId?: string;
  page?: number;
}

export interface MediaHost {
  confirm: (opts: { title: string; body?: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>;
  icons: Record<MediaView, string>;
}

const api = () => (window as unknown as { glyphh?: {
  mediaList?: (kind?: string, q?: string) => Promise<{ ok: boolean; assets: MediaAssetLite[]; error?: string }>;
  mediaUrl?: (id: string) => Promise<{ ok: boolean; url?: string; error?: string }>;
  mediaDelete?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  mediaJob?: (id: string) => Promise<{ ok: boolean; job?: MediaJobLite; error?: string }>;
  mediaUploadPick?: (kind?: string) => Promise<{ ok: boolean; id?: string; title?: string; error?: string }>;
  mediaSave?: (id: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
} }).glyphh ?? {};

/** What each view shows and says. */
const VIEWS: Record<MediaView, { title: string; kinds: string[]; empty: string; searchPh: string }> = {
  gimage: { title: "Image", kinds: ["image", "avatar"], empty: 'No images yet — ask Glyphh: "generate an image of…", or Upload.', searchPh: "Search images…" },
  gvideo: { title: "Video", kinds: ["video", "recording"], empty: 'No video yet — ask Glyphh: "make a video of…", or Upload.', searchPh: "Search video…" },
  gsound: { title: "Sounds", kinds: ["audio", "voice"], empty: 'No sounds yet — ask Glyphh for music, a sound effect, or narration.', searchPh: "Search sounds…" },
};

/** Presigned GETs expire server-side in 300s (file-store DOWNLOAD_URL_TTL) —
 *  cached forever, a video would START from browser-cached bytes and then die
 *  on the first range request against the dead signature ("plays a moment,
 *  then stops", his report 2026-08-27). Re-mint after 4 minutes. */
const URL_TTL_MS = 4 * 60 * 1000;
const urlCache = new Map<string, { url: string; at: number }>();
async function assetUrl(id: string, fresh = false): Promise<string | null> {
  const hit = urlCache.get(id);
  if (hit && !fresh && Date.now() - hit.at < URL_TTL_MS) return hit.url;
  const res = await api().mediaUrl?.(id);
  if (!res?.ok || !res.url) return hit?.url ?? null; // offline blip — a stale URL beats none
  urlCache.set(id, { url: res.url, at: Date.now() });
  return res.url;
}

/** First-frame capture for video cards: seek ~10% in, draw to canvas, cache
 *  the JPEG. A cross-origin (presigned) source can taint the canvas — that
 *  path bails to the plain duration badge rather than throwing. */
const frameCache = new Map<string, string | null>();
async function videoThumb(id: string): Promise<string | null> {
  if (frameCache.has(id)) return frameCache.get(id) ?? null;
  const url = await assetUrl(id);
  if (!url) { frameCache.set(id, null); return null; }
  const out = await new Promise<string | null>((resolve) => {
    const v = document.createElement("video");
    v.muted = true;
    v.crossOrigin = "anonymous";
    v.preload = "metadata";
    const timer = setTimeout(() => bail(), 8000);
    const cleanup = (): void => { clearTimeout(timer); v.removeAttribute("src"); v.load(); };
    const bail = (): void => { cleanup(); resolve(null); };
    v.addEventListener("error", bail, { once: true });
    v.addEventListener("loadedmetadata", () => {
      try { v.currentTime = Math.min(1.5, (v.duration || 2) * 0.1); } catch { bail(); }
    }, { once: true });
    v.addEventListener("seeked", () => {
      try {
        const c = document.createElement("canvas");
        const w = 320;
        c.width = w;
        c.height = Math.max(2, Math.round(w * ((v.videoHeight || 9) / (v.videoWidth || 16))));
        c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
        const data = c.toDataURL("image/jpeg", 0.72);
        cleanup();
        resolve(data);
      } catch { bail(); }
    }, { once: true });
    v.src = url;
  });
  frameCache.set(id, out);
  return out;
}

const fmtDur = (ms: number | null): string => {
  if (!ms) return "";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const fmtSize = (b: number): string => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`);

export interface MediaPanel {
  renderIntoSlot: (body: HTMLElement, slot: MediaSlotState, wrap: HTMLElement) => Promise<void>;
  invalidate: () => void;
}

interface PopItem { label: string; danger?: boolean; fn: () => void }
function popMenu(x: number, y: number, items: PopItem[]): void {
  document.querySelectorAll(".gmedia-menu").forEach((el) => el.remove());
  const menu = document.createElement("div");
  menu.className = "ws-popover gmedia-menu";
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

export function initMedia(host: MediaHost): MediaPanel {
  async function renderIntoSlot(body: HTMLElement, slot: MediaSlotState, wrap: HTMLElement): Promise<void> {
    const st = slot as MediaSlotState & { __gen?: number };
    st.__gen = (st.__gen ?? 0) + 1;
    try {
      await renderInner(body, slot, wrap);
    } catch (err) {
      console.warn("[gmedia] render failed:", err);
      if (body.isConnected) {
        body.innerHTML = `<div class="gdoc-empty">Media hit an error rendering.<br><code class="gpoint-err"></code></div>`;
        const code = body.querySelector(".gpoint-err");
        if (code) code.textContent = err instanceof Error ? err.message : String(err);
      }
    }
  }

  async function renderInner(body: HTMLElement, slot: MediaSlotState, wrap: HTMLElement): Promise<void> {
    body.classList.add("ws-gmedia-body");
    const view = VIEWS[slot.view] ?? VIEWS.gimage;
    const titleEl = wrap.querySelector(".ws-rail-slot-header .title");
    if (titleEl) titleEl.textContent = view.title;
    const refresh = (): void => { if (body.isConnected) void renderIntoSlot(body, slot, wrap); };
    if (slot.assetId) { await renderViewer(body, slot, refresh); return; }
    await renderLibrary(body, slot, view, refresh);
  }

  async function renderLibrary(
    body: HTMLElement,
    slot: MediaSlotState,
    view: (typeof VIEWS)[MediaView],
    refresh: () => void,
  ): Promise<void> {
    body.innerHTML = `
      <div class="gdoc-lib">
        <div class="office-toolbar">
          <input class="office-search" type="text" placeholder="${view.searchPh}" spellcheck="false" autocomplete="off" />
          <button class="action-btn primary gmedia-upload">↑ Upload</button>
          <button class="ws-icon-btn office-refresh" title="Refresh">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.3"/><polyline points="21 3 21 9 15 9"/></svg>
          </button>
        </div>
        <div class="gmedia-grid"></div>
        <div class="gdoc-empty hidden">${view.empty}</div>
      </div>`;
    body.querySelector(".office-refresh")?.addEventListener("click", refresh);
    body.querySelector(".gmedia-upload")?.addEventListener("click", () => {
      void (async () => {
        const r = await api().mediaUploadPick?.(view.kinds[0]);
        if (r && !r.ok && r.error && r.error !== "cancelled") {
          void host.confirm({ title: "Upload failed", body: r.error, confirmLabel: "OK" });
          return;
        }
        if (r?.ok) refresh();
      })();
    });

    const grid = body.querySelector<HTMLElement>(".gmedia-grid")!;
    const empty = body.querySelector<HTMLElement>(".gdoc-empty")!;
    const myGen = (slot as MediaSlotState & { __gen?: number }).__gen;
    const lists = await Promise.all(view.kinds.map((k) => api().mediaList?.(k)));
    // SUPERSEDED? A newer render (the asset viewer landing) owns the DOM now —
    // painting the library here stomped the just-opened asset.
    if (!body.isConnected || (slot as MediaSlotState & { __gen?: number }).__gen !== myGen) return;
    if (!grid.isConnected) return;
    const anyErr = lists.find((r) => r && !r.ok);
    const assets = lists.flatMap((r) => (r?.ok ? r.assets : []))
      .filter((x) => x.status === "ready")
      .sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
    if (anyErr && !assets.length) {
      empty.innerHTML = `Couldn't load the library.<br>${anyErr.error ?? "Unknown error."}`;
      empty.classList.remove("hidden");
      return;
    }

    const PER_PAGE = 24;
    const paint = (query: string): void => {
      grid.textContent = "";
      body.querySelector(".office-pager")?.remove();
      const q = query.toLowerCase();
      const matches = assets.filter((m) =>
        !q || m.title.toLowerCase().includes(q) || String(m.meta.prompt ?? "").toLowerCase().includes(q));
      empty.classList.toggle("hidden", matches.length > 0 || assets.length === 0);
      if (!assets.length) empty.classList.remove("hidden");
      const paged = officePage(matches, q ? 0 : (slot.page ?? 0), PER_PAGE);
      if (!q) slot.page = paged.page;
      const pager = officePager(matches.length, paged.page, PER_PAGE, (pg) => { slot.page = pg; paint(query); });
      if (pager && !q) grid.parentElement?.appendChild(pager);
      for (const m of paged.items) {
        const card = document.createElement("div");
        card.className = "gmedia-card";
        card.innerHTML = `
          <div class="gmedia-thumb"><span class="gmedia-thumb-ph">${host.icons[slot.view]}</span></div>
          <div class="gdrive-card-row">
            <span class="gdrive-card-title"></span>
            <button class="ws-icon-btn office-card-kebab" title="Options">
              <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="12" cy="19" r="1.9"/></svg>
            </button>
          </div>
          <span class="gdrive-card-meta"></span>`;
        (card.querySelector(".gdrive-card-title") as HTMLElement).textContent = m.title;
        (card.querySelector(".gdrive-card-meta") as HTMLElement).textContent =
          [m.kind, fmtDur(m.durationMs), fmtSize(m.sizeBytes)].filter(Boolean).join(" · ");
        const thumb = card.querySelector<HTMLElement>(".gmedia-thumb")!;
        if (m.mime.startsWith("image/")) {
          void assetUrl(m.id).then((u) => {
            if (!u || !thumb.isConnected) return;
            thumb.innerHTML = "";
            thumb.style.backgroundImage = `url("${u.replace(/"/g, "%22")}")`;
            biasThumbCrop(thumb, u);
          });
        } else if (m.mime.startsWith("audio/")) {
          thumb.classList.add("gmedia-thumb-audio");
        } else {
          const dur = document.createElement("span");
          dur.className = "gmedia-thumb-dur";
          dur.textContent = fmtDur(m.durationMs) || "▶";
          thumb.appendChild(dur);
          void videoThumb(m.id).then((frame) => {
            if (!frame || !thumb.isConnected) return;
            thumb.querySelector(".gmedia-thumb-ph")?.remove();
            thumb.style.backgroundImage = `url("${frame}")`;
          });
        }
        card.addEventListener("click", (ev) => {
          if ((ev.target as HTMLElement).closest(".office-card-kebab")) return;
          slot.assetId = m.id;
          refresh();
        });
        card.querySelector(".office-card-kebab")?.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
          popMenu(r.left, r.bottom + 4, [
            { label: "Open", fn: () => { slot.assetId = m.id; refresh(); } },
            { label: "Download…", fn: () => { void api().mediaSave?.(m.id); } },
            { label: "Delete…", danger: true, fn: () => {
              void (async () => {
                const yes = await host.confirm({ title: `Delete "${m.title}"?`, body: "Removed from the org library for real.", confirmLabel: "Delete", danger: true });
                if (!yes) return;
                await api().mediaDelete?.(m.id);
                urlCache.delete(m.id);
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

  async function renderViewer(body: HTMLElement, slot: MediaSlotState, refresh: () => void): Promise<void> {
    const id = slot.assetId!;
    body.innerHTML = `
      <div class="gmedia-viewer">
        <div class="gdz-topbar">
          <button class="action-btn gmedia-back">‹ ${VIEWS[slot.view]?.title ?? "Library"}</button>
          <span class="gmedia-viewer-title"></span>
          <button class="ws-icon-btn gmedia-viewer-dl" title="Download / export">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
          <button class="ws-icon-btn gmem-del gmedia-viewer-del" title="Delete"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></button>
        </div>
        <div class="gmedia-stagewrap">
          <button class="gmedia-nav gmedia-nav-prev" title="Previous (←/↑)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>
          <div class="gmedia-stage"><div class="gdoc-empty">Loading…</div></div>
          <button class="gmedia-nav gmedia-nav-next" title="Next (→/↓)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></button>
        </div>
        <div class="gmedia-meta"></div>
      </div>`;
    body.querySelector(".gmedia-back")?.addEventListener("click", () => { delete slot.assetId; refresh(); });
    body.querySelector(".gmedia-viewer-dl")?.addEventListener("click", () => { void api().mediaSave?.(id); });

    const myGen = (slot as MediaSlotState & { __gen?: number }).__gen;
    const lists = await Promise.all((VIEWS[slot.view]?.kinds ?? []).map((k) => api().mediaList?.(k)));
    if ((slot as MediaSlotState & { __gen?: number }).__gen !== myGen) return;
    // SUPERSEDED? A newer render may have wiped the body during the await —
    // touching the old nodes crashed the panel. Bail quietly; the newer
    // render owns the DOM now.
    const stage = body.querySelector<HTMLElement>(".gmedia-stage");
    const titleNode = body.querySelector<HTMLElement>(".gmedia-viewer-title");
    if (!stage || !titleNode || !body.isConnected) return;
    const ordered = lists.flatMap((r) => (r?.ok ? r.assets : []));
    const asset = ordered.find((x) => x.id === id);
    // ── ONE-BY-ONE NAVIGATION (his spec, 2026-08-27): ←/→ and ↑/↓ step
    // through the library in grid order; the chevrons flanking the stage do
    // the same by click. Wraps at the ends. ──
    {
      const at = ordered.findIndex((x) => x.id === id);
      const step = (d: number): void => {
        if (ordered.length < 2 || at < 0) return;
        slot.assetId = ordered[(at + d + ordered.length) % ordered.length]!.id;
        refresh();
      };
      body.querySelector(".gmedia-nav-prev")?.addEventListener("click", () => step(-1));
      body.querySelector(".gmedia-nav-next")?.addEventListener("click", () => step(1));
      const onKey = (ev: KeyboardEvent): void => {
        // The viewer owns the arrows only while it is on screen and the user
        // isn't typing somewhere (the composer keeps its caret keys).
        if (!body.isConnected || slot.assetId !== id) { document.removeEventListener("keydown", onKey, true); return; }
        const t = ev.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
        if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") { ev.preventDefault(); step(-1); }
        else if (ev.key === "ArrowRight" || ev.key === "ArrowDown") { ev.preventDefault(); step(1); }
      };
      document.addEventListener("keydown", onKey, true);
      if (ordered.length < 2) body.querySelectorAll<HTMLElement>(".gmedia-nav").forEach((b) => { b.style.display = "none"; });
    }
    if (!asset) {
      stage.innerHTML = `<div class="gdoc-empty">This asset is gone.</div>`;
      return;
    }
    titleNode.textContent = asset.title;
    body.querySelector(".gmedia-viewer-del")?.addEventListener("click", () => {
      void (async () => {
        const yes = await host.confirm({ title: `Delete "${asset.title}"?`, confirmLabel: "Delete", danger: true });
        if (!yes) return;
        await api().mediaDelete?.(id);
        urlCache.delete(id);
        delete slot.assetId;
        refresh();
      })();
    });
    const url = await assetUrl(id);
    if (!stage.isConnected) return;
    if (!url) { stage.innerHTML = `<div class="gdoc-empty">Couldn't load the bytes.</div>`; return; }
    stage.textContent = "";
    if (asset.mime.startsWith("image/")) {
      const img = document.createElement("img");
      img.className = "gmedia-full";
      img.src = url;
      stage.appendChild(img);
    } else if (asset.mime.startsWith("video/")) {
      const vid = document.createElement("video");
      vid.className = "gmedia-full";
      vid.src = url;
      vid.controls = true;
      vid.autoplay = false;
      // A signature that dies MID-PLAY (tab left open past the TTL) surfaces
      // as a media error — re-mint once and resume from where it stopped.
      let healed = false;
      vid.addEventListener("error", () => {
        if (healed) return;
        healed = true;
        const at = vid.currentTime;
        void assetUrl(id, true).then((u2) => {
          if (!u2 || !vid.isConnected) return;
          vid.src = u2;
          vid.currentTime = at;
          void vid.play().catch(() => { /* user gesture needed — controls remain */ });
        });
      });
      stage.appendChild(vid);
    } else {
      const wrapEl = document.createElement("div");
      wrapEl.className = "gmedia-audio-wrap";
      wrapEl.innerHTML = `<div class="gmedia-audio-art">♫</div>`;
      const aud = document.createElement("audio");
      aud.src = url;
      aud.controls = true;
      wrapEl.appendChild(aud);
      stage.appendChild(wrapEl);
    }
    const meta = body.querySelector<HTMLElement>(".gmedia-meta")!;
    const prompt = typeof asset.meta.prompt === "string" ? asset.meta.prompt : "";
    const model = typeof asset.meta.model === "string" ? asset.meta.model : "";
    meta.innerHTML = `
      ${prompt ? `<div class="gmedia-meta-prompt"></div>` : ""}
      <div class="gmedia-meta-row"></div>`;
    if (prompt) (meta.querySelector(".gmedia-meta-prompt") as HTMLElement).textContent = `“${prompt}”`;
    (meta.querySelector(".gmedia-meta-row") as HTMLElement).textContent = [
      model, asset.mime,
      asset.width && asset.height ? `${asset.width}×${asset.height}` : "",
      fmtDur(asset.durationMs), fmtSize(asset.sizeBytes),
    ].filter(Boolean).join(" · ");
  }

  return {
    renderIntoSlot,
    invalidate: () => { urlCache.clear(); frameCache.clear(); },
  };
}
