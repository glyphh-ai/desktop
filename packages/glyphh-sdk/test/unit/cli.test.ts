/**
 * CLI plumbing — registry matching, arg parsing, dispatch, help. Deterministic; no
 * network (commands are driven through a fake context).
 */

import { describe, it, expect, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.js";
import { CommandRegistry } from "../../src/cli/registry.js";
import { dispatch, helpText } from "../../src/cli/dispatch.js";
import type { CliContext } from "../../src/cli/context.js";

function fakeCtx(): CliContext & { out: string[] } {
  const out: string[] = [];
  return {
    out,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: {} as any,
    config: { server: "http://x" },
    print: (m: string) => out.push(m),
    printJson: (v: unknown) => out.push(JSON.stringify(v)),
  };
}

describe("parseArgs", () => {
  it("splits positionals and flags (--k v, --k=v, boolean)", () => {
    expect(parseArgs(["a", "--k", "v", "--x=y", "--f"])).toEqual({
      positional: ["a"],
      flags: { k: "v", x: "y", f: true },
    });
  });
});

describe("registry.match", () => {
  it("prefers the longest command path", () => {
    const reg = new CommandRegistry();
    const run = async () => {};
    reg.register({ path: "auth", summary: "", run });
    reg.register({ path: "auth login", summary: "", run });
    expect(reg.match(["auth", "login", "x"])?.command.path).toBe("auth login");
    expect(reg.match(["auth", "x"])?.command.path).toBe("auth");
  });
  it("rejects duplicate registration", () => {
    const reg = new CommandRegistry();
    reg.register({ path: "x", summary: "", run: async () => {} });
    expect(() => reg.register({ path: "x", summary: "", run: async () => {} })).toThrow(/duplicate/);
  });
});

describe("dispatch", () => {
  it("runs the matched command with parsed args", async () => {
    const reg = new CommandRegistry();
    const run = vi.fn(async (ctx: CliContext, args) => ctx.print(`hi ${args.positional[0]}`));
    reg.register({ path: "greet", summary: "", run });
    const ctx = fakeCtx();
    expect(await dispatch(reg, ctx, ["greet", "bob"])).toBe(0);
    expect(ctx.out).toContain("hi bob");
  });

  it("renders a thrown error and returns exit code 1", async () => {
    const reg = new CommandRegistry();
    reg.register({ path: "boom", summary: "", run: async () => { throw new Error("kaboom"); } });
    const ctx = fakeCtx();
    expect(await dispatch(reg, ctx, ["boom"])).toBe(1);
    expect(ctx.out.some((l) => l.includes("kaboom"))).toBe(true);
  });

  it("prints help for no args / unknown command", async () => {
    const reg = new CommandRegistry();
    reg.register({ path: "known", summary: "does a thing", run: async () => {} });
    const ctx = fakeCtx();
    expect(await dispatch(reg, ctx, [])).toBe(0);
    expect(ctx.out.join("\n")).toContain("does a thing");
    expect(await dispatch(reg, ctx, ["nope"])).toBe(1);
  });
});

describe("helpText", () => {
  it("lists every command", () => {
    const reg = new CommandRegistry();
    reg.register({ path: "a", summary: "alpha", run: async () => {} });
    reg.register({ path: "b", summary: "bravo", run: async () => {} });
    const text = helpText(reg);
    expect(text).toContain("alpha");
    expect(text).toContain("bravo");
  });
});
