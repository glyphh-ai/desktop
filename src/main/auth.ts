/**
 * Auth — BrowserWindow-based authentication via platform.glyphh.ai.
 *
 * Flow:
 *   1. Open BrowserWindow to platform.glyphh.ai/auth?flow=electron (register or login)
 *   2. User completes auth on the platform
 *   3. Web generates a one-time device code and redirects to /auth/callback?code=XXX
 *   4. We intercept the navigation, extract the code, exchange it for JWT tokens
 *   5. Tokens stored on disk (0600 perms), not the OS keychain — see the
 *      "Session file storage" comment below for why
 *   6. Heartbeat polls server every 4 hours for tier/entitlements
 */

import fs from "fs";
import path from "path";
import os from "os";
import { BrowserWindow, net, shell } from "electron";

const CONFIG_DIR = path.join(os.homedir(), "yo");
const SESSION_FILE = path.join(CONFIG_DIR, ".session");
const REFRESH_MARGIN = 3 * 60 * 1000; // refresh 3 min before expiry
const HEARTBEAT_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours

export const AUTH_SERVER =
  process.env.YO_AUTH_SERVER || "https://api.glyphh.ai";
export const PLATFORM_URL =
  process.env.YO_PLATFORM_URL || "https://platform.glyphh.ai";

// ── Types ────────────────────────────────────────────────────

export interface SessionData {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms timestamp
}

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

let currentSession: SessionData | null = null;
let cachedAccount: AccountInfo | null = null;
let cachedHeartbeat: HeartbeatResult | null = null;
let heartbeatObserver: ((result: HeartbeatResult) => void) | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let authWindow: BrowserWindow | null = null;

// ── Re-auth gate ─────────────────────────────────────────────
// Fired when the session can't be kept alive (refresh rejected, or an authed
// call hit 401 with no usable token) so the UI can surface the login screen
// instead of silently degrading. Debounced so a burst of failing calls only
// pops one prompt.
let reauthHandler: (() => void) | null = null;
let lastReauthAt = 0;

/** Register the callback that surfaces the login gate (set by main.ts). */
export function setReauthHandler(fn: () => void): void { reauthHandler = fn; }

/** Signal that the user must re-authenticate. Debounced (30s). */
function triggerReauth(): void {
  const now = Date.now();
  if (now - lastReauthAt < 30_000) return;
  lastReauthAt = now;
  console.warn("[auth] session cannot be refreshed — prompting re-login");
  try { reauthHandler?.(); } catch { /* noop */ }
}

// ── Session file storage ──────────────────────────────────────
// Plain file, 0600 perms — NOT safeStorage/OS-keychain. Session tokens are
// short-lived and already scoped/revocable server-side, so the tradeoff of
// hitting the macOS Keychain on every single boot (a user-visible OS prompt
// on some setups) isn't worth it for this value. Provider API keys (the
// actually sensitive, long-lived secret) live server-side entirely — see
// app-secrets.ts — so this file never holds anything higher-value than a
// session token.
function secureWrite(filePath: string, data: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, data, { encoding: "utf-8", mode: 0o600 });
}

function secureRead(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

// ── Session persistence ──────────────────────────────────────

function readSessionFile(): SessionData | null {
  const data = secureRead(SESSION_FILE);
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function saveSessionFile(session: SessionData): void {
  secureWrite(SESSION_FILE, JSON.stringify(session));
  currentSession = session;
  scheduleRefresh(session);
}

function clearSessionFile(): void {
  currentSession = null;
  cachedAccount = null;
  cachedHeartbeat = null;
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
  try { fs.unlinkSync(SESSION_FILE); } catch { /* ignore */ }
}

// ── Token refresh ────────────────────────────────────────────

function scheduleRefresh(session: SessionData): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  const delay = Math.max(0, session.expiresAt - Date.now() - REFRESH_MARGIN);
  refreshTimer = setTimeout(() => { void refreshTokens(); }, delay);
}

// Single-flight: the refresh token is single-use (the server rotates it), so
// overlapping refreshes would double-spend it and the second would 401 → a
// spurious logout. Coalesce concurrent callers onto one in-flight refresh.
let refreshInFlight: Promise<boolean> | null = null;
function refreshTokens(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefreshTokens().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

async function doRefreshTokens(): Promise<boolean> {
  const session = currentSession || readSessionFile();
  if (!session?.refreshToken) return false;

  try {
    const result = await serverPost<{
      ok: boolean;
      accessToken?: string;
      refreshToken?: string;
      expiresIn?: number;
      error?: string;
    }>("/api/session/refresh", { refreshToken: session.refreshToken });

    if (result.ok && result.accessToken && result.refreshToken && result.expiresIn) {
      saveSessionFile({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: Date.now() + result.expiresIn * 1000,
      });
      return true;
    }
    // 2xx but not ok — treat as an invalid refresh token → must re-login.
    clearSessionFile();
    triggerReauth();
    return false;
  } catch (err) {
    // Only a genuine 401 means the refresh token is invalid/revoked → re-login.
    // Everything else (5xx during a deploy, network blip, timeout) is TRANSIENT:
    // keep the existing session if still valid and retry — do NOT bounce the
    // user to the login screen over a momentary server hiccup.
    const is401 = /HTTP 401\b/.test(String((err as Error)?.message || ""));
    if (!is401 && currentSession && currentSession.expiresAt > Date.now()) {
      setTimeout(() => { void refreshTokens(); }, 30_000);
      return true;
    }
    clearSessionFile();
    triggerReauth();
    return false;
  }
}

// ── Public API ───────────────────────────────────────────────

/** Check if user is authenticated (has valid session). */
export function isAuthenticated(): boolean {
  if (currentSession && currentSession.expiresAt > Date.now()) return true;
  const saved = readSessionFile();
  if (saved && saved.expiresAt > Date.now()) {
    currentSession = saved;
    return true;
  }
  return false;
}

/** Get current access token, or null if not authenticated. */
export function getAuthToken(): string | null {
  if (currentSession && currentSession.expiresAt > Date.now()) {
    return currentSession.accessToken;
  }
  return null;
}

// Ensure a token has comfortable life left before a (potentially long) agent
// turn. The scheduled refresh timer is unreliable when the app is backgrounded
// or the machine sleeps (OS throttles/pauses setTimeout), so the agent must not
// rely on it alone — it proactively tops up the token before each turn.
const PROACTIVE_MARGIN = 10 * 60 * 1000; // refresh if <10 min of life remains

/**
 * Await a token refresh when the access token is within PROACTIVE_MARGIN of
 * expiry (or already expired). Cheap to call on every agent entry point — the
 * single-flight guard coalesces concurrent callers, and it no-ops when the
 * token still has plenty of life. Signed-out → no-op.
 */
export async function ensureFreshToken(): Promise<void> {
  const wasInMemory = !!currentSession;
  const session = currentSession || readSessionFile();
  if (!session?.refreshToken) return;
  currentSession = session;
  if (session.expiresAt - Date.now() < PROACTIVE_MARGIN) {
    await refreshTokens();
  } else if (!wasInMemory) {
    // Rehydrated from disk into a process with no armed refresh timer — re-arm
    // it so we're not relying solely on the next turn's proactive top-up.
    scheduleRefresh(session);
  }
}

/**
 * Force a refresh now, regardless of remaining life. Reactive path — call after
 * a proxy/API 401 to self-heal a token the server rejected (e.g. clock skew, or
 * a turn that outlived its token). Resolves true if a fresh token is in hand.
 */
export async function forceTokenRefresh(): Promise<boolean> {
  return refreshTokens();
}

/** Initialize auth — restore session, schedule refresh, start heartbeat. */
export async function initAuth(): Promise<void> {
  const saved = readSessionFile();
  if (saved) {
    currentSession = saved;
    if (saved.expiresAt - Date.now() < REFRESH_MARGIN) {
      await refreshTokens();
    } else {
      scheduleRefresh(saved);
    }
    // Fetch account info + heartbeat on boot
    void fetchAccountInfo();
    void fetchHeartbeat();
  }
  startHeartbeat();
}

/** Clean up timers — call on app shutdown. */
export function cleanupAuthTimers(): void {
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

/** Log out — clear session and cached data. */
export function logout(): void {
  clearSessionFile();
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
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
 * is denied only when not signed in, or when the heartbeat explicitly reports
 * the account as disabled. It does NOT require the first heartbeat to have
 * landed, so the relay/local server can come up immediately after sign-in.
 */
export function hasMcpAccess(): boolean {
  if (!isAuthenticated()) return false;
  const hb = cachedHeartbeat;
  if (hb && hb.status !== "active") return false; // account explicitly disabled
  return true;
}

/**
 * Get auth status for the boot sequence.
 * Returns account info without requiring a license key.
 */
export function getAuthStatus(): {
  authenticated: boolean;
  status: "active" | "disabled" | "unauthenticated";
  tier?: string;
} {
  if (!isAuthenticated()) {
    return { authenticated: false, status: "unauthenticated" };
  }
  if (cachedHeartbeat) {
    return {
      authenticated: true,
      status: cachedHeartbeat.status,
      tier: cachedHeartbeat.tier,
    };
  }
  return { authenticated: true, status: "active" };
}

// ── BrowserWindow auth flow ──────────────────────────────────

/**
 * Open auth window for registration or login.
 * Returns a promise that resolves when auth is complete (tokens stored).
 */
export function startAuthFlow(mode: "register" | "login" = "register"): Promise<boolean> {
  return new Promise((resolve) => {
    // Close any existing auth window
    if (authWindow && !authWindow.isDestroyed()) {
      authWindow.close();
    }

    const authPath = mode === "login" ? "/auth/login" : "/auth";
    const authUrl = `${PLATFORM_URL}${authPath}?flow=electron`;

    authWindow = new BrowserWindow({
      width: 520,
      height: 700,
      title: "Sign in to Yo",
      resizable: false,
      minimizable: false,
      maximizable: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    authWindow.setMenuBarVisibility(false);

    // Watch for navigation to the callback URL
    authWindow.webContents.on("will-navigate", async (_event, url) => {
      if (url.includes("/auth/callback")) {
        const parsed = new URL(url);
        const code = parsed.searchParams.get("code");
        if (code) {
          // Exchange device code for JWT
          const success = await exchangeDeviceCode(code);
          if (success) {
            // Fetch account info immediately
            await fetchAccountInfo();
            await fetchHeartbeat();
          }
          if (authWindow && !authWindow.isDestroyed()) {
            authWindow.close();
          }
          resolve(success);
        }
      }
    });

    // Also watch for redirects (the callback may be a server-side redirect)
    authWindow.webContents.on("will-redirect", async (_event, url) => {
      if (url.includes("/auth/callback")) {
        const parsed = new URL(url);
        const code = parsed.searchParams.get("code");
        if (code) {
          const success = await exchangeDeviceCode(code);
          if (success) {
            await fetchAccountInfo();
            await fetchHeartbeat();
          }
          if (authWindow && !authWindow.isDestroyed()) {
            authWindow.close();
          }
          resolve(success);
        }
      }
    });

    authWindow.on("closed", () => {
      authWindow = null;
      // If the window was closed without completing auth, resolve false
      resolve(false);
    });

    authWindow.loadURL(authUrl);
  });
}

// ── Native (in-client) email auth ────────────────────────────
// Email-only auth handled entirely inside the client against the server API —
// no BrowserWindow popup, no device-code handoff (which strands new users on
// the platform page). Tokens land in the same encrypted session store.

interface NativeAuthResponse {
  ok?: boolean;
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  error?: string;
}

/** Pull the server's `{ error }` message out of a serverPost rejection. */
function parseAuthError(err: unknown, fallback: string): string {
  const msg = String((err as Error)?.message || "");
  const m = msg.match(/\{.*"error"\s*:\s*"([^"]+)"/);
  if (m) return m[1];
  if (/HTTP 409/.test(msg)) return "Account already exists";
  if (/timeout/i.test(msg)) return "Request timed out — check your connection";
  return fallback;
}

async function storeAuthTokens(result: NativeAuthResponse): Promise<boolean> {
  if (result.accessToken && result.refreshToken && result.expiresIn) {
    saveSessionFile({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt: Date.now() + result.expiresIn * 1000,
    });
    await fetchAccountInfo();
    await fetchHeartbeat();
    return true;
  }
  return false;
}

/** Step 1 of registration: send a 6-digit code to the email. */
export async function authRegister(email: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await serverPost("/api/auth/register", { email });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: parseAuthError(err, "Could not start registration") };
  }
}

/** Step 2 of registration: verify the 6-digit code. */
export async function authVerifyCode(email: string, code: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await serverPost("/api/auth/verify-code", { email, code });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: parseAuthError(err, "Invalid or expired code") };
  }
}

/** Step 3 of registration: create the account + org, then sign in (store tokens). */
export async function authCompleteProfile(data: {
  email: string; firstName: string; lastName: string;
  password: string; confirmPassword: string; orgName?: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const result = await serverPost<NativeAuthResponse>("/api/auth/complete-profile", data);
    if (await storeAuthTokens(result)) return { ok: true };
    return { ok: false, error: result.error || "Account creation failed" };
  } catch (err) {
    return { ok: false, error: parseAuthError(err, "Account creation failed") };
  }
}

/** Sign in with email + password (stores tokens on success). */
export async function authLogin(email: string, password: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const result = await serverPost<NativeAuthResponse>("/api/auth/login", { email, password });
    if (await storeAuthTokens(result)) return { ok: true };
    return { ok: false, error: result.error || "Invalid credentials" };
  } catch (err) {
    return { ok: false, error: parseAuthError(err, "Invalid credentials") };
  }
}

/**
 * Request a password-reset email. The server always responds 200 (no account
 * enumeration) and emails a reset link that opens the platform's web reset page,
 * so the actual reset happens in the browser. We only surface network failures.
 */
export async function authForgotPassword(email: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await serverPost("/api/auth/forgot-password", { email });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: parseAuthError(err, "Could not send the reset email") };
  }
}

/** Exchange a one-time device code for JWT tokens. */
async function exchangeDeviceCode(code: string): Promise<boolean> {
  try {
    const result = await serverPost<{
      ok: boolean;
      accessToken?: string;
      refreshToken?: string;
      expiresIn?: number;
      error?: string;
    }>("/api/auth/device-exchange", { code });

    if (result.ok && result.accessToken && result.refreshToken && result.expiresIn) {
      saveSessionFile({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: Date.now() + result.expiresIn * 1000,
      });
      return true;
    }
    console.error("Device code exchange failed:", result.error);
    return false;
  } catch (err) {
    console.error("Device code exchange error:", err);
    return false;
  }
}

// ── Heartbeat ────────────────────────────────────────────────

function startHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (isAuthenticated()) {
      void fetchHeartbeat();
    }
  }, HEARTBEAT_INTERVAL);
}

async function fetchHeartbeat(): Promise<HeartbeatResult | null> {
  try {
    const result = await serverGetAuthed<HeartbeatResult>("/api/heartbeat");
    cachedHeartbeat = result;
    // Notify the observer so the app can gate access when an account is
    // disabled — the heartbeat is the authoritative account-status check.
    try { heartbeatObserver?.(result); } catch { /* observer must not break the poll */ }
    return result;
  } catch {
    return null;
  }
}

/**
 * Register an observer notified on every heartbeat result. Used to lock the
 * client out of the workspace the moment an account is disabled (status
 * "disabled").
 */
export function setHeartbeatObserver(cb: ((result: HeartbeatResult) => void) | null): void {
  heartbeatObserver = cb;
}

async function fetchAccountInfo(): Promise<AccountInfo | null> {
  try {
    const result = await serverGetAuthed<{
      email: string;
      firstName: string;
      lastName: string;
      role: string;
      orgName: string;
      orgSlug: string;
      tier: string;
      billingStatus: string;
    }>("/api/user/me");
    cachedAccount = result;
    return result;
  } catch {
    return null;
  }
}

/** Force a heartbeat check now (e.g. after returning from billing portal). */
export async function refreshHeartbeat(): Promise<HeartbeatResult | null> {
  return fetchHeartbeat();
}

// ── Server communication (Electron net for proxy support) ────

function serverPost<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const url = `${AUTH_SERVER}${endpoint}`;
    const data = JSON.stringify(body);
    const request = net.request({ url, method: "POST" });
    request.setHeader("Content-Type", "application/json");
    const timer = setTimeout(() => { request.abort(); reject(new Error("Request timeout")); }, 10_000);

    let responseBody = "";
    request.on("response", (response) => {
      const status = response.statusCode ?? 500;
      clearTimeout(timer);
      response.on("data", (chunk) => { responseBody += chunk.toString(); });
      response.on("end", () => {
        // Note: unauthed POST (login/refresh/device-exchange). A 401 here does
        // NOT pop the login gate — the refresh flow decides re-login itself, so
        // a transient 401 can't bounce the user.
        if (status < 200 || status >= 300) {
          reject(new Error(`HTTP ${status}: ${responseBody.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(responseBody) as T);
        } catch {
          reject(new Error("Invalid server response"));
        }
      });
    });
    request.on("error", reject);
    request.write(data);
    request.end();
  });
}

export function serverGetAuthed<T>(endpoint: string): Promise<T> {
  const token = getAuthToken();
  if (!token) { void refreshTokens(); return Promise.reject(new Error("Not authenticated")); }

  return new Promise((resolve, reject) => {
    const url = `${AUTH_SERVER}${endpoint}`;
    const request = net.request({ url, method: "GET" });
    request.setHeader("Authorization", `Bearer ${token}`);
    const timer = setTimeout(() => { request.abort(); reject(new Error("Request timeout")); }, 10_000);

    let responseBody = "";
    request.on("response", (response) => {
      const status = response.statusCode ?? 500;
      clearTimeout(timer);
      response.on("data", (chunk) => { responseBody += chunk.toString(); });
      response.on("end", () => {
        if (status === 401) void refreshTokens();   // try a refresh first; only a failed refresh re-logs-in
        if (status < 200 || status >= 300) {
          reject(new Error(`HTTP ${status}: ${responseBody.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(responseBody) as T);
        } catch {
          reject(new Error("Invalid server response"));
        }
      });
    });
    request.on("error", reject);
    request.end();
  });
}

export function serverDeleteAuthed<T>(endpoint: string): Promise<T> {
  const token = getAuthToken();
  if (!token) { void refreshTokens(); return Promise.reject(new Error("Not authenticated")); }

  return new Promise((resolve, reject) => {
    const url = `${AUTH_SERVER}${endpoint}`;
    const request = net.request({ url, method: "DELETE" });
    request.setHeader("Authorization", `Bearer ${token}`);
    const timer = setTimeout(() => { request.abort(); reject(new Error("Request timeout")); }, 10_000);

    let responseBody = "";
    request.on("response", (response) => {
      const status = response.statusCode ?? 500;
      clearTimeout(timer);
      response.on("data", (chunk) => { responseBody += chunk.toString(); });
      response.on("end", () => {
        if (status === 401) void refreshTokens();   // try a refresh first; only a failed refresh re-logs-in
        if (status < 200 || status >= 300) {
          reject(new Error(`HTTP ${status}: ${responseBody.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(responseBody) as T);
        } catch {
          reject(new Error("Invalid server response"));
        }
      });
    });
    request.on("error", reject);
    request.end();
  });
}

export function serverPostAuthed<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  return serverWriteAuthed<T>("POST", endpoint, body);
}

/** PATCH variant of serverPostAuthed — same auth/refresh/timeout handling. */
export function serverPatchAuthed<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  return serverWriteAuthed<T>("PATCH", endpoint, body);
}

/** PUT variant of serverPostAuthed — same auth/refresh/timeout handling. */
export function serverPutAuthed<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  return serverWriteAuthed<T>("PUT", endpoint, body);
}

function serverWriteAuthed<T>(method: "POST" | "PATCH" | "PUT", endpoint: string, body: Record<string, unknown>): Promise<T> {
  const token = getAuthToken();
  if (!token) { void refreshTokens(); return Promise.reject(new Error("Not authenticated")); }

  return new Promise((resolve, reject) => {
    const url = `${AUTH_SERVER}${endpoint}`;
    const data = JSON.stringify(body);
    const request = net.request({ url, method });
    request.setHeader("Content-Type", "application/json");
    request.setHeader("Authorization", `Bearer ${token}`);
    const timer = setTimeout(() => { request.abort(); reject(new Error("Request timeout")); }, 10_000);

    let responseBody = "";
    request.on("response", (response) => {
      const status = response.statusCode ?? 500;
      clearTimeout(timer);
      response.on("data", (chunk) => { responseBody += chunk.toString(); });
      response.on("end", () => {
        if (status === 401) void refreshTokens();   // try a refresh first; only a failed refresh re-logs-in
        if (status < 200 || status >= 300) {
          reject(new Error(`HTTP ${status}: ${responseBody.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(responseBody) as T);
        } catch {
          reject(new Error("Invalid server response"));
        }
      });
    });
    request.on("error", reject);
    request.write(data);
    request.end();
  });
}

