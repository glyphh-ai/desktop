/**
 * contract/usage.ts — usage rollups. Everything flows user → workspace → org from
 * one spend log (GlyphhRouter's), so a summary at any level is a sum of the same rows.
 * Money is DOLLARS: `usd` is what the window cost, split by source — Pipedream
 * calls through Glyphh (the org's budget) and provider calls (the org's own dollars on
 * its gateway keys).
 */

export interface UsageSummary {
  /** Dollars spent in the window. */
  usd: number;
  /** Dollar breakdown by source. */
  bySource: {
    pipedream: number;
    provider: number;
  };
  /** Number of spend-log events. */
  events: number;
}

/** A reporting window for {@link UsageClient.summary}; both bounds ISO or YYYY-MM-DD. */
export interface UsageSummaryQuery {
  from?: string;
  to?: string;
}

/** One day of the org usage series (dollars; only days with usage). */
export interface UsageDay {
  day: string; // YYYY-MM-DD
  usd: number; // dollars
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** Query for the per-day series. `from`/`to` are YYYY-MM-DD; `tz` defaults to UTC. */
export interface UsageDailyQuery {
  from: string;
  to: string;
  tz?: string;
  /** org_admin only — break the org series down to one member. */
  userId?: string;
}

/** One model's usage rollup (dollars). */
export interface UsageByModelRow {
  model: string;
  usd: number; // dollars
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

/** Query for the by-model rollup. `from`/`to` are YYYY-MM-DD (optional; all time when omitted). */
export interface UsageByModelQuery {
  from?: string;
  to?: string;
  /** org_admin only — drill into one member (members are pinned to their own usage). */
  userId?: string;
}

/** The stack dimension for the day × group series. */
export type UsageSeriesGroupBy = "model" | "source" | "user";

/** One (day, group) cell of the usage chart (dollars). */
export interface UsageSeriesPoint {
  day: string;
  /** The group's value: a model id, a source, or a user id ("(none)" when unattributed). */
  key: string;
  usd: number; // dollars
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

/** Query for the day × group series. `from`/`to` are YYYY-MM-DD, bucketed in `tz`. */
export interface UsageSeriesQuery {
  from: string;
  to: string;
  tz?: string;
  /** The stack dimension (default "model"; "user" is org_admin only). */
  groupBy?: UsageSeriesGroupBy;
  /** Optional exact-match dimension filters applied before grouping. */
  model?: string;
  source?: string;
  /** org_admin only — pin the series to one member. */
  userId?: string;
}
