/**
 * Transcriber — ON-DEVICE speech-to-text (Whisper via transformers.js/ONNX).
 *
 * Replaces the BYOK path (OpenAI Whisper API with the user's key) — Glyphh
 * holds no provider keys. The model (Xenova/whisper-base.en) downloads once
 * to ~/yo/models on first use, the same cache the app-platform embedder
 * uses; after that transcription is fully local and offline.
 *
 * Accepts raw 16kHz mono Float32Array audio from the renderer — exactly the
 * input shape transformers.js's ASR pipeline consumes, so no WAV encoding.
 */

import os from "os";
import path from "path";

// @huggingface/transformers is ESM-only; this file compiles to CommonJS.
const dynamicImport = new Function("specifier", "return import(specifier)") as
  (specifier: string) => Promise<any>;

const ASR_MODEL = "Xenova/whisper-base.en";

let asrPromise: Promise<any> | null = null;

function getAsr(): Promise<any> {
  if (!asrPromise) {
    asrPromise = (async () => {
      const tf = await dynamicImport("@huggingface/transformers");
      tf.env.cacheDir = path.join(os.homedir(), "yo", "models");
      return tf.pipeline("automatic-speech-recognition", ASR_MODEL);
    })();
    asrPromise.catch(() => { asrPromise = null; }); // failed load shouldn't poison retries
  }
  return asrPromise;
}

export class Transcriber {
  async transcribe(audio: Float32Array): Promise<string> {
    if (!audio || audio.length === 0) return "";
    const asr = await getAsr();
    const out = await asr(audio, { chunk_length_s: 30, stride_length_s: 5 });
    return String(out?.text ?? "").trim();
  }
}
