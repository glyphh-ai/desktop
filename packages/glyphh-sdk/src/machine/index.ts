/**
 * machine/index.ts — the MACHINE-REACH layer (Node-only): discover and launch the
 * applications installed on THIS computer. One implementation, many hosts: the
 * desktop app embeds it (and exposes it to the agent over the attach protocol);
 * the CLI hosts the same layer on machines with no desktop. Product surfaces
 * (desktop, CLI, ghost, web) call it through the server's governed tools — this
 * module itself never talks to a network.
 *
 * macOS: scans the standard app folders for .app bundles; `open -a` both
 * launches a cold app and activates a running one. Windows: resolves Start Menu
 * shortcuts (.lnk); `start ""` launches them. Linux: .desktop entries are a
 * different beast — list returns [] there (openUrl still works via xdg-open).
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface InstalledApp {
  /** Display name — bundle/shortcut basename without its extension. */
  name: string;
  /** Full path to the .app bundle (macOS) or .lnk shortcut (Windows). */
  path: string;
}

const MAC_APP_DIRS = [
  "/Applications",
  "/Applications/Utilities",
  "/System/Applications",
  "/System/Applications/Utilities",
  path.join(os.homedir(), "Applications"),
];

function winStartMenuDirs(): string[] {
  const dirs: string[] = [];
  if (process.env.ProgramData) dirs.push(path.join(process.env.ProgramData, "Microsoft", "Windows", "Start Menu", "Programs"));
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs"));
  return dirs;
}

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
  for (const c of s) {
    if (c === q[i]) i++;
    if (i === q.length) return true;
  }
  return i === q.length;
}

function scanMac(out: InstalledApp[], seen: Set<string>): void {
  for (const dir of MAC_APP_DIRS) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".app")) continue;
      const name = entry.slice(0, -4);
      const key = normKey(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ name, path: path.join(dir, entry) });
    }
  }
}

/** Windows Start Menu shortcuts, one level of subfolders deep (vendor folders). */
function scanWindows(out: InstalledApp[], seen: Set<string>): void {
  const addLnk = (dir: string, entry: string): void => {
    if (!entry.toLowerCase().endsWith(".lnk")) return;
    const name = entry.slice(0, -4);
    const key = normKey(name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ name, path: path.join(dir, entry) });
  };
  for (const dir of winStartMenuDirs()) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        const sub = path.join(dir, e.name);
        let subEntries: string[] = [];
        try {
          subEntries = fs.readdirSync(sub);
        } catch {
          continue;
        }
        for (const s of subEntries) addLnk(sub, s);
      } else {
        addLnk(dir, e.name);
      }
    }
  }
}

/** All installed apps this layer can launch (cached ~60s). [] on linux. */
export function listInstalledApps(): InstalledApp[] {
  const now = Date.now();
  if (cache && now - cachedAt < CACHE_MS) return cache;
  const out: InstalledApp[] = [];
  const seen = new Set<string>();
  if (process.platform === "darwin") scanMac(out, seen);
  else if (process.platform === "win32") scanWindows(out, seen);
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
  return (
    apps.find((a) => normKey(a.name) === nk) ||
    apps.find((a) => normKey(a.name).startsWith(nk)) ||
    apps.find((a) => normKey(a.name).includes(nk)) ||
    (nk.length >= 4 ? (apps.find((a) => isSubsequence(nk, normKey(a.name))) ?? null) : null)
  );
}

/** Launch (or activate, if already running) an installed app. */
export function launchInstalledApp(app: InstalledApp): void {
  if (process.platform === "darwin") {
    spawn("open", ["-a", app.path], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "win32") {
    // `start ""` resolves the .lnk exactly as a double-click would.
    spawn("cmd", ["/c", "start", "", app.path], { detached: true, stdio: "ignore" }).unref();
  }
}

/** Open a URL in the default browser (all platforms, best-effort). */
export function openUrl(url: string): boolean {
  try {
    const { cmd, args } =
      process.platform === "darwin"
        ? { cmd: "open", args: [url] }
        : process.platform === "win32"
          ? { cmd: "cmd", args: ["/c", "start", "", url] }
          : { cmd: "xdg-open", args: [url] };
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
