/**
 * Preferences — the SERVER map (`/api/me/prefs`), cached in memory.
 *
 * ZERO-LOCAL-STORAGE LAW (2026-08-15): the app stores nothing locally; every
 * piece of user state goes through the SDK. This file's previous SQLite
 * implementation said, in its own header, that prefs were "device-local until
 * a governed preference surface exists in the SDK — at which point the sync
 * belongs there". That surface exists (`client.profile.prefs()`), app-web has
 * been riding it all along (web/src/web-contract.js prefsCache), and desktop
 * SQLite prefs were the fork that kept the two surfaces from sharing state.
 *
 * Semantics are the WEB'S, exactly, so the shared renderer sees one behavior:
 *   - fetched ONCE per signed-in user (loadPreferences, called after auth);
 *   - reads are synchronous from the in-memory map (main-process callers like
 *     screen-layout's railWidth() are sync by contract) — before the first
 *     load, or signed out, a read answers its default, never throws;
 *   - writes update the map optimistically then persist via setPrefs;
 *     a failed persist logs and keeps the optimistic value (same as web);
 *   - sign-out clears the map (clearPreferences).
 */

import { getClient } from "../glyphh-client";

let prefs: Record<string, unknown> | null = null;
// A distinct flag, NOT `prefs != null`: setPreference initializes `prefs` on an
// optimistic write, and that must not make the loader think the SERVER map is in
// (it would skip the fetch and lose every key the user didn't just set).
let loaded = false;
let loading: Promise<void> | null = null;

/** Fetch the server map once. Safe to call repeatedly; concurrent calls share
 *  one flight. Call after auth is ready (and again after user switch). */
export function loadPreferences(): Promise<void> {
  if (loaded) return Promise.resolve(); // server map is in — cheap no-op
  if (!loading) {
    loading = (async () => {
      try {
        const server = await getClient().profile.prefs();
        // Merge over any optimistic writes made before the load returned.
        prefs = { ...server, ...(prefs ?? {}) };
        loaded = true;
        console.log(`[prefs] loaded ${Object.keys(server).length} keys from server`);
      } catch (e) {
        // Do NOT cache the failure: a pre-auth/transient 401 must not stick an
        // empty map forever (that reads as "nothing persisted / starts new"). Clear
        // the flight so the NEXT read retries a fresh load.
        console.error("[prefs] load failed — will retry on next read:", (e as Error).message);
        loading = null;
      }
    })();
  }
  return loading ?? Promise.resolve();
}

/** Sign-out / user-switch: drop the map so the next user never reads it. */
export function clearPreferences(): void {
  prefs = null;
  loaded = false;
  loading = null;
}

/** Get a preference. Synchronous from the cached server map; its default
 *  before the first load or when signed out. */
export function getPreference<T = unknown>(key: string, defaultValue?: T): T {
  if (!prefs || !(key in prefs)) return defaultValue as T;
  return prefs[key] as T;
}

/** Set a preference: optimistic in the map, persisted to the server.
 *  `null`/`undefined` deletes the key (the server treats null as delete). */
export function setPreference(key: string, value: unknown): void {
  if (!prefs) prefs = {};
  if (value === null || value === undefined) delete prefs[key];
  else prefs[key] = value;
  void getClient()
    .profile.setPrefs({ [key]: value ?? null })
    .then(() => { console.log(`[prefs] persisted "${key}" =`, value); })
    .catch((e: unknown) => {
      console.error(`[prefs] persist failed for "${key}":`, (e as Error).message);
    });
}
