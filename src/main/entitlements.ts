/**
 * Entitlements ��� all features unlocked.
 *
 * The only gate is yos balance, enforced server-side on LLM proxy calls.
 * These functions exist as no-op stubs so callers compile without changes
 * during the transition. They always return { allowed: true }.
 */

import { hasMcpAccess } from "./auth";

export type GateResult = { allowed: true } | { allowed: false; reason: string };

const ALLOWED: GateResult = { allowed: true };

export function canAddApp(_currentCount?: number): GateResult { return ALLOWED; }
export function canCreateSkill(_currentCount?: number): GateResult { return ALLOWED; }
export function canSaveLayout(_currentCount?: number): GateResult { return ALLOWED; }
// MCP is available to any signed-in, active account — there is no pay gate.
export function canUseMcp(): GateResult {
  return hasMcpAccess() ? ALLOWED : { allowed: false, reason: "Sign in to use MCP." };
}
export function canUseCustomDrips(): GateResult { return ALLOWED; }
/**
 * OFFLINE fallback only. Whether custom MCP is permitted is a WORKSPACE grant
 * the server owns — home-ipc's `mcp-custom-allowed` asks it directly and only
 * falls back here when the server is unreachable. There is no client-side copy
 * of the policy to consult (the old heartbeat entitlements are gone), so this
 * defers to sign-in state and lets the server refuse if it disagrees.
 */
export function canUseCustomMcp(): GateResult {
  return canUseMcp();
}

export function getCurrentLimits() {
  return {
    maxApps: 0,
    maxSkills: 0,
    maxLayouts: 0,
    mcp: true,
    customLayouts: true,
    customDrips: true,
    sync: true,
  };
}
