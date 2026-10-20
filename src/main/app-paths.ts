/**
 * app-paths — the single source of truth for Glyphh's local data directory.
 *
 * All user state lives under ~/.glyphh (formerly ~/yo, from the yosup era).
 * Every module that needs a data path imports GLYPHH_DIR / glyphhPath() from
 * here, so the location is defined in exactly one place.
 *
 * The one-time rename from the legacy ~/yo directory runs at module load (as an
 * import side effect) rather than from a startup function: ES module imports
 * resolve before any importer's top-level code or class construction runs, so
 * the move always lands before the first module creates or reads the data dir.
 */

import os from "os";
import path from "path";
import fs from "fs";

/** Root of all Glyphh desktop app data: ~/.glyphh */
export const GLYPHH_DIR = path.join(os.homedir(), ".glyphh");

/** Legacy pre-Glyphh location (yosup era). */
const LEGACY_DIR = path.join(os.homedir(), "yo");

/** Join path segments under the Glyphh data dir. */
export function glyphhPath(...segments: string[]): string {
  return path.join(GLYPHH_DIR, ...segments);
}

// ── Per-user scoping ─────────────────────────────────────────
//
// The client respects the authenticated user: everything user-owned
// (user-state.sqlite, Glyphh chats, …) resolves under
// ~/.glyphh/users/<userId>/ once a session is known, so two accounts on one
// machine can never see each other's local state. Before auth resolves,
// scoped paths fall back to the legacy machine-global locations — the first
// real login ADOPTS those files (they were that user's) via user-scope.ts.
//
// State lives here (the import root — nothing imports into app-paths) so
// local-db / glyphh-context / user-scope can all read it without cycles.

/** The one user on this machine (there is no server to sign in to): the
 *  desktop scopes to it at boot (auth.ts) and the `glyphh` terminal agent
 *  does the same, so both read and write ~/.glyphh/users/local. */
export const LOCAL_USER_ID = "local";

let activeUserId: string | null = null;

/** State-only setter — orchestration (closing stores, cache flushes, window
 *  reload) lives in user-scope.ts's setActiveUser(). */
export function setActiveUserIdState(id: string | null): void {
  activeUserId = id;
}

export function getActiveUserId(): string | null {
  return activeUserId;
}

/** This user's private data dir (~/.glyphh/users/<id>), or GLYPHH_DIR when no
 *  session is known yet (pre-auth boot — legacy behavior). */
export function userScopedDir(): string {
  return activeUserId ? path.join(GLYPHH_DIR, "users", activeUserId) : GLYPHH_DIR;
}

/** Join segments under the ACTIVE USER's data dir. */
export function userScopedPath(...segments: string[]): string {
  return path.join(userScopedDir(), ...segments);
}

/**
 * Move ~/yo → ~/.glyphh once, in place. Guarded so it only fires when the
 * legacy dir exists and the new one does not (never clobbers newer data), and
 * never throws — a failed migration just falls through to a fresh ~/.glyphh
 * created on demand. Idempotent and safe to run from any process.
 */
export function migrateLegacyDataDir(): void {
  try {
    if (
      LEGACY_DIR !== GLYPHH_DIR &&
      fs.existsSync(LEGACY_DIR) &&
      !fs.existsSync(GLYPHH_DIR)
    ) {
      fs.renameSync(LEGACY_DIR, GLYPHH_DIR);
    }
  } catch {
    /* best-effort — a fresh ~/.glyphh is created when first written */
  }
}

// Run at import so the rename lands before any data path is created or read.
migrateLegacyDataDir();
