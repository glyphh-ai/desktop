/**
 * rpa-map.test.ts — RPA ON A TAB (2026-10-07): the mapping is written on the
 * tab's row, a run opens the panel, waits, acts, pauses and verifies, and a
 * sequence stops where it fails.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = new Map<string, { slug: string; name: string; config: Record<string, unknown> | null; updatedAt: string }>();
const live = new Set<string>();
const calls: Array<[string, unknown]> = [];
const page = { selectors: new Set<string>(), evals: [] as string[] };
const wc = {
  id: 7, isDestroyed: () => false, focus: () => undefined,
  executeJavaScript: vi.fn(async (js: string) => {
    page.evals.push(js);
    const m = /document\.querySelector\("([^"]+)"\)/.exec(js);
    if (js.startsWith("!!document.querySelector")) return page.selectors.has(m![1]!);
    if (js.includes("__glyphh_pick__") && js.includes("new Promise")) return { selector: "#send", tag: "button", text: "Send", isEditable: false, isClickable: true };
    return "custom-result";
  }),
};

vi.mock("electron", () => ({ webContents: { fromId: (id: number) => (id === 7 ? wc : undefined) } }));
vi.mock("../../src/main/relay-client.js", () => ({
  registerRelayHandler: () => undefined,
  dispatchRelayMethod: async (method: string, params: unknown) => {
    calls.push([method, params]);
    const p = params as Record<string, string>;
    if (method === "panels.open") { live.add(p.app!); return { opened: true }; }
    if (method === "rpa.target") return { id: 7 };
    if (method === "rpa.read") return { value: `text of ${p.selector}` };
    if (method === "rpa.goto") return { url: p.url };
    if (method === "rpa.click" && !page.selectors.has(p.selector!)) throw new Error(`no element matched ${p.selector}`);
    return { ok: true };
  },
}));
vi.mock("../../src/main/rpa.js", () => ({ panelIsLive: (slug: string) => live.has(slug) }));
vi.mock("../../src/main/apps-store.js", () => ({
  readRow: (slug: string) => rows.get(slug) ?? null,
  updateEntry: async (slug: string, patch: { config?: Record<string, unknown> }) => {
    const r = rows.get(slug)!;
    r.config = patch.config ?? r.config; r.updatedAt = new Date().toISOString();
    return r;
  },
}));

const { mapCommand, unmapCommand, saveSequence, removeSequence, runCommand, runSequence, readTabRpa, pickOnTab } = await import("../../src/main/rpa-map.js");

beforeEach(() => {
  rows.clear(); live.clear(); calls.length = 0; page.selectors.clear(); page.evals.length = 0;
  rows.set("gmail", { slug: "gmail", name: "Gmail", config: { forceWeb: true }, updatedAt: "2026-10-07T00:00:00Z" });
});

describe("the mapping on the tab's row", () => {
  it("writes commands and sequences under launchConfig.rpa and keeps the rest of the config", async () => {
    await mapCommand("gmail", { key: "compose", description: "Open compose", action: "click", selector: ".compose" });
    await mapCommand("gmail", { key: "body", action: "type", selector: "textarea", text: "{{value}}" });
    await saveSequence("gmail", { name: "mail", description: "Write a mail", steps: [{ command: "compose" }, { command: "body", value: "Hi {{name}}" }] });
    const cfg = rows.get("gmail")!.config as { forceWeb: boolean; rpa: { commands: Record<string, unknown>; sequences: Record<string, unknown> } };
    expect(cfg.forceWeb).toBe(true);
    expect(Object.keys(cfg.rpa.commands)).toEqual(["compose", "body"]);
    expect(Object.keys(cfg.rpa.sequences)).toEqual(["mail"]);
    await removeSequence("gmail", "mail");
    await unmapCommand("gmail", "body");
    expect(readTabRpa("gmail")).toEqual({ commands: { compose: { key: "compose", description: "Open compose", action: "click", selector: ".compose" } }, sequences: {} });
    await expect(unmapCommand("gmail", "nope")).rejects.toThrow(/not a mapped command/);
    await expect(mapCommand("drive", { key: "x", action: "click", selector: "a" })).rejects.toThrow(/no saved tab "drive"/);
  });
});

describe("running", () => {
  it("opens the panel when it is closed, waits for the selector, acts, and verifies", async () => {
    page.selectors.add(".compose"); page.selectors.add(".compose-open");
    await mapCommand("gmail", { key: "compose", action: "click", selector: ".compose", waitFor: ".compose", guide: { verify: ".compose-open", delay: 10 } });
    const r = await runCommand("gmail", "compose");
    expect(calls[0]).toEqual(["panels.open", { app: "gmail" }]);
    expect(calls.some(([m, p]) => m === "rpa.click" && (p as { selector: string }).selector === ".compose")).toBe(true);
    expect(r).toEqual({ app: "gmail", command: "compose", action: "click", ok: true, verified: ".compose-open" });
  });
  it("a failed action names the command and carries the recover hint; a missing verify is a failure too", async () => {
    live.add("gmail");
    await mapCommand("gmail", { key: "send", action: "click", selector: "#send", guide: { recover: "use the icon" } });
    await expect(runCommand("gmail", "send")).rejects.toThrow(/gmail send \(click\) failed: no element matched #send\. If it fails: use the icon/);
    page.selectors.add("#send");
    await mapCommand("gmail", { key: "send", action: "click", selector: "#send", guide: { verify: ".sent" } });
    await expect(runCommand("gmail", "send")).rejects.toThrow(/ran but did not verify/);
  }, 15_000);
  it("type, goto and custom take the value; read returns the text", async () => {
    live.add("gmail");
    await mapCommand("gmail", { key: "body", action: "type", selector: "textarea", text: "Dear {{value}}" });
    await mapCommand("gmail", { key: "open", action: "goto", url: "https://mail/{{value}}" });
    await mapCommand("gmail", { key: "subject", action: "read", selector: "h2" });
    await mapCommand("gmail", { key: "count", action: "custom", script: "return VALUE.length" });
    await runCommand("gmail", "body", "Ada");
    expect(calls.find(([m]) => m === "rpa.type")![1]).toEqual({ app: "gmail", selector: "textarea", text: "Dear Ada" });
    expect((await runCommand("gmail", "open", "inbox")).result).toBe("https://mail/inbox");
    expect((await runCommand("gmail", "subject")).result).toBe("text of h2");
    const custom = await runCommand("gmail", "count", "abc");
    expect(custom.result).toBe("custom-result");
    expect(page.evals.at(-1)).toContain('const VALUE = "abc"');
    await expect(runCommand("gmail", "nope")).rejects.toThrow(/not a mapped command of gmail: body, open, subject, count/);
  });
  it("a sequence fills placeholders, carries a read into later steps, and stops where it fails", async () => {
    live.add("gmail"); page.selectors.add(".compose");
    await mapCommand("gmail", { key: "compose", action: "click", selector: ".compose" });
    await mapCommand("gmail", { key: "subject", action: "read", selector: "h2" });
    await mapCommand("gmail", { key: "body", action: "type", selector: "textarea", text: "{{value}}" });
    await mapCommand("gmail", { key: "send", action: "click", selector: "#send" });
    await saveSequence("gmail", { name: "reply", description: "Reply", steps: [{ command: "compose" }, { command: "subject" }, { command: "body", value: "Re: {{subject}} — {{text}}" }, { command: "send" }] });
    await expect(runSequence("gmail", "reply", { text: "thanks" })).rejects.toThrow(/sequence reply stopped at step 4 \(send\): gmail send \(click\) failed/);
    expect(calls.find(([m]) => m === "rpa.type")![1]).toEqual({ app: "gmail", selector: "textarea", text: "Re: text of h2 — thanks" });
    page.selectors.add("#send");
    const r = await runSequence("gmail", "reply", { text: "thanks" });
    expect(r.steps.map((s) => s.command)).toEqual(["compose", "subject", "body", "send"]);
    expect(r.steps[1]).toEqual({ command: "subject", result: "text of h2" });
    await expect(saveSequence("gmail", { name: "bad", steps: [{ command: "archive" }] })).rejects.toThrow(/"archive" is not a mapped command/);
  });
  it("the picker runs on the panel and hands back the element", async () => {
    live.add("gmail");
    expect(await pickOnTab("gmail")).toMatchObject({ selector: "#send", tag: "button", isClickable: true });
  });
});
