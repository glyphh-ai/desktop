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
  const lc = launchConfig || {};

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
      spawn("open", args, { detached: true, stdio: "ignore" }).unref();
    } else {
      // Plain executable — spawn directly with cwd honored where relevant.
      const args = [...(pathArg ? [pathArg] : []), ...genericArgs];
      spawn(exec, args, {
        detached: true,
        stdio: "ignore",
        cwd: str(lc.cwd) || undefined,
      }).unref();
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
