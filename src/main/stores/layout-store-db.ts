/**
 * LayoutStoreDb — SQLite-backed CRUD for saved grid layouts.
 *
 * Replaces the JSON file persistence in LayoutManager.
 * The LayoutManager itself still manages runtime grid state (activeGrid,
 * suspendedGrid, panel positioning) — this module only handles the
 * persisted library of saved layouts.
 */

import { getLocalDb } from "../local-db";
import type { GridLayout } from "../layout-manager";

// ── Row shape from SQLite ──────────────────────────────────

interface LayoutRow {
  name: string;
  layout_json: string;
  updated_at: string;
}

// ── Public API ─────────────────────────────────────────────

/**
 * List all saved layouts.
 */
export function listLayouts(): GridLayout[] {
  const db = getLocalDb();
  const rows = db.prepare(
    "SELECT * FROM layouts ORDER BY name COLLATE NOCASE"
  ).all() as LayoutRow[];
  return rows.map((r) => JSON.parse(r.layout_json) as GridLayout);
}

/**
 * Get a layout by name.
 */
export function getLayout(name: string): GridLayout | undefined {
  const db = getLocalDb();
  const row = db.prepare("SELECT * FROM layouts WHERE name = ?").get(name) as LayoutRow | undefined;
  if (!row) return undefined;
  return JSON.parse(row.layout_json) as GridLayout;
}

/**
 * Save (insert or update) a layout.
 */
export function saveLayout(grid: GridLayout): void {
  const db = getLocalDb();
  db.prepare(`
    INSERT OR REPLACE INTO layouts (name, type, layout_json, updated_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(grid.name, "standard", JSON.stringify(grid));
}

/**
 * Delete a layout by name.
 */
export function deleteLayout(name: string): boolean {
  const db = getLocalDb();
  const result = db.prepare("DELETE FROM layouts WHERE name = ?").run(name);
  return result.changes > 0;
}

/**
 * Check if a layout exists by name.
 */
export function hasLayout(name: string): boolean {
  const db = getLocalDb();
  const row = db.prepare("SELECT 1 FROM layouts WHERE name = ?").get(name);
  return !!row;
}
