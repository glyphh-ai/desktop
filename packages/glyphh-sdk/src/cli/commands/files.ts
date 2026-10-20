/**
 * commands/files.ts — saved FILE ARTIFACTS: the explicit deliverables an agent saves for
 * the user, one set across every session + the desktop. `list`/`get`/`delete` read the
 * store; `upload` saves a local file (base64-encoded) on the caller's behalf — the runtime
 * is the primary writer, this is the human path.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { CommandRegistry } from "../registry.js";
import { flagStr } from "../args.js";
import type { CreateFileInput } from "../../contract/files.js";

export function registerFiles(reg: CommandRegistry): void {
  reg.register({
    path: "files list",
    summary: "your saved file artifacts (newest first)",
    usage: "files list [--session <sessionId>]",
    covers: ["files.list"],
    async run(ctx, args) {
      const sessionId = flagStr(args, "session");
      ctx.printJson(await ctx.client.files.list(sessionId ? { sessionId } : {}));
    },
  });

  reg.register({
    path: "files get",
    summary: "one artifact by id (with a short-lived downloadUrl)",
    usage: "files get <id>",
    covers: ["files.get"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: files get <id>");
      ctx.printJson(await ctx.client.files.get(id));
    },
  });

  reg.register({
    path: "files upload",
    summary: "save a local file as an artifact",
    usage: "files upload <path> [--name <name>] [--mime <mime>] [--session <sessionId>]",
    covers: ["files.create"],
    async run(ctx, args) {
      const path = args.positional[0];
      if (!path) throw new Error("usage: files upload <path> [--name …] [--mime …]");
      const input: CreateFileInput = {
        name: flagStr(args, "name") ?? basename(path),
        contentBase64: readFileSync(path).toString("base64"),
      };
      const mime = flagStr(args, "mime");
      if (mime) input.mime = mime;
      const sessionId = flagStr(args, "session");
      if (sessionId) input.sessionId = sessionId;
      ctx.printJson(await ctx.client.files.create(input));
    },
  });

  reg.register({
    path: "files delete",
    summary: "delete a saved artifact (removes the object + row)",
    usage: "files delete <id>",
    covers: ["files.delete"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: files delete <id>");
      await ctx.client.files.delete(id);
      ctx.printJson({ deleted: id });
    },
  });
}
