/**
 * music-panel.ts — the MUSIC STUDIO transport: thin IPC over client.music,
 * plus byte-level upload for the panel's two producers — the sound editor's
 * Save-as-New (an edited WAV) and the artist voice recorder (a mic take).
 */

import { ipcMain } from "electron";
import { getClient } from "./glyphh-client";
import type { MediaKind } from "@glyphh/sdk";

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function registerMusicPanelIpc(): void {
  ipcMain.handle("music-artists", async () => {
    try { return { ok: true, artists: await getClient().music.artists() }; }
    catch (err) { return { ok: false, error: errText(err), artists: [] }; }
  });
  ipcMain.handle("music-artist-save", async (_e, id: unknown, input: unknown) => {
    try {
      const music = getClient().music;
      const artist = id
        ? await music.updateArtist(String(id), input as Parameters<typeof music.updateArtist>[1])
        : await music.createArtist(input as Parameters<typeof music.createArtist>[0]);
      return { ok: true, artist };
    } catch (err) { return { ok: false, error: errText(err) }; }
  });
  ipcMain.handle("music-artist-delete", async (_e, id: unknown) => {
    try { await getClient().music.deleteArtist(String(id)); return { ok: true }; }
    catch (err) { return { ok: false, error: errText(err) }; }
  });
  ipcMain.handle("music-songs", async () => {
    try { return { ok: true, songs: await getClient().music.songs() }; }
    catch (err) { return { ok: false, error: errText(err), songs: [] }; }
  });
  ipcMain.handle("music-song-save", async (_e, id: unknown, input: unknown) => {
    try {
      const music = getClient().music;
      const song = id
        ? await music.updateSong(String(id), input as Parameters<typeof music.updateSong>[1])
        : await music.createSong(input as Parameters<typeof music.createSong>[0]);
      return { ok: true, song };
    } catch (err) { return { ok: false, error: errText(err) }; }
  });
  ipcMain.handle("music-song-regenerate", async (_e, id: unknown, input: unknown) => {
    try {
      const r = await getClient().music.regenerateSong(String(id), (input ?? {}) as { model?: string; seconds?: number });
      return { ok: true, song: r.song, job: r.job };
    } catch (err) { return { ok: false, error: errText(err) }; }
  });
  ipcMain.handle("music-song-delete", async (_e, id: unknown) => {
    try { await getClient().music.deleteSong(String(id)); return { ok: true }; }
    catch (err) { return { ok: false, error: errText(err) }; }
  });
  // Byte-level upload — the editor's WAV export and the mic recorder both
  // land through the same presigned pipeline as everything else.
  ipcMain.handle("media-upload-bytes", async (_e, input: unknown) => {
    try {
      const i = input as { title: string; kind: MediaKind; mime: string; bytes: ArrayBuffer; meta?: Record<string, unknown> };
      const bytes = new Uint8Array(i.bytes);
      const media = getClient().media;
      const ticket = await media.uploadTicket({
        kind: i.kind, mime: i.mime, title: i.title, sizeBytes: bytes.byteLength,
        ...(i.meta ? { meta: i.meta } : {}),
      });
      if (ticket.url) {
        const res = await fetch(ticket.url, { method: "PUT", headers: { "content-type": i.mime }, body: bytes });
        if (!res.ok) throw new Error(`presigned upload failed: ${res.status}`);
      } else {
        await media.putBytes(ticket.asset.id, bytes);
      }
      const done = await media.finalize(ticket.asset.id);
      return { ok: true, id: done.id, title: done.title };
    } catch (err) { return { ok: false, error: errText(err) }; }
  });
}
