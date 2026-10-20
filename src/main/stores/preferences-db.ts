/**
 * Preferences — a local JSON map at ~/.glyphh/users/<user>/preferences.json,
 * cached in memory.
 *
 * Semantics the shared renderer relies on:
 *   - loaded once per user (loadPreferences, called after auth);
 *   - reads are synchronous from the in-memory map (main-process callers like
 *     screen-layout's railWidth() are sync by contract) — before the first
 *     load a read answers its default, never throws;
 *   - writes update the map, then persist the whole file atomically;
 *   - a user switch clears the map (clearPreferences).
 */

import fs from "fs";
import path from "path";
import { userScopedPath } from "../app-paths";

let prefs: Record<string, unknown> | null = null;
let loaded = false;

const file = (): string => userScopedPath("preferences.json");

function readFile(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file(), "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeFile(map: Record<string, unknown>): void {
  const target = file();
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch (e) {
    console.error("[prefs] persist failed:", (e as Error).message);
    try { fs.unlinkSync(tmp); } catch { /* never written */ }
  }
}

/** Read the file once. Safe to call repeatedly. */
export function loadPreferences(): Promise<void> {
  if (!loaded) {
    // Merge over any writes made before the load.
    prefs = { ...readFile(), ...(prefs ?? {}) };
    loaded = true;
  }
  return Promise.resolve();
}

/** User switch: drop the map so the next user never reads it. */
export function clearPreferences(): void {
  prefs = null;
  loaded = false;
}

/** Get a preference: its default before the first load or when unset. */
export function getPreference<T = unknown>(key: string, defaultValue?: T): T {
  if (!prefs || !(key in prefs)) return defaultValue as T;
  return prefs[key] as T;
}

/** Every loaded preference under a key prefix, keyed without the prefix. */
export function preferencesByPrefix<T = unknown>(prefix: string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(prefs ?? {})) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v as T;
  return out;
}

/** Set a preference and persist it. `null`/`undefined` deletes the key. */
export function setPreference(key: string, value: unknown): void {
  if (!loaded) void loadPreferences();
  if (!prefs) prefs = {};
  if (value === null || value === undefined) delete prefs[key];
  else prefs[key] = value;
  writeFile(prefs);
}
