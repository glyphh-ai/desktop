/**
 * A SESSION WORKS IN ITS FOLDER AND NOWHERE ELSE (his rule, 2026-09-29: "The
 * agent should work from the selected folder period!!! that is a hard hard
 * constraint, it is sandboxed to that folder").
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBuiltin } from "../../src/loop/tools.js";
import { shellProfile, shellLaunch } from "../../src/loop/sandbox.js";
import { GlyphhLoop, NO_FOLDER_MESSAGE, type LoopEvent } from "../../src/loop/loop.js";

const fresh = () => {
  const root = mkdtempSync(join(tmpdir(), "gl-sbx-"));
  const folder = join(root, "project");
  const outside = join(root, "outside");
  mkdirSync(folder); mkdirSync(outside);
  writeFileSync(join(folder, "in.txt"), "inside\n");
  writeFileSync(join(outside, "secret.txt"), "secret\n");
  return { root, folder, outside };
};

describe("the file tools stay in the session's folder", () => {
  it("read, list and search refuse anything outside — by .., absolute path, or symlink", async () => {
    const { folder, outside } = fresh();
    symlinkSync(outside, join(folder, "link"));
    for (const input of [{ path: "../outside/secret.txt" }, { path: join(outside, "secret.txt") }, { path: "link/secret.txt" }]) {
      const r = await runBuiltin("read_file", input, folder);
      expect(r.failed).toBe(true);
      expect(r.text).toMatch(/outside this session's folder/);
      expect(r.text).not.toContain("secret\n");
    }
    expect((await runBuiltin("list_dir", { path: ".." }, folder)).failed).toBe(true);
    expect((await runBuiltin("grep", { pattern: "secret", path: outside }, folder)).failed).toBe(true);
    expect((await runBuiltin("glob", { pattern: "*.txt", path: "../outside" }, folder)).failed).toBe(true);
    // Inside is fine.
    expect((await runBuiltin("read_file", { path: "in.txt" }, folder)).text).toBe("inside\n");
  });

  it("write and edit cannot land outside, even through a folder that does not exist yet", async () => {
    const { folder, outside } = fresh();
    const w = await runBuiltin("write_file", { path: "../outside/new/evil.txt", content: "x" }, folder);
    expect(w.failed).toBe(true);
    expect(existsSync(join(outside, "new"))).toBe(false);
    const e = await runBuiltin("edit_file", { path: join(outside, "secret.txt"), old_string: "secret", new_string: "pwned" }, folder);
    expect(e.failed).toBe(true);
    expect(readFileSync(join(outside, "secret.txt"), "utf-8")).toBe("secret\n");
    // A new file in a new sub-folder of the session's folder is fine, and says what it did.
    const ok = await runBuiltin("write_file", { path: "src/new.ts", content: "a\nb\n" }, folder);
    expect(ok.failed).toBe(false);
    expect(ok.detail).toMatchObject({ kind: "diff", created: true, added: 2, removed: 0 });
  });
});

describe("the shell is sandboxed to the folder (macOS Seatbelt)", () => {
  it("the profile denies every write, then allows only the folder and the named extras", () => {
    const p = shellProfile("/Users/me/project", ["/private/tmp"]);
    const deny = p.indexOf("(deny file-write*)");
    const allow = p.indexOf("(allow file-write* ");
    // Later rules win in Seatbelt: the allow must come after the blanket deny.
    expect(deny).toBeGreaterThan(-1);
    expect(allow).toBeGreaterThan(deny);
    expect(p).toContain('(subpath "/Users/me/project")');
    expect(p).toContain('(subpath "/private/tmp")');
    expect(p).not.toMatch(/\(subpath "\/Users\/me"\)/);
    // A folder name cannot break out of its string.
    expect(shellProfile('/x/a"b', [])).toContain('(subpath "/x/a\\"b")');
  });

  it("on macOS the shell is launched under sandbox-exec with the folder's REAL path", () => {
    const { folder } = fresh();
    const l = shellLaunch("/bin/zsh", "echo hi", folder);
    if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) {
      expect(l.sandboxed).toBe(false);
      return;
    }
    expect(l.sandboxed).toBe(true);
    expect(l.file).toBe("/usr/bin/sandbox-exec");
    expect(l.args[1]).toContain(`(subpath "${realpathSync(folder)}")`);
    expect(l.args.slice(2)).toEqual(["/bin/zsh", "-lc", "echo hi"]);
  });
});

describe("the shell FAILS CLOSED", () => {
  it("a sandbox that cannot be applied runs nothing, and says so", async () => {
    const { folder } = fresh();
    const r = await runBuiltin("bash", { command: "echo ran > ran.txt && echo hi" }, folder);
    const l = shellLaunch("/bin/zsh", "true", folder);
    if (!l.sandboxed) return;   // no Seatbelt on this platform: nothing to fail closed
    if (r.failed && /sandbox could not be applied/.test(r.text)) {
      // Nested inside another sandbox (CI, this harness): the command never ran.
      expect(existsSync(join(folder, "ran.txt"))).toBe(false);
      expect(r.detail).toMatchObject({ kind: "command", stdout: "" });
    } else {
      // Seatbelt applied: a write INSIDE the folder is allowed.
      expect(r.failed).toBe(false);
      expect(readFileSync(join(folder, "ran.txt"), "utf-8")).toBe("ran\n");
    }
  });
});

describe("a Code turn needs its folder", () => {
  it("refuses in its own words rather than falling back to the home directory", async () => {
    const loop = new GlyphhLoop({ gateway: async () => ({ baseUrl: "https://gw", token: "k" }) });
    const events: LoopEvent[] = [];
    await loop.run({ chatId: "nofolder", text: "hi", model: "m" }, (ev) => events.push(ev));
    expect(events.map((e) => e.type)).toEqual(["error", "done"]);
    expect((events[0] as { error: string }).error).toBe(NO_FOLDER_MESSAGE);
  });
});
