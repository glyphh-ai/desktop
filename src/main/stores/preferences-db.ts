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
let loading: Promise<void> | null = null;

/** Fetch the server map once. Safe to call repeatedly; concurrent calls share
 *  one flight. Call after auth is ready (and again after user switch). */
export function loadPreferences(): Promise<void> {
  if (!loading) {
    loading = (async () => {
      try {
        prefs = await getClient().profile.prefs();
      } catch (e) {
        // Boot on defaults rather than storming the API per read — the web
        // caches {} on a failed load for the same reason.
        console.error("[prefs] load failed — serving defaults:", (e as Error).message);
        prefs = prefs ?? {};
      }
    })();
  }
  return loading;
}

/** Sign-out / user-switch: drop the map so the next user never reads it. */
export function clearPreferences(): void {
  prefs = null;
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
    .catch((e: unknown) => {
      console.error(`[prefs] persist failed for "${key}":`, (e as Error).message);
    });
}
