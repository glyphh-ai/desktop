/**
 * contract/media.ts — GLYPHH IMAGE / VIDEO / SOUNDS wire shapes. Assets are
 * the org's media library (bytes in R2, presigned up and down); JOBS are the
 * only path that generates — enforced, modality-priced, spend-logged in dollars.
 */

export type MediaKind = "image" | "video" | "audio" | "voice" | "avatar" | "recording" | "script";

export interface MediaAsset {
  id: string;
  kind: MediaKind;
  title: string;
  mime: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  status: "uploading" | "ready" | "failed";
  meta: Record<string, unknown>;
  updatedAt: string;
}

export interface MediaUploadTicket {
  asset: MediaAsset;
  /** Presigned R2 PUT (stream bytes here, content-type must match) — null when
   *  the store cannot presign; PUT /api/media/:id/bytes instead. */
  url: string | null;
}

export interface MediaUploadInput {
  kind: MediaKind;
  title: string;
  mime: string;
  sizeBytes: number;
  meta?: Record<string, unknown>;
}

export interface MediaFinalizeInput {
  width?: number;
  height?: number;
  durationMs?: number;
  sizeBytes?: number;
  title?: string;
}

export interface MediaGenerateInput {
  /** Catalog id ("openai::gpt-image-1") or bare id; must be a media modality. */
  model: string;
  prompt: string;
  title?: string;
  options?: { size?: string; seconds?: number; voice?: string; imageUrl?: string };
}

export interface MediaJob {
  id: string;
  kind: string;
  status: "queued" | "running" | "succeeded" | "failed";
  model: string;
  params: Record<string, unknown>;
  /** What the job cost, in dollars (from the spend log). */
  usdCharged: number;
  assetId: string | null;
  error: string | null;
  updatedAt: string;
}
