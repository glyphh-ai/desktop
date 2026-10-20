/**
 * commands/marketing.ts — trackable marketing links + click analytics (super_admin).
 * One command per SDK method; `covers` keeps the parity test honest.
 */

import type { CommandRegistry } from "../registry.js";
import type { CliArgs } from "../args.js";
import { flagStr } from "../args.js";
import type { UpdateLinkInput } from "../../contract/marketing.js";

function flagNum(args: CliArgs, name: string): number | undefined {
  const v = flagStr(args, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function registerMarketing(reg: CommandRegistry): void {
  reg.register({
    path: "marketing links",
    summary: "list marketing links (super_admin)",
    usage: "marketing links [--q <search>] [--campaign <c>] [--page <n>] [--limit <n>]",
    covers: ["marketing.links"],
    async run(ctx, args) {
      ctx.printJson(await ctx.client.marketing.links({ q: flagStr(args, "q"), campaign: flagStr(args, "campaign"), page: flagNum(args, "page"), limit: flagNum(args, "limit") }));
    },
  });

  reg.register({
    path: "marketing link",
    summary: "a link's detail",
    usage: "marketing link <id>",
    covers: ["marketing.link"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: marketing link <id>");
      ctx.printJson(await ctx.client.marketing.link(id));
    },
  });

  reg.register({
    path: "marketing create",
    summary: "create a trackable link",
    usage: "marketing create <slug> <url> [--label <l>] [--campaign <c>] [--expires <iso>]",
    covers: ["marketing.create"],
    async run(ctx, args) {
      const [slug, url] = args.positional;
      if (!slug || !url) throw new Error("usage: marketing create <slug> <url> [--label ..] [--campaign ..] [--expires ..]");
      ctx.printJson(await ctx.client.marketing.create({
        slug, url,
        ...(flagStr(args, "label") !== undefined ? { label: flagStr(args, "label")! } : {}),
        ...(flagStr(args, "campaign") !== undefined ? { campaign: flagStr(args, "campaign")! } : {}),
        ...(flagStr(args, "expires") !== undefined ? { expiresAt: flagStr(args, "expires")! } : {}),
      }));
    },
  });

  reg.register({
    path: "marketing update",
    summary: "edit a link",
    usage: "marketing update <id> [--label <l>] [--url <u>] [--campaign <c>] [--active true|false] [--expires <iso|clear>]",
    covers: ["marketing.update"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: marketing update <id> [--label ..] [--url ..] [--campaign ..] [--active ..] [--expires ..]");
      const patch: UpdateLinkInput = {};
      const label = flagStr(args, "label"); if (label !== undefined) patch.label = label;
      const url = flagStr(args, "url"); if (url !== undefined) patch.url = url;
      const campaign = flagStr(args, "campaign"); if (campaign !== undefined) patch.campaign = campaign;
      if ("active" in args.flags) patch.isActive = String(args.flags.active) === "true";
      const expires = flagStr(args, "expires"); if (expires !== undefined) patch.expiresAt = expires === "clear" ? null : expires;
      ctx.printJson(await ctx.client.marketing.update(id, patch));
    },
  });

  reg.register({
    path: "marketing delete",
    summary: "delete a link",
    usage: "marketing delete <id>",
    covers: ["marketing.remove"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: marketing delete <id>");
      await ctx.client.marketing.remove(id);
      ctx.print("deleted ✓");
    },
  });

  reg.register({
    path: "marketing link stats",
    summary: "a link's per-day clicks",
    usage: "marketing link stats <id>",
    covers: ["marketing.linkStats"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: marketing link stats <id>");
      ctx.printJson(await ctx.client.marketing.linkStats(id));
    },
  });

  reg.register({
    path: "marketing link clicks",
    summary: "a link's raw click stream",
    usage: "marketing link clicks <id> [--page <n>] [--limit <n>]",
    covers: ["marketing.clicks"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: marketing link clicks <id> [--page ..] [--limit ..]");
      ctx.printJson(await ctx.client.marketing.clicks(id, flagNum(args, "page") ?? 1, flagNum(args, "limit") ?? 20));
    },
  });

  reg.register({
    path: "marketing reset",
    summary: "reset a link's click counter",
    usage: "marketing reset <id>",
    covers: ["marketing.reset"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: marketing reset <id>");
      ctx.printJson(await ctx.client.marketing.reset(id));
    },
  });

  reg.register({
    path: "marketing stats",
    summary: "aggregate campaign overview",
    usage: "marketing stats [--campaign <c>] [--from <YYYY-MM-DD>] [--to <YYYY-MM-DD>]",
    covers: ["marketing.stats"],
    async run(ctx, args) {
      ctx.printJson(await ctx.client.marketing.stats({ campaign: flagStr(args, "campaign"), from: flagStr(args, "from"), to: flagStr(args, "to") }));
    },
  });
}
