/**
 * notify-pref.test.ts — the notifications pref (src/renderer/help/notify-pref.ts):
 * on shows, off drops, ask asks; Allow turns it on, "Don't ask me again" on a
 * dismissal turns it off, a plain dismissal writes nothing (his order, 2026-10-05).
 */
import { describe, it, expect } from "vitest";
import {
  NOTIFY_PREF, NOTIFY_PREF_DEFAULT, NOTIFY_PREFS, NOTIFY_PREF_LABELS,
  readNotifyPref, notifyAction, afterAsk, askLine,
} from "../../src/renderer/help/notify-pref.js";

describe("the pref", () => {
  it("is one shared key, asking by default", () => {
    expect(NOTIFY_PREF).toBe("notifications");
    expect(NOTIFY_PREF_DEFAULT).toBe("ask");
    expect(NOTIFY_PREFS).toEqual(["ask", "on", "off"]);
    for (const p of NOTIFY_PREFS) expect(NOTIFY_PREF_LABELS[p]).toBeTruthy();
  });

  it("reads back the three words and nothing else", () => {
    expect(readNotifyPref("on")).toBe("on");
    expect(readNotifyPref("off")).toBe("off");
    expect(readNotifyPref("ask")).toBe("ask");
    expect(readNotifyPref(true)).toBe("ask");
    expect(readNotifyPref(undefined)).toBe("ask");
    expect(readNotifyPref("yes")).toBe("ask");
  });
});

describe("the decision table", () => {
  it("on shows, off drops, ask asks", () => {
    expect(notifyAction("on")).toBe("deliver");
    expect(notifyAction("off")).toBe("drop");
    expect(notifyAction("ask")).toBe("ask");
  });
});

describe("answering the ask toast", () => {
  it("Allow turns notifications on and shows this one, whatever the box says", () => {
    expect(afterAsk("allow", false)).toEqual({ pref: "on", deliver: true });
    expect(afterAsk("allow", true)).toEqual({ pref: "on", deliver: true });
  });
  it("a dismissal with Don't ask me again turns them off", () => {
    expect(afterAsk("dismiss", true)).toEqual({ pref: "off", deliver: false });
  });
  it("a plain dismissal keeps asking and writes nothing", () => {
    expect(afterAsk("dismiss", false)).toEqual({ deliver: false });
  });
});

describe("the ask line", () => {
  it("names the app, or says an app", () => {
    expect(askLine("CRM")).toBe("CRM wants to notify you");
    expect(askLine("  ")).toBe("An app wants to notify you");
  });
});
