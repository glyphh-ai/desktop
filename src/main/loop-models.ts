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
import { execFileSync } from "child_process";
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
 *  list comes from the INSTALLED CLI itself: Codex's models cache, Claude
 *  Code's aliases and the newest id per family in its binary, Gemini CLI's
 *  bundled ids. The CLI's configured model leads. */
function loginModels(cli: string): LoopModel[] {
  const read = (p: string): string => { try { return fs.readFileSync(p, "utf-8"); } catch { return ""; } };
  const rows: LoopModel[] = [];
  const push = (id: string, name = id, providerSlug?: string): void => {
    if (id && !rows.some((r) => r.id === id)) rows.push({ id, name, providerSlug: providerSlug || (providerOf(id) === "other" ? CLI_SLUG[cli] : providerOf(id)) });
  };
  if (cli === "claude") {
    try { const m = (JSON.parse(read(path.join(homedir(), ".claude", "settings.json"))) as { model?: string }).model; if (m) push(m, `${m} · your Claude Code default`); } catch { /* no settings */ }
    const newest = claudeBinaryIds();
    for (const a of CLAUDE_ALIASES) {
      const id = newest.get(a === "opusplan" ? "opus" : a);
      push(a, `${CLAUDE_ALIAS_NAMES[a]}${id ? ` · ${id}` : ""}`);
    }
  } else if (cli === "codex") {
    for (const m of read(path.join(homedir(), ".codex", "config.toml")).matchAll(/^\s*model\s*=\s*"([^"]+)"/gm)) push(m[1]);
    try {
      const cache = JSON.parse(read(path.join(homedir(), ".codex", "models_cache.json"))) as { models?: Array<{ slug: string; display_name?: string; visibility?: string; priority?: number }> };
      for (const m of (cache.models ?? []).filter((x) => x.visibility === "list").sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))) push(m.slug, m.display_name || m.slug, "openai");
    } catch { /* no cache until Codex has run once */ }
  } else if (cli === "gemini") {
    try {
      const j = JSON.parse(read(path.join(homedir(), ".gemini", "settings.json"))) as { model?: string; general?: { model?: string } };
      const m = j.model || j.general?.model; if (m) push(m);
    } catch { /* no settings */ }
    for (const id of geminiBundleIds()) push(id, id, "google");
  }
  return rows;
}

const CLI_SLUG: Record<string, string> = { claude: "anthropic", codex: "openai", gemini: "google" };
/** The aliases Claude Code's --model flag accepts (its help names them), in Claude Code's own picker order. */
const CLAUDE_ALIASES = ["fable", "opus", "sonnet", "haiku", "opusplan"];
const CLAUDE_ALIAS_NAMES: Record<string, string> = { fable: "Fable", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku", opusplan: "Opus plan mode" };

function cliBinary(cli: string): string {
  try {
    const out = execFileSync("/bin/sh", ["-lc", `command -v ${cli}`], { encoding: "utf-8", timeout: 5_000 }).trim();
    return out ? fs.realpathSync(out) : "";
  } catch { return ""; }
}

const binaryIdCache = new Map<string, string[]>();
function idsInBinary(cli: string, pattern: RegExp): string[] {
  const key = `${cli}:${pattern.source}`;
  const hit = binaryIdCache.get(key);
  if (hit) return hit;
  const bin = cliBinary(cli);
  let ids: string[] = [];
  try {
    const text = fs.readFileSync(bin, "latin1");
    ids = [...new Set([...text.matchAll(pattern)].map((m) => m[0]))];
  } catch { ids = []; }
  binaryIdCache.set(key, ids);
  return ids;
}

const numeric = (v: string): number[] => v.split(/[.-]/).map(Number);
const byVersionDesc = (a: string, b: string): number => {
  const [x, y] = [numeric(a), numeric(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (y[i] ?? 0) - (x[i] ?? 0); if (d) return d; }
  return 0;
};

/** The newest full id per family that the installed Claude Code names: what each alias resolves to. */
function claudeBinaryIds(): Map<string, string> {
  const all = idsInBinary("claude", /claude-(fable|opus|sonnet|haiku)-[0-9]+(?:-[0-9]+)?(?![0-9-])/g);
  const newest = new Map<string, string>();
  for (const id of all) {
    const fam = id.split("-")[1];
    const cur = newest.get(fam);
    if (!cur || byVersionDesc(id.slice(fam.length + 8), cur.slice(fam.length + 8)) < 0) newest.set(fam, id);
  }
  return newest;
}

/** The Gemini ids the installed Gemini CLI ships, newest first. */
function geminiBundleIds(): string[] {
  return idsInBinary("gemini", /gemini-[0-9]+(?:\.[0-9]+)?-(?:pro|flash)(?:-lite)?(?:-preview)?(?![a-z0-9.-])/g)
    .sort((a, b) => byVersionDesc(a.replace(/^gemini-/, "").replace(/-(pro|flash).*$/, ""), b.replace(/^gemini-/, "").replace(/-(pro|flash).*$/, "")));
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
  // An endpoint's list sorts; the CLI's own list keeps the CLI's order (configured model first, then its aliases).
  if (value.source !== "login") value.models.sort((a, b) => a.providerSlug.localeCompare(b.providerSlug) || a.name.localeCompare(b.name));
  if (value.ok) cache.set(loopId, { at: Date.now(), value });
  return value;
}

export function invalidateLoopModels(loopId?: string): void {
  if (loopId) cache.delete(loopId); else cache.clear();
}

export function registerLoopModelsIpc(): void {
  ipcMain.handle("loop-models", (_e, loopId: string, force?: boolean) => listLoopModels(String(loopId || ""), !!force));
}
