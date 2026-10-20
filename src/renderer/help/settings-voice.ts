/**
 * settings-voice — THE VOICE ROWS of Settings → General (his order, 2026-10-07:
 * "all this is on by default, the only setting that should be there is the
 * dropdown", then "bring back the flag that shortens the agent's reply in
 * voice mode"). The mic, dictation, voice mode and spoken replies are always
 * on; the member picks the VOICE they hear, from the speech model the super
 * admin flagged — its curated list, else the provider's own voices
 * (`window.glyphh.voiceConfig()`); nothing listed says so in one line. The
 * one switch is BRIEF: short spoken replies in voice mode, on by default.
 */

import { keepIfHost } from "./web-surface.js";

export interface VoiceConfigView { tts: string | null; voice: string | null; voices: string[] }
export interface VoicePrefView { voiceId?: string | null; /** Short replies in voice mode; absent = on. */ brief?: boolean | null }

/** What the row paints — the pure answer the DOM and the test both read. */
export interface VoiceSectionModel {
  /** The dropdown's options, or null when nothing is listed. */
  voiceOptions: Array<{ value: string; label: string }> | null;
  /** The muted line that stands in for an empty dropdown. */
  voicesLine: string | null;
  /** The dropdown's current value ("" = the admin's default). */
  voiceValue: string;
  /** The Brief switch: short spoken replies in voice mode (on unless turned off). */
  brief: boolean;
}

export const NO_SPEECH_MODEL_LINE = "No speech model is set up for your organization yet.";
export const NO_VOICES_LINE = "The speech model lists no voices yet.";

/** Unwrap a door's answer: the desktop hands the object raw, the web's
 *  contract wraps it ({ok, data}). Never throws on a bad shape. */
function unwrap(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const o = raw as Record<string, unknown>;
  if ("ok" in o && "data" in o) return (o.data && typeof o.data === "object" ? o.data : {}) as Record<string, unknown>;
  return o;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** The admin's speech config; a missing `voices` reads as []. */
export function readVoiceConfig(raw: unknown): VoiceConfigView {
  const o = unwrap(raw);
  const voices = Array.isArray(o.voices) ? o.voices.filter((v): v is string => typeof v === "string" && !!v) : [];
  return { tts: str(o.tts), voice: str(o.voice), voices };
}

/** The member's own pick. */
export function readVoicePref(raw: unknown): VoicePrefView {
  const o = unwrap(raw);
  return { voiceId: str(o.voiceId), brief: o.brief !== false };
}

export function voiceSectionModel(cfg: VoiceConfigView, pref: VoicePrefView): VoiceSectionModel {
  const brief = pref.brief !== false;
  if (!cfg.tts) return { voiceOptions: null, voicesLine: NO_SPEECH_MODEL_LINE, voiceValue: "", brief };
  const voices = cfg.voices;
  if (!voices.length) return { voiceOptions: null, voicesLine: NO_VOICES_LINE, voiceValue: "", brief };
  const voiceOptions = [
    { value: "", label: cfg.voice && voices.includes(cfg.voice) ? `${cfg.voice} (default)` : "Default" },
    ...voices.filter((v) => v !== cfg.voice).map((v) => ({ value: v, label: v })),
  ];
  // A saved voice that is no longer listed falls back to the default row.
  const voiceValue = pref.voiceId && voices.includes(pref.voiceId) && pref.voiceId !== cfg.voice ? pref.voiceId : "";
  return { voiceOptions, voicesLine: null, voiceValue, brief };
}

/** The patch the dropdown writes. */
export const voicePatch = {
  voice: (value: string): Partial<VoicePrefView> => ({ voiceId: value || null }),
  brief: (on: boolean): Partial<VoicePrefView> => ({ brief: on }),
};

// ── the DOM ──────────────────────────────────────────────────────────────────

interface VoiceDoors {
  voiceConfig?: () => Promise<unknown>;
  voiceSettingsGet?: () => Promise<unknown>;
  voiceSettingsSet?: (patch: Partial<VoicePrefView>) => Promise<unknown>;
}
const doors = (): VoiceDoors => (window as unknown as { glyphh: VoiceDoors }).glyphh;
const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c] as string));

/** The sections already wired (the DOM is static; a reload repaints only). */
const wired = new WeakSet<HTMLElement>();

function paint(m: VoiceSectionModel): void {
  const sel = $<HTMLSelectElement>("voice-voice");
  if (sel) {
    sel.innerHTML = (m.voiceOptions ?? []).map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("");
    sel.value = m.voiceValue;
    sel.classList.toggle("hidden", !m.voiceOptions);
  }
  const line = $("voice-voices-line");
  if (line) { line.textContent = m.voicesLine ?? ""; line.classList.toggle("hidden", !m.voicesLine); }
  const brief = $<HTMLInputElement>("voice-brief");
  if (brief) brief.checked = m.brief;
}

function setErr(msg: string): void {
  const e = $("voice-settings-error");
  if (e) { e.textContent = msg; e.classList.toggle("hidden", !msg); }
}

async function save(patch: Partial<VoicePrefView>): Promise<void> {
  try {
    await doors().voiceSettingsSet?.(patch);
    setErr("");
  } catch (e) { setErr(`Couldn't save — ${(e as Error).message}`); }
}

function wire(section: HTMLElement): void {
  if (wired.has(section)) return;
  wired.add(section);
  $<HTMLSelectElement>("voice-voice")?.addEventListener("change", (e) => void save(voicePatch.voice((e.target as HTMLSelectElement).value)));
  $<HTMLInputElement>("voice-brief")?.addEventListener("change", (e) => void save(voicePatch.brief((e.target as HTMLInputElement).checked)));
}

/** Populate the Voice row of Settings → General. The section hides on a host
 *  that serves no voice doors (web-surface keepIfHost). */
export async function loadVoiceSection(): Promise<void> {
  const section = $("voice-section");
  if (!section) return;
  if (!keepIfHost(section, "voiceConfig", "voiceSettingsGet", "voiceSettingsSet")) return;
  setErr("");
  const [cfgRaw, prefRaw] = await Promise.all([
    Promise.resolve().then(() => doors().voiceConfig?.()).catch(() => undefined),
    Promise.resolve().then(() => doors().voiceSettingsGet?.()).catch(() => undefined),
  ]);
  paint(voiceSectionModel(readVoiceConfig(cfgRaw), readVoicePref(prefRaw)));
  wire(section);
}
