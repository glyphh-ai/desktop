/**
 * sync/lww.ts — THE sync rule, as one pure function. The member library
 * (workspaces, tabs, skills, agents, tasks) and chat threads are database-as-truth
 * with files in R2; every client keeps a cache and reconciles it against the
 * server PER ITEM, last-write-wins on `updatedAt` (epoch ms, the writer's clock),
 * with tombstones (`deletedAt` set) in place of hard deletes:
 *
 *   - strictly newer wins, on either side;
 *   - equal clocks are a no-op — unless one side is a tombstone, which then wins
 *     (a delete is final at its instant; two sides must never settle on a
 *     live/dead disagreement);
 *   - a tombstone wins over an OLDER live row;
 *   - a live row with a strictly NEWER clock than a tombstone revives it;
 *   - a row only one side knows is simply carried across (a lone tombstone is
 *     carried too, so the other side records it and cannot be resurrected by a
 *     stale write later).
 *
 * `reconcile` names the four moves the caller then performs: `pushes` (PUT live
 * local rows), `pulls` (take live remote rows), `deletesLocal` (tombstone these
 * ids locally), `deletesRemote` (DELETE these ids on the server, carrying the
 * local clock). Nothing here touches I/O.
 */

/** The LWW facts of one row: its id, the writer's clock, and whether it is a tombstone. */
export interface LwwRow {
  id: string;
  /** Epoch milliseconds — the writer's clock for THIS state of the row. */
  updatedAt: number;
  /** ISO timestamp when tombstoned; null while live. */
  deletedAt: string | null;
}

export interface Reconciled<R extends LwwRow> {
  /** Live local rows the server must take (PUT). */
  pushes: R[];
  /** Live remote rows the local cache must take. */
  pulls: R[];
  /** Ids the local cache must tombstone (the remote tombstone won). */
  deletesLocal: string[];
  /** Ids the server must tombstone (the local tombstone won). */
  deletesRemote: string[];
}

const isTombstone = (row: LwwRow): boolean => row.deletedAt !== null;

/**
 * Which of two states of the same row wins. `"tie"` means neither — same clock,
 * same liveness — and the caller does nothing.
 */
export function compareLww(a: LwwRow, b: LwwRow): "a" | "b" | "tie" {
  if (a.updatedAt > b.updatedAt) return "a";
  if (a.updatedAt < b.updatedAt) return "b";
  const ta = isTombstone(a);
  const tb = isTombstone(b);
  if (ta === tb) return "tie";
  return ta ? "a" : "b";
}

/** Index one side by id; a duplicated id keeps its winning state by the same rule. */
function index<R extends LwwRow>(rows: readonly R[]): Map<string, R> {
  const out = new Map<string, R>();
  for (const row of rows) {
    const held = out.get(row.id);
    if (!held || compareLww(row, held) === "a") out.set(row.id, row);
  }
  return out;
}

/**
 * Reconcile a local cache against the server's rows for the same kind. Both
 * inputs may be partial (a `since` page): a row absent from one side is treated
 * as unknown there, never as deleted. Output order follows the local rows,
 * then the remote-only ones.
 */
export function reconcile<R extends LwwRow>(local: readonly R[], remote: readonly R[]): Reconciled<R> {
  const l = index(local);
  const r = index(remote);
  const out: Reconciled<R> = { pushes: [], pulls: [], deletesLocal: [], deletesRemote: [] };

  for (const [id, mine] of l) {
    const theirs = r.get(id);
    if (!theirs) {
      if (isTombstone(mine)) out.deletesRemote.push(id);
      else out.pushes.push(mine);
      continue;
    }
    const verdict = compareLww(mine, theirs);
    if (verdict === "tie") continue;
    if (verdict === "a") {
      if (!isTombstone(mine)) out.pushes.push(mine);
      else if (!isTombstone(theirs)) out.deletesRemote.push(id);
    } else {
      if (!isTombstone(theirs)) out.pulls.push(theirs);
      else if (!isTombstone(mine)) out.deletesLocal.push(id);
    }
  }

  for (const [id, theirs] of r) {
    if (l.has(id)) continue;
    if (isTombstone(theirs)) out.deletesLocal.push(id);
    else out.pulls.push(theirs);
  }

  return out;
}
