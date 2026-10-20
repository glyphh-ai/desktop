/**
 * member-library-local.ts — THE MEMBER LIBRARY, ON THIS MACHINE.
 *
 * The records the app once kept in the server's member library live here,
 * one folder per record under the local user's home:
 *
 *   <user>/library/<kind>/<id>/record.json    { id, updatedAt, data, files }
 *   <user>/library/<kind>/<id>/files/<path>   the record's bytes
 *
 * Two kinds of reader share it: the workspace, tab and agent stores
 * (layout-manager.ts, apps-store.ts, local-agents.ts) through the synchronous
 * rows below, and the house apps (house-store.ts: designs, decks, media,
 * files and folders) through `localLibrary` + `localLibraryBytes`, the
 * HouseLib / HouseBytes shapes shared/house-store.ts is written over.
 *
 * Clocks: a record carries its writer's clock (epoch ms) and a put lands only
 * when its clock is newer than the stored one — the rule the writers were
 * built around. A delete removes the folder. Nothing here touches Electron.
 */

import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { userScopedPath } from "./app-paths.js";
import type { HouseBytes, HouseFile, HouseItem, HouseLib, HouseListed } from "../shared/house-store.js";

/** The record file of one library item. */
interface StoredRecord<T = unknown> { id: string; updatedAt: number; data: T; files: HouseFile[] }

/** A library row as the stores read it. */
export interface LibraryRow<T> { id: string; updatedAt: number; data: T }

const KIND_RE = /^[a-z][a-z0-9-]{0,31}$/;
const ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;

/** "Not found", in the shape shared/house-store.ts recognises. */
class LibraryNotFound extends Error {
  readonly httpStatus = 404;
  readonly code = "not_found";
  constructor(kind: string, id: string) { super(`${kind} "${id}" not found`); }
}

function kindDir(kind: string): string {
  if (!KIND_RE.test(kind)) throw new Error(`bad library kind: ${kind}`);
  return userScopedPath("library", kind);
}

function itemDir(kind: string, id: string): string {
  if (!ID_RE.test(id) || id === "." || id === "..") throw new Error(`bad library id: ${id}`);
  return path.join(kindDir(kind), id);
}

/** A file inside an item's files folder — never outside it. */
function fileOf(kind: string, id: string, rel: string): string {
  const root = path.join(itemDir(kind, id), "files");
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) throw new Error(`bad library path: ${rel}`);
  return full;
}

function readRecord<T>(kind: string, id: string): StoredRecord<T> | null {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(itemDir(kind, id), "record.json"), "utf-8")) as StoredRecord<T>;
    return r && typeof r === "object" && r.id === id ? { ...r, files: Array.isArray(r.files) ? r.files : [] } : null;
  } catch { return null; }
}

function writeRecord<T>(kind: string, rec: StoredRecord<T>): void {
  const dir = itemDir(kind, rec.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "record.json");
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec), "utf-8");
  fs.renameSync(tmp, file);
}

// THE CLOCK: this process's Date.now(), strictly increasing across its writes,
// so a save and a delete in the same millisecond never collide.
let lastClock = 0;
export function nextClock(now: () => number = Date.now): number {
  lastClock = Math.max(now(), lastClock + 1);
  return lastClock;
}

// ── The stores' rows (synchronous) ───────────────────────────────────────────

/** Every record of a kind. */
export function libraryRows<T>(kind: string): LibraryRow<T>[] {
  let names: string[] = [];
  try { names = fs.readdirSync(kindDir(kind)); } catch { return []; }
  const out: LibraryRow<T>[] = [];
  for (const id of names) {
    if (!ID_RE.test(id)) continue;
    const r = readRecord<T>(kind, id);
    if (r && r.data !== undefined && r.data !== null) out.push({ id: r.id, updatedAt: r.updatedAt, data: r.data });
  }
  return out;
}

/** Write a record at this process's clock, keeping its files. */
export function libraryWrite<T>(kind: string, id: string, data: T): void {
  writeRecord(kind, { id, updatedAt: nextClock(), data, files: readRecord(kind, id)?.files ?? [] });
}

/** Delete a record and its files; one that is not there is already gone. */
export function libraryDelete(kind: string, id: string): void {
  fs.rmSync(itemDir(kind, id), { recursive: true, force: true });
}

// ── The house store's lanes ──────────────────────────────────────────────────

export const localLibrary: HouseLib = {
  async list<T>(kind: string): Promise<HouseListed<T>[]> {
    return libraryRows<T>(kind);
  },
  async get<T>(kind: string, id: string): Promise<HouseItem<T>> {
    const r = readRecord<T>(kind, id);
    if (!r) throw new LibraryNotFound(kind, id);
    return r;
  },
  async put<T>(kind: string, id: string, input: { data: T; files?: HouseFile[]; updatedAt: number }): Promise<{ applied: boolean; item: HouseItem<T> }> {
    const have = readRecord<T>(kind, id);
    if (have && have.updatedAt >= input.updatedAt) return { applied: false, item: have };
    const item: StoredRecord<T> = { id, updatedAt: input.updatedAt, data: input.data, files: input.files ?? have?.files ?? [] };
    writeRecord(kind, item);
    return { applied: true, item };
  },
  async remove(kind: string, id: string): Promise<void> {
    libraryDelete(kind, id);
  },
  /** A file's address is its place on disk: the panels load file:// directly. */
  async files(kind: string, id: string, paths: string[]): Promise<{ put: Record<string, string>; get: Record<string, string> }> {
    const get: Record<string, string> = {};
    for (const p of paths) {
      const full = fileOf(kind, id, p);
      if (fs.existsSync(full)) get[p] = pathToFileURL(full).href;
    }
    return { put: {}, get };
  },
};

export const localLibraryBytes: HouseBytes = {
  async get(kind, id, rel) {
    try { return new Uint8Array(fs.readFileSync(fileOf(kind, id, rel))); }
    catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") throw new Error("that file is no longer in your library");
      throw err;
    }
  },
  async put(kind, id, rel, bytes) {
    const full = fileOf(kind, id, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, bytes);
  },
};
