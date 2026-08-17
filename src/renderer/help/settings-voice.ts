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
  mode: "off" | "push-to-talk" | "continuous";
  autoplay: boolean;
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
const bridge = (): VoiceBridge => (window as unknown as { glyphh: VoiceBridge }).glyphh;
const $ = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

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

async function refreshVoices(outputModelId: string, selectedVoice: string): Promise<void> {
  const el = $<HTMLSelectElement>("voice-output-voice");
  if (!el) return;
  const provider = providerOf(outputModelId);
  if (!provider) { el.innerHTML = `<option value="">Provider default</option>`; return; }
  try {
    const voices = (await bridge().catalogVoices?.(provider)) ?? [];
    el.innerHTML = `<option value="">Provider default</option>` +
      voices.map((v) => `<option value="${v.id}">${v.name}</option>`).join("");
    el.value = selectedVoice;
  } catch { el.innerHTML = `<option value="">Provider default</option>`; }
}

async function save(patch: Partial<VoiceSettingsView>): Promise<void> {
  try { await bridge().voiceSettingsSet?.(patch); setErr(""); }
  catch (e) { setErr((e as Error).message); }
}

function wire(): void {
  $<HTMLSelectElement>("voice-mode")?.addEventListener("change", (e) => void save({ mode: (e.target as HTMLSelectElement).value as VoiceSettingsView["mode"] }));
  $<HTMLInputElement>("voice-autoplay")?.addEventListener("change", (e) => void save({ autoplay: (e.target as HTMLInputElement).checked }));
  $<HTMLSelectElement>("voice-input-model")?.addEventListener("change", (e) => void save({ inputModel: (e.target as HTMLSelectElement).value || null }));
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
    const [models, settings] = await Promise.all([
      bridge().catalogModels?.() ?? Promise.resolve<CatalogModel[]>([]),
      bridge().voiceSettingsGet?.() ?? Promise.resolve<VoiceSettingsView | null>(null),
    ]);
    const stt = models.filter((m) => m.modality === "transcription" && m.active);
    const tts = models.filter((m) => m.modality === "speech" && m.active);
    fillModelSelect("voice-input-model", stt, settings?.inputModel ?? "");
    fillModelSelect("voice-output-model", tts, settings?.outputModel ?? "");
    const mode = $<HTMLSelectElement>("voice-mode"); if (mode) mode.value = settings?.mode ?? "off";
    const auto = $<HTMLInputElement>("voice-autoplay"); if (auto) auto.checked = settings?.autoplay ?? true;
    await refreshVoices(settings?.outputModel ?? "", settings?.voiceId ?? "");
    if (!wired) { wire(); wired = true; }
  } catch (e) { setErr((e as Error).message); }
}
