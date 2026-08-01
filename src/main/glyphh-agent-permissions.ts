/**
 * Glyphh permission model + effort lever.
 *
 * Modes (glyphhMode preference, cycled from the composer chip):
 *   ask         — every mutating action needs approval; reads are free
 *   plan        — read-only: Glyphh plans, nothing changes
 *   acceptEdits — file edits auto-approved; commands/network still ask
 *   auto        — workspace actions auto-approved; dangerous ones still ask
 *   bypass      — everything auto-approved (trusted sessions only)
 *
 * The agent loop's tool executor calls gateGlyphhAction() before every
 * action. "Ask" resolutions round-trip to the Code panel: an approval card
 * renders inline (glyphh:approval → glyphh-approval-respond), defaulting
 * to DENY after a timeout or if the panel is gone.
 *
 * The effort dial is GONE. It rationed turns and tokens for the local-model
 * era; an attended session is governed by its human (the Stop button), an
 * unattended agent by its guardrails, and the reply budget by the resolved
 * model's own maxOutputTokens (loop-selections).
 */

import { ipcMain, type WebContents } from "electron";
import { getPreference } from "./stores/preferences-db";

export type GlyphhMode = "ask" | "plan" | "acceptEdits" | "auto" | "bypass";
export type GlyphhActionKind = "read" | "edit" | "command" | "network" | "dangerous";

export interface GlyphhAction {
  kind: GlyphhActionKind;
  /** Short human line, e.g. `Edit src/app.ts` or `Run npm test`. */
  title: string;
  /** The exact content being approved — command line, diff summary, URL. */
  detail?: string;
}

const MODES: GlyphhMode[] = ["ask", "plan", "acceptEdits", "auto", "bypass"];
const APPROVAL_TIMEOUT_MS = 120_000;

export function glyphhMode(): GlyphhMode {
  const m = String(getPreference("glyphhMode", "ask")) as GlyphhMode;
  return MODES.includes(m) ? m : "ask";
}



// ── The gate ───────────────────────────────────────────────────────────────

const pending = new Map<string, (allow: boolean) => void>();

/**
 * Decide whether the agent loop may perform an action. Never throws — the
 * executor branches on { allowed } and reports `reason` back to the model
 * so it can re-plan (e.g. "plan mode is read-only").
 */
export async function gateGlyphhAction(
  wc: WebContents,
  action: GlyphhAction,
): Promise<{ allowed: boolean; reason?: string }> {
  const mode = glyphhMode();
  if (action.kind === "read") return { allowed: true };
  if (mode === "bypass") return { allowed: true };
  if (mode === "plan") {
    return { allowed: false, reason: "plan mode is read-only — the user must switch modes before changes can be made" };
  }
  if (mode === "auto" && action.kind !== "dangerous") return { allowed: true };
  if (mode === "acceptEdits" && action.kind === "edit") return { allowed: true };
  return requestApproval(wc, action);
}

function requestApproval(wc: WebContents, action: GlyphhAction): Promise<{ allowed: boolean; reason?: string }> {
  return new Promise((resolve) => {
    const id = `apr-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ allowed: false, reason: "approval request timed out" });
    }, APPROVAL_TIMEOUT_MS);
    pending.set(id, (allow) => {
      clearTimeout(timer);
      resolve(allow ? { allowed: true } : { allowed: false, reason: "the user denied this action" });
    });
    try {
      if (wc.isDestroyed()) throw new Error("panel gone");
      wc.send("glyphh-agent:approval", { id, kind: action.kind, title: action.title, detail: action.detail ?? "" });
    } catch {
      clearTimeout(timer);
      pending.delete(id);
      resolve({ allowed: false, reason: "no panel available to ask" });
    }
  });
}

// ── Agent questions (ask_user) ─────────────────────────────────────────────
//
// The loop can put a real question to the user — options plus a free-text
// escape hatch — and wait on the answer. Rendered in the same ask dock as
// approvals, one step at a time ("1 of 2"). A timeout answers with nothing
// so an unattended run re-plans instead of hanging forever.

export interface AskQuestion { question: string; options?: string[] }

const pendingAsks = new Map<string, (answers: string[]) => void>();
const ASK_TIMEOUT_MS = 10 * 60_000;

export function askUserQuestions(wc: WebContents, questions: AskQuestion[]): Promise<string[]> {
  return new Promise((resolve) => {
    const id = `ask-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const timer = setTimeout(() => {
      pendingAsks.delete(id);
      resolve([]);
    }, ASK_TIMEOUT_MS);
    pendingAsks.set(id, (answers) => {
      clearTimeout(timer);
      resolve(answers);
    });
    try {
      if (wc.isDestroyed()) throw new Error("panel gone");
      wc.send("glyphh-agent:ask", { id, questions });
    } catch {
      clearTimeout(timer);
      pendingAsks.delete(id);
      resolve([]);
    }
  });
}

// ── Inline CONNECT card — the agent offers an account connection in the
// thread; the user authorizes without leaving the chat; the tool WAITS on
// the outcome (same contract as ask_user: a timeout resolves gracefully so
// an unattended run re-plans instead of hanging).

export interface ConnectCardApp { appId: string; name: string; icon?: string | null }

const pendingConnects = new Map<string, (r: { connected: boolean; reason?: string }) => void>();
const CONNECT_TIMEOUT_MS = 10 * 60_000;

export function requestInlineConnect(wc: WebContents, app: ConnectCardApp): Promise<{ connected: boolean; reason?: string }> {
  return new Promise((resolve) => {
    const id = `conn-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const timer = setTimeout(() => {
      pendingConnects.delete(id);
      resolve({ connected: false, reason: "no response" });
    }, CONNECT_TIMEOUT_MS);
    pendingConnects.set(id, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    try {
      if (wc.isDestroyed()) throw new Error("panel gone");
      wc.send("glyphh-agent:connect", { id, app });
    } catch {
      clearTimeout(timer);
      pendingConnects.delete(id);
      resolve({ connected: false, reason: "panel gone" });
    }
  });
}

export function registerGlyphhPermissionIpc(): void {
  ipcMain.handle("glyphh-agent-connect-respond", (_e, p: { id?: string; connected?: boolean; reason?: string }) => {
    const entry = pendingConnects.get(String(p?.id ?? ""));
    if (!entry) return false;
    pendingConnects.delete(String(p?.id));
    entry({ connected: !!p?.connected, ...(p?.reason ? { reason: String(p.reason) } : {}) });
    return true;
  });
  ipcMain.handle("glyphh-agent-approval-respond", (_e, p: { id?: string; allow?: boolean }) => {
    const entry = pending.get(String(p?.id ?? ""));
    if (!entry) return false;
    pending.delete(String(p?.id));
    entry(!!p?.allow);
    return true;
  });
  ipcMain.handle("glyphh-agent-ask-respond", (_e, p: { id?: string; answers?: unknown[] }) => {
    const entry = pendingAsks.get(String(p?.id ?? ""));
    if (!entry) return false;
    pendingAsks.delete(String(p?.id));
    entry((Array.isArray(p?.answers) ? p.answers : []).map(String));
    return true;
  });
}
