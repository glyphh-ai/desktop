/**
 * MigrateFromFiles — one-time migration from file-based stores to SQLite.
 *
 * Reads existing:
 *   ~/yo/.layouts        → layouts table
 *   ~/yo/.preferences    → preferences table
 *
 * Writes sentinel ~/yo/.migrated-to-db on success so it only runs once.
 * Does NOT delete old files.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { saveLayout } from "./layout-store-db";
import { setPreference } from "./preferences-db";
import type { GridLayout } from "../layout-manager";

const YO_DIR = path.join(os.homedir(), "yo");
const LAYOUTS_FILE = path.join(YO_DIR, ".layouts");
const PREFS_FILE = path.join(YO_DIR, ".preferences");
const SENTINEL = path.join(YO_DIR, ".migrated-to-db");

/**
 * Run the one-time file-to-db migration. Safe to call on every boot —
 * returns immediately if already migrated.
 */
export function migrateFromFiles(): { migrated: boolean; layouts: number; prefs: number } {
  if (fs.existsSync(SENTINEL)) {
    return { migrated: false, layouts: 0, prefs: 0 };
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
    fs.mkdirSync(YO_DIR, { recursive: true });
    fs.writeFileSync(SENTINEL, JSON.stringify({
      migratedAt: new Date().toISOString(),
      layouts: layoutCount,
      preferences: prefCount,
    }, null, 2), "utf-8");
  } catch {
    // Non-critical — migration will re-run next boot but that's safe (INSERT OR REPLACE)
  }

  return { migrated: true, layouts: layoutCount, prefs: prefCount };
}
