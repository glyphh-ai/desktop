/**
 * apps-store.ts — the LOCAL app registry (THE PURGE, 2026-09-10).
 *
 * The server app library is gone: an app is a folder on this machine,
 *
 *   ~/.glyphh/apps/<id>/app.json        — the registry row (id = slug)
 *
 * (installed glyphh-app bundles keep their extracted code where it already
 * lives — custom-apps/ — the row's nativeRef points at the entry; a future
 * consolidation can move the bytes here too).
 *
 * The API mirrors the slice of the old SDK client the desktop used
 * (mine / createEntry / updateEntry / removeEntry), so call sites swap
 * `getClient().apps.` for `appsStore.` and nothing else moves.
 */

import fs from "fs";
import path from "path";
import { homedir } from "os";

export const APPS_DIR = path.join(homedir(), ".glyphh", "apps");

/** The stored row — the fields org-apps' toRow() projection reads. */
export interface LocalAppRow {
  id: string;
  kind: "web" | "native" | "glyphh";
  slug: string;
  name: string;
  prodUrl: string | null;
  nativeRef: string | null;
  config: Record<string, unknown> | null;
  description: string;
  access: "public" | "members";
  owned: boolean;
  latestVersion: string | null;
  version: string;
  secretNames: string[];
  requiredConnections: { slug: string; actAs: string; connected: boolean }[];
  listing: null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateEntryInput {
  kind: "web" | "native" | "glyphh";
  slug: string;
  name: string;
  url?: string;
  nativeRef?: string;
  description?: string;
  config?: Record<string, unknown>;
  access?: "public" | "members";
}

export type UpdateEntryInput = Partial<Omit<CreateEntryInput, "slug">> & { secretNames?: string[] };

const rowFile = (slug: string): string => path.join(APPS_DIR, slug, "app.json");

function writeRow(row: LocalAppRow): void {
  const dir = path.join(APPS_DIR, row.slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = rowFile(row.slug);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(row, null, 2), "utf-8");
  fs.renameSync(`${file}.tmp`, file);
}

function readRow(slug: string): LocalAppRow | null {
  try {
    const row = JSON.parse(fs.readFileSync(rowFile(slug), "utf-8")) as LocalAppRow;
    return row && row.slug ? row : null;
  } catch {
    return null;
  }
}

/** Every registered app on this machine. */
export async function mine(): Promise<LocalAppRow[]> {
  let ids: string[] = [];
  try { ids = fs.readdirSync(APPS_DIR); } catch { return []; }
  const rows: LocalAppRow[] = [];
  for (const id of ids) {
    const row = readRow(id);
    if (row) rows.push(row);
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export async function createEntry(input: CreateEntryInput): Promise<LocalAppRow> {
  const slug = input.slug.toLowerCase().trim();
  if (!slug) throw new Error("an app needs a slug");
  if (readRow(slug)) throw new Error(`an app named "${slug}" already exists`);
  const now = new Date().toISOString();
  const row: LocalAppRow = {
    id: slug,
    kind: input.kind,
    slug,
    name: input.name || slug,
    prodUrl: input.url ?? null,
    nativeRef: input.nativeRef ?? null,
    config: input.config ?? null,
    description: input.description ?? "",
    access: input.access === "public" ? "public" : "members",
    owned: true,
    latestVersion: null,
    version: "0.1.0",
    secretNames: [],
    requiredConnections: [],
    listing: null,
    createdAt: now,
    updatedAt: now,
  };
  writeRow(row);
  return row;
}

export async function updateEntry(slug: string, patch: UpdateEntryInput): Promise<LocalAppRow> {
  const row = readRow(slug.toLowerCase().trim());
  if (!row) throw new Error(`app "${slug}" not found`);
  if (patch.name !== undefined) row.name = String(patch.name);
  if (patch.url !== undefined) row.prodUrl = patch.url ?? null;
  if (patch.nativeRef !== undefined) row.nativeRef = patch.nativeRef ?? null;
  if (patch.description !== undefined) row.description = String(patch.description);
  if (patch.config !== undefined) row.config = patch.config ?? null;
  if (patch.access !== undefined) row.access = patch.access === "public" ? "public" : "members";
  if (patch.kind !== undefined) row.kind = patch.kind;
  if (patch.secretNames !== undefined) row.secretNames = patch.secretNames.map(String);
  row.updatedAt = new Date().toISOString();
  writeRow(row);
  return row;
}

export async function removeEntry(slug: string): Promise<void> {
  try { fs.rmSync(path.join(APPS_DIR, slug.toLowerCase().trim()), { recursive: true, force: true }); }
  catch { /* already gone */ }
}

/** Bump the row's version after a local build cut. */
export async function markBuilt(slug: string, version: string): Promise<void> {
  const row = readRow(slug);
  if (!row) return;
  row.latestVersion = version;
  row.version = version;
  row.updatedAt = new Date().toISOString();
  writeRow(row);
}
