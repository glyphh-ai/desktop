/**
 * models-ipc.ts — SETTINGS › MODELS: the user's providers, keys and models,
 * edited from the page (help/settings-models.ts) and stored by providers.ts.
 * Every answer is an `{ ok, data | error }` envelope; a key never crosses to
 * the renderer (the view masks it). After a change the model picker and every
 * other surface are told (model-watch.ts), so a new model is pickable at once.
 */

import { ipcMain } from "electron";
import { PROVIDER_KINDS, MODEL_TYPES, OPENAI_VOICES, guessModelType, listProviderModels, type ModelType, type ProviderKind } from "@glyphh/sdk/router";
import {
  KIND_NAME, effectiveKey, providersView, readStoredProviders, removeModel, removeProvider, saveModel, saveProvider, setDefault,
} from "./providers.js";
import { refreshModelState } from "./model-watch.js";

type Env<T> = { ok: true; data: T } | { ok: false; error: string };

async function run<T>(work: () => T | Promise<T>, changed = false): Promise<Env<T>> {
  try {
    const data = await work();
    if (changed) void refreshModelState().catch(() => undefined);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Everything the page paints: the providers (keys masked), models, defaults,
 *  and the choices its selects offer. */
export function modelsPage() {
  return {
    ...providersView(),
    kinds: PROVIDER_KINDS.map((k) => ({ kind: k, name: KIND_NAME[k] })),
    types: [...MODEL_TYPES],
    voices: [...OPENAI_VOICES],
  };
}

export function registerModelsIpc(): void {
  ipcMain.handle("models-page", () => run(() => modelsPage()));
  ipcMain.handle("models-provider-save", (_e, input: { id?: string; kind: ProviderKind; name?: string; baseUrl?: string; apiKey?: string; clearKey?: boolean }) =>
    run(() => { saveProvider(input); return modelsPage(); }, true));
  ipcMain.handle("models-provider-remove", (_e, id: string) => run(() => { removeProvider(String(id)); return modelsPage(); }, true));
  // FETCH MODELS: the provider's own list, each name with a guessed type and
  // whether it is already added, for the page's add-from-list picker.
  ipcMain.handle("models-provider-list", (_e, id: string) => run(async () => {
    const p = readStoredProviders().providers.find((x) => x.id === id);
    if (!p) throw new Error(`no provider ${id}`);
    const key = effectiveKey(p);
    const names = await listProviderModels(key ? { ...p, apiKey: key } : p);
    const have = new Set(readStoredProviders().models.filter((m) => m.provider === id).map((m) => m.model));
    return names.map((model) => ({ model, type: guessModelType(model), added: have.has(model) }));
  }));
  ipcMain.handle("models-model-save", (_e, input: { provider: string; model: string; type: ModelType; label?: string }) =>
    run(() => { saveModel(input); return modelsPage(); }, true));
  ipcMain.handle("models-model-remove", (_e, id: string) => run(() => { removeModel(String(id)); return modelsPage(); }, true));
  ipcMain.handle("models-default-set", (_e, key: ModelType | "voice", value: string) =>
    run(() => { setDefault(key, String(value || "")); return modelsPage(); }, true));
}
