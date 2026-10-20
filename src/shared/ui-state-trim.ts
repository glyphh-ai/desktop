/**
 * ui-state-trim.ts — THE WORKBENCH'S UI STATE RIDES THE MEMBER'S SERVER PREFS
 * on every surface (his order, 2026-10-07: nothing replicated to the local
 * machine). The map is small: before a save it is trimmed oldest-first (by
 * each entry's `at` write stamp) to the budget the old server store had.
 * One trim for the web bridge and the desktop's main process.
 */
export const WS_STATE_PREF = "workbenchUiState";
export const WS_STATE_BUDGET = 28 * 1024;

export interface UiStateEntry { v: string; at: number }
export type UiStateSnapshot = Record<string, UiStateEntry>;

export function trimWsState(snapshot: unknown, budget: number = WS_STATE_BUDGET): UiStateSnapshot {
  const entries = Object.entries(snapshot && typeof snapshot === "object" ? (snapshot as Record<string, unknown>) : {})
    .filter((kv): kv is [string, UiStateEntry] => { const e = kv[1] as { v?: unknown } | null; return !!e && typeof e === "object" && typeof e.v === "string"; })
    .sort((a, b) => (Number(b[1].at) || 0) - (Number(a[1].at) || 0));
  const out: UiStateSnapshot = {};
  let size = 2;
  for (const [k, e] of entries) {
    const cost = JSON.stringify({ [k]: e }).length;
    if (size + cost > budget) continue;
    out[k] = { v: e.v, at: Number(e.at) || 0 };
    size += cost;
  }
  return out;
}
