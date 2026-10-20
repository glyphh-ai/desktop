/**
 * A collection pinned to an embeddings model the user no longer has (the old
 * local hashed-words model, a model removed in Settings › Models) is embedded
 * again with the user's embeddings model on first use (his report, 2026-10-03:
 * memory and search refused for a model that had been removed).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const home = mkdtempSync(join(tmpdir(), "glyphh-vectors-"));

let published: Array<{ id: string; name: string; providerSlug: string }> = [{ id: "openai::text-embedding-3-large", name: "text-embedding-3-large", providerSlug: "openai" }];
let pick = "openai::text-embedding-3-large";
const embedded: Array<{ model: string; texts: string[] }> = [];

/** Each model has its own dimension, so a vector from the old model can never pass as one from the new. */
const DIM: Record<string, number> = { "openai::text-embedding-3-large": 4, "nomic::nomic-embed-text-v1.5": 3 };

vi.mock("electron", () => ({ ipcMain: { handle: () => undefined }, app: { getPath: () => home } }));
vi.mock("better-sqlite3", () => {
  const sqlite = (process as unknown as { getBuiltinModule: (id: string) => { DatabaseSync: new (p: string) => Record<string, unknown> } }).getBuiltinModule("node:sqlite");
  return {
    default: function Database(path: string) {
      const db = new sqlite.DatabaseSync(path) as Record<string, unknown> & { exec: (sql: string) => void };
      db.pragma = () => undefined;
      db.transaction = (fn: () => void) => () => { db.exec("BEGIN"); try { fn(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } };
      db.open = true;
      return db;
    },
  };
});
vi.mock("../../src/main/glyphh-app-services.js", () => ({ appDataDir: (slug: string) => join(home, slug) }));
vi.mock("../../src/main/app-paths.js", () => ({ glyphhPath: (...p: string[]) => join(home, ...p) }));
vi.mock("../../src/main/embeddings-config.js", () => ({
  embedModels: async () => published,
  offers: (models: Array<{ id: string }>, model: string) => models.some((m) => m.id === model || m.id.split("::").pop() === model),
  resolveEmbedModel: async () => (!published.length ? "" : published.some((m) => m.id === pick) ? pick : (pick = published[0].id)),
  embedWith: async (texts: string[], model: string) => {
    embedded.push({ model, texts });
    const dim = DIM[model];
    if (!dim) throw new Error(`No provider serves the embeddings model "${model}"`);
    return texts.map((t) => Array.from({ length: dim }, (_, i) => (t.length + i) % 7 + 1));
  },
}));

const ai = await import("../../src/main/glyphh-app-ai.js");

describe("a collection follows the user's embeddings model when its own is gone", () => {
  beforeEach(() => { embedded.length = 0; });

  it("re-embeds every stored text with the new model, drops bare vectors, and answers searches again", async () => {
    await ai.vectorUpsert("memo", { collection: "turns", items: [
      { id: "a", text: "deploy the service with a canary" },
      { id: "b", text: "the budget is in dollars" },
      { id: "v", vector: [1, 0, 0, 0], metadata: { kind: "bare" } },
    ] });
    expect(ai.listCollections("memo")).toEqual([{ name: "turns", model: "openai::text-embedding-3-large", dim: 4, items: 3 }]);
    embedded.length = 0;

    published = [{ id: "nomic::nomic-embed-text-v1.5", name: "nomic-embed-text-v1.5", providerSlug: "nomic" }];
    const found = await ai.vectorSearch("memo", { collection: "turns", query: "canary deploy", k: 5 });
    expect(embedded.map((e) => e.model)).toEqual(["nomic::nomic-embed-text-v1.5", "nomic::nomic-embed-text-v1.5"]);
    expect(embedded[0].texts).toEqual(["deploy the service with a canary", "the budget is in dollars"]);
    expect(ai.listCollections("memo")).toEqual([{ name: "turns", model: "nomic::nomic-embed-text-v1.5", dim: 3, items: 2 }]);
    expect(found.matches.map((m) => m.id).sort()).toEqual(["a", "b"]);

    embedded.length = 0;
    await ai.vectorUpsert("memo", { collection: "turns", items: [{ id: "c", text: "a third turn" }] });
    expect(embedded).toEqual([{ model: "nomic::nomic-embed-text-v1.5", texts: ["a third turn"] }]);
    expect(ai.listCollections("memo")[0].items).toBe(3);
  });

  it("leaves a collection alone while its model is still offered, or there is no embeddings model to move to", async () => {
    published = [{ id: "nomic::nomic-embed-text-v1.5", name: "nomic-embed-text-v1.5", providerSlug: "nomic" }];
    pick = "nomic::nomic-embed-text-v1.5";
    await ai.vectorUpsert("notes", { collection: "n", items: [{ id: "x", text: "one" }] });
    embedded.length = 0;
    published = [];
    await ai.vectorSearch("notes", { collection: "n", query: "one" }).catch(() => undefined);
    expect(ai.listCollections("notes")).toEqual([{ name: "n", model: "nomic::nomic-embed-text-v1.5", dim: 3, items: 1 }]);
    published = [{ id: "nomic::nomic-embed-text-v1.5", name: "nomic-embed-text-v1.5", providerSlug: "nomic" }];
    await ai.vectorSearch("notes", { collection: "n", query: "one" });
    expect(embedded.every((e) => e.texts.length === 1 && e.texts[0] === "one")).toBe(true);
    expect(ai.listCollections("notes")).toEqual([{ name: "n", model: "nomic::nomic-embed-text-v1.5", dim: 3, items: 1 }]);
  });

  it("forgets a collection that held only bare vectors, so the next upsert makes it afresh", async () => {
    published = [{ id: "openai::text-embedding-3-large", name: "text-embedding-3-large", providerSlug: "openai" }];
    pick = "openai::text-embedding-3-large";
    await ai.vectorUpsert("raw", { collection: "vecs", items: [{ id: "v", vector: [0, 1, 0, 0] }] });
    published = [{ id: "nomic::nomic-embed-text-v1.5", name: "nomic-embed-text-v1.5", providerSlug: "nomic" }];
    await expect(ai.vectorSearch("raw", { collection: "vecs", query: "anything" })).rejects.toThrow("unknown collection");
    await ai.vectorUpsert("raw", { collection: "vecs", items: [{ id: "t", text: "typed" }] });
    expect(ai.listCollections("raw")).toEqual([{ name: "vecs", model: "nomic::nomic-embed-text-v1.5", dim: 3, items: 1 }]);
  });

  it("moves a collection made by the old local hashed-words model onto the user's model", async () => {
    published = [{ id: "local::hashed-words-512", name: "On this computer", providerSlug: "local" }];
    pick = "local::hashed-words-512";
    DIM["local::hashed-words-512"] = 5;
    await ai.vectorUpsert("glyphh-memory", { collection: "turns", items: [{ id: "t#0", text: "USER: hi" }] });
    published = [{ id: "openai::text-embedding-3-large", name: "text-embedding-3-large", providerSlug: "openai" }];
    embedded.length = 0;
    await ai.vectorSearch("glyphh-memory", { collection: "turns", query: "hi" });
    expect(embedded[0]).toEqual({ model: "openai::text-embedding-3-large", texts: ["USER: hi"] });
    expect(ai.listCollections("glyphh-memory")).toEqual([{ name: "turns", model: "openai::text-embedding-3-large", dim: 4, items: 1 }]);
  });

  it("refuses to embed in plain words with no embeddings model", async () => {
    published = [];
    await expect(ai.llmEmbed({ text: "x" })).rejects.toThrow("Memory needs an embeddings model. Add one in Settings › Models.");
    await expect(ai.vectorUpsert("fresh", { collection: "c", items: [{ id: "a", text: "x" }] })).rejects.toThrow("Memory needs an embeddings model");
  });
});
