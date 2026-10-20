/**
 * commands/session.ts — identity + session-token commands (the non-auth top-level
 * Client methods).
 */

import type { CommandRegistry } from "../registry.js";

function mask(token: string | null): string {
  return token ? `${token.slice(0, 12)}…${token.slice(-4)}` : "(none)";
}

export function registerSession(reg: CommandRegistry): void {
  reg.register({
    path: "me",
    summary: "the authenticated principal (who am I)",
    covers: ["me"],
    async run(ctx) {
      ctx.printJson(await ctx.client.me());
    },
  });

  reg.register({
    path: "token",
    summary: "print the current bearer (auto-refreshes)",
    covers: ["token"],
    async run(ctx) {
      ctx.print(mask(await ctx.client.token()));
    },
  });

  reg.register({
    path: "session refresh",
    summary: "force a session rotation",
    covers: ["refresh"],
    async run(ctx) {
      ctx.print((await ctx.client.refresh()) ? "rotated ✓" : "not signed in");
    },
  });

  reg.register({
    path: "session show",
    summary: "the current stored session (masked)",
    covers: ["getSession"],
    async run(ctx) {
      const s = await ctx.client.getSession();
      if (!s) return ctx.print("(no session)");
      ctx.print(`access ${mask(s.accessToken)}  refresh ${mask(s.refreshToken)}  expiresAt ${new Date(s.expiresAt).toISOString()}`);
    },
  });
}
