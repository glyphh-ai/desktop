/**
 * resources/profile.ts — the caller's own editable profile (name + timezone). Acts
 * on the authenticated principal only; there is no id — a user can only read/edit
 * themselves. Email is identity (changed elsewhere) and role is read-only.
 */

import type { AuthedHttp } from "../core/authed-http.js";
import type { SelfProfile, SelfProfileUpdate } from "../contract/user.js";
import { type VoiceSettings, DEFAULT_VOICE_SETTINGS } from "../contract/catalog.js";

export class ProfileClient {
  constructor(private readonly http: AuthedHttp) {}

  /** The caller's editable profile. */
  get(): Promise<SelfProfile> {
    return this.http.get<SelfProfile>("/api/user/me");
  }

  /** Update the caller's name and/or timezone. */
  /** The caller's full preference map (theme, UI + layout state) — org→user
   *  tenant content, stored in the stator. */
  prefs(): Promise<Record<string, unknown>> {
    return this.http.get<{ prefs: Record<string, unknown> }>("/api/me/prefs").then((r) => r.prefs);
  }

  /** Upsert preference keys; a `null` value DELETES that key. Returns the full map. */
  setPrefs(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.http.patch<{ prefs: Record<string, unknown> }>("/api/me/prefs", { prefs: patch }).then((r) => r.prefs);
  }

  update(patch: SelfProfileUpdate): Promise<SelfProfile> {
    return this.http.patch<SelfProfile>("/api/user/me", patch);
  }

  /** Upload the caller's profile image (PNG/JPEG/GIF/WebP, ≤0.5MB; sniffed
   *  server-side). The refreshed profile (with imageUrl) comes from get(). */
  uploadImage(bytes: Uint8Array): Promise<{ key: string; contentType: string; bytes: number }> {
    return this.http.post<{ key: string; contentType: string; bytes: number }>("/api/user/me/image", bytes);
  }

  /** The caller's voice settings (STT input, TTS output + voice, mode). Reads the
   *  `voice` pref key, filled with defaults so callers never see undefined. */
  async voiceSettings(): Promise<VoiceSettings> {
    const p = await this.prefs();
    const v = (p.voice ?? {}) as Partial<VoiceSettings>;
    return { ...DEFAULT_VOICE_SETTINGS, ...v };
  }

  /** Merge-update the caller's voice settings; returns the resolved settings. */
  async setVoiceSettings(patch: Partial<VoiceSettings>): Promise<VoiceSettings> {
    const next = { ...(await this.voiceSettings()), ...patch };
    await this.setPrefs({ voice: next });
    return next;
  }
}
