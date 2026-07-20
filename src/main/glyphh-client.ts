/**
 * glyphh-client.ts — the ONE @glyphh/client instance for the desktop app.
 *
 * Every control-plane call goes through this client: typed resource clients
 * (client.connections, client.apps, …) where coverage exists, and the
 * `client.http` escape hatch for endpoints still migrating. The SDK owns the
 * token lifecycle (single-flight refresh, rotation, sign-out) — nothing else
 * in the app may store or refresh tokens.
 *
 * Session storage: same policy as the old auth.ts — a mode-0600 JSON file,
 * NOT the OS keychain (short-lived, server-revocable tokens; a keychain
 * prompt on every boot isn't worth it). The file also feeds the synchronous
 * boot path in auth.ts before the SDK has loaded it.
 */

import fs from "fs";
import path from "path";
import { createClient, createTtlCache, type Client, type StoredSession, type TokenStore } from "@glyphh/client";
import { GLYPHH_DIR } from "./app-paths.js";

/**
 * Short-TTL dedup for the hot SDK reads (the org's apps, the layout library)
 * that the palette, resolver, and pages all hit. Cleared on sign-out/user
 * switch so one account's data can never be served to the next.
 */
export const appCache = createTtlCache();

export const SERVER_URL = process.env.GLYPHH_SERVER_URL || "https://api.glyphh.ai";
export const PLATFORM_URL = process.env.GLYPHH_PLATFORM_URL || "https://platform.glyphh.ai";

export const SESSION_FILE = path.join(GLYPHH_DIR, ".session");

/** Mode-0600 JSON file store (the SDK's FileTokenStore needs subpath exports
 *  our CJS tsconfig can't resolve, so it's inlined — same shape, same perms). */
class SessionFileStore implements TokenStore {
  constructor(private readonly file: string) {}

  async load(): Promise<StoredSession | null> {
    return readSessionFileSync(this.file);
  }

  async save(session: StoredSession): Promise<void> {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(session), { encoding: "utf-8", mode: 0o600 });
  }

  async clear(): Promise<void> {
    try { fs.unlinkSync(this.file); } catch { /* already gone */ }
  }
}

/** Synchronous read of the persisted session — for boot-time checks only;
 *  everything else must go through the client. */
export function readSessionFileSync(file: string = SESSION_FILE): StoredSession | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as StoredSession;
    if (typeof parsed?.accessToken === "string" && typeof parsed?.expiresAt === "number") return parsed;
    return null;
  } catch {
    return null;
  }
}

let client: Client | null = null;
let signedOutHandler: (() => void) | null = null;

/** Register the callback fired when the SDK gives up on the session (refresh
 *  rejected) — surfaces the login gate. Set once by auth.ts. */
export function setSignedOutHandler(fn: () => void): void {
  signedOutHandler = fn;
}

/** The app-wide client. Lazily constructed; safe to call from anywhere in main. */
export function getClient(): Client {
  if (!client) {
    client = createClient({
      url: SERVER_URL,
      tokenStore: new SessionFileStore(SESSION_FILE),
      onSignedOut: () => { try { signedOutHandler?.(); } catch { /* gate must not throw */ } },
    });
  }
  return client;
}
