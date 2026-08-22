/**
 * office-sheets.ts — Glyphh Office · SHEETS, the desktop transport + the
 * agent's workbook helpers. Workbooks live in the ORG library via the SDK;
 * every write RECALCULATES through the shared engine first, so stored
 * formula cells always carry fresh materialized values.
 */

import { getClient } from "./glyphh-client";
import { recalcWorkbook, type Workbook } from "../shared/sheets-engine";

export function gsheetFileName(name: unknown): string {
  const base = String(name ?? "").trim().split(/[\\/]/).pop() ?? "";
  const stem = base.replace(/\.json$/i, "").replace(/[^\w\s.-]/g, "").trim().replace(/\s+/g, "-").toLowerCase();
  if (!stem) throw new Error("a workbook needs a name");
  return `${stem}.json`;
}

export async function saveWorkbook(name: unknown, title: string, workbook: Workbook, folderId?: string | null): Promise<{ file: string; title: string; sheets: number; totalRows: number }> {
  const wb = recalcWorkbook(workbook);
  const meta = await getClient().officeSheets.put(gsheetFileName(name), title, wb, folderId);
  return { file: meta.file, title: meta.title, sheets: meta.sheets, totalRows: meta.totalRows };
}

