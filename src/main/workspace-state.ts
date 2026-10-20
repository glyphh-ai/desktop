/**
 * workspace-state.ts — the workbench's drag/panel state, ON THE SERVER.
 *
 * Until 2026-10-07 the desktop sharded this map into
 * ~/.glyphh/<user>/workspaces/<id>/state.json. His order that day: nothing is
 * replicated to the local machine. The map now rides the member's server
 * prefs under the key the web bridge already uses (shared/ui-state-trim.ts
 * WS_STATE_PREF), so an arrangement made on either surface is the member's
 * everywhere. The renderer (help/ui-state.ts) keeps its synchronous key →
 * string map and flushes the whole snapshot here (debounced); this module
 * trims it to the budget and writes the one pref.
 */
import { ipcMain } from "electron";
import { getPreference, setPreference } from "./stores/preferences-db.js";
import { WS_STATE_PREF, trimWsState, type UiStateSnapshot } from "../shared/ui-state-trim.js";

/** The map as the member's prefs hold it. */
export function loadWorkspaceState(): UiStateSnapshot {
  try {
    const raw = getPreference<unknown>(WS_STATE_PREF, null);
    const map = typeof raw === "string" ? JSON.parse(raw) : raw;
    return map && typeof map === "object" ? (map as UiStateSnapshot) : {};
  } catch { return {}; }
}

/** Persist the renderer's full snapshot, trimmed to the budget. */
export function saveWorkspaceState(snapshot: UiStateSnapshot): void {
  setPreference(WS_STATE_PREF, JSON.stringify(trimWsState(snapshot)));
}

export function registerWorkspaceStateIpc(): void {
  ipcMain.handle("wsstate-load", () => loadWorkspaceState());
  ipcMain.handle("wsstate-save", (_e, snapshot: unknown) => {
    if (snapshot && typeof snapshot === "object") saveWorkspaceState(snapshot as UiStateSnapshot);
    return true;
  });
}
