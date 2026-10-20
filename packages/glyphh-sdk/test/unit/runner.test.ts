/**
 * The runner — lifecycle, the capability gate, and guardrail enforcement.
 *
 * The gate is the point of the design: a program reaches only what its manifest
 * declared, so these assert denial as hard as they assert success.
 */

import { describe, it, expect, vi } from "vitest";
import { runProgram, CapabilityError, type RunnerHost } from "../../src/runtime/runner.js";
import type { Client } from "../../src/client.js";

/** A Client stub with just the surfaces the runner touches. */
function fakeClient(over: Record<string, unknown> = {}): Client {
  return {
    gateway: {
      complete: vi.fn(async () => ({
        id: "c1", object: "chat.completion", created: 0, model: "m",
        choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 7, total_tokens: 8 },
      })),
    },
    skills: { get: vi.fn() },
    models: { available: vi.fn(async () => [
      { id: "anthropic::claude-sonnet-5", name: "Sonnet", providerSlug: "anthropic", kind: "proxied",
        inputUsdPerMTok: 3, outputUsdPerMTok: 15, source: "proxy",
        contextWindow: 200000, maxOutputTokens: 64000 },
    ]) },
    connections: { runTool: vi.fn(async () => ({ result: { ret: "tool-ok" } })) },
    ...over,
  } as unknown as Client;
}

const caps = { roles: { planner: "anthropic::claude-sonnet-5" } };

describe("runner lifecycle", () => {
  it("runs init → start and returns start's value", async () => {
    const code = `
      export async function init(ctx) { ctx.state.ready = true; }
      export async function start(ctx) { return { ready: ctx.state.ready, got: ctx.input.n }; }
    `;
    const res = await runProgram(fakeClient(), {
      program: { slug: "p", code },
      capabilities: caps,
      input: { n: 42 },
    });
    expect(res.error).toBeUndefined();
    expect(res.output).toEqual({ ready: true, got: 42 });
  });

  it("treats ctx.exit as success, not failure", async () => {
    const code = `export async function start(ctx) { ctx.exit("early"); return "unreachable"; }`;
    const res = await runProgram(fakeClient(), { program: { slug: "p", code }, capabilities: caps });
    expect(res.error).toBeUndefined();
    expect(res.output).toBe("early");
  });

  it("always runs exit(), and its failure never masks the real error", async () => {
    const seen: string[] = [];
    const code = `
      export async function start(ctx) { throw new Error("boom"); }
      export async function exit(ctx, reason) { ctx.log("exit:" + reason); throw new Error("exit blew up"); }
    `;
    const res = await runProgram(fakeClient(), { program: { slug: "p", code }, capabilities: caps });
    expect(res.error).toBe("boom");
    expect(res.logs.some((l) => l === "exit:error")).toBe(true);
    expect(res.logs.some((l) => l.includes("exit() failed"))).toBe(true);
    expect(seen).toEqual([]);
  });

  it("reports a program with no start as an error rather than throwing", async () => {
    const res = await runProgram(fakeClient(), {
      program: { slug: "p", code: `export function other() {}` },
      capabilities: caps,
    });
    expect(res.error).toContain("no start(ctx) export");
  });

  it("reports a syntax error as a load failure", async () => {
    const res = await runProgram(fakeClient(), {
      program: { slug: "broken", code: `export async function start(ctx) { ${'{'} }` },
      capabilities: caps,
    });
    expect(res.error).toContain("failed to load");
  });

  it("accepts a bare default export as start", async () => {
    const code = `export default async function (ctx) { return "default-ok"; }`;
    const res = await runProgram(fakeClient(), { program: { slug: "p", code }, capabilities: caps });
    expect(res.output).toBe("default-ok");
  });
});

describe("runner capability gate", () => {
  it("denies an undeclared model role", async () => {
    const code = `export async function start(ctx) { return ctx.agent("nope", "hi"); }`;
    const res = await runProgram(fakeClient(), { program: { slug: "p", code }, capabilities: caps });
    expect(res.error).toContain('no model bound to role "nope"');
  });

  it("denies an undeclared connection, and allows a declared one", async () => {
    const client = fakeClient();
    const denied = await runProgram(client, {
      program: { slug: "p", code: `export async function start(ctx) { return ctx.tools.call("slack.post", {}); }` },
      capabilities: { ...caps, connections: ["gmail"] },
    });
    expect(denied.error).toContain('does not declare the "slack" connection');
    expect(client.connections.runTool).not.toHaveBeenCalled();

    const allowed = await runProgram(client, {
      program: { slug: "p", code: `export async function start(ctx) { return ctx.tools.call("gmail.send", { to: "y" }); }` },
      capabilities: { ...caps, connections: ["gmail"] },
    });
    expect(allowed.error).toBeUndefined();
    expect(allowed.output).toBe("tool-ok");
  });

  it("narrows within a connection when allowedTools is set", async () => {
    const res = await runProgram(fakeClient(), {
      program: { slug: "p", code: `export async function start(ctx) { return ctx.tools.call("gmail.delete", {}); }` },
      capabilities: { ...caps, connections: ["gmail"], allowedTools: ["gmail.send"] },
    });
    expect(res.error).toContain('does not allow the tool "gmail.delete"');
  });

  it("denies memory when undeclared, even though the host offers it", async () => {
    const host: RunnerHost = { memory: { read: vi.fn(async () => "x"), write: vi.fn(async () => {}) } };
    const res = await runProgram(
      fakeClient(),
      { program: { slug: "p", code: `export async function start(ctx) { return ctx.memory.read("q"); }` }, capabilities: caps },
      host,
    );
    expect(res.error).toContain("does not declare memory read access");
    expect(host.memory!.read).not.toHaveBeenCalled();
  });

  it("allows declared memory, and still denies write when only read was declared", async () => {
    const host: RunnerHost = { memory: { read: vi.fn(async () => "recalled"), write: vi.fn(async () => {}) } };
    const ok = await runProgram(
      fakeClient(),
      {
        program: { slug: "p", code: `export async function start(ctx) { return ctx.memory.read("q"); }` },
        capabilities: { ...caps, memory: { read: true } },
      },
      host,
    );
    expect(ok.output).toBe("recalled");

    const denied = await runProgram(
      fakeClient(),
      {
        program: { slug: "p", code: `export async function start(ctx) { return ctx.memory.write("f"); }` },
        capabilities: { ...caps, memory: { read: true } },
      },
      host,
    );
    expect(denied.error).toContain("does not declare memory write access");
  });

  it("denies ctx.ask when the host is unattended", async () => {
    const res = await runProgram(fakeClient(), {
      program: { slug: "p", code: `export async function start(ctx) { return ctx.ask("continue?"); }` },
      capabilities: caps,
    });
    expect(res.error).toContain("unattended");
  });

  it("keeps the sandbox free of require, process, and fetch", async () => {
    const code = `
      export async function start(ctx) {
        return {
          require: typeof require,
          process: typeof process,
          fetch: typeof fetch,
        };
      }
    `;
    const res = await runProgram(fakeClient(), { program: { slug: "p", code }, capabilities: caps });
    expect(res.output).toEqual({ require: "undefined", process: "undefined", fetch: "undefined" });
  });
});

describe("runner guardrails", () => {
  it("stops the run at the call ceiling instead of silently continuing", async () => {
    const client = fakeClient();
    const code = `
      export async function start(ctx) {
        for (let i = 0; i < 10; i++) await ctx.agent("planner", "go");
        return "finished";
      }
    `;
    const res = await runProgram(client, {
      program: { slug: "p", code },
      capabilities: caps,
      guardrails: { windowCalls: 3 },
    });
    expect(res.error).toContain("at most 3 model calls");
    expect(client.gateway.complete).toHaveBeenCalledTimes(3);
    expect(res.usage.calls).toBe(3);
  });

  it("clamps a program's maxTokens to the guardrail, never above it", async () => {
    const client = fakeClient();
    const code = `export async function start(ctx) { return ctx.agent("planner", "go", { maxTokens: 9000 }); }`;
    await runProgram(client, {
      program: { slug: "p", code },
      capabilities: caps,
      guardrails: { maxOutputTokens: 500 },
    });
    expect(client.gateway.complete).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 500 }));
  });

  it("honours a program asking for less than the guardrail allows", async () => {
    const client = fakeClient();
    const code = `export async function start(ctx) { return ctx.agent("planner", "go", { maxTokens: 100 }); }`;
    await runProgram(client, {
      program: { slug: "p", code },
      capabilities: caps,
      guardrails: { maxOutputTokens: 500 },
    });
    expect(client.gateway.complete).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 100 }));
  });

  it("tracks usage across the run", async () => {
    const code = `
      export async function start(ctx) {
        await ctx.agent("planner", "a");
        await ctx.agent("planner", "b");
        return "ok";
      }
    `;
    const res = await runProgram(fakeClient(), { program: { slug: "p", code }, capabilities: caps });
    expect(res.usage.calls).toBe(2);
    expect(res.usage.outputTokens).toBe(14); // 7 per stubbed completion
  });
});

describe("runner skills + progress", () => {
  it("runs a nested skill program and folds its usage in", async () => {
    const client = fakeClient({
      skills: {
        get: vi.fn(async () => ({
          slug: "research", code: `export async function start(ctx) { return ctx.agent("planner", ctx.input.q); }`,
          prompt: "", manifest: {},
        })),
      },
    });
    const code = `export async function start(ctx) { return ctx.skill("research", { q: "why" }); }`;
    const res = await runProgram(client, {
      program: { slug: "p", code },
      capabilities: { ...caps, skills: ["research"] },
    });
    expect(res.error).toBeUndefined();
    expect(res.output).toBe("hello");
    expect(res.usage.calls).toBe(1);
  });

  it("runs a prompt-only skill as a single agent turn", async () => {
    const client = fakeClient({
      skills: { get: vi.fn(async () => ({ slug: "summarize", code: "", prompt: "Summarize this", manifest: {} })) },
    });
    const code = `export async function start(ctx) { return ctx.skill("summarize", { text: "x" }); }`;
    const res = await runProgram(client, {
      program: { slug: "p", code },
      capabilities: { ...caps, skills: ["summarize"] },
    });
    expect(res.output).toBe("hello");
    expect(client.gateway.complete).toHaveBeenCalledTimes(1);
  });

  it("denies an undeclared skill without fetching it", async () => {
    const client = fakeClient({ skills: { get: vi.fn() } });
    const res = await runProgram(client, {
      program: { slug: "p", code: `export async function start(ctx) { return ctx.skill("secret", {}); }` },
      capabilities: { ...caps, skills: ["research"] },
    });
    expect(res.error).toContain('does not declare the "secret" skill');
    expect(client.skills.get).not.toHaveBeenCalled();
  });

  it("nests progress events under their step", async () => {
    const seen: string[] = [];
    const code = `
      export async function start(ctx) {
        await ctx.step("phase one", async () => { await ctx.agent("planner", "go"); });
        return "done";
      }
    `;
    const res = await runProgram(
      fakeClient(),
      { program: { slug: "p", code }, capabilities: caps },
      { onProgress: (e) => seen.push(`${e.type}:${e.status}`) },
    );
    expect(res.error).toBeUndefined();
    const step = res.events.find((e) => e.type === "step");
    const agent = res.events.find((e) => e.type === "agent");
    expect(step?.status).toBe("success");
    expect(agent?.parentId).toBe(step?.id);
    expect(seen).toContain("agent:success");
  });

  it("marks a failed step as an error event", async () => {
    const code = `
      export async function start(ctx) {
        await ctx.step("doomed", async () => { throw new Error("nope"); });
      }
    `;
    const res = await runProgram(fakeClient(), { program: { slug: "p", code }, capabilities: caps });
    expect(res.error).toBe("nope");
    const step = res.events.find((e) => e.type === "step");
    expect(step?.status).toBe("error");
    expect(step?.error).toBe("nope");
  });
});

describe("runner cancellation", () => {
  it("stops at the next ctx boundary when the signal aborts", async () => {
    const controller = new AbortController();
    const client = fakeClient({
      gateway: {
        complete: vi.fn(async () => {
          controller.abort();
          return {
            id: "c", object: "chat.completion", created: 0, model: "m",
            choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        }),
      },
    });
    const code = `
      export async function start(ctx) {
        await ctx.agent("planner", "first");
        await ctx.agent("planner", "second");
        return "should not finish";
      }
    `;
    const res = await runProgram(client, {
      program: { slug: "p", code },
      capabilities: caps,
      signal: controller.signal,
    });
    expect(res.error).toBe("cancelled");
    expect(client.gateway.complete).toHaveBeenCalledTimes(1);
  });
});

describe("CapabilityError", () => {
  it("is distinguishable from a program's own errors", () => {
    expect(new CapabilityError("x")).toBeInstanceOf(Error);
    expect(new CapabilityError("x").name).toBe("CapabilityError");
  });
});

describe("runner model budget", () => {
  it("tells a program what its role's model can hold", async () => {
    const code = `
      export async function start(ctx) {
        const m = await ctx.model("planner");
        // A loop uses this to decide its tool surface, not just its history.
        return { window: m.contextWindow, out: m.maxOutputTokens };
      }
    `;
    const res = await runProgram(fakeClient(), { program: { slug: "p", code }, capabilities: caps });
    expect(res.error).toBeUndefined();
    expect(res.output).toEqual({ window: 200000, out: 64000 });
  });

  it("answers null for an unbound role rather than guessing", async () => {
    const code = `export async function start(ctx) { return await ctx.model("nobody"); }`;
    const res = await runProgram(fakeClient(), { program: { slug: "p", code }, capabilities: caps });
    expect(res.output).toBeNull();
  });

  it("answers null when the catalog is unreachable, so the loop keeps its defaults", async () => {
    const client = fakeClient({ models: { available: vi.fn(async () => { throw new Error("offline"); }) } });
    const code = `export async function start(ctx) { return await ctx.model("planner"); }`;
    const res = await runProgram(client, { program: { slug: "p", code }, capabilities: caps });
    expect(res.error).toBeUndefined();
    expect(res.output).toBeNull();
  });
});
