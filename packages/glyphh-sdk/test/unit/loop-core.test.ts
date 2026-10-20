import { describe, it, expect } from "vitest";
import { gate, toolKind, readsByName, seedFromChat, shouldCompact, safeToolName, toolTitle, preview, systemPrompt } from "../../src/loop/core.js";

describe("the permission gate", () => {
  it("classifies the built-ins and treats anything else as a connected tool", () => {
    expect(toolKind("read_file")).toBe("read");
    expect(toolKind("edit_file")).toBe("edit");
    expect(toolKind("bash")).toBe("exec");
    expect(toolKind("glyphh_facts_search")).toBe("mcp");
  });
  it("projects the four words onto the tool kinds", () => {
    expect(gate("plan", "read")).toBe("allow");
    expect(gate("plan", "edit")).toBe("deny");
    expect(gate("plan", "exec")).toBe("deny");
    expect(gate("ask", "read")).toBe("allow");
    expect(gate("ask", "edit")).toBe("ask");
    expect(gate("ask", "mcp")).toBe("ask");
    expect(gate("acceptEdits", "edit")).toBe("allow");
    expect(gate("acceptEdits", "exec")).toBe("ask");
    expect(gate("auto", "exec")).toBe("allow");
  });
});

describe("the seed from a chat's stored turns", () => {
  it("keeps user/assistant text, merges neighbours, and leaves the current prompt off", () => {
    expect(seedFromChat([
      { role: "system", text: "x" }, { role: "user", text: "a" }, { role: "user", text: "b" }, { role: "assistant", text: "c" },
      { role: "assistant", text: "" }, { role: "user", text: "now" },
    ], "now")).toEqual([{ role: "user", content: "a\n\nb" }, { role: "assistant", content: "c" }]);
  });
  it("never opens on an assistant turn or ends on a user turn", () => {
    expect(seedFromChat([{ role: "assistant", text: "hi" }, { role: "user", text: "q" }], "other")).toEqual([]);
    expect(seedFromChat([], "x")).toEqual([]);
  });
});

describe("small helpers", () => {
  it("compacts at the threshold, names tools safely, titles a tool by its argument", () => {
    expect(shouldCompact(119_999)).toBe(false);
    expect(shouldCompact(120_000)).toBe(true);
    expect(safeToolName("pd_acme_google drive/list.files")).toBe("pd_acme_google_drive_list_files");
    expect(safeToolName("")).toBe("tool");
    expect(toolTitle("bash", { command: "npm test" })).toBe("bash npm test");
    expect(toolTitle("read_file", { path: "/a/b.ts" })).toBe("read_file /a/b.ts");
    expect(toolTitle("weird", { x: 1 })).toBe("weird");
    expect(preview("a   b\n\nc d", 5)).toBe("a b …");
    expect(preview("a   b\n\nc", 5)).toBe("a b c");
    expect(systemPrompt("/w", { hasLocalMcp: true, hasGateway: false })).toContain("Working folder: /w");
    expect(systemPrompt("/w", { hasLocalMcp: false, hasGateway: false })).not.toContain("glyphh_*");
    expect(systemPrompt("/w", { hasLocalMcp: true, hasGateway: false })).toContain("never ask whether Glyphh is running");
    expect(systemPrompt("/w", { hasLocalMcp: false, hasGateway: false })).toContain("Something happened only when a tool result says it did");
  });
});

describe("lent tools that only read", () => {
  it("reads by name: listings, searches, status — never calls, opens, sends", () => {
    for (const n of ["panels_list", "panels_available", "glyphh_connections", "mcp_tool_search", "glyphh_facts_search", "get_thread", "list_files", "health"]) expect(readsByName(n)).toBe(true);
    for (const n of ["mcp_tool_call", "panels_open", "rpa_goto", "send_email", "glyphh_facts_write", "create_task", "run_bash"]) expect(readsByName(n)).toBe(false);
  });
  it("a read-only lent tool is a READ kind, so no mode ever asks for it", () => {
    expect(toolKind("panels_list", true)).toBe("read");
    expect(toolKind("panels_open", false)).toBe("mcp");
    expect(gate("default" as never, "read")).toBe("allow");
    expect(gate("plan", "read")).toBe("allow");
  });
});
