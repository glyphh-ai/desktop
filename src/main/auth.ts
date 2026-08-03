/**
 * Auth — the desktop face of @glyphh/sdk.
 *
 * Sign-in is the SDK device flow: we start a device grant, open the user's
 * browser on the platform to approve it, and poll until the session lands.
 * The SDK owns the whole token lifecycle (storage, single-flight refresh,
 * rotation, sign-out) — this module only mirrors the bits the app needs
 * synchronously (signed-in state, a current bearer for legacy call sites)
 * and composes the account/heartbeat views the UI was built around.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { shell } from "electron";
import type { DevicePrompt } from "@glyphh/sdk";
import { GLYPHH_DIR } from "./app-paths.js";
import { setActiveUser } from "./user-scope.js";
import { getClient, resetClient, setSignedOutHandler, readSessionFileSync, SERVER_URL, SESSION_FILE, PLATFORM_URL as PLATFORM } from "./glyphh-client.js";

export const AUTH_SERVER = SERVER_URL;
export const PLATFORM_URL = PLATFORM;

const ACCOUNT_POLL_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours (the old heartbeat cadence)
// New-server session tokens are opaque (no JWT sub to decode), so the last
// authenticated identity is mirrored to a sidecar file for OFFLINE boot: it
// only scopes local per-user state, never authorization.
const IDENTITY_FILE = path.join(GLYPHH_DIR, ".identity");

// ── Types (shapes the app's UI/IPC were built around) ────────

export interface AccountInfo {
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  orgName: string;
  orgSlug: string;
  tier: string;
  billingStatus: string;
}

export interface HeartbeatResult {
  status: "active" | "disabled";
  tier: string;
  billingStatus: string;
  entitlements: Record<string, unknown>;
  org: { id: string; name: string; maxSeats: number } | null;
  user: { id: string; email: string; firstName: string | null; lastName: string | null; role: string };
}

// ── State ────────────────────────────────────────────────────

let signedIn = false;
let cachedToken: { value: string; expiresAt: number } | null = null;
let cachedAccount: AccountInfo | null = null;
let cachedHeartbeat: HeartbeatResult | null = null;
let heartbeatObserver: ((result: HeartbeatResult) => void) | null = null;
let accountTimer: ReturnType<typeof setInterval> | null = null;

// ── Re-auth gate ─────────────────────────────────────────────
// Fired when the SDK gives up on the session (refresh rejected) so the UI can
// surface the login screen instead of silently degrading. Debounced so a burst
// of failing calls only pops one prompt.
let reauthHandler: (() => void) | null = null;
let lastReauthAt = 0;

/** Register the callback that surfaces the login gate (set by main.ts). */
export function setReauthHandler(fn: () => void): void { reauthHandler = fn; }

function triggerReauth(): void {
  const now = Date.now();
  if (now - lastReauthAt < 30_000) return;
  lastReauthAt = now;
  console.warn("[auth] session cannot be refreshed — prompting re-login");
  try { reauthHandler?.(); } catch { /* noop */ }
}

// Attach lifecycle, wired via lazy import so auth.ts carries no static dep on
// attach-client (which imports THIS module). Every sign-in/out path funnels
// through here, so the outbound socket tracks auth exactly.
function attachStart(): void { void import("./attach-client.js").then((m) => m.startAttach()).catch(() => {}); }
function attachStop(): void { void import("./attach-client.js").then((m) => m.stopAttach()).catch(() => {}); }

setSignedOutHandler(() => {
  signedIn = false;
  cachedToken = null;
  cachedAccount = null;
  cachedHeartbeat = null;
  setActiveUser(null);
  attachStop();
  triggerReauth();
});

// ── Identity sidecar (offline boot scoping) ──────────────────

function readIdentitySidecar(): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(IDENTITY_FILE, "utf-8")) as { userId?: string };
    return typeof parsed.userId === "string" && parsed.userId ? parsed.userId : null;
  } catch {
    return null;
  }
}

function writeIdentitySidecar(userId: string): void {
  try {
    fs.mkdirSync(path.dirname(IDENTITY_FILE), { recursive: true });
    fs.writeFileSync(IDENTITY_FILE, JSON.stringify({ userId }), { encoding: "utf-8", mode: 0o600 });
  } catch { /* scoping falls back to the next successful me() */ }
}

function clearIdentitySidecar(): void {
  try { fs.unlinkSync(IDENTITY_FILE); } catch { /* already gone */ }
}

// ── Public API ───────────────────────────────────────────────

/** Check if user is authenticated (has a live or refreshable session). */
export function isAuthenticated(): boolean {
  if (signedIn) return true;
  // Pre-initAuth callers (early boot): a persisted session counts — the SDK
  // refreshes it on first use; a failed refresh flips this false via onSignedOut.
  if (readSessionFileSync()) { signedIn = true; return true; }
  return false;
}

/** Get current access token, or null if not authenticated.
 *  Sync mirror for legacy call sites — prefer awaiting ensureFreshToken() first. */
export function getAuthToken(): string | null {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
  const session = readSessionFileSync();
  if (session && session.expiresAt > Date.now()) {
    cachedToken = { value: session.accessToken, expiresAt: session.expiresAt };
    return session.accessToken;
  }
  return null;
}

/**
 * Top up the sync token mirror. The SDK's token() refreshes as needed and
 * single-flights concurrent callers — cheap to call on every agent entry
 * point. Signed-out → no-op (mirror goes null).
 */
export async function ensureFreshToken(): Promise<void> {
  try {
    const value = await getClient().token();
    const session = await getClient().getSession();
    cachedToken = session ? { value, expiresAt: session.expiresAt } : { value, expiresAt: Date.now() + 60_000 };
    signedIn = true;
  } catch {
    cachedToken = null;
  }
}

/**
 * Force a refresh now, regardless of remaining life. Reactive path — call
 * after an API 401 to self-heal a token the server rejected. Resolves true
 * if a fresh token is in hand.
 */
export async function forceTokenRefresh(): Promise<boolean> {
  const ok = await getClient().refresh();
  if (ok) await ensureFreshToken();
  return ok;
}

/** Scope local state to the last signed-in account from the identity sidecar —
 *  SYNCHRONOUS and offline-safe, for boot to call BEFORE the local DB opens.
 *  Without this, boot-time reads (window bounds, prefs, layouts) hit the
 *  default-scope DB while post-auth writes land in the user's — nothing
 *  "persists" across restarts. initAuth's own scoping then no-ops. */
export function restoreUserScopeFromSidecar(): void {
  setActiveUser(readIdentitySidecar());
}

/** Initialize auth — restore session, scope local state, start the account poll. */
export async function initAuth(): Promise<void> {
  const session = await getClient().getSession();
  signedIn = !!session;
  if (session) {
    // Scope local state to the restored account BEFORE anything reads it —
    // offline-safe via the sidecar; corrected by the refresh below if stale.
    setActiveUser(readIdentitySidecar());
    // AWAITED on purpose: a locally-unexpired token can be DEAD server-side
    // (revoked family). The first account fetch 401s, the SDK's forced refresh
    // fails, onSignedOut flips `signedIn` — all BEFORE boot decides login vs
    // workspace, so a ghost "signed in with no data" boot cannot happen. A
    // plain network failure keeps the session (offline boot still works), and
    // main.ts races this whole init against a 3s cap so splash never hangs.
    await ensureFreshToken();
    await refreshAccountState().catch(() => null);
    if (signedIn) attachStart();
  }
  if (accountTimer) clearInterval(accountTimer);
  accountTimer = setInterval(() => {
    if (isAuthenticated()) void refreshAccountState();
  }, ACCOUNT_POLL_INTERVAL);
}

/** Clean up timers — call on app shutdown. */
export function cleanupAuthTimers(): void {
  if (accountTimer) { clearInterval(accountTimer); accountTimer = null; }
}

/** Log out — LOCAL-FIRST, then a best-effort server revoke.
 *
 *  The old order (SDK signOut = network revoke, THEN local clear) left the
 *  session file on disk for the whole revoke round-trip — and isAuthenticated()
 *  re-hydrates `signedIn` from that file on any check (window focus fires one
 *  immediately), so logout kept resurrecting and took two tries. Worse, quitting
 *  before the delete landed left a file whose token the revoke had ALREADY
 *  killed — the next boot opened "signed in" on a dead session.
 *
 *  Now: read the token, delete the file + drop the SDK client synchronously
 *  (nothing left to resurrect from), then fire the revoke in the background. */
export function logout(): void {
  const token = getAuthToken(); // read BEFORE clearing — the revoke needs it
  signedIn = false;
  cachedToken = null;
  cachedAccount = null;
  cachedHeartbeat = null;
  clearIdentitySidecar();
  setActiveUser(null);
  attachStop();
  try { fs.unlinkSync(SESSION_FILE); } catch { /* already gone */ }
  resetClient(); // the live instance still holds the old session in memory
  if (token) {
    // Per-device logout: revokes THIS session family only. Signing out of the
    // desktop must never kill the platform's (or any other device's) login.
    void fetch(`${SERVER_URL}/api/session/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    }).catch(() => { /* best-effort: the device is signed out regardless */ });
  }
}

/** Get cached account info. */
export function getAccountInfo(): AccountInfo | null {
  return cachedAccount;
}

/** Get cached heartbeat result. */
export function getHeartbeatInfo(): HeartbeatResult | null {
  return cachedHeartbeat;
}

/**
 * MCP (connecting servers, the cloud relay, and the local MCP server) is
 * available to any signed-in, active account — there is no pay gate. Access
 * is denied only when not signed in, or when the account state explicitly
 * reports disabled.
 */
export function hasMcpAccess(): boolean {
  if (!isAuthenticated()) return false;
  const hb = cachedHeartbeat;
  if (hb && hb.status !== "active") return false;
  return true;
}

/** Get auth status for the boot sequence. */
export function getAuthStatus(): {
  authenticated: boolean;
  status: "active" | "disabled" | "unauthenticated";
  tier?: string;
} {
  if (!isAuthenticated()) {
    return { authenticated: false, status: "unauthenticated" };
  }
  if (cachedHeartbeat) {
    return { authenticated: true, status: cachedHeartbeat.status, tier: cachedHeartbeat.tier };
  }
  return { authenticated: true, status: "active" };
}

// ── Device-flow sign-in ──────────────────────────────────────

export type { DevicePrompt };

// One device grant in flight at a time: starting a new one aborts the old
// poll (its code dies server-side unused), so "get a new code" is safe to
// mash and a stuck poll can always be replaced.
let deviceLoginAbort: AbortController | null = null;

/** Abort the in-flight device login, if any (the renderer's cancel/reset). */
export function cancelDeviceLogin(): void {
  deviceLoginAbort?.abort();
  deviceLoginAbort = null;
}

/**
 * Sign in via the SDK device flow: opens the user's default browser on the
 * platform's approval page and polls until they approve. `onPrompt` receives
 * the user code + URL so the renderer can display them (and offer the link
 * again if the browser hand-off didn't land). Resolves `{ ok: true }` once
 * the session is stored; failures carry the real error message.
 */
export async function startDeviceLogin(
  onPrompt?: (prompt: DevicePrompt) => void,
): Promise<{ ok: boolean; error?: string }> {
  cancelDeviceLogin();
  const abort = new AbortController();
  deviceLoginAbort = abort;
  try {
    await getClient().auth.deviceLogin({
      machineId: os.hostname(),
      signal: abort.signal,
      onPrompt: (prompt) => {
        void shell.openExternal(prompt.verificationUriComplete || prompt.verificationUri)
          .catch((err) => console.warn("[auth] could not open browser for device approval:", err?.message || err));
        try { onPrompt?.(prompt); } catch { /* renderer display is best-effort */ }
      },
    });
    signedIn = true;
    await ensureFreshToken();
    await refreshAccountState();
    attachStart();
    return { ok: true };
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    // A replaced/cancelled attempt is not a failure the user needs shown.
    if (abort.signal.aborted) return { ok: false, error: "cancelled" };
    console.error("[auth] device login failed:", message);
    return { ok: false, error: message };
  } finally {
    if (deviceLoginAbort === abort) deviceLoginAbort = null;
  }
}

/**
 * Legacy boolean face of the device flow. The `mode` argument is historical
 * (register/login were separate password flows); the device grant serves
 * both — the platform handles new accounts.
 */
export async function startAuthFlow(
  _mode: "register" | "login" = "login",
  onPrompt?: (prompt: DevicePrompt) => void,
): Promise<boolean> {
  return (await startDeviceLogin(onPrompt)).ok;
}

// ── Account state (the old heartbeat) ────────────────────────

// Offline → online transition hooks: server-authoritative stores (prefs,
// chats, app schedules) reconcile the moment connectivity returns instead
// of waiting for the next restart.
let accountDown = false;
const reconnectHooks: Array<() => void> = [];
export function onServerReconnect(fn: () => void): void {
  reconnectHooks.push(fn);
}

/**
 * Refresh the composed account view (identity + profile + subscription + org)
 * that replaces the old server heartbeat. Also the observer feed that locks
 * the workspace when an account goes inactive.
 */
async function refreshAccountState(): Promise<HeartbeatResult | null> {
  const client = getClient();
  const [id, prof, sub, org] = await Promise.allSettled([
    client.me(),
    client.profile.get(),
    client.billing.status(),
    client.org.get(),
  ]);
  if (id.status === "rejected") {
    accountDown = true;
    return null;
  }

  const identity = id.value;
  const profile = prof.status === "fulfilled" ? prof.value : null;
  const subscription = sub.status === "fulfilled" ? sub.value : null;
  const orgInfo = org.status === "fulfilled" ? org.value : null;

  writeIdentitySidecar(identity.userId);
  setActiveUser(identity.userId);

  cachedAccount = {
    email: identity.email,
    firstName: profile?.firstName ?? identity.name ?? "",
    lastName: profile?.lastName ?? "",
    role: identity.role,
    orgName: orgInfo?.name ?? "",
    orgSlug: orgInfo?.slug ?? "",
    tier: subscription?.tier ?? identity.tier,
    billingStatus: subscription?.billingStatus ?? "",
  };
  cachedHeartbeat = {
    // The new server has no account-disabled heartbeat signal (a revoked
    // session simply 401s) — "disabled" is reserved for when it grows one.
    status: "active",
    tier: cachedAccount.tier,
    billingStatus: cachedAccount.billingStatus,
    entitlements: {},
    org: orgInfo ? { id: orgInfo.id, name: orgInfo.name, maxSeats: orgInfo.maxSeats } : null,
    user: {
      id: identity.userId,
      email: identity.email,
      firstName: profile?.firstName ?? null,
      lastName: profile?.lastName ?? null,
      role: identity.role,
    },
  };

  if (accountDown) {
    accountDown = false;
    for (const fn of reconnectHooks) {
      try { fn(); } catch { /* a hook must not break the poll */ }
    }
  }
  try { heartbeatObserver?.(cachedHeartbeat); } catch { /* observer must not break the poll */ }
  return cachedHeartbeat;
}

/** Force an account-state check now (e.g. after returning from billing portal). */
export async function refreshHeartbeat(): Promise<HeartbeatResult | null> {
  return refreshAccountState();
}

/**
 * Register an observer notified on every account-state result. Used to lock
 * the client out of the workspace the moment an account is disabled.
 */
export function setHeartbeatObserver(cb: ((result: HeartbeatResult) => void) | null): void {
  heartbeatObserver = cb;
}
