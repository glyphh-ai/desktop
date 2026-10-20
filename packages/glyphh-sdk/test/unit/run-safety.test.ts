/**
 * run-safety.test.ts — a failed run must never crash the host. When a stream fails it
 * rejects BOTH `events` and `done`; a consumer that only iterates events (and catches
 * there) must not leave `done`'s rejection unhandled. Regression guard for the TUI crash
 * "stream closed before the run opened" taking down the whole process.
 */

import { describe, it, expect } from "vitest";
import { Run } from "../../src/transport/run.js";

describe("Run terminal-promise safety", () => {
  it("a fail() consumed only via events does not unhandled-reject done", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (e: unknown) => seen.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const run = new Run();
      run.fail(new Error("stream closed before the run opened"));
      // Consume ONLY the event iterator (as a naive consumer would), and catch there.
      await (async () => {
        try {
          for await (const _ev of run.events) {
            void _ev;
          }
        } catch {
          /* expected — the stream failed */
        }
      })();
      // Give Node a couple of ticks to surface any unhandled rejection.
      await new Promise((r) => setTimeout(r, 20));
      expect(seen).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a real awaiter of done still receives the failure", async () => {
    const run = new Run();
    run.fail(new Error("boom"));
    await expect(run.done).rejects.toThrow("boom");
  });
});
