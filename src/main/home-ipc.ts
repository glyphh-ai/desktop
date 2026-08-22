/**
 * home-ipc — IPC for the Settings / home panel: the usage dashboard, the
 * MCP server manager, app connectors, exposed-MCP tokens, and the prompt log.
 *
 * (Formerly bundled into drop-ipc; the Drop is gone, these handlers are not.)
 */

import { ipcMain, webContents } from "electron";
import type { McpManager } from "./mcp-manager";
import type { ConnectorManager } from "./connectors";
import { getAccountInfo, getAuthStatus } from "./auth";
import { getClient } from "./glyphh-client";
import { ForbiddenError } from "@glyphh/sdk";

interface HomeIpcDeps {
  mcpManager: McpManager | null;
  connectorManager: ConnectorManager | null;
  canUseCustomMcp: () => { allowed: boolean; reason?: string };
}

export function registerHomeIpc(deps: HomeIpcDeps): void {
  const { mcpManager, connectorManager, canUseCustomMcp } = deps;

  // ── Home dashboard ──────────────────────────────────────────────────────
  // Credits, month spend, apps deployed, and a per-day usage series (credits
  // + calls). LLM tokens are deliberately NOT a client concept — the client
  // never meters models; usage here is compute. Mirrors the platform's
  // billing/usage endpoints; each call degrades to null so one failure
  // doesn't blank the whole card set. Credit amounts arrive in micro-credits
  // (1 credit = 1e6) → /1e6.
  // The SHELL (boot gate / tutorial) steering the home panel's section —
  // e.g. "land on Home after the first-run walkthrough".
  ipcMain.handle("home-goto-section", (_e, section: string) => {
    const homes = webContents.getAllWebContents().filter((wc) => {
      try { return !wc.isDestroyed() && /home\.html/.test(wc.getURL()); } catch { return false; }
    });
    for (const wc of homes) wc.send("home:goto-section", String(section));
    return { ok: true };
  });

  // Every RUN across every agent's tasks — the dashboard's recent-runs list.
  // Newest first, capped: the dashboard shows a page of 5, so 60 is plenty.
  ipcMain.handle("dashboard-runs", async () => {
    try {
      const client = getClient();
      const agents = await client.agents.list();
      const perAgent = await Promise.all(agents.map(async (agent) => {
        const tasks = await client.agents.tasks(agent.id).catch(() => []);
        const perTask = await Promise.all(tasks.map(async (task) => {
          const runs = await client.agents.taskRuns(agent.id, task.id).catch(() => []);
          return runs.map((run) => ({
            runId: run.id,
            agentId: agent.id,
            agentName: agent.name,
            taskName: task.name,
            target: task.target,
            startedAt: run.startedAt,
            durationMs: run.durationMs,
            status: run.status,
            error: run.error,
            output: run.output,
          }));
        }));
        return perTask.flat();
      }));
      const all = perAgent.flat().sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
      return { ok: true, data: all.slice(0, 60) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // The stacked usage chart's feed: day × (model | source) cells over the last
  // N days. Credits leave here as WHOLE credits — the renderer never sees micro.
  ipcMain.handle("usage-series", async (_e, days: number, groupBy: string, userId?: string) => {
    try {
      const MICRO = 1_000_000;
      const ymd = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const now = new Date();
      const win = Math.max(1, Math.min(Number(days) || 30, 365));
      const start = new Date(now); start.setDate(now.getDate() - (win - 1));
      const gb = groupBy === "source" ? "source" as const : "model" as const;
      // A member narrowing is org_admin-only server-side; pass it only when set
      // so a member's request stays exactly what it was.
      const member = typeof userId === "string" && userId ? { userId } : {};
      const { points } = await getClient().usage.series({
        from: ymd(start), to: ymd(now), groupBy: gb,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...member,
      });
      return {
        ok: true,
        data: {
          from: ymd(start), to: ymd(now),
          points: points.map((pt) => ({ ...pt, credits: pt.credits / MICRO })),
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("dashboard-data", async () => {
    const MICRO = 1_000_000;
    const ymd = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const now = new Date();

    const client = getClient();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const [credits, me, usage, apps] = await Promise.all([
      // Org pool — admins only; members get a 403 (→ null) and the personal
      // allocation card below renders from the caller's allocation instead.
      client.billing.credits().catch(() => null),
      client.usage.allocation().catch(() => null),
      // The caller's month-to-date spend; the SERVER owns the month boundary
      // math so this matches what an org admin sees for the same user.
      // NO upper bound: `to` is EXCLUSIVE and a bare date parses as UTC
      // midnight — passing today would chop off everything spent today
      // (which zeroed this card). Omitted = "through now".
      client.usage.summary({ from: ymd(monthStart) }).catch(() => null),
      client.apps.deployed().catch(() => null),
    ]);

    const acct = getAccountInfo();
    return {
      name: (acct?.firstName || "").trim(),
      plan: getAuthStatus().tier || "",
      // null credits = the org pool is admin-only for this account — the
      // renderer swaps in the member card fed by `me`.
      orgCredits: credits != null,
      // The renderer's member card was built around the old /api/me/credits
      // shape; `roleName` maps to the allocation's workspace name.
      me: me
        ? {
            roleName: me.workspaceName || null,
            uncapped: me.uncapped,
            capCredits: me.capCredits,
            spentCredits: me.spentCredits,
            remainingCredits: me.remainingCredits,
            windowEnd: me.windowEnd || null,
          }
        : null,
      credits: Math.floor((credits?.balance || 0) / MICRO),
      allowance: Math.floor((credits?.allowance || 0) / MICRO),
      // UsageSummary.credits is already WHOLE credits (the summary endpoint
      // converts from micro server-side) — dividing again zeroed this card.
      spendCredits: Math.round(usage?.credits || 0),
      // The summary counts ledger events — one per metered request.
      requests: usage?.events || 0,
      // Count live deployments only, exactly like the Apps tab: the seeded
      // system app (system:true) is not a deployed app.
      appsCount: Array.isArray(apps) ? apps.filter((a) => !a.system && a.url).length : 0,
    };
  });

  // (Local MCP server IPC removed — the desktop hosts no local MCP surface.)

  // Custom MCP connections live server-side (apps-ipc: mcp-connections-*);
  // this gate only drives the Connections page's show/hide. The old policy
  // endpoint is gone — governance is the workspace gate on the personal
  // custom-MCP surface, so probe it: a 403 means the workspace disallows
  // custom MCP; any other failure (offline) falls back to the local gate.
  ipcMain.handle("mcp-custom-allowed", async () => {
    try {
      await getClient().connections.personalMcpList();
      return { allowed: true };
    } catch (err) {
      if (err instanceof ForbiddenError) return { allowed: false, reason: "Custom MCP connections are disabled by your organization." };
      return canUseCustomMcp();
    }
  });

  ipcMain.handle("connectors-get-apps", async (_e, search?: string, offset?: number) => {
    if (!connectorManager) return { apps: [], hasMore: false };
    return connectorManager.getApps(search, offset);
  });
  ipcMain.handle("connectors-get-accounts", async () => {
    if (!connectorManager) return [];
    return connectorManager.getAccounts();
  });
  ipcMain.handle("connectors-connect", async (_e, appSlug: string) => {
    if (!connectorManager) return { ok: false, error: "Not initialized" };
    return connectorManager.connectApp(appSlug);
  });
  ipcMain.handle("connectors-disconnect", async (_e, accountId: string) => {
    if (!connectorManager) return false;
    return connectorManager.disconnectAccount(accountId);
  });
  ipcMain.handle("connectors-refresh-mcp", async () => {
    if (!connectorManager) return { ok: false, error: "Not initialized", toolCount: 0 };
    return connectorManager.refreshMcp();
  });
  ipcMain.handle("connectors-list-tools", async () => {
    if (!connectorManager) return [];
    return connectorManager.listTools();
  });

}
