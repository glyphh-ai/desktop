/**
 * cli/commands/org-library.ts — the ORG LIBRARY from the terminal: publish a
 * build, work the review desk, set role access, and manage your installs.
 */

import { readFileSync } from "node:fs";
import type { CommandRegistry } from "../registry.js";
import type { OrgLibraryKind } from "../../contract/org-library.js";

const KINDS: OrgLibraryKind[] = ["task", "agent", "skill"];

function kindArg(raw: string | undefined): OrgLibraryKind {
  if (raw && (KINDS as string[]).includes(raw)) return raw as OrgLibraryKind;
  throw new Error(`kind must be one of: ${KINDS.join(", ")}`);
}

function flagStr(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

export function registerOrgLibrary(reg: CommandRegistry): void {
  reg.register({
    path: "library list",
    summary: "the org's published items of one kind, narrowed to your role",
    usage: "library list <task|agent|skill>",
    covers: ["orgLibrary.list"],
    async run(ctx, args) {
      ctx.printJson(await ctx.client.orgLibrary.list(kindArg(args.positional[0])));
    },
  });

  reg.register({
    path: "library promote",
    summary: "promote a local build — payload → an immutable version, pending review",
    usage: "library promote <kind> <slug> <name> --payload <file.json> [--description <d>] [--notes <n>]",
    covers: ["orgLibrary.promote"],
    async run(ctx, args) {
      const [rawKind, slug, name] = args.positional;
      const payloadPath = flagStr(args.flags, "payload");
      if (!slug || !name || !payloadPath) {
        throw new Error("usage: library promote <kind> <slug> <name> --payload <file.json> [--description <d>] [--notes <n>]");
      }
      const payload: unknown = JSON.parse(readFileSync(payloadPath, "utf8"));
      ctx.printJson(await ctx.client.orgLibrary.promote(kindArg(rawKind), {
        slug, name, payload,
        ...(flagStr(args.flags, "description") ? { description: flagStr(args.flags, "description")! } : {}),
        ...(flagStr(args.flags, "notes") ? { notes: flagStr(args.flags, "notes")! } : {}),
      }));
    },
  });

  reg.register({
    path: "library queue",
    summary: "the review desk — every pending version, oldest first (org_admin)",
    covers: ["orgLibrary.queue"],
    async run(ctx) {
      ctx.printJson(await ctx.client.orgLibrary.queue());
    },
  });

  reg.register({
    path: "library decide",
    summary: "approve or reject one pending version (org_admin)",
    usage: "library decide <versionId> <approve|reject>",
    covers: ["orgLibrary.decide"],
    async run(ctx, args) {
      const [id, verdict] = args.positional;
      if (!id || (verdict !== "approve" && verdict !== "reject")) {
        throw new Error("usage: library decide <versionId> <approve|reject>");
      }
      ctx.printJson(await ctx.client.orgLibrary.decide(id, verdict === "approve"));
    },
  });

  reg.register({
    path: "library access",
    summary: "set one item's role access — restricted flag + full grant list (org_admin)",
    usage: "library access <kind> <id> <on|off> [--roles <wsId,wsId,…>]",
    covers: ["orgLibrary.setAccess"],
    async run(ctx, args) {
      const [rawKind, id, state] = args.positional;
      if (!id || (state !== "on" && state !== "off")) {
        throw new Error("usage: library access <kind> <id> <on|off> [--roles <wsId,…>]");
      }
      const roles = (flagStr(args.flags, "roles") ?? "").split(",").map((r) => r.trim()).filter(Boolean);
      await ctx.client.orgLibrary.setAccess(kindArg(rawKind), id, state === "on", roles);
      ctx.printJson({ ok: true });
    },
  });

  reg.register({
    path: "library install",
    summary: "join your installed list",
    usage: "library install <kind> <id>",
    covers: ["orgLibrary.install"],
    async run(ctx, args) {
      const [rawKind, id] = args.positional;
      if (!id) throw new Error("usage: library install <kind> <id>");
      await ctx.client.orgLibrary.install(kindArg(rawKind), id);
      ctx.printJson({ ok: true });
    },
  });

  reg.register({
    path: "library uninstall",
    summary: "leave your installed list",
    usage: "library uninstall <kind> <id>",
    covers: ["orgLibrary.uninstall"],
    async run(ctx, args) {
      const [rawKind, id] = args.positional;
      if (!id) throw new Error("usage: library uninstall <kind> <id>");
      await ctx.client.orgLibrary.uninstall(kindArg(rawKind), id);
      ctx.printJson({ ok: true });
    },
  });

  reg.register({
    path: "library payload",
    summary: "the approved payload — head by default, --version for a pin",
    usage: "library payload <kind> <id> [--version <n>]",
    covers: ["orgLibrary.payload"],
    async run(ctx, args) {
      const [rawKind, id] = args.positional;
      if (!id) throw new Error("usage: library payload <kind> <id> [--version <n>]");
      const v = flagStr(args.flags, "version");
      ctx.printJson(await ctx.client.orgLibrary.payload(kindArg(rawKind), id, v ? Number(v) : undefined));
    },
  });

  reg.register({
    path: "library enable",
    summary: "the admin kill-switch — off hides it from members, installs kept",
    usage: "library enable <kind> <id> <on|off>",
    covers: ["orgLibrary.setEnabled"],
    async run(ctx, args) {
      const [rawKind, id, state] = args.positional;
      if (!id || (state !== "on" && state !== "off")) throw new Error("usage: library enable <kind> <id> <on|off>");
      await ctx.client.orgLibrary.setEnabled(kindArg(rawKind), id, state === "on");
      ctx.printJson({ ok: true });
    },
  });

  reg.register({
    path: "library delete",
    summary: "DESTRUCTIVE — leaves the library AND every member's installs",
    usage: "library delete <kind> <id>",
    covers: ["orgLibrary.remove"],
    async run(ctx, args) {
      const [rawKind, id] = args.positional;
      if (!id) throw new Error("usage: library delete <kind> <id>");
      await ctx.client.orgLibrary.remove(kindArg(rawKind), id);
      ctx.printJson({ ok: true });
    },
  });

  reg.register({
    path: "library metrics",
    summary: "one item's metrics — installs + version history",
    usage: "library metrics <kind> <id>",
    covers: ["orgLibrary.metrics"],
    async run(ctx, args) {
      const [rawKind, id] = args.positional;
      if (!id) throw new Error("usage: library metrics <kind> <id>");
      ctx.printJson(await ctx.client.orgLibrary.metrics(kindArg(rawKind), id));
    },
  });
}
