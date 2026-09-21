import { describe, it, expect } from "vitest";
import { decide, parseRows } from "../../../src/main/bridge/routing.js";

describe("routing", () => {
  const rows = parseRows([
    { model: "claude-opus-5", lane: "account", permission: "edits" },
    { model: "claude-*", lane: "account" },
    { model: "gpt-oss-120b", lane: "gateway", target: "together/gpt-oss-120b" },
    { model: "*", lane: "gateway" },
    { model: "", lane: "gateway" },
    { model: "x", lane: "sideways" },
    { model: "y", lane: "account", permission: "root", chatOnly: "yes" },
  ]);

  it("drops malformed rows and keeps the rest in order", () => {
    expect(rows.map((r) => r.model)).toEqual(["claude-opus-5", "claude-*", "gpt-oss-120b", "*", "y"]);
    expect(rows[4]).toEqual({ model: "y", lane: "account" });
  });

  it("first match wins, a trailing star is a prefix, star alone is the default", () => {
    expect(decide(rows, "claude-opus-5")).toEqual({ lane: "account", model: "claude-opus-5", permission: "edits", chatOnly: false });
    expect(decide(rows, "claude-sonnet-5")).toEqual({ lane: "account", model: "claude-sonnet-5", permission: "read-only", chatOnly: false });
    expect(decide(rows, "gpt-oss-120b")).toEqual({ lane: "gateway", model: "together/gpt-oss-120b", permission: "read-only", chatOnly: false });
    expect(decide(rows, "mistral-large")).toMatchObject({ lane: "gateway", model: "mistral-large" });
  });

  it("with no table at all every name rides the gateway as asked", () => {
    expect(decide([], "claude-opus-5")).toEqual({ lane: "gateway", model: "claude-opus-5", permission: "read-only", chatOnly: false });
    expect(parseRows(null)).toEqual([]);
  });
});
