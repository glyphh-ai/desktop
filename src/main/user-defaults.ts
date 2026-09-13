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
      { panelId: "rail", col: 0, row: 0, colSpan: 1, rowSpan: 1 },
      { panelId: "glyphh", col: 1, row: 0, colSpan: 1, rowSpan: 1, sticky: true },
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
      { panelId: "rail", col: 0, row: 0, colSpan: 1, rowSpan: 2 },
      { panelId: "files", col: 1, row: 0, colSpan: 1, rowSpan: 1 },
      { panelId: "diff", col: 1, row: 1, colSpan: 1, rowSpan: 1 },
      { panelId: "editor", col: 2, row: 0, colSpan: 1, rowSpan: 1, sticky: true },
      { panelId: "terminal", col: 2, row: 1, colSpan: 1, rowSpan: 1 },
      { panelId: "glyphh", col: 3, row: 0, colSpan: 1, rowSpan: 2 },
    ],
  };
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
    const made = [vibe(), dev()].filter(ensure).length;
    if (made) console.info("[user-defaults] provisioned", made, "workspace(s)");
  } catch (err) {
    // A failure here must never block sign-in — the user simply lands with no
    // workspaces and can build their own.
    console.warn("[user-defaults] provisioning failed:", err instanceof Error ? err.message : err);
  }
}
