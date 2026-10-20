/**
 * resources/media.ts — the media library + the generation path. `generate`
 * returns a 202 job; `waitForJob` polls it to a terminal state (generation
 * runs seconds-to-minutes depending on modality).
 */

import type { AuthedHttp } from "../core/authed-http.js";
import type {
  MediaAsset, MediaKind, MediaUploadTicket, MediaUploadInput, MediaFinalizeInput,
  MediaGenerateInput, MediaJob,
} from "../contract/media.js";

export interface MediaProject {
  id: string;
  title: string;
  /** {songId?, visuals?: assetIds[], prompt?, parentId?} — the assembly. */
  scenes: Record<string, unknown>;
  status: string;
  renderAssetId: string | null;
  updatedAt: string;
}

export class MediaClient {
  constructor(private readonly http: AuthedHttp) {}

  /** The org's media library, newest first (kind and text filters optional). */
  list(kind?: MediaKind, q?: string): Promise<MediaAsset[]> {
    const qs = new URLSearchParams();
    if (kind) qs.set("kind", kind);
    if (q) qs.set("q", q);
    const tail = qs.toString();
    return this.http.get<MediaAsset[]>(`/api/media${tail ? `?${tail}` : ""}`);
  }

  get(id: string): Promise<MediaAsset> {
    return this.http.get<MediaAsset>(`/api/media/${encodeURIComponent(id)}`);
  }

  /** The asset's bytes through the API (follows the presigned redirect). */
  bytes(id: string): Promise<ArrayBuffer> {
    return this.http.getBytes(`/api/media/${encodeURIComponent(id)}/bytes`);
  }

  /** A direct-playable URL (presigned; null when the store can't presign). */
  playbackUrl(id: string): Promise<{ url: string | null }> {
    return this.http.get<{ url: string | null }>(`/api/media/${encodeURIComponent(id)}/url`);
  }

  /** Mint an upload: the row (status `uploading`) + a presigned PUT when available. */
  uploadTicket(input: MediaUploadInput): Promise<MediaUploadTicket> {
    return this.http.post<MediaUploadTicket>("/api/media/upload-url", input);
  }

  /** Direct-upload fallback for stores that cannot presign (dev) or small files. */
  putBytes(id: string, bytes: Uint8Array): Promise<{ received: number }> {
    return this.http.put<{ received: number }>(`/api/media/${encodeURIComponent(id)}/bytes`, bytes);
  }

  /** Verify the object landed and flip the row ready (+ dimensions). */
  finalize(id: string, input: MediaFinalizeInput = {}): Promise<MediaAsset> {
    return this.http.post<MediaAsset>(`/api/media/${encodeURIComponent(id)}/finalize`, input);
  }

  delete(id: string): Promise<void> {
    return this.http.del<void>(`/api/media/${encodeURIComponent(id)}`);
  }

  /** Start a generation job (202). Enforced + spend-logged (dollars) server-side. */
  generate(input: MediaGenerateInput): Promise<{ job: MediaJob; outputKind: MediaKind }> {
    return this.http.post<{ job: MediaJob; outputKind: MediaKind }>("/api/media/generate", input);
  }

  job(id: string): Promise<MediaJob> {
    return this.http.get<MediaJob>(`/api/media/jobs/${encodeURIComponent(id)}`);
  }

  jobs(): Promise<MediaJob[]> {
    return this.http.get<MediaJob[]>("/api/media/jobs");
  }

  projects(): Promise<MediaProject[]> {
    return this.http.get<MediaProject[]>("/api/media/projects");
  }
  createProject(input: { title?: string; scenes?: Record<string, unknown> }): Promise<MediaProject> {
    return this.http.post<MediaProject>("/api/media/projects", input);
  }
  updateProject(id: string, patch: { title?: string; scenes?: Record<string, unknown> }): Promise<MediaProject> {
    return this.http.patch<MediaProject>(`/api/media/projects/${encodeURIComponent(id)}`, patch);
  }
  deleteProject(id: string): Promise<void> {
    return this.http.del<void>(`/api/media/projects/${encodeURIComponent(id)}`);
  }
  /** Server-side project generation — child project now, render attaches on
   *  success, a failed child cleans itself up. */
  generateProject(id: string, input: { model?: string; seconds?: number; prompt?: string } = {}): Promise<{ project: MediaProject; job: MediaJob }> {
    return this.http.post<{ project: MediaProject; job: MediaJob }>(`/api/media/projects/${encodeURIComponent(id)}/generate`, input);
  }

  /** Poll a job to its terminal state (2s cadence, capped). */
  async waitForJob(id: string, timeoutMs = 8 * 60 * 1000): Promise<MediaJob> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const j = await this.job(id);
      if (j.status === "succeeded" || j.status === "failed") return j;
      if (Date.now() > deadline) throw new Error(`media job ${id} timed out (last status: ${j.status})`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
