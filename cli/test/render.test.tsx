/**
 * render.test.tsx — layout verification without a TTY. ink-testing-library renders each
 * region to a plain-text frame we can assert on: the version in the header outline, the
 * cat, the key state, the composer, the permission mode, the loop. The transcript is
 * a LINE MODEL (lines.ts) — pure functions asserted directly, plus a styled-line render.
 */

import "./helpers/home.js";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { InputBar } from "../src/components/InputBar.js";
import { Footer } from "../src/components/Footer.js";
import { SubFooter, thinkingLine } from "../src/components/SubFooter.js";
import { TranscriptLine } from "../src/components/TranscriptLine.js";
import { ThemePicker } from "../src/components/ThemePicker.js";
import { theme, applyTheme, themeByName, THEMES, DEFAULT_THEME } from "../src/theme.js";
import { toolLabel, connectionAuthHint, deleteWordBefore, approvalSpec } from "../src/components/App.js";
import { LOGO_MARK, LOGO_NARROW } from "../src/banner.js";
import { Picker } from "../src/components/Picker.js";
import { SlashMenu } from "../src/components/SlashMenu.js";
import { matchCommands, modelLines, permissionLines, effortLines, runSlash, type CommandCtx } from "../src/commands.js";
import { availableModels, defaultModelId } from "../src/models.js";
import { ids } from "./helpers/home.js";
import type { PickerSpec } from "../src/components/Picker.js";
import type { Effort } from "../src/types.js";
import { answerLines, commandLines, headerLines, sectionLines, userLines } from "../src/lines.js";
import type { ChatTurn, TurnStep } from "../src/types.js";

describe("TUI layout", () => {
  it("banner: one card, two panels — welcome + mascot + model + folder left, tips + what's new right; stacked when narrow", () => {
    const info = {
      version: "v1.0.0",
      cwd: "~/development/yo",
      model: "claude-sonnet-5-5",
      keyed: true,
      tips: ["Ask in plain words"],
      notes: ["Full-screen chat TUI", "Slash commands: /model /status"],
    };
    const wide = headerLines(120, LOGO_MARK, info).map((l) => l.text).join("\n");
    expect(wide).toContain("Glyphh v1.0.0"); // version in the border
    expect(wide).toContain("Welcome to Glyphh");
    expect(wide).toContain(LOGO_MARK[1]!.trim()); // the mascot
    expect(wide).toContain("your own providers");
    expect(wide).toContain("~/development/yo");
    expect(wide).toContain("claude-sonnet-5-5");
    expect(wide).toContain("Tips for getting started");
    expect(wide).toContain("What's new");
    expect(wide).toContain("Full-screen chat TUI");
    // Two panels: a tip sits on the same row as the welcome.
    const welcomeRow = headerLines(120, LOGO_MARK, info).find((l) => l.text.includes("Welcome to Glyphh"))!.text;
    expect(welcomeRow).toContain("Tips for getting started");
    // Narrow: stacked, every line fits.
    const narrowLines = headerLines(48, LOGO_MARK, info);
    const narrow = narrowLines.map((l) => l.text).join("\n");
    expect(narrow).toContain("Welcome to Glyphh");
    expect(narrow).toContain("What's new");
    for (const l of narrowLines) expect([...l.text].length).toBeLessThanOrEqual(48);
    // The card's mascot is the whole mark's left 16 columns.
    expect(LOGO_MARK).toHaveLength(LOGO_NARROW.length);
    expect(LOGO_MARK.every((r) => [...r].length <= 16)).toBe(true);
    expect(LOGO_NARROW.some((r) => [...r].length > 16)).toBe(true);
    // No key: the card says so and how to fix it.
    const out = headerLines(80, LOGO_MARK, { ...info, keyed: false, tips: [] }).map((l) => l.text).join("\n");
    expect(out).toContain("no model provider");
    expect(out).not.toContain("your own providers");
    expect(out).not.toContain("Tips for getting started");
  });

  it("the picker lists numbered options, ticks the current one and points at the selection", () => {
    const frame = render(
      <Picker width={80} selected={1} spec={{
        title: "Select model",
        description: "The models your Anthropic key reaches.",
        options: [{ id: "", label: "Default", current: true, detail: "currently claude-opus-5-5" }, { id: "claude-sonnet-5-5", label: "claude-sonnet-5-5" }],
        secondary: { key: "s", label: "use this session only" },
        enterLabel: "set as default",
        onPick: () => undefined,
      }} />,
    ).lastFrame()!;
    expect(frame).toContain("Select model");
    expect(frame).toContain("1. Default ✔");
    expect(frame).toContain("❯  2. claude-sonnet-5-5");
    expect(frame).toContain("Enter to set as default · s to use this session only · Esc to cancel");
  });

  it("the composer draws a real cursor inside the text", () => {
    const frame = render(<InputBar width={60} value="hello there" cursor={5} busy={false} />).lastFrame()!;
    expect(frame).toContain("hello");
    expect(frame).toContain("there");
    expect(render(<InputBar width={60} value="" busy={false} />).lastFrame()!).toContain("? for shortcuts");
  });

  it("the slash menu lists matching commands with the selection marked", () => {
    const items = matchCommands("m");
    expect(items.map((c) => c.name)).toEqual(["mcp", "model"]);
    const frame = render(<SlashMenu width={80} items={items} selected={1} />).lastFrame()!;
    expect(frame).toContain("/mcp");
    expect(frame).toContain("▸ /model");
    expect(matchCommands("").length).toBeGreaterThan(10);
    expect(matchCommands("zz")).toEqual([]);
  });

  it("word delete removes the word before the cursor", () => {
    expect(deleteWordBefore("fix the tests", 13)).toEqual({ value: "fix the ", cursor: 8 });
    expect(deleteWordBefore("fix the tests", 8)).toEqual({ value: "fix tests", cursor: 4 });
    expect(deleteWordBefore("", 0)).toEqual({ value: "", cursor: 0 });
  });

  it("input bar shows the typed text behind the prompt glyph", () => {
    const { lastFrame } = render(<InputBar width={60} value="hello there" busy={false} />);
    const frame = lastFrame()!;
    expect(frame).toContain("hello there");
    expect(frame).toContain("❯");
  });

  it("footer shows permission mode far-left, then model slots, then the loop far-right", () => {
    const { lastFrame } = render(
      <Footer
        width={80}
        permissionMode="bypass"
        loop="glyphh"
        slots={[{ label: "model", model: "claude-sonnet-5" }]}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("bypass permissions on"); // permission (far left), the other CLIs' words
    expect(frame).toContain("claude-sonnet-5"); // resolved model slot
    expect(frame).toContain("loop glyphh"); // loop (far right)
    // Order: permission before model before loop.
    expect(frame.indexOf("bypass permissions on")).toBeLessThan(frame.indexOf("claude-sonnet-5"));
    expect(frame.indexOf("claude-sonnet-5")).toBeLessThan(frame.indexOf("loop glyphh"));
    expect(permissionLines("plan").join("\n")).toContain("▸ plan");
  });

  it("footer shows the effort dial beside the model", () => {
    const frame = render(
      <Footer width={100} permissionMode="default" loop="glyphh" slots={[{ label: "model", model: "claude-sonnet-5" }]} effort="Extra high" />,
    ).lastFrame()!;
    expect(frame).toContain("claude-sonnet-5 · effort Extra high");
    expect(frame.indexOf("effort Extra high")).toBeLessThan(frame.indexOf("loop glyphh"));
  });

  it("footer labels each slot when a loop declares more than one", () => {
    const { lastFrame } = render(
      <Footer
        width={100}
        permissionMode="default"
        loop="planning"
        slots={[
          { label: "planner", model: "claude-opus-4-8" },
          { label: "coder", model: "claude-haiku-4-5" },
        ]}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("planner claude-opus-4-8");
    expect(frame).toContain("coder claude-haiku-4-5");
    expect(frame).toContain("loop planning");
  });
});

describe("line model", () => {
  it("user input leads with the prompt glyph; answers with the bullet", () => {
    expect(userLines("hi", 60).map((l) => l.text).join("\n")).toContain("❯ hi");
    expect(answerLines("hello!", 60).map((l) => l.text).join("\n")).toContain("● hello!");
  });

  it("a slash command carries its └ result lines", () => {
    const lines = commandLines("/model claude-haiku-5-5", ["model → claude-haiku-5-5", "this session"], 80);
    const text = lines.map((l) => l.text).join("\n");
    expect(text).toContain("❯ /model claude-haiku-5-5");
    expect(text).toContain("└ model → claude-haiku-5-5");
    expect(text).toContain("this session");
    expect(lines.filter((l) => l.style === "result").length).toBe(2);
  });

  it("a section collapses to 3 details with a fold hint, and unfolds fully", () => {
    const step: TurnStep = {
      label: "write files",
      ok: true,
      secs: 1.2,
      details: ["→ a.ts (10 bytes)", "→ b.ts (20 bytes)", "→ c.ts (30 bytes)", "→ d.ts (40 bytes)", "$ npm test"],
    };
    const folded = sectionLines(step, false);
    expect(folded[0]!.text).toContain("▸ write files · 1.2s");
    expect(folded.filter((l) => l.style === "detail").length).toBe(3);
    expect(folded.find((l) => l.style === "hint")!.text).toContain("+2 lines");
    const open = sectionLines(step, true);
    expect(open[0]!.text).toContain("▾ write files");
    expect(open.filter((l) => l.style === "detail").length).toBe(5);
    expect(open.find((l) => l.style === "hint")).toBeUndefined();
  });

  it("a failing step renders the error style + message", () => {
    const step: TurnStep = { label: "run tests", ok: false, details: [], error: "exit 1" };
    const lines = sectionLines(step, false);
    expect(lines[0]!.style).toBe("headErr");
    expect(lines[0]!.text).toContain("exit 1");
  });

  it("TranscriptLine renders a head with its glyph and a detail with its gutter", () => {
    const sel = render(<TranscriptLine line={{ text: "▸ step", style: "head" }} />).lastFrame()!;
    expect(sel).toContain("▸ step");
    const detail = render(<TranscriptLine line={{ text: "  │ → a.ts", style: "detail" }} />).lastFrame()!;
    expect(detail).toContain("│ → a.ts");
  });
});

describe("status strip", () => {
  it("a settled turn shows the verb, duration and tokens", () => {
    const last: ChatTurn = { id: "t1", text: "done", status: "done", durationMs: 2300, tokensUp: 120, tokensDown: 480 };
    const frame = render(
      <SubFooter width={80} busy={false} elapsed={0} last={last} verb={{ ing: "Brewing", past: "Brewed" }} />,
    ).lastFrame()!;
    expect(frame).toContain("Brewed for 2.3s");
    expect(frame).toContain("120↑ 480↓ tok");
  });

  it("a working turn shows the model's thinking as one dim line, folded and clipped", () => {
    const last: ChatTurn = { id: "t1", text: "", status: "running", tokensUp: 0, tokensDown: 0 };
    const frame = render(
      <SubFooter width={60} busy elapsed={1.2} last={last} verb={{ ing: "Brewing", past: "Brewed" }} thinking={"The user wants\n  a refactor; first\tI read the module"} />,
    ).lastFrame()!;
    expect(frame).toContain("Brewing…");
    expect(frame).toContain("Thinking… The user wants a refactor; first I read the mod");
    expect(frame.split("\n").filter((l) => l.includes("Thinking…"))).toHaveLength(1);
    expect(thinkingLine("short", 40)).toBe("Thinking… short");
    expect(thinkingLine("x".repeat(100), 30)).toBe(`Thinking… ${"x".repeat(17)}…`);
    // No thought, no line.
    const quiet = render(<SubFooter width={60} busy elapsed={0.1} last={last} verb={{ ing: "Brewing", past: "Brewed" }} />).lastFrame()!;
    expect(quiet).not.toContain("Thinking…");
  });

  it("a stopped turn says so", () => {
    const last: ChatTurn = { id: "t1", text: "", status: "stopped", durationMs: 100, tokensUp: 0, tokensDown: 0 };
    const frame = render(
      <SubFooter width={100} busy={false} elapsed={0} last={last} verb={{ ing: "Brewing", past: "Brewed" }} />,
    ).lastFrame()!;
    expect(frame).toContain("stopped");
  });
});

describe("/effort", () => {
  function ctx(effort: Effort): CommandCtx & { picks: PickerSpec[]; set: Array<[Effort, boolean]>; notes: string[] } {
    const c = {
      picks: [] as PickerSpec[], set: [] as Array<[Effort, boolean]>, notes: [] as string[],
      effort,
      model: null, permission: "default" as const, chatId: "c1", version: "1.4.10", cwd: "/w", keyed: true, sessionsFile: "/nonexistent/agent-sessions.json",
      cost: { turns: 0, tokensUp: 0, tokensDown: 0, durationMs: 0, startedAt: 0 },
      setEffort: (e: Effort, o?: { session?: boolean }) => { c.set.push([e, !!o?.session]); },
      openPicker: (spec: PickerSpec) => { c.picks.push(spec); },
      note: (t: string) => { c.notes.push(t); },
      emit: () => undefined, setModel: () => undefined, setPermission: () => undefined, setTheme: () => undefined,
      clearChat: () => undefined, quit: () => undefined, resumeChat: async () => [],
    };
    return c;
  }

  it("with no argument opens a selector like /model: five levels, labelled, the current one ticked, s for the session", async () => {
    const c = ctx("medium");
    expect(await runSlash(c, "/effort")).toEqual([]);
    const spec = c.picks[0]!;
    expect(spec.title).toBe("Select effort");
    expect(spec.options.map((o) => o.label)).toEqual(["Low", "Medium", "High", "Extra high", "Ultra"]);
    expect(spec.options.map((o) => o.id)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(spec.options.find((o) => o.current)?.id).toBe("medium");
    expect(spec.secondary).toEqual({ key: "s", label: "use this session only" });
    spec.onPick("max", false);
    spec.onPick("high", true);
    expect(c.set).toEqual([["max", false], ["high", true]]);
    expect(c.notes).toEqual(["effort → Ultra", "effort → High (this session)"]);
    const frame = render(<Picker width={80} spec={spec} selected={3} />).lastFrame()!;
    expect(frame).toContain("Medium ✔");
    expect(frame).toContain("❯  4. Extra high");
  });

  it("/effort <level> sets it by word or label; a bad word lists the dial", async () => {
    const c = ctx("medium");
    expect(await runSlash(c, "/effort high")).toEqual(["effort → high · High"]);
    expect(await runSlash(c, "/effort ultra")).toEqual(["effort → max · Ultra"]);
    expect(c.set).toEqual([["high", false], ["max", false]]);
    expect(await runSlash(c, "/effort extreme")).toEqual(["unknown effort: extreme — one of low, medium, high, xhigh, max"]);
    expect(effortLines("high").join("\n")).toContain("▸ high     High");
    expect(await runSlash(c, "/status")).toEqual(expect.arrayContaining([expect.stringContaining("effort Medium")]));
    expect(matchCommands("eff").map((x) => x.name)).toEqual(["effort"]);
  });
});

describe("themes", () => {
  it("has a dark default and swaps the live palette in place", () => {
    expect(DEFAULT_THEME).toBe("dark");
    const dark = themeByName("dark").colors;
    const light = themeByName("light").colors;
    expect(dark.text).not.toBe(light.text);

    applyTheme("light");
    expect(theme.text).toBe(light.text); // the shared object mutated in place
    const restored = applyTheme("dark"); // leave the module in its default for other tests
    expect(restored.name).toBe("dark");
    expect(theme.text).toBe(dark.text);
  });

  it("an unknown theme name falls back to the default", () => {
    expect(themeByName("nope").name).toBe("dark");
  });

  it("the picker lists every theme and marks the current one", () => {
    const frame = render(<ThemePicker current="claude" onPick={() => {}} />).lastFrame()!;
    for (const t of THEMES) expect(frame).toContain(t.label);
    expect(frame).toContain("Choose your theme");
    expect(frame).toContain("▸"); // a selection marker is drawn
    applyTheme("dark"); // the picker previews the current theme — reset for isolation
  });
});

describe("tool receipts", () => {
  it("prefers the pod's human title, falls back to the tool name", () => {
    expect(toolLabel("Bash", "Run npm test")).toBe("Run npm test");
    expect(toolLabel("Bash", "  ")).toBe("Bash");
    expect(toolLabel("Write")).toBe("Write");
  });

  it("bounds a long title so a receipt head never wraps", () => {
    const label = toolLabel("Bash", "x".repeat(200));
    expect(label.length).toBe(76);
    expect(label.endsWith("…")).toBe(true);
  });
});

describe("connection-auth hint", () => {
  it("turns an unauthorized-connection error into an actionable note", () => {
    const hint = connectionAuthHint("conn__google_drive__google_drive-create-folder", "No access/refresh token");
    expect(hint).toMatch(/google drive/i);
    expect(hint).toMatch(/connect/i);
  });

  it("returns null for a normal (non-auth) tool error", () => {
    expect(connectionAuthHint("Bash", "command not found: foo")).toBeNull();
  });
});

describe("approval selector", () => {
  it("asks the other CLIs' question: yes · yes and don't ask again · no, and answers accordingly", () => {
    const answers: Array<[boolean, boolean]> = [];
    const spec = approvalSpec({ id: "c:g1", kind: "command", title: "bash npm test", detail: "{\n  command: npm test\n}" }, (allow, always) => answers.push([allow, always]));
    expect(spec.title).toBe("Allow this command?");
    expect(spec.options.map((o) => o.id)).toEqual(["yes", "always", "no"]);
    expect(spec.options[1]!.label).toContain("don't ask again for commands");
    spec.onPick("yes", false); spec.onPick("always", false); spec.onPick("no", false); spec.onCancel?.();
    expect(answers).toEqual([[true, false], [true, true], [false, false], [false, false]]);
  });
});

describe("/model, /status and /config — the local catalog and the user's own key", () => {
  function ctx(opts: { model?: string | null; keyed?: boolean } = {}): CommandCtx & { picks: PickerSpec[]; models: Array<[string | null, boolean]>; notes: string[] } {
    const c = {
      picks: [] as PickerSpec[], models: [] as Array<[string | null, boolean]>, notes: [] as string[],
      effort: "medium" as const, model: opts.model ?? null, keyed: opts.keyed ?? true,
      permission: "default" as const, chatId: "c1", version: "1.7.1", cwd: "/w", sessionsFile: "/nonexistent/agent-sessions.json",
      cost: { turns: 0, tokensUp: 0, tokensDown: 0, durationMs: 0, startedAt: 0 },
      setModel: (id: string | null, o?: { session?: boolean }) => { c.models.push([id, !!o?.session]); },
      openPicker: (spec: PickerSpec) => { c.picks.push(spec); },
      note: (t: string) => { c.notes.push(t); },
      emit: () => undefined, setEffort: () => undefined, setPermission: () => undefined, setTheme: () => undefined,
      clearChat: () => undefined, quit: () => undefined, resumeChat: async () => [],
    };
    return c;
  }

  it("the list is the desktop's chat models, each with its provider and the default marked", () => {
    const models = availableModels();
    expect(models.map((m) => m.id)).toEqual(ids("claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5"));
    expect(defaultModelId()).toBe("anthropic::claude-opus-5-5");
    expect(models[0]!.detail).toBe("Anthropic · the default");
    expect(models[3]!.detail).toBe("Anthropic");
  });

  it("/model opens a selector over the catalog with Default on top; a pick sets it, for the device or the session", async () => {
    const c = ctx();
    expect(await runSlash(c, "/model")).toEqual([]);
    const spec = c.picks[0]!;
    expect(spec.options.map((o) => o.id)).toEqual(["", ...ids("claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5")]);
    expect(spec.options[0]).toMatchObject({ label: "Default", detail: "currently anthropic::claude-opus-5-5", current: true });
    spec.onPick("anthropic::claude-haiku-5-5", true);
    spec.onPick("", false);
    expect(c.models).toEqual([["anthropic::claude-haiku-5-5", true], [null, false]]);
    expect(c.notes).toEqual(["model → anthropic::claude-haiku-5-5 (this session)", "model → the default (anthropic::claude-opus-5-5)"]);
  });

  it("/model <id> takes a catalog id, refuses anything else, and /model list marks the current one", async () => {
    const c = ctx({ model: "anthropic::claude-fable-5-1" });
    expect(await runSlash(c, "/model anthropic::claude-sonnet-5-5")).toEqual(["model → anthropic::claude-sonnet-5-5"]);
    expect(await runSlash(c, "/model gpt-5.6")).toEqual(["gpt-5.6 is not a model Glyphh runs — /model list shows them"]);
    expect(await runSlash(c, "/model default")).toEqual(["model → the default (anthropic::claude-opus-5-5)"]);
    expect(c.models).toEqual([["anthropic::claude-sonnet-5-5", false], [null, false]]);
    const list = await runSlash(c, "/model list");
    expect(list[0]).toBe("your chat models (Settings › Models):");
    expect(list.find((l) => l.includes("claude-fable-5-1"))).toContain("← current");
    expect(list.at(-1)).toBe("pick:  /model <id>    the default (anthropic::claude-opus-5-5):  /model default");
    expect(modelLines(availableModels(), null).find((l) => l.includes("claude-opus-5-5"))).toContain("← current");
    expect(modelLines(availableModels(), null).at(-1)).toBe("pick:  /model <id>    (running on the default, anthropic::claude-opus-5-5)");
  });

  it("/status and /config say whether there is a key and where it goes — no account, no server", async () => {
    const keyed = await runSlash(ctx(), "/status");
    expect(keyed[0]).toBe("providers set · turns run on your own keys");
    expect(keyed[1]).toBe("model the default (anthropic::claude-opus-5-5) · effort Medium · permissions default");
    expect(keyed.join("\n")).not.toMatch(/server|signed in|plan/);
    expect((await runSlash(ctx({ keyed: false }), "/status"))[0]).toBe("no model provider · add one in Settings › Models, or set ANTHROPIC_API_KEY");
    const config = (await runSlash(ctx({ keyed: false }), "/config")).join("\n");
    expect(config).toContain("providers    not set   Settings › Models, or ~/.glyphh/users/local/providers.json");
    expect(config).not.toContain("server");
  });

  it("the cut commands are gone: no /login, /logout or /remote-control", async () => {
    for (const name of ["login", "logout", "remote-control"]) {
      expect(await runSlash(ctx(), `/${name}`)).toEqual([`unknown command: /${name} — try /help`]);
    }
    expect(matchCommands("").map((c) => c.name)).toEqual(["help", "clear", "compact", "config", "cost", "effort", "exit", "mcp", "model", "permissions", "resume", "status", "theme", "version"]);
  });
});
