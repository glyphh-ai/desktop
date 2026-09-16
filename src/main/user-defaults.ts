/**
 * user-defaults.ts — what a BRAND-NEW account finds waiting for it.
 *
 * Workspaces are LOCAL (his ruling, 2026-09-12: "that likely needs to all
 * happen on the app now and not the server… none of it lives on the server"),
 * so provisioning is the desktop's job, not an org-creation seed. It runs from
 * user-scope's setActiveUser once the scoped dir is known — never at boot,
 * where the active user is not resolved yet and the files would land in the
 * machine-global fallback.
 *
 * Idempotent and non-destructive: a workspace the user already has — even one
 * they renamed to the same id and emptied — is left exactly as it is. This
 * only ever fills an absence.
 *
 * The two defaults are his spec (2026-09-12):
 *   vibe — Rail | Glyphh.
 *   dev  — Rail (full height) | files over diff | editor over terminal |
 *          Glyphh (full height), with the EDITOR pinned.
 */

import fs from "fs";
import path from "path";
import { WORKSPACES_DIR, workspaceId, type GridLayout } from "./layout-manager.js";

// Cell panelIds use the OPENER'S vocabulary (code-workbench layout cells):
// built-in panels are "tool:<view>" and the agent surface is "tool:coding".
// The first seed wrote bare names ("rail", "glyphh") that resolve as app
// rows and die — every default workspace opened EMPTY (his log, 2026-09-14).

/** Rail | Glyphh — the everyday two-panel arrangement. */
function vibe(): GridLayout {
  return {
    name: "Vibe",
    version: 2,
    cols: 2,
    rows: 1,
    colWidths: [0.22, 0.78],
    rowHeights: [1],
    cells: [
      { panelId: "tool:rail", col: 0, row: 0, colSpan: 1, rowSpan: 1 },
      { panelId: "tool:coding", col: 1, row: 0, colSpan: 1, rowSpan: 1, sticky: true },
    ],
  };
}

/**
 * Rail | files/diff | editor/terminal | Glyphh — four columns, two rows, with
 * the rail and the agent spanning full height and the EDITOR as the pinned
 * (sticky) cell.
 */
function dev(): GridLayout {
  return {
    name: "Dev",
    version: 2,
    cols: 4,
    rows: 2,
    colWidths: [0.16, 0.2, 0.36, 0.28],
    rowHeights: [0.5, 0.5],
    cells: [
      { panelId: "tool:rail", col: 0, row: 0, colSpan: 1, rowSpan: 2 },
      { panelId: "tool:files", col: 1, row: 0, colSpan: 1, rowSpan: 1 },
      { panelId: "tool:diff", col: 1, row: 1, colSpan: 1, rowSpan: 1 },
      { panelId: "tool:monaco", col: 2, row: 0, colSpan: 1, rowSpan: 1, sticky: true },
      { panelId: "tool:terminal", col: 2, row: 1, colSpan: 1, rowSpan: 1 },
      { panelId: "tool:coding", col: 3, row: 0, colSpan: 1, rowSpan: 2 },
    ],
  };
}

// The first seed's bare panelIds → the opener's canonical ids. Only these
// exact names are touched: they can only have come from that seed (the
// editor and starter templates always wrote tool:/app ids), and desktop-
// target layouts are skipped — their cells name native apps.
const SEED_ID_FIX: Record<string, string> = {
  rail: "tool:rail",
  files: "tool:files",
  diff: "tool:diff",
  editor: "tool:monaco",
  terminal: "tool:terminal",
  glyphh: "tool:coding",
};

/** Rewrite bare seeded panelIds in existing workspace files (idempotent). */
function repairSeededIds(): void {
  let ids: string[] = [];
  try { ids = fs.readdirSync(WORKSPACES_DIR()); } catch { return; }
  for (const id of ids) {
    const file = path.join(WORKSPACES_DIR(), id, "workspace.json");
    try {
      const grid = JSON.parse(fs.readFileSync(file, "utf-8")) as GridLayout;
      if (!Array.isArray(grid.cells) || grid.target === "desktop") continue;
      let changed = false;
      for (const c of grid.cells) {
        const fix = SEED_ID_FIX[(c.panelId || "").trim().toLowerCase()];
        if (fix) { c.panelId = fix; changed = true; }
      }
      if (changed) {
        fs.writeFileSync(file, JSON.stringify(grid, null, 2), "utf-8");
        console.info("[user-defaults] repaired seeded panel ids in", id);
      }
    } catch { /* not a workspace folder — skip */ }
  }
}

/** Write one workspace if the user doesn't already have that id. */
function ensure(grid: GridLayout): boolean {
  const dir = path.join(WORKSPACES_DIR(), workspaceId(grid.name));
  const file = path.join(dir, "workspace.json");
  if (fs.existsSync(file)) return false;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(grid, null, 2), "utf-8");
  return true;
}

/**
 * Fill in anything a fresh account is missing. Safe to call on every sign-in:
 * it writes only what is absent, so a user who deleted a default keeps it
 * deleted for the session and gets it back on the next — which is the honest
 * trade for "a new account is never empty".
 */
export function provisionUserDefaults(): void {
  try {
    fs.mkdirSync(WORKSPACES_DIR(), { recursive: true });
    repairSeededIds();
    const made = [vibe(), dev()].filter(ensure).length;
    if (made) console.info("[user-defaults] provisioned", made, "workspace(s)");
  } catch (err) {
    // A failure here must never block sign-in — the user simply lands with no
    // workspaces and can build their own.
    console.warn("[user-defaults] provisioning failed:", err instanceof Error ? err.message : err);
  }
}
