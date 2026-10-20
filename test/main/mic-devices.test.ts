import { describe, expect, it } from "vitest";
import { cleanMicLabel, micChecked, micRows } from "../../src/renderer/help/mic-devices.js";

describe("the microphone picker's rows (his report, 2026-10-07)", () => {
  it("drops the browser's virtual Default / Communications twins and the hex ids, one row per name", () => {
    const rows = micRows([
      { deviceId: "default", label: "Default - Insta360 Link 2 Pro (2e1a:4c06)" },
      { deviceId: "communications", label: "Communications - Insta360 Link 2 Pro (2e1a:4c06)" },
      { deviceId: "abc", label: "Insta360 Link 2 Pro (2e1a:4c06)" },
      { deviceId: "def", label: "ctimmerm's iPhone Microphone" },
      { deviceId: "ghi", label: "insta360 link 2 pro (2e1a:4c06)" },
      { deviceId: "", label: "" },
    ]);
    expect(rows).toEqual([{ id: "", name: "System default" }, { id: "abc", name: "Insta360 Link 2 Pro" }, { id: "def", name: "ctimmerm's iPhone Microphone" }]);
  });
  it("an unlabelled device is numbered; the saved device is checked only while it is present", () => {
    expect(cleanMicLabel("", 2)).toBe("Microphone 3");
    const rows = micRows([{ deviceId: "x", label: "" }]);
    expect(rows[1]).toEqual({ id: "x", name: "Microphone 1" });
    expect(micChecked(rows, "x")).toBe("x");
    expect(micChecked(rows, "gone")).toBe("");
    expect(micChecked(rows, null)).toBe("");
  });
});
