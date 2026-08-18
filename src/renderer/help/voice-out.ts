/**
 * voice-out.ts — the agent's VOICE OUT. Two jobs, both dependency-free (WebAudio,
 * no bundled assets):
 *   1) cue()  — short tones so the user knows, without looking, that recording
 *      started / stopped / a turn was submitted.
 *   2) playReplyTTS() — when Settings › Voice sets an output (TTS) model and
 *      autoplay is on, speak the agent's reply aloud. Returns a promise that
 *      resolves when playback ends, so hands-free mode can re-listen after.
 */

const g = (): Record<string, ((...a: unknown[]) => unknown) | undefined> =>
  (window as unknown as { glyphh: Record<string, ((...a: unknown[]) => unknown) | undefined> }).glyphh;

// ── Cue tones ────────────────────────────────────────────────────────────────
let actx: AudioContext | null = null;
function audio(): AudioContext | null {
  try {
    const Ctor = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    actx ??= new Ctor();
    if (actx.state === "suspended") void actx.resume();
    return actx;
  } catch { return null; }
}

/** A tiny two-note chirp. start = rising (listening), stop = falling (done),
 *  submit = a brighter double-blip (message went). All ~0.2s, gentle gain. */
export function cue(kind: "start" | "stop" | "submit"): void {
  const ac = audio();
  if (!ac) return;
  const now = ac.currentTime;
  const pair = kind === "start" ? [620, 880] : kind === "stop" ? [880, 560] : [720, 1040];
  const o = ac.createOscillator();
  const gain = ac.createGain();
  o.type = "sine";
  o.connect(gain); gain.connect(ac.destination);
  o.frequency.setValueAtTime(pair[0], now);
  o.frequency.exponentialRampToValueAtTime(pair[1], now + 0.11);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.16, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
  o.start(now);
  o.stop(now + 0.22);
}

// ── Reply text-to-speech ──────────────────────────────────────────────────────
let playing: HTMLAudioElement | null = null;

// Speaking-state subscribers — the composer shows a "Stop" chip while true.
const speakingSubs = new Set<(speaking: boolean) => void>();
function emitSpeaking(on: boolean): void { for (const cb of speakingSubs) { try { cb(on); } catch { /* subscriber threw */ } } }
/** Subscribe to speaking on/off. Returns an unsubscribe fn. */
export function onSpeaking(cb: (speaking: boolean) => void): () => void { speakingSubs.add(cb); return () => speakingSubs.delete(cb); }
/** Is the agent's reply currently playing? */
export function isSpeaking(): boolean { return playing !== null; }

/** Stop any in-flight reply playback (user hit Stop / Esc, started talking, or a
 *  new turn began, so the agent doesn't talk over itself). */
export function stopReply(): void {
  if (playing) { try { playing.pause(); } catch { /* already gone */ } playing = null; emitSpeaking(false); }
}

/** Speech is for the ear: drop code fences, markdown syntax and URLs, collapse
 *  whitespace, and cap the length so autoplay stays quick and cheap. */
function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " (code) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_#>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}

/** The synth bridge returns an ArrayBuffer on desktop (raw IPC) or the web
 *  `lib()` envelope ({ok, data}) whose data is the bytes. Read both. */
function asBytes(res: unknown): ArrayBuffer | null {
  if (res instanceof ArrayBuffer) return res;
  if (ArrayBuffer.isView(res)) return (res as ArrayBufferView).buffer as ArrayBuffer;
  if (res && typeof res === "object") {
    const d = (res as { data?: unknown }).data;
    if (d instanceof ArrayBuffer) return d;
    if (ArrayBuffer.isView(d)) return (d as ArrayBufferView).buffer as ArrayBuffer;
  }
  return null;
}

interface OutPref { outputModel?: string | null; voiceId?: string | null; autoplay?: boolean }

/** Speak the reply if autoplay + an output model are set. Resolves when playback
 *  finishes (or immediately when disabled / on any failure) so callers can chain. */
export async function playReplyTTS(text: string, pref: OutPref): Promise<void> {
  if (!pref.autoplay || !pref.outputModel) return;
  const say = speakable(text || "");
  if (!say) return;
  stopReply();
  try {
    const bytes = asBytes(await g().voiceSynthesize?.(say, pref.outputModel, pref.voiceId ?? null));
    if (!bytes || bytes.byteLength === 0) return;
    const url = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
    await new Promise<void>((resolve) => {
      const a = new Audio(url);
      playing = a;
      emitSpeaking(true);
      const done = (): void => { URL.revokeObjectURL(url); if (playing === a) { playing = null; emitSpeaking(false); } resolve(); };
      a.onended = done;
      a.onerror = done;
      void a.play().catch(done);
    });
  } catch { /* TTS unavailable — stay silent, never block the turn */ }
}
