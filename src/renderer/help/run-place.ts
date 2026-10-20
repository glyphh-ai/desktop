/**
 * run-place — the folder rows a session can pick from, pure (his order,
 * 2026-10-07). The run-place modal that once chose where a CLI runs went with
 * the CLI agents (2026-10-08); the folder helpers stay.
 */

/** One folder as the chip lists it. */
export interface FolderRow { path: string; label: string; sub: string }
const leaf = (p: string): string => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
/** THE FOLDER CHIP under the desktop's box (his order, 2026-10-07, Claude's
 *  "Project or folder" chip): the session's folder first and checked, then
 *  the recents, each once. Pure. */
export function folderChipRows(selected: string, recents: readonly string[]): Array<FolderRow & { selected: boolean }> {
  const out: Array<FolderRow & { selected: boolean }> = [];
  const seen = new Set<string>();
  for (const p of [selected, ...recents]) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push({ path: p, label: leaf(p), sub: p, selected: p === selected });
  }
  return out;
}
/** What the chip reads: the folder's name, or "Folder" with none picked. */
export function folderChipLabel(folder: string): string {
  return folder ? leaf(folder) : "Folder";
}
