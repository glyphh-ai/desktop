/**
 * office-export.ts — Glyphh Office PDF export.
 *
 *   kind "slides"   — render the deck offscreen at full 1920×1080, capture
 *                     every VISIBLE slide (hidden ones are stripped) fully
 *                     revealed, and print an image-per-page 16:9 PDF.
 *   kind "doc-html" — the Docs panel sends its RENDERED document HTML; it
 *                     prints on US Letter with 1in margins (real text PDF).
 *
 * Both finish with a save dialog (default: ~/Downloads) and reveal the file
 * in the Finder on success.
 */

import { BrowserWindow, app, dialog, ipcMain, shell } from "electron";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { readGPoint, stripHiddenSlides } from "./gpoints";

const dataUrl = (html: string): string =>
  `data:text/html;base64,${Buffer.from(html, "utf8").toString("base64")}`;

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
    await win.loadURL(dataUrl(stripHiddenSlides(html)));
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
      pages.push(image.toPNG().toString("base64"));
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
    await win.loadURL(dataUrl(html));
    return await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
  } finally {
    win.destroy();
  }
}

function slidesPrintDoc(pages: string[]): string {
  const imgs = pages.map((b64) => `<div class="page"><img src="data:image/png;base64,${b64}"></div>`).join("");
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

async function savePdf(pdf: Buffer, suggestedName: string): Promise<{ ok: boolean; path?: string; canceled?: boolean }> {
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: join(app.getPath("downloads"), suggestedName),
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (canceled || !filePath) return { ok: true, canceled: true };
  await fsp.writeFile(filePath, pdf);
  shell.showItemInFolder(filePath);
  return { ok: true, path: filePath };
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
          await win.loadURL(dataUrl(docPrintDoc(title, html)));
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
