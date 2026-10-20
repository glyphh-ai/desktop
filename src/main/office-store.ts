/**
 * office-store.ts — Glyphh Office · the LOCAL store (THE PURGE, 2026-09-10).
 *
 * The org library is gone: Office files live on THIS machine under
 * ~/.glyphh/office as plain files the user (and any agent CLI) can see —
 *   docs/*.md        markdown documents (title = first H1)
 *   sheets/*.json    { title, workbook }
 *   drive.json       the docs' and sheets' file→folder pointers
 *   suggestions.json the Docs review-and-approve rows
 *
 * Designs, decks and Drive itself moved to the member library on 2026-10-06
 * (shared/house-store.ts: cloud is the one home); the docs and sheets
 * transports (office-docs / office-sheets / office-export) still read and
 * write through here, and the wire shapes match what the old server returned
 * so the renderers didn't have to move.
 */

import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { userScopedPath } from "./app-paths.js";

const ROOT = (): string => userScopedPath("office");
// EVERY path resolves PER CALL. These were computed once at module load, when
// main boots and nobody is signed in yet, so they pinned themselves to the
// pre-auth machine-wide folder and every account then read and wrote the same
// documents (his report, 2026-09-17: a fresh user opened Design and saw
// someone else's work).
const DIRS = (): { docs: string; sheets: string } => ({ docs: join(ROOT(), "docs"), sheets: join(ROOT(), "sheets") });
const DRIVE_FILE = (): string => join(ROOT(), "drive.json");
const SUGGESTIONS_FILE = (): string => join(ROOT(), "suggestions.json");

// ── wire shapes (what the server used to return) ─────────────────────────────

export interface DocMeta { file: string; title: string; sizeBytes: number; folderId: string | null; updatedAt: string }
export interface SheetMeta { file: string; title: string; sheets: number; totalRows: number; sizeBytes: number; folderId: string | null; updatedAt: string }
interface DriveFolder { id: string; name: string; parentId: string | null }
export interface Suggestion {
  id: string; file: string; section: string; beforeMd: string; afterMd: string;
  note: string; authorKind: string; status: "pending" | "approved" | "rejected" | "stale";
  createdAt: string; resolvedAt?: string;
}

interface DriveState { folders: DriveFolder[]; pointers: Record<string, string> }
interface SuggestionState { rows: Suggestion[] }

// ── plumbing ─────────────────────────────────────────────────────────────────

// Remembered PER ROOT: the folders belong to the signed-in user, so a switch
// has to make the new user's before anything writes into them.
let readyFor: string | null = null;
let readyPromise: Promise<void> | null = null;
function ensureDirs(): Promise<void> {
  const root = ROOT();
  if (readyFor !== root) {
    readyFor = root;
    readyPromise = null;
  }
  readyPromise ??= (async () => {
    for (const d of Object.values(DIRS())) await fsp.mkdir(d, { recursive: true });
  })();
  return readyPromise;
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fsp.readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Write-then-rename so a crash never leaves a half-written index. */
async function writeJson(path: string, value: unknown): Promise<void> {
  await ensureDirs();
  const tmp = `${path}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fsp.rename(tmp, path);
}

const loadDrive = (): Promise<DriveState> => readJson<DriveState>(DRIVE_FILE(), { folders: [], pointers: {} });
const loadSuggestions = (): Promise<SuggestionState> => readJson<SuggestionState>(SUGGESTIONS_FILE(), { rows: [] });

const pointerKey = (kind: string, file: string): string => `${kind}:${file}`;

async function setPointer(kind: string, file: string, folderId: string | null): Promise<void> {
  const drive = await loadDrive();
  const key = pointerKey(kind, file);
  if (folderId && drive.folders.some((f) => f.id === folderId)) drive.pointers[key] = folderId;
  else delete drive.pointers[key];
  await writeJson(DRIVE_FILE(), drive);
}

async function pointerOf(kind: string, file: string): Promise<string | null> {
  const drive = await loadDrive();
  return drive.pointers[pointerKey(kind, file)] ?? null;
}

/** First H1 wins; otherwise the stem reads as the title. */
function docTitle(file: string, markdown: string): string {
  const h1 = markdown.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim();
  return h1 || file.replace(/\.md$/i, "");
}

interface WorkbookLike { sheets?: Array<{ rows?: unknown[] }> }
const sheetCounts = (wb: WorkbookLike): { sheets: number; totalRows: number } => ({
  sheets: wb.sheets?.length ?? 0,
  totalRows: (wb.sheets ?? []).reduce((n, s) => n + (s.rows?.length ?? 0), 0),
});

async function statOf(path: string): Promise<{ sizeBytes: number; updatedAt: string } | null> {
  try {
    const st = await fsp.stat(path);
    return { sizeBytes: st.size, updatedAt: st.mtime.toISOString() };
  } catch {
    return null;
  }
}

async function listFiles(dir: string, ext: string): Promise<string[]> {
  try {
    return (await fsp.readdir(dir)).filter((f) => f.toLowerCase().endsWith(ext)).sort();
  } catch {
    return [];
  }
}

// ── DOCS ─────────────────────────────────────────────────────────────────────

export async function listDocs(): Promise<DocMeta[]> {
  await ensureDirs();
  const drive = await loadDrive();
  const out: DocMeta[] = [];
  for (const file of await listFiles(DIRS().docs, ".md")) {
    const path = join(DIRS().docs, file);
    const st = await statOf(path);
    if (!st) continue;
    let markdown = "";
    try { markdown = await fsp.readFile(path, "utf8"); } catch { /* raced a delete */ }
    out.push({ file, title: docTitle(file, markdown), ...st, folderId: drive.pointers[pointerKey("docs", file)] ?? null });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readDoc(file: string): Promise<DocMeta & { markdown: string }> {
  await ensureDirs();
  const path = join(DIRS().docs, file);
  const markdown = await fsp.readFile(path, "utf8");
  const st = await statOf(path);
  return { file, title: docTitle(file, markdown), markdown, sizeBytes: st?.sizeBytes ?? markdown.length, updatedAt: st?.updatedAt ?? new Date().toISOString(), folderId: await pointerOf("docs", file) };
}

/** Create-or-overwrite. folderId undefined keeps the pointer — saving content
 *  never re-files a document (the old server's rule). */
export async function writeDoc(file: string, markdown: string, folderId?: string | null): Promise<DocMeta> {
  await ensureDirs();
  await fsp.writeFile(join(DIRS().docs, file), markdown, "utf8");
  if (folderId !== undefined) await setPointer("docs", file, folderId);
  const st = await statOf(join(DIRS().docs, file));
  return { file, title: docTitle(file, markdown), sizeBytes: st?.sizeBytes ?? markdown.length, updatedAt: st?.updatedAt ?? new Date().toISOString(), folderId: await pointerOf("docs", file) };
}

export async function deleteDoc(file: string): Promise<void> {
  await ensureDirs();
  await fsp.rm(join(DIRS().docs, file), { force: true });
  await setPointer("docs", file, null);
  const sugs = await loadSuggestions();
  const rows = sugs.rows.filter((r) => r.file !== file);
  if (rows.length !== sugs.rows.length) await writeJson(SUGGESTIONS_FILE(), { rows });
}

// ── DOC SUGGESTIONS (review-and-approve) ─────────────────────────────────────

export async function listDocSuggestions(file: string, status?: string): Promise<Suggestion[]> {
  const sugs = await loadSuggestions();
  return sugs.rows.filter((r) => r.file === file && (!status || r.status === status));
}

export async function createDocSuggestion(
  file: string,
  input: { section?: string; beforeMd?: string; afterMd: string; note?: string; authorKind?: string },
): Promise<Suggestion> {
  await readDoc(file);   // the doc must exist — same 404 the server threw
  const row: Suggestion = {
    id: randomUUID(), file,
    section: String(input.section ?? ""), beforeMd: String(input.beforeMd ?? ""),
    afterMd: String(input.afterMd ?? ""), note: String(input.note ?? ""),
    authorKind: input.authorKind === "user" ? "user" : "agent",
    status: "pending", createdAt: new Date().toISOString(),
  };
  const sugs = await loadSuggestions();
  sugs.rows.push(row);
  await writeJson(SUGGESTIONS_FILE(), sugs);
  return row;
}

/** Approve applies the replacement; an apply that can't find its target goes
 *  "stale", never a lie (the old server's rule). */
export async function resolveDocSuggestion(id: string, approve: boolean): Promise<Suggestion> {
  const sugs = await loadSuggestions();
  const row = sugs.rows.find((r) => r.id === id);
  if (!row) throw new Error("suggestion not found");
  if (row.status !== "pending") throw new Error("suggestion already resolved");
  let status: Suggestion["status"] = approve ? "approved" : "rejected";
  if (approve && row.beforeMd) {
    try {
      const doc = await readDoc(row.file);
      if (doc.markdown.includes(row.beforeMd)) {
        await writeDoc(row.file, doc.markdown.replace(row.beforeMd, row.afterMd));
      } else {
        status = "stale";
      }
    } catch {
      status = "stale";
    }
  }
  row.status = status;
  row.resolvedAt = new Date().toISOString();
  await writeJson(SUGGESTIONS_FILE(), sugs);
  return row;
}

// ── SHEETS ───────────────────────────────────────────────────────────────────

interface SheetFile { title: string; workbook: WorkbookLike }

async function readSheetFile(file: string): Promise<SheetFile> {
  const raw = JSON.parse(await fsp.readFile(join(DIRS().sheets, file), "utf8")) as SheetFile;
  return { title: String(raw.title ?? file.replace(/\.json$/i, "")), workbook: raw.workbook ?? {} };
}

export async function listSheets(): Promise<SheetMeta[]> {
  await ensureDirs();
  const drive = await loadDrive();
  const out: SheetMeta[] = [];
  for (const file of await listFiles(DIRS().sheets, ".json")) {
    const st = await statOf(join(DIRS().sheets, file));
    if (!st) continue;
    try {
      const s = await readSheetFile(file);
      out.push({ file, title: s.title, ...sheetCounts(s.workbook), ...st, folderId: drive.pointers[pointerKey("sheets", file)] ?? null });
    } catch { /* unreadable workbook — skip, never kill the list */ }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readSheet(file: string): Promise<SheetMeta & { workbook: unknown }> {
  await ensureDirs();
  const s = await readSheetFile(file);
  const st = await statOf(join(DIRS().sheets, file));
  return { file, title: s.title, workbook: s.workbook, ...sheetCounts(s.workbook), sizeBytes: st?.sizeBytes ?? 0, updatedAt: st?.updatedAt ?? new Date().toISOString(), folderId: await pointerOf("sheets", file) };
}

export async function writeSheet(file: string, title: string, workbook: WorkbookLike, folderId?: string | null): Promise<SheetMeta> {
  await ensureDirs();
  await fsp.writeFile(join(DIRS().sheets, file), JSON.stringify({ title, workbook }, null, 2), "utf8");
  if (folderId !== undefined) await setPointer("sheets", file, folderId);
  const st = await statOf(join(DIRS().sheets, file));
  return { file, title, ...sheetCounts(workbook), sizeBytes: st?.sizeBytes ?? 0, updatedAt: st?.updatedAt ?? new Date().toISOString(), folderId: await pointerOf("sheets", file) };
}

export async function deleteSheet(file: string): Promise<void> {
  await ensureDirs();
  await fsp.rm(join(DIRS().sheets, file), { force: true });
  await setPointer("sheets", file, null);
}
