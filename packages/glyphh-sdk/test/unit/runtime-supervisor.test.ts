/**
 * runtime-supervisor.test.ts — the local runtime is a singleton: attach when one is
 * already healthy (never spawn twice), spawn when none exists, and re-spawn past a stale
 * record. Deterministic via injected spawn/fetch + a temp home.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLocalRuntime, localRuntimeStatus } from "../../src/runtime/index.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "glyphh-rt-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function fakeChild(pid: number) {
  return { pid, unref() {} } as unknown as ReturnType<typeof import("node:child_process").spawn>;
}

describe("ensureLocalRuntime", () => {
  it("attaches to an already-healthy runtime without spawning", async () => {
    writeFileSync(
      join(home, "runtime.json"),
      JSON.stringify({ url: "http://127.0.0.1:9", port: 9, pid: 111, token: "t", version: "1", startedAt: 1 }),
    );
    let spawned = 0;
    const rt = await ensureLocalRuntime({
      home,
      spawnImpl: () => { spawned++; return fakeChild(999); },
      fetchImpl: (async () => ({ ok: true })) as unknown as typeof fetch,
    });
    expect(rt).toEqual({ url: "http://127.0.0.1:9", token: "t", pid: 111 });
    expect(spawned).toBe(0);
  });

  it("spawns the runtime once when none is running, then records it", async () => {
    let spawned = 0;
    const rt = await ensureLocalRuntime({
      home,
      spawnImpl: (_cmd, args) => {
        spawned++;
        expect(args[0]).toBe("serve");
        expect(args[1]).toBe("-p");
        return fakeChild(4242);
      },
      fetchImpl: (async () => ({ ok: true })) as unknown as typeof fetch,
    });
    expect(spawned).toBe(1);
    expect(rt.pid).toBe(4242);
    expect(rt.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    // A second call attaches to the just-started one — no second spawn.
    const again = await ensureLocalRuntime({
      home,
      spawnImpl: () => { spawned++; return fakeChild(0); },
      fetchImpl: (async () => ({ ok: true })) as unknown as typeof fetch,
    });
    expect(spawned).toBe(1);
    expect(again.pid).toBe(4242);
  });

  it("re-spawns past a stale (unhealthy) record", async () => {
    writeFileSync(
      join(home, "runtime.json"),
      JSON.stringify({ url: "http://127.0.0.1:1", port: 1, pid: 222, token: "old", version: "1", startedAt: 1 }),
    );
    let spawned = 0;
    // The stale url (:1) is unhealthy; a freshly-spawned port is healthy.
    const fetchImpl = (async (u: string) => ({ ok: !u.includes("127.0.0.1:1/") })) as unknown as typeof fetch;
    const rt = await ensureLocalRuntime({ home, spawnImpl: () => { spawned++; return fakeChild(555); }, fetchImpl });
    expect(spawned).toBe(1);
    expect(rt.pid).toBe(555);
  });

  it("localRuntimeStatus returns null when nothing is recorded", async () => {
    const s = await localRuntimeStatus({ home, fetchImpl: (async () => ({ ok: true })) as unknown as typeof fetch });
    expect(s).toBeNull();
  });
});
