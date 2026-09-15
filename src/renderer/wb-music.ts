/**
 * wb-music.ts — the MUSIC STUDIO views inside the Sounds app: Songs, Artists,
 * Music Video (the Library tab stays wb-media's grid).
 *
 * THE SONG PAGE is the centerpiece — Apps→General shape:
 *   left  — Title, then LYRICS tall with the glowing purple underline, then
 *           the generation PROMPT (editable — it's the steering wheel)
 *   right — the sound editor: Web Audio waveform (bars per chosen interval,
 *           zoom), drag-select, cut/copy/paste at the playhead, undo,
 *           play/pause with a live playhead. Save as New encodes a WAV and
 *           lands a NEW asset + song version; Regenerate re-runs the music
 *           model with prompt+lyrics+band and creates a CHILD song (lineage —
 *           the original never moves).
 */

interface Artist { id: string; name: string; style: string; voiceAssetId: string | null; voiceId: string | null; avatarAssetId: string | null; meta: Record<string, unknown>; updatedAt: string }
interface Instrument { instrument: string; tweak: string; lookAssetId?: string | null }
interface Song {
  id: string; title: string; lyrics: string; prompt: string; bandType: string;
  artistIds: string[]; instruments: Instrument[];
  audioAssetId: string | null; parentId: string | null; model: string; visuals: string[]; updatedAt: string;
}

interface LibInstrument { id: string; name: string; description: string; meta: Record<string, unknown>; updatedAt: string }
interface Project { id: string; title: string; scenes: Record<string, unknown>; status: string; renderAssetId: string | null; updatedAt: string }

export interface MusicHost {
  confirm: (opts: { title: string; body?: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>;
}

export interface MusicState {
  songId?: string;
  artistId?: string | null;
  instrumentId?: string | null;
  videoId?: string | null;
  /** Per-list page cursors — survive re-renders. */
  pages?: Record<string, number>;
}

const api = () => (window as unknown as { glyphh?: {
  musicArtists?: () => Promise<{ ok: boolean; artists: Artist[]; error?: string }>;
  musicArtistSave?: (id: string | null, input: unknown) => Promise<{ ok: boolean; artist?: Artist; error?: string }>;
  musicArtistDelete?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  musicInstruments?: () => Promise<{ ok: boolean; instruments: LibInstrument[]; error?: string }>;
  musicInstrumentSave?: (id: string | null, input: unknown) => Promise<{ ok: boolean; instrument?: LibInstrument; error?: string }>;
  musicInstrumentDelete?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  musicInstrumentGenlook?: (id: string, description?: string, replaceLook?: number) => Promise<{ ok: boolean; instrument?: LibInstrument; credits?: number; error?: string }>;
  musicSongs?: () => Promise<{ ok: boolean; songs: Song[]; error?: string }>;
  musicSongSave?: (id: string | null, input: unknown) => Promise<{ ok: boolean; song?: Song; error?: string }>;
  musicSongDelete?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  musicSongRegenerate?: (id: string, input?: unknown) => Promise<{ ok: boolean; song?: Song; job?: { id: string }; error?: string }>;
  musicArtistGenlook?: (id: string, description?: string, replaceLook?: number) => Promise<{ ok: boolean; artist?: Artist; credits?: number; error?: string }>;
  mediaProjects?: () => Promise<{ ok: boolean; projects: Project[]; error?: string }>;
  mediaProjectSave?: (id: string | null, input: unknown) => Promise<{ ok: boolean; project?: Project; error?: string }>;
  mediaProjectDelete?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  mediaProjectGenerate?: (id: string, input?: unknown) => Promise<{ ok: boolean; project?: Project; job?: { id: string }; error?: string }>;
  mediaUploadBytes?: (input: unknown) => Promise<{ ok: boolean; id?: string; error?: string }>;
  mediaUrl?: (id: string) => Promise<{ ok: boolean; url?: string; error?: string }>;
  mediaList?: (kind?: string, q?: string) => Promise<{ ok: boolean; assets: Array<{ id: string; kind: string; title: string; mime: string; status: string }>; error?: string }>;
  mediaGenerate?: (input: unknown) => Promise<{ ok: boolean; job?: { id: string }; error?: string }>;
  mediaJob?: (id: string) => Promise<{ ok: boolean; job?: { status: string; assetId: string | null; error: string | null; creditsCharged: number; model: string }; error?: string }>;
} }).glyphh ?? {};

// ── WAV encode (PCM16) — Save-as-New's output ────────────────────────────────

function encodeWav(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const n = channels[0]?.length ?? 0;
  const ch = channels.length || 1;
  const bytesPerSample = 2;
  const blockAlign = ch * bytesPerSample;
  const buf = new ArrayBuffer(44 + n * blockAlign);
  const dv = new DataView(buf);
  const wstr = (off: number, s: string): void => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  wstr(0, "RIFF"); dv.setUint32(4, 36 + n * blockAlign, true); wstr(8, "WAVE");
  wstr(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * blockAlign, true);
  dv.setUint16(32, blockAlign, true); dv.setUint16(34, 16, true);
  wstr(36, "data"); dv.setUint32(40, n * blockAlign, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, channels[c]![i] ?? 0));
      dv.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      off += 2;
    }
  }
  return buf;
}

/** "Dust Choir" → "Dust Choir - 01", next sibling → "- 02", … The base is
 *  the title with any existing "- NN" stripped; numbering scans all songs. */
function versionTitle(rawTitle: string, all: Array<{ title: string }>): string {
  const base = rawTitle.replace(/\s*-\s*\d{2,}$/, "").trim() || "Untitled";
  let max = 0;
  for (const s2 of all) {
    const m = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*-\\s*(\\d{2,})$`).exec(s2.title.trim());
    if (m) max = Math.max(max, parseInt(m[1]!, 10));
  }
  return `${base} - ${String(max + 1).padStart(2, "0")}`;
}

/** Common instruments — the "available" column of the instrument picker. */
const INSTRUMENT_CATALOG = [
  "drums", "trap hi-hats", "808 bass", "bass guitar", "electric guitar", "acoustic guitar",
  "slide guitar", "pedal steel", "banjo", "fiddle", "violin", "cello", "strings",
  "piano", "keys", "organ", "synth", "horns", "trumpet", "sax", "harmonica",
  "tambourine", "turntables", "beatbox", "choir",
];

import { officePager, officePage } from "./wb-office-ui.js";

interface DualItem { id: string; label: string; thumbAssetId?: string | null }

/** A searchable dual-column picker: available ⇄ selected with › ‹ » «.
 *  Click marks; the arrows move marked (or all). Order of `selected` is
 *  preserved and returned via onChange. */
function dualPicker(opts: {
  parent: HTMLElement;
  available: DualItem[];
  selected: string[];
  searchPlaceholder: string;
  onChange: (selected: string[]) => void;
  renderSelectedRow?: (id: string, row: HTMLElement) => void;
}): { repaint: () => void } {
  const wrap = document.createElement("div");
  wrap.className = "gmv-pickwrap";
  wrap.innerHTML = `
    <input class="office-search gmv-search" type="text" placeholder="${opts.searchPlaceholder}" spellcheck="false" autocomplete="off" />
    <div class="gmv-dual">
      <div class="gmv-col gmv-avail"></div>
      <div class="gmv-ctl">
        <button class="ws-icon-btn gmv-add" title="Add marked">›</button>
        <button class="ws-icon-btn gmv-addall" title="Add all shown">»</button>
        <button class="ws-icon-btn gmv-rem" title="Remove marked">‹</button>
        <button class="ws-icon-btn gmv-remall" title="Remove all">«</button>
      </div>
      <div class="gmv-col gmv-chosen gmv-rows"></div>
    </div>`;
  opts.parent.appendChild(wrap);
  const search = wrap.querySelector<HTMLInputElement>(".gmv-search")!;
  const availEl = wrap.querySelector<HTMLElement>(".gmv-avail")!;
  const chosenEl = wrap.querySelector<HTMLElement>(".gmv-chosen")!;
  const marked = new Set<string>();
  const selected = opts.selected;

  const chip = (item: DualItem, inChosen: boolean): HTMLElement => {
    const el = document.createElement("button");
    el.className = "gmv-pick" + (marked.has(item.id) ? " marked" : "");
    el.innerHTML = `<span class="gmv-pick-face"></span><span class="gmv-pick-name"></span>`;
    (el.querySelector(".gmv-pick-name") as HTMLElement).textContent = item.label;
    const face = el.querySelector<HTMLElement>(".gmv-pick-face")!;
    if (item.thumbAssetId) {
      void mediaUrlOf(item.thumbAssetId).then((u) => {
        if (u && face.isConnected) face.style.backgroundImage = `url("${u.replace(/"/g, "%22")}")`;
      });
    } else face.textContent = "♪";
    el.addEventListener("click", () => {
      if (marked.has(item.id)) marked.delete(item.id); else marked.add(item.id);
      el.classList.toggle("marked", marked.has(item.id));
    });
    void inChosen;
    return el;
  };

  const repaint = (): void => {
    const q = search.value.trim().toLowerCase();
    availEl.textContent = "";
    chosenEl.textContent = "";
    const chosenSet = new Set(selected);
    for (const item of opts.available.filter((x) => !chosenSet.has(x.id))) {
      if (q && !item.label.toLowerCase().includes(q)) continue;
      availEl.appendChild(chip(item, false));
    }
    for (const id of selected) {
      const item = opts.available.find((x) => x.id === id) ?? { id, label: id };
      if (opts.renderSelectedRow) {
        const row = document.createElement("div");
        row.className = "gmv-selrow";
        const c = chip(item, true);
        row.appendChild(c);
        opts.renderSelectedRow(id, row);
        chosenEl.appendChild(row);
      } else {
        chosenEl.appendChild(chip(item, true));
      }
    }
  };
  const shownAvail = (): string[] => {
    const q = search.value.trim().toLowerCase();
    const chosenSet = new Set(selected);
    return opts.available.filter((x) => !chosenSet.has(x.id) && (!q || x.label.toLowerCase().includes(q))).map((x) => x.id);
  };
  const commit = (): void => { marked.clear(); repaint(); opts.onChange([...selected]); };
  wrap.querySelector(".gmv-add")?.addEventListener("click", () => {
    for (const id of shownAvail()) if (marked.has(id)) selected.push(id);
    commit();
  });
  wrap.querySelector(".gmv-addall")?.addEventListener("click", () => {
    for (const id of shownAvail()) selected.push(id);
    commit();
  });
  wrap.querySelector(".gmv-rem")?.addEventListener("click", () => {
    for (let i = selected.length - 1; i >= 0; i--) if (marked.has(selected[i]!)) selected.splice(i, 1);
    commit();
  });
  wrap.querySelector(".gmv-remall")?.addEventListener("click", () => {
    selected.length = 0;
    commit();
  });
  search.addEventListener("input", repaint);
  repaint();
  return { repaint };
}

const mediaUrlCache2 = new Map<string, string | null>();
async function mediaUrlOf(id: string): Promise<string | null> {
  if (mediaUrlCache2.has(id)) return mediaUrlCache2.get(id) ?? null;
  const r = await api().mediaUrl?.(id);
  const u = r?.ok && r.url ? r.url : null;
  mediaUrlCache2.set(id, u);
  return u;
}

// ── the panel ────────────────────────────────────────────────────────────────

export interface MusicViews {
  renderSongs: (pane: HTMLElement, state: MusicState, refresh: () => void) => Promise<void>;
  renderArtists: (pane: HTMLElement, state: MusicState, refresh: () => void) => Promise<void>;
  renderInstruments: (pane: HTMLElement, state: MusicState, refresh: () => void) => Promise<void>;
  renderMusicVideo: (pane: HTMLElement, state: MusicState, refresh: () => void) => Promise<void>;
  dispose: () => void;
}

export interface BandSlotState {
  id: number;
  tab?: number;
  music?: MusicState;
}

export interface BandPanel {
  renderIntoSlot: (body: HTMLElement, slot: BandSlotState, wrap: HTMLElement) => Promise<void>;
  invalidate: () => void;
}

/** GLYPHH BAND — the standalone studio app: Songs · Artists · Music Video.
 *  (Sounds keeps the raw library; every take still lands there.) */
export function initBand(host: MusicHost): BandPanel {
  const views = initMusic(host);
  async function renderIntoSlot(body: HTMLElement, slot: BandSlotState, wrap: HTMLElement): Promise<void> {
    try {
      body.classList.add("ws-gband-body");
      const titleEl = wrap.querySelector(".ws-rail-slot-header .title");
      if (titleEl) titleEl.textContent = "Band";
      const refresh = (): void => { if (body.isConnected) void renderIntoSlot(body, slot, wrap); };
      const tab = slot.tab ?? 0;
      body.innerHTML = `<div class="gmus-shell"><div class="gmem-tabs gmus-tabs"></div><div class="gmus-pane"></div></div>`;
      const tabs = body.querySelector<HTMLElement>(".gmus-tabs")!;
      ["Songs", "Artists", "Instruments", "Music Video"].forEach((name, i) => {
        const b = document.createElement("button");
        b.className = "gmem-tab" + (i === tab ? " on" : "");
        b.textContent = name;
        b.addEventListener("click", () => { slot.tab = i; refresh(); });
        tabs.appendChild(b);
      });
      const pane = body.querySelector<HTMLElement>(".gmus-pane")!;
      slot.music ??= {};
      if (tab === 1) { await views.renderArtists(pane, slot.music, refresh); return; }
      if (tab === 2) { await views.renderInstruments(pane, slot.music, refresh); return; }
      if (tab === 3) { await views.renderMusicVideo(pane, slot.music, refresh); return; }
      await views.renderSongs(pane, slot.music, refresh);
    } catch (err) {
      console.warn("[gband] render failed:", err);
      if (body.isConnected) {
        body.innerHTML = `<div class="gdoc-empty">Band hit an error rendering.<br><code class="gpoint-err"></code></div>`;
        const code = body.querySelector(".gpoint-err");
        if (code) // The MESSAGE alone made every null-deref look identical (his report,
        // 2026-08-28) — the top stack frames name the actual line.
        code.textContent = err instanceof Error ? `${err.message}\n${(err.stack || "").split("\n").slice(1, 4).join("\n")}` : String(err);
      }
    }
  }
  return { renderIntoSlot, invalidate: views.dispose };
}

export function initMusic(host: MusicHost): MusicViews {
  let audioCtx: AudioContext | null = null;
  let liveSource: AudioBufferSourceNode | null = null;
  let raf = 0;
  const ctxOf = (): AudioContext => (audioCtx ??= new AudioContext());
  const stopPlayback = (): void => {
    try { liveSource?.stop(); } catch { /* already stopped */ }
    liveSource = null;
    cancelAnimationFrame(raf);
  };

  /** Every Band list rides this: toolbar (count · SEARCH · ＋New), the PAGER
   *  at the top, then the rows — filtered live, 20 a page, cursor kept. */
  const LIST_PER = 20;
  function listShell<T>(pane: HTMLElement, state: MusicState, cfg: {
    key: string;
    noun: string;
    newLabel: string;
    onNew: () => void;
    searchPh: string;
    emptyText: string;
    items: T[];
    match: (item: T, q: string) => boolean;
    row: (item: T) => HTMLElement;
    rowsClass?: string;
  }): void {
    pane.innerHTML = `
      <div class="gmus-list">
        <div class="office-toolbar">
          <span class="gmus-count"></span>
          <input class="office-search" type="text" placeholder="${cfg.searchPh}" spellcheck="false" autocomplete="off" />
          <button class="action-btn primary gmus-new">${cfg.newLabel}</button>
        </div>
        <div class="gmus-pager-top"></div>
        <div class="${cfg.rowsClass ?? "gmus-songs"}"></div>
        <div class="gdoc-empty hidden">${cfg.emptyText}</div>
      </div>`;
    pane.querySelector(".gmus-new")?.addEventListener("click", cfg.onNew);
    const count = pane.querySelector<HTMLElement>(".gmus-count")!;
    const pagerTop = pane.querySelector<HTMLElement>(".gmus-pager-top")!;
    const rows = pane.querySelector<HTMLElement>(`.${cfg.rowsClass ?? "gmus-songs"}`)!;
    const empty = pane.querySelector<HTMLElement>(".gdoc-empty")!;
    const search = pane.querySelector<HTMLInputElement>(".office-search")!;
    state.pages ??= {};
    const paint = (q: string): void => {
      rows.textContent = "";
      pagerTop.textContent = "";
      const ql = q.toLowerCase();
      const matches = cfg.items.filter((it) => !ql || cfg.match(it, ql));
      count.textContent = `${matches.length} ${cfg.noun}${matches.length === 1 ? "" : "s"}`;
      empty.classList.toggle("hidden", matches.length > 0 || cfg.items.length > 0);
      if (!cfg.items.length) empty.classList.remove("hidden");
      const paged = officePage(matches, ql ? 0 : (state.pages![cfg.key] ?? 0), LIST_PER);
      if (!ql) state.pages![cfg.key] = paged.page;
      const pager = officePager(matches.length, paged.page, LIST_PER, (pg) => { state.pages![cfg.key] = pg; paint(q); });
      if (pager) pagerTop.appendChild(pager);
      for (const it of paged.items) rows.appendChild(cfg.row(it));
    };
    paint("");
    search.addEventListener("input", () => paint(search.value.trim()));
  }

  // ── Songs list + the song page ─────────────────────────────────────────────

  async function renderSongs(pane: HTMLElement, state: MusicState, refresh: () => void): Promise<void> {
    stopPlayback();
    if (state.songId) { await renderSongPage(pane, state, refresh); return; }
    const res = await api().musicSongs?.();
    const songs = res?.ok ? res.songs : [];
    const children = new Map<string, number>();
    for (const s of songs) if (s.parentId) children.set(s.parentId, (children.get(s.parentId) ?? 0) + 1);
    listShell(pane, state, {
      key: "songs", noun: "song", newLabel: "＋ New Song", searchPh: "Search songs…",
      emptyText: "No songs yet — ＋ New Song assembles a band, or ask Glyphh to write one.",
      items: songs,
      match: (s, q) => s.title.toLowerCase().includes(q) || s.bandType.toLowerCase().includes(q) || s.lyrics.toLowerCase().includes(q),
      onNew: () => {
        void (async () => {
          const r = await api().musicSongSave?.(null, { title: "Untitled" });
          if (!r?.ok || !r.song) {
            void host.confirm({ title: "Couldn't create the song", body: r?.error ?? (api().musicSongSave ? "Unknown error." : "Bridge not loaded — quit and relaunch the app."), confirmLabel: "OK" });
            return;
          }
          state.songId = r.song.id;
          refresh();
        })();
      },
      row: (s) => {
      const card = document.createElement("button");
      card.className = "gmus-song-card";
      card.innerHTML = `
        <span class="gmus-song-title"></span>
        <span class="gmus-song-meta"></span>
        <span class="gmus-song-badges">${s.audioAssetId ? "♫" : "·"}${s.parentId ? " ↳" : ""}${children.get(s.id) ? ` ${children.get(s.id)}v` : ""}</span>
        <span class="ws-icon-btn gmem-del gmus-song-del" title="Delete song">✕</span>`;
      (card.querySelector(".gmus-song-title") as HTMLElement).textContent = s.title;
      (card.querySelector(".gmus-song-meta") as HTMLElement).textContent =
        [s.bandType, s.model ? s.model.split("::")[1] : ""].filter(Boolean).join(" · ") || "no band yet";
      card.addEventListener("click", (ev) => {
        if ((ev.target as HTMLElement).closest(".gmus-song-del")) return;
        state.songId = s.id;
        refresh();
      });
      card.querySelector(".gmus-song-del")?.addEventListener("click", () => {
        void (async () => {
          const versions = children.get(s.id) ?? 0;
          const yes = await host.confirm({
            title: `Delete "${s.title}"?`,
            body: `The song document goes for good${versions ? ` — its ${versions} child version${versions === 1 ? "" : "s"} stay but lose the link` : ""}. The audio stays in the Sounds library.`,
            confirmLabel: "Delete", danger: true,
          });
          if (!yes) return;
          await api().musicSongDelete?.(s.id);
          refresh();
        })();
      });
        return card;
      },
    });
  }

  async function renderSongPage(pane: HTMLElement, state: MusicState, refresh: () => void): Promise<void> {
    const res = await api().musicSongs?.();
    const song = (res?.ok ? res.songs : []).find((s) => s.id === state.songId);
    if (!song) { delete state.songId; refresh(); return; }
    const artistsRes = await api().musicArtists?.();
    const artists = artistsRes?.ok ? artistsRes.artists : [];

    pane.innerHTML = `
      <div class="gmus-page">
        <div class="gdz-topbar">
          <button class="action-btn gmus-back">‹ Songs</button>
          <span class="gmus-savestate"></span>
          <select class="gdz-select gmus-length" title="Song length">
            <option value="">Auto length</option>
            <option value="60">1:00</option>
            <option value="120">2:00</option>
            <option value="180">3:00</option>
            <option value="240">4:00</option>
            <option value="300">5:00</option>
          </select>
          <button class="action-btn gmus-savenew" title="Encode the edited audio as a NEW take">Save as New</button>
          <button class="action-btn primary gmus-regen" title="Run the music model with the prompt + band + lyrics — a first take fills this song; later runs create child versions">Regenerate</button>
        </div>
        <div class="gmus-team"></div>
        <div class="gmus-split">
          <div class="gmus-left">
            <label class="gmus-label">Title</label>
            <input class="gmus-title" spellcheck="false" />
            <label class="gmus-label">Lyrics</label>
            <textarea class="gmus-lyrics" spellcheck="true" placeholder="Verse one…"></textarea>
            <label class="gmus-label">Prompt <span class="gmem-hint">what made the song — edit it, then Regenerate</span></label>
            <textarea class="gmus-prompt" spellcheck="false" placeholder="dusty desert blues, slide guitar, slow burn…"></textarea>
            <label class="gmus-label">Band</label>
            <input class="gmus-bandtype" spellcheck="false" placeholder="type of band — 'three-piece garage rock', 'bluegrass quartet'…" />
            <label class="gmus-label">Members <span class="gmem-hint">library left · in the band right</span></label>
            <div class="gmus-members-pick"></div>
            <label class="gmus-label">Instruments <span class="gmem-hint">catalog left · in the band right (tweak each)</span></label>
            <div class="gmus-instruments-pick"></div>
            <label class="gmus-label gmus-videos-label hidden">Videos</label>
            <div class="gmus-videos"></div>
          </div>
          <div class="gmus-right">
            <div class="gmus-wave-bar">
              <button class="ws-icon-btn gmus-play" title="Play / pause">▶</button>
              <span class="gmus-time">0:00</span>
              <span class="gmus-tools">
                <button class="action-btn gmus-cut" title="Cut the selection">Cut</button>
                <button class="action-btn gmus-copy" title="Copy the selection">Copy</button>
                <button class="action-btn gmus-paste" title="Paste at the playhead">Paste</button>
                <button class="action-btn gmus-undo" title="Undo">Undo</button>
              </span>
              <select class="gdz-select gmus-interval" title="Bar interval">
                <option value="0.05">50 ms</option>
                <option value="0.1" selected>100 ms</option>
                <option value="0.25">250 ms</option>
                <option value="1">1 s</option>
              </select>
              <button class="ws-icon-btn gmus-zoom-out" title="Zoom out">−</button>
              <button class="ws-icon-btn gmus-zoom-in" title="Zoom in">＋</button>
            </div>
            <div class="gmus-wave-wrap"><canvas class="gmus-wave"></canvas></div>
            <div class="gmus-wave-hint">drag selects · click sets the playhead · cut/copy/paste edit the take</div>
          </div>
        </div>
      </div>`;
    pane.querySelector(".gmus-back")?.addEventListener("click", () => { stopPlayback(); delete state.songId; refresh(); });

    const saveState = pane.querySelector<HTMLElement>(".gmus-savestate")!;
    const titleIn = pane.querySelector<HTMLInputElement>(".gmus-title")!;
    const lyricsIn = pane.querySelector<HTMLTextAreaElement>(".gmus-lyrics")!;
    const promptIn = pane.querySelector<HTMLTextAreaElement>(".gmus-prompt")!;
    titleIn.value = song.title;
    lyricsIn.value = song.lyrics;
    promptIn.value = song.prompt;
    // ── the band assembler — dual-column pickers; every change autosaves ─────
    const bandTypeIn = pane.querySelector<HTMLInputElement>(".gmus-bandtype")!;
    bandTypeIn.value = song.bandType;
    const saveBand = (): void => {
      void api().musicSongSave?.(song.id, {
        bandType: song.bandType, artistIds: song.artistIds, instruments: song.instruments,
      });
      paintTeam();
    };
    bandTypeIn.addEventListener("change", () => { song.bandType = bandTypeIn.value.trim(); saveBand(); });

    // ── THE SONG'S VIDEOS (his report, 2026-08-27): song.visuals held the
    // attached music videos but NOTHING rendered them — the agent's "linked
    // the video to the band" was invisible. A strip of playable thumbs. ──
    {
      const strip = pane.querySelector<HTMLElement>(".gmus-videos")!;
      const label = pane.querySelector<HTMLElement>(".gmus-videos-label");
      const vids = Array.isArray(song.visuals) ? song.visuals : [];
      if (vids.length) label?.classList.remove("hidden");
      for (const vid of vids) {
        const cell = document.createElement("video");
        cell.className = "gmus-video-cell";
        cell.controls = true;
        cell.preload = "metadata";
        void mediaUrlOf(vid).then((u) => { if (u) cell.src = u; });
        strip.appendChild(cell);
      }
    }

    // THE SONG TEAM — every member and instrument, faces first, above the song.
    const teamEl = pane.querySelector<HTMLElement>(".gmus-team")!;
    const paintTeam = (): void => {
      teamEl.textContent = "";
      for (const aid of song.artistIds) {
        const a2 = artists.find((x) => x.id === aid);
        if (!a2) continue;
        const m2 = document.createElement("div");
        m2.className = "gmus-team-member";
        m2.title = a2.style || a2.name;
        m2.innerHTML = `<span class="gmus-team-face">♪</span><span class="gmus-team-name"></span>`;
        (m2.querySelector(".gmus-team-name") as HTMLElement).textContent = a2.name;
        const face = m2.querySelector<HTMLElement>(".gmus-team-face")!;
        if (a2.avatarAssetId) {
          void mediaUrlOf(a2.avatarAssetId).then((u) => {
            if (u && face.isConnected) { face.textContent = ""; face.style.backgroundImage = `url("${u.replace(/"/g, "%22")}")`; }
          });
        }
        teamEl.appendChild(m2);
      }
      for (const inst of song.instruments) {
        const m2 = document.createElement("div");
        m2.className = "gmus-team-member gmus-team-inst";
        m2.title = inst.tweak || inst.instrument;
        m2.innerHTML = `<span class="gmus-team-face">🎸</span><span class="gmus-team-name"></span>`;
        (m2.querySelector(".gmus-team-name") as HTMLElement).textContent = inst.instrument;
        const face = m2.querySelector<HTMLElement>(".gmus-team-face")!;
        if (inst.lookAssetId) {
          void mediaUrlOf(inst.lookAssetId).then((u) => {
            if (u && face.isConnected) { face.textContent = ""; face.style.backgroundImage = `url("${u.replace(/"/g, "%22")}")`; }
          });
        }
        teamEl.appendChild(m2);
      }
      if (!teamEl.childNodes.length) {
        teamEl.innerHTML = `<span class="gmem-hint">the Song team assembles here — add members and instruments below</span>`;
      }
    };
    paintTeam();

    // Members — searchable dual columns over the org roster.
    dualPicker({
      parent: pane.querySelector<HTMLElement>(".gmus-members-pick")!,
      available: artists.map((a2) => ({ id: a2.id, label: a2.name, thumbAssetId: a2.avatarAssetId })),
      selected: song.artistIds,
      searchPlaceholder: "Search artists…",
      onChange: (sel) => { song.artistIds = sel; saveBand(); },
    });

    // Instruments — the ORG LIBRARY left (looks included; the Instruments tab
    // curates it), the band's right; each selected row keeps its tweak line.
    const libRes = await api().musicInstruments?.();
    const lib = libRes?.ok ? libRes.instruments : [];
    const libThumb = (li: LibInstrument): string | null => {
      const looks = (li.meta?.looks as Array<{ assetId: string }> | undefined) ?? [];
      return looks[(li.meta?.activeLook as number | undefined) ?? 0]?.assetId ?? looks[0]?.assetId ?? null;
    };
    const instSelected = song.instruments.map((i) => i.instrument);
    const instPicker = dualPicker({
      parent: pane.querySelector<HTMLElement>(".gmus-instruments-pick")!,
      available: [
        ...lib.map((li) => ({ id: li.name, label: li.name, thumbAssetId: libThumb(li) })),
        ...INSTRUMENT_CATALOG.filter((n) => !lib.some((li) => li.name === n)).map((n) => ({ id: n, label: n })),
        ...song.instruments.filter((i) => !INSTRUMENT_CATALOG.includes(i.instrument) && !lib.some((li) => li.name === i.instrument)).map((i) => ({ id: i.instrument, label: i.instrument })),
      ],
      selected: instSelected,
      searchPlaceholder: "Search instruments…",
      onChange: (sel) => {
        song.instruments = sel.map((name) => {
          const existing = song.instruments.find((i) => i.instrument === name);
          if (existing) return existing;
          const li = lib.find((x) => x.name === name);
          return { instrument: name, tweak: li?.description ?? "", ...(li && libThumb(li) ? { lookAssetId: libThumb(li) } : {}) };
        });
        saveBand();
      },
      renderSelectedRow: (id, row) => {
        const inst = song.instruments.find((i) => i.instrument === id) ?? { instrument: id, tweak: "" };
        const tweak = document.createElement("input");
        tweak.className = "gmus-a-style gmv-tweak";
        tweak.placeholder = "tweak — 'tight, dry, 90s'";
        tweak.value = inst.tweak;
        tweak.spellcheck = false;
        tweak.addEventListener("click", (ev) => ev.stopPropagation());
        tweak.addEventListener("change", () => { inst.tweak = tweak.value.trim(); saveBand(); });
        row.appendChild(tweak);
        const gen = document.createElement("button");
        gen.className = "ws-icon-btn";
        gen.title = "Generate a look image (costs credits)";
        gen.textContent = "⟳";
        gen.addEventListener("click", (ev) => {
          ev.stopPropagation();
          void (async () => {
            gen.classList.add("busy");
            const models = ["openai::gpt-image-1", "blackforest::flux-pro-1.1", "xai::grok-2-image-1212", "google::gemini-3-pro-image"];
            for (const m3 of models) {
              const started = await api().mediaGenerate?.({ model: m3, prompt: `Photorealistic product photograph of a ${inst.instrument}${inst.tweak ? `, ${inst.tweak}` : ""}, for a ${bandTypeIn.value.trim() || "rock"} band, dark stage backdrop, dramatic lighting`, title: `${inst.instrument} — look` });
              if (!started?.ok || !started.job) continue;
              for (;;) {
                await new Promise((r2) => setTimeout(r2, 2500));
                const poll = await api().mediaJob?.(started.job.id);
                if (!poll?.ok || !poll.job || poll.job.status === "failed") break;
                if (poll.job.status === "succeeded") { inst.lookAssetId = poll.job.assetId; saveBand(); break; }
              }
              break;
            }
            gen.classList.remove("busy");
            instPicker.repaint();
          })();
        });
        row.appendChild(gen);
      },
    });

    const bandNames = song.artistIds.map((id) => artists.find((a2) => a2.id === id)?.name).filter(Boolean).join(", ");

    // Doc autosave (700ms trailing) — the same local-first pattern as Sheets.
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const saveDoc = (): void => {
      if (saveTimer) clearTimeout(saveTimer);
      saveState.textContent = "…";
      saveTimer = setTimeout(() => {
        void (async () => {
          const r = await api().musicSongSave?.(song.id, {
            title: titleIn.value.trim() || "Untitled",
            lyrics: lyricsIn.value,
            prompt: promptIn.value,
          });
          saveState.textContent = r?.ok ? "Saved" : `⚠ ${r?.error ?? "save failed"}`;
        })();
      }, 700);
    };
    titleIn.addEventListener("input", saveDoc);
    lyricsIn.addEventListener("input", saveDoc);
    promptIn.addEventListener("input", saveDoc);

    // ── the editor state ─────────────────────────────────────────────────────
    const canvas = pane.querySelector<HTMLCanvasElement>(".gmus-wave")!;
    const waveWrap = pane.querySelector<HTMLElement>(".gmus-wave-wrap")!;
    let buffer: AudioBuffer | null = null;
    let clipboard: Float32Array[] | null = null;
    const undoStack: Float32Array[][] = [];
    let interval = 0.1;   // seconds per bar
    let zoom = 1;         // px per bar multiplier
    let sel: { a: number; b: number } | null = null; // seconds
    let playhead = 0;     // seconds
    let playing = false;
    let playStartCtx = 0, playStartPos = 0;

    const channelsOf = (b: AudioBuffer): Float32Array[] =>
      Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c).slice());
    const bufferFrom = (chs: Float32Array[], rate: number): AudioBuffer => {
      const nb = ctxOf().createBuffer(chs.length, chs[0]!.length, rate);
      chs.forEach((ch, i) => nb.copyToChannel(ch as Float32Array<ArrayBuffer>, i));
      return nb;
    };

    const draw = (): void => {
      const wrapW = waveWrap.clientWidth || 600;
      const h = waveWrap.clientHeight || 220;
      if (!buffer) {
        canvas.width = wrapW; canvas.height = h;
        const g = canvas.getContext("2d")!;
        g.clearRect(0, 0, wrapW, h);
        g.fillStyle = "rgba(175,95,255,0.35)";
        g.font = "12px sans-serif";
        g.fillText(song.audioAssetId ? "decoding…" : "no take yet — generating attaches it here when it lands (refresh)", 14, h / 2);
        return;
      }
      const barW = Math.max(2, 4 * zoom);
      const gap = 1;
      const bars = Math.ceil(buffer.duration / interval);
      const width = Math.max(wrapW, bars * (barW + gap));
      canvas.width = width; canvas.height = h;
      const g = canvas.getContext("2d")!;
      g.clearRect(0, 0, width, h);
      const data = buffer.getChannelData(0);
      const perBar = Math.max(1, Math.floor(buffer.sampleRate * interval));
      for (let i = 0; i < bars; i++) {
        let peak = 0;
        const start = i * perBar;
        const end = Math.min(data.length, start + perBar);
        for (let j = start; j < end; j += 16) peak = Math.max(peak, Math.abs(data[j] ?? 0));
        const bh = Math.max(2, peak * (h - 16));
        const x = i * (barW + gap);
        const t = i * interval;
        const inSel = sel && t >= Math.min(sel.a, sel.b) && t <= Math.max(sel.a, sel.b);
        g.fillStyle = inSel ? "#ec4899" : "#af5fff";
        g.globalAlpha = inSel ? 0.95 : 0.8;
        g.fillRect(x, (h - bh) / 2, barW, bh);
      }
      g.globalAlpha = 1;
      const px = (playhead / interval) * (barW + gap);
      g.fillStyle = "#f5f5f7";
      g.fillRect(px, 0, 1.5, h);
    };

    const timeEl = pane.querySelector<HTMLElement>(".gmus-time")!;
    const fmtT = (t: number): string => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
    const tick = (): void => {
      if (playing && buffer) {
        playhead = Math.min(buffer.duration, playStartPos + (ctxOf().currentTime - playStartCtx));
        if (playhead >= buffer.duration) togglePlay(false);
      }
      timeEl.textContent = `${fmtT(playhead)}${buffer ? ` / ${fmtT(buffer.duration)}` : ""}`;
      draw();
      raf = requestAnimationFrame(tick);
    };

    const playBtn = pane.querySelector<HTMLElement>(".gmus-play")!;
    const togglePlay = (want?: boolean): void => {
      const next = want ?? !playing;
      stopPlayback();
      playing = next && !!buffer;
      playBtn.textContent = playing ? "⏸" : "▶";
      if (playing && buffer) {
        const src = ctxOf().createBufferSource();
        src.buffer = buffer;
        src.connect(ctxOf().destination);
        src.start(0, playhead);
        liveSource = src;
        playStartCtx = ctxOf().currentTime;
        playStartPos = playhead;
      }
      raf = requestAnimationFrame(tick);
    };
    playBtn.addEventListener("click", () => togglePlay());

    // selection + playhead on the canvas
    let dragStart: number | null = null;
    const timeAt = (clientX: number): number => {
      const rect = canvas.getBoundingClientRect();
      const barW = Math.max(2, 4 * zoom) + 1;
      return Math.max(0, ((clientX - rect.left) / barW) * interval);
    };
    canvas.addEventListener("mousedown", (ev) => { dragStart = timeAt(ev.clientX); sel = null; });
    window.addEventListener("mousemove", (ev) => {
      if (dragStart === null) return;
      const t = timeAt(ev.clientX);
      if (Math.abs(t - dragStart) > interval / 2) sel = { a: dragStart, b: t };
    });
    window.addEventListener("mouseup", (ev) => {
      if (dragStart === null) return;
      const t = timeAt(ev.clientX);
      if (!sel) playhead = Math.min(buffer?.duration ?? 0, t);
      dragStart = null;
    });

    const pushUndo = (): void => {
      if (!buffer) return;
      undoStack.push(channelsOf(buffer));
      if (undoStack.length > 6) undoStack.shift();
    };
    const applyChannels = (chs: Float32Array[]): void => {
      buffer = bufferFrom(chs, buffer!.sampleRate);
      sel = null;
      playhead = Math.min(playhead, buffer.duration);
      saveState.textContent = "edited — Save as New keeps it";
    };
    const selRange = (): [number, number] | null => {
      if (!buffer || !sel) return null;
      const a = Math.max(0, Math.min(sel.a, sel.b));
      const b = Math.min(buffer.duration, Math.max(sel.a, sel.b));
      return b - a < 0.01 ? null : [Math.floor(a * buffer.sampleRate), Math.floor(b * buffer.sampleRate)];
    };
    pane.querySelector(".gmus-copy")?.addEventListener("click", () => {
      const r = selRange();
      if (!r || !buffer) return;
      clipboard = channelsOf(buffer).map((ch) => ch.slice(r[0], r[1]));
    });
    pane.querySelector(".gmus-cut")?.addEventListener("click", () => {
      const r = selRange();
      if (!r || !buffer) return;
      pushUndo();
      const chs = channelsOf(buffer);
      clipboard = chs.map((ch) => ch.slice(r[0], r[1]));
      applyChannels(chs.map((ch) => {
        const out = new Float32Array(ch.length - (r[1] - r[0]));
        out.set(ch.subarray(0, r[0]), 0);
        out.set(ch.subarray(r[1]), r[0]);
        return out;
      }));
    });
    pane.querySelector(".gmus-paste")?.addEventListener("click", () => {
      if (!buffer || !clipboard?.length) return;
      pushUndo();
      const at = Math.floor(playhead * buffer.sampleRate);
      const chs = channelsOf(buffer);
      applyChannels(chs.map((ch, c) => {
        const clip = clipboard![Math.min(c, clipboard!.length - 1)]!;
        const out = new Float32Array(ch.length + clip.length);
        out.set(ch.subarray(0, at), 0);
        out.set(clip, at);
        out.set(ch.subarray(at), at + clip.length);
        return out;
      }));
    });
    pane.querySelector(".gmus-undo")?.addEventListener("click", () => {
      const prev = undoStack.pop();
      if (prev && buffer) applyChannels(prev);
    });
    pane.querySelector<HTMLSelectElement>(".gmus-interval")?.addEventListener("change", (ev) => {
      interval = Number((ev.target as HTMLSelectElement).value) || 0.1;
    });
    pane.querySelector(".gmus-zoom-in")?.addEventListener("click", () => { zoom = Math.min(8, zoom * 1.4); });
    pane.querySelector(".gmus-zoom-out")?.addEventListener("click", () => { zoom = Math.max(0.4, zoom / 1.4); });

    const regenBtn = pane.querySelector<HTMLButtonElement>(".gmus-regen")!;
    regenBtn.textContent = song.audioAssetId ? "Regenerate" : "Generate";
    const saveNewBtn = pane.querySelector<HTMLButtonElement>(".gmus-savenew")!;
    const setBusy = (busy: boolean, label?: string): void => {
      regenBtn.disabled = busy;
      saveNewBtn.disabled = busy;
      regenBtn.classList.toggle("busy", busy);
      regenBtn.innerHTML = busy ? `<span class="gmus-spin"></span>${label ?? "Generating…"}` : (song.audioAssetId ? "Regenerate" : "Generate");
    };

    // Save as New — encode the edited take, land it, version the song.
    pane.querySelector(".gmus-savenew")?.addEventListener("click", () => {
      void (async () => {
        if (!buffer) { void host.confirm({ title: "Nothing to save", body: "There is no audio take loaded.", confirmLabel: "OK" }); return; }
        setBusy(true, "Saving…");
        saveState.textContent = "encoding…";
        const all = await api().musicSongs?.();
        const vTitle = versionTitle(titleIn.value.trim() || "Untitled", all?.ok ? all.songs : []);
        const wav = encodeWav(channelsOf(buffer), buffer.sampleRate);
        const up = await api().mediaUploadBytes?.({
          title: vTitle,
          kind: "audio", mime: "audio/wav", bytes: wav,
          meta: { songId: song.id, edited: true },
        });
        if (!up?.ok || !up.id) { saveState.textContent = `⚠ ${up?.error ?? "upload failed"}`; setBusy(false); return; }
        const created = await api().musicSongSave?.(null, {
          title: vTitle,
          lyrics: lyricsIn.value, prompt: promptIn.value,
          bandType: song.bandType, artistIds: song.artistIds, instruments: song.instruments,
          audioAssetId: up.id, parentId: song.id, model: song.model,
        });
        setBusy(false);
        if (created?.ok && created.song) { stopPlayback(); state.songId = created.song.id; refresh(); }
      })();
    });

    // Regenerate — SERVER-SIDE: the child version exists immediately and the
    // take attaches on job success even if this panel dies. We jump to the
    // child and poll the job for the credits line.
    pane.querySelector(".gmus-regen")?.addEventListener("click", () => {
      void (async () => {
        if (!promptIn.value.trim() && !lyricsIn.value.trim()) {
          void host.confirm({ title: "Nothing to regenerate from", body: "Give it a prompt (and lyrics) first.", confirmLabel: "OK" });
          return;
        }
        setBusy(true);
        saveState.textContent = "generating…";
        // Flush any pending doc edits first so the brief reads them.
        await api().musicSongSave?.(song.id, {
          title: titleIn.value.trim() || "Untitled",
          lyrics: lyricsIn.value,
          prompt: promptIn.value,
        });
        const secsRaw = pane.querySelector<HTMLSelectElement>(".gmus-length")?.value;
        const started = await api().musicSongRegenerate?.(song.id, secsRaw ? { seconds: Number(secsRaw) } : {});
        if (!started?.ok || !started.song || !started.job) {
          saveState.textContent = `⚠ ${started?.error ?? "couldn't start"}`;
          setBusy(false);
          return;
        }
        const childId = started.song.id;
        const jobId = started.job.id;
        for (;;) {
          await new Promise((r2) => setTimeout(r2, 2500));
          const poll = await api().mediaJob?.(jobId);
          if (!poll?.ok || !poll.job) { setBusy(false); break; }
          if (poll.job.status === "failed") { saveState.textContent = `⚠ ${poll.job.error ?? "generation failed"}`; setBusy(false); break; }
          if (poll.job.status === "succeeded") {
            saveState.textContent = `done — ${poll.job.creditsCharged.toFixed(2)} credits`;
            setBusy(false);
            stopPlayback();
            state.songId = childId;
            refresh();
            return;
          }
          if (!pane.isConnected) return; // the server finishes + attaches regardless
        }
      })();
    });

    // load + decode    // load + decode the current take
    raf = requestAnimationFrame(tick);
    if (song.audioAssetId) {
      const u = await api().mediaUrl?.(song.audioAssetId);
      if (u?.ok && u.url && pane.isConnected) {
        try {
          const bytes = await (await fetch(u.url)).arrayBuffer();
          buffer = await ctxOf().decodeAudioData(bytes);
        } catch (err) {
          console.warn("[gmus] decode failed:", err);
        }
      }
    }
  }

  // ── Artists ────────────────────────────────────────────────────────────────

  async function renderArtists(pane: HTMLElement, state: MusicState, refresh: () => void): Promise<void> {
    stopPlayback();
    if (state.artistId !== undefined) { await renderArtistPage(pane, state, refresh); return; }
    const res = await api().musicArtists?.();
    const artists = res?.ok ? res.artists : [];
    listShell(pane, state, {
      key: "artists", noun: "artist", newLabel: "＋ New Artist", searchPh: "Search artists…",
      emptyText: "No artists yet — a singer is a NAME, a LOOK and a VOICE.",
      items: artists, rowsClass: "gmus-artists",
      match: (a, q) => a.name.toLowerCase().includes(q) || a.style.toLowerCase().includes(q),
      onNew: () => { state.artistId = null; refresh(); },
      row: (a) => {
      const row = document.createElement("button");
      row.className = "gmus-artist-card";
      row.innerHTML = `
        <div class="gmus-artist-face">♪</div>
        <div class="gmus-artist-main">
          <span class="gmus-artist-name"></span>
          <span class="gmus-artist-style"></span>
          <span class="gmus-artist-badges"></span>
        </div>
        <span class="ws-icon-btn gmem-del gmus-artist-del" title="Delete"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></span>`;
      (row.querySelector(".gmus-artist-name") as HTMLElement).textContent = a.name;
      (row.querySelector(".gmus-artist-style") as HTMLElement).textContent = a.style || "—";
      const looks = (a.meta?.looks as Array<{ front: string; back: string }> | undefined) ?? [];
      (row.querySelector(".gmus-artist-badges") as HTMLElement).textContent =
        [looks.length ? `${looks.length} look${looks.length === 1 ? "" : "s"}` : "no looks",
         a.voiceAssetId ? "voice sample" : a.voiceId ? "synth voice" : "no voice"].join(" · ");
      if (a.avatarAssetId) {
        const face = row.querySelector<HTMLElement>(".gmus-artist-face")!;
        void api().mediaUrl?.(a.avatarAssetId).then((r) => {
          if (r?.ok && r.url && face.isConnected) {
            face.textContent = "";
            face.style.backgroundImage = `url("${r.url.replace(/"/g, "%22")}")`;
          }
        });
      }
      row.addEventListener("click", (ev) => {
        if ((ev.target as HTMLElement).closest(".gmus-artist-del")) return;
        state.artistId = a.id;
        refresh();
      });
      row.querySelector(".gmus-artist-del")?.addEventListener("click", () => {
        void (async () => {
          const yes = await host.confirm({ title: `Delete "${a.name}"?`, confirmLabel: "Delete", danger: true });
          if (!yes) return;
          await api().musicArtistDelete?.(a.id);
          refresh();
        })();
      });
        return row;
      },
    });
  }

  /** THE ARTIST PAGE — ‹ Artists on top; identity on the left, the LOOKS
   *  gallery on the right (front+back large, click to fill the panel,
   *  per-look ⟳ regenerate, ＋ New look). New artists use the same page. */
  async function renderArtistPage(pane: HTMLElement, state: MusicState, refresh: () => void): Promise<void> {
    const isNew = state.artistId === null;
    const res = isNew ? null : await api().musicArtists?.();
    const artist = isNew ? null : (res?.ok ? res.artists : []).find((x) => x.id === state.artistId);
    if (!isNew && !artist) { delete state.artistId; refresh(); return; }

    pane.innerHTML = `
      <div class="gmus-page">
        <div class="gdz-topbar">
          <button class="action-btn gmus-back">‹ Artists</button>
          <span class="gmus-savestate"></span>
        </div>
        <div class="gmus-split">
          <div class="gmus-left">
            <label class="gmus-label">Name</label>
            <input class="gmus-title gmus-a-name" spellcheck="false" placeholder="Artist name" />
            <label class="gmus-label">Style</label>
            <input class="gmus-a-style gmus-a-style-in" spellcheck="false" placeholder="'gravel-voiced blues shouter'" />
            <label class="gmus-label">Voice</label>
            <div class="gmus-a-row">
              <button class="action-btn gmus-a-rec">● Record voice</button>
              <span class="gmus-a-voice-state"></span>
            </div>
            <input class="gmus-a-voiceid" placeholder="…or a provider voice id" spellcheck="false" />
            ${isNew ? '<button class="action-btn primary gmus-a-create">Create artist</button>' : ""}
          </div>
          <div class="gmus-right">
            <div class="gmus-looks-head">
              <span class="gmus-label">Looks</span>
              <button class="action-btn primary gmus-look-new" ${isNew ? "disabled title='Create the artist first'" : ""}>＋ New look</button>
            </div>
            <div class="gmus-looks-gallery"></div>
            <div class="gmus-look-hint">${isNew ? "Save the artist, then generate looks — photoreal front + back, two credits' worth of images each." : "click an image to fill the panel · ⟳ regenerates that look · the highlighted look fronts the artist"}</div>
          </div>
        </div>
        <div class="gmus-lightbox hidden"><img alt="" /></div>
      </div>`;
    pane.querySelector(".gmus-back")?.addEventListener("click", () => { delete state.artistId; refresh(); });

    const saveState = pane.querySelector<HTMLElement>(".gmus-savestate")!;
    const nameIn = pane.querySelector<HTMLInputElement>(".gmus-a-name")!;
    const styleIn = pane.querySelector<HTMLInputElement>(".gmus-a-style-in")!;
    const voiceIdIn = pane.querySelector<HTMLInputElement>(".gmus-a-voiceid")!;
    const voiceState = pane.querySelector<HTMLElement>(".gmus-a-voice-state")!;
    let voiceAssetId = artist?.voiceAssetId ?? null;
    if (artist) {
      nameIn.value = artist.name;
      styleIn.value = artist.style;
      voiceIdIn.value = artist.voiceId ?? "";
      if (voiceAssetId) voiceState.textContent = "voice sample ✓";
    }

    // Edit mode autosaves; new mode saves on Create.
    const persist = async (): Promise<void> => {
      if (isNew || !artist) return;
      saveState.textContent = "…";
      const r = await api().musicArtistSave?.(artist.id, {
        name: nameIn.value.trim() || artist.name,
        style: styleIn.value.trim(),
        voiceAssetId,
        voiceId: voiceIdIn.value.trim() || null,
      });
      saveState.textContent = r?.ok ? "Saved" : `⚠ ${r?.error ?? "save failed"}`;
    };
    nameIn.addEventListener("change", () => void persist());
    styleIn.addEventListener("change", () => void persist());
    voiceIdIn.addEventListener("change", () => void persist());
    pane.querySelector(".gmus-a-create")?.addEventListener("click", () => {
      void (async () => {
        const name = nameIn.value.trim();
        if (!name) { nameIn.focus(); return; }
        const r = await api().musicArtistSave?.(null, {
          name, style: styleIn.value.trim(),
          voiceAssetId, voiceId: voiceIdIn.value.trim() || null,
        });
        if (r?.ok && r.artist) { state.artistId = r.artist.id; refresh(); }
        else saveState.textContent = `⚠ ${r?.error ?? "create failed"}`;
      })();
    });

    // Mic recording — the raw sample lands as a `voice` asset with consent.
    let recorder: MediaRecorder | null = null;
    pane.querySelector(".gmus-a-rec")?.addEventListener("click", () => {
      void (async () => {
        if (recorder) { recorder.stop(); return; }
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const chunks: Blob[] = [];
          recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
          recorder.addEventListener("dataavailable", (ev) => chunks.push(ev.data));
          recorder.addEventListener("stop", () => {
            stream.getTracks().forEach((t) => t.stop());
            recorder = null;
            (pane.querySelector(".gmus-a-rec") as HTMLElement).textContent = "● Record voice";
            void (async () => {
              voiceState.textContent = "uploading…";
              const bytes = await new Blob(chunks).arrayBuffer();
              const up = await api().mediaUploadBytes?.({
                title: `${nameIn.value.trim() || "artist"} voice sample`,
                kind: "voice", mime: "audio/webm", bytes,
                meta: { consent: "recorded in the Artists editor by the account owner", recordedAt: new Date().toISOString() },
              });
              if (up?.ok && up.id) {
                voiceAssetId = up.id;
                voiceState.textContent = "voice sample ✓";
                void persist();
              } else voiceState.textContent = `⚠ ${up?.error ?? "upload failed"}`;
            })();
          });
          recorder.start();
          (pane.querySelector(".gmus-a-rec") as HTMLElement).textContent = "■ Stop";
          voiceState.textContent = "recording — say a verse, then Stop";
        } catch {
          voiceState.textContent = "⚠ microphone unavailable";
        }
      })();
    });

    // ── the looks gallery + full-panel lightbox ──────────────────────────────
    const gallery = pane.querySelector<HTMLElement>(".gmus-looks-gallery")!;
    const lightbox = pane.querySelector<HTMLElement>(".gmus-lightbox")!;
    lightbox.addEventListener("click", () => lightbox.classList.add("hidden"));
    const openFull = (url: string): void => {
      (lightbox.querySelector("img") as HTMLImageElement).src = url;
      lightbox.classList.remove("hidden");
    };
    const paintLooks = (a2: Artist | null): void => {
      gallery.textContent = "";
      const looks = (a2?.meta?.looks as Array<{ front: string; back: string }> | undefined) ?? [];
      const active = (a2?.meta?.activeLook as number | undefined) ?? 0;
      if (!looks.length) {
        gallery.innerHTML = `<div class="gdoc-empty">${isNew ? "" : "No looks yet — ＋ New look generates a photoreal front + back."}</div>`;
        return;
      }
      looks.forEach((lk, i) => {
        const card = document.createElement("div");
        card.className = "gmus-lookcard" + (i === active ? " on" : "");
        card.innerHTML = `
          <div class="gmus-lookcard-head">
            <button class="gmus-look-use">${i === active ? "Active look" : "Use this look"}</button>
            <button class="ws-icon-btn gmus-look-regen" title="Regenerate this look (costs credits)">⟳</button>
          </div>
          <div class="gmus-lookcard-imgs">
            <div class="gmus-lookimg" data-side="front"><span>front</span></div>
            <div class="gmus-lookimg" data-side="back"><span>back</span></div>
          </div>`;
        for (const [side, id2] of [["front", lk.front], ["back", lk.back]] as const) {
          const el = card.querySelector<HTMLElement>(`.gmus-lookimg[data-side="${side}"]`)!;
          void api().mediaUrl?.(id2).then((r) => {
            if (!r?.ok || !r.url || !el.isConnected) return;
            el.style.backgroundImage = `url("${r.url.replace(/"/g, "%22")}")`;
            el.addEventListener("click", () => openFull(r.url!));
          });
        }
        card.querySelector(".gmus-look-use")?.addEventListener("click", () => {
          void (async () => {
            if (!a2) return;
            const r = await api().musicArtistSave?.(a2.id, { avatarAssetId: lk.front, meta: { ...a2.meta, activeLook: i } });
            if (r?.ok && r.artist) paintLooks(r.artist);
          })();
        });
        card.querySelector(".gmus-look-regen")?.addEventListener("click", (ev) => {
          void (async () => {
            if (!a2 || card.querySelector(".gmus-look-busy")) return;
            (ev.currentTarget as HTMLButtonElement).disabled = true;
            // A real busy state: the card veils, a ring spins, the label says
            // what's happening — not a twitching glyph in the corner.
            const veil = document.createElement("div");
            veil.className = "gmus-look-busy";
            veil.innerHTML = `<span class="gmus-spin gmus-spin-lg"></span><span class="gmus-look-busy-label">Generating front + back…</span>`;
            card.appendChild(veil);
            saveState.textContent = "generating look…";
            const r = await api().musicArtistGenlook?.(a2.id, styleIn.value.trim(), i + 1);
            saveState.textContent = r?.ok ? `look ${i + 1} regenerated — ${(r.credits ?? 0).toFixed(2)} credits` : `⚠ ${r?.error ?? "generation failed"}`;
            if (r?.ok && r.artist) paintLooks(r.artist);
            else veil.remove();
          })();
        });
        gallery.appendChild(card);
      });
    };
    paintLooks(artist ?? null);
    pane.querySelector(".gmus-look-new")?.addEventListener("click", () => {
      void (async () => {
        if (!artist) return;
        const btn = pane.querySelector<HTMLButtonElement>(".gmus-look-new")!;
        btn.disabled = true;
        btn.innerHTML = `<span class="gmus-spin"></span>Generating…`;
        saveState.textContent = "generating look…";
        const r = await api().musicArtistGenlook?.(artist.id, styleIn.value.trim());
        btn.disabled = false;
        btn.textContent = "＋ New look";
        saveState.textContent = r?.ok ? `new look — ${(r.credits ?? 0).toFixed(2)} credits` : `⚠ ${r?.error ?? "generation failed"}`;
        if (r?.ok && r.artist) paintLooks(r.artist);
      })();
    });
  }

  // ── Music Video  // ── Instruments — the org library: list → the instrument page ─────────────

  async function renderInstruments(pane: HTMLElement, state: MusicState, refresh: () => void): Promise<void> {
    stopPlayback();
    if (state.instrumentId !== undefined) { await renderInstrumentPage(pane, state, refresh); return; }
    const res = await api().musicInstruments?.();
    const instruments = res?.ok ? res.instruments : [];
    listShell(pane, state, {
      key: "instruments", noun: "instrument", newLabel: "＋ New Instrument", searchPh: "Search instruments…",
      emptyText: "No instruments yet — an instrument is a NAME, a SOUND line and a LOOK.",
      items: instruments, rowsClass: "gmus-artists",
      match: (i, q) => i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q),
      onNew: () => { state.instrumentId = null; refresh(); },
      row: (inst) => {
      const looks = (inst.meta?.looks as Array<{ assetId: string }> | undefined) ?? [];
      const active = (inst.meta?.activeLook as number | undefined) ?? 0;
      const row = document.createElement("button");
      row.className = "gmus-artist-card";
      row.innerHTML = `
        <div class="gmus-artist-face">🎸</div>
        <div class="gmus-artist-main">
          <span class="gmus-artist-name"></span>
          <span class="gmus-artist-style"></span>
          <span class="gmus-artist-badges"></span>
        </div>
        <span class="ws-icon-btn gmem-del gmus-artist-del" title="Delete"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></span>`;
      (row.querySelector(".gmus-artist-name") as HTMLElement).textContent = inst.name;
      (row.querySelector(".gmus-artist-style") as HTMLElement).textContent = inst.description || "—";
      (row.querySelector(".gmus-artist-badges") as HTMLElement).textContent = looks.length ? `${looks.length} look${looks.length === 1 ? "" : "s"}` : "no looks";
      const lookId = looks[active]?.assetId ?? looks[0]?.assetId;
      if (lookId) {
        const face = row.querySelector<HTMLElement>(".gmus-artist-face")!;
        void mediaUrlOf(lookId).then((u) => {
          if (u && face.isConnected) { face.textContent = ""; face.style.backgroundImage = `url("${u.replace(/"/g, "%22")}")`; }
        });
      }
      row.addEventListener("click", (ev) => {
        if ((ev.target as HTMLElement).closest(".gmus-artist-del")) return;
        state.instrumentId = inst.id;
        refresh();
      });
      row.querySelector(".gmus-artist-del")?.addEventListener("click", () => {
        void (async () => {
          const yes = await host.confirm({ title: `Delete "${inst.name}"?`, confirmLabel: "Delete", danger: true });
          if (!yes) return;
          await api().musicInstrumentDelete?.(inst.id);
          refresh();
        })();
      });
        return row;
      },
    });
  }

  /** THE INSTRUMENT PAGE — ‹ Instruments on top; the INPUT on the left (name
   *  + the sound/character line), the GENERATED OPTIONS on the right: a looks
   *  gallery — generate, regenerate per option, pick the active one, click
   *  to fill the panel. Exactly the artist page's shape. */
  async function renderInstrumentPage(pane: HTMLElement, state: MusicState, refresh: () => void): Promise<void> {
    const isNew = state.instrumentId === null;
    const res = isNew ? null : await api().musicInstruments?.();
    const inst = isNew ? null : (res?.ok ? res.instruments : []).find((x) => x.id === state.instrumentId);
    if (!isNew && !inst) { delete state.instrumentId; refresh(); return; }

    pane.innerHTML = `
      <div class="gmus-page">
        <div class="gdz-topbar">
          <button class="action-btn gmus-back">‹ Instruments</button>
          <span class="gmus-savestate"></span>
        </div>
        <div class="gmus-split">
          <div class="gmus-left">
            <label class="gmus-label">Name</label>
            <input class="gmus-title gmus-i-name-in" spellcheck="false" placeholder="pedal steel, 808 bass, banjo…" />
            <label class="gmus-label">Sound <span class="gmem-hint">the character — this drives the look too</span></label>
            <textarea class="gmus-prompt gmus-i-desc-in" spellcheck="false" placeholder="raw, overdriven, garage-y; sunburst body, heavy wear…"></textarea>
            ${isNew ? '<button class="action-btn primary gmus-i-create">Create instrument</button>' : ""}
          </div>
          <div class="gmus-right">
            <div class="gmus-looks-head">
              <span class="gmus-label">Looks</span>
              <button class="action-btn primary gmus-look-new" ${isNew ? "disabled title='Create the instrument first'" : ""}>＋ Generate look</button>
            </div>
            <div class="gmus-looks-gallery"></div>
            <div class="gmus-look-hint">${isNew ? "Save the instrument, then generate looks from its sound line." : "click an image to fill the panel · ⟳ regenerates that option · the highlighted look fronts the instrument"}</div>
          </div>
        </div>
        <div class="gmus-lightbox hidden"><img alt="" /></div>
      </div>`;
    pane.querySelector(".gmus-back")?.addEventListener("click", () => { delete state.instrumentId; refresh(); });

    const saveState = pane.querySelector<HTMLElement>(".gmus-savestate")!;
    const nameIn = pane.querySelector<HTMLInputElement>(".gmus-i-name-in")!;
    const descIn = pane.querySelector<HTMLTextAreaElement>(".gmus-i-desc-in")!;
    if (inst) { nameIn.value = inst.name; descIn.value = inst.description; }
    const persist = async (): Promise<void> => {
      if (isNew || !inst) return;
      saveState.textContent = "…";
      const r = await api().musicInstrumentSave?.(inst.id, { name: nameIn.value.trim() || inst.name, description: descIn.value.trim() });
      saveState.textContent = r?.ok ? "Saved" : `⚠ ${r?.error ?? "save failed"}`;
    };
    nameIn.addEventListener("change", () => void persist());
    descIn.addEventListener("change", () => void persist());
    pane.querySelector(".gmus-i-create")?.addEventListener("click", () => {
      void (async () => {
        const name = nameIn.value.trim();
        if (!name) { nameIn.focus(); return; }
        const r = await api().musicInstrumentSave?.(null, { name, description: descIn.value.trim() });
        if (r?.ok && r.instrument) { state.instrumentId = r.instrument.id; refresh(); }
      })();
    });

    const gallery = pane.querySelector<HTMLElement>(".gmus-looks-gallery")!;
    const lightbox = pane.querySelector<HTMLElement>(".gmus-lightbox")!;
    lightbox.addEventListener("click", () => lightbox.classList.add("hidden"));
    const openFull = (url: string): void => {
      (lightbox.querySelector("img") as HTMLImageElement).src = url;
      lightbox.classList.remove("hidden");
    };
    const paintLooks = (i2: LibInstrument | null): void => {
      gallery.textContent = "";
      const looks = (i2?.meta?.looks as Array<{ assetId: string }> | undefined) ?? [];
      const active = (i2?.meta?.activeLook as number | undefined) ?? 0;
      if (!looks.length) {
        gallery.innerHTML = `<div class="gdoc-empty">${isNew ? "" : "No looks yet — ＋ Generate look renders one from the sound line."}</div>`;
        return;
      }
      looks.forEach((lk, i3) => {
        const card = document.createElement("div");
        card.className = "gmus-lookcard" + (i3 === active ? " on" : "");
        card.innerHTML = `
          <div class="gmus-lookcard-head">
            <button class="gmus-look-use">${i3 === active ? "Active look" : "Use this look"}</button>
            <button class="ws-icon-btn gmus-look-regen" title="Regenerate this option (costs credits)">⟳</button>
          </div>
          <div class="gmus-lookcard-imgs"><div class="gmus-lookimg gmus-lookimg-solo"></div></div>`;
        const el = card.querySelector<HTMLElement>(".gmus-lookimg")!;
        void mediaUrlOf(lk.assetId).then((u) => {
          if (!u || !el.isConnected) return;
          el.style.backgroundImage = `url("${u.replace(/"/g, "%22")}")`;
          el.addEventListener("click", () => openFull(u));
        });
        card.querySelector(".gmus-look-use")?.addEventListener("click", () => {
          void (async () => {
            if (!i2) return;
            const r = await api().musicInstrumentSave?.(i2.id, { meta: { ...i2.meta, activeLook: i3 } });
            if (r?.ok && r.instrument) paintLooks(r.instrument);
          })();
        });
        card.querySelector(".gmus-look-regen")?.addEventListener("click", (ev) => {
          void (async () => {
            if (!i2 || card.querySelector(".gmus-look-busy")) return;
            (ev.currentTarget as HTMLButtonElement).disabled = true;
            const veil = document.createElement("div");
            veil.className = "gmus-look-busy";
            veil.innerHTML = `<span class="gmus-spin gmus-spin-lg"></span><span class="gmus-look-busy-label">Generating…</span>`;
            card.appendChild(veil);
            const r = await api().musicInstrumentGenlook?.(i2.id, descIn.value.trim(), i3 + 1);
            saveState.textContent = r?.ok ? `option ${i3 + 1} regenerated — ${(r.credits ?? 0).toFixed(2)} credits` : `⚠ ${r?.error ?? "generation failed"}`;
            if (r?.ok && r.instrument) paintLooks(r.instrument);
            else veil.remove();
          })();
        });
        gallery.appendChild(card);
      });
    };
    paintLooks(inst ?? null);
    pane.querySelector(".gmus-look-new")?.addEventListener("click", () => {
      void (async () => {
        if (!inst) return;
        const btn = pane.querySelector<HTMLButtonElement>(".gmus-look-new")!;
        btn.disabled = true;
        btn.innerHTML = `<span class="gmus-spin"></span>Generating…`;
        const r = await api().musicInstrumentGenlook?.(inst.id, descIn.value.trim());
        btn.disabled = false;
        btn.textContent = "＋ Generate look";
        saveState.textContent = r?.ok ? `new look — ${(r.credits ?? 0).toFixed(2)} credits` : `⚠ ${r?.error ?? "generation failed"}`;
        if (r?.ok && r.instrument) paintLooks(r.instrument);
      })();
    });
  }

  // ── Music Video — many videos: list → the editor page ─────────────────────

  async function renderMusicVideo(pane: HTMLElement, state: MusicState, refresh: () => void): Promise<void> {
    stopPlayback();
    if (state.videoId !== undefined) { await renderVideoPage(pane, state, refresh); return; }
    const res = await api().mediaProjects?.();
    const projects = res?.ok ? res.projects : [];
    listShell(pane, state, {
      key: "videos", noun: "video", newLabel: "＋ New Video", searchPh: "Search videos…",
      emptyText: "No music videos yet — ＋ New Video starts one.",
      items: projects,
      match: (pr, q) => pr.title.toLowerCase().includes(q),
      onNew: () => {
        void (async () => {
          if (!api().mediaProjectSave) {
            void host.confirm({ title: "Restart needed", body: "The video-project bridge isn't loaded — quit and relaunch the app (a renderer reload isn't enough after a main-process update).", confirmLabel: "OK" });
            return;
          }
          const r = await api().mediaProjectSave?.(null, { title: "Untitled", scenes: { visuals: [] } });
          if (!r?.ok || !r.project) {
            void host.confirm({ title: "Couldn't create the video", body: r?.error ?? "Unknown error.", confirmLabel: "OK" });
            return;
          }
          state.videoId = r.project.id;
          refresh();
        })();
      },
      row: (pr) => {
      const card = document.createElement("button");
      card.className = "gmus-song-card";
      card.innerHTML = `
        <span class="gmus-song-title"></span>
        <span class="gmus-song-meta"></span>
        <span class="gmus-song-badges">${pr.renderAssetId ? "▶" : pr.status === "rendering" ? "…" : "·"}</span>
        <span class="ws-icon-btn gmem-del gmus-song-del" title="Delete video">✕</span>`;
      (card.querySelector(".gmus-song-title") as HTMLElement).textContent = pr.title;
      const nVisuals = Array.isArray(pr.scenes.visuals) ? (pr.scenes.visuals as string[]).length : 0;
      (card.querySelector(".gmus-song-meta") as HTMLElement).textContent =
        [`${nVisuals} visual${nVisuals === 1 ? "" : "s"}`, pr.status].filter(Boolean).join(" · ");
      card.addEventListener("click", (ev) => {
        if ((ev.target as HTMLElement).closest(".gmus-song-del")) return;
        state.videoId = pr.id;
        refresh();
      });
      card.querySelector(".gmus-song-del")?.addEventListener("click", () => {
        void (async () => {
          const yes = await host.confirm({ title: `Delete "${pr.title}"?`, body: "The rendered clip stays in the Video library.", confirmLabel: "Delete", danger: true });
          if (!yes) return;
          await api().mediaProjectDelete?.(pr.id);
          refresh();
        })();
      });
        return card;
      },
    });
  }

  /** THE VIDEO PAGE — left: title + prompt + the DUAL-COLUMN visual picker
   *  (available ⇄ selected with > < >> <<); right: the generated video +
   *  Generate/Regenerate exactly like Songs (server-side, versioned, busy). */
  async function renderVideoPage(pane: HTMLElement, state: MusicState, refresh: () => void): Promise<void> {
    const res = await api().mediaProjects?.();
    const project = (res?.ok ? res.projects : []).find((x) => x.id === state.videoId);
    if (!project) { delete state.videoId; refresh(); return; }
    const selected: string[] = Array.isArray(project.scenes.visuals) ? [...(project.scenes.visuals as string[])] : [];

    pane.innerHTML = `
      <div class="gmus-page">
        <div class="gdz-topbar">
          <button class="action-btn gmus-back">‹ Music Video</button>
          <span class="gmus-savestate"></span>
          <button class="action-btn primary gmus-regen">${project.renderAssetId ? "Regenerate" : "Generate"}</button>
        </div>
        <div class="gmus-team"></div>
        <div class="gmus-split">
          <div class="gmus-left">
            <label class="gmus-label">Song <span class="gmem-hint">the song brings its band — artists, instruments, sound</span></label>
            <select class="gdz-select gmv-song"></select>
            <div class="gmus-team gmv-team"></div>
            <label class="gmus-label">Title</label>
            <input class="gmus-title gmv-title" spellcheck="false" />
            <label class="gmus-label">Prompt <span class="gmem-hint">the scene — what the video should be</span></label>
            <textarea class="gmus-prompt gmv-prompt gmv-prompt-tall" spellcheck="false" placeholder="neon-lit rooftop performance, slow dolly, rain…"></textarea>
          </div>
          <div class="gmus-right">
            <div class="gmv-player"><div class="gdoc-empty">${project.renderAssetId ? "loading…" : project.status === "rendering" ? "rendering — it attaches here when it lands" : "no render yet — Generate makes one"}</div></div>
          </div>
        </div>
      </div>`;
    pane.querySelector(".gmus-back")?.addEventListener("click", () => { delete state.videoId; refresh(); });

    const saveState = pane.querySelector<HTMLElement>(".gmus-savestate")!;
    const titleIn = pane.querySelector<HTMLInputElement>(".gmv-title")!;
    const promptIn = pane.querySelector<HTMLTextAreaElement>(".gmv-prompt")!;
    titleIn.value = project.title;
    promptIn.value = String(project.scenes.prompt ?? "");

    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const persist = (): void => {
      if (saveTimer) clearTimeout(saveTimer);
      saveState.textContent = "…";
      saveTimer = setTimeout(() => {
        void (async () => {
          const r = await api().mediaProjectSave?.(project.id, {
            title: titleIn.value.trim() || "Untitled",
            scenes: { ...project.scenes, prompt: promptIn.value.trim(), visuals: selected, songId: songSel.value || undefined },
          });
          saveState.textContent = r?.ok ? "Saved" : `⚠ ${r?.error ?? "save failed"}`;
        })();
      }, 600);
    };
    titleIn.addEventListener("input", persist);
    promptIn.addEventListener("input", persist);

    // ── the song + its team ──────────────────────────────────────────────────
    const songsRes = await api().musicSongs?.();
    const allSongs = (songsRes?.ok ? songsRes.songs : []).filter((s2) => s2.audioAssetId);
    const artistsRes = await api().musicArtists?.();
    const allArtists = artistsRes?.ok ? artistsRes.artists : [];
    const songSel = pane.querySelector<HTMLSelectElement>(".gmv-song")!;
    songSel.innerHTML = `<option value="">(pick a song)</option>` +
      allSongs.map((s2) => `<option value="${s2.id}">${s2.title.replace(/</g, "&lt;")}</option>`).join("");
    songSel.value = String(project.scenes.songId ?? "");
    const teamEl = pane.querySelector<HTMLElement>(".gmv-team")!;
    const paintTeam = (): void => {
      teamEl.textContent = "";
      const song = allSongs.find((s2) => s2.id === songSel.value);
      if (!song) { teamEl.innerHTML = `<span class="gmem-hint">pick a song and its band shows here</span>`; return; }
      for (const aid of song.artistIds) {
        const a2 = allArtists.find((x) => x.id === aid);
        if (!a2) continue;
        const m2 = document.createElement("div");
        m2.className = "gmus-team-member";
        m2.innerHTML = `<span class="gmus-team-face">♪</span><span class="gmus-team-name"></span>`;
        (m2.querySelector(".gmus-team-name") as HTMLElement).textContent = a2.name;
        const face = m2.querySelector<HTMLElement>(".gmus-team-face")!;
        if (a2.avatarAssetId) {
          void mediaUrlOf(a2.avatarAssetId).then((u) => {
            if (u && face.isConnected) { face.textContent = ""; face.style.backgroundImage = `url("${u.replace(/"/g, "%22")}")`; }
          });
        }
        teamEl.appendChild(m2);
      }
      for (const inst of song.instruments) {
        const m2 = document.createElement("div");
        m2.className = "gmus-team-member gmus-team-inst";
        m2.innerHTML = `<span class="gmus-team-face">🎸</span><span class="gmus-team-name"></span>`;
        (m2.querySelector(".gmus-team-name") as HTMLElement).textContent = inst.instrument;
        const face = m2.querySelector<HTMLElement>(".gmus-team-face")!;
        if (inst.lookAssetId) {
          void mediaUrlOf(inst.lookAssetId).then((u) => {
            if (u && face.isConnected) { face.textContent = ""; face.style.backgroundImage = `url("${u.replace(/"/g, "%22")}")`; }
          });
        }
        teamEl.appendChild(m2);
      }
    };
    songSel.addEventListener("change", () => { paintTeam(); persist(); });
    paintTeam();

    /** The full brief: the scene + everything the song knows about its band. */
    const composedBrief = (): string => {
      const song = allSongs.find((s2) => s2.id === songSel.value);
      const names = song ? song.artistIds.map((aid) => allArtists.find((x) => x.id === aid)?.name).filter(Boolean).join(", ") : "";
      return [
        `Music video: ${promptIn.value.trim()}`,
        song?.bandType ? `Band: ${song.bandType}.` : "",
        names ? `Performers: ${names}.` : "",
        song?.instruments.length ? `Instruments on stage: ${song.instruments.map((i) => i.instrument).join(", ")}.` : "",
        song?.prompt ? `The song: ${song.prompt}.` : "",
      ].filter(Boolean).join("\n");
    };


    // ── the player ───────────────────────────────────────────────────────────
    const player = pane.querySelector<HTMLElement>(".gmv-player")!;
    if (project.renderAssetId) {
      void api().mediaUrl?.(project.renderAssetId).then((r) => {
        if (!r?.ok || !r.url || !player.isConnected) return;
        player.textContent = "";
        const v = document.createElement("video");
        v.className = "gmedia-full";
        v.src = r.url;
        v.controls = true;
        player.appendChild(v);
      });
    }

    // ── Generate / Regenerate — the songs pattern exactly ────────────────────
    const regenBtn = pane.querySelector<HTMLButtonElement>(".gmus-regen")!;
    regenBtn.textContent = project.renderAssetId ? "Regenerate" : "Generate";
    regenBtn.addEventListener("click", () => {
      void (async () => {
        if (!promptIn.value.trim()) { void host.confirm({ title: "Give it a prompt first", confirmLabel: "OK" }); return; }
        regenBtn.disabled = true;
        regenBtn.innerHTML = `<span class="gmus-spin"></span>Generating…`;
        saveState.textContent = "generating…";
        await api().mediaProjectSave?.(project.id, {
          title: titleIn.value.trim() || "Untitled",
          scenes: { ...project.scenes, prompt: promptIn.value.trim(), visuals: selected, songId: songSel.value || undefined },
        });
        const started = await api().mediaProjectGenerate?.(project.id, { prompt: composedBrief() });
        if (!started?.ok || !started.project || !started.job) {
          saveState.textContent = `⚠ ${started?.error ?? "couldn't start"}`;
          regenBtn.disabled = false;
          regenBtn.textContent = project.renderAssetId ? "Regenerate" : "Generate";
          return;
        }
        const childId = started.project.id;
        for (;;) {
          await new Promise((r2) => setTimeout(r2, 3000));
          const poll = await api().mediaJob?.(started.job.id);
          if (!poll?.ok || !poll.job) break;
          if (poll.job.status === "failed") { saveState.textContent = `⚠ ${poll.job.error ?? "generation failed"}`; break; }
          if (poll.job.status === "succeeded") {
            saveState.textContent = `done — ${poll.job.creditsCharged.toFixed(2)} credits`;
            state.videoId = childId;
            refresh();
            return;
          }
          if (!pane.isConnected) return; // the server attaches regardless
        }
        regenBtn.disabled = false;
        regenBtn.textContent = project.renderAssetId ? "Regenerate" : "Generate";
      })();
    });
  }

  return {
    renderSongs,
    renderArtists,
    renderInstruments,
    renderMusicVideo,
    dispose: stopPlayback,
  };
}
