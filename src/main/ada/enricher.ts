/**
 * Ada's enricher — William plays the extractor, locally.
 *
 * adaL's UniversalEnricher was one cached Anthropic call per fact; here
 * the SAME system prompt runs against the local model with the reply
 * grammar-constrained to the schema shape, so extraction can't fail to
 * parse (sanitizeUniversal drops anything the rules didn't earn).
 * Write-time only — the read path never calls a model.
 */

import { ENRICHER_SYSTEM, ENRICHER_JSON_SCHEMA, sanitizeUniversal, type UniversalFacts } from "./schema";

export async function enrichFact(text: string): Promise<UniversalFacts> {
  // Lazy import — william.ts → william-tools.ts → here would otherwise cycle.
  const { williamComplete } = await import("../william");
  const raw = await williamComplete([
    { role: "system", content: ENRICHER_SYSTEM },
    { role: "user", content: `FACT: ${text}` },
  ], { temperature: 0.1, maxTokens: 400, schema: ENRICHER_JSON_SCHEMA as unknown as object });
  try {
    return sanitizeUniversal(JSON.parse(raw));
  } catch {
    return {};
  }
}
