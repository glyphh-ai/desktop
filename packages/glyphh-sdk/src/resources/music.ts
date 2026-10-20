/**
 * resources/music.ts — the MUSIC STUDIO documents: artists (a look + a voice +
 * a style line) and songs (lyrics + steering prompt + band slots + lineage).
 * Generation rides client.media.generate; these are the documents around it.
 */

import type { AuthedHttp } from "../core/authed-http.js";
import type { MediaJob } from "../contract/media.js";

export interface MusicArtist {
  id: string;
  name: string;
  style: string;
  voiceAssetId: string | null;
  voiceId: string | null;
  avatarAssetId: string | null;
  meta: Record<string, unknown>;
  updatedAt: string;
}

export interface MusicInstrument { instrument: string; tweak: string; lookAssetId?: string | null }

export interface MusicSong {
  id: string;
  title: string;
  lyrics: string;
  prompt: string;
  bandType: string;
  artistIds: string[];
  instruments: MusicInstrument[];
  audioAssetId: string | null;
  parentId: string | null;
  model: string;
  /** Music Video assembly — staged media asset ids the render consumes. */
  visuals: string[];
  updatedAt: string;
}

export interface MusicArtistInput {
  name: string;
  style?: string;
  voiceAssetId?: string | null;
  voiceId?: string | null;
  avatarAssetId?: string | null;
  meta?: Record<string, unknown>;
}

export interface MusicSongInput {
  title?: string;
  lyrics?: string;
  prompt?: string;
  bandType?: string;
  artistIds?: string[];
  instruments?: MusicInstrument[];
  audioAssetId?: string | null;
  parentId?: string | null;
  model?: string;
  visuals?: string[];
}

export interface MusicLibInstrument {
  id: string;
  name: string;
  description: string;
  meta: Record<string, unknown>;
  updatedAt: string;
}

export class MusicClient {
  constructor(private readonly http: AuthedHttp) {}

  artists(): Promise<MusicArtist[]> {
    return this.http.get<MusicArtist[]>("/api/music/artists");
  }
  createArtist(input: MusicArtistInput): Promise<MusicArtist> {
    return this.http.post<MusicArtist>("/api/music/artists", input);
  }
  updateArtist(id: string, patch: Partial<MusicArtistInput>): Promise<MusicArtist> {
    return this.http.patch<MusicArtist>(`/api/music/artists/${encodeURIComponent(id)}`, patch);
  }
  deleteArtist(id: string): Promise<void> {
    return this.http.del<void>(`/api/music/artists/${encodeURIComponent(id)}`);
  }

  instruments(): Promise<MusicLibInstrument[]> {
    return this.http.get<MusicLibInstrument[]>("/api/music/instruments");
  }
  createInstrument(input: { name: string; description?: string; meta?: Record<string, unknown> }): Promise<MusicLibInstrument> {
    return this.http.post<MusicLibInstrument>("/api/music/instruments", input);
  }
  updateInstrument(id: string, patch: { name?: string; description?: string; meta?: Record<string, unknown> }): Promise<MusicLibInstrument> {
    return this.http.patch<MusicLibInstrument>(`/api/music/instruments/${encodeURIComponent(id)}`, patch);
  }
  deleteInstrument(id: string): Promise<void> {
    return this.http.del<void>(`/api/music/instruments/${encodeURIComponent(id)}`);
  }

  songs(): Promise<MusicSong[]> {
    return this.http.get<MusicSong[]>("/api/music/songs");
  }
  song(id: string): Promise<MusicSong> {
    return this.http.get<MusicSong>(`/api/music/songs/${encodeURIComponent(id)}`);
  }
  createSong(input: MusicSongInput): Promise<MusicSong> {
    return this.http.post<MusicSong>("/api/music/songs", input);
  }
  updateSong(id: string, patch: MusicSongInput): Promise<MusicSong> {
    return this.http.patch<MusicSong>(`/api/music/songs/${encodeURIComponent(id)}`, patch);
  }
  deleteSong(id: string): Promise<void> {
    return this.http.del<void>(`/api/music/songs/${encodeURIComponent(id)}`);
  }

  /** Server-side regeneration: the CHILD version returns immediately (audio
   *  null) and the take attaches when the job succeeds — poll the job, or
   *  just re-read the song. */
  regenerateSong(id: string, input: { model?: string; seconds?: number } = {}): Promise<{ song: MusicSong; job: MediaJob }> {
    return this.http.post<{ song: MusicSong; job: MediaJob }>(`/api/music/songs/${encodeURIComponent(id)}/regenerate`, input);
  }
}
