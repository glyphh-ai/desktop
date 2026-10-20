/**
 * commands/rotor.ts — run a rotor turn against a runtime and stream its events.
 * Covers `client.session` (the rotor transport). Fleshed out in the sessions phase;
 * already works end-to-end against `rrotor serve`.
 */

import { readFileSync } from "node:fs";
import type { CommandRegistry } from "../registry.js";
import { flagStr } from "../args.js";
import { isWireEvent } from "../../protocol/events.js";

export function registerRotor(reg: CommandRegistry): void {
  reg.register({
    path: "run",
    summary: "stream a rotor turn against a runtime",
    usage: "run <prompt> --rotor <name|path.yaml> --url <runtimeUrl> [--token <t>]",
    covers: ["session"],
    async run(ctx, args) {
      const prompt = args.positional[0];
      const rotorArg = flagStr(args, "rotor");
      const url = flagStr(args, "url") ?? ctx.config.server;
      if (!prompt || !rotorArg) throw new Error("usage: run <prompt> --rotor <name|path> [--url <runtimeUrl>]");

      const rotor = rotorArg.includes(".") || rotorArg.includes("/") ? readFileSync(rotorArg, "utf8") : rotorArg;
      const token = flagStr(args, "token");
      const session = ctx.client.session({ rotor, url, ...(token ? { token: async () => token } : {}) });
      const run = session.turn(prompt);
      for await (const ev of run.events) {
        if (isWireEvent(ev)) ctx.print(`  ${ev.kind}${"seq" in ev ? ` #${ev.seq}` : ""}`);
        else ctx.print(`  · ${ev.kind}`);
      }
      const result = await run.done;
      ctx.print(`done: ${result.status} (${result.runId})`);
    },
  });
}
