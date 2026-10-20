/**
 * commands/icons.ts — the icon resolver. `icons url` prints the SDK-built
 * `/api/icons` URL for a domain (the one clients embed instead of hand-building).
 */

import type { CommandRegistry } from "../registry.js";

export function registerIcons(reg: CommandRegistry): void {
  reg.register({
    path: "icons url",
    summary: "the resolver URL for a domain's icon",
    usage: "icons url <domain>",
    covers: ["icons.urlFor"],
    async run(ctx, args) {
      const domain = args.positional[0];
      if (!domain) throw new Error("usage: icons url <domain>");
      ctx.print(ctx.client.icons.urlFor(domain));
    },
  });
}
