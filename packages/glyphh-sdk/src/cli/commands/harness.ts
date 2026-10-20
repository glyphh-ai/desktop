/**
 * commands/harness.ts — run an interactive harness turn against a HARNESS pod
 * (`glyphh.harness/v1`) and stream its frames. Covers `client.harness`.
 */

import type { CommandRegistry } from "../registry.js";
import { flagStr } from "../args.js";

export function registerHarness(reg: CommandRegistry): void {
  reg.register({
    path: "harness run",
    summary: "stream a harness turn against a session pod",
    usage: "harness run <prompt> --url <podUrl> [--token <gy_rk_…>] [--thread <id>] [--mode chat|cowork|code]",
    covers: ["harness"],
    async run(ctx, args) {
      const prompt = args.positional[0];
      const url = flagStr(args, "url");
      if (!prompt || !url) throw new Error("usage: harness run <prompt> --url <podUrl> [--token <t>] [--thread <id>] [--mode <m>]");
      const token = flagStr(args, "token");
      const thread = flagStr(args, "thread");
      const mode = flagStr(args, "mode");

      const pod = ctx.client.harness({ url, ...(token ? { token: async () => token } : {}) });
      const run = pod.start({
        prompt,
        surface: "cli", // the window tools act where the caller is (HarnessSurface)
        ...(thread ? { threadId: thread } : {}),
        ...(mode === "chat" || mode === "cowork" || mode === "code" ? { mode } : {}),
      });
      run.on((f) => {
        if (f.type === "delta") process.stdout.write(f.delta);
        else ctx.print(`  · ${f.type}${f.type === "tool" ? ` ${f.name} (${f.phase})` : ""}`);
      });
      const ack = await run.whenStarted;
      const result = await run.done;
      ctx.print("");
      ctx.print(`done: ${result.stopped ? "stopped" : result.error ? `error — ${result.error}` : "ok"} (${ack.runId})`);
    },
  });
}
