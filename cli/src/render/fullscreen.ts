/**
 * render/fullscreen.ts — A LINE-DIFF RENDERER UNDER INK (his reports,
 * 2026-09-21: "still flickering", "not full height like I asked").
 *
 * Ink 5 repaints by erasing every line it drew and writing the whole frame
 * again, and once the frame is as tall as the terminal it clears the screen
 * first. A full-height app therefore flashes on every keystroke and token.
 * The other agent CLIs solved this with their own renderer; so do we, one
 * layer down: Ink believes it is writing to stdout, but every frame lands
 * here, is split into rows, compared with the rows already on screen, and
 * ONLY the rows that changed are rewritten — each with an absolute cursor
 * move and an erase-to-end-of-line, the whole batch inside one synchronized
 * update (DEC 2026) so the terminal paints it as a unit. Unchanged rows are
 * never touched, so nothing flickers, and the frame may fill the terminal.
 *
 * The app runs on the alternate screen (main.tsx); this module owns what is
 * drawn there. A resize forgets the screen and repaints it whole once.
 */

const ESC = "\u001b";
/** Leading erase / cursor sequences Ink puts before a frame (eraseLines, clearTerminal, cursorLeft). */
const LEADING_CONTROL = /^(?:\u001b\[[0-9;?]*[KAJGH])+/;
/** A chunk that is nothing but control sequences (Ink's log.clear, cursor shows/hides). */
const ONLY_CONTROL = /^(?:\u001b\[[0-9;?]*[A-Za-z])*$/;

export interface FullscreenStream extends NodeJS.WriteStream {
  /** Forget what is on screen; the next frame repaints every row. */
  invalidate(): void;
}

/** Split a frame the way the renderer does — exported for tests. Ink's frame
 *  ends with the newline log-update appends; that is not a row. */
export function frameRows(chunk: string): string[] {
  const frame = chunk.replace(LEADING_CONTROL, "");
  return frame.endsWith("\n") ? frame.slice(0, -1).split("\n") : frame.split("\n");
}

/** The writes that turn `shown` into `rows` on a terminal `height` rows tall.
 *  Pure — exported for tests. `full` repaints every row (first frame, resize). */
export function diffWrites(shown: readonly string[], rows: readonly string[], height: number, full: boolean): string {
  const out: string[] = [`${ESC}[?2026h`];
  if (full) out.push(`${ESC}[2J`);
  const n = Math.min(rows.length, height);
  for (let i = 0; i < n; i++) {
    const row = rows[i] ?? "";
    if (!full && shown[i] === row) continue;
    // Move, write, reset attributes, erase the rest of the row (a shorter row must not leave the old tail).
    out.push(`${ESC}[${i + 1};1H${row}${ESC}[0m${ESC}[K`);
  }
  // Rows the previous frame had and this one does not.
  if (!full) for (let i = n; i < shown.length && i < height; i++) out.push(`${ESC}[${i + 1};1H${ESC}[2K`);
  // Park the cursor on the last row so a stray write lands harmlessly.
  out.push(`${ESC}[${height};1H`, `${ESC}[?2026l`);
  return out.join("");
}

/**
 * Wrap the real stdout for Ink. `rows`/`columns`/`on("resize")` pass through;
 * `write` is the diff.
 */
export function createFullscreenStdout(real: NodeJS.WriteStream, onFirstPaint?: () => void): FullscreenStream {
  let shown: string[] = [];
  let dirty = true; // first frame paints everything
  let painted = false;

  const emit = (s: string): boolean => real.write(s);

  const paint = (frame: string): void => {
    const rows = frameRows(frame);
    const height = Math.max(1, real.rows || rows.length);
    emit(diffWrites(shown, rows, height, dirty));
    dirty = false;
    shown = rows.slice(0, height);
    if (!painted) { painted = true; onFirstPaint?.(); }
  };

  const write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    if (typeof chunk !== "string") return (real.write as (c: Uint8Array, ...r: unknown[]) => boolean).call(real, chunk, ...rest);
    if (ONLY_CONTROL.test(chunk)) {
      // Cursor show/hide pass through; an erase-only write (Ink's clear) is a no-op —
      // the next frame paints whatever replaces it.
      if (/\u001b\[\?25[hl]/.test(chunk)) return emit(chunk.replace(/\u001b\[[0-9;]*[KAJGH]/g, ""));
      return true;
    }
    const frame = chunk.replace(LEADING_CONTROL, "");
    if (!frame.includes("\n")) return emit(frame); // not a frame — pass through as-is
    paint(frame);
    return true;
  };

  const invalidate = (): void => { dirty = true; };
  real.on("resize", invalidate);

  return new Proxy(real, {
    get(target, key, receiver) {
      if (key === "write") return write;
      if (key === "invalidate") return invalidate;
      const v = Reflect.get(target, key, receiver) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as FullscreenStream;
}
