/**
 * Ada's enricher — extracts a fact's structured slots at write time.
 *
 * adaL's UniversalEnricher was one cached Anthropic call per fact; this runs the
 * same system prompt through the gateway and parses the reply as JSON.
 *
 * NOT grammar-constrained: `schema` is passed but the gateway does not yet honor
 * a response schema (GatewayCompletionInput carries none), so the reply is
 * free-form JSON we parse best-effort — sanitizeUniversal drops anything the
 * rules didn't earn, and a parse failure yields {} (the fact still stores, just
 * without slots). Wiring true structured output through the gateway would make
 * this exact rather than best-effort.
 *
 * Write-time only — the read path never calls a model. And never fatal: see below.
 */

import { ENRICHER_SYSTEM, ENRICHER_JSON_SCHEMA, sanitizeUniversal, type UniversalFacts } from "./schema";
import { captureEnrich } from "../glyphh-agent-training";

export async function enrichFact(text: string): Promise<UniversalFacts> {
  // Enrichment is an ENHANCEMENT: it adds structured slots so a fact is queryable
  // by entity/relation, but the raw prose is stored and lexically recallable
  // without it. So this must NEVER throw — a memory write to a LOCAL store cannot
  // be allowed to fail because a REMOTE model call did (a 400, a timeout, no
  // model, out of credits). The caller stores the fact either way; a failed
  // enrich just means zero slots, re-enrichable later. This was the "backend 400
  // error" that lost a research session's writes: the model call threw and took
  // the local write down with it.
  try {
    // Lazy import — glyphh.ts → glyphh-tools.ts → here would otherwise cycle.
    const { glyphhComplete } = await import("../glyphh-agent");
    const raw = await glyphhComplete([
      { role: "system", content: ENRICHER_SYSTEM },
      { role: "user", content: `FACT: ${text}` },
    ], { temperature: 0.1, maxTokens: 400, schema: ENRICHER_JSON_SCHEMA as unknown as object });
    const facts = sanitizeUniversal(JSON.parse(raw));
    captureEnrich({ text, facts }); // fact→schema pairs — enricher training data
    return facts;
  } catch {
    return {};
  }
}
