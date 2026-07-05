/**
 * app-secrets — per-app config vars (Heroku-style), write-only after creation.
 *
 * Each saved app can hold KEY=value secrets the user sets on the app's
 * "Config Vars" tab. Values are encrypted in the MAIN PROCESS with
 * Electron safeStorage BEFORE they leave the machine, then stored on the
 * server inside the app row's launchConfig.secrets. safeStorage rides the
 * native vault on both shipping platforms — macOS Keychain and Windows
 * DPAPI (user+machine bound, no setup required) — so this works identically
 * on Mac and Windows; the `enc:false` plaintext fallback only exists for
 * exotic Linux setups without a keyring, which Glyphh doesn't ship to.
 *
 * Row shape:
 *
 *   launchConfig.secrets = { "OPENAI_API_KEY": { v: "<ciphertext b64>", at: "<iso>" }, … }
 *
 * Consequences of that design, all intentional:
 *   • The server db stores ciphertext only — yo-server can never read a value.
 *   • The UI can list key names + created dates but NEVER the value: the
 *     plaintext is visible exactly once, in the form field where the user
 *     typed it. There is no IPC that returns a decrypted value to a renderer.
 *   • Decryption happens only in the main process, only for the app's own
 *     capability calls (secrets.get) and agent.run's key auto-pickup.
 *   • safeStorage is machine-bound: on a new machine the values won't
 *     decrypt and the user re-enters them. Correct behavior for secrets.
 */

import { safeStorage } from "electron";
import { encryptField, decryptField } from "./local-db.js";
import { serverPatchAuthed } from "./auth.js";
import { cachedServerGet, invalidateServerCache } from "./server-cache.js";

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_VALUE_CHARS = 32_768;
const MAX_SECRETS_PER_APP = 50;

export interface SecretEntry {
  /** safeStorage ciphertext, base64 (or plaintext when enc is false). */
  v: string;
  /** ISO timestamp of when the value was (last) set. */
  at: string;
  /** Whether v was actually encrypted at write time (safeStorage available).
   *  Distinguishes "decrypt failed on this machine" from "stored plaintext
   *  because the OS keychain was unavailable". */
  enc: boolean;
}

export type SecretsMap = Record<string, SecretEntry>;

interface AppRowLite {
  id: string;
  slug: string;
  launchConfig?: (Record<string, unknown> & { secrets?: SecretsMap }) | null;
}

function readSecrets(launchConfig: AppRowLite["launchConfig"]): SecretsMap {
  const secrets = launchConfig?.secrets;
  if (!secrets || typeof secrets !== "object") return {};
  const out: SecretsMap = {};
  for (const [key, entry] of Object.entries(secrets)) {
    if (entry && typeof entry === "object" && typeof (entry as SecretEntry).v === "string") {
      const e = entry as SecretEntry;
      out[key] = { v: e.v, at: String(e.at || ""), enc: e.enc !== false };
    }
  }
  return out;
}

async function findRow(appId: string): Promise<AppRowLite | undefined> {
  const apps = await cachedServerGet<AppRowLite[]>("/api/panel-apps").catch(() => [] as AppRowLite[]);
  return apps.find((a) => a.id === appId);
}

async function patchSecrets(row: AppRowLite, secrets: SecretsMap): Promise<void> {
  await serverPatchAuthed(`/api/panel-apps/${row.id}`, {
    launchConfig: { ...(row.launchConfig || {}), secrets },
  });
  invalidateServerCache("/api/panel-apps");
}

/** Key names + set-dates only — never values (there is no "get value" IPC). */
export async function listAppSecrets(appId: string): Promise<{ ok: boolean; secrets?: Array<{ key: string; at: string; hostOnly: boolean }>; error?: string }> {
  const row = await findRow(appId);
  if (!row) return { ok: false, error: "app not found" };
  const secrets = readSecrets(row.launchConfig);
  return {
    ok: true,
    secrets: Object.entries(secrets)
      .map(([key, e]) => ({ key, at: e.at, hostOnly: isHostOnlySecret(key) }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  };
}

/** Set (or replace) one config var. The plaintext is encrypted here and never
 *  stored or echoed back — this is the last moment it exists outside the
 *  capability path. */
export async function setAppSecret(appId: string, key: string, value: string): Promise<{ ok: boolean; error?: string }> {
  const k = String(key || "").trim();
  if (!KEY_RE.test(k)) return { ok: false, error: "Key must be letters/digits/underscore (e.g. OPENAI_API_KEY), max 64 chars" };
  const v = String(value ?? "");
  if (!v) return { ok: false, error: "Value is required" };
  if (v.length > MAX_VALUE_CHARS) return { ok: false, error: `Value too large (max ${MAX_VALUE_CHARS} chars)` };

  const row = await findRow(appId);
  if (!row) return { ok: false, error: "app not found" };
  const secrets = readSecrets(row.launchConfig);
  if (!secrets[k] && Object.keys(secrets).length >= MAX_SECRETS_PER_APP) {
    return { ok: false, error: `Limit reached (${MAX_SECRETS_PER_APP} config vars per app)` };
  }
  secrets[k] = { v: encryptField(v), at: new Date().toISOString(), enc: safeStorage.isEncryptionAvailable() };
  try {
    await patchSecrets(row, secrets);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function deleteAppSecret(appId: string, key: string): Promise<{ ok: boolean; error?: string }> {
  const row = await findRow(appId);
  if (!row) return { ok: false, error: "app not found" };
  const secrets = readSecrets(row.launchConfig);
  if (!(key in secrets)) return { ok: true }; // already gone
  delete secrets[key];
  try {
    await patchSecrets(row, secrets);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── capability-path reads (main process only) ──────────────

/**
 * Credential-shaped config vars — provider API keys, tokens, secrets,
 * passwords. These are HOST-ONLY: encrypted at rest and never returned to
 * sandboxed app code via `secrets.get`. Only the trusted main-process runtime
 * (llm.complete / agent.run / the LLM-proxy tool wrappers) decrypts and uses
 * them, and it returns only results — never the key. This is what makes it
 * safe to lend a model to an untrusted remote agent.
 */
export function isHostOnlySecret(key: string): boolean {
  return /(?:_API_KEY|_KEY|_SECRET|_TOKEN|_PASSWORD|PASSWORD)$/i.test(key.trim());
}

/** Decrypt one value from an app row's launchConfig. Returns null when unset
 *  (or set on another machine — safeStorage is machine-bound). */
export function secretValueFromRow(launchConfig: Record<string, unknown> | null | undefined, key: string): string | null {
  const secrets = readSecrets(launchConfig as AppRowLite["launchConfig"]);
  const entry = secrets[key];
  if (!entry) return null;
  if (!entry.enc) return entry.v; // stored plaintext (keychain was unavailable)
  const plain = decryptField(entry.v);
  // decryptField falls back to returning its input on failure; if that
  // happens the "plaintext" is still the ciphertext — treat as unreadable
  // (value was set on another machine; the user must re-enter it here).
  return plain && plain !== entry.v ? plain : null;
}

/** Key names + whether each decrypts on THIS machine (for secrets.list).
 *  `hostOnly` = credential-shaped; the value is never returned to the sandbox
 *  via secrets.get (only the trusted runtime uses it). */
export function secretKeysFromRow(launchConfig: Record<string, unknown> | null | undefined): Array<{ key: string; readable: boolean; hostOnly: boolean }> {
  const secrets = readSecrets(launchConfig as AppRowLite["launchConfig"]);
  return Object.keys(secrets)
    .map((key) => ({ key, readable: secretValueFromRow(launchConfig, key) != null, hostOnly: isHostOnlySecret(key) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}
