/**
 * prefs.ts — this device's TUI preferences (~/.glyphh/config.json, 0600): the
 * permission chip, the picked model, the effort dial, the theme, the prompt
 * history, the trusted folders. Keys this file does not know (an older CLI's
 * `server`) are kept as they are on every write, never read.
 */

import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { GLYPHH_HOME } from "./local.js";
import { effortOf, permissionModeOf, type Effort, type PermissionMode } from "./types.js";

function file(): string {
  return join(GLYPHH_HOME, "config.json");
}

export interface Prefs {
  permissionMode?: PermissionMode;
  /** The model turns run on (a catalog id, models.ts). Absent = the default. */
  model?: string;
  /** The effort dial turns run at (/effort). Absent = medium. */
  effort?: Effort;
  /** The chosen theme's name (see theme.ts). Absent = never picked → the picker runs. */
  theme?: string;
  /** The last prompts typed, oldest first (↑ recalls them). */
  history?: string[];
  /** Folders the user said they trust the files in (the first-run question). */
  trustedFolders?: string[];
}

/** How many prompts the history keeps. */
export const HISTORY_MAX = 100;

/** The file as written, every key kept (what a write merges over). */
function rawPrefs(): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(file(), "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function readPrefs(): Prefs {
  try {
    const raw = rawPrefs();
    // Older files spelled the chip ask/auto/read-only; every spelling maps.
    const mode = permissionModeOf(typeof raw.permissionMode === "string" ? raw.permissionMode : undefined);
    const out: Prefs = {};
    if (mode) out.permissionMode = mode;
    if (typeof raw.model === "string" && raw.model) out.model = raw.model;
    const effort = effortOf(typeof raw.effort === "string" ? raw.effort : undefined);
    if (effort) out.effort = effort;
    if (typeof raw.theme === "string") out.theme = raw.theme;
    if (Array.isArray(raw.history)) out.history = raw.history.filter((h): h is string => typeof h === "string").slice(-HISTORY_MAX);
    if (Array.isArray(raw.trustedFolders)) out.trustedFolders = raw.trustedFolders.filter((f): f is string => typeof f === "string");
    return out;
  } catch {
    return {};
  }
}

/** A patch: a value sets the key, null removes it (back to the default). */
export type PrefsPatch = { [K in keyof Prefs]?: Prefs[K] | null };

/** Merge + persist (0600). Best-effort — a read-only home never breaks the TUI. */
export function writePrefs(patch: PrefsPatch): void {
  try {
    const next: Record<string, unknown> = { ...rawPrefs() };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete next[k];
      else if (v !== undefined) next[k] = v;
    }
    mkdirSync(GLYPHH_HOME, { recursive: true });
    writeFileSync(file(), JSON.stringify(next, null, 2), { mode: 0o600 });
  } catch {
    /* best-effort */
  }
}

/** Remember a prompt (deduplicated against the newest, capped). */
export function rememberPrompt(text: string): string[] {
  const cur = readPrefs().history ?? [];
  const next = cur[cur.length - 1] === text ? cur : [...cur, text].slice(-HISTORY_MAX);
  writePrefs({ history: next });
  return next;
}

/** Is this folder one the user trusts? Exact, or under a trusted parent. */
export function folderTrusted(folder: string): boolean {
  const list = readPrefs().trustedFolders ?? [];
  return list.some((t) => folder === t || folder.startsWith(t.endsWith("/") ? t : `${t}/`));
}

/** Remember a trusted folder. */
export function trustFolder(folder: string): void {
  const list = readPrefs().trustedFolders ?? [];
  if (!list.includes(folder)) writePrefs({ trustedFolders: [...list, folder] });
}
