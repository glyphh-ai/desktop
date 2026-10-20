import { describe, expect, it } from "vitest";
import { commandToolSpec, normalizeCommand, normalizeSequence, rpaOf, sequenceToolSpec, substitute, withCommand, withSequence, withoutCommand, withoutSequence } from "../../src/shared/rpa.js";

describe("RPA ON A TAB (2026-10-07): the mapping model", () => {
  it("normalizes a command: key and action checked, the fields the action needs", () => {
    const c = normalizeCommand({ key: " Send ", action: "click", selector: "button[aria-label=Send]", description: "Send the mail", guide: { verify: ".sent", delay: 500, pre: "compose is open" } });
    expect(c).toEqual({ key: "send", description: "Send the mail", action: "click", selector: "button[aria-label=Send]", guide: { verify: ".sent", delay: 500, pre: "compose is open" } });
    expect(() => normalizeCommand({ key: "Bad Key!", action: "click", selector: "a" })).toThrow(/command key/);
    expect(() => normalizeCommand({ key: "x", action: "hover", selector: "a" })).toThrow(/action is one of/);
    expect(() => normalizeCommand({ key: "x", action: "type" })).toThrow(/needs a selector/);
    expect(() => normalizeCommand({ key: "x", action: "goto" })).toThrow(/needs a url/);
    expect(() => normalizeCommand({ key: "x", action: "custom" })).toThrow(/needs a script/);
    expect(normalizeCommand({ key: "go", action: "goto", url: "https://x/{{value}}" }).url).toBe("https://x/{{value}}");
  });
  it("reads a tab's config loosely and keeps bad rows out", () => {
    const cfg = rpaOf({ rpa: { commands: { send: { action: "click", selector: "b" }, broken: { action: "type" } }, sequences: { mail: { description: "d", steps: [{ command: "send" }] }, empty: { steps: [] } } } });
    expect(Object.keys(cfg.commands)).toEqual(["send"]);
    expect(Object.keys(cfg.sequences)).toEqual(["mail"]);
    expect(rpaOf(null)).toEqual({ commands: {}, sequences: {} });
    expect(rpaOf({ rpa: "junk" })).toEqual({ commands: {}, sequences: {} });
  });
  it("a sequence's steps must be mapped commands; add and remove keep the rest", () => {
    let cfg = withCommand(rpaOf(null), normalizeCommand({ key: "compose", action: "click", selector: ".compose" }));
    cfg = withCommand(cfg, normalizeCommand({ key: "body", action: "type", selector: "textarea", text: "{{value}}" }));
    expect(() => withSequence(cfg, normalizeSequence({ name: "mail", steps: [{ command: "send" }] }))).toThrow(/not a mapped command/);
    cfg = withSequence(cfg, normalizeSequence({ name: "Mail", steps: [{ command: "compose" }, { command: "body", value: "Hi {{name}}" }] }));
    expect(cfg.sequences.mail!.steps).toEqual([{ command: "compose" }, { command: "body", value: "Hi {{name}}" }]);
    expect(Object.keys(withoutCommand(cfg, "body").commands)).toEqual(["compose"]);
    expect(Object.keys(withoutSequence(cfg, "mail").sequences)).toEqual([]);
    expect(() => normalizeSequence({ name: "x", steps: [{}] })).toThrow(/names no command/);
  });
  it("placeholders fill from args; the tools are named <tab>_<key> with the args their action takes", () => {
    expect(substitute("Hi {{ name }}, {{missing}}!", { name: "Ada" })).toBe("Hi Ada, !");
    const click = commandToolSpec("gmail", normalizeCommand({ key: "send", action: "click", selector: "b", description: "Send", guide: { pre: "compose open", recover: "use the icon" } }));
    expect(click.name).toBe("gmail_send");
    expect(click.inputSchema).toEqual({ type: "object", properties: {} });
    expect(click.description).toMatch(/Before: compose open\. If it fails: use the icon\./);
    const type = commandToolSpec("gmail", normalizeCommand({ key: "body", action: "type", selector: "t", text: "{{value}}" }));
    expect(type.inputSchema).toMatchObject({ required: ["value"] });
    expect(commandToolSpec("gmail", normalizeCommand({ key: "subject", action: "read", selector: "h2" })).readOnly).toBe(true);
    const seq = sequenceToolSpec("gmail", normalizeSequence({ name: "mail", description: "Send a mail", steps: [{ command: "compose" }, { command: "body", value: "Hi {{name}}, {{text}}" }] }));
    expect(seq.name).toBe("gmail_mail");
    expect(seq.inputSchema).toEqual({ type: "object", properties: { name: { type: "string" }, text: { type: "string" } }, required: ["name", "text"] });
    expect(seq.description).toContain("compose → body");
  });
});
