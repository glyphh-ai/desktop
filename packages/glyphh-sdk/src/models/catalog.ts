/**
 * models/catalog.ts — the installable local models (open-weight GGUFs served by llama-server)
 * and the hardware→model sizing. Qwen2.5 (Apache-2.0) is the default family: strong, small,
 * good at instruction + code. `recommendModel` picks the largest that fits the machine's RAM.
 */

import type { Hardware } from "./hardware.js";

export interface LocalModelSpec {
  /** Catalog id (matches an open_weight catalog Model, minus provider prefix). */
  id: string;
  name: string;
  paramsB: number;
  /** Minimum system RAM (GB) to run it at Q4 comfortably. */
  minRamGB: number;
  contextWindow: number;
  /** Direct GGUF (Q4_K_M) download URL. */
  ggufUrl: string;
  /** On-disk filename under $GLYPHH_HOME/models. */
  fileName: string;
}

/** Ordered small → large. */
export const LOCAL_MODELS: readonly LocalModelSpec[] = [
  {
    id: "qwen2.5-1.5b",
    name: "Qwen2.5 1.5B",
    paramsB: 1.5,
    minRamGB: 3,
    contextWindow: 32768,
    ggufUrl: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf",
    fileName: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
  },
  {
    id: "qwen2.5-3b",
    name: "Qwen2.5 3B",
    paramsB: 3,
    minRamGB: 6,
    contextWindow: 32768,
    ggufUrl: "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf",
    fileName: "qwen2.5-3b-instruct-q4_k_m.gguf",
  },
  {
    id: "qwen2.5-7b",
    name: "Qwen2.5 7B",
    paramsB: 7,
    minRamGB: 10,
    contextWindow: 32768,
    ggufUrl: "https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q4_k_m.gguf",
    fileName: "qwen2.5-7b-instruct-q4_k_m.gguf",
  },
  {
    id: "qwen2.5-14b",
    name: "Qwen2.5 14B",
    paramsB: 14,
    minRamGB: 20,
    contextWindow: 32768,
    ggufUrl: "https://huggingface.co/Qwen/Qwen2.5-14B-Instruct-GGUF/resolve/main/qwen2.5-14b-instruct-q4_k_m.gguf",
    fileName: "qwen2.5-14b-instruct-q4_k_m.gguf",
  },
] as const;

export function findLocalModel(id: string): LocalModelSpec | undefined {
  return LOCAL_MODELS.find((m) => m.id === id);
}

/**
 * Pick the largest model that fits — leaving RAM headroom for the OS + the runtime. Apple
 * Silicon gets a smaller headroom (unified memory, efficient Metal). Never returns nothing:
 * a weak box still gets the 1.5B.
 */
export function recommendModel(hw: Hardware): LocalModelSpec {
  // Leave ~2 GB for the OS + the runtime. (appleSilicon is kept for future VRAM-aware
  // sizing; unified memory already makes bigger models viable at the same RAM.)
  const usable = Math.max(2, hw.totalRamGB - 2);
  const fits = LOCAL_MODELS.filter((m) => m.minRamGB <= usable);
  return fits.length ? fits[fits.length - 1]! : LOCAL_MODELS[0]!;
}
