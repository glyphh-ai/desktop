/**
 * CloudSync — polls api.glyphh.ai/api/pending, pulls new items
 * to local stores, then ACKs so the cloud deletes them.
 *
 * Cloud is transient. Local is source of truth.
 */

import { NoteStore } from "./note-store";
import { getPreference } from "./preferences";

interface PendingItem {
  id: string;
  name: string;
  content: string;
  createdAt: string;
}

const POLL_INTERVAL_MS = 7_000; // ~7 seconds
const DEFAULT_SERVER = process.env.YO_AUTH_SERVER || "https://api.glyphh.ai";

export class CloudSync {
  private noteStore: NoteStore;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private authFailed = false;

  constructor(noteStore: NoteStore) {
    this.noteStore = noteStore;
  }

  private workspaceGetter: (() => string) | null = null;
  setWorkspaceGetter(fn: () => string): void {
    this.workspaceGetter = fn;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // First poll immediately, then on interval
    this.poll();
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    console.log("[cloud-sync] started");
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log("[cloud-sync] stopped");
  }

  get isRunning(): boolean {
    return this.running;
  }

  private get serverUrl(): string {
    return getPreference<string>("cloudServer", DEFAULT_SERVER);
  }

  private get authToken(): string | null {
    // Use JWT session token from auth module, fallback to legacy cloudToken preference
    try {
      const { getAuthToken } = require("./auth");
      const jwt = getAuthToken();
      if (jwt) return jwt;
    } catch { /* auth module not available yet */ }
    return getPreference<string>("cloudToken", null!);
  }

  resetAuth(): void { this.authFailed = false; }

  private async poll(): Promise<void> {
    if (this.authFailed) return;

    const token = this.authToken;
    if (!token) return;

    try {
      const res = await fetch(`${this.serverUrl}/api/pending`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        if (res.status === 401) {
          console.warn("[cloud-sync] auth failed — pausing until token refreshes");
          this.authFailed = true;
        }
        return;
      }

      const items = (await res.json()) as PendingItem[];
      if (items.length === 0) return;

      // 2. Write each to local notes
      for (const item of items) {
        await this.noteStore.write(item.name, item.content, "cloud-sync");
      }

      // 3. ACK all fetched IDs
      const ids = items.map((i) => i.id);
      const ackRes = await fetch(`${this.serverUrl}/api/ack`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ ids }),
      });

      if (!ackRes.ok) {
        console.warn(`[cloud-sync] ACK failed with ${ackRes.status} — will retry next poll`);
        return;
      }

      console.log(`[cloud-sync] pulled ${items.length} item(s)`);
    } catch (err) {
      // Network error — silently retry next interval
    }
  }
}
