/**
 * user-zone.ts — ONE zone everywhere (his word, 2026-10-05): the clock every
 * schedule on this machine reads — the app scheduler's node-cron tasks and
 * the library's. auth.ts seeds it with this machine's zone at start, and a
 * move re-arms what is armed through the listeners. UTC until it is set, and
 * for a zone this runtime does not know. Pure: no Electron.
 */

/** True when `name` is a zone Intl knows (an IANA name, or "UTC"). */
export function isZone(name: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: name }); return true; } catch { return false; }
}

let zone = "UTC";
const listeners = new Set<(zone: string) => void>();

/** The zone every schedule here is armed on. */
export function userZone(): string { return zone; }

/** Take the profile's zone; answers whether it moved. Empty or unknown → UTC. */
export function setUserZone(name: string | null | undefined): boolean {
  const next = name && isZone(name) ? name : "UTC";
  if (next === zone) return false;
  zone = next;
  for (const fn of listeners) {
    try { fn(zone); } catch (err) { console.error("[zone] re-arm failed:", err instanceof Error ? err.message : err); }
  }
  return true;
}

/** Re-arm on a move; answers the unsubscribe. */
export function onUserZoneChange(fn: (zone: string) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
