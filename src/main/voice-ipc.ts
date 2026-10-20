/**
 * voice-ipc.ts — DICTATION AND SPOKEN REPLIES on the user's own models. The
 * mic transcribes through the default transcription model, replies are read
 * aloud through the default speech model, both from Settings › Models
 * (providers.ts) and both on the provider's OpenAI audio routes
 * (@glyphh/sdk/router transcribe / synthesize). The member's own voice
 * preferences (mode, voice, Brief) are a local preference.
 *
 * The channel names and shapes are the ones the voice UI was built on
 * (help/voice-mic.ts, voice-out.ts, settings-voice.ts).
 */

import { ipcMain } from "electron";
import { OPENAI_VOICES, resolveModel, synthesize, transcribe } from "@glyphh/sdk/router";
import { defaultModel, readStoredProviders, routerConfig, type ModelType } from "./providers.js";
import { getPreference, setPreference } from "./stores/preferences-db.js";

const PREF = "voiceSettings";

/** What the voice UI reads as the speech setup: the default models and voices. */
export function voiceConfig(): { stt: string | null; tts: string | null; voice: string | null; voices: string[] } {
  const tts = defaultModel("speech") || null;
  const voice = readStoredProviders().defaults.voice ?? null;
  return { stt: defaultModel("transcription") || null, tts, voice: tts ? voice ?? "alloy" : null, voices: tts ? [...OPENAI_VOICES] : [] };
}

/** The member's own voice preferences (mode, picks, Brief). */
export function voiceSettings(): Record<string, unknown> {
  const v = getPreference<Record<string, unknown>>(PREF, {});
  return v && typeof v === "object" ? v : {};
}

/** The provider and model name a voice call runs on: the picked model when it
 *  is one of that type, else the type's default. */
function route(type: ModelType, picked: string | null | undefined) {
  const cfg = routerConfig();
  const ofType = cfg.models.filter((m) => m.type === type);
  const id = (picked && ofType.some((m) => m.id === picked) ? picked : "") || defaultModel(type);
  if (!id) throw new Error(type === "transcription" ? "No transcription model is set up — add one in Settings › Models" : "No speech model is set up — add one in Settings › Models");
  const r = resolveModel(cfg, id);
  if (!r) throw new Error(`No provider serves ${id}`);
  return r;
}

export function registerVoiceIpc(): void {
  ipcMain.handle("voice-config", () => voiceConfig());
  ipcMain.handle("voice-settings-get", () => voiceSettings());
  ipcMain.handle("voice-settings-set", (_e, patch: unknown) => {
    const next = { ...voiceSettings(), ...(patch && typeof patch === "object" ? (patch as Record<string, unknown>) : {}) };
    setPreference(PREF, next);
    return next;
  });
  ipcMain.handle("voice-transcribe", async (_e, audio: ArrayBuffer, mime: string, model: string) => {
    const r = route("transcription", model);
    return { text: await transcribe(r.provider, r.model, new Uint8Array(audio), String(mime || "audio/webm")) };
  });
  ipcMain.handle("voice-synthesize", async (_e, text: string, model: string, voiceId: string | null) => {
    const r = route("speech", model);
    const voice = voiceId || readStoredProviders().defaults.voice || null;
    return Buffer.from(await synthesize(r.provider, r.model, String(text || ""), voice));
  });
  ipcMain.handle("catalog-voices", () => OPENAI_VOICES.map((v) => ({ id: v, name: v, providerSlug: "openai" })));
  ipcMain.handle("catalog-models", () => {
    const names = new Map(readStoredProviders().providers.map((p) => [p.id, p.name]));
    const modality: Record<ModelType, string> = { chat: "chat", transcription: "stt", speech: "tts", embeddings: "embedding", image: "image", video: "video" };
    return routerConfig().models.map((m) => ({ id: m.id, name: m.label || m.model, providerSlug: names.get(m.provider) ?? m.provider, modality: modality[m.type], active: true }));
  });
}
