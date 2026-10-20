/**
 * drive.ts — GLYPHH DRIVE, the desktop transport: the folders and the view
 * across everything the house apps made, in the member library
 * (shared/house-store.ts; his order, 2026-10-06: cloud is the one home).
 * Drive is the UNIVERSAL surface: every kind moves through one seam.
 */

import { ipcMain } from "electron";
import { houseStore } from "./house-store.js";

export function registerDriveIpc(): void {
  const store = () => houseStore();
  ipcMain.handle("gdrive-list", (_e, q: unknown) => store().gdriveList(q));
  ipcMain.handle("gdrive-mkdir", (_e, name: unknown, parentId: unknown) => store().gdriveMkdir(name, parentId));
  ipcMain.handle("gdrive-move", (_e, kind: unknown, ref: unknown, folderId: unknown) => store().gdriveMove(kind, ref, folderId));
  ipcMain.handle("gdrive-folder-rename", (_e, id: unknown, name: unknown) => store().gdriveFolderRename(id, name));
  ipcMain.handle("gdrive-folder-delete", (_e, id: unknown) => store().gdriveFolderDelete(id));
}
