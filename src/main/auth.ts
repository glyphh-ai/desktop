/**
 * Auth — LOCAL ONLY. There is no Glyphh server: this machine has one fixed
 * user, always signed in, scoped to ~/.glyphh/users/local. No device flow, no
 * session tokens, no account or org polling.
 *
 * The exports keep the shapes the app's UI and IPC were built around, so the
 * shell, the boot gate and the settings pages read a signed-in, active local
 * account without knowing a server ever existed.
 */

import os from "os";
import { setActiveUser } from "./user-scope.js";
import { loadPreferences } from "./stores/preferences-db.js";
import { LOCAL_USER_ID } from "./app-paths.js";
import { setUserZone } from "./user-zone.js";

/** The one user on this machine. Scopes local state; never authorization. */
export { LOCAL_USER_ID };

// ── Types (shapes the app's UI/IPC were built around) ────────

export interface AccountInfo {
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  isPlatformAdmin: boolean;
  orgName: string;
  orgSlug: string;
  tier: string;
  billingStatus: string;
  avatarUrl: string;
  impersonatingOrgId: string | null;
}

export interface HeartbeatResult {
  status: "active" | "disabled";
  tier: string;
  billingStatus: string;
  entitlements: Record<string, unknown>;
  org: { id: string; name: string; maxSeats: number } | null;
  user: { id: string; email: string; firstName: string | null; lastName: string | null; role: string };
}

/** What the old device flow showed the user; kept for the renderer's types. */
export interface DevicePrompt {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

function localName(): string {
  try { return os.userInfo().username; } catch { return "you"; }
}

const account: AccountInfo = {
  email: "",
  firstName: localName(),
  lastName: "",
  role: "owner",
  isPlatformAdmin: false,
  orgName: "",
  orgSlug: "",
  tier: "local",
  billingStatus: "",
  avatarUrl: "",
  impersonatingOrgId: null,
};

const heartbeat: HeartbeatResult = {
  status: "active",
  tier: account.tier,
  billingStatus: "",
  entitlements: {},
  org: null,
  user: { id: LOCAL_USER_ID, email: "", firstName: account.firstName, lastName: null, role: account.role },
};

// ── Public API ───────────────────────────────────────────────

export function setReauthHandler(_fn: () => void): void { /* never re-auths */ }

export function isAuthenticated(): boolean { return true; }

/** No bearer: nothing here talks to a Glyphh server. */
export function getAuthToken(): string | null { return null; }

export async function ensureFreshToken(): Promise<void> { /* no token */ }

export async function forceTokenRefresh(): Promise<boolean> { return false; }

/** Scope local state to the local user — synchronous, before the local DB opens. */
export function restoreUserScopeFromSidecar(): void {
  setActiveUser(LOCAL_USER_ID);
}

export async function initAuth(): Promise<void> {
  setActiveUser(LOCAL_USER_ID);
  // Every schedule runs on this machine's own clock.
  setUserZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  await loadPreferences();
}

export function setOrgChangeObserver(_cb: (() => void) | null): void { /* no org */ }

export function cleanupAuthTimers(): void { /* no timers */ }

/** Signing out of a local-only app has nothing to end. */
export function logout(): void { /* the local user stays */ }

export function getAccountInfo(): AccountInfo | null { return account; }

export function getHeartbeatInfo(): HeartbeatResult | null { return heartbeat; }

export function hasMcpAccess(): boolean { return true; }

export function getAuthStatus(): {
  authenticated: boolean;
  status: "active" | "disabled" | "unauthenticated";
  tier?: string;
} {
  return { authenticated: true, status: "active", tier: account.tier };
}

export function cancelDeviceLogin(): void { /* no device flow */ }

export async function startDeviceLogin(
  _onPrompt?: (prompt: DevicePrompt) => void,
): Promise<{ ok: boolean; error?: string }> {
  return { ok: true };
}

export async function startAuthFlow(
  _mode: "register" | "login" = "login",
  _onPrompt?: (prompt: DevicePrompt) => void,
): Promise<boolean> {
  return true;
}

export function onServerReconnect(_fn: () => void): void { /* never offline */ }

export async function refreshHeartbeat(): Promise<HeartbeatResult | null> { return heartbeat; }

export function setHeartbeatObserver(_cb: ((result: HeartbeatResult) => void) | null): void { /* never changes */ }
