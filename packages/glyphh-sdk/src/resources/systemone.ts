/**
 * resources/systemone.ts — DECIDE: Jev, TypeSafe's System One decision model,
 * through GlyphhRouter.
 *
 * A decision is a STATE (text, an object or an array) and a map of QUESTIONS,
 * each one of three kinds:
 *   noul    yes/no            → { noul: 0..1 }
 *   choice  one of N options  → { choice, probabilities, confidence }
 *   score   an ordered scale  → { score, legend, probabilities, confidence }
 * Jev answers with numbers, never generated prose, so the same state and the
 * same questions land on the same answer.
 *
 * Every call goes to GlyphhRouter's `POST {gatewayBaseUrl}/v1/systemone` on the
 * member's own gateway key — TypeSafe's request and response shape, metered and
 * budget-walled like every other model call (402 = the wall). The SDK never
 * calls TypeSafe directly.
 *
 * Two doors:
 *   - `client.decide(req)` / `client.route(state, branches, opts)` on a signed-in
 *     Client (the credential comes from `gateway.token()`, cached, dropped on 401);
 *   - `jevDecide(conn, req)` / `jevRoute(conn, ...)` for code that already holds a
 *     gateway URL + token (a task runner, a pod) and no Client.
 *
 * ROUTING IS DETERMINISTIC. `route` asks ONE `choice` question whose options are
 * the branches and then `pickBranch` turns the answer into a branch with a pure
 * function: the branch with the highest probability wins, a tie goes to the branch
 * listed first, and below `minConfidence` the `fallback` branch is taken. Same
 * answer → same branch, always; no text generation is involved anywhere.
 */

import type { GatewayClient } from "./gateway.js";
import { ApiError, ConnectError, ProtocolError, ValidationError, apiErrorFor } from "../core/errors.js";

// ── the wire ──────────────────────────────────────────────────────────────────

/** The model a request names when it names none. */
export const JEV_DEFAULT_MODEL = "jev-latest";
/** A `choice` question takes at most this many options. */
export const JEV_MAX_CHOICES = 255;
/** A `score` question takes 2..10 ordered levels. */
export const JEV_MIN_SCORE_LEVELS = 2;
export const JEV_MAX_SCORE_LEVELS = 10;

/** JSON as Jev reads it: instructions, criteria and the state may each be text, an object or an array. */
export type JevValue = string | number | boolean | null | readonly JevValue[] | { readonly [key: string]: JevValue };
/** Text, or a structured object/array (an object can carry reference data the instructions cite by name in backticks). */
export type JevText = string | readonly JevValue[] | { readonly [key: string]: JevValue };
/** What is being decided about. */
export type JevState = JevText;

export interface JevNoulQuestion {
  type: "noul";
  instructions: JevText;
  /** What counts as yes / no (optional). */
  criteria?: { true?: JevText; false?: JevText };
}

export interface JevChoiceQuestion<O extends string = string> {
  type: "choice";
  instructions: JevText;
  /** Option → its description (or null), up to 255 options. */
  criteria: { readonly [K in O]: JevText | null };
}

export interface JevScoreQuestion {
  type: "score";
  instructions: JevText;
  /** The ordered levels, lowest first: 2..10 of them. */
  criteria: readonly JevText[];
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;
/** You pick the keys; they are never sent to the model and never used in inference. */
export type JevQuestions = { readonly [key: string]: JevQuestion };

export interface JevNoulAnswer {
  type: "noul";
  /** 0 = no, 1 = yes. */
  noul: number;
}

export interface JevChoiceAnswer<O extends string = string> {
  type: "choice";
  /** The highest-probability option. */
  choice: O;
  /** Option → probability; sums to 1. */
  probabilities: Record<O, number>;
  /** 0..1. */
  confidence: number;
}

export interface JevScoreAnswer {
  type: "score";
  /** Probability-weighted level index; may land between levels. */
  score: number;
  /** Level index (as a string) → its description. */
  legend: Record<string, string>;
  /** Level index (as a string) → probability; sums to 1. */
  probabilities: Record<string, number>;
  /** 0..1. */
  confidence: number;
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

/** The answer a question gets: a choice question's answer is typed by its options. */
export type JevAnswerFor<Q> =
  Q extends { type: "noul" } ? JevNoulAnswer
  : Q extends { type: "choice"; criteria: infer C } ? JevChoiceAnswer<Extract<keyof C, string>>
  : Q extends { type: "score" } ? JevScoreAnswer
  : JevAnswer;

export interface DecideRequest<Q extends JevQuestions = JevQuestions> {
  state: JevState;
  questions: Q;
  /** Default `jev-latest`. */
  model?: string;
}

export interface JevUsage { input_tokens: number; output_tokens: number }

export interface DecideResponse<Q extends JevQuestions = JevQuestions> {
  /** The resolved version, e.g. `jev-1.13.0`. */
  model: string;
  /** One answer per question, under the same keys. */
  answers: { [K in keyof Q]: JevAnswerFor<Q[K]> };
  usage: JevUsage;
}

// ── routing ───────────────────────────────────────────────────────────────────

/** Branches in order: a list of keys, or key → description (insertion order is the tie-break order). */
export type RouteBranches<B extends string = string> = readonly B[] | { readonly [K in B]: JevText | null };

export interface RouteOptions<F extends string = never> {
  /** What to ask. Default: pick the one branch that best fits the state. */
  instructions?: JevText;
  /** Below this confidence (0..1) the `fallback` branch is taken. Requires `fallback`. */
  minConfidence?: number;
  /** The branch taken when confidence is under `minConfidence`; need not be one Jev may pick. */
  fallback?: F;
  /** Default `jev-latest`. */
  model?: string;
}

export interface RouteDecision<B extends string = string> {
  /** The winning branch (or the fallback). */
  branch: B;
  /** Jev's confidence in its answer, 0..1. */
  confidence: number;
  /** Branch → probability, every branch listed (0 when Jev gave none). */
  probabilities: Record<string, number>;
  /** True when confidence was under `minConfidence` and `fallback` was taken. */
  fellBack: boolean;
}

export interface RouteResult<B extends string = string> extends RouteDecision<B> {
  model: string;
  usage: JevUsage;
}

/** The question key `route` asks under. */
export const ROUTE_QUESTION_KEY = "route";
const DEFAULT_ROUTE_INSTRUCTIONS = "Pick the one option that best fits the state.";

/** The branch keys of `branches`, in order. */
export function branchKeys<B extends string>(branches: RouteBranches<B>): B[] {
  return (Array.isArray(branches) ? [...(branches as readonly B[])] : Object.keys(branches)) as B[];
}

/**
 * THE ROUTING RULE — a pure function of Jev's answer. The branch with the highest
 * probability wins; equal probabilities go to the branch listed first; under
 * `minConfidence` the `fallback` is taken. With no probabilities at all, Jev's own
 * `choice` stands when it is a listed branch. Same answer → same branch.
 */
export function pickBranch<B extends string, F extends string = never>(
  answer: JevChoiceAnswer,
  branches: RouteBranches<B>,
  opts: Pick<RouteOptions<F>, "minConfidence" | "fallback"> = {},
): RouteDecision<B | F> {
  const keys = branchKeys(branches);
  if (!keys.length) throw new ValidationError({ code: "E_JEV_INVALID", httpStatus: 0, message: "route needs at least one branch" });
  const given = answer.probabilities ?? {};
  const probabilities: Record<string, number> = {};
  let best: B | null = null;
  let bestP = -Infinity;
  let any = false;
  for (const k of keys) {
    const raw = (given as Record<string, unknown>)[k];
    const p = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
    if (typeof raw === "number" && Number.isFinite(raw)) any = true;
    probabilities[k] = p;
    if (p > bestP) { best = k; bestP = p; } // strictly greater: the earlier branch keeps a tie
  }
  if (!any && keys.includes(answer.choice as B)) best = answer.choice as B;
  const confidence = typeof answer.confidence === "number" && Number.isFinite(answer.confidence) ? answer.confidence : 0;
  if (opts.minConfidence !== undefined && confidence < opts.minConfidence && opts.fallback !== undefined) {
    return { branch: opts.fallback, confidence, probabilities, fellBack: true };
  }
  return { branch: best as B, confidence, probabilities, fellBack: false };
}

/** The decide request `route` sends: one `choice` question whose options are the branches. */
export function routeRequest<B extends string>(state: JevState, branches: RouteBranches<B>, opts: RouteOptions<string> = {}): DecideRequest<{ route: JevChoiceQuestion<B> }> {
  const keys = branchKeys(branches);
  const criteria = {} as Record<B, JevText | null>;
  for (const k of keys) criteria[k] = Array.isArray(branches) ? null : (branches as Record<B, JevText | null>)[k] ?? null;
  return {
    state,
    questions: { [ROUTE_QUESTION_KEY]: { type: "choice", instructions: opts.instructions ?? DEFAULT_ROUTE_INSTRUCTIONS, criteria } } as { route: JevChoiceQuestion<B> },
    ...(opts.model ? { model: opts.model } : {}),
  };
}

/** One answer, as a log line wants it: the chosen value and the confidence — never the state. */
export type JevAnswerSummary =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number }
  | { type: "score"; score: number; confidence: number };

/** What a decision log records: per question key, the chosen value + confidence. */
export function decisionSummary(answers: { readonly [key: string]: JevAnswer }): Record<string, JevAnswerSummary> {
  const out: Record<string, JevAnswerSummary> = {};
  for (const [k, a] of Object.entries(answers)) {
    if (a.type === "noul") out[k] = { type: "noul", noul: a.noul };
    else if (a.type === "choice") out[k] = { type: "choice", choice: a.choice, confidence: a.confidence };
    else if (a.type === "score") out[k] = { type: "score", score: a.score, confidence: a.confidence };
  }
  return out;
}

/** The same, as one short line: `team=billing (0.82), urgent=0.93, anger=1.10 (0.85)`. */
export function decisionLine(answers: { readonly [key: string]: JevAnswer }): string {
  return Object.entries(decisionSummary(answers)).map(([k, a]) =>
    a.type === "noul" ? `${k}=${a.noul.toFixed(2)}`
    : a.type === "choice" ? `${k}=${a.choice} (${a.confidence.toFixed(2)})`
    : `${k}=${a.score.toFixed(2)} (${a.confidence.toFixed(2)})`).join(", ");
}

// ── validation ────────────────────────────────────────────────────────────────

const invalid = (message: string): ValidationError => new ValidationError({ code: "E_JEV_INVALID", httpStatus: 0, message });

function isText(v: unknown): boolean {
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return !!v && typeof v === "object";
}

/** Check a decide request before it is sent: the rules TypeSafe's 422 enforces, caught here. */
export function validateDecideRequest(req: DecideRequest): void {
  if (!req || typeof req !== "object") throw invalid("a decide request is an object: { state, questions, model? }");
  if (req.state === undefined || req.state === null || !(typeof req.state === "string" || typeof req.state === "object")) {
    throw invalid("`state` is required: text, an object or an array");
  }
  if (req.model !== undefined && (typeof req.model !== "string" || !req.model.trim())) throw invalid("`model` must be a model name, e.g. jev-latest");
  const qs = req.questions;
  if (!qs || typeof qs !== "object" || Array.isArray(qs) || !Object.keys(qs).length) throw invalid("`questions` must map at least one key to a question");
  for (const [key, q] of Object.entries(qs)) {
    const at = `questions.${key}`;
    if (!key.trim()) throw invalid("a question key cannot be empty");
    if (!q || typeof q !== "object") throw invalid(`${at} must be an object { type, instructions, criteria? }`);
    if (!isText(q.instructions)) throw invalid(`${at}.instructions is required: text, an object or an array`);
    const type = (q as { type?: unknown }).type;
    if (type === "noul") {
      const c = (q as JevNoulQuestion).criteria;
      if (c === undefined) continue;
      if (!c || typeof c !== "object" || Array.isArray(c)) throw invalid(`${at}.criteria must be { true?, false? }`);
      for (const k of Object.keys(c)) {
        if (k !== "true" && k !== "false") throw invalid(`${at}.criteria takes only "true" and "false", not "${k}"`);
        if (!isText((c as Record<string, unknown>)[k])) throw invalid(`${at}.criteria.${k} must be text, an object or an array`);
      }
    } else if (type === "choice") {
      const c = (q as JevChoiceQuestion).criteria;
      if (!c || typeof c !== "object" || Array.isArray(c)) throw invalid(`${at}.criteria is required: option → description (or null)`);
      const options = Object.keys(c);
      if (!options.length) throw invalid(`${at}.criteria needs at least one option`);
      if (options.length > JEV_MAX_CHOICES) throw invalid(`${at}.criteria has ${options.length} options; the most is ${JEV_MAX_CHOICES}`);
      for (const o of options) {
        if (!o.trim()) throw invalid(`${at}.criteria has an empty option name`);
        const d = (c as Record<string, unknown>)[o];
        if (d !== null && !isText(d)) throw invalid(`${at}.criteria.${o} must be a description (text, object or array) or null`);
      }
    } else if (type === "score") {
      const c = (q as JevScoreQuestion).criteria;
      if (!Array.isArray(c)) throw invalid(`${at}.criteria is required: the ordered levels, lowest first`);
      if (c.length < JEV_MIN_SCORE_LEVELS || c.length > JEV_MAX_SCORE_LEVELS) {
        throw invalid(`${at}.criteria has ${c.length} levels; a score takes ${JEV_MIN_SCORE_LEVELS} to ${JEV_MAX_SCORE_LEVELS}`);
      }
      c.forEach((lvl, i) => { if (!isText(lvl)) throw invalid(`${at}.criteria[${i}] must be text, an object or an array`); });
    } else {
      throw invalid(`${at}.type must be "noul", "choice" or "score" (lowercase), not ${JSON.stringify(type)}`);
    }
  }
}

function validateRoute(branches: RouteBranches, opts: RouteOptions<string>): void {
  const keys = branchKeys(branches);
  if (keys.length < 2) throw invalid("route needs at least two branches");
  if (new Set(keys).size !== keys.length) throw invalid("route's branches must be distinct");
  if (opts.minConfidence !== undefined) {
    if (typeof opts.minConfidence !== "number" || !(opts.minConfidence >= 0 && opts.minConfidence <= 1)) throw invalid("`minConfidence` must be a number from 0 to 1");
    if (opts.fallback === undefined) throw invalid("`minConfidence` needs a `fallback` branch to take below it");
  }
  if (opts.fallback !== undefined && (typeof opts.fallback !== "string" || !opts.fallback.trim())) throw invalid("`fallback` must be a branch name");
}

function checkResponse(req: DecideRequest, body: unknown): DecideResponse {
  const r = body as Partial<DecideResponse> | null;
  if (!r || typeof r !== "object" || !r.answers || typeof r.answers !== "object") throw new ProtocolError("GlyphhRouter's /v1/systemone answered without `answers`");
  for (const [key, q] of Object.entries(req.questions)) {
    const a = (r.answers as Record<string, JevAnswer | undefined>)[key];
    if (!a || a.type !== q.type) throw new ProtocolError(`GlyphhRouter's /v1/systemone gave no ${q.type} answer for "${key}"`);
  }
  return {
    model: typeof r.model === "string" ? r.model : req.model ?? JEV_DEFAULT_MODEL,
    answers: r.answers,
    usage: r.usage && typeof r.usage === "object" ? r.usage : { input_tokens: 0, output_tokens: 0 },
  };
}

// ── the call ──────────────────────────────────────────────────────────────────

/** What a standalone call needs: GlyphhRouter's base URL and a gateway token. */
export interface JevConnection {
  /** The gateway base URL (`GatewayToken.baseUrl`); `/v1/systemone` is appended. */
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  /** Retries on 429/529 (default 3), backing off exponentially from `retryBaseMs` (default 500). */
  retries?: number;
  retryBaseMs?: number;
  signal?: AbortSignal;
  /** Tests: how a backoff waits. */
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE = new Set([429, 529]);
const MAX_BACKOFF_MS = 8000;
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function errorText(body: unknown): string {
  if (typeof body === "string") return body;
  if (!body || typeof body !== "object") return "";
  const b = body as { error?: unknown; detail?: unknown; message?: unknown };
  for (const v of [b.error, b.detail, b.message]) {
    if (typeof v === "string") return v;
    if (v && typeof v === "object") {
      const m = (v as { message?: unknown; error?: unknown }).message ?? (v as { error?: unknown }).error;
      if (typeof m === "string") return m;
      try { return JSON.stringify(v); } catch { /* fall through */ }
    }
  }
  return "";
}

function codeFor(status: number): string {
  switch (status) {
    case 401: return "E_AUTH";
    case 402: return "E_PAYMENT";
    case 403: return "E_FORBIDDEN";
    case 422: return "E_JEV_INVALID";
    case 429: return "E_RATE_LIMITED";
    case 529: return "E_OVERLOADED";
    default: return "E_JEV";
  }
}

function retryAfterMs(res: Response): number | null {
  const h = res.headers?.get?.("retry-after");
  if (!h) return null;
  const s = Number(h);
  return Number.isFinite(s) && s >= 0 ? Math.min(s * 1000, MAX_BACKOFF_MS) : null;
}

/**
 * One decision through GlyphhRouter: validates the request, POSTs
 * `{baseUrl}/v1/systemone` with the bearer, retries 429/529 with backoff, and
 * checks every question got an answer of its own type. Errors: ValidationError
 * (bad request, before sending or the server's 422), ApiError E_PAYMENT (402,
 * the budget wall), AuthError (401), ConnectError (never reached it).
 */
export async function jevDecide<const Q extends JevQuestions>(conn: JevConnection, req: DecideRequest<Q>): Promise<DecideResponse<Q>> {
  validateDecideRequest(req);
  if (!conn?.baseUrl || !conn.token) throw invalid("a Jev call needs GlyphhRouter's base URL and a gateway token");
  const doFetch = conn.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const sleep = conn.sleep ?? realSleep;
  const retries = Math.max(0, Math.floor(conn.retries ?? 3));
  const base = Math.max(0, conn.retryBaseMs ?? 500);
  const url = `${conn.baseUrl.replace(/\/+$/, "")}/v1/systemone`;
  const body = JSON.stringify({ model: req.model ?? JEV_DEFAULT_MODEL, state: req.state, questions: req.questions });
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${conn.token}` },
        body,
        ...(conn.signal ? { signal: conn.signal } : {}),
      });
    } catch (e) {
      throw new ConnectError(`GlyphhRouter is unreachable for Jev: ${(e as Error).message}`, e);
    }
    const text = await res.text().catch(() => "");
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (res.ok) return checkResponse(req, parsed) as DecideResponse<Q>;
    if (RETRYABLE.has(res.status) && attempt < retries) {
      await sleep(retryAfterMs(res) ?? Math.min(base * 2 ** attempt, MAX_BACKOFF_MS));
      continue;
    }
    const message = errorText(parsed) || `Jev answered ${res.status}`;
    const opts = { code: codeFor(res.status), httpStatus: res.status, message, retryable: RETRYABLE.has(res.status) };
    if (res.status === 422) throw new ValidationError(opts);
    throw res.status === 402 ? new ApiError(opts) : apiErrorFor(opts);
  }
}

/** Route `state` to one of `branches` through Jev — see {@link pickBranch} for the rule. */
export async function jevRoute<const B extends string, F extends string = never>(
  conn: JevConnection,
  state: JevState,
  branches: RouteBranches<B>,
  opts: RouteOptions<F> = {},
): Promise<RouteResult<B | F>> {
  validateRoute(branches, opts);
  const res = await jevDecide(conn, routeRequest(state, branches, opts));
  return { ...pickBranch(res.answers.route, branches, opts), model: res.model, usage: res.usage };
}

// ── the Client door ───────────────────────────────────────────────────────────

/** `client.decide` / `client.route`: Jev on the member's gateway key. */
export class SystemOneClient {
  #gw: { baseUrl: string; token: string } | null = null;

  constructor(
    private readonly gateway: GatewayClient,
    private readonly fetchImpl?: typeof fetch,
    private readonly tuning: Pick<JevConnection, "retries" | "retryBaseMs" | "sleep"> = {},
  ) {}

  /** One decision: every question answered with numbers. */
  decide = async <const Q extends JevQuestions>(req: DecideRequest<Q>, opts: { signal?: AbortSignal } = {}): Promise<DecideResponse<Q>> => {
    return this.#withCredential((conn) => jevDecide({ ...conn, ...opts }, req));
  };

  /** Pick one branch for `state`, deterministically (see {@link pickBranch}). */
  route = async <const B extends string, F extends string = never>(state: JevState, branches: RouteBranches<B>, opts: RouteOptions<F> & { signal?: AbortSignal } = {}): Promise<RouteResult<B | F>> => {
    const { signal, ...rest } = opts;
    return this.#withCredential((conn) => jevRoute({ ...conn, ...(signal ? { signal } : {}) }, state, branches, rest as RouteOptions<F>));
  };

  async #withCredential<T>(fn: (conn: JevConnection) => Promise<T>): Promise<T> {
    const gw = await this.#credential();
    try {
      return await fn({ ...gw, ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}), ...this.tuning });
    } catch (e) {
      if (e instanceof ApiError && e.httpStatus === 401) this.#gw = null;
      throw e;
    }
  }

  async #credential(): Promise<{ baseUrl: string; token: string }> {
    if (this.#gw) return this.#gw;
    const t = await this.gateway.token();
    if (!t.baseUrl || !t.token || t.gateway === false) {
      throw new ApiError({ code: "E_ENTITLEMENT", httpStatus: 403, message: "GlyphhRouter is off for this organization, so Jev decisions are too" });
    }
    this.#gw = { baseUrl: t.baseUrl, token: t.token };
    return this.#gw;
  }
}
