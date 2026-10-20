/**
 * composer-state — what the composer's bottom-right slot shows (his order,
 * 2026-10-07, Claude's composer as the reference). ONE primary button whose
 * face follows the state, and the two voice presentations around it:
 *
 *   voice  — empty box, idle: no send; the mic chip + speak toggle sit there.
 *   send   — text typed, idle: the voice pair hides; an accent-filled round ↑.
 *   stop   — a turn in flight: a "▪ Stop" pill that stops the run.
 *   ptt    — dictation is listening: the dotted level meter, then ✕ and ✓.
 *   free   — hands-free is listening: the mic chip stays, a "▮▮▮ Stop" pill
 *            sits right of it.
 *
 * Pure — the DOM paint in help/code.ts sets `data-slot` from this and the
 * stylesheet does the rest. The level meter maths (RMS → level → dots / bar
 * width) lives here too so the drawing stays a loop over numbers.
 */

/** Where the recorder stands (help/voice-mic.ts). */
export type VoiceState = "off" | "ptt" | "free" | "transcribing";

export interface ComposerState {
  /** The textarea's value. */
  text: string;
  /** This session's turn is in flight. */
  running: boolean;
  voice: VoiceState;
}

export type ComposerSlot = "voice" | "send" | "stop" | "ptt" | "free";
export type ComposerPrimary = "none" | "send" | "stop";

/** The slot's presentation. A listening recorder wins over everything: the
 *  member is mid-gesture, and ✕ / Stop are its only doors. Then the run
 *  (Stop), then typed text (send), else the voice pair. */
export function composerSlot(s: ComposerState): ComposerSlot {
  if (s.voice === "ptt") return "ptt";
  if (s.voice === "free") return "free";
  if (s.running) return "stop";
  if (s.text.trim()) return "send";
  return "voice";
}

/** The ONE primary button's face, or none. */
export function composerPrimary(s: ComposerState): ComposerPrimary {
  const slot = composerSlot(s);
  return slot === "send" || slot === "stop" ? slot : "none";
}

/** Enter: sends in the typed state, queues a note mid-run (the existing
 *  rule), and does nothing while the recorder listens. */
export function composerTakesEnter(s: ComposerState): boolean {
  const slot = composerSlot(s);
  return slot === "send" || slot === "stop";
}

/** The placeholder while the recorder listens (both modes: the continuous
 *  mode transcribes on stop too — no streaming STT is invented). */
export const LISTENING_PLACEHOLDER = "Listening…";
export function composerListening(s: ComposerState): boolean {
  const slot = composerSlot(s);
  return slot === "ptt" || slot === "free";
}

// ── Level meter maths ─────────────────────────────────────────────────────────

/** RMS of 8-bit time-domain samples (AnalyserNode.getByteTimeDomainData:
 *  128 = silence). 0 for an empty buffer. */
export function rmsOf(samples: ArrayLike<number>): number {
  const n = samples.length;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) { const x = (samples[i] - 128) / 128; sum += x * x; }
  return Math.sqrt(sum / n);
}

/** Speech sits around 0.02–0.2 RMS; map that onto 0..1 with a gain of 5,
 *  clamped. NaN / negatives read as silence. */
export function levelOf(rms: number): number {
  if (!(rms > 0)) return 0;
  return Math.min(1, rms * 5);
}

/** The menu's horizontal bar: the level as a whole percent of the track. */
export function levelBarWidth(level: number): number {
  if (!(level > 0)) return 0;
  return Math.round(Math.min(1, level) * 100);
}

export const METER_DOTS = 10;
export interface MeterDot {
  /** Height as a fraction of the meter's height (the dot's own size is the floor). */
  h: number;
  /** Opacity 0..1. */
  a: number;
}
/** The dotted meter: `n` dots whose height and opacity follow the level,
 *  centre-weighted so a loud moment bulges in the middle like a voice
 *  does. Silence = a row of small, dim dots. */
export function meterDots(level: number, n = METER_DOTS): MeterDot[] {
  const lv = level > 0 ? Math.min(1, level) : 0;
  const c = (n - 1) / 2;
  const out: MeterDot[] = [];
  for (let i = 0; i < n; i++) {
    const w = c > 0 ? 1 - Math.abs(i - c) / (c + 1) : 1;   // 1 at the centre, >0 at the ends
    const v = lv * w;
    out.push({ h: Math.min(1, 0.18 + v * 0.82), a: Math.min(1, 0.35 + v * 0.65) });
  }
  return out;
}
