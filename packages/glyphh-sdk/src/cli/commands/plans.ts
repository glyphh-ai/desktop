/**
 * cli/commands/plans.ts — what the org's plan entitles it to.
 *
 * The ONE licensing read. Every surface asks this rather than testing a
 * feature flag, so what the CLI reports here is exactly what the app enforces.
 */

import type { CommandRegistry } from "../registry.js";
import type { PlanCapability } from "../../resources/plans.js";

const CAPABILITIES: PlanCapability[] = ["governance", "sso", "gateway"];

export function registerPlans(reg: CommandRegistry): void {
  reg.register({
    path: "plans gates",
    summary: "the org's entitlements (--refresh to bypass the 60s cache)",
    usage: "plans gates [--refresh]",
    covers: ["plans.gates", "plans.invalidate"],
    async run(ctx, args) {
      if (args.flags.refresh) ctx.client.plans.invalidate();
      ctx.printJson(await ctx.client.plans.gates());
    },
  });

  reg.register({
    path: "plans allows",
    summary: "whether the org's plan permits one capability",
    usage: "plans allows <capability>",
    covers: ["plans.allows"],
    async run(ctx, args) {
      const capability = args.positional[0] as PlanCapability | undefined;
      if (!capability || !CAPABILITIES.includes(capability)) {
        throw new Error(`usage: plans allows <${CAPABILITIES.join("|")}>`);
      }
      ctx.printJson({ capability, allowed: await ctx.client.plans.allows(capability) });
    },
  });
}
