/**
 * refresh-manager.ts — the session lifecycle logic that every client used to
 * hand-roll, centralized once:
 *   - proactive refresh within a margin of expiry,
 *   - single-flight refresh (concurrent callers share one in-flight request),
 *   - single-use rotation (always persist the newly returned refresh handle),
 *   - a `signedOut` signal when refresh is unrecoverable (reuse/revoked/expired),
 *   - 401-driven refresh for the credential provider's retry-once path.
 * It never logs token values.
 */

import type { HttpClient } from "../core/http.js";
import { AuthError } from "../core/errors.js";
import { createLogger, type Logger } from "../core/logger.js";
import type { IssuedSession, StoredSession } from "../contract/auth.js";
import type { TokenStore } from "./token-store.js";

export interface RefreshOptions {
  /** Refresh this many ms before expiry. Default 60s. */
  refreshMarginMs?: number;
  /** Called once when the session becomes unrecoverable; host flips UI to signed-out. */
  onSignedOut?: () => void;
  /** Optional observability sink (redacted). Silent by default. */
  logger?: Logger;
}

function toStored(issued: IssuedSession, now: number): StoredSession {
  return { accessToken: issued.accessToken, refreshToken: issued.refreshToken, expiresAt: now + issued.expiresIn * 1000 };
}

export class RefreshManager {
  private inFlight: Promise<StoredSession | null> | null = null;
  /** Bumped on sign-out: a refresh that started before the bump must NOT save
   *  its rotated session back (that resurrection made logout take two tries). */
  private gen = 0;
  private readonly marginMs: number;
  private readonly onSignedOut: (() => void) | undefined;
  private readonly log: Logger;

  constructor(
    private readonly http: HttpClient,
    private readonly store: TokenStore,
    opts: RefreshOptions = {},
    private readonly now: () => number = Date.now,
  ) {
    this.marginMs = opts.refreshMarginMs ?? 60_000;
    this.onSignedOut = opts.onSignedOut;
    this.log = opts.logger ?? createLogger();
  }

  /** Persist a freshly issued session (after any login). */
  async adopt(issued: IssuedSession): Promise<StoredSession> {
    const stored = toStored(issued, this.now());
    await this.store.save(stored);
    return stored;
  }

  /** A valid access token, refreshing proactively if near expiry. Null if signed out. */
  async accessToken(): Promise<string | null> {
    const session = await this.store.load();
    if (!session) return null;
    if (session.expiresAt - this.now() > this.marginMs) return session.accessToken;
    const refreshed = await this.refresh();
    return refreshed?.accessToken ?? null;
  }

  /** Force a refresh (single-flight). Returns the new session, or null if unrecoverable. */
  refresh(): Promise<StoredSession | null> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doRefresh(): Promise<StoredSession | null> {
    const gen = this.gen;
    const session = await this.store.load();
    if (!session) return null;
    try {
      const issued = await this.http.post<IssuedSession>("/api/session/refresh", { refreshToken: session.refreshToken });
      this.log.debug("session refreshed");
      // Signed out while this refresh was in flight — discard, never resurrect.
      if (gen !== this.gen) return null;
      return await this.adopt(issued);
    } catch (e) {
      // A 401 means the refresh is dead (rotated/reused/revoked/expired) → sign out.
      if (e instanceof AuthError) {
        this.log.info("session signed out (refresh unrecoverable)");
        await this.signalSignedOut();
        return null;
      }
      this.log.warn("session refresh failed (transient)");
      throw e; // transient (network/5xx) — let the caller decide to retry
    }
  }

  /** Called by the credential provider on a 401 from a protected call. */
  async onUnauthorized(): Promise<string | null> {
    const refreshed = await this.refresh();
    return refreshed?.accessToken ?? null;
  }

  private async signalSignedOut(): Promise<void> {
    await this.store.clear();
    this.onSignedOut?.();
  }

  /** Sign out THIS device: best-effort server logout of the caller's own session
   *  family only (never other devices' logins), then local clear. */
  async signOut(): Promise<void> {
    await this.#signOutVia("/api/session/logout");
  }

  /** Sign out EVERYWHERE: revoke every session for the user, then local clear. */
  async signOutEverywhere(): Promise<void> {
    await this.#signOutVia("/api/session/revoke");
  }

  async #signOutVia(path: string): Promise<void> {
    // LOCAL FIRST. The old order (network revoke, THEN clear) raced the
    // background auto-refresh: a rotation mid-logout made the revoke's bearer
    // stale (family never revoked server-side) and/or the in-flight refresh
    // saved the rotated session back AFTER the clear — logout resurrected, the
    // next device flow silently re-entered the old account. Bump the
    // generation so no in-flight refresh may save, clear, then revoke
    // best-effort with the pre-read token.
    const session = await this.store.load();
    this.gen++;
    this.inFlight = null;
    await this.store.clear();
    try {
      if (session) await this.http.post(path, undefined, { bearer: session.accessToken });
    } catch {
      /* revoke is best-effort; the local clear is what signs the device out */
    }
  }
}
