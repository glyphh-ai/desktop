/**
 * native-launch — open an app outside Glyphh's webview shell (5b app model).
 *
 * Two cases the in-window BrowserWindow path can't cover:
 *   - a BROWSER app whose target is "native" → open its URL in the user's real
 *     Chrome (not the persist:yo webview);
 *   - a NATIVE app (isBrowser=false) → launch its executable, honoring the
 *     archetype's launch config (terminal cwd, editor folder, generic args).
 *
 * Launch-only for v1: we start the app/URL, we don't drive it. Injecting shell
 * init commands / Terminal profiles is deferred (needs AppleScript / a PTY).
 */

import { spawn } from "child_process";
import { shell } from "electron";

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

/** Open a URL in the user's native Chrome, falling back to the OS default
 *  browser if Chrome isn't found. */
export function launchInNativeChrome(url: string): LaunchResult {
  if (!/^https?:\/\//.test(url)) return { ok: false, error: "App has no web URL" };
  try {
    if (process.platform === "darwin") {
      spawn("open", ["-a", "Google Chrome", url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "win32") {
      // `start "" chrome <url>` — the empty title arg keeps start from eating the URL.
      spawn("cmd", ["/c", "start", "", "chrome", url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("google-chrome", [url], { detached: true, stdio: "ignore" }).unref();
    }
    return { ok: true };
  } catch {
    // Chrome not resolvable on PATH — fall back to the default browser.
    void shell.openExternal(url).catch(() => {});
    return { ok: true };
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
