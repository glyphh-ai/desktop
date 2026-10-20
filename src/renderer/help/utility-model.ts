/**
 * utility-model.ts — WHICH MODEL RUNS THE SMALL SIDE JOBS (the session title).
 *
 * His order, 2026-10-05: a side request never rides the session's model. The
 * super admin flags ONE shared chat model as the utility model on the console's
 * Models page (`utility: true` on the available row); until one is flagged the
 * client takes the CHEAPEST configured chat model. The SDK will export the same
 * rule as `pickUtilityModel(rows)` — until it is rebuilt, the one rule lives
 * here, verbatim, and the two must never drift:
 *
 *   1. the first row flagged `utility` → its id
 *   2. else the cheapest row with a text/chat modality, by
 *      inputUsdPerMTok + 3 × outputUsdPerMTok (a title reads more than it
 *      writes, so output weighs three to one); ties keep list order
 *   3. else null — the caller skips the job, never falls back to the session's
 *      model.
 *
 * Pure: rows in, an id or null out. Kept inside src/renderer (the renderer
 * never imports src/shared — scripts/check-renderer-emit.mjs).
 */

export interface UtilityModelRow {
  id: string;
  /** chat | text | image | … — only chat/text rows can write a title. */
  modality?: string;
  /** The console's Utility switch (his order, 2026-10-05). */
  utility?: boolean;
  inputUsdPerMTok?: number;
  outputUsdPerMTok?: number;
}

const TEXT_MODALITIES = new Set(["chat", "text"]);

/** The rule's price: input + 3 × output per MTok; null when the row carries
 *  no usable prices (an unpriced row cannot be "the cheapest"). */
export function utilityCost(row: UtilityModelRow): number | null {
  const i = row.inputUsdPerMTok;
  const o = row.outputUsdPerMTok;
  if (typeof i !== "number" || typeof o !== "number" || !Number.isFinite(i) || !Number.isFinite(o) || i < 0 || o < 0) return null;
  return i + 3 * o;
}

/** The utility model's id: the flagged row, else the cheapest chat/text row,
 *  else null. */
export function pickUtilityModel(rows: readonly UtilityModelRow[] | null | undefined): string | null {
  if (!Array.isArray(rows) || !rows.length) return null;
  const flagged = rows.find((r) => r && r.utility === true && r.id);
  if (flagged) return flagged.id;
  let best: { id: string; cost: number } | null = null;
  for (const r of rows) {
    if (!r || !r.id || !TEXT_MODALITIES.has(String(r.modality ?? ""))) continue;
    const cost = utilityCost(r);
    // An unpriced row (an auto-router at 0/0) is not "cheapest" — it is
    // unknown; the server's resolver skips it the same way.
    if (cost === null || cost <= 0) continue;
    if (!best || cost < best.cost) best = { id: r.id, cost };
  }
  return best?.id ?? null;
}
