/**
 * artifact-rules.test.ts — THE ARTIFACTS PANEL'S RULES (his order, 2026-10-05:
 * an Artifacts work panel with Comments; the comments draw a region and
 * "Send to Glyphh" hands it to the agent). Local only since 2026-10-18: one
 * list, no sharing.
 * src/renderer/help/artifact-rules.ts is pure; this pins every answer.
 */
import { describe, it, expect } from "vitest";
import {
  artifactKind, artifactRender, searchArtifacts, sortNewest, groupByMonth, monthLabel, editedLabel,
  regionFromDrag, regionToRect, regionIsReal, MIN_REGION_PX, pinPoint, regionLabel,
  editPrompt, startChatLine, artifactStandingLine, threadText, commentAge, initialOf, orderThreads, pinNumbers,
  type ArtifactMeta, type ArtifactComment,
} from "../../src/renderer/help/artifact-rules.js";

const NOW = Date.parse("2026-10-05T12:00:00Z");
const row = (o: Partial<ArtifactMeta> & { id: string }): ArtifactMeta => ({
  name: `${o.id}.html`, mime: "text/html", sizeBytes: 10,
  createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", ...o,
});
const mascots = row({ id: "a1", name: "New-session mascots", updatedAt: "2026-08-10T10:00:00Z" });
const mobile = row({ id: "a2", name: "Glyphh Mobile — Architecture", updatedAt: "2026-08-07T10:00:00Z" });
const ada = row({ id: "a3", name: "Glyphh Ada", mime: "image/png", updatedAt: "2026-06-18T10:00:00Z" });
const notes = row({ id: "a4", name: "notes.md", mime: "text/markdown", updatedAt: "2025-12-02T10:00:00Z" });

describe("what an artifact is, and how it paints", () => {
  it("a page / code → code; markdown, text, pdf → doc; an image → image; the rest → file", () => {
    expect(artifactKind(mascots)).toBe("code");
    expect(artifactKind({ mime: "application/json", name: "x.json" })).toBe("code");
    expect(artifactKind({ mime: "text/plain", name: "x.py" })).toBe("code");
    expect(artifactKind(notes)).toBe("doc");
    expect(artifactKind({ mime: "application/pdf", name: "x.pdf" })).toBe("doc");
    expect(artifactKind(ada)).toBe("image");
    expect(artifactKind({ mime: "application/zip", name: "x.zip" })).toBe("file");
    expect(artifactKind({ mime: "", name: "x.ts" })).toBe("code");
  });
  it("HTML, SVG and PDF run in the sandboxed frame; images as <img>; text and markdown as text; the rest download", () => {
    expect(artifactRender(mascots)).toBe("frame");
    expect(artifactRender({ mime: "image/svg+xml", name: "d.svg" })).toBe("frame");
    expect(artifactRender({ mime: "application/pdf", name: "d.pdf" })).toBe("frame");
    expect(artifactRender(ada)).toBe("image");
    expect(artifactRender(notes)).toBe("text");
    expect(artifactRender({ mime: "text/plain", name: "a.txt" })).toBe("text");
    expect(artifactRender({ mime: "application/octet-stream", name: "a.bin" })).toBe("download");
  });
});

describe("the search box", () => {
  const all = [mascots, mobile, ada, notes];
  it("every word must hit — name, type; case-insensitive", () => {
    expect(searchArtifacts(all, "glyphh").map((a) => a.id)).toEqual(["a2", "a3"]);
    expect(searchArtifacts(all, "glyphh ada").map((a) => a.id)).toEqual(["a3"]);
    expect(searchArtifacts(all, "IMAGE").map((a) => a.id)).toEqual(["a3"]);
    expect(searchArtifacts(all, "  ")).toHaveLength(4);
    expect(searchArtifacts(all, "nothing-here")).toEqual([]);
  });
});

describe("newest first, grouped by month (the screenshot's August / June heads)", () => {
  it("sorts by the last edit", () => {
    expect(sortNewest([notes, ada, mobile, mascots]).map((a) => a.id)).toEqual(["a1", "a2", "a3", "a4"]);
  });
  it("groups by month; this year bare, another year with it", () => {
    const g = groupByMonth([notes, ada, mobile, mascots], NOW);
    expect(g.map((x) => x.label)).toEqual(["August", "June", "December 2025"]);
    expect(g[0].items.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(monthLabel(0, NOW)).toBe("Undated");
  });
  it("'Edited Aug 10' on the row; the year when it is not this one", () => {
    expect(editedLabel(mascots, NOW)).toBe("Edited Aug 10");
    expect(editedLabel(notes, NOW)).toBe("Edited Dec 2, 2025");
    expect(editedLabel({ updatedAt: "", createdAt: "" }, NOW)).toBe("Edited —");
  });
});

describe("the drawn region — fractions of the frame", () => {
  it("any corner first, clamped, four decimals", () => {
    expect(regionFromDrag(100, 50, 300, 150, 1000, 500)).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    expect(regionFromDrag(300, 150, 100, 50, 1000, 500)).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    expect(regionFromDrag(-20, -20, 1200, 600, 1000, 500)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(regionFromDrag(0, 0, 10, 10, 0, 0)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
  it("back to pixels for the frame's current size — survives a resize", () => {
    const r = regionFromDrag(100, 50, 300, 150, 1000, 500);
    expect(regionToRect(r, 500, 250)).toEqual({ left: 50, top: 25, width: 100, height: 50 });
  });
  it("a tiny drag is a click, not a region", () => {
    expect(MIN_REGION_PX).toBe(6);
    expect(regionIsReal({ x: 0, y: 0, w: 0.004, h: 0.1 }, 1000, 500)).toBe(false);
    expect(regionIsReal({ x: 0, y: 0, w: 0.01, h: 0.02 }, 1000, 500)).toBe(true);
  });
  it("the pin sits on the region's right edge, centred; no region → top-left", () => {
    expect(pinPoint({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 })).toEqual({ x: 0.3, y: 0.2 });
    expect(pinPoint({ x: 0.9, y: 0.5, w: 0.2, h: 0.2 })).toEqual({ x: 1, y: 0.6 });
    expect(pinPoint(null)).toEqual({ x: 0, y: 0 });
  });
  it("the region names itself in percent", () => {
    expect(regionLabel({ x: 0.123, y: 0.3, w: 0.4, h: 0.1 })).toBe("12%,30%,40%,10%");
    expect(regionLabel(null)).toBe("");
  });
});

describe("the messages the panel sends the agent", () => {
  it("'Send to Glyphh': the artifact, the area and the thread as one edit request — the id never shows (his order, 2026-10-05)", () => {
    expect(editPrompt(mascots, { x: 0.12, y: 0.3, w: 0.4, h: 0.1 }, "make the eye bigger"))
      .toBe("Edit the artifact New-session mascots: in the selected area (12%,30%,40%,10%): make the eye bigger");
    expect(editPrompt(mascots, null, "retitle it")).toBe("Edit the artifact New-session mascots: retitle it");
    expect(editPrompt(mascots, null, "retitle it", ["and bold", " ", "and blue"]))
      .toBe("Edit the artifact New-session mascots: retitle it\n- and bold\n- and blue");
    expect(editPrompt(mascots, null, "x")).not.toContain("a1");
  });
  it("'Start chat': the first context line of the session, without the id", () => {
    expect(startChatLine(mascots)).toBe("Working from the artifact New-session mascots");
  });
  it("the id rides as a hidden standing line; none without an artifact", () => {
    expect(artifactStandingLine(mascots)).toContain("artifact id a1");
    expect(artifactStandingLine(mascots)).toContain("New-session mascots");
    expect(artifactStandingLine(null)).toBe("");
    expect(artifactStandingLine({ id: "", name: "x" })).toBe("");
  });
  it("the thread's text: the opening line and the replies, blanks dropped", () => {
    expect(threadText({ text: "a", replies: [{ text: " " } as ArtifactComment, { text: "b" } as ArtifactComment] })).toEqual(["a", "b"]);
  });
});

describe("the thread popover's stamps and order", () => {
  const c = (id: string, at: string, resolved = false): ArtifactComment => ({ id, author: { id: "u1", name: "Chris" }, region: null, text: id, resolved, createdAt: at, replies: [] });
  it("now / 3m / 2h / 4d / a date", () => {
    expect(commentAge(new Date(NOW - 10e3).toISOString(), NOW)).toBe("now");
    expect(commentAge(new Date(NOW - 3 * 60e3).toISOString(), NOW)).toBe("3m");
    expect(commentAge(new Date(NOW - 2 * 3600e3).toISOString(), NOW)).toBe("2h");
    expect(commentAge(new Date(NOW - 4 * 86400e3).toISOString(), NOW)).toBe("4d");
    expect(commentAge(new Date(NOW - 40 * 86400e3).toISOString(), NOW)).toMatch(/\d/);
    expect(commentAge("", NOW)).toBe("");
  });
  it("the avatar fallback is an initial", () => {
    expect(initialOf("chris")).toBe("C");
    expect(initialOf("  ")).toBe("?");
  });
  it("open threads first by time, resolved after; pins number the open ones in that order", () => {
    const list = [c("late", "2026-10-05T11:00:00Z"), c("done", "2026-10-05T09:00:00Z", true), c("early", "2026-10-05T10:00:00Z")];
    expect(orderThreads(list).map((x) => x.id)).toEqual(["early", "late", "done"]);
    const n = pinNumbers(list);
    expect(n.get("early")).toBe(1);
    expect(n.get("late")).toBe(2);
    expect(n.get("done")).toBe(3);
  });
});
