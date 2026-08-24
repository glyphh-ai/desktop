/**
 * design.ts — GLYPHH DESIGN, the desktop transport + the agent's extraction
 * helpers. Design systems live in the ORG library via the SDK (documents +
 * assets in R2, indexed per-org); this module is the IPC surface the panel
 * rides plus the two DETERMINISTIC extractors the agent's tools lean on:
 *
 *   extractSiteDesign(url)  — fetch a page (+ its first stylesheets) and count
 *                             the colors/fonts/radii it actually uses
 *   imagePalette(path)      — dominant colors of a local image, quantized
 *
 * Both return EVIDENCE for the model to judge, never a finished system.
 */

import { readFile } from "node:fs/promises";
import { ipcMain, nativeImage } from "electron";
import { getClient } from "./glyphh-client";
import type { DesignSystem } from "@glyphh/sdk";

export function designFileName(name: unknown): string {
  const base = String(name ?? "").trim().split(/[\\/]/).pop() ?? "";
  const stem = base.replace(/\.json$/i, "").replace(/[^\w\s.-]/g, "").trim().replace(/\s+/g, "-").toLowerCase();
  if (!stem) throw new Error("a design needs a name");
  return `${stem}.json`;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ── Site extraction — colors/fonts/radii a page actually uses ────────────────

const HEX_RE = /#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/gi;
const FONT_RE = /font-family\s*:\s*([^;}{]+)[;}]/gi;
const RADIUS_RE = /border-radius\s*:\s*(\d+(?:\.\d+)?)px/gi;
const CSS_LINK_RE = /<link[^>]+rel=["']stylesheet["'][^>]*>/gi;
const HREF_RE = /href=["']([^"']+)["']/i;

const NEUTRAL = (hex: string): boolean => {
  const h = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
  const r = parseInt(h.slice(1, 3), 16), g = parseInt(h.slice(3, 5), 16), b = parseInt(h.slice(5, 7), 16);
  return Math.max(r, g, b) - Math.min(r, g, b) < 16;
};

export interface SiteDesignEvidence {
  url: string;
  /** Hex → occurrence count, most used first; neutrals flagged. */
  colors: Array<{ hex: string; count: number; neutral: boolean }>;
  fonts: Array<{ family: string; count: number }>;
  radii: Array<{ px: number; count: number }>;
  googleFonts: string[];
}

/** Fetch a page + up to 5 of its stylesheets and COUNT what they use. */
export async function extractSiteDesign(rawUrl: string): Promise<SiteDesignEvidence> {
  const url = new URL(String(rawUrl));
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http(s) URLs");
  const fetchText = async (u: string): Promise<string> => {
    const res = await fetch(u, { headers: { "user-agent": "Mozilla/5.0 (Glyphh Design)" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${u} → ${res.status}`);
    return (await res.text()).slice(0, 2_000_000);
  };
  const html = await fetchText(url.href);
  const cssTexts: string[] = [html];
  const links = [...html.matchAll(CSS_LINK_RE)].map((m) => HREF_RE.exec(m[0])?.[1]).filter((h): h is string => !!h).slice(0, 5);
  for (const href of links) {
    try { cssTexts.push(await fetchText(new URL(href, url.href).href)); } catch { /* a 403'd stylesheet is missing evidence, not failure */ }
  }
  const corpus = cssTexts.join("\n");

  const colorCounts = new Map<string, number>();
  for (const m of corpus.matchAll(HEX_RE)) {
    const hex = m[0].toLowerCase();
    colorCounts.set(hex, (colorCounts.get(hex) ?? 0) + 1);
  }
  const fontCounts = new Map<string, number>();
  for (const m of corpus.matchAll(FONT_RE)) {
    const first = (m[1] ?? "").split(",")[0]?.trim().replace(/["']/g, "");
    if (first && !/^(inherit|initial|unset|var\()/.test(first)) {
      fontCounts.set(first, (fontCounts.get(first) ?? 0) + 1);
    }
  }
  const radiusCounts = new Map<number, number>();
  for (const m of corpus.matchAll(RADIUS_RE)) {
    const px = Math.round(Number(m[1]));
    radiusCounts.set(px, (radiusCounts.get(px) ?? 0) + 1);
  }
  const googleFonts = [...new Set(
    [...corpus.matchAll(/fonts\.googleapis\.com\/css2?\?[^"')\s]*family=([^&"')\s:]+)/g)]
      .map((m) => decodeURIComponent((m[1] ?? "").replace(/\+/g, " "))),
  )];

  const top = <K,>(map: Map<K, number>, n: number): Array<[K, number]> =>
    [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  return {
    url: url.href,
    colors: top(colorCounts, 24).map(([hex, count]) => ({ hex, count, neutral: NEUTRAL(hex) })),
    fonts: top(fontCounts, 10).map(([family, count]) => ({ family, count })),
    radii: top(radiusCounts, 8).map(([px, count]) => ({ px, count })),
    googleFonts,
  };
}

// ── Image palette — dominant colors, quantized 4 bits/channel ────────────────

export async function imagePalette(path: string): Promise<Array<{ hex: string; share: number }>> {
  const img = nativeImage.createFromBuffer(await readFile(String(path)));
  if (img.isEmpty()) throw new Error("not a readable image");
  const small = img.resize({ width: 96 });
  const { width, height } = small.getSize();
  const bmp = small.toBitmap(); // BGRA
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  let opaque = 0;
  for (let i = 0; i + 3 < bmp.length; i += 4) {
    const a = bmp[i + 3]!;
    if (a < 128) continue;
    opaque++;
    const b = bmp[i]!, g = bmp[i + 1]!, r = bmp[i + 2]!;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const cur = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    cur.count++; cur.r += r; cur.g += g; cur.b += b;
    buckets.set(key, cur);
  }
  if (!opaque || !width || !height) throw new Error("image has no opaque pixels");
  return [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .map((c) => ({
      hex: `#${[c.r, c.g, c.b].map((v) => Math.round(v / c.count).toString(16).padStart(2, "0")).join("")}`,
      share: Math.round((c.count / opaque) * 1000) / 10,
    }));
}

// ── IPC — the panel's transport ──────────────────────────────────────────────

export function registerDesignIpc(): void {
  ipcMain.handle("design-list", async () => {
    try {
      const designs = (await getClient().designs.list()).map((m) => ({
        file: m.file, title: m.title, size: m.sizeBytes, mtime: Date.parse(m.updatedAt) || 0,
      }));
      return { ok: true, designs };
    } catch (err) {
      return { ok: false, error: errText(err), designs: [] };
    }
  });
  ipcMain.handle("design-read", async (_e, name: unknown) => {
    try {
      const d = await getClient().designs.get(designFileName(name));
      return { ok: true, title: d.title, document: d.document };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
  ipcMain.handle("design-write", async (_e, name: unknown, document: unknown) => {
    try {
      const meta = await getClient().designs.put(designFileName(name), document as DesignSystem);
      return { ok: true, file: meta.file, title: meta.title };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
  ipcMain.handle("design-delete", async (_e, name: unknown) => {
    try {
      await getClient().designs.delete(designFileName(name));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
  ipcMain.handle("design-asset-upload", async (_e, name: unknown, input: unknown) => {
    try {
      const a = input as { id?: string; kind: "logo" | "icon" | "image"; title: string; contentType: string; dataBase64: string };
      const entry = await getClient().designs.uploadAsset(designFileName(name), a);
      return { ok: true, asset: entry };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
  // Asset bytes ride IPC as a data URL — the panel <img> renders it directly;
  // the session bearer never reaches the renderer.
  ipcMain.handle("design-asset-url", async (_e, name: unknown, assetId: unknown) => {
    try {
      const file = designFileName(name);
      const d = await getClient().designs.get(file);
      const entry = (d.document.assets ?? []).find((x) => x.id === String(assetId));
      if (!entry) throw new Error("asset not found");
      const bytes = await getClient().designs.assetBytes(file, entry.id);
      return { ok: true, url: `data:${entry.contentType};base64,${Buffer.from(bytes).toString("base64")}` };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
  ipcMain.handle("design-asset-delete", async (_e, name: unknown, assetId: unknown) => {
    try {
      await getClient().designs.deleteAsset(designFileName(name), String(assetId));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
}
