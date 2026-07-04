/**
 * server-cache — a short-TTL, promise-dedup cache for the hot server GETs
 * (/api/panel-apps, /api/layouts) that the command palette, app resolver, and
 * layout manager all hit.
 *
 * Why: opening a layout from the command palette used to cost THREE network
 * round-trips (palette render fetches both endpoints, then the click's
 * openLayoutByName re-fetched both, serially) before a single window opened.
 * Caching the in-flight promise means the palette-open fetch and the click
 * share one request — a click within the TTL opens with zero network waits.
 *
 * The TTL is short (20s): staleness is bounded even without invalidation, and
 * every mutation path calls invalidateServerCache() anyway.
 */

import { serverGetAuthed } from "./auth.js";

const DEFAULT_TTL_MS = 20_000;

interface Entry {
  at: number;
  promise: Promise<unknown>;
}

const entries = new Map<string, Entry>();

/** GET an endpoint through the cache. Concurrent + within-TTL callers share
 *  one request. A failed fetch never poisons the cache. */
export function cachedServerGet<T>(endpoint: string, ttlMs: number = DEFAULT_TTL_MS): Promise<T> {
  const now = Date.now();
  const hit = entries.get(endpoint);
  if (hit && now - hit.at < ttlMs) return hit.promise as Promise<T>;
  const promise = serverGetAuthed<T>(endpoint);
  entries.set(endpoint, { at: now, promise });
  promise.catch(() => {
    if (entries.get(endpoint)?.promise === promise) entries.delete(endpoint);
  });
  return promise;
}

/** Drop cached entries — all of them, or those starting with `prefix`
 *  (e.g. invalidateServerCache("/api/panel-apps") after a mutation). */
export function invalidateServerCache(prefix?: string): void {
  if (!prefix) { entries.clear(); return; }
  for (const key of entries.keys()) {
    if (key.startsWith(prefix)) entries.delete(key);
  }
}
