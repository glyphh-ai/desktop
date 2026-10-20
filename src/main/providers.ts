/**
 * providers.ts — THE USER'S PROVIDERS, MODELS AND KEYS: what the router
 * (@glyphh/sdk/router) routes to. One file, ~/.glyphh/users/<user>/providers.json
 * (0600), read by the desktop and the terminal agent alike:
 *
 *   providers   how to reach each one: its kind, name, base URL and key
 *   models      what each is used for: chat (the agent), transcription
 *               (dictation), speech (reading replies aloud), embeddings
 *               (memory and search), image or video (made when a loop asks)
 *   defaults    the model of each type a new session, the mic, the speaker
 *               and memory start on, and the speaking voice
 *
 * A provider saved without a key takes its kind's environment variable
 * (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY) at read time, so a key
 * kept in the shell never lands on disk. With no file yet, a key in the
 * environment (or the single Anthropic key the first local build saved in
 * provider-keys.json) stands up that provider with its usual models.
 *
 * Electron-free on purpose: the CLI imports it.
 */

import fs from "fs";
import path from "path";
import {
  MODEL_TYPES, PROVIDER_KINDS, ROUTER_BASE_URL, ROUTER_TOKEN, modelId,
  type ModelType, type ProviderKind, type RouterConfig, type RouterModel, type RouterProvider,
} from "@glyphh/sdk/router";
import { userScopedPath } from "./app-paths.js";

export type { ModelType, ProviderKind, RouterModel, RouterProvider };

export type ProviderDefaults = Partial<Record<ModelType, string>> & { voice?: string };

export interface ProvidersFile {
  providers: RouterProvider[];
  models: RouterModel[];
  defaults: ProviderDefaults;
}

/** The environment variable each kind's key may come from. */
export const KEY_ENV: Record<ProviderKind, string | null> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  "openai-compatible": null,
};

/** What each kind is called when the user does not name it. */
export const KIND_NAME: Record<ProviderKind, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Google Gemini",
  "openai-compatible": "OpenAI-compatible",
};

/** The models a provider stood up from a bare key starts with. */
const STARTER_MODELS: Record<Exclude<ProviderKind, "openai-compatible">, Array<{ model: string; type: ModelType }>> = {
  anthropic: [
    { model: "claude-opus-5-5", type: "chat" },
    { model: "claude-fable-5-1", type: "chat" },
    { model: "claude-sonnet-5-5", type: "chat" },
    { model: "claude-haiku-5-5", type: "chat" },
  ],
  openai: [
    { model: "gpt-5.1", type: "chat" },
    { model: "gpt-4o-mini-transcribe", type: "transcription" },
    { model: "gpt-4o-mini-tts", type: "speech" },
    { model: "text-embedding-3-small", type: "embeddings" },
  ],
  gemini: [
    { model: "gemini-2.5-pro", type: "chat" },
    { model: "gemini-2.5-flash", type: "chat" },
    { model: "gemini-embedding-001", type: "embeddings" },
  ],
};

const file = (): string => userScopedPath("providers.json");
const legacyKeyFile = (): string => userScopedPath("provider-keys.json");

const isKind = (v: unknown): v is ProviderKind => PROVIDER_KINDS.includes(v as ProviderKind);
const isType = (v: unknown): v is ModelType => MODEL_TYPES.includes(v as ModelType);

/** A provider id from its name: lowercase, dashed, unique among `taken`. */
export function providerIdFor(name: string, taken: readonly string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "provider";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

function starter(kind: Exclude<ProviderKind, "openai-compatible">): { provider: RouterProvider; models: RouterModel[] } {
  const provider: RouterProvider = { id: kind, kind, name: KIND_NAME[kind] };
  const models = STARTER_MODELS[kind].map((m) => ({ id: modelId(kind, m.model), provider: kind, model: m.model, type: m.type }));
  return { provider, models };
}

/** The first local build kept one Anthropic key in provider-keys.json. */
function legacyAnthropicKey(): string {
  try {
    const j = JSON.parse(fs.readFileSync(legacyKeyFile(), "utf-8")) as { anthropic?: unknown };
    return typeof j.anthropic === "string" ? j.anthropic.trim() : "";
  } catch {
    return "";
  }
}

/** What the user has before they saved anything: a provider per key the
 *  environment (or the legacy key file) holds, with its starter models. */
function seeded(): ProvidersFile {
  const out: ProvidersFile = { providers: [], models: [], defaults: {} };
  for (const kind of ["anthropic", "openai", "gemini"] as const) {
    const key = process.env[KEY_ENV[kind]!]?.trim() || (kind === "anthropic" ? legacyAnthropicKey() : "");
    if (!key) continue;
    const s = starter(kind);
    if (kind === "anthropic" && !process.env.ANTHROPIC_API_KEY?.trim()) s.provider.apiKey = key;
    out.providers.push(s.provider);
    out.models.push(...s.models);
  }
  for (const t of MODEL_TYPES) {
    const first = out.models.find((m) => m.type === t);
    if (first) out.defaults[t] = first.id;
  }
  return out;
}

function clean(raw: unknown): ProvidersFile {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<ProvidersFile>;
  const providers = (Array.isArray(o.providers) ? o.providers : [])
    .filter((p): p is RouterProvider => !!p && typeof p.id === "string" && !!p.id && isKind(p.kind))
    .map((p) => ({
      id: p.id, kind: p.kind, name: String(p.name || KIND_NAME[p.kind]),
      ...(p.baseUrl ? { baseUrl: String(p.baseUrl) } : {}),
      ...(p.apiKey ? { apiKey: String(p.apiKey) } : {}),
    }));
  const ids = new Set(providers.map((p) => p.id));
  const models = (Array.isArray(o.models) ? o.models : [])
    .filter((m): m is RouterModel => !!m && ids.has(m.provider) && typeof m.model === "string" && !!m.model && isType(m.type))
    .map((m) => ({ id: modelId(m.provider, m.model), provider: m.provider, model: m.model, type: m.type, ...(m.label ? { label: String(m.label) } : {}) }));
  const d = (o.defaults && typeof o.defaults === "object" ? o.defaults : {}) as ProviderDefaults;
  const defaults: ProviderDefaults = {};
  for (const t of MODEL_TYPES) if (d[t] && models.some((m) => m.id === d[t] && m.type === t)) defaults[t] = d[t];
  if (typeof d.voice === "string" && d.voice) defaults.voice = d.voice;
  return { providers, models, defaults };
}

/** The saved file, exactly as stored (keys included): what Settings edits. */
export function readStoredProviders(): ProvidersFile {
  try {
    return clean(JSON.parse(fs.readFileSync(file(), "utf-8")));
  } catch {
    return seeded();
  }
}

function write(next: ProvidersFile): ProvidersFile {
  const target = file();
  const tmp = `${target}.${process.pid}.tmp`;
  const value = clean(next);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, target);
  return value;
}

/** A provider's key as the router uses it: its own, else its kind's environment variable. */
export function effectiveKey(p: RouterProvider): string | undefined {
  const own = p.apiKey?.trim();
  if (own) return own;
  const env = KEY_ENV[p.kind];
  return (env && process.env[env]?.trim()) || undefined;
}

/** What the router routes by, keys resolved. Read per call, so a save applies at once. */
export function routerConfig(): RouterConfig {
  const f = readStoredProviders();
  return {
    providers: f.providers.map((p) => {
      const key = effectiveKey(p);
      return key ? { ...p, apiKey: key } : { ...p };
    }),
    models: f.models,
  };
}

/** The loop's credential: the router's address, or null with no provider set up
 *  (the loop then says to add one). */
export async function routerCreds(): Promise<{ baseUrl: string; token: string } | null> {
  return readStoredProviders().providers.length ? { baseUrl: ROUTER_BASE_URL, token: ROUTER_TOKEN } : null;
}

/** The models of one type, in the order they were added. */
export function modelsOfType(type: ModelType): RouterModel[] {
  return readStoredProviders().models.filter((m) => m.type === type);
}

/** The model of a type a new session (or the mic, or the speaker) starts on. */
export function defaultModel(type: ModelType): string {
  const f = readStoredProviders();
  return f.defaults[type] ?? f.models.find((m) => m.type === type)?.id ?? "";
}

/** Is there a chat model the agent can run on, with a provider that can be called? */
export function hasChatModel(): boolean {
  const cfg = routerConfig();
  return cfg.models.some((m) => m.type === "chat" && cfg.providers.some((p) => p.id === m.provider && (p.kind === "openai-compatible" || !!p.apiKey)));
}

// ── edits (Settings › Models) ───────────────────────────────────────────────

/** Add or update a provider. A new one without an id gets one from its name.
 *  An empty key keeps the stored key; `clearKey` removes it. */
export function saveProvider(input: { id?: string; kind: ProviderKind; name?: string; baseUrl?: string; apiKey?: string; clearKey?: boolean }): RouterProvider {
  if (!isKind(input.kind)) throw new Error(`unknown provider kind: ${String(input.kind)}`);
  const f = readStoredProviders();
  const name = (input.name ?? "").trim() || KIND_NAME[input.kind];
  const id = input.id && f.providers.some((p) => p.id === input.id) ? input.id : providerIdFor(name, f.providers.map((p) => p.id));
  const had = f.providers.find((p) => p.id === id);
  const baseUrl = (input.baseUrl ?? had?.baseUrl ?? "").trim();
  if (input.kind === "openai-compatible" && !baseUrl) throw new Error("an OpenAI-compatible provider needs a base URL");
  const key = input.clearKey ? "" : (input.apiKey ?? "").trim() || had?.apiKey || "";
  const provider: RouterProvider = { id, kind: input.kind, name, ...(baseUrl ? { baseUrl } : {}), ...(key ? { apiKey: key } : {}) };
  const providers = had ? f.providers.map((p) => (p.id === id ? provider : p)) : [...f.providers, provider];
  write({ ...f, providers });
  return provider;
}

/** Remove a provider, its models, and any default that pointed at them. */
export function removeProvider(id: string): void {
  const f = readStoredProviders();
  write({ ...f, providers: f.providers.filter((p) => p.id !== id), models: f.models.filter((m) => m.provider !== id) });
}

/** Add a model (or retype one already there). */
export function saveModel(input: { provider: string; model: string; type: ModelType; label?: string }): RouterModel {
  const f = readStoredProviders();
  if (!f.providers.some((p) => p.id === input.provider)) throw new Error(`no provider ${input.provider}`);
  if (!isType(input.type)) throw new Error(`unknown model type: ${String(input.type)}`);
  const name = input.model.trim();
  if (!name) throw new Error("a model needs a name");
  const model: RouterModel = { id: modelId(input.provider, name), provider: input.provider, model: name, type: input.type, ...(input.label?.trim() ? { label: input.label.trim() } : {}) };
  const models = f.models.some((m) => m.id === model.id) ? f.models.map((m) => (m.id === model.id ? model : m)) : [...f.models, model];
  write({ ...f, models });
  return model;
}

export function removeModel(id: string): void {
  const f = readStoredProviders();
  write({ ...f, models: f.models.filter((m) => m.id !== id) });
}

/** Set (or with "" clear) the default model of a type, or the speaking voice. */
export function setDefault(key: ModelType | "voice", value: string): ProviderDefaults {
  const f = readStoredProviders();
  const defaults = { ...f.defaults };
  if (value) defaults[key] = value;
  else delete defaults[key];
  return write({ ...f, defaults }).defaults;
}

/** The file as Settings shows it: keys masked, with whether each is set and where from. */
export function providersView(): {
  providers: Array<Omit<RouterProvider, "apiKey"> & { keySet: boolean; keyFrom: "saved" | "environment" | null; keyHint: string }>;
  models: RouterModel[];
  defaults: ProviderDefaults;
} {
  const f = readStoredProviders();
  return {
    providers: f.providers.map(({ apiKey, ...p }) => {
      const env = KEY_ENV[p.kind];
      const fromEnv = !apiKey && !!env && !!process.env[env]?.trim();
      const key = apiKey || (fromEnv ? process.env[env!]!.trim() : "");
      return { ...p, keySet: !!key, keyFrom: apiKey ? "saved" : fromEnv ? "environment" : null, keyHint: key ? `…${key.slice(-4)}` : "" };
    }),
    models: f.models,
    defaults: f.defaults,
  };
}
