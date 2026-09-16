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

import fs from "fs";
import path from "path";
import { homedir } from "os";
import { ipcMain } from "electron";
import { agentRowFor, loopKeyValue, CLI_PROFILES } from "./cli-agents";
import { gatewayCreds } from "./gateway-token";

export interface LoopModel { id: string; name: string; providerSlug: string }
export interface LoopModelsResult {
  ok: boolean;
  source: "gateway" | "byok" | "login" | "none";
  baseUrl: string | null;
  models: LoopModel[];
  error?: string;
}

/** The vendor endpoint a loop's OWN key speaks to (the BYOK lane). */
const VENDOR_BASE: Record<string, string> = {
  claude: "https://api.anthropic.com",
  codex: "https://api.openai.com",
  gemini: "https://generativelanguage.googleapis.com",
};

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

/** The CLI's OWN model list (the login lane, his ruling, 2026-09-16: a free
 *  org rides each member's CLI login and credits). No endpoint to ask, so the
 *  list is what the CLI's config names first, then the aliases its --model
 *  flag accepts. */
function loginModels(cli: string): LoopModel[] {
  const read = (p: string): string => { try { return fs.readFileSync(p, "utf-8"); } catch { return ""; } };
  const names: string[] = [];
  if (cli === "claude") {
    try { const m = (JSON.parse(read(path.join(homedir(), ".claude", "settings.json"))) as { model?: string }).model; if (m) names.push(m); } catch { /* no settings */ }
    names.push("opus", "sonnet", "haiku", "opusplan");
  } else if (cli === "codex") {
    const toml = read(path.join(homedir(), ".codex", "config.toml"));
    for (const m of toml.matchAll(/^\s*model\s*=\s*"([^"]+)"/gm)) names.push(m[1]);
  } else if (cli === "gemini") {
    try {
      const j = JSON.parse(read(path.join(homedir(), ".gemini", "settings.json"))) as { model?: string; general?: { model?: string } };
      const m = j.model || j.general?.model; if (m) names.push(m);
    } catch { /* no settings */ }
    names.push("gemini-2.5-pro", "gemini-2.5-flash");
  }
  const seen = new Set<string>();
  const slug = cli === "claude" ? "anthropic" : cli === "codex" ? "openai" : "google";
  return names.filter((n) => n && !seen.has(n) && seen.add(n)).map((id) => ({ id, name: id, providerSlug: providerOf(id) === "other" ? slug : providerOf(id) }));
}

export async function listLoopModels(loopId: string, force = false): Promise<LoopModelsResult> {
  const hit = cache.get(loopId);
  if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const row = agentRowFor(loopId);
  if (!row) return { ok: false, source: "none", baseUrl: null, models: [], error: "loop not found" };
  const profile = CLI_PROFILES[row.cli];
  // A CLI with no base-URL seam (Copilot, Cursor) runs on its own login.
  if (!profile?.baseUrlEnv.length) return { ok: true, source: "login", baseUrl: null, models: loginModels(row.cli) };
  let value: LoopModelsResult;
  try {
    if (row.apiKey) {
      const key = loopKeyValue(row.id, row.apiKey.name);
      const base = VENDOR_BASE[row.cli];
      if (!key || !base) value = { ok: true, source: "login", baseUrl: null, models: loginModels(row.cli) };
      else value = { ok: true, source: "byok", baseUrl: base, models: await listAt(row.cli, base, key, false) };
    } else {
      const creds = await gatewayCreds();
      if (!creds) value = { ok: true, source: "login", baseUrl: null, models: loginModels(row.cli) };
      else value = { ok: true, source: "gateway", baseUrl: creds.baseUrl, models: await listAt(row.cli, creds.baseUrl, creds.token, true) };
    }
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
