/**
 * resources/skills.ts — the org's skill library. Any member lists/reads; only an
 * org_admin creates/edits/deletes (server-enforced).
 *
 * `get`/`update`/`remove` accept a slug or an id — the UI holds ids, loops and the
 * CLI use slugs.
 */

import type { AuthedHttp } from "../core/authed-http.js";
import type { Skill, SkillSummary, CreateSkillInput, UpdateSkillInput } from "../contract/skills.js";

export class SkillsClient {
  constructor(private readonly http: AuthedHttp) {}

  async list(): Promise<SkillSummary[]> {
    const { skills } = await this.http.get<{ skills: SkillSummary[] }>("/api/skills");
    return skills;
  }

  get(ref: string): Promise<Skill> {
    return this.http.get<Skill>(`/api/skills/${encodeURIComponent(ref)}`);
  }

  create(input: CreateSkillInput): Promise<Skill> {
    return this.http.post<Skill>("/api/skills", input);
  }

  update(ref: string, patch: UpdateSkillInput): Promise<Skill> {
    return this.http.patch<Skill>(`/api/skills/${encodeURIComponent(ref)}`, patch);
  }

  remove(ref: string): Promise<void> {
    return this.http.del<void>(`/api/skills/${encodeURIComponent(ref)}`);
  }

  /** Submit MY personal skill to the org admin for org-wide sharing. */
  share(ref: string): Promise<{ id: string; status: string }> {
    return this.http.post<{ id: string; status: string }>(`/api/skills/${encodeURIComponent(ref)}/share`, {});
  }

  /** Publish an ORG-shared skill to the marketplace (org_admin; platform-reviewed, always free). */
  publish(ref: string): Promise<{ id: string; reviewStatus: string }> {
    return this.http.post<{ id: string; reviewStatus: string }>(`/api/skills/${encodeURIComponent(ref)}/publish`, {});
  }
}
