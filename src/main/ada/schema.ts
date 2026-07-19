/**
 * Ada's universal schema + deterministic text machinery — a faithful port
 * of glyphh-adaL's ada/cognitive/universal.py and the shared tokenizer/
 * scorer from ada/memory/thought_space.py.
 *
 * Every fact maps into one fixed 7-layer lattice at write time; reads are
 * exact scans addressed by layer.role slot. An absent slot is a structural
 * ∅ — Ada refuses rather than confabulates.
 */

export const UNIVERSAL_SCHEMA: Record<string, string[]> = {
  entity: ["name", "kind", "subkind"],
  perceptual: ["color", "size", "shape", "texture", "sound", "smell", "taste", "temperature"],
  spatial: ["location", "origin", "direction"],
  temporal: ["time", "duration", "age", "era", "frequency"],
  relational: ["subject", "predicate", "object", "possessor", "agent", "patient", "instrument"],
  quantitative: ["count", "magnitude", "unit", "ratio"],
  epistemic: ["source", "certainty", "modality"],
};

export type UniversalFacts = Record<string, Record<string, string>>;

/** Keep only schema-valid layers/roles with non-empty values (port of
 *  _sanitize_universal — malformed layers and null-ish values drop). */
export function sanitizeUniversal(facts: unknown): UniversalFacts {
  const clean: UniversalFacts = {};
  if (!facts || typeof facts !== "object" || Array.isArray(facts)) return clean;
  for (const [layer, roles] of Object.entries(facts as Record<string, unknown>)) {
    if (!(layer in UNIVERSAL_SCHEMA)) continue;
    if (!roles || typeof roles !== "object" || Array.isArray(roles)) continue;
    const kept: Record<string, string> = {};
    for (const [role, value] of Object.entries(roles as Record<string, unknown>)) {
      if (!UNIVERSAL_SCHEMA[layer].includes(role)) continue;
      if (value === null || value === undefined) continue;
      const v = String(value).trim();
      if (!v || ["none", "null", "n/a"].includes(v.toLowerCase())) continue;
      kept[role] = v;
    }
    if (Object.keys(kept).length) clean[layer] = kept;
  }
  return clean;
}

// ── Tokenizer (shared by write-time indexing and recall scoring) ──────────

const STOPWORDS = new Set([
  "a", "an", "the",
  "is", "are", "was", "were", "be", "been", "being",
  "of", "to", "in", "on", "at", "by", "for", "with", "from", "as",
  "this", "that", "these", "those", "it", "its",
  "what", "which", "who", "whom", "whose", "where", "when", "how",
  "do", "does", "did", "have", "has", "had",
]);

const TOKEN_RE = /[a-z0-9][a-z0-9'_-]*/g;

/** Cheap deterministic normalization: aurora's→aurora, uses→use,
 *  cameras→camera. Leaves -ss words (chess, glass) and short tokens alone. */
function normalizeToken(token: string): string {
  let t = token;
  if (t.endsWith("'s") || t.endsWith("s'")) t = t.slice(0, -2);
  else if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) t = t.slice(0, -1);
  return t.replace(/'+$/, "");
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text).toLowerCase().matchAll(TOKEN_RE)) {
    if (!STOPWORDS.has(m[0])) out.push(normalizeToken(m[0]));
  }
  return out;
}

/** Normalize a slot value the way Ada does before indexing/matching. */
export const normValue = (s: unknown): string => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

// ── Lexical recall scoring (port of score_thought; both stores rank
//    identically — ours is the SQL store, scored over a candidate pool) ──

export interface ScoreInput { content: string; universal: UniversalFacts }

export function scoreThought(stored: ScoreInput, qTokens: Set<string>): number {
  const tTokens = new Set(tokenize(stored.content));
  const slotTokens = new Set<string>();
  for (const roles of Object.values(stored.universal)) {
    for (const v of Object.values(roles)) for (const t of tokenize(String(v))) slotTokens.add(t);
  }
  const allTokens = new Set([...tTokens, ...slotTokens]);

  const setCosine = (target: Set<string>): number => {
    if (!target.size || !qTokens.size) return 0;
    let inter = 0;
    for (const t of qTokens) if (target.has(t)) inter++;
    return inter / Math.sqrt(qTokens.size * target.size);
  };

  const tokenSim = Math.max(setCosine(tTokens), setCosine(allTokens));
  let slotHits = 0;
  for (const t of qTokens) if (slotTokens.has(t)) slotHits++;
  const slotSim = qTokens.size ? slotHits / qTokens.size : 0;

  return tokenSim + slotSim;
}

// ── The enricher system prompt (verbatim from universal.py — the rules
//    ARE the extraction quality; Glyphh plays the extractor locally) ──

export const ENRICHER_SYSTEM =
  "You are a structured-data extractor. Given a fact, fill in the " +
  "values of this fixed universal schema. Use ONLY the roles listed. " +
  "Leave a role's value blank/null if the fact doesn't mention it. " +
  "Do not invent roles. Return strict JSON only.\n\n" +
  "RULES:\n" +
  "1. The entity layer describes exactly ONE entity: the primary " +
  "subject the fact is about (usually the person/agent). It is a " +
  "single JSON object, never a list. When a fact mentions a second " +
  "entity (a pet, a possession, an employer), the second entity goes " +
  "in relational.object — e.g. 'X owns a parrot' → entity.name=X, " +
  "relational={subject: X, predicate: owns, object: parrot}. This " +
  "holds regardless of sentence order: 'A parrot lives with X' is " +
  "still about X owning a parrot.\n" +
  "2. spatial.location = where the subject is or lives NOW. " +
  "spatial.origin = where the subject is from, was born, or grew up. " +
  "Never put a born-in/grew-up-in/from place in spatial.location.\n" +
  "3. Values must be concrete terms from the fact. Never emit " +
  "deictic or generic placeholders ('home', 'here', 'there', " +
  "'this place') as a value — resolve to the concrete value or " +
  "leave the role blank.\n" +
  "4. Attribute values (age, color, height) describe the primary " +
  "subject and go in their dedicated roles (temporal.age, " +
  "perceptual.color, quantitative.magnitude + quantitative.unit).\n" +
  "5. Stated preferences and favorites are attributes OF the subject, " +
  "stored in the attribute's natural slot: 'X's favorite color is " +
  "blue' → perceptual.color=blue and relational.predicate=" +
  "'favorite_color'. Do not move the preferred value into " +
  "relational.object.\n" +
  "6. Occupations and roles: 'X works as a Y' → relational=" +
  "{subject: X, predicate: works_as, object: Y}. entity.kind/subkind " +
  "describe what kind of thing the subject IS (person, organization, " +
  "place) — never an occupation, hobby, or possession.\n" +
  "7. Fill a slot only with information the fact explicitly states " +
  "about the primary subject. Incidental phrases ('at home', 'at " +
  "work', 'these days', 'busier than ever') fill nothing.\n\n" +
  "SCHEMA:\n" +
  Object.entries(UNIVERSAL_SCHEMA).map(([layer, roles]) => `  ${layer}: ${roles.join(", ")}`).join("\n");

/** Grammar schema for the enricher turn — llama.cpp constrains the reply
 *  so extraction can't fail to parse (sanitizeUniversal drops the rest). */
export const ENRICHER_JSON_SCHEMA = {
  type: "object",
  properties: Object.fromEntries(
    Object.entries(UNIVERSAL_SCHEMA).map(([layer, roles]) => [
      layer,
      { type: "object", properties: Object.fromEntries(roles.map((r) => [r, { type: "string" }])) },
    ]),
  ),
} as const;
