/**
 * shell-path — resolve the user's real shell PATH at startup.
 *
 * Electron on macOS launched from Finder/Dock inherits a sanitized PATH
 * (typically `/usr/bin:/bin:/usr/sbin:/sbin`). This breaks any spawned
 * subprocess that needs Homebrew, asdf, nvm, etc.
 *
 * Terminals dodge this by spawning `zsh -il`, which loads the user's profile.
 * Direct spawns (PTYs, agent shells) need an explicit fix.
 *
 * This module runs the user's login+interactive shell once at app startup,
 * captures its PATH, and exposes it for spawn() callers to merge into env.
 */
import { execSync } from "child_process";
import * as os from "os";

let cachedPath: string | null = null;

/** Hardcoded fallback paths covering Homebrew (Intel + ARM) and common local bins. */
const FALLBACK_PATHS = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
  `${os.homedir()}/.local/bin`,
  `${os.homedir()}/.cargo/bin`,
  `${os.homedir()}/.npm-global/bin`,
];

/**
 * Resolve the user's real shell PATH. Called once at app startup.
 * Result is cached for the process lifetime.
 *
 * On Windows or if shell resolution fails, falls back to process.env.PATH
 * augmented with common dev-tool dirs.
 */
export function resolveShellPath(): string {
  if (cachedPath !== null) return cachedPath;

  const platform = os.platform();
  const currentPath = process.env.PATH || "";

  if (platform === "win32") {
    cachedPath = currentPath;
    return cachedPath;
  }

  const shell = process.env.SHELL || "/bin/zsh";

  try {
    // -i loads .zshrc/.bashrc (Homebrew, version managers); -l loads .zprofile.
    // Use null sep + printenv so we don't mangle PATHs containing colons or
    // shell-RC noise printed before our value.
    const out = execSync(
      `${shell} -ilc 'printf "%s" "$PATH"' 2>/dev/null`,
      { encoding: "utf-8", timeout: 3000 }
    ).trim();

    if (out && out.includes("/")) {
      cachedPath = mergeWithFallback(out, currentPath);
      console.log("[shell-path] resolved:", cachedPath);
      return cachedPath;
    }
  } catch (err) {
    console.log("[shell-path] shell resolution failed:", (err as Error).message);
  }

  // Shell didn't cooperate — augment current PATH with hardcoded fallbacks.
  cachedPath = mergeWithFallback("", currentPath);
  console.log("[shell-path] using fallback:", cachedPath);
  return cachedPath;
}

/** Get cached PATH (resolveShellPath() must have been called at least once). */
export function getShellPath(): string {
  return cachedPath ?? resolveShellPath();
}

/** Merge resolved + current + fallback paths, dedup preserving order. */
function mergeWithFallback(resolved: string, current: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (parts: string[]) => {
    for (const p of parts) {
      if (p && !seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  };
  if (resolved) add(resolved.split(":"));
  add(FALLBACK_PATHS);
  if (current) add(current.split(":"));
  return out.join(":");
}

/**
 * Build a spawn-ready env object with the resolved PATH merged in.
 * Use this anywhere you spawn a subprocess that needs git, npm, Homebrew tools, etc.
 */
export function envWithShellPath(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extra,
    PATH: getShellPath(),
  };
}
