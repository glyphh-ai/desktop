/**
 * resources/design.ts — GLYPHH DESIGN. Design systems are org-shared brand
 * kits in the org's R2 space; every surface reads the same library. `put` is
 * create-or-overwrite by name; `css` is the consumable contract — the whole
 * system rendered as a `:root { --design-* }` block an app maps its own
 * variables onto (or hot-links `/api/design/:file/css` directly).
 */

import type { AuthedHttp } from "../core/authed-http.js";
import type {
  Design, DesignMeta, DesignSystem, DesignAsset, UploadDesignAssetInput,
  AdoptImageryInput, AdoptImageryResult,
} from "../contract/design.js";

export class DesignsClient {
  constructor(private readonly http: AuthedHttp) {}

  /** The org's design systems, most recently touched first. */
  list(): Promise<DesignMeta[]> {
    return this.http.get<DesignMeta[]>("/api/design");
  }

  /** One system by name — metadata plus the complete document. */
  get(file: string): Promise<Design> {
    return this.http.get<Design>(`/api/design/${encodeURIComponent(file)}`);
  }

  /** Create or overwrite by name. The server validates the document (hex
   *  colors, required primary/background/text + display/body fonts, caps)
   *  and strips asset entries that were never actually uploaded. */
  put(file: string, document: DesignSystem): Promise<DesignMeta> {
    return this.http.put<DesignMeta>(`/api/design/${encodeURIComponent(file)}`, { document });
  }

  /** Delete a system for the whole org — document, assets, and index row. */
  delete(file: string): Promise<void> {
    return this.http.del<void>(`/api/design/${encodeURIComponent(file)}`);
  }

  /** The system's READABLE TEXT — what a session should read. */
  text(file: string): Promise<DesignMeta & { text: string }> {
    return this.http.get<DesignMeta & { text: string }>(`/api/design/${encodeURIComponent(file)}/text`);
  }

  /** The consumable contract: the whole system as a `:root { --design-* }`
   *  CSS block. Returned as text — paste it into an app's stylesheet. */
  async css(file: string): Promise<string> {
    const bytes = await this.http.getBytes(`/api/design/${encodeURIComponent(file)}/css`);
    return new TextDecoder().decode(bytes);
  }

  /** Upload (or replace) an image asset; the entry is indexed inside the
   *  document server-side and the bytes served under the returned id. */
  uploadAsset(file: string, input: UploadDesignAssetInput): Promise<DesignAsset> {
    return this.http.post<DesignAsset>(`/api/design/${encodeURIComponent(file)}/assets`, input);
  }

  /** One asset's bytes (render with the entry's contentType). */
  assetBytes(file: string, assetId: string): Promise<ArrayBuffer> {
    return this.http.getBytes(`/api/design/${encodeURIComponent(file)}/assets/${encodeURIComponent(assetId)}`);
  }

  /** Remove an asset — bytes and its entry in the document. */
  deleteAsset(file: string, assetId: string): Promise<void> {
    return this.http.del<void>(`/api/design/${encodeURIComponent(file)}/assets/${encodeURIComponent(assetId)}`);
  }

  /** ATOMICALLY adopt media-library assets into a system's imagery and place
   *  them on the studio canvas. The server serializes writers on the design's
   *  row lock, so parallel adoptions (four mockups in one turn) never lose an
   *  update; already-adopted assets are reported, not duplicated. */
  addImagery(file: string, assets: AdoptImageryInput[], placement?: "auto"): Promise<AdoptImageryResult> {
    return this.http.post<AdoptImageryResult>(
      `/api/design/${encodeURIComponent(file)}/imagery`,
      { assets, ...(placement ? { placement } : {}) },
    );
  }

  /** Remove an imagery ref — the pointer and its canvas card, symmetric with
   *  adoption. The media asset itself stays in the library. */
  removeImagery(file: string, assetId: string): Promise<void> {
    return this.http.del<void>(`/api/design/${encodeURIComponent(file)}/imagery/${encodeURIComponent(assetId)}`);
  }
}
