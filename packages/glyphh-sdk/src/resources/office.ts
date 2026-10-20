/**
 * resources/office.ts — GLYPHH OFFICE, starting with SLIDES. Decks are org-shared,
 * agent-authored HTML slide documents in the org's R2 space; every surface
 * (desktop, web, pods) reads the same library. `put` is create-or-overwrite by
 * name — the suite has no edit surface, the agent re-authors and saves.
 */

import type { AuthedHttp } from "../core/authed-http.js";
import type {
  OfficeSlide, OfficeSlideMeta,
  OfficeDoc, OfficeDocMeta, OfficeSuggestion, CreateSuggestionInput,
  OfficeDocTemplate, OfficeFolder, OfficeDriveListing, DriveKind,
  OfficeSheet, OfficeSheetMeta, Workbook,
} from "../contract/office.js";

export class OfficeSlidesClient {
  constructor(private readonly http: AuthedHttp) {}

  /** The org's decks, most recently touched first. */
  list(): Promise<OfficeSlideMeta[]> {
    return this.http.get<OfficeSlideMeta[]>("/api/office/slides");
  }

  /** One deck by name — metadata plus the complete HTML document. */
  get(file: string): Promise<OfficeSlide> {
    return this.http.get<OfficeSlide>(`/api/office/slides/${encodeURIComponent(file)}`);
  }

  /** Create or overwrite a deck by name. The server validates the deck shape
   *  (needs <section class="slide"> pages) and extracts title + slide count. */
  put(file: string, html: string): Promise<OfficeSlideMeta> {
    return this.http.put<OfficeSlideMeta>(`/api/office/slides/${encodeURIComponent(file)}`, { html });
  }

  /** Delete a deck for the whole org — the stored document and its index row. */
  delete(file: string): Promise<void> {
    return this.http.del<void>(`/api/office/slides/${encodeURIComponent(file)}`);
  }

  /** The deck's READABLE TEXT (per-slide, hidden slides labeled) — what a
   *  session should read; the raw document is mostly font bytes. */
  text(file: string): Promise<OfficeSlideMeta & { text: string }> {
    return this.http.get<OfficeSlideMeta & { text: string }>(`/api/office/slides/${encodeURIComponent(file)}/text`);
  }
}

// ── DOCS — markdown documents with the review-and-approve edit flow ──────────


export class OfficeDocsClient {
  constructor(private readonly http: AuthedHttp) {}

  /** The org's documents, most recently touched first. */
  list(): Promise<OfficeDocMeta[]> {
    return this.http.get<OfficeDocMeta[]>("/api/office/docs");
  }

  /** One document by name — metadata plus the complete markdown source. */
  get(file: string): Promise<OfficeDoc> {
    return this.http.get<OfficeDoc>(`/api/office/docs/${encodeURIComponent(file)}`);
  }

  /** Create or overwrite by name. Omit folderId to keep the current Drive
   *  pointer; null files at the root. Title comes from the first H1. */
  put(file: string, markdown: string, folderId?: string | null): Promise<OfficeDocMeta> {
    const body: { markdown: string; folderId?: string | null } = { markdown };
    if (folderId !== undefined) body.folderId = folderId;
    return this.http.put<OfficeDocMeta>(`/api/office/docs/${encodeURIComponent(file)}`, body);
  }

  /** Delete a document for the whole org. */
  delete(file: string): Promise<void> {
    return this.http.del<void>(`/api/office/docs/${encodeURIComponent(file)}`);
  }

  /** A document's suggestions (optionally one status, e.g. "pending"). */
  suggestions(file: string, status?: string): Promise<OfficeSuggestion[]> {
    const qs = status ? `?status=${encodeURIComponent(status)}` : "";
    return this.http.get<OfficeSuggestion[]>(`/api/office/docs/${encodeURIComponent(file)}/suggestions${qs}`);
  }

  /** Propose an edit (review-and-approve): a targeted replacement with a note. */
  suggest(file: string, input: CreateSuggestionInput): Promise<OfficeSuggestion> {
    return this.http.post<OfficeSuggestion>(`/api/office/docs/${encodeURIComponent(file)}/suggestions`, input);
  }

  /** Approve (applies the change) or reject a pending suggestion. */
  resolveSuggestion(id: string, approve: boolean): Promise<OfficeSuggestion> {
    return this.http.post<OfficeSuggestion>(`/api/office/suggestions/${encodeURIComponent(id)}/resolve`, { approve });
  }

  /** The code-defined template catalog (resume, bill of sale, …). */
  templates(): Promise<OfficeDocTemplate[]> {
    return this.http.get<OfficeDocTemplate[]>("/api/office/doc-templates");
  }
}

// ── DRIVE — folders + the pointer view over every Office file ────────────────

export class OfficeDriveClient {
  constructor(private readonly http: AuthedHttp) {}

  /** Folders + file pointers (slides AND docs), optionally filtered by q. */
  list(q?: string): Promise<OfficeDriveListing> {
    const qs = q ? `?q=${encodeURIComponent(q)}` : "";
    return this.http.get<OfficeDriveListing>(`/api/office/drive${qs}`);
  }

  createFolder(name: string, parentId?: string | null): Promise<OfficeFolder> {
    const body: { name: string; parentId?: string | null } = { name };
    if (parentId !== undefined) body.parentId = parentId;
    return this.http.post<OfficeFolder>("/api/office/drive/folders", body);
  }

  /** Rename and/or re-parent (parentId null = root; cycles are rejected). */
  updateFolder(id: string, fields: { name?: string; parentId?: string | null }): Promise<OfficeFolder> {
    return this.http.patch<OfficeFolder>(`/api/office/drive/folders/${encodeURIComponent(id)}`, fields);
  }

  /** Delete a folder — its contents re-parent to the folder's parent. */
  deleteFolder(id: string): Promise<void> {
    return this.http.del<void>(`/api/office/drive/folders/${encodeURIComponent(id)}`);
  }

  /** Point one Office file at a folder (null = root). */
  /** Move any Drive object into a folder (null = root). Office/design pass
   *  the file name; media/music/file pass the row id — both ride `file`. */
  move(kind: DriveKind, ref: string, folderId: string | null): Promise<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>("/api/office/drive/move", { kind, file: ref, folderId });
  }
}

// ── SHEETS — JSON workbooks; formula values arrive materialized ──────────────

export class OfficeSheetsClient {
  constructor(private readonly http: AuthedHttp) {}

  /** The org's workbooks, most recently touched first. */
  list(): Promise<OfficeSheetMeta[]> {
    return this.http.get<OfficeSheetMeta[]>("/api/office/sheets");
  }

  /** One workbook by name — metadata plus the full JSON workbook. */
  get(file: string): Promise<OfficeSheet> {
    return this.http.get<OfficeSheet>(`/api/office/sheets/${encodeURIComponent(file)}`);
  }

  /** Create or overwrite by name. Formula cells must carry their materialized
   *  values ({f, v}) — recompute before saving. */
  put(file: string, title: string, workbook: Workbook, folderId?: string | null): Promise<OfficeSheetMeta> {
    const body: { title: string; workbook: Workbook; folderId?: string | null } = { title, workbook };
    if (folderId !== undefined) body.folderId = folderId;
    return this.http.put<OfficeSheetMeta>(`/api/office/sheets/${encodeURIComponent(file)}`, body);
  }

  /** Delete a workbook for the whole org. */
  delete(file: string): Promise<void> {
    return this.http.del<void>(`/api/office/sheets/${encodeURIComponent(file)}`);
  }

  /** The workbook's READABLE TEXT — headers + sample rows per sheet. */
  text(file: string): Promise<OfficeSheetMeta & { text: string }> {
    return this.http.get<OfficeSheetMeta & { text: string }>(`/api/office/sheets/${encodeURIComponent(file)}/text`);
  }
}
