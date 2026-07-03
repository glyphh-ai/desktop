/**
 * provider-keys — user-supplied LLM provider API keys.
 *
 * Dashboard shell (5a): keys are server-authoritative. yo-server stores
 * them AES-256-GCM-encrypted in the `user_provider_keys` table (see
 * yo-server/src/services/byok-provider-keys.ts) — the client no longer
 * touches the OS keychain (Electron `safeStorage`) or writes anything to
 * ~/yo/.providers.json for this. Every call here is a JWT-authed request
 * to /api/provider-keys/*.
 *
 * Post-pivot this module has exactly three consumers left:
 *   • boot-gate onboarding stores an Anthropic key (provider-keys-set IPC)
 *   • cc-bootstrap checks hasKey("anthropic") for the CC-status gate
 *   • the transcriber uses getKey("openai") for Whisper voice transcription
 * The BYOK inference client, key health checks, and the Providers settings
 * page are gone (THE-PIVOT-BYOK phase 6) — Glyphh makes no LLM calls of its
 * own; apps bring keys via per-app config vars (app-secrets.ts).
 *
 * `getKey()`/`hasKey()` are backed by an in-memory cache (never written to
 * disk) that's refreshed lazily on first use and invalidated on set, so
 * callers don't pay a network round trip every time. The cache is empty
 * again on relaunch — a fresh reveal fetch happens the first time a key is
 * actually needed.
 */

import { serverGetAuthed, serverPutAuthed } from "./auth";

export type ProviderId = "anthropic" | "openai" | "google" | "xai" | "perplexity";

export const PROVIDER_IDS: ProviderId[] = ["anthropic", "openai", "google", "xai", "perplexity"];

function isValidProvider(p: string): p is ProviderId {
  return (PROVIDER_IDS as string[]).includes(p);
}

// In-memory only — never persisted. `undefined` = not yet fetched this
// session; `null` = fetched and confirmed absent.
const keyCache = new Map<ProviderId, string | null>();

/** Save a provider key server-side. Never touches local disk. */
export async function setKey(provider: ProviderId, plaintextKey: string): Promise<void> {
  if (!isValidProvider(provider)) throw new Error(`unknown provider: ${provider}`);
  const trimmed = plaintextKey.trim();
  if (!trimmed) throw new Error("key cannot be empty");
  await serverPutAuthed(`/api/provider-keys/${provider}`, { key: trimmed });
  keyCache.set(provider, trimmed);
}

/** Returns the plaintext key for use in the main process only.
 *  Cached in memory after the first server round trip. */
export async function getKey(provider: ProviderId): Promise<string | null> {
  if (!isValidProvider(provider)) return null;
  if (keyCache.has(provider)) return keyCache.get(provider) ?? null;
  try {
    const { key } = await serverGetAuthed<{ key: string | null }>(`/api/provider-keys/${provider}/reveal`);
    keyCache.set(provider, key ?? null);
    return key ?? null;
  } catch {
    return null;
  }
}

export async function hasKey(provider: ProviderId): Promise<boolean> {
  return (await getKey(provider)) !== null;
}
