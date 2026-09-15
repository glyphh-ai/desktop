/**
 * loop-selections.ts — THE MODEL PICK (his ruling, 2026-09-15: one loop, ours,
 * proxied through the gateway; "instead of loops it just has a model dropdown
 * fed from the api via the sdk").
 *
 * The loop is fixed ("glyphh"); what the user picks is the MODEL, from the
 * org's catalog on the gateway (`client.catalog.models()` — the platform's
 * models plus the org's own BYOK ones, grouped by provider in the picker).
 * The pick persists as the `agentModel` preference. The pre-purge role/loop
 * grammar survives as ONE role, "default", so the engine's callers
 * (runModel / runContextWindow / runMaxOutputTokens / resolveRoles) read
 * unchanged.
 */
import { getClient } from "./glyphh-client";
import { getPreference, setPreference } from "./stores/preferences-db";
import { createTtlCache } from "@glyphh/sdk";

export const GLYPHH_LOOP = "glyphh";
const PREF_KEY = "agentModel";

export interface RoleChoice {
  id: string;
  name: string;
  providerSlug: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  gatewayReady: boolean;
  own: boolean;
}
export interface ResolvedLoopRole {
  name: string;
  label: string;
  modelId: string | null;
  choices: RoleChoice[];
}

interface CatalogModel {
  id: string;
  name: string;
  providerSlug: string;
  active: boolean;
  defaultOn: boolean;
  source?: string;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  hasByokKey?: boolean;
  alias?: string | null;
}

const cache = createTtlCache({ ttlMs: 60_000 });
const LAST_GOOD_TTL_MS = 10 * 60_000;
let lastGood: { choices: RoleChoice[]; at: number } | null = null;

export function invalidateRoles(): void {
  cache.invalidate("catalog");
  lastGood = null;
}

export function currentLoop(): string {
  return GLYPHH_LOOP;
}

export function setCurrentLoop(_loop: string): void {
  /* one loop — nothing to switch */
}

export function applyLoopConfig(_loop: string | null | undefined, selections?: Record<string, string>): void {
  const pick = selections?.default;
  if (pick) setPreference(PREF_KEY, pick);
}

export function selectionsFor(_loop: string = GLYPHH_LOOP): Record<string, string> {
  const pick = String(getPreference(PREF_KEY, "") || "");
  return pick ? { default: pick } : {};
}

export function setSelection(_loop: string, _role: string, modelId: string | null): void {
  setPreference(PREF_KEY, modelId || "");
  invalidateRoles();
}

/** The catalog's proxied models as picker choices — the gateway serves all of them. */
async function choices(): Promise<RoleChoice[]> {
  try {
    const rows = await cache.cached("catalog", async () => (await getClient().catalog.models()) as unknown as CatalogModel[]);
    const out = rows
      .filter((m) => m.active && (m.source ?? "proxy") === "proxy")
      .map((m) => ({
        id: m.name, name: m.alias || m.name, providerSlug: m.providerSlug,
        contextWindow: m.contextWindow ?? null, maxOutputTokens: m.maxOutputTokens ?? null,
        gatewayReady: true, own: !!m.hasByokKey,
      }));
    lastGood = { choices: out, at: Date.now() };
    return out;
  } catch (err) {
    if (lastGood && Date.now() - lastGood.at < LAST_GOOD_TTL_MS) return lastGood.choices;
    throw err;
  }
}

/** One role, "default": the picked model (or the first default-on one) over the catalog. */
export async function resolveRoles(_loop: string = GLYPHH_LOOP, _context: "local" | "cloud" = "local"): Promise<ResolvedLoopRole[]> {
  const all = await choices();
  const picked = selectionsFor().default;
  const modelId = (picked && all.some((c) => c.id === picked)) ? picked : (all[0]?.id ?? null);
  return [{ name: "default", label: "Model", modelId, choices: all }];
}

export async function runModel(role = "default", loop: string = GLYPHH_LOOP): Promise<string | null> {
  try {
    const roles = await resolveRoles(loop);
    return roles.find((r) => r.name === role)?.modelId ?? roles[0]?.modelId ?? null;
  } catch (err) {
    console.warn(`[loop-selections] resolving the model failed:`, err instanceof Error ? err.message : String(err));
    return selectionsFor().default ?? null;
  }
}

async function pickedChoice(): Promise<RoleChoice | null> {
  const roles = await resolveRoles();
  const slot = roles[0];
  if (!slot?.modelId) return null;
  return slot.choices.find((c) => c.id === slot.modelId) ?? null;
}

/** The picked model's context window, or null when the catalog never recorded it. */
export async function runContextWindow(_role = "default"): Promise<number | null> {
  try {
    return (await pickedChoice())?.contextWindow ?? null;
  } catch (err) {
    console.warn(`[loop-selections] context window failed:`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** The reply budget: the picked model's own maxOutputTokens, 8192 when unknown. */
export async function runMaxOutputTokens(_role = "default"): Promise<number> {
  try {
    return (await pickedChoice())?.maxOutputTokens ?? 8192;
  } catch {
    return 8192;
  }
}
