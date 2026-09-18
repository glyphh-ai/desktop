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
import { ipcMain } from "electron";
import { agentRowFor, CLI_PROFILES } from "./cli-agents";
import { getClient } from "./glyphh-client";
import { gatewayCreds } from "./gateway-token";

export interface LoopModel { id: string; name: string; providerSlug: string }
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
const CLI_VENDOR: Record<string, string> = { claude: "anthropic", codex: "openai", gemini: "google", copilot: "github" };

/**
 * GATEWAY MODE: THE ORG ADMIN OWNS THE LIST (his order, 2026-09-18).
 *
 * When the org runs on the gateway, the models on offer are the ones the org
 * admin added on their own key, and nothing else: not the shared catalog we
 * seed, not the vendor's own list, not the CLI's login. The same list is
 * offered for every loop, so switching loops never changes what can be picked,
 * and an org that has added none offers none.
 *
 * A model added by the org is team-scoped on the gateway, which is exactly
 * what `hasByokKey` reports on the catalog row.
 */
async function orgOwnModels(): Promise<LoopModel[]> {
  const rows = await getClient().models.available() as Array<{ name: string; providerSlug: string; modality: string; hasByokKey?: boolean }>;
  return rows
    .filter((m) => m.modality === "chat" && m.hasByokKey === true)
    .map((m) => ({ id: m.name, name: m.name, providerSlug: m.providerSlug }));
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
      const creds = await gatewayCreds().catch(() => null);
      value = { ok: true, source: "gateway", baseUrl: creds?.baseUrl ?? null, models: await orgOwnModels() };
      cache.set(loopId, { at: Date.now(), value });
      return value;
    }
    // The gateway lane (paid, on): the list is what the org's gateway serves this member.
    const creds = CLI_PROFILES[row.cli]?.baseUrlEnv.length && !row.apiKey ? await gatewayCreds() : null;
    value = creds
      ? { ok: true, source: "gateway", baseUrl: creds.baseUrl, models: await listAt(row.cli, creds.baseUrl, creds.token, true) }
      : { ok: true, source: row.apiKey ? "byok" : "login", baseUrl: null, models: await orgModels(row.cli) };
  } catch (err) {
    value = { ok: false, source: "none", baseUrl: null, models: [], error: err instanceof Error ? err.message : String(err) };
  }
  value.models.sort((a, b) => a.providerSlug.localeCompare(b.providerSlug) || a.name.localeCompare(b.name));
  if (value.ok) cache.set(loopId, { at: Date.now(), value });
  return value;
}

export function invalidateLoopModels(loopId?: string): void {
  if (loopId) cache.delete(loopId); else cache.clear();
}

export function registerLoopModelsIpc(): void {
  ipcMain.handle("loop-models", (_e, loopId: string, force?: boolean) => listLoopModels(String(loopId || ""), !!force));
}
