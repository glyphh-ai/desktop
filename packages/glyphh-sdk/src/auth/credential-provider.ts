/**
 * credential-provider.ts — turns the session into the `token: () => Promise<string>`
 * bearer supplier the rest of the SDK (and the rotor transport) consumes. Two
 * shapes: a session-backed provider that refreshes as needed, and a static
 * provider for a `gy_ak_` API key (headless / CI).
 */

import type { RefreshManager } from "./refresh-manager.js";

export type TokenProvider = () => Promise<string>;

/** Session-backed: returns a live access token, refreshing proactively. Throws if signed out. */
export function sessionTokenProvider(refresh: RefreshManager): TokenProvider {
  return async () => {
    const token = await refresh.accessToken();
    if (!token) throw new Error("not authenticated");
    return token;
  };
}

/** Static: a long-lived `gy_ak_` API key, unchanged per call. */
export function staticTokenProvider(apiKey: string): TokenProvider {
  return async () => apiKey;
}
