/**
 * local.test.ts — the terminal on the desktop's own data. The key and the
 * chat store are the desktop's files under ~/.glyphh/users/local; a chat the
 * desktop wrote opens here and a turn written here keeps every chat (and
 * every field) the desktop had; the model a turn runs on is always one the
 * catalog knows; the only lent server is the desktop's own; and --help /
 * --version print instead of opening the screen.
 */

import "./helpers/home.js";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chatStoreFile, hasProviderKey, GLYPHH_HOME, NO_KEY_LINES } from "../src/local.js";
import { getActiveUserId } from "../../src/main/app-paths.js";
import { defaultModelId, isKnownModel, resolveModel } from "../src/models.js";
import { writeProviders } from "./helpers/home.js";
import { mcpServersFrom } from "../src/loop.js";
import { HELP, USAGE, parseFlags } from "../src/flags.js";
import { agoLabel, conversationOf, desktopPermission, findChat, listGlyphhChats, loadStore, newChat, saveChat, titleOf, touchedAt, type StoredChat } from "../src/sessions.js";

const ENV_KEYS = ["ANTHROPIC_API_KEY", "GLYPHH_APP_SESSIONS"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("local.ts — the desktop's local user", () => {
  it("scopes to the one local user at import, so every path is under ~/.glyphh/users/local", () => {
    expect(getActiveUserId()).toBe("local");
    expect(GLYPHH_HOME).toBe(join(homedir(), ".glyphh"));
    delete process.env.GLYPHH_APP_SESSIONS;
    expect(chatStoreFile()).toBe(join(homedir(), ".glyphh", "users", "local", "agent-sessions.json"));
    process.env.GLYPHH_APP_SESSIONS = "/tmp/desk/agent-sessions.json";
    expect(chatStoreFile()).toBe("/tmp/desk/agent-sessions.json");
  });

  it("a provider with a key counts, saved or from the environment; the no-provider lines say where to add one", () => {
    writeProviders(null);
    expect(hasProviderKey()).toBe(false);
    process.env.ANTHROPIC_API_KEY = "sk-ant-env";
    expect(hasProviderKey()).toBe(true);
    delete process.env.ANTHROPIC_API_KEY;
    writeProviders();
    expect(hasProviderKey()).toBe(true);
    expect(NO_KEY_LINES.join("\n")).toContain("Settings › Models");
    expect(NO_KEY_LINES.join("\n")).toContain("ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY");
    expect(NO_KEY_LINES.join("\n")).toContain("~/.glyphh/users/local/providers.json");
  });
});

describe("models.ts — a turn's model is always one the user set up", () => {
  it("the first known pick wins; unknown or empty picks fall through to the default", () => {
    expect(resolveModel("anthropic::claude-haiku-5-5", "anthropic::claude-sonnet-5-5")).toBe("anthropic::claude-haiku-5-5");
    expect(resolveModel(null, "anthropic::claude-sonnet-5-5")).toBe("anthropic::claude-sonnet-5-5");
    expect(resolveModel("gpt-5.6", undefined)).toBe(defaultModelId());
    expect(resolveModel()).toBe("anthropic::claude-opus-5-5");
    expect(isKnownModel("anthropic::claude-fable-5-1")).toBe(true);
    expect(isKnownModel("claude-fable-5-1")).toBe(false);
    expect(isKnownModel("")).toBe(false);
    expect(isKnownModel(null)).toBe(false);
  });
});

describe("loop.ts — what the terminal lends a run", () => {
  it("the desktop's own tools when it launched us, and nothing else", () => {
    expect(mcpServersFrom({})).toEqual([]);
    expect(mcpServersFrom({ GLYPHH_APP_MCP_URL: "http://127.0.0.1:4555/mcp" })).toEqual([]);
    expect(mcpServersFrom({ GLYPHH_APP_MCP_URL: "http://127.0.0.1:4555/mcp", GLYPHH_APP_MCP_TOKEN: "t" })).toEqual([
      { name: "glyphh-app", url: "http://127.0.0.1:4555/mcp", headers: { Authorization: "Bearer t" }, tag: "Glyphh" },
    ]);
  });
});

describe("flags — print and exit", () => {
  it("--help and --version are flags, not prompt words; the help names both commands and the key", () => {
    expect(parseFlags(["--help"])).toEqual({ help: true });
    expect(parseFlags(["-h"])).toEqual({ help: true });
    expect(parseFlags(["--version"])).toEqual({ version: true });
    expect(parseFlags(["-v"])).toEqual({ version: true });
    expect(parseFlags(["remote-control"])).toEqual({ prompt: "remote-control" });
    expect(USAGE).toContain("glyphh desktop [args…]");
    expect(HELP).toContain("ANTHROPIC_API_KEY");
    expect(HELP).not.toMatch(/login|server|gateway/i);
  });
});

/** A store the way the desktop writes it: extra fields, a chat on another loop. */
function desktopStore(dir: string): string {
  const file = join(dir, "agent-sessions.json");
  writeFileSync(file, JSON.stringify({
    currentId: "cdesk",
    chats: [
      {
        id: "cdesk", title: "Fix the build", createdAt: 1000, updatedAt: 5000, loop: "glyphh", mode: "code",
        workdir: "/w/app", source: { kind: "local", path: "/w/app" }, permission: "ask", pinned: true,
        messages: [
          { role: "user", text: "fix the build", at: 1000 },
          { role: "assistant", text: "Fixed.", at: 2000 },
          { role: "assistant", text: "compacted", at: 2500, kind: "compact" },
        ],
      },
      { id: "cwork", title: "Notes", createdAt: 900, updatedAt: 9000, loop: "glyphh", mode: "chat", messages: [{ role: "user", text: "hi", at: 9000 }] },
      { id: "cempty", title: "New session", createdAt: 800, loop: "glyphh", messages: [] },
      { id: "cother", title: "Other loop", createdAt: 700, loop: "other", messages: [{ role: "user", text: "x", at: 700 }] },
    ],
  }));
  return file;
}

describe("sessions.ts — one chat store with the desktop", () => {
  it("opens the desktop's chats: the glyphh loop's, newest first, with the plain turns as the seed", () => {
    const file = desktopStore(mkdtempSync(join(tmpdir(), "glyphh-cli-store-")));
    expect(listGlyphhChats(file).map((c) => c.id)).toEqual(["cwork", "cdesk"]);
    expect(listGlyphhChats(file, 1).map((c) => c.id)).toEqual(["cwork"]);
    const chat = findChat(file, "cdesk")!;
    expect(chat.pinned).toBe(true);
    expect(conversationOf(chat)).toEqual([{ role: "user", text: "fix the build" }, { role: "assistant", text: "Fixed." }]);
    expect(touchedAt(chat)).toBe(5000);
    expect(findChat(file, "nope")).toBeNull();
  });

  it("a turn written here keeps every other chat and field, and the newer desktop copy is never overwritten", () => {
    const file = desktopStore(mkdtempSync(join(tmpdir(), "glyphh-cli-store-")));
    const chat = findChat(file, "cdesk")!;
    const next: StoredChat = { ...chat, updatedAt: 6000, messages: [...chat.messages, { role: "user", text: "again", at: 6000 }] };
    saveChat(file, next);
    const after = loadStore(file);
    expect(after.currentId).toBe("cdesk");
    expect(after.chats.map((c) => c.id)).toEqual(["cdesk", "cwork", "cempty", "cother"]);
    expect(after.chats[0]!.messages.map((m) => m.text)).toEqual(["fix the build", "Fixed.", "compacted", "again"]);
    expect(after.chats[0]!.pinned).toBe(true);
    // The desktop wrote something newer meanwhile: the stale copy is dropped.
    saveChat(file, { ...chat, updatedAt: 4000, title: "stale" });
    expect(findChat(file, "cdesk")!.title).toBe("Fix the build");
  });

  it("a new chat lands in the desktop's shape; launched by the desktop, it becomes the current one", () => {
    const file = desktopStore(mkdtempSync(join(tmpdir(), "glyphh-cli-store-")));
    const fresh = newChat("/w/cli", "bypass", "cnew");
    expect(fresh).toMatchObject({ id: "cnew", loop: "glyphh", mode: "code", workdir: "/w/cli", source: { kind: "local", path: "/w/cli" }, permission: "auto", cliSessionIds: { glyphh: "cnew" } });
    saveChat(file, { ...fresh, messages: [{ role: "user", text: "go", at: 1 }] }, { current: true });
    const after = loadStore(file);
    expect(after.currentId).toBe("cnew");
    expect(after.chats[0]!.id).toBe("cnew");
    expect(after.chats).toHaveLength(5);
    // Written as the desktop reads it: plain JSON, chats + currentId.
    expect(Object.keys(JSON.parse(readFileSync(file, "utf-8")) as object).sort()).toEqual(["chats", "currentId"]);
  });

  it("a missing or broken store reads empty, and a save into an unwritable place never throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "glyphh-cli-store-"));
    expect(loadStore(join(dir, "none.json"))).toEqual({ chats: [], currentId: null });
    writeFileSync(join(dir, "bad.json"), "{nope");
    expect(loadStore(join(dir, "bad.json"))).toEqual({ chats: [], currentId: null });
    writeFileSync(join(dir, "file"), "");
    expect(() => saveChat(join(dir, "file", "agent-sessions.json"), newChat("/w", "default"))).not.toThrow();
  });

  it("titles, permission words and ages read the way the desktop shows them", () => {
    expect(titleOf("  refactor the loop\nand more")).toBe("refactor the loop");
    expect(titleOf("")).toBe("New session");
    expect(titleOf("x".repeat(80))).toBe(`${"x".repeat(63)}…`);
    expect(desktopPermission("default")).toBe("ask");
    expect(desktopPermission("bypass")).toBe("auto");
    expect(desktopPermission("plan")).toBe("plan");
    expect(agoLabel(1000, 1000)).toBe("just now");
    expect(agoLabel(0, 5 * 60_000)).toBe("5m ago");
    expect(agoLabel(0, 3 * 3_600_000)).toBe("3h ago");
    expect(agoLabel(0, 2 * 86_400_000)).toBe("2d ago");
  });
});
