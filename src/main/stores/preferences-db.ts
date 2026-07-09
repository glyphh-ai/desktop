/**
 * PreferencesDb — SQLite-backed key-value store for user preferences,
 * write-through to yo-server for roaming keys.
 *
 * The only preferences store: every main-process module and the renderer
 * (via settings-ipc) read and write through here. Reads stay local and
 * synchronous (the sqlite cache is the working copy); writes to ROAMING
 * keys queue a debounced push to /api/me/preferences, so a user's setup
 * (theme, agent mode/effort, escalation model, …) follows them to any
 * machine. DEVICE-LOCAL keys — window geometry, local model paths, ports,
 * local MCP secrets, session/tab state — never leave this machine.
 *
 * Sync contract (syncPreferencesFromServer, called after auth and on user
 * switch): push pending local edits FIRST (offline changes win over stale
 * server rows), then pull — server values overwrite local roaming keys —
 * then upload any local roaming keys the server has never seen (first
 * login from an existing install migrates itself).
 *
 * Backed by the local-db singleton (already per-user scoped); callers run
 * after initLocalDb().
 */

import { getLocalDb } from "../local-db";

// Machine-specific keys: geometry, local runtime paths/ports, local MCP
// config + bearer tokens, per-device toggles, and ephemeral session/tab
// state. Everything NOT listed roams by default. "__"-prefixed keys are
// store-internal and never sync either.
const DEVICE_LOCAL = new Set([
  "windowBounds", "filesRailWidth", "codeRailWidth", "codeRailCollapsed",
  "codeRecentsH", "codeRecentsOpen",
  "williamBaseUrl", "williamModel", "williamModelPath", "williamServerBin",
  "localMcpEnabled", "localMcpPort", "localMcpTokens",
  "mcpServers", "mcpToolOverrides",
  "openTabs", "browserTabUrls", "panelFavicons", "suspendedLayout",
  "recents", "lastView", "homeLastSection", "homeLastSub",
  "defaultBrowser", "autoUpdate", "relayEnabled",
  // Legacy purged secret — must never round-trip through the prefs API.
  "anthropicApiKey",
]);

const PENDING_KEY = "__pendingSync";
const PUSH_DEBOUNCE_MS = 1500;

const isRoaming = (key: string) => !key.startsWith("__") && !DEVICE_LOCAL.has(key);

// ── Public API ─────────────────────────────────────────────

/**
 * Get a preference value by key. Returns `defaultValue` if not found.
 */
export function getPreference<T = unknown>(key: string, defaultValue?: T): T {
  // Resilient by contract: IPC handlers race boot (before initLocalDb) and
  // quit (after close) — a preference read answers its default instead of
  // throwing through the handler.
  let db;
  try { db = getLocalDb(); } catch { return defaultValue as T; }
  const row = db.prepare(
    "SELECT value FROM preferences WHERE key = ?"
  ).get(key) as { value: string } | undefined;
  if (!row) return defaultValue as T;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return row.value as unknown as T;
  }
}

/**
 * Set a preference value. Serializes to JSON. Roaming keys also queue a
 * debounced write-through to the server.
 */
export function setPreference(key: string, value: unknown): void {
  rawSet(key, value);
  if (isRoaming(key)) queuePush(key);
}

// ── Server write-through ───────────────────────────────────

/** Local write only — used by the pull path so applying server state never
 *  re-queues a push of what we just received. */
function rawSet(key: string, value: unknown): void {
  const db = getLocalDb();
  db.prepare(
    "INSERT OR REPLACE INTO preferences (key, value) VALUES (?, ?)"
  ).run(key, JSON.stringify(value));
}

// Pending = roaming keys with local edits the server hasn't confirmed.
// Persisted under a reserved key so edits made offline survive a restart
// and win over the server copy on the next sync.
function pendingKeys(): Set<string> {
  return new Set(getPreference<string[]>(PENDING_KEY, []) ?? []);
}
function setPendingKeys(keys: Set<string>): void {
  rawSet(PENDING_KEY, [...keys]);
}

let pushTimer: NodeJS.Timeout | null = null;

function queuePush(key: string): void {
  const pending = pendingKeys();
  pending.add(key);
  setPendingKeys(pending);
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { pushTimer = null; void flushPending(); }, PUSH_DEBOUNCE_MS);
}

/** Push every pending key's CURRENT local value. Failures keep the keys
 *  pending — the next set or sync retries; prefs are never lost locally. */
async function flushPending(): Promise<void> {
  const pending = pendingKeys();
  if (!pending.size) return;
  const prefs: Record<string, unknown> = {};
  for (const k of pending) prefs[k] = getPreference(k, null);
  try {
    const { serverPutAuthed } = await import("../auth");
    const r = await serverPutAuthed<{ ok: boolean }>("/api/me/preferences", { prefs });
    if (r.ok) {
      // Only clear what we sent — keys edited DURING the flight stay pending.
      const now = pendingKeys();
      for (const k of pending) now.delete(k);
      setPendingKeys(now);
    }
  } catch { /* offline / signed out — retry on next set or sync */ }
}

/**
 * Full reconcile with the server — call after auth lands and on user
 * switch. Push-first so offline edits beat stale server rows; then the
 * server is truth for every roaming key; then first-sync upload of local
 * keys the server has never seen.
 */
export async function syncPreferencesFromServer(): Promise<void> {
  try { getLocalDb(); } catch { return; } // store not up (early boot) — next call wins
  await flushPending();
  let server: Record<string, unknown>;
  try {
    const { serverGetAuthed } = await import("../auth");
    const r = await serverGetAuthed<{ ok: boolean; prefs?: Record<string, unknown> }>("/api/me/preferences");
    if (!r.ok) return;
    server = r.prefs ?? {};
  } catch { return; } // offline / signed out — local cache stands
  for (const [key, value] of Object.entries(server)) {
    if (isRoaming(key)) rawSet(key, value);
  }
  // Roaming keys this install has that the server doesn't — first login
  // from an existing machine seeds the server copy.
  const db = getLocalDb();
  const rows = db.prepare("SELECT key FROM preferences").all() as Array<{ key: string }>;
  const missing = rows.map((r) => r.key).filter((k) => isRoaming(k) && !(k in server));
  if (missing.length) {
    const pending = pendingKeys();
    for (const k of missing) pending.add(k);
    setPendingKeys(pending);
    await flushPending();
  }
}
