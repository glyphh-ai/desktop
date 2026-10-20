/**
 * commands/support.ts — submit a support ticket. One command per SDK method.
 */

import type { CommandRegistry } from "../registry.js";
import { flagStr } from "../args.js";

export function registerSupport(reg: CommandRegistry): void {
  reg.register({
    path: "support ticket",
    summary: "submit a legacy support flare (Discord relay)",
    usage: "support ticket --subject <s> --description <s>",
    covers: ["support.ticket"],
    async run(ctx, args) {
      const subject = flagStr(args, "subject");
      const description = flagStr(args, "description");
      if (!subject || !description) throw new Error("usage: support ticket --subject <s> --description <s>");
      ctx.printJson(await ctx.client.support.ticket({ subject, description }));
    },
  });

  // ── stored ticketing ─────────────────────────────────────────────────────────
  reg.register({
    path: "support new",
    summary: "open a stored support ticket",
    usage: "support new --subject <s> --message <s>",
    covers: ["support.createTicket"],
    async run(ctx, args) {
      const subject = flagStr(args, "subject");
      const message = flagStr(args, "message");
      if (!subject || !message) throw new Error("usage: support new --subject <s> --message <s>");
      ctx.printJson(await ctx.client.support.createTicket({ subject, message }));
    },
  });
  reg.register({
    path: "support list",
    summary: "your support tickets (newest first)",
    covers: ["support.tickets"],
    async run(ctx) {
      ctx.printJson(await ctx.client.support.tickets());
    },
  });
  reg.register({
    path: "support thread",
    summary: "one of your tickets + its full thread",
    usage: "support thread <id>",
    covers: ["support.thread"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: support thread <id>");
      ctx.printJson(await ctx.client.support.thread(id));
    },
  });
  reg.register({
    path: "support reply",
    summary: "reply to one of your tickets",
    usage: "support reply <id> <body...>",
    covers: ["support.reply"],
    async run(ctx, args) {
      const [id, ...rest] = args.positional;
      const body = rest.join(" ").trim();
      if (!id || !body) throw new Error("usage: support reply <id> <body...>");
      ctx.printJson(await ctx.client.support.reply(id, body));
    },
  });
  reg.register({
    path: "support read",
    summary: "mark one of your tickets read",
    usage: "support read <id>",
    covers: ["support.markTicketRead"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: support read <id>");
      ctx.printJson(await ctx.client.support.markTicketRead(id));
    },
  });
  reg.register({
    path: "support unread",
    summary: "count of tickets with an unread admin response",
    covers: ["support.unreadCount"],
    async run(ctx) {
      ctx.printJson(await ctx.client.support.unreadCount());
    },
  });
}
