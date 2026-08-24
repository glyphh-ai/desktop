/**
 * music-panel.ts — the MUSIC STUDIO transport: thin IPC over client.music,
 * plus byte-level upload for the panel's two producers — the sound editor's
 * Save-as-New (an edited WAV) and the artist voice recorder (a mic take).
 */

import { ipcMain } from "electron";
import { getClient } from "./glyphh-client";
import type { MediaKind } from "@glyphh/sdk";

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** One metered IMAGE job, structured — the band builder's brush. */
export async function genImageAsset(prompt: string, title: string): Promise<{ id: string; credits: number }> {
  const models = await getClient().models.available();
  const model = models.find((m) => String((m as { modality?: string }).modality ?? "") === "image");
  if (!model) throw new Error("this org has no enabled image model");
  const started = await getClient().media.generate({ model: model.id, prompt, title, options: { size: "1024x1536" } });
  const job = await getClient().media.waitForJob(started.job.id);
  if (job.status === "failed" || !job.assetId) throw new Error(job.error ?? "image generation failed");
  return { id: job.assetId, credits: job.creditsCharged };
}

/** A member look: FRONT + BACK of the same person, photoreal, stage-ready. */
export async function genLook(name: string, description: string, bandType: string): Promise<{ front: string; back: string; credits: number }> {
  const base = `Photorealistic full-body studio photograph of ${description || name}, member of a ${bandType || "rock"} band, stage outfit, neutral dark backdrop, cinematic lighting, lifelike skin texture, 85mm`;
  const front = await genImageAsset(`${base}. FRONT view, facing the camera.`, `${name} — look (front)`);
  const back = await genImageAsset(`${base}. BACK view — the SAME person and outfit seen from behind.`, `${name} — look (back)`);
  return { front: front.id, back: back.id, credits: front.credits + back.credits };
}

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
  ipcMain.handle("music-instruments", async () => {
    try { return { ok: true, instruments: await getClient().music.instruments() }; }
    catch (err) { return { ok: false, error: errText(err), instruments: [] }; }
  });
  ipcMain.handle("music-instrument-save", async (_e, id: unknown, input: unknown) => {
    try {
      const music = getClient().music;
      const instrument = id
        ? await music.updateInstrument(String(id), input as Parameters<typeof music.updateInstrument>[1])
        : await music.createInstrument(input as Parameters<typeof music.createInstrument>[0]);
      return { ok: true, instrument };
    } catch (err) { return { ok: false, error: errText(err) }; }
  });
  ipcMain.handle("music-instrument-delete", async (_e, id: unknown) => {
    try { await getClient().music.deleteInstrument(String(id)); return { ok: true }; }
    catch (err) { return { ok: false, error: errText(err) }; }
  });
  ipcMain.handle("music-instrument-genlook", async (_e, id: unknown, description: unknown, replaceLook: unknown) => {
    try {
      const music = getClient().music;
      const inst = (await music.instruments()).find((x) => x.id === String(id));
      if (!inst) throw new Error("unknown instrument");
      const img = await genImageAsset(
        `Photorealistic product photograph of a ${inst.name}${String(description ?? inst.description ?? "").trim() ? `, ${String(description ?? inst.description).trim()}` : ""}, dark stage backdrop, dramatic lighting`,
        `${inst.name} — look`,
      );
      const looks = [...((inst.meta.looks as Array<{ assetId: string }> | undefined) ?? [])];
      const idx = replaceLook !== undefined && replaceLook !== null ? Math.trunc(Number(replaceLook)) - 1 : -1;
      let active: number;
      if (idx >= 0 && idx < looks.length) { looks[idx] = { assetId: img.id }; active = idx; }
      else { looks.push({ assetId: img.id }); active = looks.length - 1; }
      const updated = await music.updateInstrument(inst.id, { meta: { ...inst.meta, looks, activeLook: active } });
      return { ok: true, instrument: updated, credits: img.credits };
    } catch (err) { return { ok: false, error: errText(err) }; }
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
  // Look generation server→main-side: the panel and the agent share ONE
  //   implementation; replaceLook (1-based) regenerates in place, absent
  //   appends. Returns the fresh artist row.
  ipcMain.handle("music-artist-genlook", async (_e, id: unknown, description: unknown, replaceLook: unknown) => {
    try {
      const music = getClient().music;
      const artist = (await music.artists()).find((x) => x.id === String(id));
      if (!artist) throw new Error("unknown artist");
      const look = await genLook(artist.name, String(description ?? artist.style ?? ""), "");
      const looks = [...((artist.meta.looks as Array<{ front: string; back: string }> | undefined) ?? [])];
      const idx = replaceLook !== undefined && replaceLook !== null ? Math.trunc(Number(replaceLook)) - 1 : -1;
      let active: number;
      if (idx >= 0 && idx < looks.length) {
        looks[idx] = { front: look.front, back: look.back };
        active = idx;
      } else {
        looks.push({ front: look.front, back: look.back });
        active = looks.length - 1;
      }
      const updated = await music.updateArtist(artist.id, {
        avatarAssetId: looks[active]!.front,
        meta: { ...artist.meta, looks, activeLook: active },
      });
      return { ok: true, artist: updated, credits: look.credits };
    } catch (err) { return { ok: false, error: errText(err) }; }
  });

  ipcMain.handle("media-projects", async () => {
    try { return { ok: true, projects: await getClient().media.projects() }; }
    catch (err) { return { ok: false, error: errText(err), projects: [] }; }
  });
  ipcMain.handle("media-project-save", async (_e, id: unknown, input: unknown) => {
    try {
      const media = getClient().media;
      const project = id
        ? await media.updateProject(String(id), input as Parameters<typeof media.updateProject>[1])
        : await media.createProject(input as Parameters<typeof media.createProject>[0]);
      return { ok: true, project };
    } catch (err) { return { ok: false, error: errText(err) }; }
  });
  ipcMain.handle("media-project-delete", async (_e, id: unknown) => {
    try { await getClient().media.deleteProject(String(id)); return { ok: true }; }
    catch (err) { return { ok: false, error: errText(err) }; }
  });
  ipcMain.handle("media-project-generate", async (_e, id: unknown, input: unknown) => {
    try {
      const r = await getClient().media.generateProject(String(id), (input ?? {}) as { model?: string; seconds?: number; prompt?: string });
      return { ok: true, project: r.project, job: r.job };
    } catch (err) { return { ok: false, error: errText(err) }; }
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
