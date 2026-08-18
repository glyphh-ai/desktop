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

export interface MusicHost {
  confirm: (opts: { title: string; body?: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>;
}

export interface MusicState {
  songId?: string;
  artistId?: string | null;
}

const api = () => (window as unknown as { glyphh?: {
  musicArtists?: () => Promise<{ ok: boolean; artists: Artist[]; error?: string }>;
  musicArtistSave?: (id: string | null, input: unknown) => Promise<{ ok: boolean; artist?: Artist; error?: string }>;
  musicArtistDelete?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  musicSongs?: () => Promise<{ ok: boolean; songs: Song[]; error?: string }>;
  musicSongSave?: (id: string | null, input: unknown) => Promise<{ ok: boolean; song?: Song; error?: string }>;
  musicSongDelete?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  musicSongRegenerate?: (id: string, input?: unknown) => Promise<{ ok: boolean; song?: Song; job?: { id: string }; error?: string }>;
  musicArtistGenlook?: (id: string, description?: string, replaceLook?: number) => Promise<{ ok: boolean; artist?: Artist; credits?: number; error?: string }>;
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

// ── the panel ────────────────────────────────────────────────────────────────

export interface MusicViews {
  renderSongs: (pane: HTMLElement, state: MusicState, refresh: () => void) => Promise<void>;
  renderArtists: (pane: HTMLElement, state: MusicState, refresh: () => void) => Promise<void>;
  renderMusicVideo: (pane: HTMLElement, refresh: () => void) => Promise<void>;
  dispose: () => void;
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

  // ── Songs list + the song page ─────────────────────────────────────────────

  async function renderSongs(pane: HTMLElement, state: MusicState, refresh: () => void): Promise<void> {
    stopPlayback();
    if (state.songId) { await renderSongPage(pane, state, refresh); return; }
    const res = await api().musicSongs?.();
    const songs = res?.ok ? res.songs : [];
    pane.innerHTML = `
      <div class="gmus-list">
        <div class="office-toolbar">
          <span class="gmus-count">${songs.length} song${songs.length === 1 ? "" : "s"}</span>
          <button class="action-btn primary gmus-new">＋ New Song</button>
        </div>
        <div class="gmus-songs"></div>
        <div class="gdoc-empty ${songs.length ? "hidden" : ""}">No songs yet — ＋ New Song assembles a band, or ask Glyphh to write one.</div>
      </div>`;
    pane.querySelector(".gmus-new")?.addEventListener("click", () => {
      void (async () => {
        const r = await api().musicSongSave?.(null, { title: "Untitled" });
        if (r?.ok && r.song) { state.songId = r.song.id; refresh(); }
      })();
    });
    const list = pane.querySelector<HTMLElement>(".gmus-songs")!;
    const children = new Map<string, number>();
    for (const s of songs) if (s.parentId) children.set(s.parentId, (children.get(s.parentId) ?? 0) + 1);
    for (const s of songs) {
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
      list.appendChild(card);
    }
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
          <button class="action-btn primary gmus-regen" title="Re-run the music model with the edited prompt + lyrics — creates a child version">Regenerate</button>
        </div>
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
            <div class="gmus-artist-chips"></div>
            <div class="gmus-instruments"></div>
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
    // ── the band assembler — every change autosaves onto the song ────────────
    const bandTypeIn = pane.querySelector<HTMLInputElement>(".gmus-bandtype")!;
    bandTypeIn.value = song.bandType;
    const artistChips = pane.querySelector<HTMLElement>(".gmus-artist-chips")!;
    const instrWrap = pane.querySelector<HTMLElement>(".gmus-instruments")!;
    const saveBand = (): void => {
      void api().musicSongSave?.(song.id, {
        bandType: song.bandType, artistIds: song.artistIds, instruments: song.instruments,
      });
    };
    bandTypeIn.addEventListener("change", () => { song.bandType = bandTypeIn.value.trim(); saveBand(); });
    const paintArtistChips = (): void => {
      artistChips.textContent = "";
      for (const a2 of artists) {
        const chip = document.createElement("button");
        chip.className = "gmus-mv-chip" + (song.artistIds.includes(a2.id) ? " on" : "");
        chip.textContent = `♪ ${a2.name}`;
        chip.title = a2.style || a2.name;
        chip.addEventListener("click", () => {
          song.artistIds = song.artistIds.includes(a2.id)
            ? song.artistIds.filter((x) => x !== a2.id)
            : [...song.artistIds, a2.id];
          saveBand(); paintArtistChips();
        });
        artistChips.appendChild(chip);
      }
      if (!artists.length) {
        const hint = document.createElement("span");
        hint.className = "gmem-hint";
        hint.textContent = "no artists yet — build the band in the Artists tab";
        artistChips.appendChild(hint);
      }
    };
    paintArtistChips();
    const paintInstruments = (): void => {
      instrWrap.textContent = "";
      song.instruments.forEach((inst, i) => {
        const row = document.createElement("div");
        row.className = "gmus-a-row";
        row.innerHTML = `
          <span class="gmus-i-look" title="Instrument look"></span>
          <input class="gmus-a-style gmus-i-name" spellcheck="false" placeholder="instrument" style="max-width:130px" />
          <input class="gmus-a-style gmus-i-tweak" spellcheck="false" placeholder="tweak — 'tight, dry, 90s'" style="flex:1" />
          <button class="ws-icon-btn gmus-i-gen" title="Generate a look image (costs credits)">⟳</button>
          <button class="ws-icon-btn gmem-del" title="Remove">✕</button>`;
        const lookEl = row.querySelector<HTMLElement>(".gmus-i-look")!;
        if (inst.lookAssetId) {
          void api().mediaUrl?.(inst.lookAssetId).then((r) => {
            if (r?.ok && r.url && lookEl.isConnected) lookEl.style.backgroundImage = `url("${r.url.replace(/"/g, "%22")}")`;
          });
        }
        row.querySelector(".gmus-i-gen")?.addEventListener("click", () => {
          void (async () => {
            lookEl.classList.add("busy");
            const started = await api().mediaGenerate?.({
              model: "",
              prompt: `Photorealistic product photograph of a ${inst.instrument}${inst.tweak ? `, ${inst.tweak}` : ""}, for a ${bandTypeIn.value.trim() || "rock"} band, dark stage backdrop, dramatic lighting`,
              title: `${inst.instrument} — look`,
            }).catch(() => null);
            // model "" → the org's first image model, resolved main-side? The
            // generate endpoint needs a model — fall back to asking for one.
            if (!started?.ok || !started.job) {
              const models = ["openai::gpt-image-1", "blackforest::flux-pro-1.1", "xai::grok-2-image-1212", "google::gemini-3-pro-image"];
              for (const m2 of models) {
                const retry = await api().mediaGenerate?.({ model: m2, prompt: `Photorealistic product photograph of a ${inst.instrument}${inst.tweak ? `, ${inst.tweak}` : ""}, dark stage backdrop, dramatic lighting`, title: `${inst.instrument} — look` });
                if (retry?.ok && retry.job) { await followJob(retry.job.id); return; }
              }
              lookEl.classList.remove("busy");
              return;
            }
            await followJob(started.job.id);
            async function followJob(jobId: string): Promise<void> {
              for (;;) {
                await new Promise((r2) => setTimeout(r2, 2500));
                const poll = await api().mediaJob?.(jobId);
                if (!poll?.ok || !poll.job) break;
                if (poll.job.status === "failed") break;
                if (poll.job.status === "succeeded") {
                  inst.lookAssetId = poll.job.assetId;
                  saveBand();
                  break;
                }
                if (!row.isConnected) return;
              }
              lookEl.classList.remove("busy");
              paintInstruments();
            }
          })();
        });
        const nameIn = row.querySelector<HTMLInputElement>(".gmus-i-name")!;
        const tweakIn = row.querySelector<HTMLInputElement>(".gmus-i-tweak")!;
        nameIn.value = inst.instrument;
        tweakIn.value = inst.tweak;
        nameIn.addEventListener("change", () => { inst.instrument = nameIn.value.trim() || inst.instrument; saveBand(); });
        tweakIn.addEventListener("change", () => { inst.tweak = tweakIn.value.trim(); saveBand(); });
        row.querySelector(".gmem-del")?.addEventListener("click", () => {
          song.instruments.splice(i, 1);
          saveBand(); paintInstruments();
        });
        instrWrap.appendChild(row);
      });
      const add = document.createElement("button");
      add.className = "action-btn gmus-i-add";
      add.textContent = "＋ Instrument";
      add.addEventListener("click", () => {
        song.instruments.push({ instrument: "guitar", tweak: "" });
        saveBand(); paintInstruments();
      });
      instrWrap.appendChild(add);
    };
    paintInstruments();
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
        g.fillStyle = "rgba(140,59,242,0.35)";
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
        g.fillStyle = inSel ? "#ec4899" : "#8c3bf2";
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
    const saveNewBtn = pane.querySelector<HTMLButtonElement>(".gmus-savenew")!;
    const setBusy = (busy: boolean, label?: string): void => {
      regenBtn.disabled = busy;
      saveNewBtn.disabled = busy;
      regenBtn.classList.toggle("busy", busy);
      regenBtn.innerHTML = busy ? `<span class="gmus-spin"></span>${label ?? "Generating…"}` : "Regenerate";
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
    pane.innerHTML = `
      <div class="gmus-list">
        <div class="office-toolbar">
          <span class="gmus-count">${artists.length} artist${artists.length === 1 ? "" : "s"}</span>
          <button class="action-btn primary gmus-new">＋ New Artist</button>
        </div>
        <div class="gmus-artists"></div>
        <div class="gdoc-empty ${artists.length ? "hidden" : ""}">No artists yet — a singer is a NAME, a LOOK and a VOICE.</div>
      </div>`;
    pane.querySelector(".gmus-new")?.addEventListener("click", () => { state.artistId = null; refresh(); });
    const list = pane.querySelector<HTMLElement>(".gmus-artists")!;
    for (const a of artists) {
      const row = document.createElement("button");
      row.className = "gmus-artist-card";
      row.innerHTML = `
        <div class="gmus-artist-face">♪</div>
        <div class="gmus-artist-main">
          <span class="gmus-artist-name"></span>
          <span class="gmus-artist-style"></span>
          <span class="gmus-artist-badges"></span>
        </div>
        <span class="ws-icon-btn gmem-del gmus-artist-del" title="Delete">✕</span>`;
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
      list.appendChild(row);
    }
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
            if (!a2) return;
            (ev.currentTarget as HTMLElement).classList.add("busy");
            saveState.textContent = "generating look…";
            const r = await api().musicArtistGenlook?.(a2.id, styleIn.value.trim(), i + 1);
            saveState.textContent = r?.ok ? `look ${i + 1} regenerated — ${(r.credits ?? 0).toFixed(2)} credits` : `⚠ ${r?.error ?? "generation failed"}`;
            if (r?.ok && r.artist) paintLooks(r.artist);
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

  // ── Music Video  // ── Music Video — the assembler (renders when the pipeline phase lands) ────

  async function renderMusicVideo(pane: HTMLElement, refresh: () => void): Promise<void> {
    stopPlayback();
    const [songsRes, imgs, vids] = await Promise.all([api().musicSongs?.(), api().mediaList?.("image"), api().mediaList?.("video")]);
    const songs = (songsRes?.ok ? songsRes.songs : []).filter((s) => s.audioAssetId);
    const visuals = [...(imgs?.ok ? imgs.assets : []), ...(vids?.ok ? vids.assets : [])].filter((x) => x.status === "ready");
    pane.innerHTML = `
      <div class="gmus-list gmus-mv">
        <div class="gmus-mv-head">Pick a song, pull in visuals — the assembly SAVES onto the song; the render lands with the pipeline phase.</div>
        <label class="gmus-label">Song</label>
        <select class="gdz-select gmus-mv-song">${songs.map((s) => `<option value="${s.id}">${s.title.replace(/</g, "&lt;")}</option>`).join("") || "<option value=''>(no songs with audio yet)</option>"}</select>
        <label class="gmus-label">Visuals <span class="gmem-hint">images + video from the library — click to toggle</span></label>
        <div class="gmus-mv-pool"></div>
        <button class="action-btn primary gmus-mv-save" ${songs.length ? "" : "disabled"}>Save assembly</button>
        <span class="gmus-mv-state"></span>
      </div>`;
    const pool = pane.querySelector<HTMLElement>(".gmus-mv-pool")!;
    const songSel = pane.querySelector<HTMLSelectElement>(".gmus-mv-song")!;
    const stateEl = pane.querySelector<HTMLElement>(".gmus-mv-state")!;
    let picked = new Set<string>();
    const chips = new Map<string, HTMLElement>();
    const loadPicks = (): void => {
      const song = songs.find((s) => s.id === songSel.value);
      picked = new Set(song?.visuals ?? []);
      for (const [id, chip] of chips) chip.classList.toggle("on", picked.has(id));
    };
    for (const v of visuals.slice(0, 60)) {
      const chip = document.createElement("button");
      chip.className = "gmus-mv-chip";
      chip.textContent = `${v.kind === "video" ? "▶" : "◻"} ${v.title.slice(0, 28)}`;
      chip.addEventListener("click", () => {
        if (picked.has(v.id)) picked.delete(v.id); else picked.add(v.id);
        chip.classList.toggle("on", picked.has(v.id));
      });
      chips.set(v.id, chip);
      pool.appendChild(chip);
    }
    songSel.addEventListener("change", loadPicks);
    loadPicks();
    pane.querySelector(".gmus-mv-save")?.addEventListener("click", () => {
      void (async () => {
        const songId = songSel.value;
        if (!songId) return;
        const r = await api().musicSongSave?.(songId, { visuals: [...picked] });
        stateEl.textContent = r?.ok ? `saved — ${picked.size} visual${picked.size === 1 ? "" : "s"} staged for the render` : `⚠ ${r?.error ?? "save failed"}`;
      })();
    });
    void refresh;
  }

  return {
    renderSongs,
    renderArtists,
    renderMusicVideo,
    dispose: stopPlayback,
  };
}
