/**
 * commands/auth.ts — sign-in commands. Each maps 1:1 to an SDK auth method and
 * declares it in `covers` so the parity test proves the surface is complete.
 */

import type { CommandRegistry } from "../registry.js";
import { flagStr } from "../args.js";

export function registerAuth(reg: CommandRegistry): void {
  reg.register({
    path: "auth approve-device",
    summary: "approve another device's pending login code (as the signed-in user)",
    usage: "auth approve-device <user-code>",
    covers: ["auth.approveDevice"],
    async run(ctx, args) {
      const userCode = args.positional[0];
      if (!userCode) throw new Error("usage: auth approve-device <user-code>");
      ctx.printJson(await ctx.client.auth.approveDevice(userCode));
    },
  });

  reg.register({
    path: "auth login",
    summary: "sign in from this terminal (device flow — approve in a browser)",
    covers: ["auth.deviceLogin"],
    async run(ctx) {
      await ctx.client.auth.deviceLogin({
        onPrompt: (p) => {
          ctx.print(`To sign in, open:  ${p.verificationUri}`);
          ctx.print(`and enter the code:  ${p.userCode}`);
          ctx.print("waiting for approval…");
        },
      });
      ctx.print("signed in ✓");
    },
  });

  reg.register({
    path: "auth email",
    summary: "sign in via email magic link (dev returns the token and completes)",
    usage: "auth email <email>",
    covers: ["auth.startEmailLink", "auth.verifyEmailLink"],
    async run(ctx, args) {
      const email = args.positional[0];
      if (!email) throw new Error("usage: auth email <email>");
      const start = await ctx.client.auth.startEmailLink(email);
      if (!start.devToken) {
        ctx.print(`link sent to ${email} — then: glyphh auth verify <token>`);
        return;
      }
      await ctx.client.auth.verifyEmailLink(start.devToken);
      ctx.print("signed in ✓");
    },
  });

  reg.register({
    path: "auth verify",
    summary: "verify a magic-link token → session",
    usage: "auth verify <token>",
    covers: ["auth.verifyEmailLink"],
    async run(ctx, args) {
      const token = args.positional[0];
      if (!token) throw new Error("usage: auth verify <token>");
      await ctx.client.auth.verifyEmailLink(token);
      ctx.print("signed in ✓");
    },
  });

  reg.register({
    path: "auth google",
    summary: "native Google sign-in (paste a device idToken)",
    usage: "auth google <idToken>",
    covers: ["auth.google"],
    async run(ctx, args) {
      const idToken = args.positional[0];
      if (!idToken) throw new Error("usage: auth google <idToken>");
      await ctx.client.auth.google(idToken);
      ctx.print("signed in ✓");
    },
  });

  reg.register({
    path: "auth apple",
    summary: "native Apple sign-in (paste a device identityToken)",
    usage: "auth apple <identityToken>",
    covers: ["auth.apple"],
    async run(ctx, args) {
      const token = args.positional[0];
      if (!token) throw new Error("usage: auth apple <identityToken>");
      await ctx.client.auth.apple(token);
      ctx.print("signed in ✓");
    },
  });

  reg.register({
    path: "auth org",
    summary: "start organization SSO (prints the authorization URL)",
    usage: "auth org <email> [--redirect <uri>]",
    covers: ["auth.startOrgSso"],
    async run(ctx, args) {
      const email = args.positional[0];
      if (!email) throw new Error("usage: auth org <email>");
      const { authorizationUrl } = await ctx.client.auth.startOrgSso({
        email,
        redirectUri: flagStr(args, "redirect") ?? "glyphh://auth/callback",
      });
      ctx.print(authorizationUrl);
    },
  });

  reg.register({
    path: "auth exchange",
    summary: "trade a one-time callback code for a session",
    usage: "auth exchange <code>",
    covers: ["auth.exchange"],
    async run(ctx, args) {
      const code = args.positional[0];
      if (!code) throw new Error("usage: auth exchange <code>");
      await ctx.client.auth.exchange(code);
      ctx.print("signed in ✓");
    },
  });

  reg.register({
    path: "auth signout",
    summary: "sign out this device (--everywhere revokes every device)",
    usage: "auth signout [--everywhere]",
    covers: ["auth.signOut", "auth.signOutEverywhere"],
    async run(ctx, args) {
      if (args.flags["everywhere"] === true) {
        await ctx.client.auth.signOutEverywhere();
        ctx.print("signed out everywhere ✓");
      } else {
        await ctx.client.auth.signOut();
        ctx.print("signed out ✓");
      }
    },
  });
}
