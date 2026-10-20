/**
 * commands/member-library.ts — `member-library <verb> <kind> …` over the member
 * library v2 (workspace|tab|skill|agent|task). `put` takes `--data` (inline JSON
 * or `@file.json`), optional `--files` (the manifest, same forms) and
 * `--updated-at` (epoch ms, defaults to now); `remove` takes `--updated-at` too.
 */

import { readFileSync } from "node:fs";
import type { CommandRegistry } from "../registry.js";
import { flagStr } from "../args.js";
import { MEMBER_LIBRARY_KINDS, type MemberLibraryFile, type MemberLibraryKind, type PutMemberLibraryInput } from "../../contract/member-library.js";

function kindOf(raw: string | undefined, usage: string): MemberLibraryKind {
  if (!raw || !(MEMBER_LIBRARY_KINDS as readonly string[]).includes(raw)) {
    throw new Error(`${usage}\nkind is one of: ${MEMBER_LIBRARY_KINDS.join("|")}`);
  }
  return raw as MemberLibraryKind;
}

/** Resolve a JSON flag: inline JSON, or `@path` to a JSON file. */
function parseJson(raw: string): unknown {
  return JSON.parse(raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw);
}

function epochMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const ms = Number(raw);
  if (!Number.isSafeInteger(ms) || ms < 0) throw new Error("--updated-at must be epoch milliseconds");
  return ms;
}

export function registerMemberLibrary(reg: CommandRegistry): void {
  const KIND = "<workspace|tab|skill|agent|task>";

  reg.register({
    path: "member-library list",
    summary: "the member library rows of one kind (live; with --since, changed rows incl. tombstones)",
    usage: `member-library list ${KIND} [--since <epoch-ms>]`,
    covers: ["memberLibrary.list"],
    async run(ctx, args) {
      const usage = `usage: member-library list ${KIND} [--since <epoch-ms>]`;
      const kind = kindOf(args.positional[0], usage);
      const since = epochMs(flagStr(args, "since"));
      ctx.printJson(await ctx.client.memberLibrary.list(kind, since !== undefined ? { since } : {}));
    },
  });

  reg.register({
    path: "member-library get",
    summary: "one member library item in full (data + file manifest)",
    usage: `member-library get ${KIND} <id>`,
    covers: ["memberLibrary.get"],
    async run(ctx, args) {
      const usage = `usage: member-library get ${KIND} <id>`;
      const kind = kindOf(args.positional[0], usage);
      const id = args.positional[1];
      if (!id) throw new Error(usage);
      ctx.printJson(await ctx.client.memberLibrary.get(kind, id));
    },
  });

  reg.register({
    path: "member-library put",
    summary: "LWW-put a member library item (an unknown id creates it)",
    usage: `member-library put ${KIND} <id> --data <json|@file> [--files <json|@file>] [--updated-at <epoch-ms>]`,
    covers: ["memberLibrary.put"],
    async run(ctx, args) {
      const usage = `usage: member-library put ${KIND} <id> --data <json|@file> [--files <json|@file>] [--updated-at <epoch-ms>]`;
      const kind = kindOf(args.positional[0], usage);
      const id = args.positional[1];
      const data = flagStr(args, "data");
      if (!id || data === undefined) throw new Error(usage);
      const input: PutMemberLibraryInput = { data: parseJson(data), updatedAt: epochMs(flagStr(args, "updated-at")) ?? Date.now() };
      const files = flagStr(args, "files");
      if (files !== undefined) input.files = parseJson(files) as MemberLibraryFile[];
      ctx.printJson(await ctx.client.memberLibrary.put(kind, id, input));
    },
  });

  reg.register({
    path: "member-library remove",
    summary: "tombstone a member library item",
    usage: `member-library remove ${KIND} <id> [--updated-at <epoch-ms>]`,
    covers: ["memberLibrary.remove"],
    async run(ctx, args) {
      const usage = `usage: member-library remove ${KIND} <id> [--updated-at <epoch-ms>]`;
      const kind = kindOf(args.positional[0], usage);
      const id = args.positional[1];
      if (!id) throw new Error(usage);
      const updatedAt = epochMs(flagStr(args, "updated-at"));
      await ctx.client.memberLibrary.remove(kind, id, updatedAt !== undefined ? { updatedAt } : {});
      ctx.printJson({ removed: id });
    },
  });

  reg.register({
    path: "member-library files",
    summary: "presigned R2 put/get URLs for an item's files",
    usage: `member-library files ${KIND} <id> <path> [<path> …]`,
    covers: ["memberLibrary.files"],
    async run(ctx, args) {
      const usage = `usage: member-library files ${KIND} <id> <path> [<path> …]`;
      const kind = kindOf(args.positional[0], usage);
      const [, id, ...paths] = args.positional;
      if (!id || paths.length === 0) throw new Error(usage);
      ctx.printJson(await ctx.client.memberLibrary.files(kind, id, paths));
    },
  });
}
