/**
 * pipedream-view.ts — the Connections page's Pipedream logic that needs no
 * DOM: the connected accounts as one row per app, a directory page merged
 * into what is already shown, and what a connect's progress reads as.
 * Pure, so the unit tests run it bare (settings-connections.ts paints it).
 */

export interface PdAccountLike {
  id: string;
  app: string;
  appName: string;
  icon: string | null;
  healthy: boolean;
  dead: boolean;
  createdAt: string;
  enabled: boolean;
}

/** One connected app: every account of it, its switch, and its health. */
export interface PdAppRow {
  app: string;
  name: string;
  icon: string | null;
  enabled: boolean;
  /** Some account of it works; false when every account is dead or unhealthy. */
  healthy: boolean;
  accounts: PdAccountLike[];
}

/** The accounts as one row per app, by name. Two accounts of one app share
 *  its MCP server and its switch, so they share a row too. */
export function pdAppRows(accounts: readonly PdAccountLike[]): PdAppRow[] {
  const by = new Map<string, PdAppRow>();
  for (const a of accounts) {
    if (!a.app) continue;
    const row = by.get(a.app) ?? { app: a.app, name: a.appName || a.app, icon: a.icon, enabled: a.enabled !== false, healthy: false, accounts: [] };
    row.accounts.push(a);
    if (!a.dead && a.healthy) row.healthy = true;
    if (!row.icon && a.icon) row.icon = a.icon;
    by.set(a.app, row);
  }
  return [...by.values()].sort((x, y) => x.name.localeCompare(y.name));
}

/** A directory page appended to what is shown, without repeating an app the
 *  cursor hands back twice. */
export function mergeApps<T extends { slug: string }>(have: readonly T[], page: readonly T[]): T[] {
  const seen = new Set(have.map((a) => a.slug));
  return [...have, ...page.filter((a) => !seen.has(a.slug) && (seen.add(a.slug), true))];
}

export type PdProgressLike =
  | { phase: "opening"; app: string }
  | { phase: "waiting"; app: string; url: string }
  | { phase: "done"; app: string; ok: boolean; error?: string; cancelled?: boolean };

/** The line a Connect button's card shows while the flow runs; "" once done. */
export function connectProgressText(p: PdProgressLike | undefined): string {
  if (!p) return "";
  if (p.phase === "opening") return "Opening Pipedream…";
  if (p.phase === "waiting") return "Finish connecting in the Pipedream window…";
  return "";
}

/** "proj_abc123" is the only shape Pipedream hands out; say so before the
 *  save does. Empty = fine. */
export function projectIdProblem(v: string): string {
  const s = v.trim();
  if (!s) return "The project ID is required.";
  return /^proj_[A-Za-z0-9]+$/.test(s) ? "" : "A project ID looks like proj_abc123.";
}
