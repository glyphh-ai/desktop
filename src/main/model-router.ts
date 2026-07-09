/**
 * Model router — the slicer. Every Anthropic Messages call from the agent
 * loop lands here (the Claude Agent SDK subprocess is pointed at
 * ANTHROPIC_BASE_URL=127.0.0.1:<port>), and each turn gets a routing
 * decision:
 *
 *   local    → translated to the llama-server runtime (Will/William) and
 *              answered in Anthropic wire format — free by construction.
 *   frontier → the bundled turn (system + history + tools, verbatim) is
 *              forwarded to the real Anthropic endpoint. Credits only burn
 *              here — the router is the metering point.
 *
 * The escalation dial is the composer's effort slider (williamEffort):
 * far-left pins everything local, Superfly sends every turn to Claude, and
 * the middle stops escalate on evidence — local flailing (failed/denied
 * tool streaks), oversized turns, explicit asks, and Ada's memory of
 * similar turns having needed the big model. Every decision is written
 * back to Ada, so her recall sharpens the next one.
 */

import http from "node:http";
import { ipcMain } from "electron";
import { getPreference } from "./stores/preferences-db";
import { escalationPolicy, effortMaxTokens } from "./william-permissions";
import { ensureWilliamServing, williamBaseUrl } from "./william";
import { adaRecall, adaTellRaw } from "./ada/store";
import { AUTH_SERVER, getAuthToken, serverGetAuthed } from "./auth";


// ── Wire shapes (loose — we translate, we don't validate) ─────────────────

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface AnthropicMessage { role: "user" | "assistant"; content: string | AnthropicBlock[] }

interface MessagesBody {
  model?: string;
  system?: string | AnthropicBlock[];
  messages?: AnthropicMessage[];
  tools?: Array<{ name: string; description?: string; input_schema?: object }>;
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
  [k: string]: unknown;
}

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

// ── Router state ───────────────────────────────────────────────────────────

let server: http.Server | null = null;
let port = 0;
let starting: Promise<number> | null = null;

/** Recent-escalation stickiness: an escalated turn keeps the next couple of
 *  turns on the frontier so a hard stretch isn't sliced mid-thought. */
let pressure = 0;

const usage = {
  localTurns: 0,
  frontierTurns: 0,
  byokTurns: 0,
  gatewayTurns: 0,
  frontierInputTokens: 0,
  frontierOutputTokens: 0,
};

interface Decision { at: number; route: "local" | "frontier"; reason: string; score: number }
const decisions: Decision[] = [];

function recordDecision(d: Decision, promptHead: string): void {
  decisions.push(d);
  if (decisions.length > 50) decisions.shift();
  // Ada earns her keep: routing decisions become facts she can recall when
  // a similar turn shows up. Best-effort — a cold store never blocks a run.
  try {
    adaTellRaw(
      `routing: ${d.route} (score ${d.score}) — ${d.reason} :: ${promptHead}`,
      { kind: "routing", route: d.route, reason: d.reason },
      { speaker: "router" },
    );
  } catch { /* store not ready */ }
}

// ── Escalation scoring ─────────────────────────────────────────────────────

function lastUserText(messages: AnthropicMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    const texts = m.content.filter((b) => b.type === "text").map((b) => b.text || "");
    if (texts.length) return texts.join("\n");
    // tool_result-only user turns keep scanning upward for the real ask
  }
  return "";
}

function failStreak(messages: AnthropicMessage[]): number {
  let fails = 0;
  for (const m of messages.slice(-8)) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type !== "tool_result") continue;
      const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
      if (b.is_error || /^\s*(ERROR|DENIED:|STOP[:.]|exit [1-9])/m.test(text)) fails++;
    }
  }
  return fails;
}

function decide(body: MessagesBody): Decision {
  const policy = escalationPolicy();
  const messages = body.messages ?? [];
  const ask = lastUserText(messages);

  if (policy === "local") return { at: Date.now(), route: "local", reason: "dial pinned local", score: 0 };
  if (policy === "frontier") return { at: Date.now(), route: "frontier", reason: "dial pinned to Claude", score: 99 };

  let score = 0;
  const reasons: string[] = [];
  const bump = (n: number, why: string) => { score += n; reasons.push(why); };

  const totalChars = JSON.stringify(messages).length;
  if (totalChars > 110_000) {
    // Too big for the local context no matter how we squeeze — forced up.
    return { at: Date.now(), route: "frontier", reason: "turn exceeds local context", score: 99 };
  }

  // Vision: local models are text-only — an attached image forces the
  // frontier lane so the model can actually SEE it (the Local pin above
  // still wins; the image then rides as its path in the manifest only).
  const hasImage = messages.some((m) =>
    m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b?.type === "image"));
  if (hasImage) return { at: Date.now(), route: "frontier", reason: "image attached (vision)", score: 99 };

  if (/\b(escalate|use claude|ask claude)\b/i.test(ask)) bump(99, "explicit escalation ask");
  const fails = Math.min(failStreak(messages), 3);
  if (fails) bump(fails, `local flailing (${fails} failed/denied tool results)`);
  // Building/generating an app or site is the HARDEST agentic work (scaffold →
  // write files → run commands → build → install) and local models narrate
  // instead of tool-calling — so it never trips the fail-streak net. Escalate
  // it up front (bump ≥ both thresholds), except on the Local pin.
  // Verb stems match their whole word (\w* consumes to the word end — a bare
  // \b after "creat" never matches "create"), then a noun within ~40 chars.
  const BUILD_INTENT = /\b(?:build|creat|mak|scaffold|design|generat|develop|spin\s*up|whip\s*up|code)\w*[^.!?\n]{0,40}?\b(?:app|application|web ?site|web ?app|site|game|dashboard|landing ?page|ui|interface|widget|component|tool|visuali[sz]\w*|animation|3d|three\.?js|glyphh app)\b/i;
  if (BUILD_INTENT.test(ask)) bump(3, "app/UI build (multi-step agentic — beyond local models)");
  // Follow-ups ("let's do it", "keep going") during app work: keep momentum on
  // Claude when the recent transcript is clearly an app build.
  else if (/\b(manifest\.json|glyphh\.app\.json|npm run build|update_app|vite\.config|tailwind\.config)\b/.test(JSON.stringify(messages.slice(-6)))) {
    bump(3, "app build in progress");
  }
  if (/(refactor|migrat|architect|debug|test suite|across (the )?(repo|project)|multi.?file|plan (out|the))/i.test(ask)) {
    bump(1, "heavy-lift keywords");
  }
  if (totalChars > 24_000) bump(1, "long transcript");
  if (messages.length > 28) bump(1, "long horizon");
  if (pressure > 0) bump(2, "recent escalation (sticky)");

  try {
    const hits = adaRecall(`routing ${ask.slice(0, 60)}`, 3);
    if (hits.some((h) => h.score > 0.8 && /routing: frontier/.test(h.content))) {
      bump(1, "Ada: similar turns needed Claude");
    }
  } catch { /* store not ready */ }

  const threshold = policy === "eager" ? 2 : 3;
  const route = score >= threshold ? "frontier" : "local";
  pressure = route === "frontier" ? 2 : Math.max(0, pressure - 1);
  return {
    at: Date.now(),
    route,
    reason: reasons.length ? reasons.join("; ") : "routine turn",
    score,
  };
}

// ── Local serving: Anthropic ⇄ OpenAI translation over llama-server ───────

function systemText(system: MessagesBody["system"]): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system.filter((b) => b.type === "text").map((b) => b.text || "").join("\n");
}

function blockContentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === "string" ? c : (c as AnthropicBlock).text ?? JSON.stringify(c))).join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

function toOpenAiMessages(body: MessagesBody): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  const sys = systemText(body.system);
  if (sys) out.push({ role: "system", content: sys });

  let messages = body.messages ?? [];
  // Squeeze oversized turns into the local window: keep the head (the task
  // framing) and the recent tail (the live work); the middle is history the
  // compactor already summarized upstream anyway.
  if (JSON.stringify(messages).length > 90_000 && messages.length > 16) {
    messages = [
      ...messages.slice(0, 2),
      { role: "user", content: "[…older turns elided to fit the local model's context…]" },
      ...messages.slice(-12),
    ];
  }

  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text || "").join("\n");
      const calls = m.content.filter((b) => b.type === "tool_use").map((b) => ({
        id: String(b.id || `call_${Math.random().toString(36).slice(2)}`),
        type: "function" as const,
        function: { name: String(b.name || ""), arguments: JSON.stringify(b.input ?? {}) },
      }));
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      const results = m.content.filter((b) => b.type === "tool_result");
      for (const r of results) {
        out.push({ role: "tool", tool_call_id: String(r.tool_use_id || ""), content: blockContentToString(r.content) });
      }
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text || "").join("\n");
      if (text) out.push({ role: "user", content: text });
    }
  }
  return out;
}

interface LocalResult {
  blocks: AnthropicBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  inputTokens: number;
  outputTokens: number;
}

async function completeLocal(body: MessagesBody): Promise<LocalResult> {
  await ensureWilliamServing();
  const payload = {
    messages: toOpenAiMessages(body),
    tools: (body.tools ?? []).map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description ?? "", parameters: t.input_schema ?? { type: "object", additionalProperties: true } },
    })),
    tool_choice: (body.tools?.length ? "auto" : "none") as "auto" | "none",
    temperature: 0.15,
    max_tokens: Math.min(Number(body.max_tokens) || effortMaxTokens(), 16384),
    stream: false,
  };
  const res = await fetch(`${williamBaseUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`local model answered HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json() as {
    choices?: Array<{ finish_reason?: string; message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = j.choices?.[0];
  const blocks: AnthropicBlock[] = [];
  const text = choice?.message?.content;
  if (text) blocks.push({ type: "text", text });
  for (const c of choice?.message?.tool_calls ?? []) {
    let input: Record<string, unknown>;
    try { input = JSON.parse(c.function?.arguments || "{}") as Record<string, unknown>; }
    catch { input = { raw: c.function?.arguments ?? "" }; }
    blocks.push({ type: "tool_use", id: c.id || `toolu_local_${Math.random().toString(36).slice(2)}`, name: c.function?.name || "", input });
  }
  if (!blocks.length) blocks.push({ type: "text", text: "" });
  const stopReason = choice?.finish_reason === "tool_calls" ? "tool_use"
    : choice?.finish_reason === "length" ? "max_tokens" : "end_turn";
  return {
    blocks,
    stopReason,
    inputTokens: j.usage?.prompt_tokens ?? 0,
    outputTokens: j.usage?.completion_tokens ?? 0,
  };
}

function anthropicMessageJson(body: MessagesBody, r: LocalResult): Record<string, unknown> {
  return {
    id: `msg_local_${Date.now().toString(36)}`,
    type: "message",
    role: "assistant",
    model: body.model ?? "glyphh-local",
    content: r.blocks,
    stop_reason: r.stopReason,
    stop_sequence: null,
    usage: { input_tokens: r.inputTokens, output_tokens: r.outputTokens },
  };
}

/** Replay a completed local turn as Anthropic SSE — the loop client speaks
 *  streaming; local generation buffers first (correctness over trickle). */
function emitAnthropicSse(res: http.ServerResponse, body: MessagesBody, r: LocalResult): void {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (event: string, data: Record<string, unknown>) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);

  const skeleton = { ...anthropicMessageJson(body, r), content: [], stop_reason: null, usage: { input_tokens: r.inputTokens, output_tokens: 0 } };
  send("message_start", { message: skeleton });
  r.blocks.forEach((b, index) => {
    if (b.type === "text") {
      send("content_block_start", { index, content_block: { type: "text", text: "" } });
      send("content_block_delta", { index, delta: { type: "text_delta", text: b.text ?? "" } });
    } else {
      send("content_block_start", { index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input ?? {}) } });
    }
    send("content_block_stop", { index });
  });
  send("message_delta", { delta: { stop_reason: r.stopReason, stop_sequence: null }, usage: { output_tokens: r.outputTokens } });
  send("message_stop", {});
  res.end();
}

// ── The frontier lane — every escalation rides the gateway ────────────────
//
// ONE lane: yo-server's governed gateway. BYOK no longer means "direct to
// api.anthropic.com" — a member's own key lives SERVER-side (encrypted) and
// the gateway uses it upstream, billing zero token credits on those calls
// while keeping model governance and rate limits. The client never holds a
// provider key. Signed out → escalation is impossible; the slicer stays
// local.

type FrontierLane = { token: string };

function frontierLane(): FrontierLane | null {
  const token = getAuthToken();
  return token ? { token } : null;
}

// ── Org-governed escalation models (gateway lane) ──────────────────────────
//
// /api/models?proxy=1 is the server's word on which Claude models THIS user
// may escalate to (plan ∩ org ∩ user allow-lists) and the org default.
// Cached; refreshed lazily. Offline or BYOK falls back to the raw pref.

export interface GatewayModelInfo {
  model: string;
  display_name: string;
  input_credits_per_mtok: number | null;
  output_credits_per_mtok: number | null;
}

let gwCache: { at: number; models: GatewayModelInfo[]; def: string | null } | null = null;
const GW_CACHE_TTL_MS = 6 * 60 * 60_000;

/** Drop the cached gateway model list — called when the signed-in user
 *  changes (org/role allow-lists differ per account). */
export function clearGatewayModelsCache(): void {
  gwCache = null;
}

async function gatewayModels(force = false): Promise<{ models: GatewayModelInfo[]; def: string | null }> {
  if (!force && gwCache && Date.now() - gwCache.at < GW_CACHE_TTL_MS) return gwCache;
  try {
    const r = await serverGetAuthed<{
      models?: Array<{ model: string; display_name: string; input_credits_per_mtok?: number | null; output_credits_per_mtok?: number | null }>;
      default_model?: string | null;
    }>("/api/models?proxy=1");
    gwCache = {
      at: Date.now(),
      models: (r.models ?? []).map((m) => ({
        model: m.model,
        display_name: m.display_name,
        input_credits_per_mtok: m.input_credits_per_mtok ?? null,
        output_credits_per_mtok: m.output_credits_per_mtok ?? null,
      })),
      def: r.default_model ?? null,
    };
  } catch { /* signed out / offline — keep whatever we had */ }
  return gwCache ?? { models: [], def: null };
}

/** The model an escalated turn runs on: the user's pick when the org allows
 *  it, else the org default, else the first allowed model; offline trusts
 *  the pick as-is. */
export async function effectiveFrontierModel(): Promise<string> {
  const pref = String(getPreference("frontierModel", "")).trim();
  const { models, def } = await gatewayModels();
  if (models.length) {
    const ids = new Set(models.map((m) => m.model));
    if (pref && ids.has(pref)) return pref;
    if (def && ids.has(def)) return def;
    return models[0].model;
  }
  return pref || "claude-sonnet-5";
}

function upstreamHeaders(req: http.IncomingMessage, lane: FrontierLane): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": String(req.headers["anthropic-version"] || "2023-06-01"),
    "Authorization": `Bearer ${lane.token}`,
  };
  if (req.headers["anthropic-beta"]) h["anthropic-beta"] = String(req.headers["anthropic-beta"]);
  return h;
}

/** Forward an escalated turn. Returns false when the gateway declined it for
 *  governance reasons (rate limit, credit cap, role) — the caller then serves
 *  the turn locally so the user keeps working instead of erroring. */
async function forwardFrontier(req: http.IncomingMessage, res: http.ServerResponse, body: MessagesBody, lane: FrontierLane): Promise<boolean> {
  const up = await fetch(`${AUTH_SERVER}/api/gateway/v1/messages`, {
    method: "POST",
    headers: upstreamHeaders(req, lane),
    body: JSON.stringify(body),
  });
  if (up.status === 402 || up.status === 403 || up.status === 429) {
    let why = `gateway ${up.status}`;
    try {
      const j = await up.json() as { message?: string; error?: string };
      why = j.message || j.error || why;
    } catch { /* body unreadable */ }
    decisions.push({ at: Date.now(), route: "local", reason: `gateway declined (${why}) — served locally`, score: 0 });
    if (decisions.length > 50) decisions.shift();
    return false;
  }
  usage.frontierTurns++;
  // The gateway says which key paid: byok (the member's own, zero token
  // credits) or platform (org credits).
  if (up.headers.get("x-glyphh-lane") === "byok") usage.byokTurns++;
  else usage.gatewayTurns++;

  if (body.stream && up.ok && up.body) {
    res.writeHead(up.status, { "Content-Type": up.headers.get("content-type") || "text/event-stream", "Cache-Control": "no-cache" });
    const reader = up.body.getReader();
    const dec = new TextDecoder();
    let tail = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
      // Best-effort metering tap: usage rides message_start/message_delta.
      tail = (tail + dec.decode(value, { stream: true })).slice(-4000);
    }
    const inTok = /"input_tokens":\s*(\d+)/.exec(tail);
    const outMatches = [...tail.matchAll(/"output_tokens":\s*(\d+)/g)];
    if (inTok) usage.frontierInputTokens += Number(inTok[1]);
    if (outMatches.length) usage.frontierOutputTokens += Number(outMatches[outMatches.length - 1][1]);
    res.end();
    return true;
  }

  const text = await up.text();
  if (up.ok) {
    try {
      const j = JSON.parse(text) as { usage?: { input_tokens?: number; output_tokens?: number } };
      usage.frontierInputTokens += j.usage?.input_tokens ?? 0;
      usage.frontierOutputTokens += j.usage?.output_tokens ?? 0;
    } catch { /* non-JSON success — pass through */ }
  }
  res.writeHead(up.status, { "Content-Type": up.headers.get("content-type") || "application/json" });
  res.end(text);
  return true;
}

// ── The server ─────────────────────────────────────────────────────────────

async function handleMessages(req: http.IncomingMessage, res: http.ServerResponse, body: MessagesBody): Promise<void> {
  let decision = decide(body);
  const lane = frontierLane();
  if (decision.route === "frontier" && !lane) {
    decision = { ...decision, route: "local", reason: `${decision.reason} — but not signed in; staying local` };
  }
  recordDecision(decision, lastUserText(body.messages ?? []).slice(0, 80));

  if (decision.route === "frontier" && lane) {
    // The gateway 403s models outside the org allow-list — resolve to the
    // effective (allowed) model up front so a stale pref can't fail turns.
    body.model = await effectiveFrontierModel();
    const handled = await forwardFrontier(req, res, body, lane);
    if (handled) return;
    // Governance decline (cap/rate/role) — degrade to local, keep working.
  }

  const r = await completeLocal(body);
  usage.localTurns++;
  if (body.stream) emitAnthropicSse(res, body, r);
  else {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(anthropicMessageJson(body, r)));
  }
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const raw = await readBody(req);
  const url = (req.url || "").split("?")[0];

  if (req.method === "POST" && url === "/v1/messages") {
    const body = JSON.parse(raw.toString("utf8") || "{}") as MessagesBody;
    await handleMessages(req, res, body);
    return;
  }

  if (req.method === "POST" && url === "/v1/messages/count_tokens") {
    // Estimated locally — close enough for loop budgeting, and the gateway
    // (the only upstream) is /v1/messages only.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ input_tokens: Math.ceil(raw.length / 4) }));
    return;
  }

  // No other Anthropic endpoints exist behind the router — the gateway is
  // /v1/messages only and the client holds no provider key to go direct.
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `router: no local handler for ${req.method} ${url}` } }));
}

/** Start the slicer on an ephemeral localhost port (single-flight). */
export function startModelRouter(): Promise<number> {
  if (server && port) return Promise.resolve(port);
  if (starting) return starting;
  starting = new Promise<number>((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      void handle(req, res).catch((err) => {
        try {
          const msg = err instanceof Error ? err.message : String(err);
          if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `router: ${msg}` } }));
        } catch { /* socket gone */ }
      });
    });
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") { reject(new Error("router: no address")); return; }
      server = srv;
      port = addr.port;
      resolve(port);
    });
  }).finally(() => { starting = null; });
  return starting;
}

export function stopModelRouter(): void {
  if (server) { try { server.close(); } catch { /* already down */ } server = null; port = 0; }
}

export function registerModelRouterIpc(): void {
  ipcMain.handle("gateway-models-list", async () => {
    const { models, def } = await gatewayModels(true);
    // BYOK status now lives server-side (user_provider_keys) — the client
    // holds no key; this just reports whether one is stored for the badge.
    let byok = false;
    try {
      const r = await serverGetAuthed<{ keys?: Array<{ provider: string; hasKey: boolean }> }>("/api/me/provider-keys");
      byok = (r.keys ?? []).some((k) => k.provider === "anthropic" && k.hasKey);
    } catch { /* signed out / offline */ }
    return {
      models,
      default: def,
      selected: String(getPreference("frontierModel", "")).trim() || null,
      effective: await effectiveFrontierModel(),
      lanes: { byok, gateway: !!getAuthToken() },
    };
  });
}
