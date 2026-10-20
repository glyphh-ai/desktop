/**
 * contract/catalog.ts — the provider/model catalog. Glyphh (super_admin) releases
 * providers + models; an org enables a subset and may attach a BYOK key (write-only
 * — never returned). Workspaces filter within the org's catalog. The list price
 * on a row is INFORMATIONAL — the vendor's dollars per 1M tokens — never a bill:
 * LLM calls are the org's own dollars on its gateway keys.
 */

export type ProviderKind = "proxied" | "open_weight";

export interface Provider {
  slug: string; // "anthropic", "openai", "openweights"
  name: string;
  kind: ProviderKind;
  /** Short @-mention name (no hyphens). Null = not mentionable. */
  alias: string | null;
  /** OpenAI-compatible base for this provider (e.g. a Gemini or Groq host).
   *  Null = the built-in default. One converter, many addresses. */
  baseUrl: string | null;
  /** Is this provider enabled for the caller's org. */
  enabledForOrg: boolean;
  /** Non-secret summary of the stored BYOK key (sk-ant-…abcd); null when unset. */
  byokHint?: string | null;
  /** Does the org have a BYOK key set (never the key itself). */
  hasByokKey: boolean;
}

/** What a model produces. Drives picker/loop-slot filtering + how it's metered. */
export type Modality = "chat" | "image" | "video" | "speech" | "transcription" | "music" | "audio" | "dubbing";
/** The unit the list prices are quoted in. 'mtok'/'mchar' bill per million,
 *  'kchar' per thousand, the rest per single unit. */
export type RateUnit = "mtok" | "image" | "second" | "mchar" | "minute" | "kchar" | "hour" | "generation";

export interface Model {
  id: string; // "anthropic::claude-opus-4-8"
  providerSlug: string;
  name: string;
  /** Short @-mention name; unique per provider. Null = not mentionable. */
  alias: string | null;
  kind: ProviderKind;
  modality: Modality;
  /** Unit the rates below are quoted in (mtok/image/second/mchar/minute). */
  rateUnit: RateUnit;
  /** The vendor's list price per input unit, in dollars (per rateUnit). Chat:
   *  per 1M input tokens. Informational. */
  inputUsdPerMTok: number;
  /** The vendor's list price per output unit, in dollars. Chat: per 1M output
   *  tokens. Image: per image. Video: per second. Informational. */
  outputUsdPerMTok: number;
  /** Total tokens the model accepts. Null = unrecorded, not enforced. */
  contextWindow: number | null;
  /** Largest single completion. Null = unrecorded. */
  maxOutputTokens: number | null;
  active: boolean;
  /** Live per-org default: orgs with no explicit org_models override follow this. */
  defaultOn: boolean;
  /** One of the handful of models a Free org gets (his order, 2026-10-04). */
  freePlan?: boolean;
}

/** org_admin: enable a provider for the org, optionally with a BYOK key (write-only). */
export interface EnableProviderInput {
  slug: string;
  key?: string;
}

/** super_admin: release a provider into the platform catalog. */
export interface ProviderCreate {
  /** Omit to keep the stored address; null clears it to the default. */
  baseUrl?: string | null;
  /** Short @-mention name (no hyphens). Omit to keep the stored one. */
  alias?: string | null;
  slug: string;
  name: string;
  kind: ProviderKind;
}

/** super_admin: release a model (+ its informational list price). */
export interface ModelCreate {
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  /** Short @-mention name; unique per provider. */
  alias?: string | null;
  id: string;
  providerSlug: string;
  name: string;
  kind: ProviderKind;
  /** Defaults to 'chat' / 'mtok' when omitted. */
  modality?: Modality;
  rateUnit?: RateUnit;
  /** Vendor list price, dollars per unit — informational; omit when unknown. */
  inputUsdPerMTok?: number;
  outputUsdPerMTok?: number;
  /** Live per-org default: orgs with no explicit override follow this. Omit → false (opt-in). */
  defaultOn?: boolean;
  /** One of the handful of models a Free org gets. Omit → false. */
  freePlan?: boolean;
}

/** super_admin: update a model's list price / availability. */
export interface ModelPricing {
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  /** Null clears the alias; omit to keep it. */
  alias?: string | null;
  inputUsdPerMTok?: number;
  outputUsdPerMTok?: number;
  modality?: Modality;
  rateUnit?: RateUnit;
  active?: boolean;
  /** Live per-org default: orgs with no explicit override follow this. */
  defaultOn?: boolean;
  /** One of the handful of models a Free org gets. */
  freePlan?: boolean;
}

/** A TTS provider's voice — a synthesis call is model + voice. */
export interface Voice {
  id: string;
  name: string;
  providerSlug: string;
  /** A short sample the UI can play, when the provider gives one. */
  previewUrl?: string;
  /** premade | cloned | generated, or absent. */
  category?: string;
}

/** The caller's persisted voice preferences (stored in prefs under the `voice` key). */
export interface VoiceSettings {
  /** STT model id for voice INPUT (e.g. openai::whisper-1). Null = no voice input. */
  inputModel: string | null;
  /** TTS model id for voice OUTPUT (e.g. elevenlabs::eleven_flash_v2_5). Null = off. */
  outputModel: string | null;
  /** The output model's voice id (provider-specific). Null = provider default. */
  voiceId: string | null;
  /** The chosen microphone (OS deviceId). Null = system default. */
  deviceId: string | null;
  /** Capture mode for talk-to-agent. */
  mode: "off" | "push-to-talk" | "continuous";
  /** Auto-play the agent's spoken reply. */
  autoplay: boolean;
  /** Speech mode: steer the agent to answer in a couple of short, spoken-style
   *  sentences (no lists/code/headings) — affects both what's SAID and what's
   *  rendered to the screen. */
  brief: boolean;
}

/** The defaults a fresh account starts from. */
export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  // The mic is ON by default (his order, 2026-10-06: the voice features are
  // always on and available); the super admin's speech models fill the model
  // fields on the client when a member never picked. "off" is a member's choice.
  inputModel: null, outputModel: null, voiceId: null, deviceId: null, mode: "push-to-talk", autoplay: true, brief: false,
};

// ── Hugging Face open-weight search (proxied server-side) ─────────────────────
/** A GGUF repo hit from HF search. */
export interface HfRepo {
  repo: string;
  downloads: number;
}
/** A curated open-weight recommendation (shown when the search box is empty). */
export interface HfRecommended {
  repo: string;
  displayName: string;
  description: string;
}
/** The hf-search result: raw repo hits + curated recommendations. */
export interface HfSearchResult {
  repos: HfRepo[];
  recommended: HfRecommended[];
}
/** One downloadable GGUF quant within a repo. */
export interface HfQuant {
  file: string;
  url: string;
  sizeBytes: number;
  sha256: string;
  contextTokens: number;
  minRamGb: number;
}
