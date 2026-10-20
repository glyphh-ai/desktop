/**
 * models.ts — WHICH MODEL A TURN RUNS ON. The list is the desktop's own: the
 * user's chat models in Settings › Models (src/main/providers.ts), each on a
 * provider that can be called. A pick that is not in the list (a model name
 * from the old gateway days, still in config.json) never reaches a turn — the
 * default runs instead.
 */

import { defaultModel, readStoredProviders, routerConfig } from "../../src/main/providers.js";

export interface ModelChoice {
  /** The model's id (`<provider>::<model>`) — what a turn sends. */
  id: string;
  /** What the picker shows beside it. */
  detail: string;
}

/** The default chat model's id, or "" with none set up. */
export function defaultModelId(): string {
  return defaultModel("chat");
}

/** The models the picker offers, in the order they were added. */
export function availableModels(): ModelChoice[] {
  const cfg = routerConfig();
  const callable = new Set(cfg.providers.filter((p) => p.kind === "openai-compatible" || !!p.apiKey).map((p) => p.id));
  const names = new Map(readStoredProviders().providers.map((p) => [p.id, p.name]));
  const fallback = defaultModelId();
  return cfg.models
    .filter((m) => m.type === "chat" && callable.has(m.provider))
    .map((m) => ({ id: m.id, detail: `${names.get(m.provider) ?? m.provider}${m.id === fallback ? " · the default" : ""}` }));
}

/** Is this a model the list holds? */
export function isKnownModel(id: string | null | undefined): id is string {
  return !!id && availableModels().some((m) => m.id === id);
}

/** The model a turn runs on: the first known pick, else the default. */
export function resolveModel(...picks: Array<string | null | undefined>): string {
  return picks.find(isKnownModel) ?? defaultModelId();
}
