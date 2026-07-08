/**
 * William permission model + effort lever.
 *
 * Modes (williamMode preference, cycled from the composer chip):
 *   ask         — every mutating action needs approval; reads are free
 *   plan        — read-only: William plans, nothing changes
 *   acceptEdits — file edits auto-approved; commands/network still ask
 *   auto        — workspace actions auto-approved; dangerous ones still ask
 *   bypass      — everything auto-approved (trusted sessions only)
 *
 * The agent loop's tool executor calls gateWilliamAction() before every
 * action. "Ask" resolutions round-trip to the Code panel: an approval card
 * renders inline (william:approval → william-approval-respond), defaulting
 * to DENY after a timeout or if the panel is gone.
 *
 * Effort (williamEffort preference): low | medium | high. llama.cpp has no
 * native reasoning-effort for this model, so effort is OUR lever — it sets
 * the response token budget today and the repair-pass budget once the
 * generate→validate→repair loop lands.
 */

import { ipcMain, type WebContents } from "electron";
import { getPreference } from "./preferences";

export type WilliamMode = "ask" | "plan" | "acceptEdits" | "auto" | "bypass";
export type WilliamEffort = "low" | "medium" | "high" | "superfly";
export type WilliamActionKind = "read" | "edit" | "command" | "network" | "dangerous";

export interface WilliamAction {
  kind: WilliamActionKind;
  /** Short human line, e.g. `Edit src/app.ts` or `Run npm test`. */
  title: string;
  /** The exact content being approved — command line, diff summary, URL. */
  detail?: string;
}

const MODES: WilliamMode[] = ["ask", "plan", "acceptEdits", "auto", "bypass"];
const APPROVAL_TIMEOUT_MS = 120_000;

export function williamMode(): WilliamMode {
  const m = String(getPreference("williamMode", "ask")) as WilliamMode;
  return MODES.includes(m) ? m : "ask";
}

export function williamEffort(): WilliamEffort {
  const e = String(getPreference("williamEffort", "medium"));
  return e === "low" || e === "high" || e === "superfly" ? e : "medium";
}

/** Agent-loop turn budget per effort tier (tool calls per run). */
export function effortMaxTurns(): number {
  switch (williamEffort()) {
    case "low": return 4;
    case "high": return 14;
    case "superfly": return 24;
    default: return 8;
  }
}

/** Response token budget per effort tier (context is 16384 minus history). */
export function effortMaxTokens(): number {
  switch (williamEffort()) {
    case "low": return 1024;
    case "high": return 8192;
    case "superfly": return 12288; // absolute max — history squeezes to fit
    default: return 4096;
  }
}

// ── The gate ───────────────────────────────────────────────────────────────

const pending = new Map<string, (allow: boolean) => void>();

/**
 * Decide whether the agent loop may perform an action. Never throws — the
 * executor branches on { allowed } and reports `reason` back to the model
 * so it can re-plan (e.g. "plan mode is read-only").
 */
export async function gateWilliamAction(
  wc: WebContents,
  action: WilliamAction,
): Promise<{ allowed: boolean; reason?: string }> {
  const mode = williamMode();
  if (action.kind === "read") return { allowed: true };
  if (mode === "bypass") return { allowed: true };
  if (mode === "plan") {
    return { allowed: false, reason: "plan mode is read-only — the user must switch modes before changes can be made" };
  }
  if (mode === "auto" && action.kind !== "dangerous") return { allowed: true };
  if (mode === "acceptEdits" && action.kind === "edit") return { allowed: true };
  return requestApproval(wc, action);
}

function requestApproval(wc: WebContents, action: WilliamAction): Promise<{ allowed: boolean; reason?: string }> {
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
      wc.send("william:approval", { id, kind: action.kind, title: action.title, detail: action.detail ?? "" });
    } catch {
      clearTimeout(timer);
      pending.delete(id);
      resolve({ allowed: false, reason: "no panel available to ask" });
    }
  });
}

export function registerWilliamPermissionIpc(): void {
  ipcMain.handle("william-approval-respond", (_e, p: { id?: string; allow?: boolean }) => {
    const entry = pending.get(String(p?.id ?? ""));
    if (!entry) return false;
    pending.delete(String(p?.id));
    entry(!!p?.allow);
    return true;
  });
}
