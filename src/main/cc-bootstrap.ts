/**
 * Auth bootstrap — BYOK Anthropic API key only.
 *
 * The earlier Claude Code OAuth path (spawning `claude /login` and reading
 * the resulting credentials from disk or the OS keychain) was removed
 * because hosting that flow in our own app violates Anthropic's Terms of
 * Service. Users now bring their own Anthropic API key, pasted into the
 * boot-gate modal and stored server-side (yo-server's user_provider_keys
 * table) via the provider-keys module — never written to local disk.
 *
 * Surface (kept for back-compat with existing call sites):
 *   • bootstrapStatus() — { found, byokAnthropic } reflecting BYOK key
 *   • ensureCcAuth()    — true iff a BYOK Anthropic key is set; else
 *                         the renderer's `cc-show-modal` IPC fires and
 *                         the modal prompts the user to paste a key
 */

import { BrowserWindow } from "electron";
import { hasKey as hasProviderKey } from "./provider-keys";
import { getAuthToken } from "./auth";

export interface BootstrapStatus {
  /** True when an Anthropic API key is configured. The renderer treats
   *  this as "logged in"; the agent passes the key as ANTHROPIC_API_KEY
   *  to the SDK so api.anthropic.com calls succeed. */
  found: boolean;
  /** Always true here — semantic marker preserved for the renderer modal
   *  which now exists solely to collect a BYOK key. */
  byokAnthropic: boolean;
}

export async function bootstrapStatus(): Promise<BootstrapStatus> {
  let byok = false;
  try { byok = await hasProviderKey("anthropic"); } catch { /* */ }
  let loggedIn = false;
  try { loggedIn = !!getAuthToken(); } catch { /* not logged in */ }
  // `found` = the Glyphh agent can run. That's true when logged in (it goes
  // through the platform proxy — no key needed) OR when a BYOK key is set.
  // So the boot-gate key modal only appears when signed out without a key.
  return { found: byok || loggedIn, byokAnthropic: byok };
}

/**
 * Is the Glyphh agent allowed to run? The agent now goes through the platform
 * proxy authenticated with the session JWT, so being LOGGED IN is sufficient —
 * no Anthropic key required. (A user's own key, if set, is only for the Agents
 * coding agents.) Only when signed out AND without a BYOK key do we fall back to
 * the legacy key modal.
 */
export async function ensureCcAuth(): Promise<boolean> {
  try { if (getAuthToken()) return true; } catch { /* not logged in */ }
  if ((await bootstrapStatus()).found) return true;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("cc-show-modal");
  }
  return false;
}
