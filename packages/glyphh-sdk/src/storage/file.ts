/**
 * @glyphh/sdk/storage/file — a TokenStore backed by a mode-0600 JSON file (for
 * the CLI / headless hosts). Not encryption at rest — pair with an OS keychain for
 * that — but it keeps the session off memory-only and out of world-readable paths.
 */

import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TokenStore } from "../auth/token-store.js";
import type { StoredSession } from "../contract/auth.js";

export class FileTokenStore implements TokenStore {
  constructor(private readonly path: string) {}

  async load(): Promise<StoredSession | null> {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as StoredSession;
    } catch {
      return null;
    }
  }

  async save(session: StoredSession): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(session), { mode: 0o600 });
  }

  async clear(): Promise<void> {
    try {
      rmSync(this.path, { force: true });
    } catch {
      /* already gone */
    }
  }
}
