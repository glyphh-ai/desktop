/**
 * git-ipc.ts — the DESKTOP's GitHub seam (his spec, 2026-08-27: "the user
 * should be able to pull a repo from github when the local folder is empty —
 * create from git, just like in the cloud").
 *
 * The renderer has no SDK handle on desktop (that is a web-bridge thing), so
 * the source chip reaches the git surface through these handlers:
 *
 *   git-status      → the caller's connection (login, connected)
 *   git-repos       → their repo list (the same picker the cloud path shows)
 *   git-connect     → the OAuth link URL (opened in the default browser)
 *   git-clone-into  → clone owner/name into a LOCAL folder. The folder must
 *                     be empty (or absent — it is created). A private repo
 *                     clones with a short-lived, repo-scoped token from
 *                     /api/git/clone-token; the token rides ONLY the process
 *                     argv and is scrubbed from every error before it can
 *                     reach a log or the renderer.
 */

import { ipcMain, shell } from "electron";
import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import { getClient } from "./glyphh-client";

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
  ipcMain.handle("git-status", async () => {
    try { return { ok: true, status: await getClient().git.status() }; }
    catch (e) { return { ok: false, error: (e as Error).message }; }
  });

  ipcMain.handle("git-repos", async () => {
    try { return { ok: true, repos: await getClient().git.repos() }; }
    catch (e) { return { ok: false, error: (e as Error).message }; }
  });

  ipcMain.handle("git-connect", async () => {
    try {
      const link = await getClient().git.connect();
      if (link?.url) void shell.openExternal(link.url);
      return { ok: !!link?.url };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  });

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

    // Private repos ride a short-lived, repo-scoped token; a 404 (App doesn't
    // cover the repo / not connected) falls back to a plain HTTPS clone,
    // which still works for public repos and local credential helpers.
    let url = `https://github.com/${repo}.git`;
    try {
      const minted = await getClient().git.cloneToken(repo);
      if (minted?.token) url = `https://x-access-token:${minted.token}@github.com/${repo}.git`;
    } catch { /* fall through to the plain URL */ }

    const res = await runGit(["clone", "--", url, "."], target);
    if (res.code !== 0) return { ok: false, error: res.out.trim().slice(-400) || "git clone failed" };
    // Never leave the token in the remote — rewrite origin to the clean URL.
    await runGit(["remote", "set-url", "origin", `https://github.com/${repo}.git`], target);
    return { ok: true };
  });
}
