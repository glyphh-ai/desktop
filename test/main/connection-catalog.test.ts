/**
 * connection-catalog.test.ts — the connections' tools as the Glyphh loop
 * sees them (main/connection-catalog.ts): Always allow runs without asking,
 * Needs approval asks in every mode, an unattended run carries only Always
 * allow; and the loop lends connections at all only once one exists
 * (org-models.ts connectionsAvailable).
 */

import { describe, expect, it, vi } from "vitest";
import type { ConnTool } from "../../src/main/mcp-connections.js";

let has = false;
vi.mock("../../src/main/mcp-connections.js", () => ({ hasConnections: () => has }));
vi.mock("../../src/main/providers.js", () => ({ defaultModel: () => "anthropic::m", hasChatModel: () => true }));

const { connectionCatalogEntries } = await import("../../src/main/connection-catalog.js");
const { connectionsAvailable, orgModelState } = await import("../../src/main/org-models.js");

const tool = (name: string, mode: ConnTool["mode"], over: Partial<ConnTool> = {}): ConnTool => ({
  connection: "pd:gmail", label: "Gmail", name, description: `${name} does a thing`, inputSchema: { type: "object", properties: {} }, mode, ...over,
});

describe("connection tools in the loop's catalog", () => {
  const tools = [tool("gmail-list-labels", "allow"), tool("gmail-send-email", "ask")];

  it("Always allow is readOnly (no approval); Needs approval asks; the family is the connection's name", () => {
    const entries = connectionCatalogEntries(tools, async () => null, false);
    expect(entries.map((e) => [e.name, e.family, e.readOnly ?? false, e.ask ?? false])).toEqual([
      ["pd_gmail_gmail-list-labels", "connection: Gmail", true, false],
      ["pd_gmail_gmail-send-email", "connection: Gmail", false, true],
    ]);
    expect(entries[0]!.inputSchema).toEqual({ type: "object", properties: {} });
  });

  it("an unattended run carries only Always allow tools", () => {
    expect(connectionCatalogEntries(tools, async () => null, true).map((e) => e.name)).toEqual(["pd_gmail_gmail-list-labels"]);
  });

  it("runs call the connection by its id and real tool name; isError and throws read as failures", async () => {
    const call = vi.fn(async (_c: string, t: string) => (t === "gmail-send-email" ? { isError: true, content: [] } : { content: [{ type: "text", text: "ok" }] }));
    const [list, send] = connectionCatalogEntries(tools, call, false);
    expect(await list!.run({})).toEqual({ text: JSON.stringify({ content: [{ type: "text", text: "ok" }] }), failed: false });
    expect((await send!.run({ to: "a" })).failed).toBe(true);
    expect(call).toHaveBeenCalledWith("pd:gmail", "gmail-send-email", { to: "a" });
    const boom = connectionCatalogEntries([tool("x", "allow")], async () => { throw new Error("down"); }, false);
    expect(await boom[0]!.run({})).toEqual({ text: "down", failed: true });
  });

  it("falls back to the tool name for a missing description and the id for a missing label", () => {
    const [e] = connectionCatalogEntries([tool("crm-find", "allow", { connection: "crm", label: "", description: "", inputSchema: undefined })], async () => null, false);
    expect(e!.description).toBe("crm-find");
    expect(e!.family).toBe("connection: crm");
    expect(e!.inputSchema).toBeUndefined();
  });
});

describe("the connections lane", () => {
  it("is on once any connection exists, and the model state says so", () => {
    has = false;
    expect(connectionsAvailable()).toBe(false);
    expect(orgModelState().connectionsOn).toBe(false);
    has = true;
    expect(connectionsAvailable()).toBe(true);
    expect(orgModelState().connectionsOn).toBe(true);
  });
});
