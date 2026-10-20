/**
 * loop/sandbox.ts — A SESSION WORKS IN ITS FOLDER AND NOWHERE ELSE (his rule,
 * 2026-09-29: "The agent should work from the selected folder period!!! that
 * is a hard hard constraint, it is sandboxed to that folder").
 *
 * Two walls:
 *
 *  - FILE TOOLS (read, write, edit, list, glob, grep) resolve every path —
 *    `..`, absolute paths, symlinks — to where it really lands, and refuse
 *    anything outside the folder. Reads included: the folder is the session's
 *    whole world.
 *
 *  - THE SHELL runs under the OS sandbox on macOS (Seatbelt, the same mechanism
 *    the system's own sandboxed tools use): it may READ what the user can, but
 *    it may WRITE only inside the folder, the temp directories, `/dev`, and the
 *    package managers' caches (so `npm install` and `pip install` can work).
 *    If the sandbox cannot be applied the command does not run — failing closed
 *    is the point. Elsewhere the shell is pinned to the folder as its cwd, which
 *    is weaker, and the host is told so.
 */

import { existsSync, promises as fs, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export class OutsideFolderError extends Error {}

/** The real path of `p`, or of its nearest existing ancestor with the rest
 *  re-attached — so a file that does not exist YET (a write) is judged by where
 *  it would land, through whatever symlinks lead there. */
async function realOf(p: string): Promise<string> {
  let cur = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try { return path.join(await fs.realpath(cur), ...rest.reverse()); }
    catch {
      const up = path.dirname(cur);
      if (up === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = up;
    }
  }
}

const within = (root: string, target: string): boolean => {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** Resolve `p` against the folder and refuse it if it lands outside. */
export async function insideFolder(folder: string, p: string): Promise<string> {
  const root = await realOf(folder);
  const target = await realOf(path.resolve(folder, p || "."));
  if (!within(root, target)) {
    throw new OutsideFolderError(`${p || "."} is outside this session's folder (${folder}). The agent works only inside it — ask the user to change the session's folder if they need somewhere else.`);
  }
  return target;
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Paths the shell may write besides the folder. Real paths — Seatbelt matches
 *  on them, and /tmp is a symlink on macOS. */
function writableExtras(): string[] {
  const home = os.homedir();
  const real = (p: string): string => { try { return realpathSync(p); } catch { return p; } };
  return [
    real(os.tmpdir()), "/private/tmp", "/private/var/folders", "/dev",
    // The package managers' own caches — not the user's files, and without
    // them nothing can be installed.
    path.join(home, "Library", "Caches"), path.join(home, ".cache"), path.join(home, ".npm"),
    path.join(home, ".pnpm-store"), path.join(home, ".yarn"), path.join(home, ".cargo", "registry"),
  ];
}

const sbString = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The Seatbelt profile: allow everything, then deny every write, then allow
 *  writes under the folder and the extras (later rules win). */
export function shellProfile(folder: string, extras: string[] = writableExtras()): string {
  const allowed = [folder, ...extras].map((p) => `(subpath ${sbString(p)})`).join(" ");
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${allowed})`,
  ].join("\n");
}

export interface ShellLaunch { file: string; args: string[]; sandboxed: boolean }

/** How to launch `cmd` for a session in `folder`. */
export function shellLaunch(shell: string, cmd: string, folder: string): ShellLaunch {
  if (process.platform === "darwin" && existsSync(SANDBOX_EXEC)) {
    let root = folder;
    try { root = realpathSync(folder); } catch { /* the caller already checked it exists */ }
    return { file: SANDBOX_EXEC, args: ["-p", shellProfile(root), shell, "-lc", cmd], sandboxed: true };
  }
  return { file: shell, args: ["-lc", cmd], sandboxed: false };
}

/** Seatbelt could not be applied (already inside another sandbox, or policy):
 *  the command must not run unconfined. */
export const sandboxApplyFailed = (stderr: string): boolean => /sandbox_apply|sandbox-exec: .*not permitted/i.test(stderr);
