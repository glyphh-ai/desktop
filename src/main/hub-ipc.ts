/**
 * hub-ipc.ts — the AI HUB lanes (his order, 2026-09-15: the Marketplace is
 * back and hardcodes to the org's AI Hub on the console).
 *
 *   hub-url      the hub in a work panel, signed in: a console session minted
 *                on this login (POST /api/gateway/ui-session) handed to the
 *                console's login page as ?handoff=…&next=/ui/model-hub-table
 *   hub-publish  a local skill / task / agent → the org library (promote); an
 *                org admin's own goes live at once, a member's lands on the
 *                review desk
 *   hub-sync     everything the caller INSTALLED on the hub → local rows
 *                (~/.glyphh/{skills,tasks,agents}) so the pages and the loops
 *                see them like anything built here
 */

import { ipcMain } from "electron";
import { getClient, PLATFORM_URL } from "./glyphh-client.js";
import { getSkillRow, getTaskRow, putSkillRow, saveTaskSpec } from "./local-library.js";
import { getAgent, saveAgent } from "./local-agents.js";

type Kind = "skill" | "task" | "agent";
const KINDS: readonly Kind[] = ["skill", "task", "agent"];

interface HubItem { id: string; kind: Kind; slug: string; name: string; description: string; installed: boolean; headVersion: number | null }
interface Role { name?: string; label?: string; description?: string; default?: string | null; model?: string | null }

const env = async <T>(fn: () => Promise<T>): Promise<{ ok: boolean; data?: T; error?: string }> => {
  try { return { ok: true, data: await fn() }; }
  catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
};

function payloadOf(kind: Kind, ref: string): { slug: string; name: string; description: string; payload: unknown } {
  if (kind === "skill") {
    const r = getSkillRow(ref);
    return { slug: r.slug, name: r.name, description: r.description, payload: { manifest: r.manifest, prompt: r.prompt, code: r.code } };
  }
  if (kind === "task") {
    const r = getTaskRow(ref);
    return { slug: r.slug, name: r.name, description: r.description, payload: { manifest: r.manifest, code: r.code } };
  }
  const a = getAgent(ref);
  return {
    slug: a.slug, name: a.name, description: a.description,
    payload: {
      prompt: a.prompt, loopId: a.loopId, provider: a.provider, model: a.model,
      selections: { roles: [], skills: a.skills, apps: a.apps }, guardrails: a.guardrails,
    },
  };
}

function importOne(kind: Kind, it: HubItem, p: Record<string, unknown>): void {
  const str = (k: string): string => (typeof p[k] === "string" ? (p[k] as string) : "");
  const manifest = (p.manifest && typeof p.manifest === "object" ? p.manifest : {}) as Record<string, unknown>;
  if (kind === "skill") {
    putSkillRow({ slug: it.slug, name: it.name, description: it.description, manifest, prompt: str("prompt"), code: str("code") });
    return;
  }
  if (kind === "task") {
    const roles = (Array.isArray(manifest.roles) ? manifest.roles : []) as Role[];
    saveTaskSpec({
      slug: it.slug, name: it.name, description: it.description, program: str("code"),
      slots: roles.map((r) => ({ name: r.name, label: r.label, description: r.description, agent: r.default ?? null, model: r.model ?? null })),
    });
    return;
  }
  const sel = (p.selections && typeof p.selections === "object" ? p.selections : {}) as { skills?: unknown; apps?: unknown };
  saveAgent({
    slug: it.slug, name: it.name, description: it.description, prompt: str("prompt"),
    loopId: typeof p.loopId === "string" ? p.loopId : null, provider: str("provider"), model: str("model"),
    skills: Array.isArray(sel.skills) ? sel.skills.map(String) : [], apps: Array.isArray(sel.apps) ? sel.apps.map(String) : [],
    guardrails: (p.guardrails && typeof p.guardrails === "object" ? p.guardrails : null) as never,
  });
}

export function registerHubIpc(): void {
  ipcMain.handle("hub-url", () => env(async () => {
    const { token } = await getClient().http.post<{ token: string }>("/api/gateway/ui-session");
    const next = encodeURIComponent("/ui/model-hub-table?embed=1");
    return { url: `${PLATFORM_URL}/ui/login?handoff=${encodeURIComponent(token)}&next=${next}` };
  }));

  ipcMain.handle("hub-publish", (_e, kind: Kind, ref: string, notes?: string) => env(async () => {
    if (!KINDS.includes(kind)) throw new Error(`cannot publish a ${String(kind)}`);
    const { slug, name, description, payload } = payloadOf(kind, ref);
    return getClient().orgLibrary.promote(kind, { slug, name, description, notes: String(notes ?? ""), payload });
  }));

  ipcMain.handle("hub-sync", () => env(async () => {
    const client = getClient();
    const counts: Record<Kind, number> = { skill: 0, task: 0, agent: 0 };
    const errors: string[] = [];
    for (const kind of KINDS) {
      const items = (await client.orgLibrary.list(kind)) as unknown as HubItem[];
      for (const it of items.filter((i) => i.installed && i.headVersion)) {
        try {
          const p = await client.http.get<Record<string, unknown>>(`/api/library/${kind}/${encodeURIComponent(it.id)}/payload`);
          importOne(kind, it, p && typeof p === "object" ? p : {});
          counts[kind] += 1;
        } catch (err) {
          errors.push(`${kind} ${it.slug}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return { counts, errors };
  }));
}
