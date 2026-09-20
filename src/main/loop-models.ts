/**
 * loop-models.ts — THE MODEL LIST IS WHATEVER THE ENDPOINT SAYS (his ruling,
 * 2026-09-15): the picker asks the same base URL the turn will hit, with the
 * same key, and renders the answer. No seeded per-org catalog, no plan branch
 * on the desktop, no local allow-list.
 *
 * A loop (a CLI pre-config) ends up with one of three credentials:
 *   own key   → the vendor's own endpoint, the user's key      (BYOK, ungoverned)
 *   gateway   → the org's gateway, the member's minted key     (governed: the
 *               list is the org's team allow-list, key-scoped by LiteLLM)
 *   login     → the CLI's own login; no endpoint to ask, so the list is the
 *               CLI's own: its configured model + the names its flag accepts
 *
 * The three vendors answer the same question in three dialects; each is
 * normalised to { id, name, providerSlug } where id is the RAW model name the
 * CLI's --model / -m flag takes.
 */

import path from "path";
import fs from "fs";
import { homedir } from "os";
import { ipcMain } from "electron";
import { agentRowFor, CLI_PROFILES } from "./cli-agents";
import { getClient } from "./glyphh-client";
import { gatewayCreds } from "./gateway-token";

export interface LoopModel { id: string; name: string; providerSlug: string; /** "local" = a directory row for a CLI's own login, never proxied. */ source?: string }
export interface LoopModelsResult {
  ok: boolean;
  source: "gateway" | "byok" | "login" | "none";
  baseUrl: string | null;
  models: LoopModel[];
  error?: string;
}

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: LoopModelsResult }>();

/** Provider from a raw model id — display grouping only, never a filter. */
export function providerOf(id: string, ownedBy?: string): string {
  const s = id.toLowerCase();
  if (s.startsWith("claude")) return "anthropic";
  if (/^(gpt|o[0-9]|chatgpt|text-|davinci)/.test(s)) return "openai";
  if (s.startsWith("gemini") || s.startsWith("gemma")) return "google";
  if (s.startsWith("grok")) return "xai";
  if (s.startsWith("mistral") || s.startsWith("codestral") || s.startsWith("ministral")) return "mistral";
  if (s.startsWith("deepseek")) return "deepseek";
  if (s.startsWith("kimi") || s.startsWith("moonshot")) return "moonshot";
  if (s.includes("llama")) return "meta";
  if (s.startsWith("qwen")) return "qwen";
  if (s.startsWith("glm")) return "zai";
  return (ownedBy || "").toLowerCase() || "other";
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.json();
}

/** GET the models list at `base` in the dialect that host speaks. */
async function listAt(cli: string, base: string, token: string, viaGateway: boolean): Promise<LoopModel[]> {
  const root = base.replace(/\/+$/, "");
  // The gateway and OpenAI share the OpenAI dialect. Anthropic's own endpoint
  // wants its key header; Gemini's own endpoint wants ?key= and a v1beta path.
  if (!viaGateway && cli === "claude") {
    const body = await fetchJson(`${root}/v1/models?limit=1000`, { "x-api-key": token, "anthropic-version": "2023-06-01" }) as { data?: Array<{ id: string; display_name?: string }> };
    return (body.data ?? []).map((m) => ({ id: m.id, name: m.display_name || m.id, providerSlug: "anthropic" }));
  }
  if (!viaGateway && cli === "gemini") {
    const body = await fetchJson(`${root}/v1beta/models?pageSize=1000&key=${encodeURIComponent(token)}`, {}) as { models?: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }> };
    return (body.models ?? [])
      .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes("generateContent"))
      .map((m) => ({ id: m.name.replace(/^models\//, ""), name: m.displayName || m.name.replace(/^models\//, ""), providerSlug: "google" }));
  }
  const body = await fetchJson(`${root}/v1/models`, { authorization: `Bearer ${token}` }) as { data?: Array<{ id: string; owned_by?: string }> };
  const rows = (body.data ?? []).map((m) => ({ id: m.id, name: m.id, providerSlug: providerOf(m.id, m.owned_by) }));
  // Gemini CLI speaks Google's protocol only — through the gateway it can
  // still only drive Google models. Claude Code and Codex drive everything
  // the gateway serves (LiteLLM translates both dialects to every vendor).
  return cli === "gemini" ? rows.filter((r) => r.providerSlug === "google") : rows;
}

/** The org's catalog, by the CLI's vendor (his ruling, 2026-09-16: on Free
 *  every curated model is on and the list is just their names; a paid org
 *  with the gateway on gets the gateway's list instead). */
const CLI_VENDOR: Record<string, string> = { claude: "anthropic", codex: "openai", gemini: "google", copilot: "github", cursor: "cursor" };

/**
 * GATEWAY MODE: THE ORG ADMIN OWNS THE LIST (his order, 2026-09-18).
 *
 * The one honest source is the member's own key asked of the gateway: LiteLLM
 * answers with the team's allow-list (what the org admin turned on of ours)
 * plus the org's own deployments, and nothing else. That means the list moves
 * the moment an admin changes it, an org that allows none offers none, and the
 * allowance handover needs no separate wiring here.
 *
 * Asked ONCE, not per loop: every loop offers the same list, so switching
 * loops never changes what can be picked.
 */
const GATEWAY_KEY = "\u0000gateway";

async function orgGatewayModels(): Promise<{ models: LoopModel[]; baseUrl: string | null }> {
  const creds = await gatewayCreds().catch(() => null);
  // The SERVER answers this, not the gateway's own /v1/models: a team-scoped
  // deployment is renamed internally there (model_name_<team>_<uuid>), and an
  // auto-router has no business being offered as a model name at all. Our own
  // endpoint publishes the public name, applies the org's allow-list, and
  // collapses to the auto-router under Auto only (his report, 2026-09-18).
  const rows = await getClient().models.available() as Array<{ name: string; providerSlug: string; modality: string; autoRouter?: boolean; source?: string }>;
  return {
    baseUrl: creds?.baseUrl ?? null,
    models: rows
      .filter((m) => m.modality === "chat")
      .map((m) => ({ id: m.name, name: m.autoRouter ? "Auto" : m.name, providerSlug: m.autoRouter ? "auto" : m.providerSlug, source: m.source })),
  };
}

/**
 * LOGIN LANE, CODEX: a ChatGPT login runs ONLY the models Codex's own picker
 * lists (his report, 2026-09-20: every catalog name — gpt-4.1, gpt-5.1-codex —
 * came back "not supported when using Codex with a ChatGPT account"). Codex
 * caches that list in ~/.codex/models_cache.json; the configured default rides
 * along. An API-key login (auth_mode "apikey") drives the vendor's full list,
 * so the catalog stays right there. Null = nothing to say, use the catalog.
 */
function codexLoginModels(): LoopModel[] | null {
  const home = path.join(homedir(), ".codex");
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(home, "auth.json"), "utf-8")) as { auth_mode?: string };
    if ((auth.auth_mode || "").toLowerCase() !== "chatgpt") return null;
  } catch { return null; }
  let rows: LoopModel[] = [];
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(home, "models_cache.json"), "utf-8")) as { models?: Array<{ slug?: string; display_name?: string; visibility?: string }> };
    rows = (cache.models ?? [])
      .filter((m) => m.slug && m.visibility !== "hide")
      .map((m) => ({ id: m.slug!, name: m.display_name || m.slug!, providerSlug: "openai" }));
  } catch { /* no cache yet: the configured default alone */ }
  try {
    const cfg = fs.readFileSync(path.join(home, "config.toml"), "utf-8");
    const def = /^\s*model\s*=\s*"([^"]+)"/m.exec(cfg)?.[1];
    if (def && !rows.some((r) => r.id === def)) rows.unshift({ id: def, name: def, providerSlug: "openai" });
  } catch { /* no config */ }
  return rows.length ? rows : null;
}

/** What a loop on the CLI's OWN login can run (no endpoint to ask). */
async function loginModels(cli: string): Promise<LoopModel[]> {
  if (cli === "codex") { const own = codexLoginModels(); if (own) return own; }
  return orgModels(cli);
}

async function gatewayMode(): Promise<boolean> {
  try { return !!(await getClient().plans.gates()).gatewayAllowed; } catch { return false; }
}

async function orgModels(cli: string): Promise<LoopModel[]> {
  const vendor = CLI_VENDOR[cli];
  const rows = await getClient().models.available();
  return rows
    .filter((m) => m.modality === "chat" && (!vendor || m.providerSlug === vendor))
    .map((m) => ({ id: m.name, name: m.name, providerSlug: m.providerSlug }));
}

export async function listLoopModels(loopId: string, force = false): Promise<LoopModelsResult> {
  const hit = cache.get(loopId);
  if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const row = agentRowFor(loopId);
  if (!row) return { ok: false, source: "none", baseUrl: null, models: [], error: "loop not found" };
  let value: LoopModelsResult;
  try {
    // Gateway mode short-circuits every other lane: one list, org-controlled,
    // the same for a loop with its own key and a loop on a vendor login.
    if (await gatewayMode()) {
      // ONE org list, asked once; THIS loop sees its own vendor's slice of it
      // (his order, 2026-09-20: Codex offered Claude's models). A CLI speaks
      // its vendor's wire, so the org's allow-list is filtered to the models
      // that loop can drive; the org's auto-router is every loop's.
      const hitAll = cache.get(GATEWAY_KEY);
      const all = !force && hitAll && Date.now() - hitAll.at < TTL_MS ? hitAll.value : await (async () => {
        const { models, baseUrl } = await orgGatewayModels();
        const v: LoopModelsResult = { ok: true, source: "gateway", baseUrl, models };
        cache.set(GATEWAY_KEY, { at: Date.now(), value: v });
        return v;
      })();
      // THE WHOLE PROXIED LIST, ON EVERY LOOP (his order, 2026-09-20): with
      // the gateway on the router translates every dialect, so Claude Code can
      // run an OpenAI model and Codex an Anthropic one. DIRECTORY rows are the
      // exception: they are a CLI's own-login list (Copilot, Cursor), never
      // proxied, so only that CLI's loop sees its own (his report, the same
      // day: the Claude loop listed every Cursor row).
      const vendor = CLI_VENDOR[row.cli];
      value = { ...all, models: all.models.filter((m) => m.source !== "local" || (!!vendor && m.providerSlug === vendor)) };
      value.models.sort((a, b) => a.providerSlug.localeCompare(b.providerSlug) || a.name.localeCompare(b.name));
      cache.set(loopId, { at: Date.now(), value });
      return value;
    }
    // The gateway lane (paid, on): the list is what the org's gateway serves this member.
    const creds = CLI_PROFILES[row.cli]?.baseUrlEnv.length && !row.apiKey ? await gatewayCreds() : null;
    value = creds
      ? { ok: true, source: "gateway", baseUrl: creds.baseUrl, models: await listAt(row.cli, creds.baseUrl, creds.token, true) }
      : { ok: true, source: row.apiKey ? "byok" : "login", baseUrl: null, models: row.apiKey ? await orgModels(row.cli) : await loginModels(row.cli) };
  } catch (err) {
    value = { ok: false, source: "none", baseUrl: null, models: [], error: err instanceof Error ? err.message : String(err) };
  }
  value.models.sort((a, b) => a.providerSlug.localeCompare(b.providerSlug) || a.name.localeCompare(b.name));
  if (value.ok) cache.set(loopId, { at: Date.now(), value });
  return value;
}

export function invalidateLoopModels(loopId?: string): void {
  // The gateway's answer is shared by every loop, so one loop's invalidation
  // must drop it too — otherwise an org admin's change waits out the TTL.
  cache.delete(GATEWAY_KEY);
  if (loopId) cache.delete(loopId); else cache.clear();
}

export function registerLoopModelsIpc(): void {
  ipcMain.handle("loop-models", (_e, loopId: string, force?: boolean) => listLoopModels(String(loopId || ""), !!force));
}
