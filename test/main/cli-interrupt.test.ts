/**
 * A stop is not a failure: the CLI's own words for an interrupt are told apart
 * from a real error, so stopping a turn never paints an error card.
 */
import { describe, it, expect } from "vitest";
import { isInterrupted, INTERRUPT_SAID } from "../../src/main/cli-interrupt.js";

describe("cli-interrupt", () => {
  it("knows the CLI's own words for a user stop", () => {
    for (const result of [
      "Interrupted by user",
      "Request interrupted by user",
      "the operation was cancelled",
      "aborted by the user",
      "Process terminated: SIGINT",
    ]) expect(isInterrupted({ is_error: true, result }), result).toBe(true);
  });

  it("reads an interrupt subtype whatever the text says", () => {
    expect(isInterrupted({ is_error: true, subtype: "interrupted", result: "" })).toBe(true);
    expect(isInterrupted({ is_error: true, subtype: "aborted" })).toBe(true);
  });

  // The whole point: a REAL failure must still reach the user.
  it("leaves a genuine failure alone", () => {
    for (const result of [
      "the run failed",
      "Error: ENOENT: no such file or directory",
      "Failed to authenticate: OAuth session expired",
      "the program exports no run(ctx, input) function",
    ]) expect(isInterrupted({ is_error: true, result }), result).toBe(false);
  });

  it("is never true for a frame that is not an error at all", () => {
    expect(isInterrupted({ is_error: false, result: "interrupted by user" })).toBe(false);
    expect(isInterrupted({})).toBe(false);
  });

  it("matches a SIGTERM'd stderr tail, which is how our own kill reads", () => {
    expect(INTERRUPT_SAID.test("claude: terminated by SIGTERM")).toBe(true);
    expect(INTERRUPT_SAID.test("claude exited 1")).toBe(false);
  });
});
