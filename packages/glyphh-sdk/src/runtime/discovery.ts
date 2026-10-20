/**
 * runtime/discovery.ts — the local runtime's discovery record: a small 0600 JSON file
 * (`~/.glyphh/runtime.json`) that lets any client on the machine find the one running
 * runtime — its URL, PID, and loopback token. Written by whoever starts the runtime.
 */

import { readFileSync, writeFileSync, rmSync } from "node:fs";

export interface RuntimeRecord {
  /** `http://127.0.0.1:<port>`. */
  url: string;
  port: number;
  /** The runtime process id (for stale-detection + stop). */
  pid: number;
  /** Loopback access token (future hardening; harmless today). */
  token: string;
  /** Supervisor protocol version that wrote this record. */
  version: string;
  /** ms epoch. */
  startedAt: number;
}

export function readRecord(path: string): RuntimeRecord | null {
  try {
    const r = JSON.parse(readFileSync(path, "utf8")) as RuntimeRecord;
    return r && typeof r.url === "string" && typeof r.pid === "number" ? r : null;
  } catch {
    return null; // missing or malformed
  }
}

export function writeRecord(path: string, rec: RuntimeRecord): void {
  writeFileSync(path, JSON.stringify(rec), { mode: 0o600 });
}

export function clearRecord(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* already gone */
  }
}
