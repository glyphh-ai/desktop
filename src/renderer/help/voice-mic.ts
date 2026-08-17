/**
 * voice-mic.ts — the composer's voice input. When Settings › Voice enables a
 * transcription model, a mic chip appears by the permission-mode / + controls: click to
 * record, click to stop, and the speech is transcribed (server-side STT) into the
 * composer. Uses the user's chosen input device + model. `continuous` mode auto-restarts
 * after each transcript so the user can just keep talking.
 */

interface VoicePref {
  mode?: "off" | "push-to-talk" | "continuous";
  inputModel?: string | null;
  deviceId?: string | null;
}

const el = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;
const g = (): Record<string, ((...a: unknown[]) => unknown) | undefined> =>
  (window as unknown as { glyphh: Record<string, ((...a: unknown[]) => unknown) | undefined> }).glyphh;

let recorder: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let chunks: Blob[] = [];
let startedAt = 0;

async function voicePref(): Promise<VoicePref> {
  try {
    const res = await g().voiceSettingsGet?.();
    if (res && typeof res === "object") {
      const o = res as Record<string, unknown>;
      // web contract wraps the result; desktop IPC returns it raw.
      return ((o.data && typeof o.data === "object" ? o.data : o) as VoicePref) ?? {};
    }
  } catch { /* no voice settings */ }
  return {};
}

/** Show the mic chip only when a transcription model + non-off mode are set. */
export async function refreshMicChip(): Promise<void> {
  const wrap = el("code-mic-wrap");
  if (!wrap) return;
  const p = await voicePref();
  const on = !!p.inputModel && p.mode !== undefined && p.mode !== "off";
  wrap.classList.toggle("hidden", !on);
}

function insertTranscript(text: string): void {
  const ta = el<HTMLTextAreaElement>("code-input");
  if (!ta || !text) return;
  const sep = ta.value && !/\s$/.test(ta.value) ? " " : "";
  ta.value = ta.value + sep + text;
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.focus();
}

/** The transcribe bridge returns {text} on desktop or an envelope on web — read both. */
function readText(res: unknown): string {
  if (!res || typeof res !== "object") return "";
  const o = res as Record<string, unknown>;
  if (typeof o.text === "string") return o.text;
  const data = o.data as Record<string, unknown> | undefined;
  return typeof data?.text === "string" ? data.text : "";
}

async function finish(model: string, mode: VoicePref["mode"]): Promise<void> {
  const chip = el("code-mic-chip");
  chip?.classList.remove("recording");
  chip?.classList.add("transcribing");
  try {
    const blob = new Blob(chunks, { type: recorder?.mimeType || "audio/webm" });
    const ms = Date.now() - startedAt;
    if (blob.size > 0) {
      const buf = await blob.arrayBuffer();
      insertTranscript(readText(await g().voiceTranscribe?.(buf, blob.type, model, ms)));
    }
  } catch (e) { console.error("[voice] transcribe failed", e); }
  chip?.classList.remove("transcribing");
  recorder = null;
  chunks = [];
  // Continuous: keep listening until the user stops or disables it.
  if (mode === "continuous") { const p = await voicePref(); if (p.mode === "continuous" && p.inputModel) void start(); }
}

async function start(): Promise<void> {
  const p = await voicePref();
  if (!p.inputModel || recorder) return;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: p.deviceId ? { deviceId: { exact: p.deviceId } } : true });
  } catch (e) { console.error("[voice] mic access denied", e); return; }
  recorder = new MediaRecorder(stream);
  chunks = [];
  startedAt = Date.now();
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => { stream?.getTracks().forEach((t) => t.stop()); stream = null; void finish(p.inputModel!, p.mode); };
  recorder.start();
  el("code-mic-chip")?.classList.add("recording");
}

function stop(): void {
  if (recorder && recorder.state === "recording") recorder.stop();
}

/** Wire the mic chip once. Click toggles recording. */
export function initVoiceMic(): void {
  const chip = el("code-mic-chip");
  if (!chip || chip.dataset.wired) return;
  chip.dataset.wired = "1";
  chip.addEventListener("click", () => {
    if (recorder && recorder.state === "recording") stop();
    else void start();
  });
  void refreshMicChip();
}
