/**
 * Preferences — simple JSON key-value store at ~/.glyphh/.preferences
 *
 * The store is shared by the main process AND short-lived child/utility
 * processes (embedder, sdk-llm, mcp-client, capability sync, …). An in-memory
 * cache goes stale the instant another process writes the file, and writing a
 * stale snapshot back silently drops whatever keys it didn't know about —
 * which is exactly how `agentMode`, `openTabs`, `theme` kept disappearing on
 * restart. So we never hold a long-lived cache: every read and write goes
 * against the current on-disk state, and writes are atomic (tmp + rename) so a
 * crash mid-write can't corrupt the file into a `{}` that wipes every key.
 */

import fs from "fs";
import path from "path";
import { glyphhPath } from "./app-paths.js";

const PREFS_FILE = glyphhPath(".preferences");

function readAll(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(PREFS_FILE, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeAll(data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true });
  const tmp = `${PREFS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, PREFS_FILE);
}

export function getPreference<T = unknown>(key: string, fallback?: T): T {
  const prefs = readAll();
  return (prefs[key] as T) ?? fallback!;
}

export function setPreference(key: string, value: unknown): void {
  // Read-modify-write against the latest on-disk state so concurrent writers
  // never clobber each other's keys.
  const prefs = readAll();
  prefs[key] = value;
  writeAll(prefs);
}
