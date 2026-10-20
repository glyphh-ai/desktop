/**
 * resources/releases.ts — the desktop build list and its downloads. The URL a
 * download returns is signed and expires, so ask for it at click time.
 */

import type { AuthedHttp } from "../core/authed-http.js";
import type { Release, ReleaseAssetUrl } from "../contract/releases.js";

export class ReleasesClient {
  constructor(private readonly http: AuthedHttp) {}

  list(): Promise<Release[]> {
    return this.http.get<Release[]>("/api/releases");
  }

  assetUrl(tag: string, name: string): Promise<ReleaseAssetUrl> {
    return this.http.get<ReleaseAssetUrl>(
      `/api/releases/asset?tag=${encodeURIComponent(tag)}&name=${encodeURIComponent(name)}`,
    );
  }
}
