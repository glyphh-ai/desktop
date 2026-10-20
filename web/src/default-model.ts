/**
 * default-model.ts — THE MODEL A NEW MOBILE SESSION OPENS ON, by the Glyphh
 * agent's own rule (his order, 2026-09-30: "the model chip at the top of the page
 * should default just like the glyphh agent does"; desktop help/code.ts
 * selectedModel + resolvedDefaultModel):
 *
 *   1. the member's own Default model (Settings → General — a server pref, so
 *      the phone reads the same one the desktop set);
 *   2. the org's default, as the server resolves it for this member's team
 *      (plans.gates().defaultModel — the team's flagged default, then the org's);
 *   3. the team's auto-router;
 *   4. the first chat model by id.
 *
 * Only a model the member's list still carries is ever chosen.
 */

export interface DefaultModelRow { id: string; name: string; providerSlug?: string; modality?: string; autoRouter?: boolean }

/** A catalog id's bare name: "anthropic::claude-sonnet-5" → "claude-sonnet-5". */
const bare = (v: string): string => v.replace(/^[a-z0-9_-]+::/i, "").trim();

export function resolveDefaultModel(models: readonly DefaultModelRow[], memberPref: string, orgDefault: string): string {
  const chat = models.filter((m) => !m.modality || m.modality === "chat");
  const find = (want: string): DefaultModelRow | undefined => {
    const w = want.trim();
    if (!w) return undefined;
    return chat.find((m) => m.id === w) ?? chat.find((m) => m.name === bare(w));
  };
  const picked = find(memberPref) ?? find(orgDefault)
    ?? chat.find((m) => m.autoRouter || m.providerSlug === "auto")
    ?? [...chat].sort((a, b) => a.id.localeCompare(b.id))[0];
  return picked?.id ?? "";
}
