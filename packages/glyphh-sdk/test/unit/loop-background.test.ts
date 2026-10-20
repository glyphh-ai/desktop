import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBuiltin } from "../../src/loop/tools.js";

const plain = (_shell: string, cmd: string) => ({ file: "/bin/sh", args: ["-c", cmd], sandboxed: false });

describe("bash background: true (his report, 2026-09-29: `npm run dev` blocked the turn and was killed)", () => {
  it("returns while the command keeps running, with its pid and first output", async () => {
    const folder = mkdtempSync(join(tmpdir(), "bg-"));
    const t0 = Date.now();
    const r = await runBuiltin("bash", { command: "echo listening on 5173; sleep 30", background: true }, folder, undefined, plain);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r.failed).toBe(false);
    expect(r.text).toContain("still running");
    expect(r.text).toContain("listening on 5173");
    const pid = Number(/pid (\d+)/.exec(r.text)?.[1]);
    expect(() => process.kill(pid, 0)).not.toThrow();
    process.kill(-pid, "SIGTERM");
  });

  it("a command that fails at once is reported as failed, not as started", async () => {
    const folder = mkdtempSync(join(tmpdir(), "bg-"));
    const r = await runBuiltin("bash", { command: "echo nope >&2; exit 3", background: true }, folder, undefined, plain);
    expect(r.failed).toBe(true);
    expect(r.text).toContain("exit 3");
  });
});
