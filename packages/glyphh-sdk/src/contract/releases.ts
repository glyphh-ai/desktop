/**
 * contract/releases.ts — desktop builds. The releases repo is private, so the
 * server reads it with a token and hands out a short-lived asset URL.
 */

export interface ReleaseAsset {
  name: string;
  size: number;
}

export interface Release {
  tag: string;
  publishedAt: string | null;
  prerelease: boolean;
  assets: ReleaseAsset[];
}

export interface ReleaseAssetUrl {
  url: string;
}
