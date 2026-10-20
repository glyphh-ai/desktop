/**
 * logger.ts — the SDK's diagnostic channel. **No telemetry by default**: unless the
 * host supplies a `sink`, the logger is a no-op — the SDK never phones home and
 * never writes to the console on its own. Every field is redacted before it reaches
 * the sink, so a token can't leak even by accident. `child()` stamps bindings.
 */

import { redact } from "./redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface LogEntry {
  level: LogLevel;
  msg: string;
  fields: LogFields;
}

/** Where log entries go. The host provides one to observe the SDK; default is none. */
export type LogSink = (entry: LogEntry) => void;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const noop: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
  child() {
    return noop;
  },
};

class SinkLogger implements Logger {
  constructor(
    private readonly sink: LogSink,
    private readonly min: number,
    private readonly bindings: LogFields,
  ) {}
  private emit(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVELS[level] < this.min) return;
    // A diagnostic failure must never surface as a request failure.
    try {
      this.sink({ level, msg, fields: redact({ ...this.bindings, ...(fields ?? {}) }) as LogFields });
    } catch {
      /* swallow */
    }
  }
  debug(msg: string, fields?: LogFields): void { this.emit("debug", msg, fields); }
  info(msg: string, fields?: LogFields): void { this.emit("info", msg, fields); }
  warn(msg: string, fields?: LogFields): void { this.emit("warn", msg, fields); }
  error(msg: string, fields?: LogFields): void { this.emit("error", msg, fields); }
  child(bindings: LogFields): Logger {
    return new SinkLogger(this.sink, this.min, { ...this.bindings, ...bindings });
  }
}

export interface LoggerOptions {
  sink?: LogSink;
  level?: LogLevel;
}

/** A logger that forwards (redacted) to `sink`, or a silent no-op if none is given. */
export function createLogger(opts: LoggerOptions = {}): Logger {
  if (!opts.sink) return noop;
  return new SinkLogger(opts.sink, LEVELS[opts.level ?? "info"], {});
}
