/**
 * embeddings-config — WHAT MEMORY AND SEARCH EMBED WITH: the user's own
 * embeddings model, from Settings › Models (providers.ts), called through the
 * router's `/embeddings` wire with that provider's key.
 *
 * The model is the default embeddings model (or, with none picked, the first
 * one added). With no embeddings model at all there is nothing to embed with,
 * so memory is off: capture and recall skip quietly and Settings › Memory says
 * to add one. There is no built-in fallback embedder.
 *
 * A collection pinned to a model that is no longer offered (the old local
 * hashed-words model, a gateway model, a model since removed) is embedded
 * again with the current one by glyphh-app-ai's repin, on first use.
 */
import { ipcMain } from "electron";
import { embed, resolveModel } from "@glyphh/sdk/router";
import { defaultModel, modelsOfType, readStoredProviders, routerConfig, setDefault } from "./providers.js";
import { MEMORY_NEEDS_MODEL, registerMemoryIpc } from "./memory.js";

export interface EmbedModel { id: string; name: string; providerSlug: string }

/** The embeddings models on offer: the user's embeddings-type models. */
export async function embedModels(): Promise<EmbedModel[]> {
  const names = new Map(readStoredProviders().providers.map((p) => [p.id, p.name]));
  return modelsOfType("embeddings").map((m) => ({ id: m.id, name: m.label || m.model, providerSlug: names.get(m.provider) ?? m.provider }));
}

/** The model embeds run on: the default embeddings model, or "" with none. */
export function selectedEmbedModel(): string {
  return defaultModel("embeddings");
}

export async function resolveEmbedModel(): Promise<string> {
  return selectedEmbedModel();
}

/** Whether an offered model is this one: by its id, or by its bare name. */
export function offers(models: EmbedModel[], model: string): boolean {
  return models.some((m) => m.id === model || routeName(m.id) === model);
}

/** A model id without its provider prefix. */
export function routeName(id: string): string {
  const cut = id.indexOf("::");
  return cut === -1 ? id : id.slice(cut + 2);
}

/** Embed texts with a model (a collection's pin), through its provider. */
export async function embedWith(texts: string[], model: string): Promise<number[][]> {
  if (!model) throw new Error(MEMORY_NEEDS_MODEL);
  const route = resolveModel(routerConfig(), model);
  if (!route) throw new Error(`No provider serves the embeddings model "${model}" — add it in Settings › Models`);
  return embed(route.provider, route.model, texts);
}

export function registerEmbeddingsIpc(): void {
  registerMemoryIpc();
  ipcMain.handle("embeddings-config-get", async () => ({ ok: true, model: selectedEmbedModel(), models: await embedModels() }));
  ipcMain.handle("embeddings-config-set", async (_e, input: { model?: string } = {}) => {
    const model = String(input?.model ?? "");
    if (!(await embedModels()).some((m) => m.id === model)) return { ok: false, error: `${model || "That"} is not one of your embeddings models` };
    setDefault("embeddings", model);
    return { ok: true, model: selectedEmbedModel() };
  });
}
