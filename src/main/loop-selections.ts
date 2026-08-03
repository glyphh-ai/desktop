/**
 * loop-selections.ts — which model fills each of a loop's slots.
 *
 * A loop declares SLOTS ("planner", "coder", or just "default"); a selection binds
 * one to a model. Resolution — selection → the loop author's default → the platform
 * default → the first allowed model — happens server-side, so the picker and the
 * run ask the same question and cannot drift apart.
 *
 * Selections are stored per loop. A "coder" pick in one loop must not silently
 * rebind a slot of the same name in another: same word, different program.
 *
 * This lives apart from both callers because the picker (apps-ipc) and the turn
 * (glyphh-agent) both need it, and a model shown in the dropdown that is not the
 * model that runs is the exact bug this file exists to prevent.
 */

import { getClient } from "./glyphh-client";
import { getPreference, setPreference } from "./stores/preferences-db";
import { createTtlCache, type ResolvedLoopRole } from "@glyphh/sdk";

/** Every loop's stored picks: `{ [loopSlug]: { [role]: modelId } }`. */
type SelectionMap = Record<string, Record<string, string>>;

const PREF_KEY = "loopSelections";

/**
 * Slots change when an admin edits a loop or the catalog moves — rarely, and never
 * mid-turn. Caching them keeps the TURN off the network: a turn that must wait on
 * a picker query before it can start is a turn that hangs when that query is slow,
 * and the composer just spins. The cache also collapses the meter's and the turn's
 * concurrent lookups onto one request.
 */
const cache = createTtlCache({ ttlMs: 60_000 });

/** Last good answer per loop — survives TTL expiry so a failed refresh degrades to
 *  stale-but-usable rather than to nothing. */
const lastGood = new Map<string, ResolvedLoopRole[]>();

/** Drop cached slots — call after a selection changes, or the picker shows the
 *  model the user just replaced. */
export function invalidateRoles(loop?: string): void {
  cache.invalidate(loop ? `roles:${loop}` : "roles:");
}

/** The loop the composer is set to. */
export function currentLoop(): string {
  return String(getPreference("glyphhLoop", "default") || "default");
}

/** Switch the composer's active loop. */
export function setCurrentLoop(loop: string): void {
  setPreference("glyphhLoop", loop || "default");
}

/**
 * Apply a layout's loop + model config: make its loop active and bind each of
 * its slots to the layout's chosen model. This is how "load a layout" also sets
 * "which loop, on which models" — the layout is the one place that binds all
 * three (arrangement, program, models) so opening it puts the workspace in a
 * known state rather than only rearranging panels.
 *
 * A null/absent loop leaves the active loop untouched (the layout simply has no
 * opinion about it). Selections are written through the normal per-loop store,
 * so they persist and the composer's own picker reflects them.
 */
export function applyLoopConfig(loop: string | null | undefined, selections?: Record<string, string>): void {
  if (!loop) return;
  setCurrentLoop(loop);
  for (const [role, modelId] of Object.entries(selections ?? {})) {
    setSelection(loop, role, modelId || null);
  }
  invalidateRoles(loop);
}

function allSelections(): SelectionMap {
  const raw = getPreference<SelectionMap>(PREF_KEY, {});
  return raw && typeof raw === "object" ? raw : {};
}

/** This loop's stored picks. */
export function selectionsFor(loop: string): Record<string, string> {
  return allSelections()[loop] ?? {};
}

/**
 * Bind a slot to a model. A null model CLEARS the pick, handing the slot back to
 * the loop's own default — that is what "Auto" means in the picker.
 */
export function setSelection(loop: string, role: string, modelId: string | null): void {
  const all = allSelections();
  const forLoop = { ...(all[loop] ?? {}) };
  if (modelId) forLoop[role] = modelId;
  else delete forLoop[role];
  setPreference(PREF_KEY, { ...all, [loop]: forLoop });
  invalidateRoles(loop);
}

/** Resolve every slot for this caller — what the picker renders. */
export async function resolveRoles(loop: string): Promise<ResolvedLoopRole[]> {
  const key = `roles:${loop}:${JSON.stringify(selectionsFor(loop))}`;
  try {
    const roles = await cache.cached(key, () => getClient().loops.roles(loop, selectionsFor(loop)));
    lastGood.set(loop, roles);
    return roles;
  } catch (err) {
    // A stale answer beats none: the models a caller may use rarely change, and
    // blocking the composer on a transient failure is the worse outcome.
    const stale = lastGood.get(loop);
    if (stale) return stale;
    throw err;
  }
}

/**
 * The model a turn should run on, for one slot of the current loop.
 *
 * Falls back to the first slot when the named one is absent, because a program
 * asking for a role its manifest no longer declares should still run rather than
 * refuse. Null only when the caller may use no model at all.
 */
export async function runModel(role = "default"): Promise<string | null> {
  const loop = currentLoop();
  try {
    const roles = await resolveRoles(loop);
    return roles.find((r) => r.name === role)?.modelId ?? roles[0]?.modelId ?? null;
  } catch (err) {
    console.warn(`[loop-selections] resolving "${loop}.${role}" failed:`, err instanceof Error ? err.message : String(err));
    // Offline or signed out: trust the stored pick rather than blocking the turn.
    return selectionsFor(loop)[role] ?? null;
  }
}

/**
 * How much context the model in a slot can hold, or null when the catalog never
 * recorded it. Null means UNKNOWN, not zero: an unrecorded window falls back to a
 * conservative default rather than refusing to run.
 *
 * This is what makes compaction follow the model. A 200k-window model and an 8k
 * one need to fold at very different points, and folding on a constant means one
 * of them is always wrong.
 */
export async function runContextWindow(role = "default"): Promise<number | null> {
  const loop = currentLoop();
  try {
    const roles = await resolveRoles(loop);
    const slot = roles.find((r) => r.name === role) ?? roles[0];
    if (!slot?.modelId) return null;
    return slot.choices.find((c) => c.id === slot.modelId)?.contextWindow ?? null;
  } catch (err) {
    console.warn(`[loop-selections] context window for "${loop}.${role}" failed:`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * The reply budget for a turn: the resolved model's own maxOutputTokens.
 *
 * This replaced the effort dial's fixed tiers (1024/8192/12288) — local-era
 * rationing on models that declare their real limit in the catalog. Unknown
 * falls back to a workable 8192 rather than a crippled floor.
 */
export async function runMaxOutputTokens(role = "default"): Promise<number> {
  const loop = currentLoop();
  try {
    const roles = await resolveRoles(loop);
    const slot = roles.find((r) => r.name === role) ?? roles[0];
    const max = slot?.modelId ? slot.choices.find((c) => c.id === slot.modelId)?.maxOutputTokens : null;
    return max ?? 8192;
  } catch {
    return 8192;
  }
}
