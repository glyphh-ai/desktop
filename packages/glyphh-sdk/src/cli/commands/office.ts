/**
 * commands/office.ts — GLYPHH OFFICE · SLIDES: the org's shared, agent-authored
 * slide decks. `list`/`get` read the library; `save` uploads a local deck HTML
 * by name (create-or-overwrite); `delete` removes it for the whole org.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import type { CommandRegistry } from "../registry.js";
import { flagStr } from "../args.js";

export function registerOffice(reg: CommandRegistry): void {
  reg.register({
    path: "slides list",
    summary: "the org's slide decks (newest first)",
    usage: "slides list",
    covers: ["officeSlides.list"],
    async run(ctx) {
      ctx.printJson(await ctx.client.officeSlides.list());
    },
  });

  reg.register({
    path: "slides get",
    summary: "one deck by name — metadata + HTML (--out writes the HTML to a file)",
    usage: "slides get <file> [--out <path>]",
    covers: ["officeSlides.get"],
    async run(ctx, args) {
      const file = args.positional[0];
      if (!file) throw new Error("usage: slides get <file> [--out <path>]");
      const deck = await ctx.client.officeSlides.get(file);
      const out = flagStr(args, "out");
      if (out) {
        writeFileSync(out, deck.html, "utf8");
        const { html: _html, ...meta } = deck;
        ctx.printJson({ ...meta, wrote: out });
        return;
      }
      ctx.printJson(deck);
    },
  });

  reg.register({
    path: "slides text",
    summary: "a deck's readable text (per-slide) — skip the font bytes",
    usage: "slides text <file>",
    covers: ["officeSlides.text"],
    async run(ctx, args) {
      const file = args.positional[0];
      if (!file) throw new Error("usage: slides text <file>");
      ctx.printJson(await ctx.client.officeSlides.text(file));
    },
  });

  reg.register({
    path: "slides save",
    summary: "create/overwrite a deck from a local HTML file",
    usage: "slides save <path> [--name <file>]",
    covers: ["officeSlides.put"],
    async run(ctx, args) {
      const path = args.positional[0];
      if (!path) throw new Error("usage: slides save <path> [--name <file>]");
      const name = flagStr(args, "name") ?? basename(path);
      ctx.printJson(await ctx.client.officeSlides.put(name, readFileSync(path, "utf8")));
    },
  });

  reg.register({
    path: "slides delete",
    summary: "delete a deck for the whole org",
    usage: "slides delete <file>",
    covers: ["officeSlides.delete"],
    async run(ctx, args) {
      const file = args.positional[0];
      if (!file) throw new Error("usage: slides delete <file>");
      await ctx.client.officeSlides.delete(file);
      ctx.printJson({ deleted: file });
    },
  });

  // ── DOCS ────────────────────────────────────────────────────────────────────

  reg.register({
    path: "docs list",
    summary: "the org's documents (newest first)",
    usage: "docs list",
    covers: ["officeDocs.list"],
    async run(ctx) {
      ctx.printJson(await ctx.client.officeDocs.list());
    },
  });

  reg.register({
    path: "docs get",
    summary: "one document by name — metadata + markdown (--out writes the markdown)",
    usage: "docs get <file> [--out <path>]",
    covers: ["officeDocs.get"],
    async run(ctx, args) {
      const file = args.positional[0];
      if (!file) throw new Error("usage: docs get <file> [--out <path>]");
      const doc = await ctx.client.officeDocs.get(file);
      const out = flagStr(args, "out");
      if (out) {
        writeFileSync(out, doc.markdown, "utf8");
        const { markdown: _md, ...meta } = doc;
        ctx.printJson({ ...meta, wrote: out });
        return;
      }
      ctx.printJson(doc);
    },
  });

  reg.register({
    path: "docs save",
    summary: "create/overwrite a document from a local markdown file",
    usage: "docs save <path> [--name <file>] [--folder <folderId>]",
    covers: ["officeDocs.put"],
    async run(ctx, args) {
      const path = args.positional[0];
      if (!path) throw new Error("usage: docs save <path> [--name <file>] [--folder <folderId>]");
      const name = flagStr(args, "name") ?? basename(path);
      const folder = flagStr(args, "folder");
      ctx.printJson(await ctx.client.officeDocs.put(name, readFileSync(path, "utf8"), folder === undefined ? undefined : folder || null));
    },
  });

  reg.register({
    path: "docs delete",
    summary: "delete a document for the whole org",
    usage: "docs delete <file>",
    covers: ["officeDocs.delete"],
    async run(ctx, args) {
      const file = args.positional[0];
      if (!file) throw new Error("usage: docs delete <file>");
      await ctx.client.officeDocs.delete(file);
      ctx.printJson({ deleted: file });
    },
  });

  reg.register({
    path: "docs suggestions",
    summary: "a document's suggestions (--status pending|approved|rejected|stale)",
    usage: "docs suggestions <file> [--status <status>]",
    covers: ["officeDocs.suggestions"],
    async run(ctx, args) {
      const file = args.positional[0];
      if (!file) throw new Error("usage: docs suggestions <file> [--status <status>]");
      ctx.printJson(await ctx.client.officeDocs.suggestions(file, flagStr(args, "status")));
    },
  });

  reg.register({
    path: "docs suggest",
    summary: "propose an edit (review-and-approve): replace --before with --after",
    usage: "docs suggest <file> --after <text> [--before <text>] [--section <name>] [--note <why>]",
    covers: ["officeDocs.suggest"],
    async run(ctx, args) {
      const file = args.positional[0];
      const after = flagStr(args, "after");
      if (!file || !after) throw new Error("usage: docs suggest <file> --after <text> [--before <text>] …");
      ctx.printJson(await ctx.client.officeDocs.suggest(file, {
        afterMd: after,
        beforeMd: flagStr(args, "before") ?? "",
        section: flagStr(args, "section") ?? "",
        note: flagStr(args, "note") ?? "",
        authorKind: "user",
      }));
    },
  });

  reg.register({
    path: "docs resolve",
    summary: "approve (applies) or reject a pending suggestion",
    usage: "docs resolve <id> <approve|reject>",
    covers: ["officeDocs.resolveSuggestion"],
    async run(ctx, args) {
      const [id, verdict] = args.positional;
      if (!id || !["approve", "reject"].includes(verdict ?? "")) throw new Error("usage: docs resolve <id> <approve|reject>");
      ctx.printJson(await ctx.client.officeDocs.resolveSuggestion(id, verdict === "approve"));
    },
  });

  reg.register({
    path: "docs templates",
    summary: "the code-defined document template catalog",
    usage: "docs templates",
    covers: ["officeDocs.templates"],
    async run(ctx) {
      ctx.printJson(await ctx.client.officeDocs.templates());
    },
  });

  // ── DRIVE ───────────────────────────────────────────────────────────────────

  reg.register({
    path: "drive list",
    summary: "folders + every Office file pointer (--q searches)",
    usage: "drive list [--q <query>]",
    covers: ["officeDrive.list"],
    async run(ctx, args) {
      ctx.printJson(await ctx.client.officeDrive.list(flagStr(args, "q")));
    },
  });

  reg.register({
    path: "drive mkdir",
    summary: "create a folder",
    usage: "drive mkdir <name> [--parent <folderId>]",
    covers: ["officeDrive.createFolder"],
    async run(ctx, args) {
      const name = args.positional[0];
      if (!name) throw new Error("usage: drive mkdir <name> [--parent <folderId>]");
      ctx.printJson(await ctx.client.officeDrive.createFolder(name, flagStr(args, "parent") ?? null));
    },
  });

  reg.register({
    path: "drive folder",
    summary: "rename and/or re-parent a folder (--root moves it to the root)",
    usage: "drive folder <id> [--name <name>] [--parent <folderId>] [--root]",
    covers: ["officeDrive.updateFolder"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: drive folder <id> [--name …] [--parent …] [--root]");
      const fields: { name?: string; parentId?: string | null } = {};
      const name = flagStr(args, "name");
      if (name) fields.name = name;
      const parent = flagStr(args, "parent");
      if (parent) fields.parentId = parent;
      else if (flagStr(args, "root") !== undefined) fields.parentId = null;
      ctx.printJson(await ctx.client.officeDrive.updateFolder(id, fields));
    },
  });

  reg.register({
    path: "drive rmdir",
    summary: "delete a folder (its contents re-parent, nothing is lost)",
    usage: "drive rmdir <id>",
    covers: ["officeDrive.deleteFolder"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: drive rmdir <id>");
      await ctx.client.officeDrive.deleteFolder(id);
      ctx.printJson({ deleted: id });
    },
  });

  reg.register({
    path: "drive mv",
    summary: "move an Office file into a folder (--root files it at the root)",
    usage: "drive mv <slides|docs> <file> [--folder <folderId>] [--root]",
    covers: ["officeDrive.move"],
    async run(ctx, args) {
      const [kind, file] = args.positional;
      if ((kind !== "slides" && kind !== "docs") || !file) throw new Error("usage: drive mv <slides|docs> <file> [--folder <id>] [--root]");
      const folder = flagStr(args, "folder");
      ctx.printJson(await ctx.client.officeDrive.move(kind, file, folder ?? null));
    },
  });

  // ── SHEETS ──────────────────────────────────────────────────────────────────

  reg.register({
    path: "sheets list",
    summary: "the org's workbooks (newest first)",
    usage: "sheets list",
    covers: ["officeSheets.list"],
    async run(ctx) {
      ctx.printJson(await ctx.client.officeSheets.list());
    },
  });

  reg.register({
    path: "sheets get",
    summary: "one workbook by name — metadata + the JSON workbook (--out writes it)",
    usage: "sheets get <file> [--out <path>]",
    covers: ["officeSheets.get"],
    async run(ctx, args) {
      const file = args.positional[0];
      if (!file) throw new Error("usage: sheets get <file> [--out <path>]");
      const sheet = await ctx.client.officeSheets.get(file);
      const out = flagStr(args, "out");
      if (out) {
        writeFileSync(out, JSON.stringify(sheet.workbook, null, 2), "utf8");
        const { workbook: _wb, ...meta } = sheet;
        ctx.printJson({ ...meta, wrote: out });
        return;
      }
      ctx.printJson(sheet);
    },
  });

  reg.register({
    path: "sheets save",
    summary: "create/overwrite a workbook from a local JSON file",
    usage: "sheets save <path> [--name <file>] [--title <title>]",
    covers: ["officeSheets.put"],
    async run(ctx, args) {
      const path = args.positional[0];
      if (!path) throw new Error("usage: sheets save <path> [--name <file>] [--title <title>]");
      const name = flagStr(args, "name") ?? basename(path);
      const title = flagStr(args, "title") ?? name.replace(/\.json$/i, "");
      const workbook = JSON.parse(readFileSync(path, "utf8"));
      ctx.printJson(await ctx.client.officeSheets.put(name, title, workbook));
    },
  });

  reg.register({
    path: "sheets delete",
    summary: "delete a workbook for the whole org",
    usage: "sheets delete <file>",
    covers: ["officeSheets.delete"],
    async run(ctx, args) {
      const file = args.positional[0];
      if (!file) throw new Error("usage: sheets delete <file>");
      await ctx.client.officeSheets.delete(file);
      ctx.printJson({ deleted: file });
    },
  });

  reg.register({
    path: "sheets text",
    summary: "a workbook's readable text (headers + sample rows)",
    usage: "sheets text <file>",
    covers: ["officeSheets.text"],
    async run(ctx, args) {
      const file = args.positional[0];
      if (!file) throw new Error("usage: sheets text <file>");
      ctx.printJson(await ctx.client.officeSheets.text(file));
    },
  });
}
