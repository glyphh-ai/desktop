/**
 * auth-client.ts — the typed sign-in surface every client renders on top of. Each
 * method calls the control plane, adopts the returned opaque session into the
 * refresh manager, and returns the stored session. All four methods converge to
 * one session type, so the UI differs only in which button was tapped.
 */

import type { HttpClient } from "../core/http.js";
import type { AuthedHttp } from "../core/authed-http.js";
import type { RefreshManager } from "./refresh-manager.js";
import { AuthError } from "../core/errors.js";
import type {
  AppleName,
  DeviceAuthStart,
  DeviceLoginOptions,
  DevicePoll,
  IssuedSession,
  MagicLinkStart,
  OrgSsoParams,
  OrgSsoStart,
  StoredSession,
} from "../contract/auth.js";

/** A client-side device-login failure (the caller must re-authenticate). */
function deviceFail(message: string): AuthError {
  return new AuthError({ code: "E_DEVICE_LOGIN", message, httpStatus: 401 });
}

/** Sleep `ms`, rejecting early if the caller aborts. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(deviceFail("device login cancelled"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(deviceFail("device login cancelled"));
      },
      { once: true },
    );
  });
}

export class AuthClient {
  constructor(
    private readonly http: HttpClient,
    private readonly refresh: RefreshManager,
    /** Authenticated transport — only the device-APPROVE leg needs it (it is performed
     *  by the already-signed-in user, unlike start/poll which are unauthenticated). */
    private readonly authed?: AuthedHttp,
  ) {}

  async #adopt(issued: IssuedSession): Promise<StoredSession> {
    return this.refresh.adopt(issued);
  }

  // ── email magic link (passwordless) ─────────────────────────────────────────
  startEmailLink(email: string, opts: { redirectUri?: string; machineId?: string } = {}): Promise<MagicLinkStart> {
    return this.http.post<MagicLinkStart>("/api/auth/magic/start", { email, ...opts });
  }
  async verifyEmailLink(token: string, machineId?: string, opts: { runtimeImage?: string } = {}): Promise<StoredSession> {
    // `runtimeImage` is the REGISTRATION-time SKU choice (§7b) — honoured only when
    // this verify creates the account; the server falls back to free on any problem.
    const issued = await this.http.post<IssuedSession>("/api/auth/magic/verify", {
      token,
      ...(machineId ? { machineId } : {}),
      ...(opts.runtimeImage ? { runtimeImage: opts.runtimeImage } : {}),
    });
    return this.#adopt(issued);
  }

  // ── native social ───────────────────────────────────────────────────────────
  async google(idToken: string, machineId?: string): Promise<StoredSession> {
    const issued = await this.http.post<IssuedSession>("/api/auth/google", { idToken, ...(machineId ? { machineId } : {}) });
    return this.#adopt(issued);
  }
  async apple(identityToken: string, opts: { fullName?: AppleName; machineId?: string } = {}): Promise<StoredSession> {
    const issued = await this.http.post<IssuedSession>("/api/auth/apple", { identityToken, ...opts });
    return this.#adopt(issued);
  }

  // ── device authorization grant (headless CLI/TUI sign-in) ───────────────────
  /**
   * Sign in without a browser redirect back to this process: start a device grant,
   * hand the user a short code + URL via `onPrompt`, then poll until they approve it
   * in a browser. Resolves to the adopted session; rejects if denied/expired/cancelled.
   */
  async deviceLogin(opts: DeviceLoginOptions): Promise<StoredSession> {
    const start = await this.http.post<DeviceAuthStart>(
      "/api/auth/device/start",
      opts.machineId ? { machineId: opts.machineId } : {},
    );
    // Guard against a server that answers with a different (or empty) shape — e.g.
    // an older deployment — so the failure is legible instead of "reading 'userCode'".
    if (!start || typeof start.userCode !== "string") {
      throw deviceFail("this server does not support device login");
    }
    opts.onPrompt({
      userCode: start.userCode,
      verificationUri: start.verificationUri,
      verificationUriComplete: start.verificationUriComplete,
      expiresIn: start.expiresIn,
    });

    let intervalMs = Math.max(1, start.interval) * 1000;
    const deadline = Date.now() + start.expiresIn * 1000;
    while (Date.now() < deadline) {
      await delay(intervalMs, opts.signal);
      const poll = await this.http.post<DevicePoll>("/api/auth/device/token", { deviceCode: start.deviceCode });
      switch (poll.status) {
        case "approved":
          if (poll.session) return this.#adopt(poll.session);
          break;
        case "denied":
          throw deviceFail("device login was denied");
        case "expired":
          throw deviceFail("device login expired — start again");
        case "slow_down":
          intervalMs += 2000;
          break;
        case "pending":
          break;
      }
    }
    throw deviceFail("device login timed out");
  }

  /**
   * Approve a pending device code AS THE SIGNED-IN USER — the browser half of the
   * grant, for a surface the user is already authenticated on (the platform's device
   * page). A CLI/TUI blocked in `deviceLogin`'s poll completes once this lands. The
   * server also renders a standalone `/device` form for users who aren't signed in.
   */
  approveDevice(userCode: string): Promise<{ ok: boolean }> {
    if (!this.authed) throw deviceFail("device approval requires an authenticated client");
    return this.authed.post<{ ok: boolean }>("/api/auth/device/approve", { userCode });
  }

  // ── organization OAuth/SSO (WorkOS, browser handoff) ────────────────────────
  /** Returns the WorkOS authorization URL to open in a system browser. */
  startOrgSso(params: OrgSsoParams): Promise<OrgSsoStart> {
    return this.http.post<OrgSsoStart>("/api/auth/org/start", params);
  }
  /** Trade the one-time code (from the app's deep-link callback) for a session. */
  async exchange(code: string, machineId?: string): Promise<StoredSession> {
    const issued = await this.http.post<IssuedSession>("/api/auth/exchange", { code, ...(machineId ? { machineId } : {}) });
    return this.#adopt(issued);
  }

  // ── session ─────────────────────────────────────────────────────────────────
  signOut(): Promise<void> {
    return this.refresh.signOut();
  }
  /** Revoke every device's session for this user (global sign-out). */
  signOutEverywhere(): Promise<void> {
    return this.refresh.signOutEverywhere();
  }
}
