/**
 * redact.ts — mask secrets before anything reaches a log sink. Even if a caller
 * logs a token or an auth header by accident, it is masked. Depth/size capped so a
 * hostile payload can't turn logging into a DoS.
 */

const SENSITIVE_KEY = /(pass(word)?|secret|token|authorization|auth|api[-_]?key|cookie|bearer|refresh|access|credential)/i;
const SENSITIVE_VALUE = /^(gy_[a-z]{2}_[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{10,}\.)/;
const MAX_DEPTH = 5;
const MAX_KEYS = 64;

function mask(value: string): string {
  return value.length <= 4 ? "***" : `${value.slice(0, 2)}…[redacted]`;
}

export function redact(input: unknown, depth = 0): unknown {
  if (input == null) return input;
  if (typeof input === "string") return SENSITIVE_VALUE.test(input) ? mask(input) : input;
  if (typeof input === "number" || typeof input === "boolean") return input;
  if (input instanceof Error) return { name: input.name, message: input.message };
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(input)) return input.slice(0, MAX_KEYS).map((v) => redact(v, depth + 1));
  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (n++ >= MAX_KEYS) {
        out["…"] = "[truncated]";
        break;
      }
      out[k] = SENSITIVE_KEY.test(k) ? (typeof v === "string" ? mask(v) : "[redacted]") : redact(v, depth + 1);
    }
    return out;
  }
  return String(input);
}
