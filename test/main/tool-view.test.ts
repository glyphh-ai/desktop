import { describe, it, expect } from "vitest";
import { summaryOf, trimForStore, type ToolRec } from "../../src/renderer/help/tool-view";

const text = (html: string): string => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const rec = (over: Partial<ToolRec>): ToolRec => ({ name: "bash", title: "bash ls", state: "done", startedAt: 0, endedAt: 10, ...over });
const diff = (path: string, created: boolean, added: number, removed: number): ToolRec["detail"] =>
  ({ kind: "diff", path, created, added, removed, truncated: false, hunks: [] });

describe("the group's one line (his order, 2026-09-29)", () => {
  it("counts by kind, names the ONE file it made, and totals the change", () => {
    const recs = [
      rec({ name: "bash" }), rec({ name: "bash" }),
      rec({ name: "write_file", detail: diff("/p/agent-tools.ts", true, 92, 0) }),
      rec({ name: "read_file", detail: { kind: "read", path: "/p/a.ts", lines: 10 } }),
    ];
    expect(text(summaryOf(recs, false).html)).toBe("Ran 2 commands, created agent-tools.ts, read 1 file +92−0");
  });

  it("several files are counted, and a file made then edited in the same turn is one made file", () => {
    const recs = [
      rec({ name: "write_file", detail: diff("/p/a.ts", true, 5, 0) }),
      rec({ name: "edit_file", detail: diff("/p/a.ts", false, 2, 1) }),
      rec({ name: "edit_file", detail: diff("/p/b.ts", false, 3, 3) }),
      rec({ name: "edit_file", detail: diff("/p/c.ts", false, 1, 0) }),
    ];
    expect(text(summaryOf(recs, false).html)).toBe("Created a.ts, edited 2 files +11−4");
  });

  it("says how many failed, and a live group says what it is doing now", () => {
    const failed = summaryOf([rec({ state: "failed" }), rec({})], false);
    expect(failed.failed).toBe(1);
    expect(text(failed.html)).toContain("· 1 failed");
    const live = summaryOf([rec({}), rec({ title: "bash npm test", state: "running" })], true);
    expect(text(live.html)).toBe("Running npm test2 steps");
  });

  it("everything else reads as what it was", () => {
    const recs = [rec({ name: "spawn_agent", title: "researcher · find" }), rec({ name: "mcp_tool_call", title: "mcp_tool_call gmail" }), rec({ name: "grep", detail: { kind: "search", pattern: "x", path: "/p", matches: 3 } })];
    expect(text(summaryOf(recs, false).html)).toBe("Searched 1 time, asked 1 agent, called 1 tool");
  });

  it("a file name cannot inject markup into the line", () => {
    const html = summaryOf([rec({ name: "write_file", detail: diff("/p/<img src=x onerror=alert(1)>.ts", true, 1, 0) })], false).html;
    expect(html).not.toContain("<img");
  });
});

describe("what a step keeps on disk", () => {
  it("a long diff and a long output are bounded, and say they were", () => {
    const lines = Array.from({ length: 500 }, (_, i) => ({ t: "+" as const, s: `l${i}` }));
    const big = trimForStore(rec({ name: "write_file", detail: { kind: "diff", path: "/p/x", created: true, added: 500, removed: 0, truncated: false, hunks: [{ oldStart: 1, newStart: 1, lines }] } }));
    const d = big.detail as Extract<ToolRec["detail"], { kind: "diff" }>;
    expect(d.hunks[0]!.lines).toHaveLength(240);
    expect(d.truncated).toBe(true);
    expect(d.added).toBe(500);   // the counts stay exact
    const cmd = trimForStore(rec({ detail: { kind: "command", command: "x", exitCode: 0, ms: 1, truncated: false, stdout: "y".repeat(10_000), stderr: "" } }));
    const c = cmd.detail as Extract<ToolRec["detail"], { kind: "command" }>;
    expect(c.stdout.length).toBeLessThan(6100);
    expect(c.truncated).toBe(true);
  });

  it("a small step is kept whole", () => {
    const r = rec({ input: "{}", output: "ok", detail: { kind: "command", command: "ls", exitCode: 0, ms: 3, truncated: false, stdout: "a\nb", stderr: "" } });
    expect(trimForStore(r)).toEqual(r);
  });
});
