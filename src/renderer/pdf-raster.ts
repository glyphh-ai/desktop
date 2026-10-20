/**
 * pdf-raster.ts — the rasterizer harness page (pdf-raster.html).
 *
 * Runs pdf.js inside a hidden window so the MAIN process can rasterize any PDF
 * into per-page PNGs with zero native dependencies — the capability agents kept
 * probing the OS for (sips is page-1-only; Ghostscript/poppler aren't
 * installed; the Swift/JXA tricks are macOS-only). Driven entirely through
 * executeJavaScript:
 *
 *   __pdfChunk(b64)      — append a base64 chunk of the PDF bytes
 *   __pdfOpen()          — decode + open; resolves the page count
 *   __pdfPage(n, scale)  — render 1-based page n at scale (dpi/72) → PNG data URL
 *
 * Bytes arrive in chunks because one executeJavaScript call with an 80MB
 * string is where Chromium gets unhappy; each chunk decodes immediately so the
 * base64 never lives twice in memory.
 */

import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist";

// The worker bundle sits beside this page in dist/renderer (see
// build:code-workbench). pdf.js spawns it as a module worker.
GlobalWorkerOptions.workerSrc = new URL("pdf-raster-worker.js", location.href).toString();

let parts: Uint8Array[] = [];
let doc: PDFDocumentProxy | null = null;

function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const g = window as unknown as {
  __pdfChunk?: (b64: string) => number;
  __pdfOpen?: () => Promise<number>;
  __pdfPage?: (n: number, scale: number) => Promise<string>;
};

g.__pdfChunk = (b64: string): number => {
  parts.push(decode(b64));
  return parts.length;
};

g.__pdfOpen = async (): Promise<number> => {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { bytes.set(p, at); at += p.length; }
  parts = [];
  doc = await getDocument({ data: bytes }).promise;
  return doc.numPages;
};

g.__pdfPage = async (n: number, scale: number): Promise<string> => {
  if (!doc) throw new Error("no document open — __pdfOpen first");
  const page = await doc.getPage(n);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const canvasContext = canvas.getContext("2d");
  if (!canvasContext) throw new Error("canvas 2d context unavailable");
  await page.render({ canvas, canvasContext, viewport }).promise;
  const url = canvas.toDataURL("image/png");
  page.cleanup();
  return url;
};
