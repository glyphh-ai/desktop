/**
 * user-scope — makes the client respect the authenticated user.
 *
 * All per-user local state (user-state.sqlite, Glyphh chats) resolves under
 * ~/.glyphh/users/<userId>/ (see app-paths.ts). This module owns the SWITCH:
 * when auth learns who the user is — boot restore, login, or a login as a
 * DIFFERENT account — it closes the per-user stores, flips the scope, clears
 * every in-memory cache that could carry the previous user's data, and
 * reloads the window so no renderer state survives the change.
 *
 * Legacy adoption: the first real login on a machine claims the pre-scoping
 * machine-global files (they were that user's data — this is the upgrade
 * path, not a leak). Every LATER account starts clean; that's the point.
 */

import fs from "fs";
import path from "path";
import { app } from "electron";
import { GLYPHH_DIR, getActiveUserId, setActiveUserIdState, userScopedDir } from "./app-paths";
import { initLocalDb, closeLocalDb } from "./local-db";
import { appCache } from "./glyphh-client";
import { installDefaultHubItems } from "./hub-ipc.js";
import { provisionUserDefaults } from "./user-defaults.js";

// main.ts registers how to reload the UI (it owns the BrowserWindow).
let reloadWindow: (() => void) | null = null;
export function setUserScopeReloader(fn: () => void): void {
  reloadWindow = fn;
}

// Main-process singletons that hold per-user state in MEMORY (LayoutManager,
// AppConnector, ConnectorManager, …) register a reset here — closing the
// SQLite file and reloading the renderer is NOT enough, the maps live in
// main and would keep serving the previous account forever.
const userChangeResets: Array<() => void> = [];
export function onUserChange(fn: () => void): void {
  userChangeResets.push(fn);
}

/** One-time: the first signed-in user adopts the legacy machine-global state
 *  (pre-scoping ~/.glyphh/user-state.sqlite + userData/glyphh). Marker file
 *  guarantees later accounts start clean instead of inheriting it too. */
function adoptLegacyState(userDir: string): void {
  try {
    const marker = path.join(GLYPHH_DIR, "users", ".legacy-adopted");
    if (fs.existsSync(marker)) return;
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });

    const legacyDb = path.join(GLYPHH_DIR, "user-state.sqlite");
    for (const suffix of ["", "-wal", "-shm"]) {
      const src = legacyDb + suffix;
      try {
        if (fs.existsSync(src)) fs.renameSync(src, path.join(userDir, `user-state.sqlite${suffix}`));
      } catch { /* per-file best-effort */ }
    }

    // Layout cache + local app registry were machine-global too.
    for (const name of [".layouts", "apps"]) {
      try {
        const src = path.join(GLYPHH_DIR, name);
        const dest = path.join(userDir, name);
        if (fs.existsSync(src) && !fs.existsSync(dest)) fs.renameSync(src, dest);
      } catch { /* per-entry best-effort */ }
    }

    try {
      const legacyGlyphh = path.join(app.getPath("userData"), "glyphh");
      const dest = path.join(userDir, "glyphh");
      if (fs.existsSync(legacyGlyphh) && !fs.existsSync(dest)) fs.renameSync(legacyGlyphh, dest);
    } catch { /* cross-volume rename can fail — old chats just aren't adopted */ }

    fs.writeFileSync(marker, new Date().toISOString());
  } catch { /* best-effort — a fresh scoped dir is created on demand */ }
}

/**
 * Point every per-user store at `userId` (null = signed out). No-op when the
 * user is unchanged. Safe to call from any auth event — it is the ONE choke
 * point for identity changes on this machine.
 */
export function setActiveUser(userId: string | null): void {
  const prev = getActiveUserId();
  if (prev === userId) return;

  // Close the open per-user stores BEFORE moving/re-pointing files.
  closeLocalDb();

  if (userId) adoptLegacyState(path.join(GLYPHH_DIR, "users", userId));
  setActiveUserIdState(userId);

  // Reopen stores under the new scope and drop every cross-user cache.
  fs.mkdirSync(userScopedDir(), { recursive: true });
  // A NEW account is never empty: workspaces are local, so the desktop
  // provisions its own defaults here — the first moment the scope is known.
  if (userId) { provisionUserDefaults(); void installDefaultHubItems(); }
  initLocalDb();
  appCache.invalidate();

  // Reset every main-process singleton holding per-user state in memory.
  for (const reset of userChangeResets) {
    try { reset(); } catch (err) { console.error("[user-scope] reset failed:", err); }
  }

  // A user CHANGE mid-run (not the boot-time first set) reloads the renderer
  // so no DOM/JS state from the previous account survives.
  if (prev !== null && reloadWindow) reloadWindow();
}
