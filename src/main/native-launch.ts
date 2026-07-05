/**
 * native-launch — start real OS apps (the native-OS app model).
 *
 *   - a WEB app → its URL opens in the user's chosen real browser
 *     (launchWebApp: window or tab, per the app's config);
 *   - a NATIVE app (isBrowser=false) → launch its executable, honoring the
 *     archetype's launch config (terminal cwd, editor folder, generic args).
 *
 * Launch-only: we start the app/URL; window adoption/positioning happens in
 * app-resolver via the OS window manager.
 */

import { spawn } from "child_process";
import { shell } from "electron";
import type { InstalledBrowser } from "./browser-detect.js";

export type LaunchResult = { ok: boolean; error?: string };

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Detached spawn with a MANDATORY error handler — a failed exec (EACCES,
 *  ENOENT, …) emits 'error' asynchronously, and with no listener Node raises an
 *  uncaught exception that crashes the app. Log instead. */
function safeSpawn(cmd: string, args: string[], cwd?: string): void {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", cwd });
    child.on("error", (err) => console.error(`[native-launch] spawn failed (${cmd}):`, err.message));
    child.unref();
  } catch (err) {
    console.error(`[native-launch] spawn threw (${cmd}):`, err instanceof Error ? err.message : String(err));
  }
}

/** Escape a string for embedding inside an AppleScript double-quoted literal. */
function appleEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function runOsascript(lines: string[]): void {
  const args = lines.flatMap((l) => ["-e", l]);
  spawn("osascript", args, { detached: true, stdio: "ignore" }).unref();
}

/**
 * macOS Terminal.app: open a new window, a new tab, or nothing at all (just
 * bring Terminal to the front as-is). Tab mode uses a Cmd+T keystroke (needs
 * Accessibility permission); window mode uses AppleScript's `do script`, which
 * always spawns a fresh window; blank mode only activates the app so the user
 * lands on whatever window/tab is already open.
 */
function launchMacTerminal(lc: Record<string, unknown>, mode: string): void {
  // Blank — "just open the app, no new anything." Only activate Terminal; skip
  // cwd / init commands so we don't disturb the current session.
  if (mode === "blank") {
    runOsascript(['tell application "Terminal" to activate']);
    return;
  }
  const cwd = str(lc.cwd);
  const cmds: string[] = [];
  if (cwd) cmds.push(`cd "${cwd}"`);
  if (Array.isArray(lc.initCommands)) {
    for (const c of lc.initCommands as unknown[]) { const s = str(c); if (s) cmds.push(s); }
  }
  const script = appleEscape(cmds.join("; "));
  if (mode === "tab") {
    runOsascript([
      'tell application "Terminal" to activate',
      'tell application "System Events" to keystroke "t" using command down',
      'delay 0.15',
      `tell application "Terminal" to do script "${script}" in front window`,
    ]);
  } else {
    runOsascript([
      'tell application "Terminal"',
      'activate',
      `do script "${script}"`,
      'end tell',
    ]);
  }
}

/**
 * Open a web app in a real browser — the ONLY way web apps open (we stay
 * native OS: the user's own browser, extensions, sessions; no webview shell).
 *
 *   browser — a detected browser (browser-detect), or null = system default.
 *   openAs  — "window": a NEW browser window, trackable by the OS window
 *             manager so layouts/panels can tile, focus, and re-find it;
 *             "tab": a tab in the frontmost window (fire-and-forget — no
 *             cross-browser way to address a specific tab afterwards).
 */
export function launchWebApp(url: string, browser: InstalledBrowser | null, openAs: "window" | "tab"): LaunchResult {
  if (!/^https?:\/\//.test(url)) return { ok: false, error: "App has no web URL" };
  try {
    if (!browser) {
      // "System default" — we can't know which app claims the URL, so this is
      // always fire-and-forget (no window to track).
      void shell.openExternal(url).catch(() => {});
      return { ok: true };
    }
    if (process.platform === "darwin") {
      if (openAs === "tab") {
        safeSpawn("open", ["-a", browser.appPath, url]);
      } else if (browser.chromium) {
        // -n signals a fresh activation so --args reach a NEW window.
        safeSpawn("open", ["-na", browser.appPath, "--args", "--new-window", url]);
      } else if (browser.id === "firefox") {
        safeSpawn("open", ["-na", browser.appPath, "--args", "-new-window", url]);
      } else if (browser.id === "safari") {
        // Safari has no CLI window flag — AppleScript makes a real new window.
        runOsascript([
          'tell application "Safari"',
          "activate",
          `make new document with properties {URL:"${appleEscape(url)}"}`,
          "end tell",
        ]);
      } else {
        safeSpawn("open", ["-a", browser.appPath, url]);
      }
    } else if (process.platform === "win32") {
      safeSpawn(browser.appPath, openAs === "window"
        ? [browser.chromium ? "--new-window" : "-new-window", url]
        : [url]);
    } else {
      safeSpawn(browser.appPath, openAs === "window" ? ["--new-window", url] : [url]);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Launch a native desktop app by executable path. The archetype decides which
 * launchConfig field becomes the primary argument:
 *   - terminal → cwd (open the terminal at that directory)
 *   - editor   → folder (open the editor on that folder)
 *   - generic  → args[] passed through verbatim
 */
export function launchNativeApp(
  execPath: string,
  archetype?: string | null,
  launchConfig?: Record<string, unknown> | null,
): LaunchResult {
  const exec = str(execPath);
  if (!exec) return { ok: false, error: "Native app has no executable path" };
  // Guard: an HTML entry (e.g. a Glyphh app's index.html) must NEVER be
  // spawned as a program — spawn would fire an async EACCES that crashes the
  // whole app. Those apps are opened by glyphh-app-host, not here.
  if (/\.html?$/i.test(exec)) {
    return { ok: false, error: "not a launchable executable (Glyphh apps open in their own window)" };
  }
  const lc = launchConfig || {};

  // macOS Terminal.app honors the window/tab choice + runs cwd/init commands
  // via AppleScript. Other terminals / platforms fall through to `open`, which
  // opens a new window (tab mode isn't controllable generically).
  if (process.platform === "darwin" && archetype === "terminal") {
    const appName = (exec.split("/").pop() || "").replace(/\.app$/, "");
    if (appName === "Terminal") {
      try {
        launchMacTerminal(lc, str(lc.windowMode) || "window");
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  }

  const pathArg =
    archetype === "terminal" ? str(lc.cwd) :
    archetype === "editor" ? str(lc.folder) :
    "";
  const genericArgs = archetype === "generic" && Array.isArray(lc.args)
    ? (lc.args as unknown[]).map(str).filter(Boolean)
    : [];

  try {
    if (process.platform === "darwin" && exec.endsWith(".app")) {
      // macOS bundle: `open -a <Bundle> [file] [--args ...]`.
      const args = ["-a", exec];
      if (pathArg) args.push(pathArg);
      if (genericArgs.length) args.push("--args", ...genericArgs);
      safeSpawn("open", args);
    } else {
      // Plain executable — spawn directly with cwd honored where relevant.
      const args = [...(pathArg ? [pathArg] : []), ...genericArgs];
      safeSpawn(exec, args, str(lc.cwd) || undefined);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
