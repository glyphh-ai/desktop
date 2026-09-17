/**
 * office-store.ts — Glyphh Office · the LOCAL store (THE PURGE, 2026-09-10).
 *
 * The org library is gone: Office files live on THIS machine under
 * ~/.glyphh/office as plain files the user (and any agent CLI) can see —
 *   docs/*.md        markdown documents (title = first H1)
 *   sheets/*.json    { title, workbook }
 *   slides/*.html    self-contained deck documents
 *   drive.json       folders + file→folder pointers (Drive is a view; the
 *                    files themselves stay flat so names remain stable refs)
 *   suggestions.json the Docs review-and-approve rows
 *
 * Every transport (office-docs / office-sheets / gpoints / office-export)
 * reads and writes through here; the wire shapes match what the old server
 * returned so the renderers didn't have to move.
 */

import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { userScopedPath } from "./app-paths.js";

const ROOT = (): string => userScopedPath("office");
// EVERY path resolves PER CALL. These were computed once at module load, when
// main boots and nobody is signed in yet, so they pinned themselves to the
// pre-auth machine-wide folder and every account then read and wrote the same
// documents (his report, 2026-09-17: a fresh user opened Design and saw
// someone else's work).
const DIRS = (): { docs: string; sheets: string; slides: string; design: string } => ({
  docs: join(ROOT(), "docs"), sheets: join(ROOT(), "sheets"), slides: join(ROOT(), "slides"), design: join(ROOT(), "design"),
});
/** Asset bytes live beside the documents: design/assets/<stem>/<assetId>. */
const DESIGN_ASSETS = (): string => join(DIRS().design, "assets");
const DRIVE_FILE = (): string => join(ROOT(), "drive.json");
const SUGGESTIONS_FILE = (): string => join(ROOT(), "suggestions.json");

// ── wire shapes (what the server used to return) ─────────────────────────────

export interface DocMeta { file: string; title: string; sizeBytes: number; folderId: string | null; updatedAt: string }
export interface SheetMeta { file: string; title: string; sheets: number; totalRows: number; sizeBytes: number; folderId: string | null; updatedAt: string }
export interface SlideMeta { file: string; title: string; slides: number; sizeBytes: number; updatedAt: string }
export interface DriveFolder { id: string; name: string; parentId: string | null }
export interface DriveEntry {
  kind: "slides" | "docs" | "sheets" | "design";
  ref: string; file: string; title: string;
  sizeBytes: number; folderId: string | null; updatedAt: string;
  /** sheets carry their counts so Drive cards can label them */
  sheets?: number; totalRows?: number; slides?: number;
}
export interface Suggestion {
  id: string; file: string; section: string; beforeMd: string; afterMd: string;
  note: string; authorKind: string; status: "pending" | "approved" | "rejected" | "stale";
  createdAt: string; resolvedAt?: string;
}

interface DriveState { folders: DriveFolder[]; pointers: Record<string, string> }
interface SuggestionState { rows: Suggestion[] }

// ── plumbing ─────────────────────────────────────────────────────────────────

let readyPromise: Promise<void> | null = null;
function ensureDirs(): Promise<void> {
  readyPromise ??= (async () => {
    for (const d of Object.values(DIRS)) await fsp.mkdir(d, { recursive: true });
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

function slideTitle(file: string, html: string): string {
  const t = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.trim()
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  return t || file.replace(/\.html$/i, "");
}

const slideCount = (html: string): number => (html.match(/<section\b[^>]*class="[^"]*\bslide\b/g) ?? []).length;

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

// ── SLIDES ───────────────────────────────────────────────────────────────────

export async function listSlides(): Promise<SlideMeta[]> {
  await ensureDirs();
  const out: SlideMeta[] = [];
  for (const file of await listFiles(DIRS().slides, ".html")) {
    const path = join(DIRS().slides, file);
    const st = await statOf(path);
    if (!st) continue;
    let html = "";
    try { html = await fsp.readFile(path, "utf8"); } catch { /* raced a delete */ }
    out.push({ file, title: slideTitle(file, html), slides: slideCount(html), ...st });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readSlide(file: string): Promise<SlideMeta & { html: string }> {
  await ensureDirs();
  const path = join(DIRS().slides, file);
  const html = await fsp.readFile(path, "utf8");
  const st = await statOf(path);
  return { file, title: slideTitle(file, html), slides: slideCount(html), html, sizeBytes: st?.sizeBytes ?? html.length, updatedAt: st?.updatedAt ?? new Date().toISOString() };
}

export async function writeSlide(file: string, html: string): Promise<SlideMeta> {
  await ensureDirs();
  await fsp.writeFile(join(DIRS().slides, file), html, "utf8");
  const st = await statOf(join(DIRS().slides, file));
  return { file, title: slideTitle(file, html), slides: slideCount(html), sizeBytes: st?.sizeBytes ?? html.length, updatedAt: st?.updatedAt ?? new Date().toISOString() };
}

export async function deleteSlide(file: string): Promise<void> {
  await ensureDirs();
  await fsp.rm(join(DIRS().slides, file), { force: true });
  await setPointer("slides", file, null);
}

// ── DESIGN — systems (JSON documents) + their asset bytes ────────────────────

export interface DesignMeta { file: string; title: string; sizeBytes: number; updatedAt: string }
interface DesignDocLike { name?: string; assets?: Array<{ id: string; kind: string; title: string; contentType: string; sizeBytes: number }> }

const designStem = (file: string): string => file.replace(/\.json$/i, "");
const designTitle = (file: string, doc: DesignDocLike): string => (typeof doc.name === "string" && doc.name.trim()) || designStem(file);

export async function listDesigns(): Promise<DesignMeta[]> {
  await ensureDirs();
  const out: DesignMeta[] = [];
  for (const file of await listFiles(DIRS().design, ".json")) {
    const st = await statOf(join(DIRS().design, file));
    if (!st) continue;
    try {
      const doc = JSON.parse(await fsp.readFile(join(DIRS().design, file), "utf8")) as DesignDocLike;
      out.push({ file, title: designTitle(file, doc), ...st });
    } catch { /* unreadable system — skip, never kill the list */ }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readDesign(file: string): Promise<DesignMeta & { document: DesignDocLike }> {
  await ensureDirs();
  const document = JSON.parse(await fsp.readFile(join(DIRS().design, file), "utf8")) as DesignDocLike;
  const st = await statOf(join(DIRS().design, file));
  return { file, title: designTitle(file, document), document, sizeBytes: st?.sizeBytes ?? 0, updatedAt: st?.updatedAt ?? new Date().toISOString() };
}

export async function writeDesign(file: string, document: DesignDocLike): Promise<DesignMeta> {
  await ensureDirs();
  await fsp.writeFile(join(DIRS().design, file), JSON.stringify(document, null, 2), "utf8");
  const st = await statOf(join(DIRS().design, file));
  return { file, title: designTitle(file, document), sizeBytes: st?.sizeBytes ?? 0, updatedAt: st?.updatedAt ?? new Date().toISOString() };
}

export async function deleteDesign(file: string): Promise<void> {
  await ensureDirs();
  await fsp.rm(join(DIRS().design, file), { force: true });
  await fsp.rm(join(DESIGN_ASSETS(), designStem(file)), { recursive: true, force: true });
  await setPointer("design", file, null);
}

export async function writeDesignAssetBytes(file: string, assetId: string, bytes: Buffer): Promise<void> {
  const dir = join(DESIGN_ASSETS(), designStem(file));
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(join(dir, assetId), bytes);
}

export const readDesignAssetBytes = (file: string, assetId: string): Promise<Buffer> =>
  fsp.readFile(join(DESIGN_ASSETS(), designStem(file), assetId));

export const deleteDesignAssetBytes = (file: string, assetId: string): Promise<void> =>
  fsp.rm(join(DESIGN_ASSETS(), designStem(file), assetId), { force: true });

// ── DRIVE — folders + the pointer view over every Office file ────────────────

export async function listDrive(q?: string): Promise<{ folders: DriveFolder[]; files: DriveEntry[] }> {
  const drive = await loadDrive();
  const files: DriveEntry[] = [
    ...(await listSlides()).map((m): DriveEntry => ({ kind: "slides", ref: m.file, file: m.file, title: m.title, sizeBytes: m.sizeBytes, updatedAt: m.updatedAt, slides: m.slides, folderId: drive.pointers[pointerKey("slides", m.file)] ?? null })),
    ...(await listDocs()).map((m): DriveEntry => ({ kind: "docs", ref: m.file, file: m.file, title: m.title, sizeBytes: m.sizeBytes, updatedAt: m.updatedAt, folderId: m.folderId })),
    ...(await listSheets()).map((m): DriveEntry => ({ kind: "sheets", ref: m.file, file: m.file, title: m.title, sizeBytes: m.sizeBytes, updatedAt: m.updatedAt, sheets: m.sheets, totalRows: m.totalRows, folderId: m.folderId })),
    ...(await listDesigns()).map((m): DriveEntry => ({ kind: "design", ref: m.file, file: m.file, title: m.title, sizeBytes: m.sizeBytes, updatedAt: m.updatedAt, folderId: drive.pointers[pointerKey("design", m.file)] ?? null })),
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!q) return { folders: drive.folders, files };
  const needle = q.toLowerCase();
  return {
    folders: drive.folders.filter((f) => f.name.toLowerCase().includes(needle)),
    files: files.filter((f) => f.title.toLowerCase().includes(needle) || f.file.toLowerCase().includes(needle)),
  };
}

export async function createFolder(name: string, parentId?: string | null): Promise<DriveFolder> {
  const clean = name.trim();
  if (!clean) throw new Error("a folder needs a name");
  const drive = await loadDrive();
  const parent = parentId && drive.folders.some((f) => f.id === parentId) ? parentId : null;
  const folder: DriveFolder = { id: randomUUID(), name: clean, parentId: parent };
  drive.folders.push(folder);
  await writeJson(DRIVE_FILE(), drive);
  return folder;
}

export async function updateFolder(id: string, fields: { name?: string; parentId?: string | null }): Promise<DriveFolder> {
  const drive = await loadDrive();
  const folder = drive.folders.find((f) => f.id === id);
  if (!folder) throw new Error("folder not found");
  if (fields.name !== undefined) {
    const clean = fields.name.trim();
    if (!clean) throw new Error("a folder needs a name");
    folder.name = clean;
  }
  if (fields.parentId !== undefined) {
    // cycle guard — walking up from the new parent must never meet `id`
    let cursor = fields.parentId;
    while (cursor) {
      if (cursor === id) throw new Error("a folder can't live inside itself");
      cursor = drive.folders.find((f) => f.id === cursor)?.parentId ?? null;
    }
    folder.parentId = fields.parentId && drive.folders.some((f) => f.id === fields.parentId) ? fields.parentId : null;
  }
  await writeJson(DRIVE_FILE(), drive);
  return folder;
}

/** Delete a folder — children and file pointers re-parent to its parent. */
export async function deleteFolder(id: string): Promise<void> {
  const drive = await loadDrive();
  const folder = drive.folders.find((f) => f.id === id);
  if (!folder) return;
  drive.folders = drive.folders.filter((f) => f.id !== id);
  for (const f of drive.folders) if (f.parentId === id) f.parentId = folder.parentId;
  for (const [key, fid] of Object.entries(drive.pointers)) {
    if (fid !== id) continue;
    if (folder.parentId) drive.pointers[key] = folder.parentId;
    else delete drive.pointers[key];
  }
  await writeJson(DRIVE_FILE(), drive);
}

export async function moveToFolder(kind: string, ref: string, folderId: string | null): Promise<void> {
  await setPointer(kind, ref, folderId);
}
