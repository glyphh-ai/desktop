/**
 * commands/artifacts.ts — the member's artifacts (his direction, 2026-10-05:
 * artifacts like Claude's): list by scope, publish a file, update one in place
 * from a file, share one, open one in the browser, read its bytes, rename, delete.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { spawn } from "node:child_process";

import { flagStr } from "../args.js";
import type { CommandRegistry } from "../registry.js";
import { ARTIFACT_ACCESSES } from "../../contract/artifacts.js";
import type { ArtifactAccess, ArtifactScope } from "../../contract/artifacts.js";

const SCOPES: readonly ArtifactScope[] = ["all", "mine", "shared"];

function accessFlag(raw: string | undefined): ArtifactAccess {
  if (!raw || !(ARTIFACT_ACCESSES as string[]).includes(raw)) throw new Error(`--access must be one of ${ARTIFACT_ACCESSES.join("|")}`);
  return raw as ArtifactAccess;
}

/** The OS's own opener; nothing of ours parses the URL. */
export function openUrl(url: string): void {
  const [file, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  spawn(file, args, { detached: true, stdio: "ignore" }).unref();
}

export function registerArtifacts(reg: CommandRegistry): void {
  reg.register({
    path: "artifacts list",
    summary: "list artifacts: all (yours + the org's shared), mine, or shared (the org's, not yours)",
    usage: "artifacts list [--scope all|mine|shared]",
    covers: ["artifacts.list"],
    async run(ctx, args) {
      const scope = flagStr(args, "scope") ?? "all";
      if (!(SCOPES as string[]).includes(scope)) throw new Error(`--scope must be one of ${SCOPES.join("|")}`);
      ctx.printJson(await ctx.client.artifacts.list(scope as ArtifactScope));
    },
  });

  reg.register({
    path: "artifacts get",
    summary: "one artifact's record (its view link, access, owner)",
    usage: "artifacts get <id>",
    covers: ["artifacts.get"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: artifacts get <id>");
      ctx.printJson(await ctx.client.artifacts.get(id));
    },
  });

  reg.register({
    path: "artifacts publish",
    summary: "publish a file as an artifact (private until shared)",
    usage: "artifacts publish <file> [--name <name>] [--mime <type>]",
    covers: ["artifacts.create"],
    async run(ctx, args) {
      const file = args.positional[0];
      if (!file) throw new Error("usage: artifacts publish <file> [--name <name>] [--mime <type>]");
      const mime = flagStr(args, "mime");
      const content = readFileSync(file).toString("base64");
      ctx.printJson(await ctx.client.artifacts.create({ name: flagStr(args, "name") ?? basename(file), content, ...(mime ? { mime } : {}) }));
    },
  });

  reg.register({
    path: "artifacts update",
    summary: "replace an artifact's content in place from a file: the same id and link, comments kept",
    usage: "artifacts update <id> --file <path> [--name <name>] [--mime <type>]",
    covers: ["artifacts.update"],
    async run(ctx, args) {
      const id = args.positional[0];
      const file = flagStr(args, "file");
      if (!id || !file) throw new Error("usage: artifacts update <id> --file <path> [--name <name>] [--mime <type>]");
      const name = flagStr(args, "name");
      const mime = flagStr(args, "mime");
      ctx.printJson(await ctx.client.artifacts.update(id, { content: readFileSync(file).toString("base64"), ...(name ? { name } : {}), ...(mime ? { mime } : {}) }));
    },
  });

  reg.register({
    path: "artifacts content",
    summary: "print an artifact's bytes to stdout",
    usage: "artifacts content <id>",
    covers: ["artifacts.content"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: artifacts content <id>");
      process.stdout.write(Buffer.from(await ctx.client.artifacts.content(id)));
    },
  });

  reg.register({
    path: "artifacts share",
    summary: "set who can open an artifact; public answers the link to hand out",
    usage: "artifacts share <id> --access private|org|public",
    covers: ["artifacts.share"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: artifacts share <id> --access private|org|public");
      ctx.printJson(await ctx.client.artifacts.share(id, accessFlag(flagStr(args, "access"))));
    },
  });

  reg.register({
    path: "artifacts rename",
    summary: "rename an artifact",
    usage: "artifacts rename <id> <name>",
    covers: ["artifacts.update"],
    async run(ctx, args) {
      const [id, name] = args.positional;
      if (!id || !name) throw new Error("usage: artifacts rename <id> <name>");
      ctx.printJson(await ctx.client.artifacts.update(id, { name }));
    },
  });

  reg.register({
    path: "artifacts delete",
    summary: "delete an artifact: the record and the bytes",
    usage: "artifacts delete <id>",
    covers: ["artifacts.remove"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: artifacts delete <id>");
      await ctx.client.artifacts.remove(id);
      ctx.printJson({ deleted: id });
    },
  });

  reg.register({
    path: "artifacts open",
    summary: "open an artifact's page in the browser (the share link when it is public)",
    usage: "artifacts open <id>",
    covers: ["artifacts.get"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: artifacts open <id>");
      const a = await ctx.client.artifacts.get(id);
      const url = a.shareUrl ?? a.viewUrl;
      openUrl(url);
      ctx.print(url);
    },
  });
}
