/**
 * commands/memberships.ts — the caller's org-switcher: list the orgs you belong to
 * and switch which one this session acts in. One command per SDK method; `covers`
 * keeps the parity test honest.
 */

import type { CommandRegistry } from "../registry.js";

export function registerMemberships(reg: CommandRegistry): void {
  reg.register({
    path: "orgs",
    summary: "the orgs you belong to (the active one flagged)",
    covers: ["memberships.orgs"],
    async run(ctx) {
      ctx.printJson(await ctx.client.memberships.orgs());
    },
  });

  reg.register({
    path: "use-org",
    summary: "switch this session's active org (must be a member)",
    usage: "use-org <orgId>",
    covers: ["memberships.setActiveOrg"],
    async run(ctx, args) {
      const orgId = args.positional[0];
      if (!orgId) throw new Error("usage: use-org <orgId>");
      ctx.printJson(await ctx.client.memberships.setActiveOrg(orgId));
    },
  });
}
