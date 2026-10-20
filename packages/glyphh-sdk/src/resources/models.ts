/**
 * resources/models.ts — the caller's EFFECTIVE model set. `available()` returns the
 * models this member may actually use right now — the catalog narrowed by the org's
 * supported set and the caller's workspace allow-list — each tagged with how it's
 * reached (proxy / byok / local). This is what a model picker should show.
 */

import type { AuthedHttp } from "../core/authed-http.js";
import type { AvailableModel } from "../contract/models.js";

export class ModelsClient {
  constructor(private readonly http: AuthedHttp) {}

  /** The models the caller may actually use (catalog ∩ org-supported ∩ workspace allow-list). */
  available(): Promise<AvailableModel[]> {
    return this.http.get<AvailableModel[]>("/api/models/available");
  }
}

/** A side task reads little and writes less: output weighs three to one, the
 *  same formula the server's resolver (`utilityModel` on the plan gates) uses. */
export function utilityCost(row: Pick<AvailableModel, "inputUsdPerMTok" | "outputUsdPerMTok">): number {
  return (row.inputUsdPerMTok || 0) + 3 * (row.outputUsdPerMTok || 0);
}

/**
 * The model to run a side task on (a session title): the row flagged `utility`,
 * else the cheapest chat row by {@link utilityCost}, else null. An unpriced row
 * (0 both ways) is unknown rather than cheap and never wins the fallback.
 * Answers the row's `id`, which is what a turn names.
 */
export function pickUtilityModel(rows: readonly AvailableModel[]): string | null {
  const chat = rows.filter((m) => m.modality === "chat");
  const flagged = chat.find((m) => m.utility === true);
  if (flagged) return flagged.id;
  const priced = chat.filter((m) => utilityCost(m) > 0);
  if (priced.length === 0) return null;
  return priced.reduce((best, m) => {
    const d = utilityCost(m) - utilityCost(best);
    return d < 0 || (d === 0 && m.id < best.id) ? m : best;
  }).id;
}
