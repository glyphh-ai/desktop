/**
 * errors.ts — the SDK error hierarchy. Two layers, both typed:
 *   ConnectError  — never reached the server (network / timeout / abort).
 *   ApiError      — the server returned a typed error envelope; carries the control
 *                   plane's taxonomy code + remediation so callers branch on a
 *                   stable code without depending on the server package.
 *     AuthError       — 401; the caller must (re)authenticate.
 *     ForbiddenError  — 403; authenticated but not permitted (authz is server-side).
 *     ValidationError — 400; bad request shape.
 *     NotFoundError   — 404; the addressed resource does not exist (or is tombstoned).
 * Transport/protocol errors (ProtocolError, UnsupportedError) join when the rotor
 * streaming layer lands.
 */

export class SdkError extends Error {
  readonly code: string;
  override readonly cause?: unknown;
  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.cause = cause;
  }
}

/** The request never got a response (offline, DNS, TLS, timeout, aborted). */
export class ConnectError extends SdkError {
  constructor(message: string, cause?: unknown) {
    super("E_CONNECT", message, cause);
  }
}

/** The server responded with a typed error envelope. */
export class ApiError extends SdkError {
  readonly httpStatus: number;
  readonly remediation: string | undefined;
  readonly requestId: string | undefined;
  readonly retryable: boolean;
  constructor(opts: { code: string; message: string; httpStatus: number; remediation?: string; requestId?: string; retryable?: boolean }) {
    super(opts.code, opts.message);
    this.httpStatus = opts.httpStatus;
    this.remediation = opts.remediation;
    this.requestId = opts.requestId;
    this.retryable = opts.retryable ?? false;
  }
}

export class AuthError extends ApiError {}
export class ForbiddenError extends AuthError {}
export class ValidationError extends ApiError {}
export class NotFoundError extends ApiError {}

/** The wire protocol version mismatched, or a frame was malformed — do not guess. */
export class ProtocolError extends SdkError {
  constructor(message: string, cause?: unknown) {
    super("E_PROTOCOL", message, cause);
  }
}

/** A capability the runtime does not (yet) expose — e.g. attachments before the
 *  server ships them. The API shape is frozen; the call throws until it lands. */
export class UnsupportedError extends SdkError {
  constructor(message = "not supported by this runtime") {
    super("E_UNSUPPORTED", message);
  }
}

/**
 * The rotor runtime's error taxonomy codes, re-exported so a client can branch on a
 * run's error code WITHOUT importing the runtime package. Kept in sync with
 * rrotor's `errors.ts`.
 */
export const RUNTIME_ERROR_CODES = [
  "E_MISSING_INPUT", "E_TYPE", "E_SCHEMA", "E_UNKNOWN_STEP", "E_NO_HANDLER", "E_NO_TOOL",
  "E_POLICY_DENIED", "E_SCOPE_EXCEEDED", "E_BUDGET_EXCEEDED", "E_TIMEOUT", "E_UNGROUNDED",
  "E_SPACE_MISMATCH", "E_TRANSPORT", "E_TOOL", "E_STATOR", "E_UNTRANSLATABLE", "E_UNMERGEABLE",
  "E_REPLAY_DIVERGENCE", "E_HANDLER", "E_FAILED", "E_DEFAULT", "E_INTERNAL",
] as const;
export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODES)[number];

/** Build the most specific ApiError subclass for a server error envelope. */
export function apiErrorFor(opts: { code: string; message: string; httpStatus: number; remediation?: string; requestId?: string; retryable?: boolean }): ApiError {
  if (opts.httpStatus === 401) return new AuthError(opts);
  if (opts.httpStatus === 403) return new ForbiddenError(opts);
  if (opts.httpStatus === 400) return new ValidationError(opts);
  if (opts.httpStatus === 404) return new NotFoundError(opts);
  return new ApiError(opts);
}
