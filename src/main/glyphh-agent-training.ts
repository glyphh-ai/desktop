/**
 * Glyphh training capture — the flywheel back into the model.
 *
 * Every agent run (full message transcript: system + memory + history +
 * constrained turns + tool observations + final) and every Ada-enricher
 * pair (prose fact → schema slots) appends to local, daily-rotated JSONL
 * under userData/glyphh/training/. This is exactly the Track B "operate"
 * data the next glyphh agent training run consumes — guess→rejection→
 * recovery sequences especially. INTERNAL ONLY: users don't train their
 * own Glyphh (they receive released weights via the model manifest), so
 * capture is gated by the GLYPHH_TRAINING_CAPTURE env var — off in every
 * end-user build, on in our dev script.
 */

import { app } from "electron";
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function trainingDir(): string {
  const d = join(app.getPath("userData"), "glyphh", "training");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

const enabled = () => process.env.GLYPHH_TRAINING_CAPTURE === "1";
const fileFor = (kind: string) => join(trainingDir(), `${kind}-${new Date().toISOString().slice(0, 10)}.jsonl`);

function append(kind: string, record: Record<string, unknown>): void {
  if (!enabled()) return;
  try {
    appendFileSync(fileFor(kind), JSON.stringify({ ts: Date.now(), ...record }) + "\n");
  } catch { /* capture must never break a run */ }
}

export const captureRun = (record: Record<string, unknown>): void => append("runs", record);
export const captureEnrich = (record: Record<string, unknown>): void => append("enrich", record);

