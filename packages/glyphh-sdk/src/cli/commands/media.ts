/**
 * commands/media.ts — the media library + generation from the CLI. `generate`
 * starts the job and WAITS (generation is seconds-to-minutes); `--no-wait`
 * prints the job to poll yourself.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { CommandRegistry } from "../registry.js";
import { flagStr } from "../args.js";

const MIMES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".txt": "text/plain", ".md": "text/markdown",
};
const KIND_BY_MIME = (mime: string): "image" | "video" | "audio" | "script" =>
  mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "script";

export function registerMedia(reg: CommandRegistry): void {
  reg.register({
    path: "media list",
    summary: "the org's media library (newest first)",
    usage: "media list [--kind image|video|audio|voice|avatar|recording|script] [--q <text>]",
    covers: ["media.list"],
    async run(ctx, args) {
      const kind = flagStr(args, "kind");
      ctx.printJson(await ctx.client.media.list(kind as never, flagStr(args, "q")));
    },
  });

  reg.register({
    path: "media get",
    summary: "one asset's metadata",
    usage: "media get <id>",
    covers: ["media.get"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: media get <id>");
      ctx.printJson(await ctx.client.media.get(id));
    },
  });

  reg.register({
    path: "media download",
    summary: "download an asset's bytes",
    usage: "media download <id> --out <path>",
    covers: ["media.bytes"],
    async run(ctx, args) {
      const id = args.positional[0];
      const out = flagStr(args, "out");
      if (!id || !out) throw new Error("usage: media download <id> --out <path>");
      const bytes = await ctx.client.media.bytes(id);
      writeFileSync(out, Buffer.from(bytes));
      ctx.printJson({ wrote: out, bytes: bytes.byteLength });
    },
  });

  reg.register({
    path: "media url",
    summary: "a direct-playable (presigned) URL for an asset",
    usage: "media url <id>",
    covers: ["media.playbackUrl"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: media url <id>");
      ctx.printJson(await ctx.client.media.playbackUrl(id));
    },
  });

  reg.register({
    path: "media upload",
    summary: "upload a local file into the library (presigned when possible)",
    usage: "media upload <path> [--title <t>] [--kind <k>]",
    covers: ["media.uploadTicket", "media.putBytes", "media.finalize"],
    async run(ctx, args) {
      const path = args.positional[0];
      if (!path) throw new Error("usage: media upload <path> [--title <t>] [--kind <k>]");
      const mime = MIMES[extname(path).toLowerCase()];
      if (!mime) throw new Error(`unsupported file type "${extname(path)}"`);
      const bytes = readFileSync(path);
      const kind = (flagStr(args, "kind") as never) ?? KIND_BY_MIME(mime);
      const ticket = await ctx.client.media.uploadTicket({
        kind, mime,
        title: flagStr(args, "title") ?? basename(path),
        sizeBytes: bytes.byteLength,
      });
      if (ticket.url) {
        const res = await fetch(ticket.url, { method: "PUT", headers: { "content-type": mime }, body: new Uint8Array(bytes) });
        if (!res.ok) throw new Error(`presigned upload failed: ${res.status}`);
      } else {
        await ctx.client.media.putBytes(ticket.asset.id, new Uint8Array(bytes));
      }
      ctx.printJson(await ctx.client.media.finalize(ticket.asset.id));
    },
  });

  reg.register({
    path: "media generate",
    summary: "generate with any media model (image/video/speech/music/sfx) — costs dollars",
    usage: "media generate <model> <prompt…> [--size 1024x1024|16:9] [--seconds <n>] [--voice <id>] [--image-url <u>] [--title <t>] [--no-wait]",
    covers: ["media.generate", "media.waitForJob"],
    async run(ctx, args) {
      const [model, ...rest] = args.positional;
      const prompt = rest.join(" ").trim();
      if (!model || !prompt) throw new Error("usage: media generate <model> <prompt…>");
      const size = flagStr(args, "size");
      const seconds = flagStr(args, "seconds");
      const voice = flagStr(args, "voice");
      const imageUrl = flagStr(args, "image-url");
      const title = flagStr(args, "title");
      const started = await ctx.client.media.generate({
        model, prompt,
        ...(title ? { title } : {}),
        options: {
          ...(size ? { size } : {}),
          ...(seconds ? { seconds: Number(seconds) } : {}),
          ...(voice ? { voice } : {}),
          ...(imageUrl ? { imageUrl } : {}),
        },
      });
      if (args.flags["no-wait"]) { ctx.printJson(started); return; }
      ctx.printJson(await ctx.client.media.waitForJob(started.job.id));
    },
  });

  reg.register({
    path: "media jobs",
    summary: "recent generation jobs (status, model, dollars charged)",
    usage: "media jobs [--id <jobId>]",
    covers: ["media.jobs", "media.job"],
    async run(ctx, args) {
      const id = flagStr(args, "id");
      ctx.printJson(id ? await ctx.client.media.job(id) : await ctx.client.media.jobs());
    },
  });

  reg.register({
    path: "media projects",
    summary: "video projects (Music Video / studio documents)",
    usage: "media projects [--id <projectId>]",
    covers: ["media.projects"],
    async run(ctx, args) {
      const id = flagStr(args, "id");
      const all = await ctx.client.media.projects();
      ctx.printJson(id ? all.find((p) => p.id === id) ?? { error: "not found" } : all);
    },
  });

  reg.register({
    path: "media project-create",
    summary: "create a video project document",
    usage: "media project-create <title> [--song <songId>] [--prompt <p>]",
    covers: ["media.createProject"],
    async run(ctx, args) {
      const title = args.positional.join(" ").trim() || "Untitled";
      const song = flagStr(args, "song");
      const prompt = flagStr(args, "prompt");
      ctx.printJson(await ctx.client.media.createProject({
        title,
        scenes: { ...(song ? { songId: song } : {}), ...(prompt ? { prompt } : {}), visuals: [] },
      }));
    },
  });

  reg.register({
    path: "media project-update",
    summary: "update a project (title / scenes)",
    usage: "media project-update <id> [--title <t>] [--prompt <p>]",
    covers: ["media.updateProject"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: media project-update <id>");
      const title = flagStr(args, "title");
      const prompt = flagStr(args, "prompt");
      const patch: { title?: string; scenes?: Record<string, unknown> } = {};
      if (title) patch.title = title;
      if (prompt) {
        const cur = (await ctx.client.media.projects()).find((p) => p.id === id);
        patch.scenes = { ...(cur?.scenes ?? {}), prompt };
      }
      ctx.printJson(await ctx.client.media.updateProject(id, patch));
    },
  });

  reg.register({
    path: "media project-generate",
    summary: "server-side project generation (child now, render attaches; metered)",
    usage: "media project-generate <id> [--model <m>] [--seconds <n>] [--prompt <p>]",
    covers: ["media.generateProject"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: media project-generate <id>");
      const model = flagStr(args, "model"), seconds = flagStr(args, "seconds"), prompt = flagStr(args, "prompt");
      ctx.printJson(await ctx.client.media.generateProject(id, {
        ...(model ? { model } : {}),
        ...(seconds ? { seconds: Number(seconds) } : {}),
        ...(prompt ? { prompt } : {}),
      }));
    },
  });

  reg.register({
    path: "media project-delete",
    summary: "delete a video project document",
    usage: "media project-delete <id>",
    covers: ["media.deleteProject"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: media project-delete <id>");
      await ctx.client.media.deleteProject(id);
      ctx.printJson({ deleted: id });
    },
  });

  reg.register({
    path: "media delete",
    summary: "delete an asset (bytes + row)",
    usage: "media delete <id>",
    covers: ["media.delete"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: media delete <id>");
      await ctx.client.media.delete(id);
      ctx.printJson({ deleted: id });
    },
  });
}
