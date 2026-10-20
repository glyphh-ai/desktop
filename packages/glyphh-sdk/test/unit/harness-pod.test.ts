/**
 * harness-pod.test.ts — the LOCAL HARNESS POD supervisor helper: it rides the
 * runtime supervisor with a separate home, launches rrotor in ROTOR_MODE=harness
 * with introspection auth cleared, and resolves the dev launch command from
 * GLYPHH_LOCAL_ROTOR_CMD (whitespace-split, preArgs before `serve`).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLocalHarnessPod, resolveHarnessCommand } from "../../src/runtime/index.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "glyphh-harness-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function fakeChild(pid: number) {
  return { pid, unref() {} } as unknown as ReturnType<typeof import("node:child_process").spawn>;
}

describe("resolveHarnessCommand", () => {
  it("splits a full command into bin + preArgs (the dev repo-entry launch)", () => {
    expect(resolveHarnessCommand("node /repo/rrotor/dist/cli.js")).toEqual({
      bin: "node",
      preArgs: ["/repo/rrotor/dist/cli.js"],
    });
  });

  it("a bare command is just the bin", () => {
    expect(resolveHarnessCommand("rrotor")).toEqual({ bin: "rrotor", preArgs: [] });
  });
});

describe("ensureLocalHarnessPod", () => {
  it("spawns rrotor in harness mode: preArgs before `serve`, ROTOR_MODE=harness, auth cleared", async () => {
    let seen: { cmd?: string; args?: string[]; env?: NodeJS.ProcessEnv } = {};
    const pod = await ensureLocalHarnessPod({
      home,
      cmd: "node /repo/rrotor/dist/cli.js",
      spawnImpl: (cmd, args, opts) => {
        seen = { cmd, args, env: opts.env };
        return fakeChild(777);
      },
      fetchImpl: (async () => ({ ok: true })) as unknown as typeof fetch,
    });
    expect(seen.cmd).toBe("node");
    expect(seen.args?.slice(0, 3)).toEqual(["/repo/rrotor/dist/cli.js", "serve", "-p"]);
    expect(seen.env?.ROTOR_MODE).toBe("harness");
    expect(seen.env?.ROTOR_AUTH_INTROSPECT_URL).toBeUndefined();
    expect(seen.env?.HARNESS_HOME).toBe(join(home, "state"));
    expect(pod.pid).toBe(777);
    expect(pod.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    // Its discovery record lives in the HARNESS home — separate from the
    // rotor-mode runtime's record by construction.
    expect(existsSync(join(home, "runtime.json"))).toBe(true);
  });

  it("attaches to an already-healthy pod without spawning again", async () => {
    let spawned = 0;
    const opts = {
      home,
      cmd: "rrotor",
      spawnImpl: () => {
        spawned++;
        return fakeChild(101);
      },
      fetchImpl: (async () => ({ ok: true })) as unknown as typeof fetch,
    };
    const first = await ensureLocalHarnessPod(opts);
    const again = await ensureLocalHarnessPod(opts);
    expect(spawned).toBe(1);
    expect(again.url).toBe(first.url);
  });
});
