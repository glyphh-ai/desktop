/**
 * token-store.ts — where the client keeps its opaque session. The SDK owns the
 * token *lifecycle*; the host owns *storage at rest*. Core ships only the in-memory
 * store; platform adapters (Expo SecureStore, OS keychain, sealed file) implement
 * this same interface and are imported from separate entry points, so the core
 * stays dependency-free and runs on every runtime.
 */

import type { StoredSession } from "../contract/auth.js";

export interface TokenStore {
  load(): Promise<StoredSession | null>;
  save(session: StoredSession): Promise<void>;
  clear(): Promise<void>;
}

/** Default store — ephemeral, process-local. Fine for tests + short-lived CLIs. */
export class InMemoryTokenStore implements TokenStore {
  private session: StoredSession | null = null;
  async load(): Promise<StoredSession | null> {
    return this.session;
  }
  async save(session: StoredSession): Promise<void> {
    this.session = session;
  }
  async clear(): Promise<void> {
    this.session = null;
  }
}
