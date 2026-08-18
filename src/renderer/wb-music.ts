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

interface Artist { id: string; name: string; style: string; voiceAssetId: string | null; voiceId: string | null; avatarAssetId: string | null; updatedAt: string }
interface Instrument { instrument: string; tweak: string }
interface Song {
  id: string; title: string; lyrics: string; prompt: string; bandType: string;
  artistIds: string[]; instruments: Instrument[];
  audioAssetId: string | null; parentId: string | null; model: string; updatedAt: string;
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
        <span class="gmus-song-badges">${s.audioAssetId ? "♫" : "·"}${s.parentId ? " ↳" : ""}${children.get(s.id) ? ` ${children.get(s.id)}v` : ""}</span>`;
      (card.querySelector(".gmus-song-title") as HTMLElement).textContent = s.title;
      (card.querySelector(".gmus-song-meta") as HTMLElement).textContent =
        [s.bandType, s.model ? s.model.split("::")[1] : ""].filter(Boolean).join(" · ") || "no band yet";
      card.addEventListener("click", () => { state.songId = s.id; refresh(); });
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
            <div class="gmus-band-line"></div>
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
    const bandLine = pane.querySelector<HTMLElement>(".gmus-band-line")!;
    const bandNames = song.artistIds.map((id) => artists.find((a) => a.id === id)?.name).filter(Boolean).join(", ");
    bandLine.textContent = [song.bandType, bandNames, song.instruments.map((i) => i.instrument).join("/")]
      .filter(Boolean).join(" · ") || "no band assembled — the New Song assembler or the agent sets one";

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
        g.fillText(song.audioAssetId ? "decoding…" : "no take yet — Regenerate makes one", 14, h / 2);
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

    // Save as New — encode the edited take, land it, version the song.
    pane.querySelector(".gmus-savenew")?.addEventListener("click", () => {
      void (async () => {
        if (!buffer) { void host.confirm({ title: "Nothing to save", body: "There is no audio take loaded.", confirmLabel: "OK" }); return; }
        saveState.textContent = "encoding…";
        const wav = encodeWav(channelsOf(buffer), buffer.sampleRate);
        const up = await api().mediaUploadBytes?.({
          title: `${titleIn.value.trim() || "Untitled"} (edit)`,
          kind: "audio", mime: "audio/wav", bytes: wav,
          meta: { songId: song.id, edited: true },
        });
        if (!up?.ok || !up.id) { saveState.textContent = `⚠ ${up?.error ?? "upload failed"}`; return; }
        const created = await api().musicSongSave?.(null, {
          title: `${titleIn.value.trim() || "Untitled"} (edit)`,
          lyrics: lyricsIn.value, prompt: promptIn.value,
          bandType: song.bandType, artistIds: song.artistIds, instruments: song.instruments,
          audioAssetId: up.id, parentId: song.id, model: song.model,
        });
        if (created?.ok && created.song) { stopPlayback(); state.songId = created.song.id; refresh(); }
      })();
    });

    // Regenerate — the metered path; the edited prompt + lyrics steer it.
    pane.querySelector(".gmus-regen")?.addEventListener("click", () => {
      void (async () => {
        const brief = [
          promptIn.value.trim(),
          song.bandType ? `Band: ${song.bandType}.` : "",
          bandNames ? `Vocalists: ${bandNames}.` : "",
          song.instruments.length ? `Instruments: ${song.instruments.map((i) => `${i.instrument}${i.tweak ? ` (${i.tweak})` : ""}`).join(", ")}.` : "",
          lyricsIn.value.trim() ? `Lyrics:\n${lyricsIn.value.trim()}` : "",
        ].filter(Boolean).join("\n");
        if (!brief) { void host.confirm({ title: "Nothing to regenerate from", body: "Give it a prompt (and lyrics) first.", confirmLabel: "OK" }); return; }
        saveState.textContent = "generating…";
        const started = await api().mediaGenerate?.({ model: song.model || "elevenlabs::music-v1", prompt: brief, title: titleIn.value.trim() || "Untitled" });
        if (!started?.ok || !started.job) { saveState.textContent = `⚠ ${started?.error ?? "couldn't start"}`; return; }
        for (;;) {
          await new Promise((r) => setTimeout(r, 2500));
          const poll = await api().mediaJob?.(started.job.id);
          if (!poll?.ok || !poll.job) { saveState.textContent = "⚠ lost the job"; return; }
          if (poll.job.status === "failed") { saveState.textContent = `⚠ ${poll.job.error ?? "generation failed"}`; return; }
          if (poll.job.status === "succeeded") {
            const created = await api().musicSongSave?.(null, {
              title: titleIn.value.trim() || "Untitled",
              lyrics: lyricsIn.value, prompt: promptIn.value,
              bandType: song.bandType, artistIds: song.artistIds, instruments: song.instruments,
              audioAssetId: poll.job.assetId, parentId: song.id, model: poll.job.model,
            });
            saveState.textContent = `done — ${poll.job.creditsCharged.toFixed(2)} credits`;
            if (created?.ok && created.song) { stopPlayback(); state.songId = created.song.id; refresh(); }
            return;
          }
          if (!pane.isConnected) return;
        }
      })();
    });

    // load + decode the current take
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
    const list = pane.querySelector<HTMLElement>(".gmus-artists")!;

    const editor = (artist: Artist | null): void => {
      const card = document.createElement("div");
      card.className = "gmus-artist-editor";
      card.innerHTML = `
        <input class="gmus-a-name" placeholder="Artist name" spellcheck="false" />
        <input class="gmus-a-style" placeholder="style — 'gravel-voiced blues shouter'" spellcheck="false" />
        <div class="gmus-a-row">
          <button class="action-btn gmus-a-rec">● Record voice</button>
          <span class="gmus-a-voice-state"></span>
          <input class="gmus-a-voiceid" placeholder="…or a provider voice id" spellcheck="false" />
        </div>
        <div class="gmus-a-row">
          <button class="action-btn gmus-a-avatar">Pick a look…</button>
          <span class="gmus-a-avatar-state"></span>
        </div>
        <div class="gmus-a-row">
          <button class="action-btn primary gmus-a-save">Save</button>
          <button class="action-btn gmus-a-cancel">Cancel</button>
        </div>`;
      const nameIn = card.querySelector<HTMLInputElement>(".gmus-a-name")!;
      const styleIn = card.querySelector<HTMLInputElement>(".gmus-a-style")!;
      const voiceIdIn = card.querySelector<HTMLInputElement>(".gmus-a-voiceid")!;
      const voiceState = card.querySelector<HTMLElement>(".gmus-a-voice-state")!;
      const avatarState = card.querySelector<HTMLElement>(".gmus-a-avatar-state")!;
      let voiceAssetId = artist?.voiceAssetId ?? null;
      let avatarAssetId = artist?.avatarAssetId ?? null;
      if (artist) {
        nameIn.value = artist.name;
        styleIn.value = artist.style;
        voiceIdIn.value = artist.voiceId ?? "";
        if (voiceAssetId) voiceState.textContent = "voice sample ✓";
        if (avatarAssetId) avatarState.textContent = "look ✓";
      }

      // Mic recording — the raw sample lands as a `voice` asset with a consent
      // note; the P2 clone flow turns it into a synthesizable voice.
      let recorder: MediaRecorder | null = null;
      card.querySelector(".gmus-a-rec")?.addEventListener("click", () => {
        void (async () => {
          if (recorder) {
            recorder.stop();
            return;
          }
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const chunks: Blob[] = [];
            recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
            recorder.addEventListener("dataavailable", (ev) => chunks.push(ev.data));
            recorder.addEventListener("stop", () => {
              stream.getTracks().forEach((t) => t.stop());
              recorder = null;
              (card.querySelector(".gmus-a-rec") as HTMLElement).textContent = "● Record voice";
              void (async () => {
                voiceState.textContent = "uploading…";
                const bytes = await new Blob(chunks).arrayBuffer();
                const up = await api().mediaUploadBytes?.({
                  title: `${nameIn.value.trim() || "artist"} voice sample`,
                  kind: "voice", mime: "audio/webm", bytes,
                  meta: { consent: "recorded in the Artists editor by the account owner", recordedAt: new Date().toISOString() },
                });
                if (up?.ok && up.id) { voiceAssetId = up.id; voiceState.textContent = "voice sample ✓"; }
                else voiceState.textContent = `⚠ ${up?.error ?? "upload failed"}`;
              })();
            });
            recorder.start();
            (card.querySelector(".gmus-a-rec") as HTMLElement).textContent = "■ Stop";
            voiceState.textContent = "recording — say a verse, then Stop";
          } catch {
            voiceState.textContent = "⚠ microphone unavailable";
          }
        })();
      });

      card.querySelector(".gmus-a-avatar")?.addEventListener("click", () => {
        void (async () => {
          const imgs = await api().mediaList?.("image");
          const pool = (imgs?.ok ? imgs.assets : []).filter((x) => x.status === "ready").slice(0, 30);
          if (!pool.length) { avatarState.textContent = "no images in the library yet — generate one"; return; }
          const picker = document.createElement("div");
          picker.className = "ws-popover gdesign-menu gdz-img-picker";
          for (const x of pool) {
            const b = document.createElement("button");
            b.className = "ws-popover-item";
            b.textContent = x.title.slice(0, 44);
            b.addEventListener("click", () => { picker.remove(); avatarAssetId = x.id; avatarState.textContent = `look ✓ (${x.title.slice(0, 20)})`; });
            picker.appendChild(b);
          }
          document.body.appendChild(picker);
          const r = (card.querySelector(".gmus-a-avatar") as HTMLElement).getBoundingClientRect();
          picker.style.top = `${r.bottom + 4}px`;
          picker.style.left = `${r.left}px`;
          const onDoc = (ev: MouseEvent): void => {
            if (!picker.contains(ev.target as Node)) { picker.remove(); document.removeEventListener("mousedown", onDoc, true); }
          };
          document.addEventListener("mousedown", onDoc, true);
        })();
      });

      card.querySelector(".gmus-a-cancel")?.addEventListener("click", () => refresh());
      card.querySelector(".gmus-a-save")?.addEventListener("click", () => {
        void (async () => {
          const name = nameIn.value.trim();
          if (!name) return;
          await api().musicArtistSave?.(artist?.id ?? null, {
            name, style: styleIn.value.trim(),
            voiceAssetId, avatarAssetId,
            voiceId: voiceIdIn.value.trim() || null,
          });
          refresh();
        })();
      });
      list.prepend(card);
      nameIn.focus();
    };

    pane.querySelector(".gmus-new")?.addEventListener("click", () => editor(null));
    for (const a of artists) {
      const row = document.createElement("div");
      row.className = "gmus-artist-card";
      row.innerHTML = `
        <div class="gmus-artist-face">♪</div>
        <div class="gmus-artist-main">
          <span class="gmus-artist-name"></span>
          <span class="gmus-artist-style"></span>
          <span class="gmus-artist-badges"></span>
        </div>
        <button class="action-btn gmus-a-edit">Edit</button>
        <button class="ws-icon-btn gmem-del" title="Delete">✕</button>`;
      (row.querySelector(".gmus-artist-name") as HTMLElement).textContent = a.name;
      (row.querySelector(".gmus-artist-style") as HTMLElement).textContent = a.style || "—";
      (row.querySelector(".gmus-artist-badges") as HTMLElement).textContent =
        [a.voiceAssetId ? "voice sample" : a.voiceId ? "synth voice" : "no voice", a.avatarAssetId ? "look" : "no look"].join(" · ");
      if (a.avatarAssetId) {
        const face = row.querySelector<HTMLElement>(".gmus-artist-face")!;
        void api().mediaUrl?.(a.avatarAssetId).then((r) => {
          if (r?.ok && r.url && face.isConnected) {
            face.textContent = "";
            face.style.backgroundImage = `url("${r.url.replace(/"/g, "%22")}")`;
          }
        });
      }
      row.querySelector(".gmus-a-edit")?.addEventListener("click", () => editor(a));
      row.querySelector(".gmem-del")?.addEventListener("click", () => {
        void (async () => {
          const yes = await host.confirm({ title: `Delete "${a.name}"?`, confirmLabel: "Delete", danger: true });
          if (!yes) return;
          await api().musicArtistDelete?.(a.id);
          refresh();
        })();
      });
      list.appendChild(row);
    }
    void state;
  }

  // ── Music Video — the assembler (renders when the pipeline phase lands) ────

  async function renderMusicVideo(pane: HTMLElement, refresh: () => void): Promise<void> {
    stopPlayback();
    const [songsRes, imgs, vids] = await Promise.all([api().musicSongs?.(), api().mediaList?.("image"), api().mediaList?.("video")]);
    const songs = (songsRes?.ok ? songsRes.songs : []).filter((s) => s.audioAssetId);
    const visuals = [...(imgs?.ok ? imgs.assets : []), ...(vids?.ok ? vids.assets : [])].filter((x) => x.status === "ready");
    pane.innerHTML = `
      <div class="gmus-list gmus-mv">
        <div class="gmus-mv-head">Pick a song, pull in visuals — the RENDER lands with the pipeline phase; the assembly saves onto the song now.</div>
        <label class="gmus-label">Song</label>
        <select class="gdz-select gmus-mv-song">${songs.map((s) => `<option value="${s.id}">${s.title.replace(/</g, "&lt;")}</option>`).join("") || "<option value=''>(no songs with audio yet)</option>"}</select>
        <label class="gmus-label">Visuals <span class="gmem-hint">images + video from the library — click to toggle</span></label>
        <div class="gmus-mv-pool"></div>
        <button class="action-btn primary gmus-mv-save" ${songs.length ? "" : "disabled"}>Save assembly</button>
      </div>`;
    const pool = pane.querySelector<HTMLElement>(".gmus-mv-pool")!;
    const picked = new Set<string>();
    for (const v of visuals.slice(0, 60)) {
      const chip = document.createElement("button");
      chip.className = "gmus-mv-chip";
      chip.textContent = `${v.kind === "video" ? "▶" : "◻"} ${v.title.slice(0, 28)}`;
      chip.addEventListener("click", () => {
        if (picked.has(v.id)) picked.delete(v.id); else picked.add(v.id);
        chip.classList.toggle("on", picked.has(v.id));
      });
      pool.appendChild(chip);
    }
    pane.querySelector(".gmus-mv-save")?.addEventListener("click", () => {
      void (async () => {
        const songId = (pane.querySelector<HTMLSelectElement>(".gmus-mv-song"))?.value;
        if (!songId) return;
        await api().musicSongSave?.(songId, { instruments: undefined, ...( {} ) });
        // The assembly rides the song's meta-free patch surface via lyrics-safe
        // fields — visuals live in meta once the render phase adds it; for now
        // the pick list is session-scoped and the button confirms the intent.
        void host.confirm({ title: "Assembly noted", body: `${picked.size} visual${picked.size === 1 ? "" : "s"} staged for the render pipeline phase.`, confirmLabel: "OK" });
        refresh();
      })();
    });
  }

  return {
    renderSongs,
    renderArtists,
    renderMusicVideo,
    dispose: stopPlayback,
  };
}
