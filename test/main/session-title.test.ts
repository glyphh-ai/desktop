/**
 * ONE TITLE GRAMMAR for the rail's session rows. His report, 2026-09-25: "the
 * left rail session names are way too long and they don't match what claude or
 * codex show."
 *
 * (The chat ⇄ CLI-session binding cases that used to sit here went with the
 * bridge, 2026-09-28: the chat is the session, so there is nothing to bind.)
 */
import { describe, it, expect } from "vitest";
import { sessionDisplayTitle, SESS_TITLE_MAX } from "../../src/renderer/help/session-title";

describe("one title grammar for the merged rail", () => {
  it("cuts the 80-char native titles down to the list's own width", () => {
    const native = "a".repeat(80);
    const shown = sessionDisplayTitle(native);
    expect(shown.length).toBeLessThanOrEqual(SESS_TITLE_MAX);
    expect(shown.endsWith("…")).toBe(true);
  });

  it("leaves a short title exactly as it is", () => {
    expect(sessionDisplayTitle("fix the sync bug")).toBe("fix the sync bug");
  });

  it("collapses the newlines a pasted prompt carries in", () => {
    expect(sessionDisplayTitle("fix   the\n\nsync\tbug")).toBe("fix the sync bug");
  });

  it("never renders an empty row", () => {
    expect(sessionDisplayTitle("")).toBe("Session");
    expect(sessionDisplayTitle("   ")).toBe("Session");
    expect(sessionDisplayTitle(undefined)).toBe("Session");
  });

  it("does not leave a dangling space before the ellipsis", () => {
    expect(sessionDisplayTitle(`${"b".repeat(SESS_TITLE_MAX - 1)} tail`)).not.toContain(" …");
  });
});
