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
// Live meter: one AudioContext + analyser drives BOTH the waveform overlay and
// (hands-free only) the silence detector.
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let waveRaf = 0;
let vadTimer: ReturnType<typeof setInterval> | null = null;

// Speech-mode steering, prepended to the model prompt when "brief" is on. It
// shapes BOTH the spoken reply and what's rendered, since it steers the turn
// itself (not just playback). Cached so the synchronous send() can read it.
export const SPEECH_STEER =
  "[Speech mode is on: the user is talking to you by voice and hearing your reply read aloud. " +
  "Answer in at most one to three short, conversational sentences. Lead with the answer. " +
  "Do not use lists, tables, headings, or code blocks unless explicitly asked. Keep it tight.]";
let cachedBrief = false;
/** The steer to prepend to a turn's prompt, or "" when speech mode is off. */
export function briefSteer(): string { return cachedBrief ? SPEECH_STEER : ""; }

async function voicePref(): Promise<VoicePref> {
  try {
    const res = await g().voiceSettingsGet?.();
    if (res && typeof res === "object") {
      const o = res as Record<string, unknown>;
      // web contract wraps the result ({ok,data}); desktop IPC returns it raw.
      const pref = ((o.data && typeof o.data === "object" ? o.data : o) as VoicePref) ?? {};
      cachedBrief = !!pref.brief;   // keep the sync steer cache warm
      return pref;
    }
  } catch { /* no voice settings */ }
  return {};
}

async function setPref(patch: Partial<VoicePref>): Promise<void> {
  try { await g().voiceSettingsSet?.(patch); } catch { /* offline — keep going */ }
}

/** Show the mic chip only when a transcription model + non-off mode are set,
 *  and keep its tooltip honest about the current mode. */
export async function refreshMicChip(): Promise<void> {
  const wrap = el("code-mic-wrap");
  if (!wrap) return;
  const p = await voicePref();
  const on = !!p.inputModel && p.mode !== undefined && p.mode !== "off";
  wrap.classList.toggle("hidden", !on);
  const chip = el("code-mic-chip");
  if (chip) chip.title = p.mode === "continuous"
    ? "Hands-free — click to start talking, click to stop"
    : "Click to record, click again to stop — the text drops into the composer";
}

function insertTranscript(text: string): void {
  const ta = el<HTMLTextAreaElement>("code-input");
  if (!ta || !text) return;
  const sep = ta.value && !/\s$/.test(ta.value) ? " " : "";
  ta.value = ta.value + sep + text;
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.focus();
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
    drawWave();                 // the transparent recording indicator over the input
    if (handsFree) startVadLoop();
  } catch { /* metering unsupported — recording itself still works */ }
}

function stopMeter(): void {
  if (waveRaf) { cancelAnimationFrame(waveRaf); waveRaf = 0; }
  if (vadTimer) { clearInterval(vadTimer); vadTimer = null; }
  const canvas = el("code-rec-wave");
  canvas?.classList.add("hidden");
  canvas?.parentElement?.classList.remove("code-recording");
  analyser = null;
  if (audioCtx) { try { void audioCtx.close(); } catch { /* already closed */ } audioCtx = null; }
}

/** Paint the mic's live frequency bars onto the transparent overlay canvas. */
function drawWave(): void {
  const canvas = el<HTMLCanvasElement>("code-rec-wave");
  if (!canvas || !analyser) return;
  canvas.classList.remove("hidden");
  canvas.parentElement?.classList.add("code-recording");   // hides the placeholder
  const ctx2d = canvas.getContext("2d");
  if (!ctx2d) return;
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#af5fff";
  const BARS = 32;
  const freq = new Uint8Array(analyser.frequencyBinCount);
  const step = Math.max(1, Math.floor(freq.length / BARS));
  const tick = (): void => {
    if (!analyser || !ctx2d) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w === 0 || h === 0) { waveRaf = requestAnimationFrame(tick); return; }
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    analyser.getByteFrequencyData(freq);
    ctx2d.clearRect(0, 0, w, h);
    const gap = 3;
    const barW = Math.max(2, (w - (BARS - 1) * gap) / BARS);
    for (let i = 0; i < BARS; i++) {
      let sum = 0;
      for (let j = 0; j < step; j++) sum += freq[i * step + j];
      const v = sum / step / 255;                 // 0..1 loudness for this band
      const bh = Math.max(2, v * h);
      const x = i * (barW + gap);
      ctx2d.fillStyle = accent;
      ctx2d.globalAlpha = 0.25 + v * 0.6;
      ctx2d.fillRect(x, (h - bh) / 2, barW, bh);
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
  const SPEAK = 0.025, SILENCE_MS = 1300, MAX_MS = 30000;
  vadTimer = setInterval(() => {
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
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => { stopMeter(); stream?.getTracks().forEach((t) => t.stop()); stream = null; void transcribe(p.inputModel!); };
  recorder.start();
  el("code-mic-chip")?.classList.add("recording");
  cue("start");
  startMeter(stream);                 // waveform overlay (+ hands-free silence detect)
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
  chip?.classList.add("transcribing");
  let text = "";
  try {
    const blob = new Blob(chunks, { type: recorder?.mimeType || "audio/webm" });
    const ms = Date.now() - startedAt;
    if (blob.size > 0) text = readText(await g().voiceTranscribe?.(await blob.arrayBuffer(), blob.type, model, ms));
  } catch (e) { console.error("[voice] transcribe failed", e); }
  chip?.classList.remove("transcribing");
  recorder = null;
  chunks = [];
  if (!handsFree) { insertTranscript(text); return; }
  // Hands-free: a real utterance submits the turn; silence just re-listens.
  if (text.trim()) {
    insertTranscript(text);
    awaitingReply = true;
    resetEarlySpeech();
    cue("submit");
    el("code-send")?.click();          // fire the turn; reply → onTurnComplete
  } else if (handsFree) {
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
  void (async () => {
    const p = await voicePref();
    if (p.outputModel && p.autoplay) await playReplyTTS(line, p);
  })();
}

/** Called from finishRun when a reply lands: speak it (if autoplay) — minus
 *  the first line when it was already spoken early — then, in a hands-free
 *  session, start listening again for the next thing the user says. */
export async function onTurnComplete(text: string): Promise<void> {
  const p = await voicePref();
  let say = text;
  if (earlyLine) {
    const t = say.trimStart();
    if (t.startsWith(earlyLine)) say = t.slice(earlyLine.length).trimStart();
  }
  resetEarlySpeech();
  if (say) await playReplyTTS(say, p);
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
  // Already recording → the user is stopping.
  if (recorder && recorder.state === "recording") {
    handsFree = false; awaitingReply = false;
    stopRecording();                             // → onstop → transcribe
    return;
  }
  if (recorder) return;                          // mid-transcribe — ignore stray clicks
  const p = await voicePref();
  handsFree = p.mode === "continuous";           // continuous = auto-submit + re-listen
  void startRecording();
}

// (The composer's device/mode drop-up is GONE — Settings › Voice owns the
// config. The chip is just the mic.)

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

/** Build the mic drop-up: a device list (checkmark on the chosen one) + a
 *  "Hold to record" toggle that flips push-to-talk ⇄ hands-free. Rebuilt each open. */
export async function renderMicMenu(menu: HTMLElement): Promise<void> {
  const p = await voicePref();
  menu.textContent = "";
  const head = document.createElement("div");
  head.className = "code-drop-head";
  const label = document.createElement("span");
  label.textContent = "Microphone";
  head.appendChild(label);
  menu.appendChild(head);

  const devices = await micDevices();
  const rows: Array<{ id: string; name: string }> = [{ id: "", name: "System default" }, ...devices.map((d, i) => ({ id: d.deviceId, name: d.label || `Microphone ${i + 1}` }))];
  // The chosen device is only valid if it's still present; otherwise fall back to
  // System default so exactly ONE row is ever checked.
  const chosen = devices.some((d) => d.deviceId === p.deviceId) ? p.deviceId : "";
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

  // "Hold to record" toggle — ON = push-to-talk (hold), OFF = hands-free.
  const sep = document.createElement("div");
  sep.className = "code-drop-sep";
  menu.appendChild(sep);
  const toggleRow = document.createElement("button");
  toggleRow.className = "code-drop-item code-drop-toggle";
  toggleRow.type = "button";
  const tlabel = document.createElement("span");
  tlabel.textContent = "Hold to record";
  const sw = document.createElement("span");
  const holdOn = p.mode !== "continuous";
  sw.className = "code-drop-switch" + (holdOn ? " on" : "");
  toggleRow.append(tlabel, sw);
  toggleRow.addEventListener("click", () => {
    const nowHold = !sw.classList.contains("on");
    sw.classList.toggle("on", nowHold);
    void setPref({ mode: nowHold ? "push-to-talk" : "continuous" }).then(refreshMicChip);
  });
  menu.appendChild(toggleRow);

  // Populate the OS device labels asynchronously if they arrive after first paint.
  void refreshMicChip();
}

/** Wire the mic chip once. Down/up drive hold-to-talk; click drives hands-free. */
export function initVoiceMic(): void {
  const chip = el("code-mic-chip");
  if (!chip || chip.dataset.wired) return;
  chip.dataset.wired = "1";
  chip.addEventListener("click", () => void chipClick());
  void refreshMicChip();
}
