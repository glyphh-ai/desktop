/**
 * commands/attach.ts — the attached desktop. `attach status` shows whether the
 * caller's Glyphh desktop is live; `attach dispatch <method> [json]` runs a
 * method on it (panels.list, rpa.click, loops.run, scrape.page, …). Self only —
 * it always targets the caller's own machine.
 */

import type { CommandRegistry } from "../registry.js";

export function registerAttach(reg: CommandRegistry): void {
  reg.register({
    path: "attach status",
    summary: "whether your desktop is attached, and what it can do",
    covers: ["attach.status"],
    async run(ctx) {
      ctx.printJson(await ctx.client.attach.status());
    },
  });

  reg.register({
    path: "attach dispatch",
    summary: "run a method on your attached desktop",
    usage: "attach dispatch <method> [paramsJson]",
    covers: ["attach.dispatch"],
    async run(ctx, args) {
      const method = args.positional[0];
      if (!method) throw new Error("usage: attach dispatch <method> [paramsJson]");
      let params: Record<string, unknown> = {};
      if (args.positional[1]) {
        try { params = JSON.parse(args.positional[1]) as Record<string, unknown>; }
        catch { throw new Error("params must be valid JSON"); }
      }
      ctx.printJson(await ctx.client.attach.dispatch(method, params));
    },
  });

  reg.register({
    path: "attach fs-list",
    summary: "browse a folder on your attached desktop",
    usage: "attach fs-list [path]",
    covers: ["attach.fsList"],
    async run(ctx, args) {
      const path = args.positional[0];
      ctx.printJson(await ctx.client.attach.fsList(path));
    },
  });
}
