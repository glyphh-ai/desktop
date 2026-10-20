/**
 * commands/music.ts — the Music Studio documents from the CLI.
 */

import type { CommandRegistry } from "../registry.js";
import { flagStr } from "../args.js";

export function registerMusic(reg: CommandRegistry): void {
  reg.register({
    path: "music artists",
    summary: "the org's artist profiles",
    usage: "music artists",
    covers: ["music.artists"],
    async run(ctx) { ctx.printJson(await ctx.client.music.artists()); },
  });
  reg.register({
    path: "music artist-create",
    summary: "create an artist (a look + a voice + a style line)",
    usage: "music artist-create <name> [--style <s>] [--voice <providerVoiceId>] [--voice-asset <id>] [--avatar <assetId>]",
    covers: ["music.createArtist"],
    async run(ctx, args) {
      const name = args.positional.join(" ").trim();
      if (!name) throw new Error("usage: music artist-create <name>");
      const style = flagStr(args, "style"), voiceId = flagStr(args, "voice"),
        voiceAssetId = flagStr(args, "voice-asset"), avatarAssetId = flagStr(args, "avatar");
      ctx.printJson(await ctx.client.music.createArtist({
        name,
        ...(style ? { style } : {}),
        ...(voiceId ? { voiceId } : {}),
        ...(voiceAssetId ? { voiceAssetId } : {}),
        ...(avatarAssetId ? { avatarAssetId } : {}),
      }));
    },
  });
  reg.register({
    path: "music artist-update",
    summary: "update an artist",
    usage: "music artist-update <id> [--name <n>] [--style <s>] [--voice <v>] [--avatar <assetId>]",
    covers: ["music.updateArtist"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: music artist-update <id>");
      const name = flagStr(args, "name"), style = flagStr(args, "style"),
        voiceId = flagStr(args, "voice"), avatarAssetId = flagStr(args, "avatar");
      ctx.printJson(await ctx.client.music.updateArtist(id, {
        ...(name ? { name } : {}),
        ...(style ? { style } : {}),
        ...(voiceId ? { voiceId } : {}),
        ...(avatarAssetId ? { avatarAssetId } : {}),
      }));
    },
  });
  reg.register({
    path: "music artist-delete",
    summary: "delete an artist profile",
    usage: "music artist-delete <id>",
    covers: ["music.deleteArtist"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: music artist-delete <id>");
      await ctx.client.music.deleteArtist(id);
      ctx.printJson({ deleted: id });
    },
  });
  reg.register({
    path: "music instruments",
    summary: "the org instrument library",
    usage: "music instruments",
    covers: ["music.instruments"],
    async run(ctx) { ctx.printJson(await ctx.client.music.instruments()); },
  });
  reg.register({
    path: "music instrument-create",
    summary: "add an instrument to the library",
    usage: "music instrument-create <name> [--desc <sound line>]",
    covers: ["music.createInstrument"],
    async run(ctx, args) {
      const name = args.positional.join(" ").trim();
      if (!name) throw new Error("usage: music instrument-create <name>");
      const description = flagStr(args, "desc");
      ctx.printJson(await ctx.client.music.createInstrument({ name, ...(description ? { description } : {}) }));
    },
  });
  reg.register({
    path: "music instrument-update",
    summary: "update a library instrument",
    usage: "music instrument-update <id> [--name <n>] [--desc <d>]",
    covers: ["music.updateInstrument"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: music instrument-update <id>");
      const name = flagStr(args, "name"), description = flagStr(args, "desc");
      ctx.printJson(await ctx.client.music.updateInstrument(id, {
        ...(name ? { name } : {}),
        ...(description ? { description } : {}),
      }));
    },
  });
  reg.register({
    path: "music instrument-delete",
    summary: "remove a library instrument",
    usage: "music instrument-delete <id>",
    covers: ["music.deleteInstrument"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: music instrument-delete <id>");
      await ctx.client.music.deleteInstrument(id);
      ctx.printJson({ deleted: id });
    },
  });

  reg.register({
    path: "music songs",
    summary: "the org's songs (newest first) or one song in full",
    usage: "music songs [--id <songId>]",
    covers: ["music.songs", "music.song"],
    async run(ctx, args) {
      const id = flagStr(args, "id");
      ctx.printJson(id ? await ctx.client.music.song(id) : await ctx.client.music.songs());
    },
  });
  reg.register({
    path: "music song-create",
    summary: "create a song document (generation rides `media generate`)",
    usage: "music song-create <title> [--lyrics <text>] [--prompt <p>] [--band <type>] [--parent <songId>]",
    covers: ["music.createSong"],
    async run(ctx, args) {
      const title = args.positional.join(" ").trim() || "Untitled";
      const lyrics = flagStr(args, "lyrics"), prompt = flagStr(args, "prompt"),
        bandType = flagStr(args, "band"), parentId = flagStr(args, "parent");
      ctx.printJson(await ctx.client.music.createSong({
        title,
        ...(lyrics ? { lyrics } : {}),
        ...(prompt ? { prompt } : {}),
        ...(bandType ? { bandType } : {}),
        ...(parentId ? { parentId } : {}),
      }));
    },
  });
  reg.register({
    path: "music song-update",
    summary: "update a song (title/lyrics/prompt/band/audio asset)",
    usage: "music song-update <id> [--title <t>] [--lyrics <l>] [--prompt <p>] [--audio <assetId>]",
    covers: ["music.updateSong"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: music song-update <id>");
      const title = flagStr(args, "title"), lyrics = flagStr(args, "lyrics"),
        prompt = flagStr(args, "prompt"), audio = flagStr(args, "audio");
      ctx.printJson(await ctx.client.music.updateSong(id, {
        ...(title ? { title } : {}),
        ...(lyrics ? { lyrics } : {}),
        ...(prompt ? { prompt } : {}),
        ...(audio ? { audioAssetId: audio } : {}),
      }));
    },
  });
  reg.register({
    path: "music regenerate",
    summary: "server-side regenerate — child version now, take attaches on success (metered)",
    usage: "music regenerate <songId> [--model <id>] [--seconds <n>]",
    covers: ["music.regenerateSong"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: music regenerate <songId>");
      const model = flagStr(args, "model");
      const seconds = flagStr(args, "seconds");
      ctx.printJson(await ctx.client.music.regenerateSong(id, {
        ...(model ? { model } : {}),
        ...(seconds ? { seconds: Number(seconds) } : {}),
      }));
    },
  });

  reg.register({
    path: "music song-delete",
    summary: "delete a song document",
    usage: "music song-delete <id>",
    covers: ["music.deleteSong"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: music song-delete <id>");
      await ctx.client.music.deleteSong(id);
      ctx.printJson({ deleted: id });
    },
  });
}
