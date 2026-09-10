/**
 * workspace-state.ts — the workbench's drag/panel state, ON DISK
 * (THE PURGE, 2026-09-10 — replacing the 32KB server pref):
 *
 *   ~/.glyphh/workspaces/<id>/state.json   — a workspace's arrangement
 *   ~/.glyphh/workspaces/_global.json      — everything not tied to one
 *
 * The renderer (help/ui-state.ts) keeps its synchronous key→string map and
 * flushes the whole snapshot here (debounced); this module shards entries by
 * the workspace their key names and writes one JSON file per shard. Keys
 * look like `workbench:namedlayout:<name>[:…]`, `workbench:layoutsession:
 * <name>[:…]`, `echo:layout:<name>[:…]` — everything else is global.
 */

import fs from "fs";
import path from "path";
import { ipcMain } from "electron";
import { WORKSPACES_DIR, workspaceId } from "./layout-manager.js";

interface Entry { v: string; at: number }
type Snapshot = Record<string, Entry>;

const GLOBAL_FILE = path.join(WORKSPACES_DIR, "_global.json");

const WS_KEY_RE = /^(?:workbench:namedlayout|workbench:layoutsession|echo:layout):([^:]+)/;

/** Which file an entry lives in: the named workspace's, or the global one. */
function shardOf(key: string): string {
  const ws = WS_KEY_RE.exec(key)?.[1];
  return ws ? path.join(WORKSPACES_DIR, workspaceId(ws), "state.json") : GLOBAL_FILE;
}

function readShard(file: string): Snapshot {
  try {
    const map = JSON.parse(fs.readFileSync(file, "utf-8")) as Snapshot;
    return map && typeof map === "object" ? map : {};
  } catch {
    return {};
  }
}

function writeShard(file: string, snap: Snapshot): void {
  try {
    if (Object.keys(snap).length === 0) { fs.rmSync(file, { force: true }); return; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(snap, null, 2), "utf-8");
    fs.renameSync(`${file}.tmp`, file);
  } catch (err) {
    console.error("[wsstate] failed to write", file, err instanceof Error ? err.message : err);
  }
}

/** Every state entry on disk, merged back into one map for the renderer. */
export function loadWorkspaceState(): Snapshot {
  const merged: Snapshot = {};
  const files: string[] = [GLOBAL_FILE];
  try {
    for (const id of fs.readdirSync(WORKSPACES_DIR)) files.push(path.join(WORKSPACES_DIR, id, "state.json"));
  } catch { /* no workspaces yet */ }
  for (const f of files) Object.assign(merged, readShard(f));
  return merged;
}

/** Persist the renderer's full snapshot, sharded per workspace. A shard the
 *  snapshot no longer names any keys for is emptied (its file removed). */
export function saveWorkspaceState(snapshot: Snapshot): void {
  const shards = new Map<string, Snapshot>();
  for (const [key, entry] of Object.entries(snapshot)) {
    if (!entry || typeof entry.v !== "string") continue;
    const file = shardOf(key);
    const shard = shards.get(file) ?? {};
    shard[key] = { v: entry.v, at: Number(entry.at) || 0 };
    shards.set(file, shard);
  }
  // Existing shard files that lost all their keys get cleaned up too.
  const known = new Set(shards.keys());
  const existing: string[] = [GLOBAL_FILE];
  try {
    for (const id of fs.readdirSync(WORKSPACES_DIR)) existing.push(path.join(WORKSPACES_DIR, id, "state.json"));
  } catch { /* none */ }
  for (const f of existing) if (!known.has(f) && fs.existsSync(f)) writeShard(f, {});
  for (const [file, shard] of shards) writeShard(file, shard);
}

export function registerWorkspaceStateIpc(): void {
  ipcMain.handle("wsstate-load", () => loadWorkspaceState());
  ipcMain.handle("wsstate-save", (_e, snapshot: unknown) => {
    if (snapshot && typeof snapshot === "object") saveWorkspaceState(snapshot as Snapshot);
    return true;
  });
}
