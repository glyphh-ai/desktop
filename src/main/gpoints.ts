/**
 * gpoints.ts — Glyphh Office · SLIDES, the desktop transport.
 *
 * A deck is ONE self-contained HTML document (the marketing frame format: a
 * fixed 1920×1080 #stage that scales itself, <section class="slide"> pages with
 * #s1…#sN ids, .frag/data-step build steps, built-in keyboard/click nav).
 *
 * Decks live in the ORG'S LIBRARY — R2 behind yo-server, reached through the
 * SDK (`client.officeSlides`) — so every surface (desktop, web, pods) reads the
 * same shelf. Nothing is stored locally (zero-local-storage): the one nod to
 * history is a boot-time migration that uploads any decks a pre-Office build
 * left in ~/.glyphh/gpoints, then retires the folder.
 *
 * There is NO edit surface anywhere — the agent authors decks (create_gpoint /
 * delete_gpoint tools); the Slides panel lists, opens, presents and deletes.
 */

import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ipcMain } from "electron";
import { getClient } from "./glyphh-client";

export interface GPointMeta {
  /** Bare filename in the org library, e.g. "q3-review.html". */
  file: string;
  title: string;
  slides: number;
  mtime: number;
  size: number;
}

/** Deck refs are bare names — strip any path the caller sent and force the
 *  .html extension. Mirrors the server's rule so names round-trip unchanged. */
export function gpointFileName(name: unknown): string {
  const base = String(name ?? "").trim().split(/[\\/]/).pop() ?? "";
  const stem = base.replace(/\.html?$/i, "").replace(/[^\w\s.-]/g, "").trim().replace(/\s+/g, "-").toLowerCase();
  if (!stem) throw new Error("a deck needs a name");
  return `${stem}.html`;
}

interface WireMeta { file: string; title: string; slides: number; sizeBytes: number; updatedAt: string }

const metaOf = (m: WireMeta): GPointMeta => ({
  file: m.file,
  title: m.title,
  slides: m.slides,
  mtime: Date.parse(m.updatedAt) || 0,
  size: m.sizeBytes,
});

// ── One-time local→org migration ─────────────────────────────────────────────
// Pre-Office builds kept decks in ~/.glyphh/gpoints (a zero-local-storage
// violation this module replaces). First library read uploads whatever is
// there, then renames the folder so it never runs again. Upserts are
// idempotent, so a half-finished pass just resumes on the next read.
let migrationDone = false;
async function migrateLocalDecks(): Promise<void> {
  if (migrationDone) return;
  const dir = join(homedir(), ".glyphh", "gpoints");
  let names: string[];
  try {
    names = (await fsp.readdir(dir)).filter((n) => /\.html$/i.test(n));
  } catch {
    migrationDone = true;   // no folder — nothing to migrate, ever
    return;
  }
  // Per-file: an INVALID file (server E_VALIDATION — not a deck) is skipped
  // permanently; an auth/network failure defers the WHOLE pass for a retry on
  // the next read. One bad file must never wedge the import of the good ones.
  const isTransient = (err: unknown): boolean => {
    const msg = err instanceof Error ? err.message : String(err);
    return /unauthenticated|signed out|token|fetch|network|econn|enotfound|timeout|50\d/i.test(msg);
  };
  const client = getClient();
  let uploaded = 0;
  for (const n of names) {
    try {
      const html = await fsp.readFile(join(dir, n), "utf8");
      await client.officeSlides.put(gpointFileName(n), html);
      uploaded++;
    } catch (err) {
      if (isTransient(err)) {
        console.warn("[gpoints] local-deck migration deferred:", err instanceof Error ? err.message : err);
        return;   // folder stays; the next read resumes (upserts are idempotent)
      }
      console.warn(`[gpoints] skipping "${n}" — not a valid deck:`, err instanceof Error ? err.message : err);
    }
  }
  await fsp.rename(dir, `${dir}.migrated`).catch(() => { /* best effort — re-runs are harmless */ });
  migrationDone = true;
  if (uploaded) console.log(`[gpoints] migrated ${uploaded} local deck(s) to the org library`);
}

export async function listGPoints(): Promise<GPointMeta[]> {
  await migrateLocalDecks();
  return (await getClient().officeSlides.list()).map(metaOf);
}

export async function readGPoint(name: unknown): Promise<string> {
  return (await getClient().officeSlides.get(gpointFileName(name))).html;
}

export async function writeGPoint(name: unknown, html: string): Promise<{ file: string; path: string; slides: number }> {
  const meta = await getClient().officeSlides.put(gpointFileName(name), html);
  return { file: meta.file, path: `the org's Slides library (${meta.file})`, slides: meta.slides };
}

export async function deleteGPoint(name: unknown): Promise<void> {
  await getClient().officeSlides.delete(gpointFileName(name));
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The Slides panel's transport: list the org library, read a deck's HTML for
 *  the reader/presenter iframes, delete (the renderer confirms first). */
export function registerGPointIpc(): void {
  ipcMain.handle("gpoint-list", async () => {
    try {
      return { ok: true, decks: await listGPoints() };
    } catch (err) {
      return { ok: false, error: errText(err), decks: [] };
    }
  });
  ipcMain.handle("gpoint-read", async (_e, name: unknown) => {
    try {
      return { ok: true, content: await readGPoint(name) };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
  ipcMain.handle("gpoint-delete", async (_e, name: unknown) => {
    try {
      await deleteGPoint(name);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
  // The panel's ONE write: per-slide hide/delete re-saves the whole deck
  // document (decks stay agent-authored; this is surgery, not an editor).
  ipcMain.handle("gpoint-write", async (_e, name: unknown, html: unknown) => {
    try {
      await writeGPoint(name, String(html ?? ""));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
}
