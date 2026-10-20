/**
 * core/cache.ts — a short-TTL, promise-deduplicating cache for SDK reads.
 *
 * Clients that render the same data from several places (a palette and the
 * click that follows it, a page and its background refresh) would otherwise
 * issue the same request two or three times. `cached()` collapses concurrent
 * and within-TTL callers onto ONE in-flight promise, keyed by a caller-chosen
 * string. A rejected fetch is evicted immediately, so a failure never poisons
 * the key for the rest of the TTL.
 *
 * Deliberately not automatic on every resource method: caching is a policy the
 * caller owns (a dashboard wants a few seconds of reuse; a write path wants
 * none), so it is opt-in per call site with an explicit invalidation hook.
 */

export interface TtlCacheOptions {
  /** Default lifetime for an entry, in ms (default 20 000). */
  ttlMs?: number;
}

export interface TtlCache {
  /** Run `fetcher` under `key`, reusing an in-flight or fresh result. */
  cached<T>(key: string, fetcher: () => Promise<T>, ttlMs?: number): Promise<T>;
  /** Drop everything, or every key starting with `prefix`. */
  invalidate(prefix?: string): void;
}

interface Entry {
  at: number;
  promise: Promise<unknown>;
}

export function createTtlCache(opts: TtlCacheOptions = {}): TtlCache {
  const defaultTtl = opts.ttlMs ?? 20_000;
  const entries = new Map<string, Entry>();

  return {
    cached<T>(key: string, fetcher: () => Promise<T>, ttlMs: number = defaultTtl): Promise<T> {
      const now = Date.now();
      const hit = entries.get(key);
      if (hit && now - hit.at < ttlMs) return hit.promise as Promise<T>;
      const promise = fetcher();
      entries.set(key, { at: now, promise });
      promise.catch(() => {
        if (entries.get(key)?.promise === promise) entries.delete(key);
      });
      return promise;
    },

    invalidate(prefix?: string): void {
      if (prefix === undefined) {
        entries.clear();
        return;
      }
      for (const key of [...entries.keys()]) {
        if (key.startsWith(prefix)) entries.delete(key);
      }
    },
  };
}
