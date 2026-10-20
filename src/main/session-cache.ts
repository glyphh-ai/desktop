/**
 * SessionCache — in-memory capture store for yo/sup.
 *
 * yo captures content → stored here + copied to clipboard.
 * sup reads from here instantly — no disk, no search, no latency.
 *
 * The session is runtime-only. Restart clears it.
 */

import { clipboard } from "electron";

export interface SessionEntry {
  id: string;
  appId: string;
  timestamp: number;
  content: string;
}

export interface SessionInfo {
  hasContent: boolean;
  label: string;
  /** Library file name (without .md) if loaded from library, empty otherwise */
  fileName: string;
}

export class SessionCache {
  private entries: SessionEntry[] = [];
  private combined = "";
  private _label = "";
  private _fileName = "";
  private _onCapture: ((appId: string, content: string) => void) | null = null;
  private _onRawCapture: ((appId: string, content: string) => void) | null = null;

  /** Register callback fired on every capture (cleaned content for skills/display). */
  setOnCapture(fn: (appId: string, content: string) => void): void {
    this._onCapture = fn;
  }

  /** Register callback for raw body text capture (for search indexing). */
  setOnRawCapture(fn: (appId: string, content: string) => void): void {
    this._onRawCapture = fn;
  }

  /** Fire the raw capture callback directly (called by interceptor/grabber). */
  rawCapture(appId: string, content: string): void {
    if (this._onRawCapture) this._onRawCapture(appId, content);
  }

  /** Add captured content from a panel. Replaces any existing entry from the same app. */
  capture(appId: string, content: string, label?: string, fileName?: string): void {
    // Replace existing entry from same app (latest capture wins)
    this.entries = this.entries.filter((e) => e.appId !== appId);
    this.entries.push({
      id: `${appId}-${Date.now()}`,
      appId,
      timestamp: Date.now(),
      content,
    });
    this._label = label || appId;
    this._fileName = fileName || "";
    this.rebuildCombined();
    if (this._onCapture) this._onCapture(appId, content);
  }

  /** Get the combined session content (what sup uses). */
  get(): string {
    return this.combined;
  }

  /** Get all individual entries. */
  getEntries(): SessionEntry[] {
    return [...this.entries];
  }

  /** Check if session has content. */
  hasContent(): boolean {
    return this.combined.length > 0;
  }

  /** Get session info for the renderer (pill display). */
  getInfo(): SessionInfo {
    return {
      hasContent: this.combined.length > 0,
      label: this._label,
      fileName: this._fileName,
    };
  }

  /** Copy current session to system clipboard. */
  copyToClipboard(): void {
    if (this.combined) {
      clipboard.writeText(this.combined);
    }
  }

  /** Clear the session. */
  clear(): void {
    this.entries = [];
    this.combined = "";
    this._label = "";
    this._fileName = "";
  }

  /** Remove a specific entry by app ID. */
  remove(appId: string): void {
    this.entries = this.entries.filter((e) => e.appId !== appId);
    this.rebuildCombined();
  }

  private rebuildCombined(): void {
    if (this.entries.length === 0) {
      this.combined = "";
    } else if (this.entries.length === 1) {
      this.combined = this.entries[0].content;
    } else {
      this.combined = this.entries
        .map((e) => `## ${e.appId}\n\n${e.content}`)
        .join("\n\n---\n\n");
    }
  }
}
