/**
 * commands/guest.ts — the anonymous (no-account) chat surface. These are the ONLY
 * commands that work signed OUT: the guest client rides the unauthenticated
 * transport, so a guest token — not a session bearer — carries the turn. The model
 * is forced to Mistral and the spend is capped per client IP, both server-side.
 */

import type { CommandRegistry } from "../registry.js";
import type { CliArgs } from "../args.js";
import { flagStr, flagBool } from "../args.js";
import type { GuestTurnInput } from "../../contract/gateway.js";

/** Build the turn body shared by `guest messages` and `guest chat`. */
function turnInput(prompt: string, args: CliArgs): GuestTurnInput {
  const input: GuestTurnInput = { messages: [{ role: "user", content: prompt }] };
  const system = flagStr(args, "system");
  if (system !== undefined) input.system = system;
  const max = flagStr(args, "max");
  if (max !== undefined) {
    const n = Number(max);
    if (!Number.isFinite(n) || n <= 0) throw new Error("--max must be a positive number");
    input.maxTokens = n;
  }
  return input;
}

export function registerGuest(reg: CommandRegistry): void {
  reg.register({
    path: "guest token",
    summary: "mint an anonymous guest token (no account needed)",
    usage: "guest token [--id <guestId>]",
    covers: ["guest.token"],
    async run(ctx, args) {
      ctx.printJson(await ctx.client.guest.token(flagStr(args, "id")));
    },
  });

  reg.register({
    path: "guest messages",
    summary: "one guest Anthropic Messages turn, printed raw (bring your own token)",
    usage: 'guest messages <token> "<prompt>" [--system <s>] [--max <tokens>] [--stream]',
    covers: ["guest.messages"],
    async run(ctx, args) {
      const [token, prompt] = args.positional;
      if (!token || !prompt) {
        throw new Error('usage: guest messages <token> "<prompt>" [--system <s>] [--max <tokens>] [--stream]');
      }
      const upstream = await ctx.client.guest.messages(token, {
        ...turnInput(prompt, args),
        ...(flagBool(args, "stream") ? { stream: true } : {}),
      });
      // Raw on purpose: SSE frames or the JSON body, exactly as an interceptor relays them.
      ctx.print(await upstream.text());
    },
  });

  reg.register({
    path: "guest chat",
    summary: "one anonymous chat turn — mints a token for you and prints the message",
    usage: 'guest chat "<prompt>" [--system <s>] [--max <tokens>] [--token <t>] [--id <guestId>]',
    covers: ["guest.chat"],
    async run(ctx, args) {
      const prompt = args.positional.join(" ").trim();
      if (!prompt) {
        throw new Error('usage: guest chat "<prompt>" [--system <s>] [--max <tokens>] [--token <t>] [--id <guestId>]');
      }
      const opts: { token?: string; guestId?: string } = {};
      const bearer = flagStr(args, "token"); if (bearer !== undefined) opts.token = bearer;
      const guestId = flagStr(args, "id"); if (guestId !== undefined) opts.guestId = guestId;
      const { token, message } = await ctx.client.guest.chat(turnInput(prompt, args), opts);
      // Echo the token so the next turn can reuse it instead of minting a new guest.
      ctx.printJson({ token, message });
    },
  });
}
