/**
 * installed-apps — discover apps installed on this machine so `.dip <name>`
 * can launch them even when they were never added to the Glyphh library.
 *
 * macOS: scans the standard app folders for .app bundles (cached ~60s).
 * `open -a` both launches a cold app and activates an already-running one.
 * Windows: not implemented yet (Start-Menu shortcut resolution is a
 * different beast) — findInstalledApp returns null there.
 */

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

export interface InstalledApp {
  /** Display name — the bundle basename without ".app". */
  name: string;
  /** Full path to the .app bundle. */
  path: string;
}

const MAC_APP_DIRS = [
  "/Applications",
  "/Applications/Utilities",
  "/System/Applications",
  "/System/Applications/Utilities",
  path.join(os.homedir(), "Applications"),
];

let cache: InstalledApp[] | null = null;
let cachedAt = 0;
const CACHE_MS = 60_000;

/** Lowercase, alphanumerics only — "VS Code" ≈ "vscode" ≈ "vs-code". */
export function normKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** True when `q`'s characters appear in order inside `s` ("vscode" ⊑
 *  "visualstudiocode"). Loose — callers gate it to longer queries. */
export function isSubsequence(q: string, s: string): boolean {
  let i = 0;
  for (const c of s) { if (c === q[i]) i++; if (i === q.length) return true; }
  return i === q.length;
}

/** All .app bundles in the standard folders (macOS; [] elsewhere). */
export function listInstalledApps(): InstalledApp[] {
  if (process.platform !== "darwin") return [];
  const now = Date.now();
  if (cache && now - cachedAt < CACHE_MS) return cache;
  const out: InstalledApp[] = [];
  const seen = new Set<string>();
  for (const dir of MAC_APP_DIRS) {
    let entries: string[] = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      if (!entry.endsWith(".app")) continue;
      const name = entry.slice(0, -4);
      const key = normKey(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ name, path: path.join(dir, entry) });
    }
  }
  cache = out;
  cachedAt = now;
  return out;
}

/** Fuzzy-find an installed app: normalized exact → prefix → substring →
 *  subsequence ("vscode" ⊑ "visualstudiocode", queries ≥4 chars). */
export function findInstalledApp(ref: string): InstalledApp | null {
  const nk = normKey(ref);
  if (nk.length < 2) return null;
  const apps = listInstalledApps();
  return apps.find((a) => normKey(a.name) === nk)
    || apps.find((a) => normKey(a.name).startsWith(nk))
    || apps.find((a) => normKey(a.name).includes(nk))
    || (nk.length >= 4 ? apps.find((a) => isSubsequence(nk, normKey(a.name))) : null)
    || null;
}

/** Launch (or activate, if already running) an installed macOS app. */
export function launchInstalledApp(app: InstalledApp): void {
  spawn("open", ["-a", app.path], { detached: true, stdio: "ignore" }).unref();
}
