/**
 * office-export.ts — Glyphh Office PDF export.
 *
 *   kind "slides"   — render the deck offscreen at full 1920×1080, capture
 *                     every VISIBLE slide (hidden ones are stripped) fully
 *                     revealed, and print an image-per-page 16:9 PDF.
 *   kind "doc-html" — the Docs panel sends its RENDERED document HTML; it
 *                     prints on US Letter with 1in margins (real text PDF).
 *
 * Both render HERE (an offscreen window; the web has none) and the PDF lands
 * in Drive as a `file` record of the member library (his order, 2026-10-06:
 * cloud is the one home) — the Drive panel opens or downloads it from there.
 */

import { BrowserWindow, ipcMain } from "electron";
import { promises as fsp } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { marked } from "marked";
import { readGPoint, stripHiddenSlides } from "./gpoints";
import { gdocFileName } from "./office-docs";
import { readDoc } from "./office-store";
import { houseStore } from "./house-store.js";

/** Load HTML into a window via a TEMP FILE, not a data: URL. A base64 data URL
 *  has a hard length ceiling in Chromium, so a big/image-heavy deck (media
 *  inlined as data URIs, or a page-per-slide print doc) failed `loadURL`
 *  outright — "PDF export choked on the deck size" (his report, 2026-09-08). A
 *  file has no such limit. Cleaned up once loaded (the page is in memory). */
async function loadHtml(win: BrowserWindow, html: string): Promise<void> {
  const p = join(tmpdir(), `glyphh-export-${randomBytes(8).toString("hex")}.html`);
  await fsp.writeFile(p, html, "utf8");
  try { await win.loadFile(p); }
  finally { await fsp.unlink(p).catch(() => { /* temp — best effort */ }); }
}

async function offscreen(width: number, height: number): Promise<BrowserWindow> {
  return new BrowserWindow({
    width, height, show: false, frame: false,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
}

/** Every visible slide as a full-resolution PNG data URL. */
async function captureSlides(html: string): Promise<string[]> {
  const win = await offscreen(1920, 1080);
  try {
    await loadHtml(win, stripHiddenSlides(html));
    await win.webContents.executeJavaScript(
      `new Promise((r) => { const s = document.createElement("style");
         s.textContent = "*{transition:none!important;animation:none!important}";
         document.head.appendChild(s); requestAnimationFrame(() => r(document.querySelectorAll(".slide").length)); })`,
    );
    const count = (await win.webContents.executeJavaScript(`document.querySelectorAll(".slide").length`)) as number;
    const pages: string[] = [];
    for (let i = 0; i < count; i++) {
      await win.webContents.executeJavaScript(
        `(() => { const ss = document.querySelectorAll(".slide");
           ss.forEach((s, k) => { s.classList.toggle("on", k === ${i});
             if (k === ${i}) s.querySelectorAll(".frag").forEach((f) => f.classList.add("show")); }); })()`,
      );
      await new Promise((r) => setTimeout(r, 90));   // let the compositor paint
      const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1920, height: 1080 });
      // JPEG, not PNG: a full-res 1920×1080 slide is multi-MB as PNG, so a
      // 20-slide deck's print doc ran to tens of MB and blew memory / the load
      // ceiling. JPEG@92 is visually identical for slides and ~6× smaller.
      pages.push(image.toJPEG(92).toString("base64"));
    }
    return pages;
  } finally {
    win.destroy();
  }
}

/** Print an HTML document to PDF bytes (CSS @page rules decide the paper). */
async function printHtml(html: string): Promise<Buffer> {
  const win = await offscreen(1200, 800);
  try {
    await loadHtml(win, html);
    return await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
  } finally {
    win.destroy();
  }
}

function slidesPrintDoc(pages: string[]): string {
  const imgs = pages.map((b64) => `<div class="page"><img src="data:image/jpeg;base64,${b64}"></div>`).join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    @page { size: 13.333in 7.5in; margin: 0; }
    html, body { margin: 0; padding: 0; }
    .page { width: 13.333in; height: 7.5in; page-break-after: always; }
    .page:last-child { page-break-after: auto; }
    img { display: block; width: 100%; height: 100%; }
  </style></head><body>${imgs}</body></html>`;
}

function docPrintDoc(title: string, bodyHtml: string): string {
  const esc = title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc}</title><style>
    @page { size: Letter; margin: 1in; }
    html, body { margin: 0; padding: 0; background: #fff; }
    body { font-family: Georgia, 'Times New Roman', serif; font-size: 12pt; line-height: 1.6; color: #111; }
    h1, h2, h3, h4 { font-family: Inter, -apple-system, system-ui, sans-serif; line-height: 1.25; }
    h1 { font-size: 24pt; } h2 { font-size: 16pt; margin-top: 20pt; } h3 { font-size: 13pt; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #bbb; padding: 6pt 8pt; text-align: left; }
    code, pre { font-family: ui-monospace, monospace; font-size: 10.5pt; }
    pre { background: #f4f4f4; padding: 8pt; overflow: hidden; white-space: pre-wrap; }
    blockquote { border-left: 3pt solid #ccc; margin-left: 0; padding-left: 12pt; color: #444; }
  </style></head><body>${bodyHtml}</body></html>`;
}

/** The PDF into Drive: one `file` record under a free name, its bytes the one file. */
async function savePdf(pdf: Buffer, name: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  const r = await houseStore().fileAdd(name, new Uint8Array(pdf), "application/pdf");
  return r.ok ? { ok: true, path: `Drive/${r.id}` } : r;
}

/**
 * AGENT entry points — the same rendering pipeline as the panel's File menu,
 * minus the save dialog: bytes come back for the caller to store (the agent
 * tool saves them as a Drive file artifact).
 */
export async function exportDocPdf(name: string): Promise<{ title: string; pdf: Buffer }> {
  const doc = await readDoc(gdocFileName(name));
  const html = await marked.parse(doc.markdown ?? "");
  const title = doc.title || name.replace(/\.md$/i, "");
  return { title, pdf: await printHtml(docPrintDoc(title, String(html))) };
}

export async function exportSlidesPdf(name: string): Promise<{ title: string; pdf: Buffer }> {
  const deck = await readGPoint(name);
  const pages = await captureSlides(deck);
  if (!pages.length) throw new Error("the deck has no visible slides");
  return { title: name.replace(/\.html$/i, ""), pdf: await printHtml(slidesPrintDoc(pages)) };
}

export function registerOfficeExportIpc(): void {
  ipcMain.handle("office-export-pdf", async (_e, req: { kind?: string; file?: string; title?: string; html?: string; print?: boolean } | undefined) => {
    try {
      if (req?.kind === "slides") {
        const file = String(req.file ?? "");
        if (!file) throw new Error("a deck name is required");
        const deck = await readGPoint(file);
        const pages = await captureSlides(deck);
        if (!pages.length) throw new Error("the deck has no visible slides");
        const pdf = await printHtml(slidesPrintDoc(pages));
        return await savePdf(pdf, file.replace(/\.html$/i, "") + ".pdf");
      }
      if (req?.kind === "doc-html") {
        const html = String(req.html ?? "");
        if (!html) throw new Error("document html is required");
        const title = String(req.title ?? "Document");
        if (req.print) {
          // File → Print: the OS print dialog over the same paper document.
          const win = await offscreen(1200, 800);
          await loadHtml(win, docPrintDoc(title, html));
          await new Promise<void>((resolve) => {
            win.webContents.print({}, () => { win.destroy(); resolve(); });
          });
          return { ok: true };
        }
        const pdf = await printHtml(docPrintDoc(title, html));
        return await savePdf(pdf, title.replace(/[\\/:]/g, "-") + ".pdf");
      }
      throw new Error("unknown export kind");
    } catch (err) {
      console.warn("[office-export] failed:", err instanceof Error ? err.message : err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
