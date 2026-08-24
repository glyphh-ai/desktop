/**
 * MigrateFromFiles — one-time migration from file-based stores to SQLite.
 *
 * Reads existing:
 *   ~/.glyphh/.layouts        → layouts table
 *   ~/.glyphh/.preferences    → preferences table
 *
 * Two passes, each gated by its own sentinel so it runs once:
 *
 *   v1 (.migrated-to-db)    — full copy of both files at the SQLite cutover.
 *   v2 (.migrated-to-db-v2) — re-copies the keys that stayed JSON-authoritative
 *     after v1: working-directory, home-ipc, local-mcp-server, and mcp-manager
 *     kept writing the legacy file store until they were repointed to
 *     preferences-db, so for those keys the JSON file holds writes v1 never
 *     saw. Keys whose writers were already on SQLite by then (theme, agentMode,
 *     relayEnabled, and zoom/lastView via settings-ipc and main.ts) are
 *     deliberately NOT re-copied — their JSON values are stale and copying
 *     them would resurrect old state.
 *
 * Does NOT delete old files.
 */

import fs from "fs";
import path from "path";
import { saveLayout } from "./layout-store-db";
import { setPreference } from "./preferences-db";
import type { GridLayout } from "../layout-manager";
import { GLYPHH_DIR } from "../app-paths.js";

const LAYOUTS_FILE = path.join(GLYPHH_DIR, ".layouts");
const PREFS_FILE = path.join(GLYPHH_DIR, ".preferences");
const SENTINEL = path.join(GLYPHH_DIR, ".migrated-to-db");
const SENTINEL_V2 = path.join(GLYPHH_DIR, ".migrated-to-db-v2");

/** Keys still being written to ~/.glyphh/.preferences after the v1 cutover. */
const V2_STRANDED_KEYS = [
  // working-directory.ts
  "workingDirectory",
  "workingDirDefault",
  "workingDirRecents",
  "recents",
  // home-ipc.ts + local-mcp-server.ts
  "localMcpEnabled",
  "localMcpPort",
  "localMcpTokens",
  // mcp-manager.ts
  "mcpServers",
  "mcpToolOverrides",
];

/**
 * Run the one-time file-to-db migrations. Safe to call on every boot —
 * each pass returns immediately once its sentinel exists.
 */
export function migrateFromFiles(): { migrated: boolean; layouts: number; prefs: number; prefsV2: number } {
  const v1 = migrateV1();
  const v2 = migrateStrandedPrefs();
  return { migrated: v1.ran || v2.ran, layouts: v1.layouts, prefs: v1.prefs, prefsV2: v2.prefs };
}

function migrateV1(): { ran: boolean; layouts: number; prefs: number } {
  if (fs.existsSync(SENTINEL)) {
    return { ran: false, layouts: 0, prefs: 0 };
  }

  let layoutCount = 0;
  let prefCount = 0;

  // ── Migrate layouts ──────────────────────────────────────
  try {
    if (fs.existsSync(LAYOUTS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(LAYOUTS_FILE, "utf-8")) as unknown[];
      for (const item of raw) {
        try {
          const obj = item as Record<string, unknown>;
          let grid: GridLayout;
          if (obj.version === 2) {
            grid = obj as unknown as GridLayout;
          } else {
            // Legacy format: convert splits to grid
            const legacy = obj as { name: string; splits: Array<{ panelId: string; width: number }> };
            const n = legacy.splits.length;
            grid = {
              name: legacy.name,
              version: 2,
              cols: n,
              rows: 1,
              colWidths: legacy.splits.map((s) => s.width),
              rowHeights: [1],
              cells: legacy.splits.map((s, i) => ({
                panelId: s.panelId,
                col: i,
                row: 0,
                colSpan: 1,
                rowSpan: 1,
              })),
            };
          }
          if (grid.name) {
            saveLayout(grid);
            layoutCount++;
          }
        } catch {
          // Skip malformed layout entries
        }
      }
    }
  } catch {
    // .layouts doesn't exist or isn't readable — skip
  }

  // ── Migrate preferences ──────────────────────────────────
  try {
    if (fs.existsSync(PREFS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(PREFS_FILE, "utf-8")) as Record<string, unknown>;
      for (const [key, value] of Object.entries(raw)) {
        try {
          setPreference(key, value);
          prefCount++;
        } catch {
          // Skip individual preference errors
        }
      }
    }
  } catch {
    // .preferences doesn't exist or isn't readable — skip
  }

  // ── Write sentinel ───────────────────────────────────────
  try {
    fs.mkdirSync(GLYPHH_DIR, { recursive: true });
    fs.writeFileSync(SENTINEL, JSON.stringify({
      migratedAt: new Date().toISOString(),
      layouts: layoutCount,
      preferences: prefCount,
    }, null, 2), "utf-8");
  } catch {
    // Non-critical — migration will re-run next boot but that's safe (INSERT OR REPLACE)
  }

  return { ran: true, layouts: layoutCount, prefs: prefCount };
}

function migrateStrandedPrefs(): { ran: boolean; prefs: number } {
  if (fs.existsSync(SENTINEL_V2)) {
    return { ran: false, prefs: 0 };
  }

  let prefCount = 0;

  try {
    if (fs.existsSync(PREFS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(PREFS_FILE, "utf-8")) as Record<string, unknown>;
      for (const key of V2_STRANDED_KEYS) {
        if (!(key in raw)) continue;
        try {
          setPreference(key, raw[key]);
          prefCount++;
        } catch {
          // Skip individual preference errors
        }
      }
    }
  } catch {
    // .preferences doesn't exist or isn't readable — skip
  }

  try {
    fs.mkdirSync(GLYPHH_DIR, { recursive: true });
    fs.writeFileSync(SENTINEL_V2, JSON.stringify({
      migratedAt: new Date().toISOString(),
      preferences: prefCount,
    }, null, 2), "utf-8");
  } catch {
    // Non-critical — migration will re-run next boot but that's safe (INSERT OR REPLACE)
  }

  return { ran: true, prefs: prefCount };
}
