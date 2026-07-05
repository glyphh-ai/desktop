/**
 * browser-detect — which real browsers are installed on this machine.
 *
 * The native-OS app model opens every web app in the user's own browser
 * (their extensions, sessions, profiles — we build tooling, not a browser).
 * This feeds the app editor's Browser dropdown and native-launch's targeting.
 */

import fs from "fs";
import path from "path";
import os from "os";

export interface InstalledBrowser {
  /** Stable id stored in the app's launchConfig.browser. */
  id: string;
  name: string;
  /** macOS: .app bundle path. Windows: exe path. */
  appPath: string;
  /** Chromium-based — supports --new-window/--app= launch flags. */
  chromium: boolean;
  /** Process name the OS window manager sees (for tracked windows). */
  proc: string;
}

interface BrowserDef {
  id: string;
  name: string;
  chromium: boolean;
  /** macOS bundle names to look for, in preference order. */
  macApps: string[];
  /** Windows exe paths relative to Program Files roots. */
  winPaths: string[];
  proc: string;
}

const KNOWN: BrowserDef[] = [
  { id: "chrome", name: "Google Chrome", chromium: true, macApps: ["Google Chrome.app"], winPaths: ["Google/Chrome/Application/chrome.exe"], proc: "Google Chrome" },
  { id: "safari", name: "Safari", chromium: false, macApps: ["Safari.app"], winPaths: [], proc: "Safari" },
  { id: "edge", name: "Microsoft Edge", chromium: true, macApps: ["Microsoft Edge.app"], winPaths: ["Microsoft/Edge/Application/msedge.exe"], proc: "Microsoft Edge" },
  { id: "arc", name: "Arc", chromium: true, macApps: ["Arc.app"], winPaths: [], proc: "Arc" },
  { id: "brave", name: "Brave", chromium: true, macApps: ["Brave Browser.app"], winPaths: ["BraveSoftware/Brave-Browser/Application/brave.exe"], proc: "Brave Browser" },
  { id: "firefox", name: "Firefox", chromium: false, macApps: ["Firefox.app"], winPaths: ["Mozilla Firefox/firefox.exe"], proc: "Firefox" },
  { id: "vivaldi", name: "Vivaldi", chromium: true, macApps: ["Vivaldi.app"], winPaths: ["Vivaldi/Application/vivaldi.exe"], proc: "Vivaldi" },
  { id: "opera", name: "Opera", chromium: true, macApps: ["Opera.app"], winPaths: ["Opera/opera.exe"], proc: "Opera" },
];

let cache: InstalledBrowser[] | null = null;

/** Scan for installed browsers (cached for the process lifetime — installing
 *  a browser mid-session is rare; restart picks it up). */
export function detectBrowsers(): InstalledBrowser[] {
  if (cache) return cache;
  const found: InstalledBrowser[] = [];

  if (process.platform === "darwin") {
    const roots = ["/Applications", "/System/Applications", path.join(os.homedir(), "Applications")];
    // Safari lives under /Applications on modern macOS but check cryptexes too.
    roots.push("/System/Cryptexes/App/System/Applications");
    for (const def of KNOWN) {
      for (const bundle of def.macApps) {
        const hit = roots.map((r) => path.join(r, bundle)).find((p) => fs.existsSync(p));
        if (hit) { found.push({ id: def.id, name: def.name, appPath: hit, chromium: def.chromium, proc: def.proc }); break; }
      }
    }
  } else if (process.platform === "win32") {
    const roots = [
      process.env["ProgramFiles"] || "C:\\Program Files",
      process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
      path.join(process.env["LOCALAPPDATA"] || "", "Programs"),
    ];
    for (const def of KNOWN) {
      for (const rel of def.winPaths) {
        const hit = roots.map((r) => path.join(r, rel)).find((p) => p && fs.existsSync(p));
        if (hit) { found.push({ id: def.id, name: def.name, appPath: hit, chromium: def.chromium, proc: def.proc }); break; }
      }
    }
  }

  cache = found;
  return found;
}

/** Look up one detected browser by id (null = not installed / unknown). */
export function getBrowser(id: string | undefined | null): InstalledBrowser | null {
  if (!id || id === "default") return null;
  return detectBrowsers().find((b) => b.id === id) || null;
}
