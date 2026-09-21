/**
 * routing.ts — WHICH LANE a Claude Desktop turn takes (BRIDGE-MODE.md §4).
 *
 * The org admin owns the table on the gateway; the bridge only executes it.
 * First matching row wins, "*" is the default, a trailing "*" matches a
 * prefix. No row at all means the gateway lane on the name as asked.
 */

export type Lane = "gateway" | "account";
export type Permission = "read-only" | "plan" | "edits" | "auto";

export interface RoutingRow {
  model: string;
  lane: Lane;
  target?: string;
  permission?: Permission;
  chatOnly?: boolean;
}

export interface Decision {
  lane: Lane;
  /** The model the lane runs: the row's target on the gateway, the name as asked otherwise. */
  model: string;
  permission: Permission;
  chatOnly: boolean;
}

const LANES: ReadonlySet<string> = new Set(["gateway", "account"]);
const PERMISSIONS: ReadonlySet<string> = new Set(["read-only", "plan", "edits", "auto"]);

/** Rows as the server hands them, dropping anything malformed rather than failing the turn. */
export function parseRows(raw: unknown): RoutingRow[] {
  if (!Array.isArray(raw)) return [];
  const out: RoutingRow[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const model = typeof o.model === "string" ? o.model.trim() : "";
    const lane = typeof o.lane === "string" ? o.lane : "";
    if (!model || !LANES.has(lane)) continue;
    const row: RoutingRow = { model, lane: lane as Lane };
    if (typeof o.target === "string" && o.target.trim()) row.target = o.target.trim();
    if (typeof o.permission === "string" && PERMISSIONS.has(o.permission)) row.permission = o.permission as Permission;
    if (o.chatOnly === true) row.chatOnly = true;
    out.push(row);
  }
  return out;
}

function matches(pattern: string, model: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return model.startsWith(pattern.slice(0, -1));
  return pattern === model;
}

export function decide(rows: readonly RoutingRow[], model: string): Decision {
  const row = rows.find((r) => matches(r.model, model));
  if (!row) return { lane: "gateway", model, permission: "read-only", chatOnly: false };
  return {
    lane: row.lane,
    model: row.lane === "gateway" && row.target ? row.target : model,
    permission: row.permission ?? "read-only",
    chatOnly: row.chatOnly === true,
  };
}
