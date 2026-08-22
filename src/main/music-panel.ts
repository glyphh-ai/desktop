/**
 * music-panel.ts — the MUSIC STUDIO transport: thin IPC over client.music,
 * plus byte-level upload for the panel's two producers — the sound editor's
 * Save-as-New (an edited WAV) and the artist voice recorder (a mic take).
 */

import { getClient } from "./glyphh-client";
import type { MediaKind } from "@glyphh/sdk";

/** One metered IMAGE job, structured — the band builder's brush. */
export async function genImageAsset(prompt: string, title: string): Promise<{ id: string; credits: number }> {
  const models = await getClient().models.available();
  const model = models.find((m) => String((m as { modality?: string }).modality ?? "") === "image");
  if (!model) throw new Error("this org has no enabled image model");
  const started = await getClient().media.generate({ model: model.id, prompt, title, options: { size: "1024x1536" } });
  const job = await getClient().media.waitForJob(started.job.id);
  if (job.status === "failed" || !job.assetId) throw new Error(job.error ?? "image generation failed");
  return { id: job.assetId, credits: job.creditsCharged };
}

/** A member look: FRONT + BACK of the same person, photoreal, stage-ready. */
export async function genLook(name: string, description: string, bandType: string): Promise<{ front: string; back: string; credits: number }> {
  const base = `Photorealistic full-body studio photograph of ${description || name}, member of a ${bandType || "rock"} band, stage outfit, neutral dark backdrop, cinematic lighting, lifelike skin texture, 85mm`;
  const front = await genImageAsset(`${base}. FRONT view, facing the camera.`, `${name} — look (front)`);
  const back = await genImageAsset(`${base}. BACK view — the SAME person and outfit seen from behind.`, `${name} — look (back)`);
  return { front: front.id, back: back.id, credits: front.credits + back.credits };
}

