/**
 * gpoints.ts — Glyphh Office · SLIDES, the desktop transport.
 *
 * A deck is ONE self-contained HTML document (shared/deck-document.ts owns
 * the shell, the structure lock and the per-slide surgery). Decks live in the
 * member library — the deck record and its `deck.html` as the one file
 * (shared/house-store.ts; his order, 2026-10-06: cloud is the one home).
 *
 * There is NO edit surface anywhere — the agent authors decks (create_gpoint /
 * delete_gpoint tools); the Slides panel lists, opens, presents and deletes.
 */

import { ipcMain } from "electron";
import { broadcast } from "./broadcast";
import { houseStore } from "./house-store.js";
import { deckFileName } from "../shared/deck-document.js";

export {
  buildDeckDocument, importDeckHtml, insertSlideAt, lockDeckSections, normalizeDeckHtml, removeSlideAt, replaceSlideAt,
  setDeckTitle, setSlideHiddenAt, slideSpans, stripHiddenSlides, type SlideSpan,
} from "../shared/deck-document.js";

export interface GPointMeta {
  /** Bare filename in the library, e.g. "q3-review.html". */
  file: string;
  title: string;
  slides: number;
  mtime: number;
  size: number;
}

/** Deck refs are bare names — the store's own rule, under the name the tools call. */
export const gpointFileName = deckFileName;

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const unwrap = <T extends { ok: boolean; error?: string }>(r: T): Exclude<T, { ok: false }> => {
  if (!r.ok) throw new Error(r.error ?? "failed");
  return r as Exclude<T, { ok: false }>;
};

// ── Write-through cache: OUR just-written bytes are authoritative ──────────────
// The deck store (R2) is eventually consistent on OVERWRITE — a GET issued right
// after a PUT can return the PREVIOUS bytes. A surgical pass that edits slide 6
// then slide 2 in separate update_slides calls therefore rebased slide 2 on a
// stale deck and WIPED the slide-6 edit (his report, 2026-09-08: deleting/editing
// one slide reverted another). All agent slide ops run in THIS process, so a
// write-through cache keyed by file makes a follow-up read see the bytes we just
// stored. Only WRITES populate it (they're authoritative); reads prefer it within
// a short window that covers an editing pass, then fall back to the store.
const deckCache = new Map<string, { html: string; at: number }>();
const DECK_CACHE_TTL_MS = 30_000;

export async function listGPoints(): Promise<GPointMeta[]> {
  return unwrap(await houseStore().gpointList()).decks;
}

export async function readGPoint(name: unknown): Promise<string> {
  const file = deckFileName(name);
  const hit = deckCache.get(file);
  if (hit && Date.now() - hit.at < DECK_CACHE_TTL_MS) return hit.html;
  return unwrap(await houseStore().gpointRead(file)).content;
}

export async function writeGPoint(name: unknown, html: string): Promise<{ file: string; path: string; slides: number }> {
  // Every save passes the STRUCTURE LOCK in the store — agent or import, no
  // exceptions — and the store hands back the EXACT bytes it now holds, so the
  // next readGPoint in this pass rebases on them, not on an eventually-consistent GET.
  const r = unwrap(await houseStore().gpointWrite(name, html));
  deckCache.set(r.file, { html: r.html, at: Date.now() });
  // Tell every renderer: the Slides panel caches deck HTML per session and
  // otherwise keeps showing the pre-write deck (the one-slide starter) until
  // a restart.
  broadcast("gpoint-changed", r.file);
  return { file: r.file, path: `Drive/${r.file}`, slides: r.slides };
}

export async function deleteGPoint(name: unknown): Promise<void> {
  const file = deckFileName(name);
  deckCache.delete(file);
  unwrap(await houseStore().gpointDelete(file));
  broadcast("gpoint-changed", file);
}

/** The Slides panel's transport: list the library, read a deck's HTML for the
 *  reader/presenter iframes, delete (the renderer confirms first). */
export function registerGPointIpc(): void {
  ipcMain.handle("gpoint-list", () => houseStore().gpointList());
  ipcMain.handle("gpoint-read", async (_e, name: unknown) => {
    try { return { ok: true, content: await readGPoint(name) }; }
    catch (err) { return { ok: false, error: errText(err) }; }
  });
  ipcMain.handle("gpoint-delete", async (_e, name: unknown) => {
    try { await deleteGPoint(name); return { ok: true }; }
    catch (err) { return { ok: false, error: errText(err) }; }
  });
  // The panel's ONE write: per-slide hide/delete re-saves the whole deck
  // document (decks stay agent-authored; this is surgery, not an editor).
  // ＋ New in the panel: a one-slide starter through the CANONICAL shell —
  // the panel never writes its own harness (same law as the agent tools).
  ipcMain.handle("gpoint-new", async (_e, name: unknown, title: unknown) => {
    const r = await houseStore().gpointNew(name, title);
    if (r.ok) { deckCache.delete(r.file); broadcast("gpoint-changed", r.file); }
    return r;
  });
  ipcMain.handle("gpoint-write", async (_e, name: unknown, html: unknown) => {
    try { await writeGPoint(name, String(html ?? "")); return { ok: true }; }
    catch (err) { return { ok: false, error: errText(err) }; }
  });
}
