/**
 * ui-state.ts — the workbench's UI state, server-side.
 *
 * ZERO-LOCAL-STORAGE LAW: the app stores nothing locally. The workbench's
 * arrangement — which panels are open in a layout, the geometry the user
 * dragged them into, the session a layout rides — was the last holdout: it
 * lived in `localStorage`, so it was per-DEVICE. Open a layout on the desktop,
 * open it on the web, and you got the server's default placement instead of
 * how you left it.
 *
 * This is a synchronous key → string store mirrored from ONE server pref
 * (`workbenchUiState`), so every existing call site keeps its `localStorage`
 * shape (`get`/`set`/`remove` of a JSON string) while the state itself follows
 * the user. `load()` must resolve before the first read; after that reads are
 * pure memory and writes are optimistic + debounced into one PATCH.
 *
 * NOT blob storage: a pref VALUE is capped at 32KB server-side, so writes evict
 * the least-recently-written entries to stay under budget. The state is a
 * convenience — losing the oldest folder's arrangement is survivable, a
 * rejected 32KB PATCH that drops EVERY arrangement is not.
 */

const PREF_KEY = "workbenchUiState";
/** Serialized ceiling for the whole map. The server rejects a value over 32KB. */
const MAX_BYTES = 28 * 1024;
/** Coalesce the burst of writes a single drag produces into one PATCH. */
const FLUSH_MS = 800;

interface Entry { v: string; at: number }

const mem = new Map<string, Entry>();
let loaded = false;
let loading: Promise<void> | null = null;
let flushTimer = 0;
let clock = 0;
/** A write is pending persistence (may predate the load). */
let dirty = false;

const bridge = (): {
  getPreference?: (k: string, d?: unknown) => Promise<unknown>;
  setPreference?: (k: string, v: unknown) => void;
} => (window as unknown as { glyphh?: Record<string, never> }).glyphh ?? {};

/** Monotonic write stamp. Date.now() ties within a millisecond during a drag,
 *  and eviction needs a total order to be stable. */
function stamp(): number { return ++clock; }

/**
 * Pull the server map into memory. Safe to call repeatedly; concurrent calls
 * share one flight. A failure does NOT latch: the store simply starts empty
 * and the next call retries, because caching a failed load reads to the user
 * as "every layout forgot itself".
 */
export function loadUiState(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (!loading) {
    loading = (async () => {
      try {
        const raw = await bridge().getPreference?.(PREF_KEY, null);
        const map = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (map && typeof map === "object") {
          // Re-stamp in the PERSISTED write order, not iteration order. The
          // stored `at` is a per-session counter — meaningless as a value, but
          // a valid total order within one snapshot. Iterating JSON order here
          // froze every key at its CREATION position (Map.set keeps an
          // existing key's slot), so a key updated daily but created first
          // stayed "oldest" forever and the 28KB eviction deleted the user's
          // hottest arrangements (his report, 2026-09-08: deleting a layout
          // wiped panels out of other layouts for good).
          const entries = Object.entries(map as Record<string, unknown>)
            .map(([k, e]): [string, Entry] | null => {
              // Tolerate both shapes: {v, at} and a bare string from an older write.
              if (typeof e === "string") return [k, { v: e, at: 0 }];
              if (e && typeof e === "object" && typeof (e as Entry).v === "string") {
                return [k, { v: (e as Entry).v, at: Number((e as Entry).at) || 0 }];
              }
              return null;
            })
            .filter((x): x is [string, Entry] => x !== null)
            .sort((a, b) => a[1].at - b[1].at);
          for (const [k, e] of entries) {
            // An optimistic write made while this flight was open is NEWER than
            // the server's copy — merge under it, never over it.
            if (mem.has(k)) continue;
            mem.set(k, { v: e.v, at: stamp() });
          }
        }
        loaded = true;
        // A write that landed pre-load is still only in memory — and its flush
        // was held back precisely because the map was not whole yet.
        if (dirty) schedule();
      } catch {
        loading = null; // transient (pre-auth 401, offline) — let the next read retry
      }
    })();
  }
  return loading ?? Promise.resolve();
}

/** Sign-out / user switch: drop the map so the next user never reads it. */
export function clearUiState(): void {
  mem.clear();
  loaded = false;
  loading = null;
  dirty = false;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = 0; }
}

/** Read a stored value. Synchronous; null before `loadUiState()` resolves. */
export function uiStateGet(key: string): string | null {
  return mem.get(key)?.v ?? null;
}

/** Write a value (optimistic in memory, debounced to the server). */
export function uiStateSet(key: string, value: string): void {
  mem.set(key, { v: value, at: stamp() });
  schedule();
}

/** Delete a value. */
export function uiStateRemove(key: string): void {
  if (mem.delete(key)) schedule();
}

/**
 * Forget `prefix` and every key namespaced under it (`prefix:...`) — what a
 * renamed or deleted layout needs, since its state is spread across several
 * key families (arrangement, per-space session binding, panel memory). Matches
 * on a colon boundary so "wall" never takes "wall-2" with it.
 */
export function uiStateRemovePrefix(prefix: string): void {
  let hit = false;
  for (const k of [...mem.keys()]) {
    if (k === prefix || k.startsWith(`${prefix}:`)) { mem.delete(k); hit = true; }
  }
  if (hit) schedule();
}

function schedule(): void {
  dirty = true;
  // NEVER flush a partial map. Before the load resolves `mem` holds only what
  // this session happened to write, and pushing that would DELETE every key
  // the user has on the server. Kick the load; it re-schedules when it lands.
  if (!loaded) { void loadUiState(); return; }
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = window.setTimeout(flush, FLUSH_MS);
}

/**
 * The map to store, with the least-recently-written entries evicted until it
 * fits the server's per-value ceiling. Eviction is applied to `mem` too —
 * otherwise the dropped entries would be re-serialized on every later flush
 * and the map would never converge.
 *
 * Returns the OBJECT, not a string: the server measures a value by its own
 * JSON.stringify, and a pre-stringified map arrives re-escaped (every quote
 * becomes \") — roughly double the bytes, against the same 32KB ceiling.
 */
function snapshot(): Record<string, Entry> {
  const out: Record<string, Entry> = {};
  for (const [k, e] of mem) out[k] = e;
  if (JSON.stringify(out).length <= MAX_BYTES) return out;

  const oldestFirst = [...mem.entries()].sort((a, b) => a[1].at - b[1].at);
  const evicted: string[] = [];
  for (const [k] of oldestFirst) {
    if (mem.size <= 1) break; // never evict the entry that was just written
    delete out[k];
    mem.delete(k);
    evicted.push(k);
    if (JSON.stringify(out).length <= MAX_BYTES) break;
  }
  // Never silent: an evicted key IS a forgotten arrangement somewhere.
  if (evicted.length) console.warn("[ui-state] over budget — evicted:", evicted.join(", "));
  return out;
}

/** Push the map to the server. Failures are logged, never thrown: the
 *  in-memory state stays authoritative for this session either way. */
function flush(): void {
  flushTimer = 0;
  if (!loaded) return; // schedule() re-arms once the server map is whole
  dirty = false;
  try {
    bridge().setPreference?.(PREF_KEY, snapshot());
  } catch (e) {
    console.error("[ui-state] persist failed:", (e as Error).message);
  }
}

/** Flush now instead of waiting out the debounce — used on unload so the last
 *  drag of a session is not the one that gets lost. */
export function flushUiState(): void {
  if (flushTimer) { clearTimeout(flushTimer); flush(); }
}
