/**
 * embeddings-config — the CLIENT-SIDE embeddings upgrade (his order,
 * 2026-09-14): ONNX on-device is the default; a Together AI key + a picked
 * model upgrade every chunk/embed lane. Calls go DIRECT from this machine to
 * Together — never proxied through the glyphh server.
 *
 * The key lives write-only in a 0600 file beside the other user-scoped
 * secrets (the loop API-key pattern); reads hand back only a hint. The
 * chosen model + enablement ride ordinary preferences.
 *
 * A Together-backed model is namespaced "together:<model>" wherever a model
 * string travels (collection metadata pins it per store, so index and query
 * always embed with the same model).
 */

import fs from "fs";
import { ipcMain } from "electron";
import { userScopedPath } from "./app-paths.js";
import { getPreference, setPreference } from "./stores/preferences-db.js";

export const TOGETHER_PREFIX = "together:";
export const TOGETHER_API = "https://api.together.xyz/v1/embeddings";

/** The supported Together embedding models — curated, diverse (quality /
 *  fast / long-context / multilingual). */
export const TOGETHER_EMBED_MODELS = [
  "BAAI/bge-large-en-v1.5",
  "BAAI/bge-base-en-v1.5",
  "togethercomputer/m2-bert-80M-32k-retrieval",
  "intfloat/multilingual-e5-large-instruct",
];

const keyFile = (): string => userScopedPath("together-embeddings.key");

function readKey(): string {
  try { return fs.readFileSync(keyFile(), "utf-8").trim(); } catch { return ""; }
}

function keyHint(key: string): string {
  const k = key.trim();
  return k.length >= 12 ? `${k.slice(0, 6)}...${k.slice(-4)}` : k ? "..." : "";
}

/** The model every embed defaults to: "together:<model>" when the upgrade is
 *  configured (key + pick), else "" — the caller's ONNX default stands. */
export function defaultEmbedModel(): string {
  const model = String(getPreference<string>("embeddingsModel", "") ?? "");
  if (!model || !TOGETHER_EMBED_MODELS.includes(model)) return "";
  return readKey() ? `${TOGETHER_PREFIX}${model}` : "";
}

/** Embed via Together — direct call, the user's own key. */
export async function togetherEmbed(texts: string[], model: string): Promise<number[][]> {
  const key = readKey();
  if (!key) throw new Error("Together AI embeddings need a key — Settings → Embeddings");
  const res = await fetch(TOGETHER_API, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, input: texts }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Together embeddings failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { data?: Array<{ index: number; embedding: number[] }> };
  const rows = (json.data ?? []).slice().sort((a, b) => a.index - b.index);
  if (rows.length !== texts.length) throw new Error("Together embeddings returned the wrong count");
  return rows.map((r) => r.embedding);
}

export function registerEmbeddingsIpc(): void {
  ipcMain.handle("embeddings-config-get", () => {
    const key = readKey();
    return {
      ok: true,
      model: String(getPreference<string>("embeddingsModel", "") ?? ""),
      keySet: !!key,
      keyHint: keyHint(key),
      models: TOGETHER_EMBED_MODELS,
    };
  });
  ipcMain.handle("embeddings-config-set", (_e, input: { model?: string; key?: string; clearKey?: boolean }) => {
    try {
      if (input?.clearKey) { try { fs.rmSync(keyFile(), { force: true }); } catch { /* gone */ } }
      if (typeof input?.key === "string" && input.key.trim()) {
        fs.writeFileSync(keyFile(), input.key.trim(), { encoding: "utf-8", mode: 0o600 });
      }
      if (typeof input?.model === "string") {
        const m = input.model.trim();
        if (m && !TOGETHER_EMBED_MODELS.includes(m)) return { ok: false, error: `unsupported embeddings model: ${m}` };
        setPreference("embeddingsModel", m);
      }
      const key = readKey();
      return { ok: true, keySet: !!key, keyHint: keyHint(key) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
