/**
 * commands/usage.ts — usage rollups (dollars, by source) at the user, workspace,
 * and org level.
 */

import type { CommandRegistry } from "../registry.js";
import { flagStr } from "../args.js";

export function registerUsage(reg: CommandRegistry): void {
  reg.register({
    path: "usage mine",
    summary: "your usage (dollars, by source)",
    covers: ["usage.mine"],
    async run(ctx) {
      ctx.printJson(await ctx.client.usage.mine());
    },
  });

  reg.register({
    path: "usage summary",
    summary: "windowed totals (org for an admin, your own otherwise)",
    usage: "usage summary [--from <ISO|YYYY-MM-DD>] [--to <ISO|YYYY-MM-DD>]",
    covers: ["usage.summary"],
    async run(ctx, args) {
      const from = flagStr(args, "from");
      const to = flagStr(args, "to");
      ctx.printJson(await ctx.client.usage.summary({ ...(from ? { from } : {}), ...(to ? { to } : {}) }));
    },
  });

  reg.register({
    path: "usage workspace",
    summary: "a workspace's usage rollup",
    usage: "usage workspace <workspaceId>",
    covers: ["usage.workspace"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: usage workspace <workspaceId>");
      ctx.printJson(await ctx.client.usage.workspace(id));
    },
  });

  reg.register({
    path: "usage org",
    summary: "the org usage rollup (org_admin)",
    covers: ["usage.org"],
    async run(ctx) {
      ctx.printJson(await ctx.client.usage.org());
    },
  });

  reg.register({
    path: "usage by-model",
    summary: "usage attributed by model (org_admin sees the org; members see self)",
    usage: "usage by-model [--from <YYYY-MM-DD>] [--to <YYYY-MM-DD>] [--user <userId>]",
    covers: ["usage.byModel"],
    async run(ctx, args) {
      const from = flagStr(args, "from");
      const to = flagStr(args, "to");
      const userId = flagStr(args, "user");
      ctx.printJson(
        await ctx.client.usage.byModel({
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
          ...(userId ? { userId } : {}),
        }),
      );
    },
  });

  reg.register({
    path: "usage series",
    summary: "day-by-day usage grouped by model, source, or member (the chart feed)",
    usage: "usage series <from:YYYY-MM-DD> <to:YYYY-MM-DD> [--group model|source|user] [--model <id>] [--source <s>] [--tz <IANA>] [--user <userId>]",
    covers: ["usage.series"],
    async run(ctx, args) {
      const from = args.positional[0];
      const to = args.positional[1];
      if (!from || !to) throw new Error("usage: usage series <from> <to> [--group model|source|user]");
      const groupRaw = flagStr(args, "group");
      if (groupRaw && groupRaw !== "model" && groupRaw !== "source" && groupRaw !== "user") {
        throw new Error("usage: --group must be model, source, or user");
      }
      const groupBy = groupRaw as "model" | "source" | "user" | undefined;
      const tz = flagStr(args, "tz");
      const model = flagStr(args, "model");
      const source = flagStr(args, "source");
      const userId = flagStr(args, "user");
      ctx.printJson(
        await ctx.client.usage.series({
          from, to,
          ...(groupBy ? { groupBy } : {}),
          ...(tz ? { tz } : {}),
          ...(model ? { model } : {}),
          ...(source ? { source } : {}),
          ...(userId ? { userId } : {}),
        }),
      );
    },
  });

  reg.register({
    path: "usage daily",
    summary: "per-day org usage series for a date range",
    usage: "usage daily <from:YYYY-MM-DD> <to:YYYY-MM-DD> [--tz <IANA>] [--user <userId>]",
    covers: ["usage.daily"],
    async run(ctx, args) {
      const from = args.positional[0];
      const to = args.positional[1];
      if (!from || !to) throw new Error("usage: usage daily <from> <to> [--tz <IANA>] [--user <userId>]");
      const tz = flagStr(args, "tz");
      const userId = flagStr(args, "user");
      ctx.printJson(
        await ctx.client.usage.daily({
          from,
          to,
          ...(tz ? { tz } : {}),
          ...(userId ? { userId } : {}),
        }),
      );
    },
  });
}
