/**
 * loop-models.ts — WHAT THE AGENT CAN RUN ON: the user's chat models
 * (Settings › Models, providers.ts), as the picker's rows.
 *
 * Asked once and cached briefly: every panel offers the same list.
 */

import { ipcMain } from "electron";
import { hasChatModel, readStoredProviders, routerConfig } from "./providers";

export interface LoopModel {
  id: string;
  name: string;
  providerSlug: string;
  /** The model takes an effort (the composer's dial); absent on an older server = yes. */
  reasoning?: boolean;
  /** On the Free plan's list (the server's flag; nothing in the app shows it). */
  freePlan?: boolean;
  /** THE UTILITY-MODEL RULE reads these (renderer help/utility-model.ts, his
   *  order 2026-10-05: side requests ride the console's flagged Utility model,
   *  else the cheapest chat row by price — never the session's model). */
  modality?: string;
  utility?: boolean;
  inputUsdPerMTok?: number;
  outputUsdPerMTok?: number;
}
export interface LoopModelsResult {
  ok: boolean;
  source: "gateway" | "none";
  baseUrl: string | null;
  models: LoopModel[];
  error?: string;
}

const TTL_MS = 60_000;
let cached: { at: number; value: LoopModelsResult } | null = null;

type FetchListener = (value: LoopModelsResult, forced: boolean) => void;
const fetchListeners = new Set<FetchListener>();

/** Told after every read that went to the server (not a cache hit), and
 *  whether a surface forced it — model-watch.ts compares and announces. */
export function onLoopModelsFetched(cb: FetchListener): () => void {
  fetchListeners.add(cb);
  return () => { fetchListeners.delete(cb); };
}

export async function listLoopModels(force = false): Promise<LoopModelsResult> {
  if (!force && cached && Date.now() - cached.at < TTL_MS) return cached.value;
  // THE USER'S OWN CHAT MODELS (Settings › Models), each under its provider,
  // when that provider can be called (a key, or a keyless compatible server).
  const cfg = routerConfig();
  const callable = new Set(cfg.providers.filter((p) => p.kind === "openai-compatible" || !!p.apiKey).map((p) => p.id));
  const names = new Map(readStoredProviders().providers.map((p) => [p.id, p.name]));
  const models = cfg.models
    .filter((m) => m.type === "chat" && callable.has(m.provider))
    .map((m): LoopModel => ({ id: m.id, name: m.label || m.model, providerSlug: names.get(m.provider) ?? m.provider, reasoning: true, modality: "chat" }));
  const value: LoopModelsResult = { ok: true, source: hasChatModel() ? "gateway" : "none", baseUrl: null, models };
  cached = { at: Date.now(), value };
  for (const cb of fetchListeners) {
    try { cb(value, force); } catch (err) { console.warn("[models] fetch listener failed:", err instanceof Error ? err.message : err); }
  }
  return value;
}

export function registerLoopModelsIpc(): void {
  // The channel keeps its name: the preload contract is not pruned for a
  // rename (preload-contract law). The loop id it used to take is ignored —
  // there is one loop now, and one list.
  ipcMain.handle("loop-models", (_e, _loopId?: string, force?: boolean) => listLoopModels(!!force));
}
