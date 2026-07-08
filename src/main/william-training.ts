/**
 * William training capture — the flywheel back into the model.
 *
 * Every agent run (full message transcript: system + memory + history +
 * constrained turns + tool observations + final) and every Ada-enricher
 * pair (prose fact → schema slots) appends to local, daily-rotated JSONL
 * under userData/william/training/. This is exactly the Track B "operate"
 * data the next glyphh-william training run consumes — guess→rejection→
 * recovery sequences especially. Local only; toggle in Settings → William
 * (williamTrainingCapture, default on).
 */

import { app } from "electron";
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getPreference } from "./stores/preferences-db";

export function trainingDir(): string {
  const d = join(app.getPath("userData"), "william", "training");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

const enabled = () => getPreference<boolean>("williamTrainingCapture", true) !== false;
const fileFor = (kind: string) => join(trainingDir(), `${kind}-${new Date().toISOString().slice(0, 10)}.jsonl`);

function append(kind: string, record: Record<string, unknown>): void {
  if (!enabled()) return;
  try {
    appendFileSync(fileFor(kind), JSON.stringify({ ts: Date.now(), ...record }) + "\n");
  } catch { /* capture must never break a run */ }
}

export const captureRun = (record: Record<string, unknown>): void => append("runs", record);
export const captureEnrich = (record: Record<string, unknown>): void => append("enrich", record);

export function trainingStats(): { files: number; bytes: number; dir: string; enabled: boolean } {
  const d = trainingDir();
  let files = 0, bytes = 0;
  try {
    for (const f of readdirSync(d)) {
      if (!f.endsWith(".jsonl")) continue;
      files++;
      try { bytes += statSync(join(d, f)).size; } catch { /* racing rotation */ }
    }
  } catch { /* dir gone */ }
  return { files, bytes, dir: d, enabled: enabled() };
}
