/**
 * app.test.tsx — the whole chat, headless, on a throwaway home. With no key
 * provider the card says so and a prompt answers with where to add one (never a
 * login); a provider the desktop saved counts; --resume opens a chat the desktop
 * wrote; and the first run asks for a theme before the chat. HOME points at a
 * temp folder BEFORE the modules load, so app-paths resolves ~/.glyphh there
 * and nothing touches the real one.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "ink-testing-library";
import type { App as AppT } from "../src/components/App.js";
import type { Boot as BootT } from "../src/components/Boot.js";

const home = mkdtempSync(join(tmpdir(), "glyphh-cli-home-"));
const userDir = join(home, ".glyphh", "users", "local");
const savedHome = process.env.HOME;
const savedKey = process.env.ANTHROPIC_API_KEY;
let App: typeof AppT;
let Boot: typeof BootT;

/** Ink paints on the next tick; give it a few. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

beforeAll(async () => {
  process.env.HOME = home;
  delete process.env.ANTHROPIC_API_KEY;
  mkdirSync(userDir, { recursive: true });
  writeFileSync(join(userDir, "providers.json"), JSON.stringify({ providers: [], models: [], defaults: {} }));
  ({ App } = await import("../src/components/App.js"));
  ({ Boot } = await import("../src/components/Boot.js"));
  return () => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  };
});

afterEach(() => {
  cleanup();
  delete process.env.ANTHROPIC_API_KEY;
  writeFileSync(join(userDir, "providers.json"), JSON.stringify({ providers: [], models: [], defaults: {} }));
});

describe("the chat with no key", () => {
  it("the card says there is no provider, and a prompt answers with where to add one — no login", async () => {
    const ui = render(<App version="1.7.1" cwd="~/w" trusted />);
    await settle();
    expect(ui.lastFrame()).toContain("no model provider");
    expect(ui.lastFrame()).not.toMatch(/login|sign in/i);
    ui.stdin.write("hello");
    await settle();
    ui.stdin.write("\r");
    await settle();
    const frame = ui.lastFrame()!;
    expect(frame).toContain("❯ hello");
    expect(frame).toContain("No model provider is set up.");
    expect(frame).toContain("Settings › Models");
  });

  it("a provider the desktop saved in providers.json counts", async () => {
    writeFileSync(join(userDir, "providers.json"), JSON.stringify({
      providers: [{ id: "anthropic", kind: "anthropic", name: "Anthropic", apiKey: "sk-ant-saved" }],
      models: [{ id: "anthropic::claude-opus-5-5", provider: "anthropic", model: "claude-opus-5-5", type: "chat" }],
      defaults: { chat: "anthropic::claude-opus-5-5" },
    }));
    const ui = render(<App version="1.7.1" cwd="~/w" trusted />);
    await settle();
    expect(ui.lastFrame()).toContain("your own providers");
    expect(ui.lastFrame()).toContain("claude-opus-5-5");
  });
});

describe("the chat on the desktop's store", () => {
  it("--resume opens a chat the desktop wrote, its turns in the transcript", async () => {
    writeFileSync(join(userDir, "agent-sessions.json"), JSON.stringify({
      currentId: null,
      chats: [{ id: "cdesk", title: "From the desktop", createdAt: 1, updatedAt: 2, loop: "glyphh", messages: [{ role: "user", text: "what is here", at: 1 }, { role: "assistant", text: "A package.", at: 2 }] }],
    }));
    const ui = render(<App version="1.7.1" cwd="~/w" trusted resumeId="cdesk" />);
    await settle();
    expect(ui.lastFrame()).toContain("❯ what is here");
    expect(ui.lastFrame()).toContain("● A package.");
    const missing = render(<App version="1.7.1" cwd="~/w" trusted resumeId="cgone" />);
    await settle();
    expect(missing.lastFrame()).toContain("no conversation cgone on this machine — starting fresh");
  });
});

describe("Boot", () => {
  it("the first run asks for a theme; once one is saved the chat opens straight away", async () => {
    const first = render(<Boot version="1.7.1" cwd="~/w" trusted />);
    await settle();
    expect(first.lastFrame()).toContain("Choose your theme");
    first.stdin.write("\r");
    await settle();
    expect(first.lastFrame()).toContain("Welcome to Glyphh");
    cleanup();
    const again = render(<Boot version="1.7.1" cwd="~/w" trusted />);
    await settle();
    expect(again.lastFrame()).toContain("Welcome to Glyphh");
  });
});
