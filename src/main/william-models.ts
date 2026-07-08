/**
 * William model delivery (client) — download weights from the manifest.
 *
 * yo-server's /api/william/models returns presigned R2 URLs + sha256; this
 * streams the GGUF to userData/models (hashing as it writes), verifies,
 * and renames into place. Progress broadcasts as william:setup to every
 * panel so the composer spinner can read "Downloading William — 42%".
 * One download at a time; a failed/mismatched file never lands.
 */

import { app, webContents } from "electron";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { serverGetAuthed } from "./auth";
import { getPreference } from "./stores/preferences-db";

export interface WilliamModelEntry {
  id: string;
  name: string;
  file: string;
  size: number;
  sha256: string;
  context: number;
  minRamGB: number;
  default: boolean;
  status?: "available" | "coming" | "hosted";
  creditMultiplier?: number;
  usage?: string;
  url: string | null;
}

let downloading: Promise<string> | null = null;

// ── Manifest cache (disk) — offline resolution + the selector's list ──────
const manifestPath = () => join(app.getPath("userData"), "william", "manifest.json");

const MANIFEST_STALE_MS = 6 * 60 * 60_000;

function saveManifest(models: WilliamModelEntry[]): void {
  try {
    writeFileSync(manifestPath(), JSON.stringify({ at: Date.now(), models: models.map(({ url: _url, ...m }) => m) }));
  } catch { /* best-effort */ }
}

function readManifestFile(): { at: number; models: Array<Omit<WilliamModelEntry, "url">> } {
  try {
    const raw = JSON.parse(readFileSync(manifestPath(), "utf8"));
    if (Array.isArray(raw)) return { at: 0, models: raw }; // pre-freshness format
    return { at: Number(raw?.at) || 0, models: Array.isArray(raw?.models) ? raw.models : [] };
  } catch {
    return { at: 0, models: [] };
  }
}

export function cachedManifest(): Array<Omit<WilliamModelEntry, "url">> {
  return readManifestFile().models;
}

/** Fresh manifest for the selector: refetch when the cache is empty or
 *  stale (signed-out/offline falls back to whatever the cache holds). */
export async function refreshManifestIfStale(): Promise<Array<Omit<WilliamModelEntry, "url">>> {
  const { at, models } = readManifestFile();
  if (models.length && Date.now() - at < MANIFEST_STALE_MS) return models;
  try {
    const r = await serverGetAuthed<{ ok: boolean; models?: WilliamModelEntry[] }>("/api/william/models");
    if (r.models?.length) {
      saveManifest(r.models);
      return r.models.map(({ url: _url, ...m }) => m);
    }
  } catch { /* signed out / offline */ }
  return models;
}

export function selectedModelId(): string {
  return String(getPreference("williamModel", "auto"));
}

/** The model the client should run: explicit selection when it exists in
 *  the manifest, else the RAM auto-pick. Null when the cache is empty. */
export function resolveDesiredModel(): Omit<WilliamModelEntry, "url"> | null {
  const models = cachedManifest();
  if (!models.length) return null;
  const sel = selectedModelId();
  if (sel !== "auto") {
    const hit = models.find((m) => m.id === sel && (m.status ?? "available") === "available");
    if (hit) return hit;
  }
  return pickModel(models as WilliamModelEntry[]);
}

/** Local file for a manifest entry, when present (userData models dir). */
export function localModelPath(entry: { file: string; size: number }): string | null {
  const p = join(app.getPath("userData"), "models", entry.file);
  try { if (existsSync(p) && statSync(p).size === entry.size) return p; } catch { /* fs race */ }
  return null;
}

function broadcast(data: Record<string, unknown>): void {
  for (const wc of webContents.getAllWebContents()) {
    try { if (!wc.isDestroyed()) wc.send("william:setup", data); } catch { /* gone */ }
  }
}

function modelsDir(): string {
  const d = join(app.getPath("userData"), "models");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

/** Pick the tier for this machine (default tier when RAM allows, else the
 *  smallest that fits; null when nothing fits). */
function pickModel<T extends { minRamGB: number; default: boolean; status?: string }>(models: T[]): T | null {
  const ramGB = Math.round(require("node:os").totalmem() / 1e9);
  const fits = models.filter((m) => (m.status ?? "available") === "available" && ramGB >= m.minRamGB);
  if (!fits.length) return null;
  return fits.find((m) => m.default) ?? fits.sort((a, b) => b.minRamGB - a.minRamGB)[0];
}

/**
 * Ensure a William model exists locally — download if missing. Returns the
 * model path. Single-flight; throws with an actionable message when the
 * manifest is unreachable or the machine is below every tier.
 */
export async function downloadWilliamModel(): Promise<string> {
  if (downloading) return downloading;
  downloading = downloadInner().finally(() => { downloading = null; });
  return downloading;
}

async function downloadInner(): Promise<string> {
  broadcast({ phase: "manifest" });
  const r = await serverGetAuthed<{ ok: boolean; models?: WilliamModelEntry[] }>("/api/william/models");
  const models = r.models || [];
  if (!models.length) throw new Error("no William models published yet");
  saveManifest(models);
  const sel = selectedModelId();
  const avail = models.filter((m) => (m.status ?? "available") === "available");
  const model = (sel !== "auto" && avail.find((m) => m.id === sel)) || pickModel(avail);
  if (!model) {
    const min = Math.min(...models.map((m) => m.minRamGB));
    throw new Error(`this machine is below William's smallest tier (${min}GB RAM needed) — the hosted tier lands soon`);
  }

  const dest = join(modelsDir(), model.file);
  if (existsSync(dest) && statSync(dest).size === model.size) return dest;

  const tmp = join(modelsDir(), `.downloading-${model.file}`);
  try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* stale */ }

  if (!model.url) throw new Error(`model ${model.id} has no download URL (not released)`);
  broadcast({ phase: "downloading", pct: 0, model: model.name });
  const res = await fetch(model.url);
  if (!res.ok || !res.body) throw new Error(`model download failed: HTTP ${res.status}`);

  const hash = createHash("sha256");
  const out = createWriteStream(tmp);
  const reader = res.body.getReader();
  let received = 0;
  let lastPct = -1;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      received += value.length;
      await new Promise<void>((resolve, reject) => {
        out.write(value, (err) => (err ? reject(err) : resolve()));
      });
      const pct = Math.floor((received / model.size) * 100);
      if (pct !== lastPct) {
        lastPct = pct;
        broadcast({
          phase: "downloading",
          pct,
          model: model.name,
          receivedGB: +(received / 1e9).toFixed(2),
          totalGB: +(model.size / 1e9).toFixed(2),
        });
      }
    }
  } finally {
    await new Promise<void>((resolve) => out.end(() => resolve()));
  }

  const digest = hash.digest("hex");
  if (digest !== model.sha256) {
    try { unlinkSync(tmp); } catch { /* partial */ }
    throw new Error("model download corrupted (checksum mismatch) — try again");
  }
  renameSync(tmp, dest);
  broadcast({ phase: "ready", model: model.name });
  return dest;
}
