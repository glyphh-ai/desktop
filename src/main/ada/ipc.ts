/**
 * Ada IPC — the renderer's window into fact memory (app search surfaces,
 * memory panes). Read-only from here; writes go through William's gated
 * tools or the indexer.
 */

import { ipcMain } from "electron";
import { adaRecall, adaExecuteOp, adaStats, adaHistory, type AdaOp } from "./store";
import { syncWorkspaceFacts } from "./indexer";

export function registerAdaIpc(): void {
  ipcMain.handle("ada-recall", (_e, p: { query?: string; k?: number }) =>
    adaRecall(String(p?.query || ""), Math.max(1, Math.min(20, Number(p?.k) || 5))));
  ipcMain.handle("ada-ask", (_e, p: { op?: AdaOp }) => {
    try { return { ok: true, answer: adaExecuteOp((p?.op ?? { op: "refuse" }) as AdaOp) }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("ada-history", (_e, p: { key?: string }) => adaHistory(String(p?.key || "")));
  ipcMain.handle("ada-stats", () => adaStats());
  ipcMain.handle("ada-sync", async () => syncWorkspaceFacts());
}
