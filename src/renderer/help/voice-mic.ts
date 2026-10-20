/**
 * voice-mic.ts — the composer's voice input. When Settings › Voice sets a
 * transcription model, a mic chip (+ a caret opening the device/mode menu)
 * appears by the permission-mode / + controls. Two modes, chosen by the menu's
 * "Hold to record" toggle:
 *   • push-to-talk (hold ON)  — hold the chip to record, release to transcribe
 *     into the composer (the user still sends).
 *   • hands-free   (hold OFF) — click once to start a talking session: it listens,
 *     auto-stops on silence, transcribes, SUBMITS the turn, speaks the reply
 *     (voice-out), then listens again until the user clicks to stop.
 * Start/stop cues (voice-out) tell the user where they are without looking.
 */

import { cue, playReplyTTS, stopReply } from "./voice-out.js";
import { levelBarWidth, levelOf, meterDots, rmsOf, type VoiceState } from "./composer-state.js";
import { dictationText, partialDue, transcribeErrorText, SPEECH_STEER } from "./voice-text.js";
export { SPEECH_STEER };
import { micChecked, micRows } from "./mic-devices.js";

interface VoicePref {
  mode?: "off" | "push-to-talk" | "continuous";
  inputModel?: string | null;
  outputModel?: string | null;
  voiceId?: string | null;
  deviceId?: string | null;
  autoplay?: boolean;
  brief?: boolean;
}
interface VoiceItem { id: string; name: string }

const el = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;
const g = (): Record<string, ((...a: unknown[]) => unknown) | undefined> =>
  (window as unknown as { glyphh: Record<string, ((...a: unknown[]) => unknown) | undefined> }).glyphh;

let recorder: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let chunks: Blob[] = [];
let startedAt = 0;
// Hands-free session: the user has clicked the chip to "just talk". Stays true
// across listen → transcribe → submit → reply → listen until they click to stop.
let handsFree = false;
let awaitingReply = false;   // submitted a turn; hold off re-listening until it lands
// The user clicked the chip to END a hands-free session mid-utterance: what
// was said still SUBMITS (the click means "done talking", not "discard" —
// his report, 2026-09-08), and then the session ends instead of re-listening.
let endAfterUtterance = false;

// The REAL composer submit, registered by code.ts — the same path the Enter
// key takes (queues mid-run instead of turning into Stop). The old synthetic
// el("code-send").click() was silently swallowed whenever the button was
// disabled, and would have CANCELLED a live run.
let submitFn: (() => void) | null = null;
export function registerComposerSubmit(fn: () => void): void { submitFn = fn; }
/** True when the submit fired; false when the composer was gated. */
function submitComposer(): boolean {
  // Mirror the Enter key's reach: a gated composer takes no keydown, so a
  // gated hands-free utterance stays in the box for the user instead of
  // firing into a source that isn't ready.
  const ta = el<HTMLTextAreaElement>("code-input");
  if (ta?.disabled) return false;
  if (submitFn) submitFn();
  else el("code-send")?.click();
  return true;
}
// Live meter: one AudioContext + analyser drives BOTH the dotted level meter and
// (hands-free only) the silence detector.
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let waveRaf = 0;
let vadTimer: ReturnType<typeof setInterval> | null = null;

// ── Where the recorder stands — the composer's slot paints from this (his
// order, 2026-10-07): "ptt" = dictation listening (✕ / ✓ + the meter),
// "free" = hands-free listening (mic + the ▮▮▮ Stop pill), "transcribing"
// = stopped, text on its way, "off" = idle. help/code.ts subscribes.
let vstate: VoiceState = "off";
const stateSubs = new Set<(s: VoiceState) => void>();
function setVoiceState(s: VoiceState): void {
  if (vstate === s) return;
  vstate = s;
  // DICTATION LIGHTS THE BOX (his order, 2026-10-07): a faint glow in the
  // theme's primary while the take records and transcribes; voice mode has
  // its own bar and stays dark.
  el("code-input")?.closest(".code-composer")?.classList.toggle("dictating", s === "ptt" || s === "transcribing");
  for (const cb of stateSubs) { try { cb(s); } catch { /* subscriber threw */ } }
}
/** The recorder's state right now. */
export function voiceState(): VoiceState { return vstate; }
/** Subscribe to state changes. Returns an unsubscribe fn. */
export function onVoiceState(cb: (s: VoiceState) => void): () => void { stateSubs.add(cb); return () => stateSubs.delete(cb); }
// ✕ pressed: the take is thrown away when the recorder stops.
let discard = false;

/** ✓ — stop recording and transcribe through the usual path (the text lands
 *  in the composer; in hands-free it submits). */
export function acceptRecording(): void { stopRecording(); }
/** ✕ / Esc — stop recording and discard the take; back to idle. In a
 *  hands-free session this ends the session too. */
export function cancelRecording(): void {
  if (!recorder || recorder.state !== "recording") return;
  discard = true;
  handsFree = false;
  awaitingReply = false;
  endAfterUtterance = false;
  stopRecording();
}
/** The ▮▮▮ Stop pill — end the hands-free session, keeping what was said
 *  in the composer WITHOUT submitting it (his order, 2026-10-07: "Stop ends
 *  listening and leaves the text in the composer"). */
export function stopHandsFree(): void {
  handsFree = false;
  awaitingReply = false;
  endAfterUtterance = false;
  voiceModeOn = false;
  stopReply();                       // voice mode is over: hush a reply playing or still synthesizing
  paintVoiceMode();
  stopRecording();
}
/** The live input level (0..1) off the recorder's analyser, or null when
 *  nothing is recording. */
function currentLevel(): number | null {
  if (!analyser) return null;
  const buf = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(buf);
  return levelOf(rmsOf(buf));
}

// BRIEF REPLIES IN VOICE MODE (his order, 2026-10-07: the flag is back, as the
// switch in Settings › Voice, on by default): the steer rides a turn only
// while voice mode is on — dictation and typed turns are untouched. It shapes
// BOTH the spoken reply and what's rendered, since it steers the turn itself
// (not just playback). Cached so the synchronous send() can read it.
let cachedBrief = true;
/** The steer to prepend to a turn's prompt, or "" outside voice mode / with Brief off. */
export function briefSteer(): string { return voiceModeOn && cachedBrief ? SPEECH_STEER : ""; }

/** The super admin's speech models (GET /api/voice/config: stt, tts, voice),
 *  read once a minute. The feature is always on and available (his order,
 *  2026-10-06): a member who never picked models speaks and listens on these. */
interface VoiceConfig { stt?: string | null; tts?: string | null; voice?: string | null }
let configCache: { at: number; cfg: VoiceConfig } | null = null;
async function voiceConfig(): Promise<VoiceConfig> {
  if (configCache && Date.now() - configCache.at < 60_000) return configCache.cfg;
  let cfg: VoiceConfig = {};
  try {
    const res = await g().voiceConfig?.();
    if (res && typeof res === "object") {
      const o = res as Record<string, unknown>;
      cfg = ((o.data && typeof o.data === "object" ? o.data : o) as VoiceConfig) ?? {};
    }
  } catch { /* no config door — the member's own settings stand alone */ }
  configCache = { at: Date.now(), cfg };
  return cfg;
}

async function voicePref(): Promise<VoicePref> {
  let pref: VoicePref = {};
  try {
    const res = await g().voiceSettingsGet?.();
    if (res && typeof res === "object") {
      const o = res as Record<string, unknown>;
      // web contract wraps the result ({ok,data}); desktop IPC returns it raw.
      pref = ((o.data && typeof o.data === "object" ? o.data : o) as VoicePref) ?? {};
      cachedBrief = pref.brief !== false;   // keep the sync steer cache warm; absent = on
    }
  } catch { /* no voice settings */ }
  // The super admin's models fill what the member left unset; a member's own
  // picks (Settings › Voice) always win. With a transcription model on hand
  // the mic is on by default — "off" is a choice the member makes there.
  const cfg = await voiceConfig();
  const merged: VoicePref = {
    ...pref,
    inputModel: pref.inputModel || cfg.stt || null,
    outputModel: pref.outputModel || cfg.tts || null,
    voiceId: pref.voiceId || cfg.voice || null,
  };
  if (merged.mode === undefined && merged.inputModel) merged.mode = "push-to-talk";
  return merged;
}

async function setPref(patch: Partial<VoicePref>): Promise<void> {
  try { await g().voiceSettingsSet?.(patch); } catch { /* offline — keep going */ }
}

// ── VOICE MODE (his order, 2026-10-07, Claude's composer): the bigger button
// right of the mic. On = a spoken conversation for this session — listen,
// submit what was said, read the reply aloud, listen again — until the member
// turns it off (the button, or the ▮▮▮ Stop pill). The mic itself is DICTATE.
let voiceModeOn = false;
export function voiceMode(): boolean { return voiceModeOn; }
function paintVoiceMode(): void {
  const btn = el<HTMLButtonElement>("code-voice-mode");
  if (!btn) return;
  btn.classList.toggle("on", voiceModeOn);
  btn.setAttribute("aria-pressed", voiceModeOn ? "true" : "false");
  btn.title = voiceModeOn ? "Voice mode is on — click to end" : "Voice mode";
}
export async function toggleVoiceMode(): Promise<void> {
  if (voiceModeOn) { stopHandsFree(); return; }
  if (osDenied) { void (window.glyphh as unknown as { micOpenSettings?: () => Promise<unknown> }).micOpenSettings?.(); return; }
  if (recorder) return;
  voiceModeOn = true;
  handsFree = true;
  paintVoiceMode();
  if (!(await startRecording())) { voiceModeOn = false; handsFree = false; paintVoiceMode(); }
}

// MUTE in voice mode (Claude's voice bar): the track goes quiet, the silence
// detector waits, the session stays up; unmute carries on.
let muted = false;
function paintMute(): void {
  const b = el<HTMLButtonElement>("code-voice-mute");
  if (!b) return;
  b.classList.toggle("on", muted);
  b.setAttribute("aria-pressed", muted ? "true" : "false");
  b.title = muted ? "Unmute" : "Mute";
}
export function toggleMute(): void {
  muted = !muted;
  stream?.getAudioTracks().forEach((t) => { t.enabled = !muted; });
  paintMute();
}

/** Show each voice control only when its models exist: the mic (dictation)
 *  needs a transcription model; voice mode — listen, then read the reply
 *  aloud — needs a speech model too. `fresh` drops the cached setup, for when
 *  Settings › Models changed it. */
export async function refreshMicChip(fresh = false): Promise<void> {
  const wrap = el("code-mic-wrap");
  if (!wrap) return;
  if (fresh) configCache = null;
  const p = await voicePref();
  wrap.classList.toggle("hidden", !p.inputModel);
  const canSpeak = !!p.inputModel && !!p.outputModel;
  el("code-voice-mode")?.classList.toggle("hidden", !canSpeak);
  if (!canSpeak && voiceModeOn) stopHandsFree();
  const chip = el("code-mic-chip");
  if (chip && !chip.classList.contains("mic-error")) chip.title = "Dictate";
  paintVoiceMode();
}

// ── THE LIVE TRANSCRIPT (his order, 2026-10-07): the box fills as the member
// speaks. The take is recorded in one-second slices; every PARTIAL_EVERY_MS
// the slices so far go for a transcript and the box shows it after the text
// that was there when the take began; the final transcript replaces the last
// partial. One partial in flight at a time; the final waits for it.
let dictBase = "";
/** Every take has a number; a paint from a take that is no longer current is
 *  dropped (his report, 2026-10-07: the submitted text came back into the
 *  box — a late paint landed after the send had cleared it). */
let takeId = 0;
let partialTimer: ReturnType<typeof setInterval> | null = null;
let partialInflight: Promise<void> | null = null;
let partialAt = 0;
function paintTranscript(text: string): void {
  const ta = el<HTMLTextAreaElement>("code-input");
  if (!ta) return;
  ta.value = dictationText(dictBase, text);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}
function takeBlob(): Blob { return new Blob(chunks, { type: recorder?.mimeType || "audio/webm" }); }
async function transcribeBlob(blob: Blob, model: string): Promise<string> {
  if (!blob.size) return "";
  return readText(await g().voiceTranscribe?.(await blob.arrayBuffer(), blob.type, model, Date.now() - startedAt));
}
function startPartials(model: string): void {
  stopPartials();
  partialAt = 0;
  partialTimer = setInterval(() => {
    if (!recorder || recorder.state !== "recording" || discard) return;
    if (!partialDue(Date.now(), startedAt, partialAt, !!partialInflight)) return;
    partialAt = Date.now();
    const blob = takeBlob();
    const mine = takeId;
    partialInflight = transcribeBlob(blob, model)
      .then((text) => { if (mine === takeId && recorder && recorder.state === "recording" && !discard && text) paintTranscript(text); })
      .catch((e) => console.warn("[voice] partial transcript:", e))
      .finally(() => { partialInflight = null; });
  }, 500);
}
function stopPartials(): void {
  if (partialTimer) { clearInterval(partialTimer); partialTimer = null; }
}

/** The transcribe bridge returns {text} on desktop or an envelope on web. */
function readText(res: unknown): string {
  if (!res || typeof res !== "object") return "";
  const o = res as Record<string, unknown>;
  if (typeof o.text === "string") return o.text;
  const data = o.data as Record<string, unknown> | undefined;
  return typeof data?.text === "string" ? data.text : "";
}

// ── Live meter: waveform overlay + (hands-free) silence detection ─────────────
function startMeter(src: MediaStream): void {
  try {
    const Ctor = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    audioCtx = new Ctor();
    const node = audioCtx.createMediaStreamSource(src);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    node.connect(analyser);
    drawDots();                 // the dotted level meter in the composer's slot
    if (handsFree) startVadLoop();
  } catch { /* metering unsupported — recording itself still works */ }
}

function stopMeter(): void {
  if (waveRaf) { cancelAnimationFrame(waveRaf); waveRaf = 0; }
  if (vadTimer) { clearInterval(vadTimer); vadTimer = null; }
  analyser = null;
  if (audioCtx) { try { void audioCtx.close(); } catch { /* already closed */ } audioCtx = null; }
}

/** Paint the dotted level meter (#code-rec-wave): a row of dots whose height
 *  and opacity follow the live input level (composer-state meterDots). The
 *  slot shows the canvas only while dictation listens (data-slot="ptt"); a
 *  hidden canvas measures 0×0 and the frame just waits. */
function drawDots(): void {
  const canvas = el<HTMLCanvasElement>("code-rec-wave");
  if (!canvas || !analyser) return;
  const ctx2d = canvas.getContext("2d");
  if (!ctx2d) return;
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#af5fff";
  const tick = (): void => {
    if (!analyser || !ctx2d) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w === 0 || h === 0) { waveRaf = requestAnimationFrame(tick); return; }
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, w, h);
    const dots = meterDots(currentLevel() ?? 0);
    const n = dots.length;
    const pitch = w / n;                          // one cell per dot
    const r = Math.min(2.5, pitch / 2 - 1);       // the dot's radius (its floor height)
    ctx2d.fillStyle = accent;
    for (let i = 0; i < n; i++) {
      const { h: hf, a } = dots[i];
      const bh = Math.max(r * 2, hf * h);         // a dot grows into a rounded bar
      const x = i * pitch + pitch / 2;
      ctx2d.globalAlpha = a;
      ctx2d.beginPath();
      ctx2d.roundRect(x - r, (h - bh) / 2, r * 2, bh, r);
      ctx2d.fill();
    }
    waveRaf = requestAnimationFrame(tick);
  };
  tick();
}

function startVadLoop(): void {
  if (!analyser) return;
  const buf = new Uint8Array(analyser.fftSize);
  let spoke = false, silenceAt = 0;
  const openedAt = Date.now();
  // A SECOND of quiet ends the utterance (was 1.3s; his report, 2026-10-07: "a lag").
  const SPEAK = 0.025, SILENCE_MS = 1000, MAX_MS = 30000;
  vadTimer = setInterval(() => {
    if (muted) { spoke = false; silenceAt = 0; return; }
    if (!analyser) return;
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const x = (buf[i] - 128) / 128; sum += x * x; }
    const rms = Math.sqrt(sum / buf.length);
    const now = Date.now();
    if (rms > SPEAK) { spoke = true; silenceAt = 0; }
    else if (spoke) { if (!silenceAt) silenceAt = now; else if (now - silenceAt > SILENCE_MS) stopRecording(); }
    if (now - openedAt > MAX_MS) stopRecording();
  }, 100);
}

// ── Record / transcribe ───────────────────────────────────────────────────────
async function startRecording(): Promise<boolean> {
  const p = await voicePref();
  if (!p.inputModel || recorder) return false;
  stopReply();                       // never capture the agent's own voice
  if (!navigator.mediaDevices?.getUserMedia) { micError("This browser can't access the microphone."); handsFree = false; return false; }
  // DESKTOP: settle the OS permission BEFORE asking Chromium for the stream
  // (his report, 2026-08-29: the button flashed and went cold). A macOS TCC
  // denial surfaces from getUserMedia as a bare NotAllowedError — the same
  // error a web page gets — so the old message told the user to allow access
  // "for this site", which is not where the switch lives. Ask the OS first
  // and name the real state.
  const osMic = (window.glyphh as unknown as { micAccessStatus?: () => Promise<{ status: string }> }).micAccessStatus;
  if (osMic) {
    try {
      const { status } = await osMic();
      if (status === "denied" || status === "restricted") {
        micError("macOS is blocking the microphone for Glyphh — click here to open Privacy & Security › Microphone.", true);
        handsFree = false;
        return false;
      }
    } catch { /* status unavailable — fall through and let getUserMedia decide */ }
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: p.deviceId ? { deviceId: { exact: p.deviceId } } : true });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    // A SAVED DEVICE THAT IS GONE (unplugged mic, changed default) throws
    // OverconstrainedError — retry once on the system default rather than
    // making the user go find the setting.
    if (name === "OverconstrainedError" || name === "NotFoundError") {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e2) {
        micError(`Microphone unavailable (${(e2 as { name?: string })?.name || "error"}).`, true);
        console.error("[voice] getUserMedia retry failed", e2);
        handsFree = false; el("code-mic-chip")?.classList.remove("recording"); return false;
      }
    } else {
      micError(name === "NotAllowedError" || name === "SecurityError"
        ? (osMic ? "Microphone blocked — open Privacy & Security › Microphone and allow Glyphh." : "Microphone blocked — allow mic access for this site, then click again.")
        : `Microphone unavailable (${name || "error"}).`, true);
      console.error("[voice] getUserMedia failed", e);
      handsFree = false; el("code-mic-chip")?.classList.remove("recording"); return false;
    }
  }
  micError("");                       // clear any prior error
  try { recorder = new MediaRecorder(stream); }
  catch (e) { micError("Recording isn't supported here."); console.error("[voice] MediaRecorder failed", e); stream.getTracks().forEach((t) => t.stop()); stream = null; handsFree = false; return false; }
  chunks = [];
  startedAt = Date.now();
  takeId += 1;
  // DICTATION appends to the draft in the box; VOICE MODE owns the box — the
  // take is the whole text, never stacked on what a send just cleared.
  dictBase = handsFree ? "" : (el<HTMLTextAreaElement>("code-input")?.value ?? "");
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => { stopMeter(); stopPartials(); stream?.getTracks().forEach((t) => t.stop()); stream = null; void transcribe(p.inputModel!); };
  recorder.start(1000);               // one-second slices: the live transcript reads them as they land
  discard = false;
  muted = false;
  paintMute();
  startPartials(p.inputModel);
  el("code-mic-chip")?.classList.add("recording");
  setVoiceState(handsFree ? "free" : "ptt");   // the slot repaints: ✕ ✓ + meter, or mic + Stop
  try { cue("start"); } catch { /* no audio out — the recorder runs regardless */ }
  startMeter(stream);                 // the dotted level meter (+ hands-free silence detect)
  return true;
}

/** Surface a mic problem where the user can see it: the chip tooltip + a brief
 *  error flash. Empty string clears it. */
function micError(msg: string, sticky = false): void {
  const chip = el("code-mic-chip");
  if (!chip) return;
  if (msg) {
    chip.title = msg;
    chip.classList.add("mic-error");
    // A REAL failure STAYS lit (his report: it "flashes then disables" — the
    // 2.6s auto-clear erased the only evidence). It clears on the next
    // successful start, or when the user clicks through to the OS settings.
    if (!sticky) setTimeout(() => chip.classList.remove("mic-error"), 2600);
    // The chip has ONE click handler (chipClick) — it reads this flag rather
    // than us stacking a second listener on the same button.
    osDenied = sticky && /Privacy & Security/.test(msg);
    console.warn("[voice] mic:", msg);
  } else {
    chip.classList.remove("mic-error");
    osDenied = false;
  }
}

function stopRecording(): void {
  if (recorder && recorder.state === "recording") { cue("stop"); recorder.stop(); }
}

async function transcribe(model: string): Promise<void> {
  const chip = el("code-mic-chip");
  chip?.classList.remove("recording");
  // ✕ / Esc: the take is dropped on the floor — no transcription, back to idle.
  if (discard) {
    discard = false;
    recorder = null;
    chunks = [];
    paintTranscript("");               // the partials leave with the take
    setVoiceState("off");
    return;
  }
  chip?.classList.add("transcribing");
  setVoiceState("transcribing");
  let text = "";
  let failed = false;
  try {
    if (partialInflight) await partialInflight;
    text = await transcribeBlob(takeBlob(), model);
  } catch (e) {
    // SAID, NOT SWALLOWED (his report, 2026-10-07): the chip wears the reason
    // until the next good take, instead of a take that quietly lands nothing.
    failed = true;
    micError(transcribeErrorText(e), true);
    console.error("[voice] transcribe failed", e);
  }
  chip?.classList.remove("transcribing");
  recorder = null;
  chunks = [];
  setVoiceState("off");
  if (!handsFree) { if (!failed) paintTranscript(text); el<HTMLTextAreaElement>("code-input")?.focus(); return; }
  // Voice mode: a real utterance submits the turn; silence just re-listens.
  if (text.trim()) {
    const myTake = takeId;
    paintTranscript(text);
    awaitingReply = true;
    resetEarlySpeech();
    cue("submit");
    const fired = submitComposer();    // the Enter path; reply → onTurnComplete
    // The send clears the box; a take still showing after it fired is a
    // leftover, not a draft (his report, 2026-10-07).
    const ta = el<HTMLTextAreaElement>("code-input");
    if (fired && myTake === takeId && ta && ta.value.trim() === text.trim()) { ta.value = ""; ta.dispatchEvent(new Event("input", { bubbles: true })); }
    if (endAfterUtterance) {           // the member ended the session — submit, don't re-listen
      endAfterUtterance = false;
      handsFree = false;
      voiceModeOn = false;
      awaitingReply = false;
      paintVoiceMode();
    }
  } else if (endAfterUtterance) {
    endAfterUtterance = false;         // ended with nothing said — just stop
    handsFree = false;
    voiceModeOn = false;
    paintVoiceMode();
  } else {
    void startRecording();             // heard nothing — keep listening
  }
}

// ── Early first-line speech (hands-free): a long turn says its FIRST line as
// soon as it streams in — "I'm working" — then the rest waits for the end. ──
let earlyLine = "";
let earlyFired = false;
/** Reset per turn — called when a hands-free utterance submits. */
export function resetEarlySpeech(): void { earlyLine = ""; earlyFired = false; }
/** Feed the streaming text; fires AT MOST once per turn, hands-free only. */
export function maybeSpeakFirstLine(sofar: string): void {
  if (earlyFired || !handsFree || !awaitingReply) return;
  const t = sofar.trimStart();
  // A complete first sentence (10–240 chars) or a finished first line.
  const m = /^([\s\S]{10,240}?[.!?])(?:\s|$)/.exec(t) ?? /^(.{10,240})\n/.exec(t);
  const line = (m?.[1] ?? "").trim();
  if (!line) return;
  earlyFired = true;
  earlyLine = line;
  // The remainder waits for this line to finish (onTurnComplete awaits it), so
  // the two never overlap and the line is never cut mid-sentence.
  earlyPlayback = (async () => {
    const p = await voicePref();
    // Read the LIVE mode after the await: voice mode may have ended meanwhile.
    if (voiceModeOn) await playReplyTTS(line, { ...p, autoplay: true });
  })().catch(() => undefined);
}
/** The early line's playback, awaited before the remainder speaks. */
let earlyPlayback: Promise<void> | null = null;
/** The last reply spoken: a second completion of the SAME turn (the web's
 *  stream end and its thread-store reconcile both report one) is ignored. */
let lastSpoken: { text: string; at: number } | null = null;
const SAME_TURN_MS = 15_000;
/** Words only — how the early line and the settled text are compared. */
const spokenKey = (s: string): string => s.replace(/[*_#>`]/g, "").replace(/\s+/g, " ").trim();

/** Called from finishRun when a reply lands: speak it (if autoplay) — minus
 *  the first line when it was already spoken early — then, in a hands-free
 *  session, start listening again for the next thing the user says. */
export async function onTurnComplete(text: string): Promise<void> {
  // ONE SPEAKER (his report, 2026-10-07): the same reply completing twice
  // speaks once; the early line finishes before the remainder; the trim that
  // takes the early line off the settled text compares words, not bytes.
  const key = spokenKey(text || "");
  if (key && lastSpoken && lastSpoken.text === key && Date.now() - lastSpoken.at < SAME_TURN_MS) return;
  if (key) lastSpoken = { text: key, at: Date.now() };
  const p = await voicePref();
  let say = text;
  if (earlyLine) {
    const t = spokenKey(say);
    const e = spokenKey(earlyLine);
    if (e && t.startsWith(e)) say = t.slice(e.length).trim();
  }
  const early = earlyPlayback;
  earlyPlayback = null;
  resetEarlySpeech();
  if (early) await early;
  // Replies are spoken ONLY in voice mode, read live after the awaits above.
  // The stored `autoplay` pref (SDK default true, no longer in Settings) must
  // not make typed / dictated turns, or turns after voice mode ended, talk.
  if (say && voiceModeOn) await playReplyTTS(say, { ...p, autoplay: true });
  if (handsFree && awaitingReply) { awaitingReply = false; void startRecording(); }
}

// ── Chip interaction ──────────────────────────────────────────────────────────
// CLICK TO TOGGLE, in every mode — a click is not a hold, so a hold-only gesture
// just flickered on the browser (record → instant stop, nothing captured). One
// click starts; the next stops. In CONTINUOUS mode it also auto-stops on silence
// (VAD), submits, and re-listens; in push-to-talk it just drops the text in the
// composer for the user to send.
/** Set when macOS itself is blocking the mic: the click opens the OS pane. */
let osDenied = false;

async function chipClick(): Promise<void> {
  if (osDenied) {
    void (window.glyphh as unknown as { micOpenSettings?: () => Promise<unknown> }).micOpenSettings?.();
    return;
  }
  // Already recording → the user is stopping. In a HANDS-FREE session the
  // click means "done talking": what was captured still submits, then the
  // session ends. Killing handsFree here instead routed the transcript down
  // the push-to-talk path — text in the box, turn never fired (his report,
  // 2026-09-08).
  if (recorder && recorder.state === "recording") {
    if (handsFree) endAfterUtterance = true;
    else awaitingReply = false;
    stopRecording();                             // → onstop → transcribe
    return;
  }
  if (recorder) return;                          // mid-transcribe — ignore stray clicks
  handsFree = false;                             // DICTATE: the text lands in the box, the member sends
  void startRecording();
}

// ── The device / mode drop-up (populated on open by code.ts) ───────────────────
async function micDevices(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    let devices = await navigator.mediaDevices.enumerateDevices();
    // Real mics have a non-empty deviceId. Before permission is granted the
    // browser returns ONE blank placeholder (empty id + label) — dropping it
    // avoids the "System default" collision that double-checked the list.
    const mics = (): MediaDeviceInfo[] => devices.filter((d) => d.kind === "audioinput" && d.deviceId);
    // Labels + ids only populate after mic permission — ask once so the list reads.
    if (!mics().length || mics().every((d) => !d.label)) {
      try { const st = await navigator.mediaDevices.getUserMedia({ audio: true }); st.getTracks().forEach((t) => t.stop()); devices = await navigator.mediaDevices.enumerateDevices(); } catch { /* denied */ }
    }
    return mics();
  } catch { return []; }
}

function checkSvg(): string {
  return `<svg class="drop-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
}

// ── The menu's level meter ────────────────────────────────────────────────────
let menuMeter: { stop: () => void } | null = null;
function stopMenuMeter(): void { menuMeter?.stop(); menuMeter = null; }
/** Drive `fill`'s width from the input level while `menu` stays open. The
 *  recorder's analyser is read when it is live; otherwise a stream opens on
 *  `deviceId` (null = system default) and closes when the menu hides, the
 *  menu re-renders (a device switch), or the stream cannot open. */
function startMenuMeter(menu: HTMLElement, fill: HTMLElement | null, deviceId: string | null): void {
  stopMenuMeter();
  if (!fill) return;
  let ownCtx: AudioContext | null = null;
  let ownAnalyser: AnalyserNode | null = null;
  let ownStream: MediaStream | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  const stop = (): void => {
    stopped = true;
    if (timer) { clearInterval(timer); timer = null; }
    ownStream?.getTracks().forEach((t) => t.stop());
    ownStream = null;
    ownAnalyser = null;
    if (ownCtx) { try { void ownCtx.close(); } catch { /* already closed */ } ownCtx = null; }
  };
  const me = { stop };
  menuMeter = me;
  const open = (): boolean => menu.isConnected && !menu.classList.contains("hidden");
  const paint = (): void => {
    if (!open()) { if (menuMeter === me) stopMenuMeter(); else stop(); return; }
    let level = currentLevel();        // the recorder's own stream when it is live
    if (level === null && ownAnalyser) {
      const buf = new Uint8Array(ownAnalyser.fftSize);
      ownAnalyser.getByteTimeDomainData(buf);
      level = levelOf(rmsOf(buf));
    }
    fill.style.width = `${levelBarWidth(level ?? 0)}%`;
  };
  timer = setInterval(paint, 60);
  paint();
  if (analyser || !navigator.mediaDevices?.getUserMedia) return;   // the recorder feeds it, or nothing can
  void (async () => {
    try {
      const st = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
      if (stopped || !open()) { st.getTracks().forEach((t) => t.stop()); return; }
      ownStream = st;
      const Ctor = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      ownCtx = new Ctor();
      ownAnalyser = ownCtx.createAnalyser();
      ownAnalyser.fftSize = 1024;
      ownCtx.createMediaStreamSource(st).connect(ownAnalyser);
    } catch (e) {
      console.warn("[voice] menu level meter:", (e as { name?: string })?.name || e);
    }
  })();
}

/** Build the mic drop-up: a live input level, a device list (checkmark on the
 *  chosen one) + a "Hold to record" toggle that flips push-to-talk ⇄ hands-free.
 *  Rebuilt each open; a device pick re-renders (and restarts the meter on it). */
export async function renderMicMenu(menu: HTMLElement): Promise<void> {
  stopMenuMeter();
  const p = await voicePref();
  menu.textContent = "";
  const head = document.createElement("div");
  head.className = "code-drop-head";
  const label = document.createElement("span");
  label.textContent = "Microphone";
  head.appendChild(label);
  menu.appendChild(head);

  // THE LIVE INPUT LEVEL (his order, 2026-10-07, Claude's mic menu): a mic
  // glyph and a horizontal bar whose fill follows the chosen device's level
  // while the menu is open, so the member knows the mic works before they
  // speak. Runs on the recorder's own analyser when one is live; otherwise
  // opens its own stream on the chosen device (and closes it with the menu).
  const lvl = document.createElement("div");
  lvl.className = "code-mic-level";
  lvl.setAttribute("role", "img");
  lvl.setAttribute("aria-label", "Input level");
  lvl.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="22"/></svg><span class="code-mic-level-track"><span class="code-mic-level-fill"></span></span>`;
  menu.appendChild(lvl);

  const rows = micRows(await micDevices());
  // The chosen device is only valid if it's still present; otherwise fall back to
  // System default so exactly ONE row is ever checked.
  const chosen = micChecked(rows, p.deviceId);
  startMenuMeter(menu, lvl.querySelector<HTMLElement>(".code-mic-level-fill"), chosen || null);
  let marked = false;
  for (const r of rows) {
    const item = document.createElement("button");
    item.className = "code-drop-item";
    item.type = "button";
    const name = document.createElement("span");
    name.textContent = r.name;
    item.appendChild(name);
    if (!marked && r.id === chosen) { marked = true; item.classList.add("selected"); item.insertAdjacentHTML("beforeend", checkSvg()); }
    item.addEventListener("click", () => { void setPref({ deviceId: r.id || null }); void renderMicMenu(menu); });
    menu.appendChild(item);
  }

  // Populate the OS device labels asynchronously if they arrive after first paint.
  void refreshMicChip();
}

/** Wire the voice controls once: the mic dictates, Voice mode converses. */
export function initVoiceMic(): void {
  const chip = el("code-mic-chip");
  if (!chip || chip.dataset.wired) return;
  chip.dataset.wired = "1";
  chip.addEventListener("click", () => void chipClick());
  el("code-voice-mode")?.addEventListener("click", (e) => { e.stopPropagation(); void toggleVoiceMode(); });
  el("code-voice-mute")?.addEventListener("click", (e) => { e.stopPropagation(); toggleMute(); });
  el("code-voice-end")?.addEventListener("click", (e) => { e.stopPropagation(); stopHandsFree(); });
  // Esc cancels a dictation take (his order, 2026-10-07) — captured ahead of
  // every other Escape door so an open drop-up never swallows it.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && vstate === "ptt") { e.stopPropagation(); e.preventDefault(); cancelRecording(); }
  }, true);
  void refreshMicChip();
}
