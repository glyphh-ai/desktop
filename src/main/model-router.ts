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
import { ensureWilliamServing, williamBaseUrl, LOCAL_CTX_TOKENS } from "./william";
import { adaRecall, adaTellRaw } from "./ada/store";
import { AUTH_SERVER, PLATFORM_URL, getAuthToken, serverGetAuthed, ensureFreshToken } from "./auth";


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

// TEMPORARY (until the loop logic lands): the composer's model pick IS the
// lane — no escalation heuristics. Flip to false to restore the full
// evidence-based router below (heuristicDecide), which is kept intact.
const BYPASS_LOOP = true;

/** The lane the user's pick selects: "gw:<model>" → frontier with that model;
 *  "auto" or a local id → local. (code.ts writes modelPick on every pick.) */
function pickedRoute(): "local" | "frontier" {
  return String(getPreference("modelPick", "auto")).startsWith("gw:") ? "frontier" : "local";
}

function decide(body: MessagesBody): Decision {
  if (BYPASS_LOOP) {
    return pickedRoute() === "frontier"
      ? { at: Date.now(), route: "frontier", reason: "model picker: Claude model selected", score: 99 }
      : { at: Date.now(), route: "local", reason: "model picker: local model selected", score: 0 };
  }
  return heuristicDecide(body);
}

function heuristicDecide(body: MessagesBody): Decision {
  const policy = escalationPolicy();
  const messages = body.messages ?? [];
  const ask = lastUserText(messages);

  if (policy === "local") return { at: Date.now(), route: "local", reason: "dial pinned local", score: 0 };
  if (policy === "frontier") return { at: Date.now(), route: "frontier", reason: "dial pinned to Claude", score: 99 };

  let score = 0;
  const reasons: string[] = [];
  const bump = (n: number, why: string) => { score += n; reasons.push(why); };

  // Vision: local models are text-only — an attached image forces the
  // frontier lane so the model can actually SEE it (the Local pin above
  // still wins; the image then rides as its path in the manifest only).
  // Checked before the size guard so the decision names the real reason
  // (base64 image bytes would otherwise read as "oversized").
  const hasImage = messages.some((m) =>
    m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b?.type === "image"));
  if (hasImage) return { at: Date.now(), route: "frontier", reason: "image attached (vision)", score: 99 };

  // The WHOLE request renders into the local prompt — system + tool schemas
  // + messages, not just messages. Bigger than the window → forced up; the
  // squeeze (completeLocal) only exists for lanes that can't escalate.
  const cost = promptCost(body);
  if (cost.total > localPromptBudget()) {
    return {
      at: Date.now(),
      route: "frontier",
      reason: `turn exceeds local context (~${Math.round(cost.total / 1000)}k tokens: ` +
        `${Math.round(cost.system / 1000)}k system + ${Math.round(cost.tools / 1000)}k tools + ${Math.round(cost.messages / 1000)}k messages)`,
      score: 99,
    };
  }

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
  if (cost.messages > 7_500) bump(1, "long transcript");
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

function toOpenAiMessages(body: MessagesBody, systemSuffix = ""): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  const sys = systemText(body.system) + systemSuffix;
  if (sys) out.push({ role: "system", content: sys });

  for (const m of body.messages ?? []) {
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

// ── Local window budgeting ─────────────────────────────────────────────────
//
// llama-server 400s any request whose rendered prompt exceeds `-c` (n_ctx),
// and EVERYTHING renders into that prompt: system, tool schemas, messages.
// The budget measures all three on the TRANSLATED payload (translation drops
// image blocks, which never reach the local prompt). The estimate skews high
// (JSON escaping) — the safe direction; llama's own 400 is the backstop.

const estTokens = (s: string) => Math.ceil(s.length / 3.2);
/** Room kept for the reply + chat-template glue. */
const LOCAL_REPLY_ROOM = 2048;
const localPromptBudget = () => LOCAL_CTX_TOKENS - LOCAL_REPLY_ROOM;

interface PromptCost { system: number; tools: number; messages: number; total: number }

function promptCost(body: MessagesBody): PromptCost {
  const system = estTokens(systemText(body.system));
  const tools = body.tools?.length ? estTokens(JSON.stringify(body.tools)) : 0;
  const messages = estTokens(JSON.stringify(toOpenAiMessages({ ...body, system: undefined })));
  return { system, tools, messages, total: system + tools + messages + 64 };
}

// ── Squeeze: make an oversized turn servable locally ───────────────────────
//
// Escalation is the first choice for oversized turns (decide()); the squeeze
// serves the lanes that MUST answer locally — dial pinned local, signed out,
// or the gateway declined. It only ever shrinks `messages`: system and tools
// render verbatim, so when those alone bust the budget no squeeze can save
// the turn and the caller reports that honestly.

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

interface SqueezeLevel { resultCap: number; textCap: number; keepHead: number; keepTail: number }
const SQUEEZE: SqueezeLevel[] = [
  { resultCap: 6000, textCap: 24_000, keepHead: 2, keepTail: 12 },
  { resultCap: 2500, textCap: 12_000, keepHead: 2, keepTail: 8 },
  { resultCap: 1200, textCap: 8_000, keepHead: 1, keepTail: 6 },
  { resultCap: 700, textCap: 5_000, keepHead: 1, keepTail: 4 },
];

function truncateText(s: string, cap: number): string {
  if (s.length <= cap) return s;
  const head = Math.floor(cap * 0.7);
  const tail = cap - head;
  return `${s.slice(0, head)}\n[…${(s.length - cap).toLocaleString()} chars elided to fit the local model's context…]\n${s.slice(s.length - tail)}`;
}

/** Cap tool_result payloads (the usual bulk) and oversized text in place. */
function capBlocks(messages: AnthropicMessage[], resultCap: number, textCap: number): void {
  for (const m of messages) {
    if (typeof m.content === "string") {
      if (m.content.length > textCap) m.content = truncateText(m.content, textCap);
      continue;
    }
    for (const b of m.content) {
      if (b.type === "tool_result") {
        const text = blockContentToString(b.content);
        if (text.length > resultCap) b.content = truncateText(text, resultCap);
      } else if (b.type === "text" && b.text && b.text.length > textCap) {
        b.text = truncateText(b.text, textCap);
      }
    }
  }
}

/** Drop the middle of the transcript — keep the head (task framing) and the
 *  recent tail (live work). Tool linkage the cut orphans is flattened to
 *  text so the chat template never sees a result without its call or a call
 *  without its result. */
function elideMiddle(messages: AnthropicMessage[], keepHead: number, keepTail: number): AnthropicMessage[] {
  if (messages.length <= keepHead + keepTail + 1) return messages;
  const kept: AnthropicMessage[] = [
    ...messages.slice(0, keepHead),
    { role: "user", content: "[…older turns elided to fit the local model's context…]" },
    ...messages.slice(-keepTail),
  ];
  const liveToolUse = new Set<string>();
  const answered = new Set<string>();
  for (const m of kept) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (m.role === "assistant" && b.type === "tool_use" && b.id) liveToolUse.add(b.id);
      if (m.role === "user" && b.type === "tool_result") answered.add(String(b.tool_use_id));
    }
  }
  for (const m of kept) {
    if (typeof m.content === "string") continue;
    m.content = m.content.map((b) => {
      if (m.role === "user" && b.type === "tool_result" && !liveToolUse.has(String(b.tool_use_id))) {
        return { type: "text", text: "[tool output from an elided earlier turn]" };
      }
      if (m.role === "assistant" && b.type === "tool_use" && !answered.has(String(b.id))) {
        return { type: "text", text: `[called ${b.name || "a tool"} — output elided]` };
      }
      return b;
    });
  }
  return kept;
}

/** Body at squeeze level `n` — a fresh clone each time; levels re-derive
 *  from the original rather than compounding. */
function squeezeAt(body: MessagesBody, level: SqueezeLevel): MessagesBody {
  const msgs = elideMiddle(clone(body.messages ?? []), level.keepHead, level.keepTail);
  capBlocks(msgs, level.resultCap, level.textCap);
  return { ...body, messages: msgs };
}

/** The lightest body that fits the budget — or the heaviest squeeze when
 *  nothing fits (estimates skew high, so the attempt still goes out; llama
 *  has the final word). */
function fitForLocal(body: MessagesBody): { body: MessagesBody; level: number } {
  const budget = localPromptBudget();
  if (promptCost(body).total <= budget) return { body, level: -1 };
  for (let i = 0; i < SQUEEZE.length; i++) {
    const squeezed = squeezeAt(body, SQUEEZE[i]);
    if (promptCost(squeezed).total <= budget) return { body: squeezed, level: i };
  }
  return { body: squeezeAt(body, SQUEEZE[SQUEEZE.length - 1]), level: SQUEEZE.length - 1 };
}

/** Local turn that cannot fit the window even fully squeezed. */
class LocalContextOverflowError extends Error {
  constructor(detail: string, public readonly cost: PromptCost) {
    super(detail);
  }
}

const isContextOverflow = (status: number, text: string) =>
  status === 400 && /exceed.*context|context size|n_ctx/i.test(text);

interface LocalResult {
  blocks: AnthropicBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  inputTokens: number;
  outputTokens: number;
}

// Local models over-eagerly tool-call: a small model reads "tools present" as
// "must use a tool," firing a search on a bare "hi" or "what model are you?".
// Two harness guards (the real fix is the loop rewrite — see rotors epic):
//   1) a system nudge that tools are OPTIONAL — answer directly when able;
//   2) drop tools entirely on a clearly-conversational opening turn, so the
//      model literally can't tool-call. Default is to KEEP tools (safe) —
//      only a short, plainly-conversational ask with no tool loop in the tail
//      loses them.
const TOOLS_OPTIONAL_NUDGE =
  "\n\nTools are optional. If the user is greeting you, asking about you or " +
  "your capabilities, or anything you can answer from what you already know, " +
  "reply directly in plain text — do NOT call a tool. Call a tool only when the " +
  "task genuinely needs external data or an action.";

const CONVERSATIONAL_RE =
  /^(hi|hey|hello|yo|sup|thanks|thank you|thx|ok|okay|cool|nice|lol|good (morning|afternoon|evening|night)|how are you|how's it going|who are you|what('| a)re you|what model|what are you called|what can you do|what do you do|help)\b/i;

/** Whether THIS turn should be offered tools at all. Mid-task turns (a
 *  tool_use/tool_result in the recent tail) always keep them; a short,
 *  plainly-conversational opener does not. Everything else keeps them. */
function turnNeedsTools(body: MessagesBody): boolean {
  const msgs = body.messages ?? [];
  const inToolLoop = msgs.slice(-4).some((m) => Array.isArray(m.content)
    && m.content.some((b) => b?.type === "tool_use" || b?.type === "tool_result"));
  if (inToolLoop) return true;
  const ask = lastUserText(msgs).trim();
  if (!ask) return true;
  return !(CONVERSATIONAL_RE.test(ask) && ask.length < 80);
}

/** One attempt against llama-server. Throws LocalContextOverflowError on
 *  the window-overflow 400 so the caller can squeeze and go again. */
async function callLocal(body: MessagesBody): Promise<LocalResult> {
  const cost = promptCost(body);
  const withTools = (body.tools?.length ?? 0) > 0 && turnNeedsTools(body);
  const payload = {
    messages: toOpenAiMessages(body, withTools ? TOOLS_OPTIONAL_NUDGE : ""),
    tools: withTools ? (body.tools ?? []).map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description ?? "", parameters: t.input_schema ?? { type: "object", additionalProperties: true } },
    })) : [],
    tool_choice: (withTools ? "auto" : "none") as "auto" | "none",
    temperature: 0.15,
    // The reply must fit what's left of the window after the prompt.
    max_tokens: Math.max(256, Math.min(Number(body.max_tokens) || effortMaxTokens(), 16384, LOCAL_CTX_TOKENS - cost.total - 128)),
    stream: false,
  };
  const res = await fetch(`${williamBaseUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    if (isContextOverflow(res.status, text)) throw new LocalContextOverflowError(text, cost);
    throw new Error(`local model answered HTTP ${res.status}: ${text}`);
  }
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

/** Serve a turn locally: fit to the window up front (estimate), then let
 *  llama's own overflow 400 drive progressively harder squeezes. Throws
 *  LocalContextOverflowError only when the hardest squeeze still overflows. */
async function completeLocal(body: MessagesBody): Promise<LocalResult> {
  await ensureWilliamServing();
  const fitted = fitForLocal(body);
  let attempt = fitted.body;
  for (let level = fitted.level; ; level++) {
    try {
      return await callLocal(attempt);
    } catch (err) {
      if (!(err instanceof LocalContextOverflowError) || level >= SQUEEZE.length - 1) throw err;
      attempt = squeezeAt(body, SQUEEZE[level + 1]);
    }
  }
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
// /api/models/catalog is the server's word on which models THIS user may use:
// the org's curated catalog intersected with their role's allow-list, plus the
// org default. We take the PROXIED entries (the gateway escalation targets;
// open-weight models run on-device and are picked separately). Multi-provider —
// whatever the admin added. Cached; refreshed lazily. Offline falls back to the
// raw pref.

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
      models?: Array<{
        key: string; kind: string; model: string | null; displayName: string; active?: boolean;
        inputCreditsPerMtok?: number | null; outputCreditsPerMtok?: number | null;
      }>;
      default?: string | null;
    }>("/api/models/catalog");
    // Escalation targets are the ACTIVE proxied models — a BYOK model with no
    // provider key set is inactive and never shown. The gateway takes a bare
    // model id (the org catalog key is provider::model). The default is only
    // what the server says an admin set — never invented from list position.
    const proxied = (r.models ?? []).filter((m) => m.kind === "proxied" && m.model && m.active !== false);
    const def = proxied.find((m) => m.key === r.default)?.model ?? null;
    gwCache = {
      at: Date.now(),
      models: proxied.map((m) => ({
        model: m.model!,
        display_name: m.displayName,
        input_credits_per_mtok: m.inputCreditsPerMtok ?? null,
        output_credits_per_mtok: m.outputCreditsPerMtok ?? null,
      })),
      def,
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
interface FrontierResult { handled: boolean; declined?: { status: number; why: string } }
async function forwardFrontier(req: http.IncomingMessage, res: http.ServerResponse, body: MessagesBody, lane: FrontierLane): Promise<FrontierResult> {
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
    console.warn(`[model-router] gateway DECLINED the escalation (${up.status}: ${why}). This is org governance (credits/role/rate), not the model picker.`);
    decisions.push({ at: Date.now(), route: "local", reason: `gateway declined (${why})`, score: 0 });
    if (decisions.length > 50) decisions.shift();
    return { handled: false, declined: { status: up.status, why } };
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
    return { handled: true };
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
  return { handled: true };
}

/** Actionable chat error when a USER-PICKED frontier model is declined by the
 *  gateway — never a silent downgrade to local. Leads with a machine marker the
 *  client parses into a styled card (%%GLYPHHERR:<kind>:<url>%%); the trailing
 *  line is a plain-text fallback for any surface that shows the raw message. */
function frontierDeclineError(status: number, why: string): string {
  const kind = status === 402 ? "credits" : status === 403 ? "role" : status === 429 ? "rate" : "generic";
  const url = status === 402 ? `${PLATFORM_URL}/billing` : PLATFORM_URL;
  const human = kind === "credits" ? "Out of credits — buy more or pick an on-device model."
    : kind === "role" ? `That model isn't allowed on your account${why ? ` (${why})` : ""}.`
    : kind === "rate" ? "The gateway is rate-limiting right now — try again shortly, or pick an on-device model."
    : `The gateway declined this model${why ? ` (${why})` : ""}.`;
  return `%%GLYPHHERR:${kind}:${url}%%\n${human}`;
}

// ── The server ─────────────────────────────────────────────────────────────

async function handleMessages(req: http.IncomingMessage, res: http.ServerResponse, body: MessagesBody): Promise<void> {
  // Top up the auth token BEFORE deciding the lane. A stale/expired token makes
  // frontierLane() null, which silently downgrades every picked-frontier turn to
  // local — the exact "it always uses the local model" symptom. This proactive
  // refresh (single-flight, no-ops when the token has life) had no caller.
  await ensureFreshToken().catch(() => {});
  let decision = decide(body);
  const lane = frontierLane();
  if (decision.route === "frontier" && !lane) {
    console.warn("[model-router] picked a Claude/gateway model but there's no auth lane — serving local. Token/sign-in issue (getAuthToken returned null).");
    decision = { ...decision, route: "local", reason: `${decision.reason} — but not signed in; staying local` };
  }
  recordDecision(decision, lastUserText(body.messages ?? []).slice(0, 80));

  let frontierDeclined = false;
  if (decision.route === "frontier" && lane) {
    // The gateway 403s models outside the org allow-list — resolve to the
    // effective (allowed) model up front so a stale pref can't fail turns.
    body.model = await effectiveFrontierModel();
    const fr = await forwardFrontier(req, res, body, lane);
    if (fr.handled) return;
    frontierDeclined = true;
    // The user EXPLICITLY picked this frontier model (with BYPASS_LOOP that's
    // the only way route==="frontier"). A decline (out of credits, role, rate)
    // must SURFACE as a chat error — never a silent downgrade to the local
    // model. Auto-escalation (BYPASS_LOOP off) still falls back to local below.
    if (pickedRoute() === "frontier" && fr.declined) {
      const { status, why } = fr.declined;
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: frontierDeclineError(status, why) },
      }));
      return;
    }
  }

  let r: LocalResult;
  try {
    r = await completeLocal(body);
  } catch (err) {
    if (!(err instanceof LocalContextOverflowError)) throw err;
    // The hardest squeeze still overflowed — system + tools render verbatim,
    // so no message trimming can save this turn. Escalate when the dial and
    // the gateway allow it; otherwise say exactly what's full (a plain 400 —
    // NOT a "temporary server error" the client tells the user to wait out).
    if (lane && !frontierDeclined && !BYPASS_LOOP && escalationPolicy() !== "local") {
      const d: Decision = { at: Date.now(), route: "frontier", reason: "local context overflow after squeeze — escalated", score: 99 };
      recordDecision(d, lastUserText(body.messages ?? []).slice(0, 80));
      body.model = await effectiveFrontierModel();
      if ((await forwardFrontier(req, res, body, lane)).handled) return;
    }
    const c = err.cost;
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          `This turn doesn't fit the local model's ${LOCAL_CTX_TOKENS.toLocaleString()}-token window even after squeezing ` +
          `(≈${c.system.toLocaleString()} system + ${c.tools.toLocaleString()} tools + ${c.messages.toLocaleString()} message tokens). ` +
          (lane ? "" : "Sign in to escalate big turns to Claude, or ") +
          "start a fresh chat, or disconnect unused connector accounts to shrink the toolset.",
      },
    }));
    return;
  }
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
