/**
 * contract/api-keys.ts — user-scoped API keys (`gy_ak_…`). A key authenticates headless
 * SDK/CLI use and the desktop relay as its owning user. Only the SHA-256 hash is
 * stored; the raw token is shown once. The platform lists keys by org → user.
 */

export interface ApiKey {
  id: string;
  label: string;
  /** A non-secret display prefix, e.g. "gy_ak_ab12…". The full token is never returned. */
  prefix: string;
  /** Console-style hint — `gy_ak_abcdefgh...wxyz` — null on keys minted before it existed. */
  tokenHint?: string | null;
  userId: string;
  userEmail: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  /** Attributed spend in dollars (summed from the spend log); 0 until the key
   *  records usage. Absent on older servers. */
  spentUsd?: number;
}

/** `apiKeys.create` returns the key metadata + the raw token (shown once). */
export interface CreatedApiKey {
  key: ApiKey;
  token: string;
}

export interface ApiKeyInput {
  label: string;
  /** Optional expiry; omit for a non-expiring key. */
  expiresInDays?: number;
}
