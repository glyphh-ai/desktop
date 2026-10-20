/**
 * backoff.ts — exponential backoff with full jitter, capped. Used by the durable
 * reconnect loop so a flapping connection neither hammers the server nor stalls.
 */

export interface BackoffOptions {
  baseMs?: number;
  capMs?: number;
  /** Injected for tests; defaults to Math.random. */
  random?: () => number;
}

/** Delay (ms) for reconnect `attempt` (1-based): min(cap, base·2^(n-1)) · [0,1) jitter. */
export function backoffDelay(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 300;
  const cap = opts.capMs ?? 30_000;
  const random = opts.random ?? Math.random;
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return Math.floor(exp * random());
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}
