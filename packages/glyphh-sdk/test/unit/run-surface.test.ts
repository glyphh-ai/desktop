/**
 * run-surface.test.ts — THE RUN CARRIES ITS SURFACE (his report, 2026-10-06:
 * a web member's agent opened panels on their DESKTOP). client.run's cloud
 * branch forwards `surface` verbatim in the /api/harness/run body, leaves it
 * out when the caller named none, and the CLI's `harness run` stamps "cli".
 */
import { describe, it, expect } from "vitest";
import { createClient, isHarnessWireFrame, isHarnessTerminal } from "../../src/index.js";
import type { HarnessFrame, HarnessRunBody, HarnessSurface } from "../../src/index.js";

function frontDoor() {
  const bodies: HarnessRunBody[] = [];
  const ac = new AbortController();
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/api/harness/run")) {
      bodies.push(JSON.parse(String(init?.body)) as HarnessRunBody);
      ac.abort();
      return new Response(JSON.stringify({ runId: "r1", sessionId: "s1", wire: "glyphh.harness/v1" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ frames: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = createClient({ url: "https://cp.test", apiKey: "sk-test", fetch: fetchImpl as unknown as typeof fetch });
  return { bodies, ac, client };
}

describe("client.run({ target: 'cloud' }) — the surface rides the run body", () => {
  it.each<HarnessSurface>(["web", "desktop", "cli"])("forwards surface %s verbatim", async (surface) => {
    const a = frontDoor();
    await a.client.run({ target: "cloud", prompt: "hi", threadId: "t1", surface, signal: a.ac.signal }).done.catch(() => undefined);
    expect(a.bodies).toHaveLength(1);
    expect(a.bodies[0]!.surface).toBe(surface);
  });

  it("leaves the field out when the caller named no surface (the pod then treats the run as desktop/CLI)", async () => {
    const a = frontDoor();
    await a.client.run({ target: "cloud", prompt: "hi", threadId: "t1", signal: a.ac.signal }).done.catch(() => undefined);
    expect(a.bodies[0]).not.toHaveProperty("surface");
  });
});

describe("the frame contract", () => {
  it("admits the open-app frame a web run's window tools answer with: an app slug, layout:<name> or settings:<page>, never terminal", () => {
    const frames: HarnessFrame[] = [
      { type: "open-app", ref: "crm" },
      { type: "open-app", ref: "layout:Research" },
      { type: "open-app", ref: "settings:skills" },
      { type: "open-app", url: "https://glyphh.ai" },
    ];
    for (const f of frames) {
      expect(isHarnessTerminal(f)).toBe(false);
      expect(isHarnessWireFrame({ ...f, seq: 1, runId: "r", at: 0 })).toBe(true);
    }
  });
});
