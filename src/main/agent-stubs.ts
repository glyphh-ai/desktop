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
  "org-clients", "org-client-create", "org-client-cap", "org-client-detach",
  "app-collaborator-remove", "app-collaborator-set", "app-collaborators",
  "app-domain-add", "app-domain-remove", "app-domains-list",
  "app-listing-image-add", "app-listing-image-remove", "app-listing-list", "app-listing-set",
  "app-release-notes", "app-release-org-review", "app-release-promote", "app-releases",
  "app-server-deploy", "app-server-deployments", "app-server-destroy", "app-servers-list",
  "app-version-set",
  "files:r2-diff",
  "harness-stop-run",
  "hosting-deploy", "hosting-destroy", "hosting-status",
  "loop-apply-config", "loop-role-set",
  "marketing-link-create", "marketing-link-delete", "marketing-link-update", "marketing-links",
  "memory-amend", "memory-browse", "memory-forget", "memory-graph", "memory-search",
  "org-custom-models-delete", "org-custom-models-list", "org-custom-models-save",
  "org-custom-providers-delete", "org-custom-providers-list", "org-custom-providers-save",
  "org-models-list", "org-models-set-supported",
  "gateway-metrics",
  "workspace-provider-keys", "workspace-provider-key-set", "workspace-provider-key-clear",
  "gateway-keys-list", "gateway-keys-create", "gateway-keys-revoke",
  "org-provider-clear-key", "org-provider-disable", "org-provider-enable", "org-providers-list",
  "run-stream-attach", "run-stream-stop",
  "apikeys-create",
  "apikeys-list",
  "apikeys-revoke",
  "app-org-pending-releases",
  "app-source-history",
  "app-source-restore",
  "app-traffic",
  "org-domains-traffic",
  "glyphh-threads-delete",
  "glyphh-threads-get",
  "glyphh-threads-push",
  "library-admin-queue",
  "library-admin-review",
  "library-loop-create",
  "library-market",
  "library-market-install",
  "library-market-uninstall",
  "library-pending",
  "library-publish",
  "library-share",
  "library-share-review",
  "library-skill-create",
  "mkt-admin-app-search",
  "mkt-admin-dev-flagged",
  "mkt-admin-dev-moderate",
  "mkt-admin-flagged-reviews",
  "mkt-admin-queue",
  "mkt-admin-report-resolve",
  "mkt-admin-reports",
  "mkt-admin-review",
  "mkt-admin-review-moderate",
  "mkt-admin-source-file",
  "mkt-admin-source-tree",
  "mkt-admin-suspend",
  "mkt-browse",
  "mkt-detail",
  "mkt-dev-avatar",
  "mkt-dev-create",
  "mkt-dev-get",
  "mkt-dev-me",
  "mkt-dev-review-delete",
  "mkt-dev-review-put",
  "mkt-dev-review-report",
  "mkt-dev-review-respond",
  "mkt-dev-reviews",
  "mkt-dev-update",
  "mkt-earnings",
  "mkt-install",
  "mkt-my-apps",
  "mkt-payout-config-set",
  "mkt-payouts",
  "mkt-pricing-set",
  "mkt-program-enroll",
  "mkt-program-state",
  "mkt-release-submit",
  "mkt-releases",
  "mkt-report-app",
  "mkt-review-delete",
  "mkt-review-put",
  "mkt-review-report",
  "mkt-review-respond",
  "mkt-reviews",
  "mkt-stripe-onboarding",
  "mkt-uninstall",
] as const;

/** Channels whose callers destructure a bare array. */
const EMPTY_LIST = [
  "glyphh-threads-list",
] as const;

export function registerAgentStubs(): void {
  for (const ch of ENVELOPE) {
    ipcMain.handle(ch, () => ({ ok: false, error: RETIRED }));
  }
  for (const ch of EMPTY_LIST) {
    ipcMain.handle(ch, () => []);
  }
  // Shape-specific dead ends — callers read named fields, not the envelope.
  // Background/resident mode is gone — report it off, refuse to arm it.
  ipcMain.handle("get-background-mode", () => false);
  ipcMain.handle("set-background-mode", () => false);
}
