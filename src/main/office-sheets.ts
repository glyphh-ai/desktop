/**
 * office-sheets.ts — Glyphh Office · SHEETS, the desktop transport + the
 * agent's workbook helpers. Workbooks live in the LOCAL library
 * (~/.glyphh/office/sheets via office-store, THE PURGE 2026-09-10); every
 * write RECALCULATES through the shared engine first, so stored formula
 * cells always carry fresh materialized values.
 */

import { ipcMain } from "electron";
import * as store from "./office-store";
import { recalcWorkbook, type Workbook } from "../shared/sheets-engine";

export function gsheetFileName(name: unknown): string {
  const base = String(name ?? "").trim().split(/[\\/]/).pop() ?? "";
  const stem = base.replace(/\.json$/i, "").replace(/[^\w\s.-]/g, "").trim().replace(/\s+/g, "-").toLowerCase();
  if (!stem) throw new Error("a workbook needs a name");
  return `${stem}.json`;
}

export async function saveWorkbook(name: unknown, title: string, workbook: Workbook, folderId?: string | null): Promise<{ file: string; title: string; sheets: number; totalRows: number }> {
  const wb = recalcWorkbook(workbook);
  const meta = await store.writeSheet(gsheetFileName(name), title, wb as never, folderId);
  return { file: meta.file, title: meta.title, sheets: meta.sheets, totalRows: meta.totalRows };
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function registerOfficeSheetsIpc(): void {
  ipcMain.handle("gsheet-list", async () => {
    try {
      const sheets = (await store.listSheets()).map((m) => ({
        file: m.file, title: m.title, sheets: m.sheets, totalRows: m.totalRows,
        size: m.sizeBytes, folderId: m.folderId, mtime: Date.parse(m.updatedAt) || 0,
      }));
      return { ok: true, sheets };
    } catch (err) {
      return { ok: false, error: errText(err), sheets: [] };
    }
  });
  ipcMain.handle("gsheet-read", async (_e, name: unknown) => {
    try {
      const s = await store.readSheet(gsheetFileName(name));
      return { ok: true, title: s.title, workbook: s.workbook };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
  ipcMain.handle("gsheet-write", async (_e, name: unknown, title: unknown, workbook: unknown) => {
    try {
      const r = await saveWorkbook(name, String(title ?? "Untitled"), workbook as Workbook);
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
  ipcMain.handle("gsheet-delete", async (_e, name: unknown) => {
    try {
      await store.deleteSheet(gsheetFileName(name));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
}
