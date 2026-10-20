/**
 * commands/billing.ts — plans, subscription status, the budget, and the Stripe
 * checkout/portal handoff (prints the URL to open).
 */

import type { CommandRegistry } from "../registry.js";

export function registerBilling(reg: CommandRegistry): void {
  reg.register({
    path: "billing plans",
    summary: "list plans (tier, price, monthly pool, seats)",
    covers: ["billing.plans"],
    async run(ctx) {
      ctx.printJson(await ctx.client.billing.plans());
    },
  });

  reg.register({
    path: "billing status",
    summary: "the org's subscription state",
    covers: ["billing.status"],
    async run(ctx) {
      ctx.printJson(await ctx.client.billing.status());
    },
  });

  reg.register({
    path: "billing reconcile",
    summary: "self-heal the org's billing from Stripe (missed webhook) → refreshed status",
    covers: ["billing.reconcile"],
    async run(ctx) {
      ctx.printJson(await ctx.client.billing.reconcile());
    },
  });

  reg.register({
    path: "billing budget",
    summary: "your own budget this period: your organization's limit plus what runs through Glyphh",
    covers: ["billing.myBudget"],
    async run(ctx) {
      ctx.printJson(await ctx.client.billing.myBudget());
    },
  });

  reg.register({
    path: "billing balance",
    summary: "the org's budget this period (plan pool, funds, spent, remaining — dollars)",
    covers: ["billing.balance"],
    async run(ctx) {
      ctx.printJson(await ctx.client.billing.balance());
    },
  });

  reg.register({
    path: "billing invoices",
    summary: "recent Stripe invoices for the org",
    covers: ["billing.invoices"],
    async run(ctx) {
      ctx.printJson(await ctx.client.billing.invoices());
    },
  });

  reg.register({
    path: "billing change-plan",
    summary: "move the org's plan (proration applied); prints the change (or a Checkout URL)",
    usage: "billing change-plan <basic|pro>",
    covers: ["billing.changePlan"],
    async run(ctx, args) {
      const tier = args.positional[0];
      if (!tier) throw new Error("usage: billing change-plan <basic|pro>");
      ctx.printJson(await ctx.client.billing.changePlan(tier));
    },
  });

  reg.register({
    path: "billing topup",
    summary: "add funds to the budget (whole dollars, min 5); prints the Stripe Checkout URL",
    usage: "billing topup <usd>",
    covers: ["billing.topup"],
    async run(ctx, args) {
      const usd = Number(args.positional[0]);
      if (!Number.isFinite(usd) || usd < 5) throw new Error("usage: billing topup <usd> (minimum 5)");
      ctx.print((await ctx.client.billing.topup({ usd })).url ?? "(no checkout url)");
    },
  });

  reg.register({
    path: "billing autotopup",
    summary: "the org's auto-reload rule (dollars)",
    covers: ["billing.autotopup"],
    async run(ctx) {
      ctx.printJson(await ctx.client.billing.autotopup());
    },
  });

  reg.register({
    path: "billing autotopup set",
    summary: "configure auto-reload (dollars)",
    usage: "billing autotopup set <on|off> <thresholdUsd> <topupUsd>",
    covers: ["billing.setAutotopup"],
    async run(ctx, args) {
      const [state, threshold, topup] = args.positional;
      if (!state || (state !== "on" && state !== "off")) throw new Error("usage: billing autotopup set <on|off> <thresholdUsd> <topupUsd>");
      const enabled = state === "on";
      const thresholdUsd = Number(threshold ?? 0);
      const topupUsd = Number(topup ?? 0);
      if (enabled && (!(thresholdUsd > 0) || !(topupUsd > 0))) {
        throw new Error("thresholdUsd and topupUsd must be positive when enabling");
      }
      ctx.printJson(await ctx.client.billing.setAutotopup({ enabled, thresholdUsd, topupUsd }));
    },
  });

  reg.register({
    path: "billing subscribe",
    summary: "start a checkout for a tier (prints the Stripe URL)",
    usage: "billing subscribe <basic|pro>",
    covers: ["billing.subscribe"],
    async run(ctx, args) {
      const tier = args.positional[0];
      if (!tier) throw new Error("usage: billing subscribe <basic|pro>");
      ctx.print((await ctx.client.billing.subscribe(tier)).url);
    },
  });

  reg.register({
    path: "billing portal",
    summary: "open the Stripe customer portal (prints the URL)",
    covers: ["billing.portal"],
    async run(ctx) {
      ctx.print((await ctx.client.billing.portal()).url);
    },
  });
}
