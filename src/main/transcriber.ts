/**
 * Transcriber — speech-to-text via OpenAI Whisper using the user's BYOK key.
 *
 * Phase 6 of THE-PIVOT-BYOK. Was a thin wrapper over yo-server's
 * /api/llm/transcribe proxy; now calls api.openai.com/v1/audio/transcriptions
 * directly with the user's locally-stored OpenAI key.
 *
 * Accepts raw 16kHz mono Float32Array audio from the renderer, encodes
 * to WAV, and POSTs as multipart/form-data.
 */

import * as providerKeys from "./provider-keys";

/** Thrown when the user hasn't saved a key for this provider. (Lived in
 *  provider-adapters/agent-adapter.ts until the BYOK inference client was
 *  deleted — transcription was its last consumer.) */
export class ProviderNotConfiguredError extends Error {
  constructor(public provider: string) {
    super(`provider "${provider}" not configured — add an API key`);
    this.name = "ProviderNotConfiguredError";
  }
}

export class Transcriber {
  async transcribe(audio: Float32Array): Promise<string> {
    const apiKey = await providerKeys.getKey("openai");
    if (!apiKey) throw new ProviderNotConfiguredError("openai");

    const wav = encodeWav(audio, 16000);
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
    form.append("model", "whisper-1");

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Whisper ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = await res.json() as { text?: string };
    return (data.text ?? "").trim();
  }
}

/** Encode Float32 PCM samples to a 16-bit WAV buffer. */
function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const numSamples = samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  writeString(view, 8, "WAVE");

  // fmt chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);           // chunk size
  view.setUint16(20, 1, true);            // PCM
  view.setUint16(22, 1, true);            // mono
  view.setUint32(24, sampleRate, true);    // sample rate
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);            // block align
  view.setUint16(34, 16, true);           // bits per sample

  // data chunk
  writeString(view, 36, "data");
  view.setUint32(40, numSamples * 2, true);

  // Convert float32 [-1,1] to int16
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    offset += 2;
  }

  return buffer;
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
