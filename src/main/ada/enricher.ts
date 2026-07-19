/**
 * Ada's enricher — Glyphh plays the extractor, locally.
 *
 * adaL's UniversalEnricher was one cached Anthropic call per fact; here
 * the SAME system prompt runs against the local model with the reply
 * grammar-constrained to the schema shape, so extraction can't fail to
 * parse (sanitizeUniversal drops anything the rules didn't earn).
 * Write-time only — the read path never calls a model.
 */

import { ENRICHER_SYSTEM, ENRICHER_JSON_SCHEMA, sanitizeUniversal, type UniversalFacts } from "./schema";
import { captureEnrich } from "../glyphh-agent-training";

export async function enrichFact(text: string): Promise<UniversalFacts> {
  // Lazy import — glyphh.ts → glyphh-tools.ts → here would otherwise cycle.
  const { glyphhComplete } = await import("../glyphh-agent");
  const raw = await glyphhComplete([
    { role: "system", content: ENRICHER_SYSTEM },
    { role: "user", content: `FACT: ${text}` },
  ], { temperature: 0.1, maxTokens: 400, schema: ENRICHER_JSON_SCHEMA as unknown as object });
  try {
    const facts = sanitizeUniversal(JSON.parse(raw));
    captureEnrich({ text, facts }); // fact→schema pairs — enricher training data
    return facts;
  } catch {
    return {};
  }
}
