/**
 * loop/diff.ts — WHAT A FILE CHANGE CHANGED, line by line (his order,
 * 2026-09-29: "file changes… + adds green, - removes red, foldable with inline
 * adds highlighted in green, removes highlighted in red… way more robust
 * viewing… world class").
 *
 * The built-in write and edit tools hand the host a real diff: hunks with line
 * numbers on both sides, a few lines of context around each change, and the
 * counts. It is computed here, where the before and after are both known,
 * rather than guessed at by a renderer from the model's arguments.
 *
 * Common prefix and suffix are trimmed first (most edits touch a small part of
 * a file), then the middle gets an LCS diff — bounded, so a huge rewrite
 * degrades to "these lines out, those lines in" instead of burning memory.
 */

export type DiffLine = { t: " " | "+" | "-"; s: string };
export interface DiffHunk { oldStart: number; newStart: number; lines: DiffLine[] }
export interface FileDiff {
  hunks: DiffHunk[];
  added: number;
  removed: number;
  /** Lines were dropped to stay under the cap; the counts are still exact. */
  truncated: boolean;
}

const LCS_CELLS = 4_000_000;

const split = (s: string): string[] => {
  if (s === "") return [];
  const lines = s.split("\n");
  // A trailing newline is the end of the last line, not an empty line after it.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
};

/** The edit script for the middle of the file: LCS when it fits, a block
 *  replace when it does not. */
function middle(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  if (!n) return b.map((s) => ({ t: "+", s }));
  if (!m) return a.map((s) => ({ t: "-", s }));
  if (n * m > LCS_CELLS) return [...a.map((s): DiffLine => ({ t: "-", s })), ...b.map((s): DiffLine => ({ t: "+", s }))];
  // lens[i][j] = LCS of a[i..] and b[j..], one flat array.
  const w = m + 1;
  const lens = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lens[i * w + j] = a[i] === b[j] ? lens[(i + 1) * w + j + 1]! + 1 : Math.max(lens[(i + 1) * w + j]!, lens[i * w + j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: " ", s: a[i]! }); i++; j++; }
    else if (lens[(i + 1) * w + j]! >= lens[i * w + j + 1]!) { out.push({ t: "-", s: a[i]! }); i++; }
    else { out.push({ t: "+", s: b[j]! }); j++; }
  }
  while (i < n) out.push({ t: "-", s: a[i++]! });
  while (j < m) out.push({ t: "+", s: b[j++]! });
  return out;
}

/**
 * The diff of `before` → `after` as hunks with `context` lines around each
 * change. `cap` bounds the lines KEPT across all hunks (counts stay exact).
 */
export function lineDiff(before: string, after: string, context = 3, cap = 400): FileDiff {
  const a = split(before);
  const b = split(after);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;

  const script: DiffLine[] = [
    ...a.slice(0, pre).map((s): DiffLine => ({ t: " ", s })),
    ...middle(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf)),
    ...a.slice(a.length - suf).map((s): DiffLine => ({ t: " ", s })),
  ];

  let added = 0;
  let removed = 0;
  for (const l of script) { if (l.t === "+") added++; else if (l.t === "-") removed++; }

  // Group changes into hunks, each with its context; nearby hunks merge.
  const hunks: DiffHunk[] = [];
  let kept = 0;
  let truncated = false;
  let oldNo = 1;
  let newNo = 1;
  const pos: Array<{ o: number; n: number }> = script.map((l) => {
    const at = { o: oldNo, n: newNo };
    if (l.t !== "+") oldNo++;
    if (l.t !== "-") newNo++;
    return at;
  });
  let k = 0;
  while (k < script.length) {
    if (script[k]!.t === " ") { k++; continue; }
    const start = Math.max(0, k - context);
    let end = k;
    // Extend while changes are within 2×context of each other.
    for (let x = k; x < script.length; x++) {
      if (script[x]!.t !== " ") end = x;
      else if (x - end > context * 2) break;
    }
    const stop = Math.min(script.length, end + context + 1);
    const lines = script.slice(start, stop);
    if (kept + lines.length > cap) {
      truncated = true;
      const room = cap - kept;
      if (room > 0) hunks.push({ oldStart: pos[start]!.o, newStart: pos[start]!.n, lines: lines.slice(0, room) });
      break;
    }
    hunks.push({ oldStart: pos[start]!.o, newStart: pos[start]!.n, lines });
    kept += lines.length;
    k = stop;
  }
  return { hunks, added, removed, truncated };
}
