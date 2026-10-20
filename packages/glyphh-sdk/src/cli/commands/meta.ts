/**
 * commands/meta.ts — CLI conveniences that aren't SDK methods: server probes and
 * the config server target. (No `covers` — parity only tracks SDK methods.)
 */

import type { CommandRegistry } from "../registry.js";
import { saveConfig } from "../config.js";

export function registerMeta(reg: CommandRegistry): void {
  reg.register({
    path: "health",
    summary: "probe the server (/healthz + /readyz)",
    async run(ctx) {
      const at = async (p: string) => {
        try {
          return (await fetch(`${ctx.config.server}${p}`)).status;
        } catch {
          return "unreachable";
        }
      };
      ctx.print(`healthz=${await at("/healthz")}  readyz=${await at("/readyz")}`);
    },
  });

  reg.register({
    path: "server",
    summary: "show or set the server URL (persisted)",
    usage: "server [<url>]",
    async run(ctx, args) {
      const url = args.positional[0];
      if (!url) return ctx.print(ctx.config.server);
      ctx.config.server = url;
      saveConfig(ctx.config);
      ctx.print(`server → ${url} (restart the REPL to reconnect)`);
    },
  });
}
