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
 * `getKey()`/`hasKey()` are backed by an in-memory cache (never written to
 * disk) that's refreshed lazily on first use and invalidated on set/remove,
 * so BYOK calls (byok-client.ts) don't pay a network round trip on every
 * turn. The cache is empty again on relaunch — a fresh reveal fetch happens
 * the first time a key is actually needed.
 */

import { serverGetAuthed, serverPutAuthed, serverDeleteAuthed } from "./auth";

export type ProviderId = "anthropic" | "openai" | "google" | "xai" | "perplexity";

export const PROVIDER_IDS: ProviderId[] = ["anthropic", "openai", "google", "xai", "perplexity"];

export interface ProviderStatus {
  provider: ProviderId;
  configured: boolean;
  lastTestOk: boolean | null;
  lastTestError: string | null;
}

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

/** Returns the plaintext key for use by an adapter. Main-process only.
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

export async function removeKey(provider: ProviderId): Promise<void> {
  if (!isValidProvider(provider)) return;
  await serverDeleteAuthed(`/api/provider-keys/${provider}`);
  keyCache.set(provider, null);
}

/** Status for the renderer. Never includes the key value itself. */
export async function listStatus(): Promise<ProviderStatus[]> {
  try {
    const status = await serverGetAuthed<ProviderStatus[]>("/api/provider-keys");
    return status;
  } catch {
    return PROVIDER_IDS.map((provider) => ({
      provider, configured: false, lastTestOk: null, lastTestError: null,
    }));
  }
}

/**
 * Fire a 1-token / minimal-cost test against the provider. Returns
 * `{ ok: true }` on a clean response; `{ ok: false, error }` otherwise.
 */
export async function testKey(provider: ProviderId): Promise<{ ok: boolean; error?: string }> {
  if (!isValidProvider(provider)) return { ok: false, error: "unknown provider" };
  const key = await getKey(provider);
  if (!key) return { ok: false, error: "no key configured" };

  try {
    const ok = await runProviderHealthCheck(provider, key);
    return { ok };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "test failed";
    return { ok: false, error: msg };
  }
}

/**
 * Send a real one-shot prompt through the provider's inference API with the
 * stored key and return the model's reply — so the Providers page can prove
 * end-to-end connectivity (not just key validity).
 */
export async function testPrompt(
  provider: ProviderId,
  model?: string,
  prompt?: string,
): Promise<{ ok: boolean; text?: string; model?: string; error?: string }> {
  if (!isValidProvider(provider)) return { ok: false, error: "unknown provider" };
  const key = await getKey(provider);
  if (!key) return { ok: false, error: "no key configured" };
  const { getDefaultModel } = await import("./provider-models");
  const useModel = (model && model.trim()) || getDefaultModel(provider);
  const userPrompt = (prompt && prompt.trim())
    || "Reply in one short sentence confirming the connection works, and name the model you are.";
  const { runByokStream } = await import("./provider-adapters/byok-client");
  let text = "";
  let streamErr = "";
  try {
    await runByokStream(
      provider,
      { model: useModel, messages: [{ role: "user", content: userPrompt }], maxTokens: 120 },
      { onText: (d) => { text += d; }, onError: (m) => { streamErr = m; } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "test failed";
    return { ok: false, error: msg, model: useModel };
  }
  if (!text.trim() && streamErr) {
    return { ok: false, error: streamErr, model: useModel };
  }
  return { ok: true, text: text.trim() || "(empty response)", model: useModel };
}

/**
 * Cheapest possible "is this key live" call per provider. Uses HEAD/GET
 * against the provider's models-list or equivalent endpoint where
 * available; falls back to a 1-token completion when no listing is
 * exposed.
 */
async function runProviderHealthCheck(provider: ProviderId, key: string): Promise<true> {
  const timeoutMs = 10_000;

  if (provider === "anthropic") {
    // Claude /v1/models requires the same key + version header as inference.
    await fetchOk("https://api.anthropic.com/v1/models?limit=1", {
      method: "GET",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    }, timeoutMs);
    return true;
  }
  if (provider === "openai") {
    await fetchOk("https://api.openai.com/v1/models", {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
    }, timeoutMs);
    return true;
  }
  if (provider === "google") {
    await fetchOk(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=1`,
      { method: "GET" },
      timeoutMs,
    );
    return true;
  }
  if (provider === "xai") {
    await fetchOk("https://api.x.ai/v1/models", {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
    }, timeoutMs);
    return true;
  }
  if (provider === "perplexity") {
    // Perplexity has no models endpoint; do a near-empty completion.
    await fetchOk("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "sonar",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
    }, timeoutMs);
    return true;
  }
  throw new Error(`no health check defined for ${provider}`);
}

async function fetchOk(url: string, init: RequestInit, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: controller.signal });
    if (!r.ok) {
      let detail = "";
      try { detail = (await r.text()).slice(0, 200); } catch { /* ignore */ }
      throw new Error(`HTTP ${r.status}${detail ? `: ${detail}` : ""}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
