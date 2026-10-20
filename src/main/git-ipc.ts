/**
 * git-ipc.ts — the DESKTOP's GitHub seam (his spec, 2026-08-27: "the user
 * should be able to pull a repo from github when the local folder is empty").
 *
 *   git-clone-into  → clone owner/name into a LOCAL folder with this
 *                     machine's own git: a public repo, or a private one the
 *                     user's credential helper can reach. The folder must be
 *                     empty (or absent — it is created). Any credential that
 *                     leaks into git's output is scrubbed before it can reach
 *                     a log or the renderer.
 */

import { ipcMain } from "electron";
import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";

/** Strip any credential from a git URL that leaked into output. */
function scrub(text: string): string {
  return text.replace(/https:\/\/[^@\s/]+@/g, "https://");
}

function runGit(args: string[], cwd?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { out += String(d); });
    child.on("error", (e) => resolve({ code: -1, out: scrub(e.message) }));
    child.on("close", (code) => resolve({ code: code ?? -1, out: scrub(out) }));
  });
}

export function registerGitIpc(): void {
  ipcMain.handle("git-clone-into", async (_e, repo: string, dir: string) => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo ?? ""))) return { ok: false, error: "repo must be owner/name" };
    const target = String(dir ?? "").trim();
    if (!target) return { ok: false, error: "a target folder is required" };
    // The folder must be EMPTY (or absent) — cloning over someone's files is
    // exactly the kind of surprise this app never springs.
    try {
      const entries = await fsp.readdir(target).catch(async (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") { await fsp.mkdir(target, { recursive: true }); return []; }
        throw err;
      });
      const real = entries.filter((n) => n !== ".DS_Store");
      if (real.length) return { ok: false, error: "the folder isn't empty — pick an empty (or new) folder to clone into" };
    } catch (e) { return { ok: false, error: (e as Error).message }; }

    const res = await runGit(["clone", "--", `https://github.com/${repo}.git`, "."], target);
    if (res.code !== 0) return { ok: false, error: res.out.trim().slice(-400) || "git clone failed" };
    return { ok: true };
  });
}
