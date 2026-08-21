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
import { execFileSync } from "child_process";

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
  /** macOS bundle id (lowercased) — matches the OS default-handler lookup. */
  macBundleId: string;
  /** Windows exe paths relative to Program Files roots. */
  winPaths: string[];
  /** Windows UserChoice ProgId prefixes — matches the default-handler lookup. */
  winProgIds: string[];
  proc: string;
}

const KNOWN: BrowserDef[] = [
  { id: "chrome", name: "Google Chrome", chromium: true, macApps: ["Google Chrome.app"], macBundleId: "com.google.chrome", winPaths: ["Google/Chrome/Application/chrome.exe"], winProgIds: ["ChromeHTML"], proc: "Google Chrome" },
  { id: "safari", name: "Safari", chromium: false, macApps: ["Safari.app"], macBundleId: "com.apple.safari", winPaths: [], winProgIds: [], proc: "Safari" },
  { id: "edge", name: "Microsoft Edge", chromium: true, macApps: ["Microsoft Edge.app"], macBundleId: "com.microsoft.edgemac", winPaths: ["Microsoft/Edge/Application/msedge.exe"], winProgIds: ["MSEdgeHTM"], proc: "Microsoft Edge" },
  { id: "arc", name: "Arc", chromium: true, macApps: ["Arc.app"], macBundleId: "company.thebrowser.browser", winPaths: [], winProgIds: [], proc: "Arc" },
  { id: "brave", name: "Brave", chromium: true, macApps: ["Brave Browser.app"], macBundleId: "com.brave.browser", winPaths: ["BraveSoftware/Brave-Browser/Application/brave.exe"], winProgIds: ["BraveHTML"], proc: "Brave Browser" },
  { id: "firefox", name: "Firefox", chromium: false, macApps: ["Firefox.app"], macBundleId: "org.mozilla.firefox", winPaths: ["Mozilla Firefox/firefox.exe"], winProgIds: ["FirefoxURL"], proc: "Firefox" },
  { id: "vivaldi", name: "Vivaldi", chromium: true, macApps: ["Vivaldi.app"], macBundleId: "com.vivaldi.vivaldi", winPaths: ["Vivaldi/Application/vivaldi.exe"], winProgIds: ["VivaldiHTM"], proc: "Vivaldi" },
  { id: "opera", name: "Opera", chromium: true, macApps: ["Opera.app"], macBundleId: "com.operasoftware.opera", winPaths: ["Opera/opera.exe"], winProgIds: ["OperaStable"], proc: "Opera" },
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

let defaultCache: InstalledBrowser | null | undefined; // undefined = not yet probed

/**
 * The machine's default https browser, resolved to a concrete detected
 * browser — so "System default" can still open a NEW WINDOW (which needs a
 * real app path + launch flags), not just a fire-and-forget tab.
 * Returns null if it can't be resolved (unknown/unlisted browser).
 */
export function getDefaultBrowser(): InstalledBrowser | null {
  if (defaultCache !== undefined) return defaultCache;
  let matched: InstalledBrowser | null = null;
  try {
    if (process.platform === "darwin") {
      // LaunchServices records the per-scheme handler bundle id. plutil is
      // always present; convert the (binary) secure plist to JSON and find
      // the https handler.
      const plist = path.join(os.homedir(), "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist");
      const json = execFileSync("plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf8", timeout: 3000 });
      const handlers = (JSON.parse(json).LSHandlers || []) as Array<{ LSHandlerURLScheme?: string; LSHandlerRoleAll?: string }>;
      const https = handlers.find((h) => h.LSHandlerURLScheme === "https");
      const bundleId = https?.LSHandlerRoleAll?.toLowerCase();
      if (bundleId) {
        const def = KNOWN.find((d) => d.macBundleId === bundleId);
        if (def) matched = detectBrowsers().find((b) => b.id === def.id) || null;
      } else {
        // No recorded https handler → Safari is the implicit OS default.
        matched = detectBrowsers().find((b) => b.id === "safari") || null;
      }
    } else if (process.platform === "win32") {
      // HKCU UserChoice ProgId is the authoritative default for https.
      const out = execFileSync("reg", [
        "query",
        "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice",
        "/v", "ProgId",
      ], { encoding: "utf8", timeout: 3000 });
      const m = out.match(/ProgId\s+REG_SZ\s+(\S+)/i);
      const progId = m?.[1] || "";
      const def = KNOWN.find((d) => d.winProgIds.some((p) => progId.startsWith(p)));
      if (def) matched = detectBrowsers().find((b) => b.id === def.id) || null;
    }
  } catch { /* unreadable / unknown handler → null (fire-and-forget fallback) */ }
  defaultCache = matched;
  return matched;
}

/** Resolve an app's configured browser id, mapping "default"/unset to the
 *  machine's actual default browser so New window works there too. */
export function resolveBrowser(id: string | undefined | null): InstalledBrowser | null {
  if (id && id !== "default") return getBrowser(id);
  return getDefaultBrowser();
}

/** The installed browser this executable path points at (a saved "native"
 *  app card whose binary IS a browser), or null. Matched by bundle/exe
 *  basename so path casing or install root differences don't matter. */
export function browserForExecPath(execPath: string | null | undefined): InstalledBrowser | null {
  const base = (execPath || "").trim().replace(/[\\/]+$/, "").split(/[\\/]/).pop()?.toLowerCase();
  if (!base) return null;
  return detectBrowsers().find((b) => (b.appPath.split(/[\\/]/).pop() || "").toLowerCase() === base) || null;
}
