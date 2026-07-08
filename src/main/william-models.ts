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
import { serverGetAuthed } from "./auth";

export interface WilliamModelEntry {
  id: string;
  name: string;
  file: string;
  size: number;
  sha256: string;
  context: number;
  minRamGB: number;
  default: boolean;
  url: string;
}

let downloading: Promise<string> | null = null;

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
function pickModel(models: WilliamModelEntry[]): WilliamModelEntry | null {
  const ramGB = Math.round(require("node:os").totalmem() / 1e9);
  const fits = models.filter((m) => ramGB >= m.minRamGB);
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
  const model = pickModel(models);
  if (!model) {
    const min = Math.min(...models.map((m) => m.minRamGB));
    throw new Error(`this machine is below William's smallest tier (${min}GB RAM needed) — the hosted tier lands soon`);
  }

  const dest = join(modelsDir(), model.file);
  if (existsSync(dest) && statSync(dest).size === model.size) return dest;

  const tmp = join(modelsDir(), `.downloading-${model.file}`);
  try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* stale */ }

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
