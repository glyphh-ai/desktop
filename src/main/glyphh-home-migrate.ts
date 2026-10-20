/**
 * glyphh-home-migrate.ts — the ~/.glyphh directory rename (his ruling,
 * 2026-09-11: "rename agents to be loops ... then we restore agents").
 *
 * The vocabulary rotated one seat, so the storage has to rotate with it or
 * two different things end up sharing a name:
 *
 *   ~/.glyphh/loops/   held TASK SPECS (local-library called it a loop row;
 *                      the Tasks page rendered it) ──▶  ~/.glyphh/tasks/
 *   ~/.glyphh/agents/  held CLI PRE-CONFIGS (the page called them Agents;
 *                      they are what he calls Loops) ──▶ ~/.glyphh/loops/
 *   ~/.glyphh/agents/  freed for the REAL Agents — prompts + tasks.
 *
 * ORDER IS LOAD-BEARING: tasks vacate `loops/` before the CLI configs move
 * in. Each step is a plain rename, guarded so it only fires when the source
 * exists and the destination does not — running twice is a no-op, and a
 * half-finished run resumes cleanly on the next boot.
 *
 * Runs BEFORE any module reads its directory (main.ts, first thing).
 */

import fs from "fs";
import path from "path";
import { homedir } from "os";

const HOME = path.join(homedir(), ".glyphh");

/** Rename `from` → `to` when that is unambiguous. Returns what it did so the
 *  caller can log a real story instead of a guess. */
function moveDir(from: string, to: string): "moved" | "skipped" | "failed" {
  const src = path.join(HOME, from);
  const dst = path.join(HOME, to);
  // Destination already there = a previous run finished (or the user has
  // genuine data under the new name). Never merge — that would interleave
  // two vocabularies in one folder.
  if (!fs.existsSync(src) || fs.existsSync(dst)) return "skipped";
  try {
    fs.mkdirSync(HOME, { recursive: true });
    fs.renameSync(src, dst);
    return "moved";
  } catch (err) {
    // A failed move must not take the app down: the modules below create
    // their directories on demand, so the worst case is an empty surface
    // plus this line in the log.
    console.error(`[glyphh-home] could not move ${from}/ → ${to}/:`, err instanceof Error ? err.message : err);
    return "failed";
  }
}

export function migrateGlyphhHome(): void {
  if (!fs.existsSync(HOME)) return;          // fresh install — nothing to rotate
  const tasks = moveDir("loops", "tasks");   // FIRST: vacate loops/
  const loops = moveDir("agents", "loops");  // THEN: CLI configs take the name
  if (tasks === "moved" || loops === "moved") {
    console.log(`[glyphh-home] rotated storage — task specs: ${tasks}, CLI loops: ${loops}`);
  }
}
