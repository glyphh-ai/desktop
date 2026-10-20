/**
 * Logger + redaction unit tests. Proves the no-telemetry default and that secrets
 * never reach a sink.
 */

import { describe, it, expect, vi } from "vitest";
import { createLogger, type LogEntry } from "../../src/core/logger.js";
import { redact } from "../../src/core/redact.js";

describe("createLogger", () => {
  it("is a silent no-op when no sink is given (no telemetry by default)", () => {
    const log = createLogger();
    expect(() => log.info("hi", { a: 1 })).not.toThrow();
  });

  it("forwards entries to a sink, redacting sensitive fields", () => {
    const entries: LogEntry[] = [];
    const log = createLogger({ sink: (e) => entries.push(e), level: "debug" });
    log.info("auth", { accessToken: "gy_at_supersecretvalue", user: "alice" });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.fields.user).toBe("alice");
    expect(String(entries[0]!.fields.accessToken)).toContain("[redacted]");
  });

  it("respects the level threshold", () => {
    const sink = vi.fn();
    const log = createLogger({ sink, level: "warn" });
    log.debug("x");
    log.info("y");
    log.warn("z");
    expect(sink).toHaveBeenCalledOnce();
  });

  it("child() merges bindings", () => {
    const entries: LogEntry[] = [];
    const log = createLogger({ sink: (e) => entries.push(e) }).child({ scope: "auth" });
    log.info("event");
    expect(entries[0]!.fields.scope).toBe("auth");
  });

  it("a throwing sink never propagates to the caller", () => {
    const log = createLogger({ sink: () => { throw new Error("sink boom"); } });
    expect(() => log.error("x")).not.toThrow();
  });
});

describe("redact", () => {
  it("masks secret-looking values by key and by shape", () => {
    const out = redact({ token: "abcdefgh", note: "gy_rt_abcdefghij", ok: "plain" }) as Record<string, unknown>;
    expect(String(out.token)).toContain("[redacted]"); // masked by sensitive key
    expect(String(out.note)).toContain("[redacted]"); // masked by value shape
    expect(out.ok).toBe("plain");
  });
});
