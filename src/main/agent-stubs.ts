/**
 * agent-stubs.ts — DEAD ENDS for the retired agent surface (THE PURGE,
 * owner order 2026-09-10: "for now just dead end all those agent calls").
 *
 * The built-in agent engine, its pickers (models/loops), cloud memory,
 * connections, hosting, marketplace listings, and the run-stream observer are
 * gone from the main process. The renderer's chat shell still exists (it is
 * the future face of the CLI workpanel — the NORTH STAR is cli → glyphh
 * agent UX), so every surviving call site gets a SENTENCE back instead of a
 * dead invoke: `{ ok: false, error: RETIRED }` in the envelope shape, or an
 * empty list where callers expect a bare array. One file, auditable, deleted
 * lane-by-lane as real replacements land (local registry in P3d, the CLI
 * panel next).
 */

import { ipcMain } from "electron";

const RETIRED =
  "The built-in agent is retired — run Claude (or any CLI) in the terminal panel; it drives Glyphh over the local MCP server.";

/** Channels whose callers expect the { ok, error } envelope. */
const ENVELOPE = [
  "agent-dock:capture-target",
  "app-clone",
  "app-collaborator-remove", "app-collaborator-set", "app-collaborators",
  "app-domain-add", "app-domain-remove", "app-domains-list",
  "app-listing-image-add", "app-listing-image-remove", "app-listing-list", "app-listing-set",
  "app-release-notes", "app-release-org-review", "app-release-promote", "app-releases",
  "app-server-deploy", "app-server-deployments", "app-server-destroy", "app-servers-list",
  "app-version-set",
  "connection-disconnect", "connection-rename", "connection-tools-list", "connection-tools-set",
  "connectors-connect", "connectors-disconnect", "connectors-list-tools", "connectors-refresh-mcp",
  "files:r2-diff",
  "glyphh-agent-approval-respond", "glyphh-agent-ask-respond", "glyphh-agent-connect-respond",
  "glyphh-agent-context-usage", "glyphh-agent-inject", "glyphh-agent-set-permission", "glyphh-agent-stop",
  "harness-stop-run",
  "hosting-deploy", "hosting-destroy", "hosting-status",
  "loop-apply-config", "loop-role-set", "loop-set-role-default",
  "marketing-link-create", "marketing-link-delete", "marketing-link-update", "marketing-links",
  "mcp-connections-catalog", "mcp-connections-create", "mcp-connections-delete",
  "mcp-connections-install", "mcp-connections-tools", "mcp-connections-update",
  "memory-amend", "memory-browse", "memory-forget", "memory-graph", "memory-search",
  "org-custom-models-delete", "org-custom-models-list", "org-custom-models-save",
  "org-custom-providers-delete", "org-custom-providers-list", "org-custom-providers-save",
  "org-models-list", "org-models-set-supported",
  "org-provider-clear-key", "org-provider-disable", "org-provider-enable", "org-providers-list",
  "run-stream-attach", "run-stream-stop",
] as const;

/** Channels whose callers destructure a bare array. */
const EMPTY_LIST = [
  "connections-list", "connectors-get-accounts",
  "drips-builtin-effects", "drips-list", "drips-running",
  "loops-list",
] as const;

export function registerAgentStubs(): void {
  for (const ch of ENVELOPE) {
    ipcMain.handle(ch, () => ({ ok: false, error: RETIRED }));
  }
  for (const ch of EMPTY_LIST) {
    ipcMain.handle(ch, () => []);
  }
  // Shape-specific dead ends — callers read named fields, not the envelope.
  ipcMain.handle("connectors-get-apps", () => ({ apps: [], hasMore: false }));
  ipcMain.handle("drips-save", () => RETIRED);
  ipcMain.handle("drips-delete", () => RETIRED);
  ipcMain.handle("drips-preview", () => RETIRED);
  ipcMain.handle("drips-stop", () => "stopped");
  ipcMain.handle("loop-roles", (_e, p?: { loop?: string }) => ({ ok: false, loop: String(p?.loop || "default"), roles: [] }));
  ipcMain.handle("mcp-connections-list", () => ({ ok: false, error: RETIRED, connections: [] }));
  ipcMain.handle("mcp-custom-allowed", () => ({ allowed: false, reason: RETIRED }));
  // Background/resident mode is gone — report it off, refuse to arm it.
  ipcMain.handle("get-background-mode", () => false);
  ipcMain.handle("set-background-mode", () => false);
}
