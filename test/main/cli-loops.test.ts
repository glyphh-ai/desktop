/**
 * cli-loops.test.ts — the loop choices the renderer makes (help/cli-loops.ts):
 * the default and start loop, the face an agent opens with, the route chip
 * and why it greys, each CLI's own model list and where a pick is kept, the
 * modes a loop can honor, and the hop back from the terminal to the chat.
 */
import { describe, expect, it } from "vitest";
import {
  CLI_DEFAULT_MODEL_LABEL, CLI_MODELS, LOOP_IDS, cliModelChoices, coerceMode, defaultLoopOf, defaultViewOf, gatewayBlockedWhy,
  gatewayHintOf, hopBack, isLoopId, isVendorLoop, modelLaneOf, modelSlotOf, modesOf, resolveAgentView, resolveRoute,
  resolveStartLoop, scopedHopSessions, settle, storedView, toStoredGateway, toStoredView,
} from "../../src/renderer/help/cli-loops";

const claude = { cli: "claude", name: "Claude", gatewayCapable: true };
const codex = { cli: "codex", name: "Codex", gatewayCapable: false };
const glyphh = { cli: "glyphh", name: "Glyphh", gatewayCapable: false };

describe("the loops", () => {
  it("Glyphh leads, and every vendor CLI is listed once", () => {
    expect(LOOP_IDS[0]).toBe("glyphh");
    expect([...LOOP_IDS].sort()).toEqual(["claude", "codex", "copilot", "cursor", "gemini", "glyphh"]);
    expect(isLoopId("codex")).toBe(true);
    expect(isLoopId("default")).toBe(false);
    expect(isVendorLoop("glyphh")).toBe(false);
    expect(isVendorLoop("cursor")).toBe(true);
  });

  it("the default loop is the member's pick only while that loop is on", () => {
    expect(defaultLoopOf("codex", ["glyphh", "codex"])).toBe("codex");
    expect(defaultLoopOf("codex", ["glyphh"])).toBe("glyphh");
    expect(defaultLoopOf("", ["glyphh", "codex"])).toBe("glyphh");
    expect(defaultLoopOf(42, ["glyphh"])).toBe("glyphh");
  });

  it("a workspace starts on the cell's loop, then the workspace's, then the default — skipping loops that are off", () => {
    const on = ["glyphh", "claude", "gemini"];
    expect(resolveStartLoop("gemini", "claude", "glyphh", on)).toBe("gemini");
    expect(resolveStartLoop("", "claude", "glyphh", on)).toBe("claude");
    expect(resolveStartLoop("codex", null, "claude", on)).toBe("claude");
    expect(resolveStartLoop(undefined, "codex", "codex", on)).toBe("glyphh");
  });
});

describe("the face an agent opens with", () => {
  it("reads the stored workspace words and writes them back", () => {
    expect(storedView("glyphh")).toBe("chat");
    expect(storedView("cli")).toBe("terminal");
    expect(storedView("chat")).toBeNull();
    expect(toStoredView("chat")).toBe("glyphh");
    expect(toStoredView("terminal")).toBe("cli");
    expect(defaultViewOf("terminal")).toBe("terminal");
    expect(defaultViewOf("whatever")).toBe("last");
  });

  it("the cell wins, then the workspace, then the member's default", () => {
    expect(resolveAgentView("cli", "glyphh", "chat", "chat")).toBe("terminal");
    expect(resolveAgentView(undefined, "glyphh", "terminal", "terminal")).toBe("chat");
    expect(resolveAgentView(undefined, null, "terminal", "chat")).toBe("terminal");
  });

  it("only \"last\" reads the face last used, and nothing at all is the chat", () => {
    expect(resolveAgentView(undefined, undefined, "last", "terminal")).toBe("terminal");
    expect(resolveAgentView(undefined, undefined, "last", "chat")).toBe("chat");
    expect(resolveAgentView(undefined, undefined, undefined, undefined)).toBe("chat");
  });
});

describe("the route", () => {
  it("reads and writes a workspace's on/off", () => {
    expect(gatewayHintOf("on")).toBe(true);
    expect(gatewayHintOf("off")).toBe(false);
    expect(gatewayHintOf("inherit")).toBeNull();
    expect(toStoredGateway(true)).toBe("on");
    expect(toStoredGateway(false)).toBe("off");
    expect(toStoredGateway(null)).toBeNull();
  });

  it("the session's pick wins, then the cell, then the workspace, then the member's default", () => {
    expect(resolveRoute(claude, { session: false, cell: true, layout: true }, true, true)).toBe("direct");
    expect(resolveRoute(claude, { session: null, cell: true, layout: false }, false, true)).toBe("gateway");
    expect(resolveRoute(claude, { layout: true }, false, true)).toBe("gateway");
    expect(resolveRoute(claude, {}, true, true)).toBe("gateway");
    expect(resolveRoute(claude, undefined, false, true)).toBe("direct");
  });

  it("the gateway only on a loop the router can carry, with a chat model to call", () => {
    expect(resolveRoute(codex, { session: true }, true, true)).toBe("direct");
    expect(resolveRoute(glyphh, { session: true }, true, true)).toBe("direct");
    expect(resolveRoute(claude, { session: true }, true, false)).toBe("direct");
    expect(resolveRoute(undefined, { session: true }, true, true)).toBe("direct");
  });

  it("says why the gateway is greyed, and nothing when it is not", () => {
    expect(gatewayBlockedWhy(codex, true)).toMatch(/Codex only talks to its own service/);
    expect(gatewayBlockedWhy(claude, false)).toBe("Add a chat model in Settings › Models");
    expect(gatewayBlockedWhy(glyphh, true)).toMatch(/your own providers/);
    expect(gatewayBlockedWhy(claude, true)).toBeNull();
  });
});

describe("the model picker", () => {
  it("every CLI lists its own default first, then its own names", () => {
    for (const cli of ["claude", "codex", "gemini", "cursor", "copilot"] as const) {
      const list = cliModelChoices(cli);
      expect(list[0]).toEqual({ id: "", name: CLI_DEFAULT_MODEL_LABEL });
      expect(list.slice(1)).toEqual([...CLI_MODELS[cli]]);
      expect(new Set(list.map((m) => m.id)).size).toBe(list.length);
    }
    expect(cliModelChoices("claude").map((m) => m.id)).toEqual(["", "opus", "sonnet", "haiku"]);
    expect(cliModelChoices("glyphh")).toEqual([{ id: "", name: CLI_DEFAULT_MODEL_LABEL }]);
  });

  it("speaks the CLI's words only for a CLI on its own login", () => {
    expect(modelLaneOf("claude", "direct")).toBe("cli");
    expect(modelLaneOf("claude", "gateway")).toBe("router");
    expect(modelLaneOf("glyphh", "direct")).toBe("router");
    expect(modelLaneOf("codex", "direct")).toBe("cli");
  });

  it("keeps each lane's pick in its own slot, so a route flip never crosses them", () => {
    expect(modelSlotOf("router", "claude")).toBe("default");
    expect(modelSlotOf("router", "glyphh")).toBe("default");
    expect(modelSlotOf("cli", "claude")).toBe("direct:claude");
    expect(modelSlotOf("cli", "codex")).toBe("direct:codex");
  });
});

describe("the modes a loop can honor", () => {
  it("is the row's own list, or every mode before the roster loads", () => {
    expect(modesOf({ modes: ["plan", "acceptEdits", "auto"] })).toEqual(["plan", "acceptEdits", "auto"]);
    expect(modesOf({ modes: ["ask", "bogus"] })).toEqual(["ask"]);
    expect(modesOf(undefined)).toEqual(["ask", "plan", "acceptEdits", "auto"]);
  });

  it("moves a mode the loop cannot honor to ask, else the loop's first", () => {
    expect(coerceMode("plan", ["ask", "plan"])).toBe("plan");
    expect(coerceMode("acceptEdits", ["ask", "plan"])).toBe("ask");
    expect(coerceMode("ask", ["plan", "auto"])).toBe("plan");
  });
});

describe("the hop back from the terminal", () => {
  const rows = [
    { id: "old", cwd: "/w/app", mtime: 100, cli: "claude" },
    { id: "elsewhere", cwd: "/other", mtime: 900, cli: "claude" },
    { id: "new", cwd: "/w/app/", mtime: 500, cli: "claude" },
    { id: "codex1", cwd: "/w/app", mtime: 999, cli: "codex" },
  ];

  it("scopes to the loop's own CLI, the terminal's folder first, newest first", () => {
    expect(scopedHopSessions(rows, "claude", ["/w/app"]).map((r) => r.id)).toEqual(["new", "old"]);
    expect(scopedHopSessions(rows, "claude", [undefined, "/other"]).map((r) => r.id)).toEqual(["elsewhere"]);
    expect(scopedHopSessions(rows, "claude", ["/nowhere"]).map((r) => r.id)).toEqual(["elsewhere", "new", "old"]);
    expect(scopedHopSessions(rows, "codex", []).map((r) => r.id)).toEqual(["codex1"]);
  });

  it("returns to the chat it left, adopting the terminal's session only when it was typed in since", () => {
    const has = (id: string): boolean => id === "c1";
    expect(hopBack({ id: "s", cwd: "", mtime: 5_000 }, { chatId: "c1", at: 4_000 }, has)).toEqual({ kind: "adopt", sessionId: "s", chatId: "c1" });
    expect(hopBack({ id: "s", cwd: "", mtime: 1_000 }, { chatId: "c1", at: 4_000 }, has)).toEqual({ kind: "open", chatId: "c1" });
    expect(hopBack(undefined, { chatId: "c1", at: 4_000 }, has)).toEqual({ kind: "open", chatId: "c1" });
  });

  it("a hop from a new chat comes back new, unless the terminal made a session", () => {
    const none = (): boolean => false;
    expect(hopBack({ id: "s", cwd: "", mtime: 5_000 }, { chatId: "", at: 4_000 }, none)).toEqual({ kind: "adopt", sessionId: "s" });
    expect(hopBack({ id: "s", cwd: "", mtime: 1_000 }, { chatId: "", at: 4_000 }, none)).toEqual({ kind: "new" });
    expect(hopBack({ id: "s", cwd: "", mtime: 1_000 }, { chatId: "gone", at: 4_000 }, none)).toEqual({ kind: "new" });
  });

  it("with no hop, the newest session in scope is adopted, else a new chat", () => {
    expect(hopBack({ id: "s", cwd: "", mtime: 1 }, null, () => true)).toEqual({ kind: "adopt", sessionId: "s" });
    expect(hopBack(undefined, null, () => true)).toEqual({ kind: "new" });
  });
});

describe("a bridge door that may not be there", () => {
  it("settles a promise, a bare value, nothing or a rejection to the answer or the fallback", async () => {
    expect(await settle(Promise.resolve(3), 0)).toBe(3);
    expect(await settle(5, 0)).toBe(5);
    expect(await settle(undefined, "none")).toBe("none");
    expect(await settle(Promise.resolve(null), "none")).toBe("none");
    expect(await settle(Promise.reject(new Error("x")), "none")).toBe("none");
  });
});
