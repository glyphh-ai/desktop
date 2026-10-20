/**
 * apps-store.ts — THE TAB ROWS: the local member library's `tab` records
 * (member-library-local.ts), with a running copy in memory for the
 * synchronous readers, loaded on first read and written through on every
 * change.
 *
 * The API keeps the slice the desktop used (mine / readRow / createEntry /
 * updateEntry / removeEntry), so no call site moves.
 */
import { isTabRow } from "../shared/member-library.js";
import { libraryDelete, libraryRows, libraryWrite } from "./member-library-local.js";

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

/** `url` / `nativeRef` take null to CLEAR them (a cloud instance's row keeps no local entry). */
export type UpdateEntryInput = Partial<Omit<CreateEntryInput, "slug" | "url" | "nativeRef">> & { url?: string | null; nativeRef?: string | null; secretNames?: string[] };

// ── The running copy ─────────────────────────────────────────────────────────
const rows = new Map<string, LocalAppRow>();
let loaded = false;

/** The copy, read from the library the first time anything asks. */
function tabs(): Map<string, LocalAppRow> {
  if (loaded) return rows;
  for (const r of libraryRows<LocalAppRow>("tab")) {
    if (!isTabRow(r.data)) continue;
    const slug = r.id.toLowerCase();
    rows.set(slug, { ...r.data, slug, id: r.data.id || slug, updatedAt: new Date(r.updatedAt).toISOString() });
  }
  loaded = true;
  return rows;
}

/** Announce a change the way main's own writes always did. */
async function announce(): Promise<void> {
  const { broadcast } = await import("./broadcast.js");
  broadcast("panel-apps-changed");
}

export function readRow(slug: string): LocalAppRow | null {
  return tabs().get(slug.toLowerCase().trim()) ?? null;
}

/** Every tab row, from the running copy. */
export function mineSync(): LocalAppRow[] {
  return Array.from(tabs().values()).sort((a, b) => a.name.localeCompare(b.name));
}

/** Every tab row (the async face the IPC and the resolver await). */
export async function mine(): Promise<LocalAppRow[]> {
  return mineSync();
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
  libraryWrite("tab", slug, row);
  tabs().set(slug, row);
  void announce();
  return row;
}

export async function updateEntry(slug: string, patch: UpdateEntryInput): Promise<LocalAppRow> {
  const row = readRow(slug);
  if (!row) throw new Error(`app "${slug}" not found`);
  const next = { ...row };
  if (patch.name !== undefined) next.name = String(patch.name);
  if (patch.url !== undefined) next.prodUrl = patch.url ?? null;
  if (patch.nativeRef !== undefined) next.nativeRef = patch.nativeRef ?? null;
  if (patch.description !== undefined) next.description = String(patch.description);
  if (patch.config !== undefined) next.config = patch.config ?? null;
  if (patch.access !== undefined) next.access = patch.access === "public" ? "public" : "members";
  if (patch.kind !== undefined) next.kind = patch.kind;
  if (patch.secretNames !== undefined) next.secretNames = patch.secretNames.map(String);
  next.updatedAt = new Date().toISOString();
  libraryWrite("tab", next.slug, next);
  tabs().set(next.slug, next);
  void announce();
  return next;
}

/** Delete the tab row; the running copy drops it. */
export async function removeEntry(slug: string): Promise<void> {
  const key = slug.toLowerCase().trim();
  libraryDelete("tab", key);
  tabs().delete(key);
  void announce();
}
