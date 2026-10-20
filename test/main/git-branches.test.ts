/**
 * The composer's branch chip, on a real repo in a temp folder: list, switch,
 * start a branch, turn git on, and git's refusals said plainly.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() }, dialog: {}, BrowserWindow: {}, shell: {}, app: { getPath: () => tmpdir() } }));
vi.mock("../../src/main/stores/preferences-db", () => ({ getPreference: () => null, setPreference: () => undefined }));

const W = await import("../../src/main/working-directory.js");

let dir = "";
const git = (...a: string[]): string => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
function repo(): void {
  git("init", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "one");
  git("add", ".");
  git("commit", "-m", "one");
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "glyphh-branches-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("branch chip", () => {
  it("lists nothing for a folder without git, then turns git on to main", async () => {
    expect(await W.gitBranchesForDir(dir)).toEqual({ isRepo: false, branches: [] });
    const on = await W.gitInitDir(dir);
    expect(on.isRepo).toBe(true);
    expect(on.current).toBe("main");
    expect(on.branches).toContain("main");
  });

  it("starts a branch, switches back, and lists both", async () => {
    repo();
    const made = await W.gitCreateBranch(dir, "feature/x");
    expect(made.current).toBe("feature/x");
    const back = await W.gitSwitchBranch(dir, "main");
    expect(back.current).toBe("main");
    expect(back.branches.sort()).toEqual(["feature/x", "main"]);
  });

  it("refuses a taken or bad name, and a switch that would lose changes, in plain words", async () => {
    repo();
    await expect(W.gitCreateBranch(dir, "main")).rejects.toThrow(/already exists/);
    await expect(W.gitCreateBranch(dir, "bad name..")).rejects.toThrow(/can't be a branch name/);
    await expect(W.gitCreateBranch(dir, "-x")).rejects.toThrow(/can't be a branch name/);
    await expect(W.gitSwitchBranch(dir, "")).rejects.toThrow(/pick a branch/);
    git("checkout", "-b", "other");
    writeFileSync(join(dir, "a.txt"), "two");
    git("commit", "-am", "two");
    git("checkout", "main");
    writeFileSync(join(dir, "a.txt"), "dirty");
    await expect(W.gitSwitchBranch(dir, "other")).rejects.toThrow(/would overwrite/);
  });

  it("says git's other refusals plainly", () => {
    expect(W.gitWords(new Error("fatal: not a git repository"))).toBe("This folder doesn't track changes yet.");
    expect(W.gitWords(new Error("spawn git ENOENT"))).toBe("Git isn't installed on this machine.");
    expect(W.gitWords(new Error("error: something odd\nmore"))).toBe("something odd");
    expect(W.gitWords("x")).toBe("x");
  });
});
