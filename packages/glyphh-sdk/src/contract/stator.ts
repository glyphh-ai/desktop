/**
 * contract/stator.ts — the org MEMORY PLANE wire shapes: the FACT SUBSTRATE
 * (the glyph ledger the per-turn fact block reads). Recall is the runtime
 * path; browse/graph/create/forget/amend are the CURATION surface the desktop
 * Memory panel drives. Owner-scoped end to end: the server proxy region-routes
 * to the org's runtime and the bearer's org/user scopes every op.
 */

/** One fact glyphh, as the ledger serializes it. `concept.facts` holds the
 *  stored slots as {layer: {role: value}} over the universal schema. */
export interface GlyphFact {
  id: string;
  name: string;
  /** Cosine to the probe — present on recall hits only. */
  cos?: number;
  confidence: number;
  scope: "org" | "user";
  derived: boolean;
  citations?: string[];
  concept: { name?: string; facts?: Record<string, Record<string, string>> };
  createdAt: string;
}

export interface StatorRecallInput { query?: string; topK?: number }
export interface StatorRecallResult {
  /** The hits rendered as fact-block lines — what a prompt would inject. */
  block: string;
  facts: GlyphFact[];
}

export interface StatorBrowseInput { limit?: number }
export interface StatorBrowseResult {
  /** Every live fact rendered as ledger lines. */
  block: string;
  facts: GlyphFact[];
}

export interface StatorCreateInput {
  name: string;
  /** {layer: {role: value}} over the universal schema; off-schema slots are
   *  preserved verbatim (reported back as preservedSlots). */
  facts?: Record<string, Record<string, string>>;
  confidence?: number;
  scope?: "org" | "user";
}
export interface StatorCreateResult {
  id: string;
  confidence: number;
  scope: "org" | "user";
  preservedSlots?: string[];
}

export interface StatorGraphInput { max?: number; semMin?: number; neuralMin?: number; neuralMax?: number }
export interface StatorGraphNode {
  /** Index into coords. */
  id: number;
  factId: string;
  name: string;
  /** "layer.role=value" lines — the info card's body. */
  slots: string[];
  scope: string;
  derived: boolean;
  confidence: number;
  createdAt: string;
}
export interface StatorGraphResult {
  nodes: StatorGraphNode[];
  /** 3D PCA coordinates over the cortex space, index-aligned with nodes. */
  coords: Array<[number, number, number]>;
  edges: Array<{ a: number; b: number; sim: number; kind: "semantic" | "neural" }>;
}

export interface StatorForgetInput { id: string }
export interface StatorForgetResult { forgotten: boolean }

export interface StatorAmendInput {
  /** The fact to correct — a new version is appended and this id superseded. */
  id: string;
  name?: string;
  facts?: Record<string, Record<string, string>>;
  confidence?: number;
}
export interface StatorAmendResult { id: string; supersedes: string }
