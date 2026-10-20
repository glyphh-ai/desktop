/**
 * commands/design.ts — GLYPHH DESIGN: the org's design systems (brand kits).
 * `list`/`get`/`text` read the library; `save` uploads a document JSON by name
 * (create-or-overwrite); `css` prints the consumable `--design-*` contract;
 * `asset-*` manage the image shelf; `delete` removes a system for the org.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { CommandRegistry } from "../registry.js";
import { flagStr } from "../args.js";

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

export function registerDesign(reg: CommandRegistry): void {
  reg.register({
    path: "design list",
    summary: "the org's design systems (newest first)",
    usage: "design list",
    covers: ["designs.list"],
    async run(ctx) {
      ctx.printJson(await ctx.client.designs.list());
    },
  });

  reg.register({
    path: "design get",
    summary: "one system by name — metadata + the document (--out writes JSON)",
    usage: "design get <file> [--out <path>]",
    covers: ["designs.get"],
    async run(ctx, args) {
      const file = args.positional[0];
      if (!file) throw new Error("usage: design get <file> [--out <path>]");
      const design = await ctx.client.designs.get(file);
      const out = flagStr(args, "out");
      if (out) {
        writeFileSync(out, JSON.stringify(design.document, null, 2), "utf8");
        const { document: _doc, ...meta } = design;
        ctx.printJson({ ...meta, wrote: out });
        return;
      }
      ctx.printJson(design);
    },
  });

  reg.register({
    path: "design text",
    summary: "a system's readable summary",
    usage: "design text <file>",
    covers: ["designs.text"],
    async run(ctx, args) {
      const file = args.positional[0];
      if (!file) throw new Error("usage: design text <file>");
      ctx.printJson(await ctx.client.designs.text(file));
    },
  });

  reg.register({
    path: "design css",
    summary: "the consumable contract — the :root { --design-* } block",
    usage: "design css <file> [--out <path>]",
    covers: ["designs.css"],
    async run(ctx, args) {
      const file = args.positional[0];
      if (!file) throw new Error("usage: design css <file> [--out <path>]");
      const css = await ctx.client.designs.css(file);
      const out = flagStr(args, "out");
      if (out) {
        writeFileSync(out, css, "utf8");
        ctx.printJson({ wrote: out });
        return;
      }
      ctx.print(css);
    },
  });

  reg.register({
    path: "design save",
    summary: "create/overwrite a system from a local document JSON",
    usage: "design save <path> [--name <file>]",
    covers: ["designs.put"],
    async run(ctx, args) {
      const path = args.positional[0];
      if (!path) throw new Error("usage: design save <path> [--name <file>]");
      const name = flagStr(args, "name") ?? basename(path);
      ctx.printJson(await ctx.client.designs.put(name, JSON.parse(readFileSync(path, "utf8"))));
    },
  });

  reg.register({
    path: "design delete",
    summary: "delete a system for the whole org (document + assets)",
    usage: "design delete <file>",
    covers: ["designs.delete"],
    async run(ctx, args) {
      const file = args.positional[0];
      if (!file) throw new Error("usage: design delete <file>");
      await ctx.client.designs.delete(file);
      ctx.printJson({ deleted: file });
    },
  });

  reg.register({
    path: "design asset-upload",
    summary: "upload (or replace) an image asset from a local file",
    usage: "design asset-upload <file> <imagePath> [--id <slug>] [--kind logo|icon|image] [--title <t>]",
    covers: ["designs.uploadAsset"],
    async run(ctx, args) {
      const [file, imagePath] = args.positional;
      if (!file || !imagePath) throw new Error("usage: design asset-upload <file> <imagePath> [--id <slug>] [--kind logo|icon|image] [--title <t>]");
      const contentType = CONTENT_TYPES[extname(imagePath).toLowerCase()];
      if (!contentType) throw new Error(`unsupported image type "${extname(imagePath)}"`);
      const kindFlag = flagStr(args, "kind");
      const kind = kindFlag === "logo" || kindFlag === "icon" || kindFlag === "image" ? kindFlag : "image";
      const id = flagStr(args, "id");
      ctx.printJson(await ctx.client.designs.uploadAsset(file, {
        ...(id ? { id } : {}),
        kind,
        title: flagStr(args, "title") ?? basename(imagePath),
        contentType,
        dataBase64: readFileSync(imagePath).toString("base64"),
      }));
    },
  });

  reg.register({
    path: "design asset-get",
    summary: "download an asset's bytes to a file",
    usage: "design asset-get <file> <assetId> --out <path>",
    covers: ["designs.assetBytes"],
    async run(ctx, args) {
      const [file, assetId] = args.positional;
      const out = flagStr(args, "out");
      if (!file || !assetId || !out) throw new Error("usage: design asset-get <file> <assetId> --out <path>");
      const bytes = await ctx.client.designs.assetBytes(file, assetId);
      writeFileSync(out, Buffer.from(bytes));
      ctx.printJson({ wrote: out, bytes: bytes.byteLength });
    },
  });

  reg.register({
    path: "design imagery-add",
    summary: "atomically adopt media-library assets into a system's imagery (+canvas)",
    usage: "design imagery-add <file> <assetId...> [--role <r>] [--title <t>] [--kind image|video]",
    covers: ["designs.addImagery"],
    async run(ctx, args) {
      const [file, ...assetIds] = args.positional;
      if (!file || !assetIds.length) throw new Error("usage: design imagery-add <file> <assetId...> [--role <r>] [--title <t>] [--kind image|video]");
      const role = flagStr(args, "role");
      const title = flagStr(args, "title");
      const kindFlag = flagStr(args, "kind");
      const kind = kindFlag === "image" || kindFlag === "video" ? kindFlag : undefined;
      ctx.printJson(await ctx.client.designs.addImagery(file, assetIds.map((assetId) => ({
        assetId,
        ...(title ? { title } : {}),
        ...(role ? { role } : {}),
        ...(kind ? { kind } : {}),
      }))));
    },
  });

  reg.register({
    path: "design imagery-remove",
    summary: "remove an imagery ref (pointer + canvas card; the media asset stays)",
    usage: "design imagery-remove <file> <assetId>",
    covers: ["designs.removeImagery"],
    async run(ctx, args) {
      const [file, assetId] = args.positional;
      if (!file || !assetId) throw new Error("usage: design imagery-remove <file> <assetId>");
      await ctx.client.designs.removeImagery(file, assetId);
      ctx.printJson({ removed: assetId });
    },
  });

  reg.register({
    path: "design asset-delete",
    summary: "remove an asset (bytes + its entry in the document)",
    usage: "design asset-delete <file> <assetId>",
    covers: ["designs.deleteAsset"],
    async run(ctx, args) {
      const [file, assetId] = args.positional;
      if (!file || !assetId) throw new Error("usage: design asset-delete <file> <assetId>");
      await ctx.client.designs.deleteAsset(file, assetId);
      ctx.printJson({ deleted: assetId });
    },
  });
}
