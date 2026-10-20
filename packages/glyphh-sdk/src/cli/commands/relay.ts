/**
 * commands/relay.ts — drive-my-desktop relay. `relay enable <label>` opts a device in,
 * `relay disable <id>` revokes it, `relay status` shows the org policy + your devices,
 * and `relay policy <on|off>` is the org_admin toggle for the whole org.
 */

import type { CommandRegistry } from "../registry.js";

export function registerRelay(reg: CommandRegistry): void {
  reg.register({
    path: "relay status",
    summary: "org relay policy + your opted-in devices",
    covers: ["relay.status"],
    async run(ctx) {
      ctx.printJson(await ctx.client.relay.status());
    },
  });

  reg.register({
    path: "relay enable",
    summary: "opt a device into relay",
    usage: "relay enable <label>",
    covers: ["relay.enable"],
    async run(ctx, args) {
      const label = args.positional[0];
      if (!label) throw new Error("usage: relay enable <label>");
      ctx.printJson(await ctx.client.relay.enable(label));
    },
  });

  reg.register({
    path: "relay disable",
    summary: "revoke a relay device",
    usage: "relay disable <deviceId>",
    covers: ["relay.disable"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: relay disable <deviceId>");
      await ctx.client.relay.disable(id);
      ctx.printJson({ revoked: id });
    },
  });

  reg.register({
    path: "relay policy",
    summary: "set whether the org permits relay (org_admin)",
    usage: "relay policy <on|off>",
    covers: ["relay.setPolicy"],
    async run(ctx, args) {
      const v = args.positional[0];
      if (v !== "on" && v !== "off") throw new Error("usage: relay policy <on|off>");
      ctx.printJson(await ctx.client.relay.setPolicy(v === "on"));
    },
  });
}
