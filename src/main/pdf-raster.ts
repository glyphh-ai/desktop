/**
 * pdf-raster.ts — multi-page PDF → PNGs, in-toolbox and cross-platform.
 *
 * The agent's `pdf_pages` tool. A hidden window runs pdf.js (the
 * pdf-raster.html harness), so rasterization needs NOTHING from the OS — no
 * Ghostscript, no poppler, no Quartz — and behaves identically on macOS,
 * Windows and Linux. Bytes go in over executeJavaScript in chunks; pages come
 * back one at a time as PNG data URLs and land as files, so memory stays
 * bounded on hundred-page documents.
 */

import { promises as fsp } from "node:fs";
import { basename, dirname, join } from "node:path";
import { BrowserWindow } from "electron";

/** Rasterizer input ceiling — matches the deck store's own 100MB cap. */
const MAX_PDF_BYTES = 100 * 1024 * 1024;
/** Base64 characters per executeJavaScript call. */
const CHUNK = 4 * 1024 * 1024;
/** Hard page ceiling — a rogue 10k-page document is a hang, not a job. */
const MAX_PAGES = 200;

export interface RasterizeResult {
  /** Directory the PNGs were written into (`<stem>-pages/` beside the PDF). */
  dir: string;
  files: string[];
  pageCount: number;
  rendered: number;
}

export async function rasterizePdf(absPath: string, opts: { dpi?: number; pages?: number } = {}): Promise<RasterizeResult> {
  const bytes = await fsp.readFile(absPath);
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw new Error(`PDF is ${Math.round(bytes.byteLength / 1e6)}MB — the rasterizer caps at ${Math.round(MAX_PDF_BYTES / 1e6)}MB`);
  }
  const dpi = Math.min(Math.max(opts.dpi ?? 150, 36), 300);
  const scale = dpi / 72;
  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await win.loadFile(join(__dirname, "..", "renderer", "pdf-raster.html"));
    const b64 = bytes.toString("base64");
    for (let i = 0; i < b64.length; i += CHUNK) {
      await win.webContents.executeJavaScript(`window.__pdfChunk(${JSON.stringify(b64.slice(i, i + CHUNK))})`);
    }
    const pageCount = (await win.webContents.executeJavaScript(`window.__pdfOpen()`)) as number;
    const cap = Math.min(pageCount, Math.max(1, Math.min(opts.pages ?? pageCount, MAX_PAGES)));
    const stem = basename(absPath).replace(/\.pdf$/i, "") || "pdf";
    const dir = join(dirname(absPath), `${stem}-pages`);
    await fsp.mkdir(dir, { recursive: true });
    const pad = cap >= 100 ? 3 : 2;
    const files: string[] = [];
    for (let n = 1; n <= cap; n++) {
      const dataUrl = (await win.webContents.executeJavaScript(`window.__pdfPage(${n}, ${scale})`)) as string;
      const m = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl));
      if (!m) throw new Error(`page ${n}: unexpected render output`);
      const out = join(dir, `page-${String(n).padStart(pad, "0")}.png`);
      await fsp.writeFile(out, Buffer.from(m[1]!, "base64"));
      files.push(out);
    }
    return { dir, files, pageCount, rendered: cap };
  } finally {
    win.destroy();
  }
}
