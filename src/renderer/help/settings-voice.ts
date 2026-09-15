/**
 * settings-voice.ts — the Voice settings panel. Picks the STT model that transcribes
 * the user's speech (input) and the TTS model + voice that speaks replies (output),
 * persisted to the account via the SDK (profile.voiceSettings). Model lists are filtered
 * by modality (transcription / speech); voices are fetched per output provider.
 */

interface VoiceSettingsView {
  inputModel: string | null;
  outputModel: string | null;
  voiceId: string | null;
  deviceId?: string | null;
  mode: "off" | "push-to-talk" | "continuous";
  autoplay: boolean;
  brief?: boolean;
}
interface CatalogModel { id: string; name: string; providerSlug: string; modality: string; active: boolean }
interface VoiceItem { id: string; name: string; providerSlug: string }

/** The bridge methods the preload exposes (cast locally so we don't depend on the
 *  global window.glyphh type surface). */
interface VoiceBridge {
  catalogModels?: () => Promise<CatalogModel[]>;
  catalogVoices?: (provider: string) => Promise<VoiceItem[]>;
  voiceSettingsGet?: () => Promise<VoiceSettingsView>;
  voiceSettingsSet?: (patch: Partial<VoiceSettingsView>) => Promise<VoiceSettingsView>;
}
import { refreshMicChip } from "./voice-mic.js";

const bridge = (): VoiceBridge => (window as unknown as { glyphh: VoiceBridge }).glyphh;
const $ = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

/** Normalize a bridge response to an array — desktop IPC returns raw arrays, the web
 *  contract wraps results (or returns undefined on error). Never let a shape mismatch
 *  crash the panel. */
function asArray<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v && typeof v === "object") {
    for (const k of ["data", "value", "result", "items"]) {
      const inner = (v as Record<string, unknown>)[k];
      if (Array.isArray(inner)) return inner as T[];
    }
  }
  return [];
}

/** Unwrap a single object from the web `lib()` envelope ({ok, data}) or return it raw. */
function unwrap<T>(v: unknown): T | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if ("ok" in o && "data" in o) return (o.data ?? null) as T | null;
  return v as T;
}

let wired = false;

function setErr(msg: string): void {
  const el = $("voice-settings-error");
  if (el) { el.textContent = msg; el.classList.toggle("hidden", !msg); }
}

function fillModelSelect(id: string, models: CatalogModel[], selected: string): void {
  const el = $<HTMLSelectElement>(id);
  if (!el) return;
  el.innerHTML = `<option value="">None</option>` +
    models.map((m) => `<option value="${m.id}">${m.name} · ${m.providerSlug}</option>`).join("");
  el.value = selected;
}

const providerOf = (modelId: string): string => (modelId.includes("::") ? modelId.slice(0, modelId.indexOf("::")) : "");

/** Populate the microphone picker from the OS device list. Labels only appear after
 *  mic permission is granted, so request it once if they're blank. */
async function fillMicDevices(selected: string): Promise<void> {
  const sel = $<HTMLSelectElement>("voice-device");
  if (!sel || !navigator.mediaDevices?.enumerateDevices) return;
  try {
    let devices = await navigator.mediaDevices.enumerateDevices();
    // Real mics have a non-empty deviceId; the pre-permission placeholder does not.
    const mics = () => devices.filter((d) => d.kind === "audioinput" && d.deviceId);
    if (!mics().length || mics().every((d) => !d.label)) {
      try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((t) => t.stop()); devices = await navigator.mediaDevices.enumerateDevices(); } catch { /* denied */ }
    }
    sel.innerHTML = `<option value="">System default</option>` +
      mics().map((d, i) => `<option value="${d.deviceId}">${d.label || `Microphone ${i + 1}`}</option>`).join("");
    sel.value = selected;
  } catch { /* enumeration unsupported */ }
}

async function refreshVoices(outputModelId: string, selectedVoice: string): Promise<void> {
  const el = $<HTMLSelectElement>("voice-output-voice");
  if (!el) return;
  const provider = providerOf(outputModelId);
  if (!provider) { el.innerHTML = `<option value="">Provider default</option>`; return; }
  try {
    const voices = asArray<VoiceItem>(await bridge().catalogVoices?.(provider));
    el.innerHTML = `<option value="">Provider default</option>` +
      voices.map((v) => `<option value="${v.id}">${v.name}</option>`).join("");
    el.value = selectedVoice;
  } catch { el.innerHTML = `<option value="">Provider default</option>`; }
}

async function save(patch: Partial<VoiceSettingsView>): Promise<void> {
  try {
    await bridge().voiceSettingsSet?.(patch);
    void refreshMicChip(); // show/hide the composer mic chip as the setting changes
    setErr("");
  } catch (e) { setErr((e as Error).message); }
}

function wire(): void {
  $<HTMLSelectElement>("voice-mode")?.addEventListener("change", (e) => void save({ mode: (e.target as HTMLSelectElement).value as VoiceSettingsView["mode"] }));
  $<HTMLInputElement>("voice-autoplay")?.addEventListener("change", (e) => void save({ autoplay: (e.target as HTMLInputElement).checked }));
  $<HTMLInputElement>("voice-brief")?.addEventListener("change", (e) => void save({ brief: (e.target as HTMLInputElement).checked }));
  $<HTMLSelectElement>("voice-input-model")?.addEventListener("change", (e) => void save({ inputModel: (e.target as HTMLSelectElement).value || null }));
  $<HTMLSelectElement>("voice-device")?.addEventListener("change", (e) => void save({ deviceId: (e.target as HTMLSelectElement).value || null }));
  $<HTMLSelectElement>("voice-output-voice")?.addEventListener("change", (e) => void save({ voiceId: (e.target as HTMLSelectElement).value || null }));
  $<HTMLSelectElement>("voice-output-model")?.addEventListener("change", (e) => {
    const v = (e.target as HTMLSelectElement).value || null;
    void (async () => { await save({ outputModel: v, voiceId: null }); await refreshVoices(v ?? "", ""); })();
  });
}

/** Populate the panel — called when the Voice sub-tab is shown. */
export async function loadVoiceSettings(): Promise<void> {
  setErr("");
  try {
    const [modelsRaw, settingsRaw] = await Promise.all([
      Promise.resolve(bridge().catalogModels?.()).catch(() => undefined),
      Promise.resolve(bridge().voiceSettingsGet?.()).catch(() => undefined),
    ]);
    const models = asArray<CatalogModel>(modelsRaw);
    const settings = unwrap<VoiceSettingsView>(settingsRaw);
    const stt = models.filter((m) => m.modality === "transcription" && m.active);
    const tts = models.filter((m) => m.modality === "speech" && m.active);
    fillModelSelect("voice-input-model", stt, settings?.inputModel ?? "");
    fillModelSelect("voice-output-model", tts, settings?.outputModel ?? "");
    const mode = $<HTMLSelectElement>("voice-mode"); if (mode) mode.value = settings?.mode ?? "off";
    const auto = $<HTMLInputElement>("voice-autoplay"); if (auto) auto.checked = settings?.autoplay ?? true;
    const brief = $<HTMLInputElement>("voice-brief"); if (brief) brief.checked = settings?.brief ?? false;
    await fillMicDevices((settings as { deviceId?: string } | null)?.deviceId ?? "");
    await refreshVoices(settings?.outputModel ?? "", settings?.voiceId ?? "");
    if (!wired) { wire(); wired = true; }
  } catch (e) { setErr((e as Error).message); }
}
