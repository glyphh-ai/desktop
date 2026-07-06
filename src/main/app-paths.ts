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
