/**
 * ui-sounds.ts — tiny synthesized interface sounds (no audio assets).
 *
 * Two sounds, both WebAudio-generated and very quiet:
 *   "tick"  — a ~12ms high blip for hovering apps on the command center
 *   "focus" — a softer, lower ~45ms thunk for clicking into the agent input
 *
 * Exposed as window.__uiSound(kind) so the esbuild-bundled workbench
 * (code-workbench.ts) can play them without an import seam. The AudioContext
 * is created lazily and resumed on demand — browsers gate audio behind a user
 * gesture, and hover may fire first; a still-suspended context just skips the
 * sound rather than queuing stale blips.
 */

type UiSoundKind = "tick" | "focus";

/** Volume 0..1 from the server-backed pref (uiSoundVolume; Settings > General
 *  slider). Loaded lazily once; the slider pushes live changes through
 *  __uiSoundSetVolume. 0 = silent. Default LOW (0.3). */
let volume = 0.3;
let volumeLoaded = false;
function loadVolume(): void {
  if (volumeLoaded) return;
  volumeLoaded = true;
  const g = (window as unknown as { glyphh?: { getPreference?: (k: string, d?: unknown) => Promise<unknown> } }).glyphh;
  void g?.getPreference?.("uiSoundVolume", 0.3)?.then((v) => {
    const n = Number(v);
    if (Number.isFinite(n)) volume = Math.max(0, Math.min(1, n));
  }).catch(() => { /* keep the default */ });
}
(window as unknown as { __uiSoundSetVolume?: (v: number) => void }).__uiSoundSetVolume = (v: number) => {
  volumeLoaded = true;   // the slider is now the live authority
  volume = Math.max(0, Math.min(1, Number(v) || 0));
};

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (!ctx) {
    try {
      const AC = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext });
      const Ctor = AC.AudioContext ?? AC.webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    } catch { return null; }
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx.state === "running" ? ctx : null;
}

/** A blip: one oscillator through an exponential-decay gain. */
function blip(freq: number, ms: number, peak: number, type: OscillatorType): void {
  const ac = audio();
  if (!ac) return;
  const t0 = ac.currentTime;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(peak, t0);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000);
  osc.connect(gain).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + ms / 1000 + 0.01);
}

/** Hover ticks fire in bursts as the cursor sweeps a page of tiles — a small
 *  floor between plays keeps a sweep from turning into a zipper. */
let lastTick = 0;

export function uiSound(kind: UiSoundKind): void {
  loadVolume();
  if (volume <= 0) return;
  // Peaks scale with the pref: the old fixed levels (0.05 / 0.07) sit at the
  // default 30% -- full slider is ~3x that, still gentle.
  if (kind === "tick") {
    const now = performance.now();
    if (now - lastTick < 45) return;
    lastTick = now;
    blip(1900, 14, 0.17 * volume, "square");
  } else {
    blip(340, 45, 0.23 * volume, "triangle");
  }
}

(window as unknown as { __uiSound?: (kind: UiSoundKind) => void }).__uiSound = uiSound;
