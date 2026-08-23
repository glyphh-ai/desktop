/**
 * workspaces-ipc — the org-admin Workspaces page's bridge to the control plane.
 *
 * Mirrors the platform's Configure → Workspaces surface. A workspace IS the
 * governance layer: which providers and models a member may reach, which shared
 * and personal connections (down to individual tools), which apps and hosting,
 * whether they may add custom MCP, plus a rate limit and a credit cap.
 *
 * Every handler is a thin, guarded pass through the SDK — the server enforces
 * org_admin on all writes, and the base workspace's undeletability, so a
 * non-admin gets the server's refusal back as `error` rather than a crash.
 *
 * The Connections tab reads from three more surfaces that live elsewhere in the
 * SDK (the org's Pipedream connectors, its custom MCP connections, and the
 * broad app catalog a member may connect with their OWN auth) — they are here
 * rather than in connectors.ts because this page is their only caller in the
 * app, and they are read-only lookups for the pickers.
 */

import { ipcMain } from "electron";
import { getClient } from "./glyphh-client";
import type { WorkspaceInput } from "@glyphh/sdk";

function wrap<T>(fn: () => Promise<T>): Promise<{ ok: boolean; data?: T; error?: string }> {
  return fn()
    .then((data) => ({ ok: true as const, data }))
    .catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
}

export function registerWorkspacesIpc(): void {
  ipcMain.handle("workspaces-list", () => wrap(() => getClient().workspaces.list()));
  ipcMain.handle("workspaces-create", (_e, input: WorkspaceInput) =>
    wrap(() => getClient().workspaces.create(input)));
  ipcMain.handle("workspaces-update", (_e, id: string, input: WorkspaceInput) =>
    wrap(() => getClient().workspaces.update(String(id), input)));
  ipcMain.handle("workspaces-delete", (_e, id: string) =>
    wrap(() => getClient().workspaces.delete(String(id))));
  // The CALLER's effective grants — the app-governance surfaces (Releases-tab
  // Access picker, marketplace install CTA) narrow their controls to it.
  ipcMain.handle("workspaces-grants", () => wrap(() => getClient().workspaces.grants()));

  // ── What the tabs can grant WITHIN ──────────────────────────────────────
  // Models: the org's EFFECTIVE set (global catalog ∩ org-supported ∩ the
  // caller's grants), not the whole catalog — a workspace can only narrow.
  ipcMain.handle("workspaces-model-catalog", () => wrap(() => getClient().models.available()));
  // Shared connections: the org's Pipedream connectors + its custom MCP servers.
  ipcMain.handle("workspaces-org-connectors", () => wrap(async () => {
    const client = getClient();
    const [pipedream, mcp] = await Promise.all([
      client.connections.pipedreamList().catch(() => []),
      client.connections.orgMcpList().catch(() => []),
    ]);
    return { pipedream, mcp };
  }));
  // The ORG-level tool cap (Connections page): { slug: allowedToolNames[] }. A
  // workspace scopes within it, never past it.
  ipcMain.handle("workspaces-org-tool-cap", () => wrap(() => getClient().connections.orgConnectionTools()));
  // The tools one connector advertises — best-effort; unconfigured apps answer
  // with nothing, which the picker renders as "no tools to scope".
  ipcMain.handle("workspaces-conn-tools", (_e, slug: string) =>
    wrap(() => getClient().connections.appTools(String(slug))));
  // The broad app catalog — the universe for PERSONAL connections (apps a
  // member may connect with their own auth).
  ipcMain.handle("workspaces-app-search", (_e, search: string, limit?: number) =>
    wrap(() => getClient().connections.apps({
      ...(search ? { search } : {}),
      limit: Math.max(1, Math.min(50, Number(limit) || 24)),
    })));
}
