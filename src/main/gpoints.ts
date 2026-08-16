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

// ── The canonical deck shell ─────────────────────────────────────────────────
// Deterministic control, stochastic data: the agent authors ONLY the
// <section class="slide"> content; THIS shell owns everything a deck must get
// right — the 1920×1080 stage with pure-CSS scaling (min(100vw/1920,
// 100vh/1080): the browser's layout engine rescales in any embed, no JS
// timing to get wrong), frag build-steps, the progress bar, and the exact
// nav contract the Slides reader/presenter drive (arrows/space/click, Home/
// End, #sN hash deep-links with frags revealed).
export function buildDeckDocument(title: string, slidesHtml: string): string {
  const esc = title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: #0d0d0f; }
  body { font-family: Inter, -apple-system, system-ui, sans-serif; color: #f1f1f1;
         -webkit-font-smoothing: antialiased; }
  /* The stage is a FIXED 1920×1080 canvas; CSS alone scales it to fit
     whatever surface renders it (panel, popout, fullscreen). */
  #stage { position: absolute; left: 50%; top: 50%; width: 1920px; height: 1080px;
           transform: translate(-50%, -50%) scale(min(calc(100vw / 1920), calc(100vh / 1080))); }
  .slide { position: absolute; inset: 0; opacity: 0; visibility: hidden;
           transition: opacity .5s ease; overflow: hidden; }
  .slide.on { opacity: 1; visibility: visible; }
  .frag { opacity: 0; transform: translateY(14px);
          transition: opacity .5s ease, transform .5s ease; }
  .slide.on .frag.show { opacity: 1; transform: none; }
  #prog { position: fixed; left: 0; bottom: 0; height: 3px; width: 0; z-index: 9;
          background: #8c3bf2; transition: width .3s ease; }
</style></head>
<body>
<div id="stage">
${slidesHtml}
</div>
<div id="prog"></div>
<script>
(() => {
  const slides = [...document.querySelectorAll(".slide")];
  const prog = document.getElementById("prog");
  let cur = 0;
  const frags = (i) => [...slides[i].querySelectorAll(".frag")];
  const shown = (i) => frags(i).filter((f) => f.classList.contains("show"));
  function goto(i, revealAll) {
    i = Math.max(0, Math.min(slides.length - 1, i));
    slides.forEach((s, k) => s.classList.toggle("on", k === i));
    if (revealAll) frags(i).forEach((f) => f.classList.add("show"));
    else if (i !== cur) frags(i).forEach((f) => f.classList.remove("show"));
    cur = i;
    if (prog && slides.length > 1) prog.style.width = (i / (slides.length - 1) * 100) + "%";
    try { location.hash = "s" + (i + 1); } catch (e) { /* srcdoc */ }
  }
  function next() {
    const fs = frags(cur), sh = shown(cur);
    if (sh.length < fs.length) {
      const nxt = fs.find((f) => !f.classList.contains("show"));
      const step = nxt.dataset.step;
      if (step === undefined) nxt.classList.add("show");
      else fs.filter((f) => !f.classList.contains("show") && f.dataset.step === step)
             .forEach((f) => f.classList.add("show"));
    } else goto(cur + 1);
  }
  function prev() {
    const sh = shown(cur);
    if (sh.length) {
      const last = sh[sh.length - 1], step = last.dataset.step;
      (step === undefined ? [last] : sh.filter((f) => f.dataset.step === step))
        .forEach((f) => f.classList.remove("show"));
    } else { goto(cur - 1); frags(cur).forEach((f) => f.classList.add("show")); }
  }
  addEventListener("keydown", (e) => {
    if (["ArrowRight", " ", "PageDown", "Enter"].includes(e.key)) { e.preventDefault(); next(); }
    else if (["ArrowLeft", "PageUp", "Backspace"].includes(e.key)) { e.preventDefault(); prev(); }
    else if (e.key === "Home") goto(0);
    else if (e.key === "End") goto(slides.length - 1, true);
  });
  addEventListener("click", (e) => { if (!e.target.closest("a")) next(); });
  const m = location.hash.match(/^#s(\\d+)$/);
  goto(m ? +m[1] - 1 : 0, !!m);
})();
</script>
</body></html>
`;
}

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

// ── Per-slide surgery (string level — a DOM round-trip could mangle a
// hand-authored deck). A slide's span runs from its <section class="slide">
// open tag to the first </section> after it (the format never nests
// sections). Mirrors the renderer's wb-gpoint helpers; indexes are 0-based
// here — the TOOLS take 1-based and convert.
export interface SlideSpan { start: number; openEnd: number; end: number; hidden: boolean }
export function slideSpans(html: string): SlideSpan[] {
  const re = /<section[^>]*class="[^"]*\bslide\b[^"]*"[^>]*>/gi;
  const spans: SlideSpan[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const close = html.indexOf("</section>", re.lastIndex);
    if (close < 0) break;
    spans.push({ start: m.index, openEnd: m.index + m[0].length, end: close + "</section>".length, hidden: /\bdata-gp-hidden\b/.test(m[0]) });
    re.lastIndex = close;
  }
  return spans;
}
export function removeSlideAt(html: string, i: number): string {
  const s = slideSpans(html)[i];
  return s ? html.slice(0, s.start) + html.slice(s.end) : html;
}
export function replaceSlideAt(html: string, i: number, sectionHtml: string): string {
  const s = slideSpans(html)[i];
  return s ? html.slice(0, s.start) + sectionHtml + html.slice(s.end) : html;
}
/** Insert BEFORE 0-based index i (i >= count appends after the last slide). */
export function insertSlideAt(html: string, i: number, sectionHtml: string): string {
  const spans = slideSpans(html);
  if (!spans.length) return html;
  if (i >= spans.length) {
    const last = spans[spans.length - 1]!;
    return html.slice(0, last.end) + "\n" + sectionHtml + html.slice(last.end);
  }
  const s = spans[Math.max(0, i)]!;
  return html.slice(0, s.start) + sectionHtml + "\n" + html.slice(s.start);
}
export function setSlideHiddenAt(html: string, i: number, hidden: boolean): string {
  const s = slideSpans(html)[i];
  if (!s || s.hidden === hidden) return html;
  const open = html.slice(s.start, s.openEnd);
  const next = hidden
    ? open.replace(/^<section/i, '<section data-gp-hidden="1"')
    : open.replace(/\s*data-gp-hidden(="[^"]*")?/i, "");
  return html.slice(0, s.start) + next + html.slice(s.openEnd);
}
export function setDeckTitle(html: string, title: string): string {
  const esc = title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return /<title[^>]*>[\s\S]*?<\/title>/i.test(html)
    ? html.replace(/<title[^>]*>[\s\S]*?<\/title>/i, `<title>${esc}</title>`)
    : html.replace(/<head[^>]*>/i, (m) => `${m}<title>${esc}</title>`);
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
