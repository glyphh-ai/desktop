/**
 * resources/runtime-images.ts — the runtime IMAGE surface (§7b). `list` is the
 * org-scoped picker (active SKUs in the caller org's region); `current` the org's
 * bound image + realized route; `change` requests a transition (org_admin — the
 * server validates region+active, refuses no-ops, and rides the fleet seams:
 * promote / in-place resize / demote). Admin CRUD lives on `client.admin`.
 */

import type { AuthedHttp } from "../core/authed-http.js";
import type { RuntimeImage, OrgRuntimeImage } from "../contract/runtime-images.js";

export class RuntimeImagesClient {
  constructor(private readonly http: AuthedHttp) {}

  /** The active images available to the caller org (its region's catalog), cheapest first. */
  list(): Promise<RuntimeImage[]> {
    return this.http.get<RuntimeImage[]>("/api/runtime-images");
  }

  /** The org's current image + the route it is realized as. */
  current(): Promise<OrgRuntimeImage> {
    return this.http.get<OrgRuntimeImage>("/api/org/runtime-image");
  }

  /** Change the org's image by SKU key (org_admin). Upgrades provision a dedicated
   *  runtime sized from the image; downgrading to 'free' demotes back onto the
   *  region's shared runtime. A no-op or unknown/inactive key is a ValidationError. */
  change(image: string): Promise<OrgRuntimeImage> {
    return this.http.post<OrgRuntimeImage>("/api/org/runtime-image", { image });
  }
}
