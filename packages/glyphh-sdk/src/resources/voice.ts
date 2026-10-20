/**
 * resources/voice.ts — the voice runtime: transcribe (STT) and synthesize (TTS). Keys
 * live server-side; this just carries audio in/out with the session bearer attached.
 */

import type { AuthedHttp } from "../core/authed-http.js";

export class VoiceClient {
  constructor(private readonly http: AuthedHttp) {}

  /** Transcribe audio bytes to text. `contentType` is the recording MIME
   *  (audio/webm, audio/mp4…); `ms` is the recorded length, for per-minute metering. */
  transcribe(audio: Uint8Array, model: string, contentType: string, ms?: number): Promise<{ text: string }> {
    const q = `model=${encodeURIComponent(model)}${ms ? `&ms=${Math.round(ms)}` : ""}`;
    return this.http.postBinary<{ text: string }>(`/api/voice/transcribe?${q}`, audio, contentType);
  }

  /** Synthesize speech from text; returns audio bytes (mp3). */
  synthesize(text: string, model: string, voiceId?: string | null): Promise<ArrayBuffer> {
    return this.http.postForBytes("/api/voice/synthesize", { text, model, voiceId: voiceId ?? null });
  }
}
