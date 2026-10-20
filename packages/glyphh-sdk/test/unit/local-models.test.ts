/**
 * local-models.test.ts — hardware→model sizing, and the per-model llama-server singleton
 * (download once, serve once, attach thereafter) via injected download/spawn/fetch.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recommendModel, findLocalModel, ensureLocalModel } from "../../src/models/index.js";
import type { Hardware } from "../../src/models/index.js";

const hw = (totalRamGB: number, appleSilicon = false): Hardware => ({
  platform: "darwin", arch: "arm64", cpuCount: 8, totalRamGB, appleSilicon,
});

describe("local model sizing", () => {
  it("scales the model to available RAM", () => {
    expect(recommendModel(hw(8)).id).toBe("qwen2.5-3b"); // 8 − 2 = 6 usable → 3b (min 6)
    expect(recommendModel(hw(16)).id).toBe("qwen2.5-7b"); // 14 usable → 7b (min 10)
    expect(recommendModel(hw(64)).id).toBe("qwen2.5-14b");
    expect(recommendModel(hw(4)).id).toBe("qwen2.5-1.5b"); // weak box floor
  });
  it("findLocalModel resolves known ids and rejects unknown", () => {
    expect(findLocalModel("qwen2.5-7b")?.paramsB).toBe(7);
    expect(findLocalModel("nope")).toBeUndefined();
  });
});

describe("ensureLocalModel (singleton)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "glyphh-models-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const fakeChild = (pid: number) => ({ pid, unref() {} }) as unknown as ReturnType<typeof import("node:child_process").spawn>;

  it("downloads once, serves once, then attaches", async () => {
    let downloads = 0, spawns = 0;
    const common = {
      home,
      download: async (_spec: unknown, dest: string) => { downloads++; writeFileSync(dest, "gguf"); },
      spawnImpl: (() => { spawns++; return fakeChild(7001); }) as never,
      fetchImpl: (async () => ({ ok: true })) as unknown as typeof fetch,
    };
    const a = await ensureLocalModel("qwen2.5-7b", common);
    expect(a.model).toBe("qwen2.5-7b");
    expect(a.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(a.pid).toBe(7001);
    expect(downloads).toBe(1);
    expect(spawns).toBe(1);
    // Second call attaches — no re-download, no re-spawn.
    const b = await ensureLocalModel("qwen2.5-7b", common);
    expect(b.pid).toBe(7001);
    expect(downloads).toBe(1);
    expect(spawns).toBe(1);
  });

  it("rejects an unknown model", async () => {
    await expect(ensureLocalModel("bogus", { home })).rejects.toThrow(/unknown local model/);
  });
});
