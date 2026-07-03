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
// MCP (connecting servers + exposing Glyphh as one) is a paid-tier feature.
export function canUseMcp(): GateResult {
  return hasMcpAccess() ? ALLOWED : { allowed: false, reason: "MCP requires a Pro plan." };
}
export function canUseCustomDrips(): GateResult { return ALLOWED; }

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
