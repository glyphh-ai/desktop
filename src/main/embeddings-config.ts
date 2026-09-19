/**
 * embeddings-config — embeddings run on the GATEWAY (his order, 2026-09-16:
 * no local model, no vendor key on the machine). The org admin publishes
 * embedding models in the console; a member picks one here and every
 * chunk/embed lane calls the gateway with their own key.
 *
 * No pick (or an org with no embedding models) = the semantic features are
 * off, and callers say so rather than silently degrading.
 */
import { ipcMain } from "electron";
import { getPreference, setPreference } from "./stores/preferences-db.js";
import { getClient } from "./glyphh-client.js";
import { gatewayCreds } from "./gateway-token.js";
import { registerMemoryIpc } from "./memory-bridge.js";

export interface EmbedModel { id: string; name: string; providerSlug: string }

const MODELS_TTL_MS = 60_000;
let cached: { at: number; models: EmbedModel[] } | null = null;

/** The org's embedding models, as the server's catalog reports them. */
export async function orgEmbedModels(force = false): Promise<EmbedModel[]> {
  if (!force && cached && Date.now() - cached.at < MODELS_TTL_MS) return cached.models;
  try {
    const rows = await getClient().http.get<Array<{ id: string; name: string; providerSlug: string; modality?: string; active?: boolean }>>("/api/models/available");
    const models = (Array.isArray(rows) ? rows : [])
      .filter((m) => m && m.modality === "embedding")
      .map((m) => ({ id: m.id, name: m.name || m.id, providerSlug: m.providerSlug || "" }));
    cached = { at: Date.now(), models };
    return models;
  } catch (err) {
    console.warn("[embeddings] model list unavailable:", err instanceof Error ? err.message : String(err));
    return cached?.models ?? [];
  }
}

/** The member's pick, or "" when they have not chosen one. */
export function selectedEmbedModel(): string {
  return String(getPreference<string>("embeddingsModel", "") ?? "");
}

/** The model id the gateway should embed with, stripped of our provider prefix. */
function routeName(id: string): string {
  const cut = id.indexOf("::");
  return cut === -1 ? id : id.slice(cut + 2);
}

/** Embed through the gateway with the member's own key: the org's allow-list,
 *  its rate limits and its spend, like every other model call. */
export async function gatewayEmbed(texts: string[], model: string): Promise<number[][]> {
  const creds = await gatewayCreds();
  if (!creds) throw new Error("embeddings need the gateway — sign in, or ask your admin to enable it");
  const res = await fetch(`${creds.baseUrl.replace(/\/+$/, "")}/v1/embeddings`, {
    method: "POST",
    headers: { authorization: `Bearer ${creds.token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: routeName(model), input: texts }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`the gateway refused the embedding (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const body = await res.json() as { data?: Array<{ embedding?: number[]; index?: number }> };
  const rows = body.data ?? [];
  if (rows.length !== texts.length) throw new Error(`the gateway returned ${rows.length} vectors for ${texts.length} texts`);
  return rows
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((d) => {
      if (!Array.isArray(d.embedding)) throw new Error("the gateway returned no vector");
      return d.embedding;
    });
}

export function registerEmbeddingsIpc(): void {
  registerMemoryIpc();
  ipcMain.handle("embeddings-config-get", async () => {
    const models = await orgEmbedModels();
    return { ok: true, model: selectedEmbedModel(), models };
  });

  ipcMain.handle("embeddings-config-set", (_e, input: { model?: string }) => {
    if (typeof input?.model === "string") setPreference("embeddingsModel", input.model);
    return { ok: true, model: selectedEmbedModel() };
  });
}
