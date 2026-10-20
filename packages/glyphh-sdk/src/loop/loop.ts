/**
 * loop/loop.ts — THE GLYPHH LOOP: our own agent loop, a supported loop beside
 * claude/codex/gemini, on ANY model the gateway serves. ONE engine, several
 * hosts: the desktop's Agent panel and the `glyphh` CLI both run this class;
 * only the host seams differ (who supplies the gateway credential, which MCP
 * servers to lend, how events are rendered).
 *
 * It exists only on the gateway lane: the Messages calls go to the gateway on
 * the member's own key, so the org's allow-list, budgets and per-org prompt
 * caching apply and every turn lands in Usage. No vendor login.
 *
 * Tools: the built-ins (files + shell, tools.ts) and whatever MCP servers the
 * host lends (the desktop's local server, the gateway's connection tools).
 * Permission is Glyphh's one vocabulary projected onto tool kinds (core.ts);
 * an ask parks the run until `respondApproval`. Prompt caching marks the
 * system prompt; a long conversation is compacted by the model itself.
 *
 * State is process memory: a chat's messages live here for the process's life
 * and re-seed from the host's stored turns (nothing of ours on disk).
 */

import { homedir } from "node:os";
import {
  gate, toolKind, readsByName, seedFromChat, shouldCompact, safeToolName, toolTitle, preview, systemPrompt,
  MAX_TOKENS_OUT, MAX_TOOL_ROUNDS, roundsPausedMessage, type LoopHost, type LoopPermission, type PromptExtras, type SeedTurn,
} from "./core.js";
import { BUILTIN_TOOLS, runBuiltin, type ShellLauncher, type ToolDetail } from "./tools.js";
import { ARTIFACT_PUBLISH, ARTIFACT_PUBLISH_TOOL, ARTIFACT_READ, ARTIFACT_READ_TOOL, runArtifactPublish, runArtifactRead, type LoopArtifacts } from "./artifacts.js";
import { McpHttpClient, resultImages, resultText, splitDataImages } from "./mcp.js";
import { CALL_TOOL, FIND_TOOL, callToolSpec, familyOf, findToolSpec, searchCatalog, skillsIndex, type LoopCatalogEntry, type LoopSkill } from "./catalog.js";
import {
  streamMessage, isTextBlock, isToolUseBlock,
  type ContentBlock, type FetchLike, type ImageParam, type LoopEffort, type MessageParam, type TextParam, type ToolResultBlock, type ToolSpec, type AssembledMessage, withConversationCacheMark } from "./messages.js";

/** A transport drop, not an answer: the stream ended under fetch (`terminated`,
 *  a reset, a hang-up, a failed connect). A gateway's own refusal is an answer. */
export function isTransportDrop(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  if (/^gateway \d{3}/.test(m)) return false;
  return /terminated|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|socket hang up|fetch failed|network error|other side closed|aborted/i.test(m);
}

export { LOOP_EFFORTS, type LoopEffort } from "./messages.js";

// ── the host contract ────────────────────────────────────────────────────────

export interface LoopGateway { baseUrl: string; token: string }

export interface LoopMcpServer {
  /** A short name for the client handshake and logs. */
  name: string;
  url: string;
  headers?: Record<string, string>;
  /** The word the tool descriptions fall back to ("Glyphh tool x", "connection tool y"). */
  tag: string;
  /** THE FIXED BELT (his order, 2026-09-29: the toolset must not grow with
   *  every install and connection): the tools of this server wired into each
   *  thread type's prompt. Everything else it lists is in the catalog, found
   *  with find_tools and run with call_tool. Absent = all of them wired. */
  core?: { work?: ReadonlySet<string>; code?: ReadonlySet<string> };
  /** Which of this server's tools only read (never ask). Default: the server's
   *  readOnlyHint annotation, else the name (core.ts readsByName). */
  readOnly?: (tool: string) => boolean;
  /** Which of this server's tools may be lent at all. The host decides: the
   *  desktop drops its connection tools when the org has the connections lane
   *  off, so a gated lane is not merely refused at call time — it is never
   *  offered. Default: all of them. */
  allow?: (tool: string) => boolean;
}

/**
 * A SUB-AGENT DEFINITION (his order, 2026-09-29: "I just want the local agent
 * to spawn sub-agents for now based on definitions the user can create with
 * model slots running our full agent loop").
 *
 * The host owns these — on the desktop they are the member's own agent records
 * (name, standing prompt, model slot). The engine only needs enough to open a
 * child chat: who it is, what it always knows, and what it runs on. A child
 * runs THIS loop, with this host's tools, so an agent is not a different kind
 * of thing from the main agent. It is the same agent with a brief.
 */
export interface LoopAgentDef {
  slug: string;
  name: string;
  description?: string;
  /** WHAT RUNS IT (his order, 2026-10-07: "allow agents and tasks to define
   *  cli or glyphh agents with models"): "glyphh" (the default) is this loop
   *  as a child, with its own model slot; "cli" is one of the member's CLI
   *  agents (claude, codex, gemini, …) run headless by the host through
   *  LoopDeps.runCliAgent, with `cli` naming which. */
  kind?: "glyphh" | "cli";
  cli?: string;
  /** The standing instruction every one of this agent's runs opens with. */
  prompt: string;
  /** THE MODEL SLOT — empty runs it on the parent's model. This is the point
   *  of a swarm: a cheap model for the fan-out, a strong one for the synthesis. */
  model?: string;
  /** Its toolbelt. Absent = the parent's. */
  space?: LoopSpace;
  /** Its permission mode. Absent = the parent's. */
  permission?: LoopPermission;
  /** Its effort dial. Absent = the parent's (a child inherits the turn's). */
  effort?: LoopEffort;
}

/** Who a child event came from, so a host can nest it under the right agent. */
export interface LoopAgentRef { childId: string; slug: string; name: string; model: string }

export interface LoopDeps {
  /** The member's gateway credential, or null when the org's gateway lane is off. */
  gateway: () => Promise<LoopGateway | null>;
  /** MCP servers to lend this process's runs (resolved once per chat). */
  mcpServers?: () => Promise<LoopMcpServer[]>;
  /** The agents this member can hand work to. Absent (or empty) and the loop
   *  carries no spawn tool at all — no roster, no swarm, no prompt cost. */
  agents?: () => Promise<LoopAgentDef[]>;
  /** More of what the loop can do, reached through find_tools / call_tool and
   *  never wired into the prompt: installed apps' tools, the member's own MCP
   *  connections. Resolved when a chat's belt is built (invalidateTools()). */
  catalog?: () => Promise<LoopCatalogEntry[]>;
  /** The member's skills, indexed in the system prompt (name and when to use
   *  it); the model reads one in full with the host's skill_get when it fits. */
  skills?: () => Promise<LoopSkill[]>;
  /** TEST HARNESSES ONLY: how the shell is launched. Hosts leave it unset, and
   *  the shell runs sandboxed to the session's folder (sandbox.ts). */
  shell?: ShellLauncher;
  /** MEMORY, NATIVE (his order, 2026-09-28: the bridge goes, the memory lane
   *  stays through this loop). `facts` is asked for relevant context before the
   *  turn and, when it returns text, it rides inside the turn's own user
   *  message (2026-10-07: it changes every turn, so as a system block it broke
   *  the cache prefix before the transcript); `capture` is handed the exchange
   *  once the turn settles. Both are the host's business — the engine only
   *  calls them, and a host that passes neither has no memory, which is
   *  exactly the old behaviour. Every model gets memory this way, not just
   *  the one a proxy happened to sit in front of. */
  facts?: (userText: string, scope: { folder: string; workspace?: string }) => Promise<string>;
  /** STANDING TEXT (2026-10-07): what a host wants in the system prompt for the
   *  whole chat — a run's own instructions, a workspace note — the SAME every
   *  turn. It rides as a second, CACHED system block: constant text belongs
   *  in the prefix, where the cache reads it back. Per-turn text is `facts`. */
  standing?: (scope: { folder: string; workspace?: string }) => Promise<string>;
  /** A CLI AGENT AS A CHILD (2026-10-07): the host runs the named CLI headless
   *  with the agent's brief, the task and the model slot, in the chat's
   *  folder, and hands back what it printed. A host without the seam cannot
   *  run `kind: "cli"` agents, and the spawn says so. */
  runCliAgent?: (def: LoopAgentDef, task: string, opts: { model: string; workdir: string; signal: AbortSignal }) => Promise<{ text: string; failed: boolean }>;
  capture?: (userText: string, answer: string, scope: { folder: string; workspace?: string }) => void;
  /** THE USER'S ARTIFACTS (local only, 2026-10-18): the host's own store,
   *  behind artifact_publish and artifact_read. Absent and the loop carries
   *  neither tool. */
  artifacts?: LoopArtifacts;
  host?: LoopHost;
  fetch?: FetchLike;
  /** A warning sink for a lent server that would not connect (never fatal). */
  warn?: (message: string) => void;
}

export type LoopEvent =
  | { type: "setup"; phase: "ready"; model: string; loop: "glyphh" }
  | { type: "delta"; delta: string }
  /** The model's reasoning as it streams (a `thinking` block's text), for a
   *  host that shows it. A host that ignores unknown event types loses nothing. */
  | { type: "thinking"; chatId: string; text: string }
  | { type: "tool"; phase: "start"; name: string; title: string }
  | {
      type: "tool"; phase: "done"; name: string; title: string; failed: boolean; preview: string;
      /** What the step did, drawn rather than paraphrased: a diff, a command
       *  and its output, a read (tools.ts ToolDetail). Built-ins only. */
      detail?: ToolDetail;
      /** A lent tool's arguments, as sent (JSON, capped) — the host shows them. */
      input?: string;
      /** A lent tool's result, capped — what came back, for the person. */
      output?: string;
    }
  | { type: "progress"; inTokens: number; outTokens: number; cacheReadTokens: number }
  | { type: "approval"; id: string; kind: "command" | "edit" | "tool"; title: string; detail: string }
  | { type: "permission"; permission: LoopPermission }
  | { type: "done"; stopped: boolean }
  | { type: "error"; error: string }
  /** A sub-agent took a piece of the work, and later handed it back. Every
   *  event a child emits in between carries its `agent` ref, so a host can
   *  show the child's own feed without knowing anything about the engine. */
  | { type: "agent"; phase: "start"; agent: LoopAgentRef; task: string }
  | { type: "agent"; phase: "done"; agent: LoopAgentRef; failed: boolean; summary: string };

export type LoopEmit = (event: LoopEvent & { runId: string; agent?: LoopAgentRef }) => void;

/** A thread's TYPE (his order, 2026-09-29: two spaces, Work and Code). It is
 *  the TOOLBELT: a Work turn should not haul every tool definition the host
 *  lends into the prompt — that is token cost on every message and a cache
 *  prefix that churns. Work keeps only the gateway's two lookup tools, so the
 *  model can still FIND and call a connector's tool when a question turns out
 *  to need one; Code carries the file/shell builtins and everything lent.
 *  Absent = code (what every thread was before). */
export type LoopSpace = "work" | "code";

export interface LoopTurn {
  chatId: string;
  /** The user's message. Empty re-runs nothing new (a continuation). */
  text: string;
  /** The bare model id. The host resolves it (its picker, the org's default). */
  model: string;
  permission?: LoopPermission;
  /** The effort dial for this turn. Set, it replaces the chat's; absent, the
   *  chat keeps the one it had (none = the model's default). Rides the model
   *  round as `reasoning_effort`; never a compaction. */
  effort?: LoopEffort;
  workdir?: string;
  workspace?: string;
  /** The chat's stored turns, to seed a conversation this process has not seen. */
  history?: SeedTurn[];
  /** Work or Code — the toolbelt this thread runs with. A birth property of
   *  the thread: the host sends the same one on every turn of it. */
  space?: LoopSpace;
  /** Images the host read for this message (a paste, a drop, a screenshot).
   *  Files that are not images are the host's business: it puts their paths in
   *  the text, and the loop's own read tools open them. */
  images?: ImageParam[];
}

interface McpTool {
  client: McpHttpClient;
  realName: string;
  readOnly: boolean;
  /** Lent by the HOST's own server (the desktop's local MCP), not by the
   *  gateway's connector plane. A Work thread keeps these. */
  local: boolean;
}

interface LoopChat {
  chatId: string;
  messages: MessageParam[];
  model: string;
  permission: LoopPermission;
  /** The effort dial the last turn set, carried turn to turn. */
  effort?: LoopEffort;
  workdir: string;
  runId: string;
  emit: LoopEmit;
  abort: AbortController | null;
  running: boolean;
  nextApproval: number;
  approvals: Map<string, (allow: boolean) => void>;
  usage: { inTokens: number; outTokens: number; cacheRead: number };
  /** Messages sent WHILE this chat was working — they ride the next turn. */
  queued: Array<{ text: string; images?: ImageParam[] }>;
  mcp: Map<string, McpTool>;
  clients: McpHttpClient[];
  tools: ToolSpec[] | null;
  space: LoopSpace;
  hasLocalMcp: boolean;
  hasGateway: boolean;
  /** What find_tools searches: tools not on the belt. */
  catalog: LoopCatalogEntry[];
  /** The gateway's connected-account search and call, when it lends them. */
  accounts: { search: McpTool; call: McpTool | null } | null;
  /** The skills index for the system prompt ("" = none). */
  skillsText: string;
  /** The working set: catalog tools this chat called, and when. */
  recent: Map<string, number>;
  /** Set on a CHILD chat: which agent it is. Its events carry this, it never
   *  spawns further (one level of fan-out, on purpose), and it is not in the
   *  engine's chat map — it lives for one piece of work. */
  as?: LoopAgentRef;
  /** A child's parent: who owns its approvals (an approval id has to name a
   *  chat the host can answer into) and who its tokens roll up to. */
  owner?: LoopChat;
  /** Children started during THIS run — the fan-out cap. */
  spawned: number;
  /** The roster the spawn tool was built from, for resolving a slug. */
  roster: LoopAgentDef[] | null;
  /** The gateway credential this run is using — a child needs it to call. */
  wire: { baseUrl: string; token: string } | null;
  /** The host said its tools changed (a new agent, a new connection): the
   *  belt is rebuilt when this chat's next turn starts — never mid-turn, when
   *  its lent clients are still answering calls. */
  toolsStale?: boolean;
}

/** How many tools may run at once, and how many agents one run may start.
 *  Both are about the person's bill and their patience, not correctness. */
const MAX_PARALLEL_TOOLS = 4;

/** What a tool run hands back to the model: its text, and any images it produced. */
type ToolRun = { text: string; failed: boolean; detail?: ToolDetail; images?: ImageParam[] };

/** A tool result's text, at most this long (~25k tokens): one result can no
 *  longer turn a prompt into a dollar-a-call (his audit, 2026-09-29). */
export const TOOL_RESULT_CHARS = 100_000;
/** Images per result, and the vendor's per-image ceiling (base64 characters). */
const TOOL_RESULT_IMAGES = 4;
const IMAGE_B64_MAX = 5_000_000;

/** The tool_result content: text without any base64 in it (a data:image URL
 *  becomes an image block), capped with a note, plus the result's images. */
export function toolResultContent(r: { text: string; images?: ImageParam[] }): string | Array<TextParam | ImageParam> {
  const split = splitDataImages(r.text);
  const over = split.text.length - TOOL_RESULT_CHARS;
  const text = over > 0
    ? `${split.text.slice(0, TOOL_RESULT_CHARS)}\n\n[truncated: ${over.toLocaleString("en-US")} more characters. Ask for a narrower read: a line range, a search, or a smaller page.]`
    : split.text;
  const images = [...(r.images ?? []), ...split.images].filter((im) => im.source.data.length <= IMAGE_B64_MAX).slice(0, TOOL_RESULT_IMAGES);
  return images.length ? [{ type: "text", text: text || "(image)" }, ...images] : text;
}
/** How much of a lent tool's arguments and result the HOST sees per step. */
const TOOL_IO_CAP = 8_000;
const MAX_SPAWN_PER_RUN = 8;

/** Run `fn` over `items` with at most `limit` in flight. Order of completion
 *  is whatever it is; the caller puts the results back in the model's order. */
async function inPool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]!);
    }
  });
  await Promise.all(workers);
}

export const GATEWAY_OFF_MESSAGE = "No model provider is set up yet. Add one in Settings › Models.";
/** Plain words for the person (his report, 2026-09-29: "make the message make sense to the user"). */
export const NO_MODEL_MESSAGE = "Choose a model in the model picker below.";
export const NO_FOLDER_MESSAGE = "This session has no folder. Pick one for it — the agent works inside that folder and nowhere else.";
export const BUSY_MESSAGE = "The Glyphh loop is still working on the last message. Stop it or wait for it to finish.";

export class GlyphhLoop {
  private readonly chats = new Map<string, LoopChat>();

  constructor(private readonly deps: LoopDeps) {}

  has(chatId: string): boolean { return this.chats.has(chatId); }

  /** An approval id this loop minted (`<chatId>:g<n>`). */
  static isApproval(id: string): boolean { return /:g\d+$/.test(id); }

  private send(c: LoopChat, ev: LoopEvent): void {
    // A child's events ride the PARENT's run id with the child's own ref
    // attached: one run, several voices, and the host nests by `agent`.
    try { c.emit({ runId: c.runId, ...(c.as ? { agent: c.as } : {}), ...ev }); } catch { /* the host's sink is gone */ }
  }

  // ── tools ──────────────────────────────────────────────────────────────────

  private async lentTools(c: LoopChat): Promise<ToolSpec[]> {
    const defs: ToolSpec[] = [];
    const servers = this.deps.mcpServers ? await this.deps.mcpServers().catch(() => [] as LoopMcpServer[]) : [];
    for (const s of servers) {
      const client = new McpHttpClient({ url: s.url, ...(s.headers ? { headers: s.headers } : {}), name: s.name, ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}) });
      try {
        await client.connect();
        const listed = await client.listTools();
        c.clients.push(client);
        const belt = s.core ? s.core[c.space] : undefined;
        for (const t of listed) {
          const name = safeToolName(t.name);
          if (s.allow && !s.allow(t.name)) continue;
          if (defs.some((d) => d.name === name) || BUILTIN_TOOLS.some((b) => b.name === name) || name === ARTIFACT_PUBLISH || name === ARTIFACT_READ || name === FIND_TOOL || name === CALL_TOOL) continue;
          const readOnly = s.readOnly ? s.readOnly(t.name) : (t.annotations?.readOnlyHint === true || (t.annotations?.readOnlyHint !== false && readsByName(t.name)));
          const tool: McpTool = { client, realName: t.name, readOnly, local: s.tag === "Glyphh" };
          // The gateway's lookup pair stands in for every connected account's
          // tools; find_tools / call_tool drive it, so it is never listed itself.
          if (!tool.local && GlyphhLoop.ACCOUNT_SEARCH === t.name) { c.accounts = { search: tool, call: c.accounts?.call ?? null }; continue; }
          if (!tool.local && GlyphhLoop.ACCOUNT_CALL === t.name) { c.accounts = { search: c.accounts?.search ?? tool, call: tool }; continue; }
          const description = (t.description ?? `${s.tag} tool ${t.name}`).slice(0, 1000);
          // Off the belt: in the catalog, found by search and run through call_tool.
          if (!tool.local || (s.core && !belt?.has(t.name))) {
            c.catalog.push({
              name, description, family: tool.local ? familyOf(t.name) : s.tag, readOnly,
              ...(t.inputSchema ? { inputSchema: t.inputSchema as Record<string, unknown> } : {}),
              run: async (args, signal) => {
                const out = await client.callTool(t.name, args, signal);
                return { text: resultText(out), failed: out.isError, images: resultImages(out) };
              },
            });
            continue;
          }
          c.mcp.set(name, tool);
          defs.push({ name, description, input_schema: t.inputSchema ?? { type: "object", properties: {} } });
        }
        if (s.tag === "Glyphh") c.hasLocalMcp = true;
      } catch (err) {
        this.deps.warn?.(`[glyphh-loop] ${s.name} unavailable: ${err instanceof Error ? err.message : String(err)}`);
        void client.close();
      }
    }
    c.hasGateway = !!c.accounts?.search && !!c.accounts.call;
    if (!c.hasGateway) c.accounts = null;
    return defs;
  }

  /** The gateway's own lookup pair: a connected account's thousands of tools
   *  are REACHED through these, never listed. */
  private static readonly ACCOUNT_SEARCH = "mcp_tool_search";
  private static readonly ACCOUNT_CALL = "mcp_tool_call";

  /**
   * WORK KEEPS THE HOST'S OWN TOOLS (his report, 2026-09-29: "the glyphh agent
   * loop doesn't have access or isn't getting the full tool list to run
   * glyphh"). Work was cut to the lookup pair alone, which dropped the tools
   * that ARE the product — the desktop's panels, apps, layouts, tasks, skills
   * and memory — so a Work thread could reach a connected account and not its
   * own application. Those come from the host's local server and stay.
   *
   * What Work does NOT carry: the file and shell builtins (that is Code), and
   * the gateway's connector definitions, which the lookup pair reaches on
   * demand instead of listing on every message.
   */
  private async toolset(c: LoopChat): Promise<ToolSpec[]> {
    if (c.tools) return c.tools;
    c.catalog = [];
    c.accounts = null;
    const lent = await this.lentTools(c);
    // The host's own additions (installed apps' tools, its MCP connections) go
    // straight into the catalog; a name already on the belt keeps the belt's.
    const extra = this.deps.catalog ? await this.deps.catalog().catch(() => [] as LoopCatalogEntry[]) : [];
    const taken = new Set([...lent.map((t) => t.name), ...c.catalog.map((e) => e.name), ...BUILTIN_TOOLS.map((b) => b.name), ARTIFACT_PUBLISH, ARTIFACT_READ]);
    for (const e of extra) if (e?.name && !taken.has(e.name)) { c.catalog.push(e); taken.add(e.name); }
    const skills = this.deps.skills ? await this.deps.skills().catch(() => [] as LoopSkill[]) : [];
    c.skillsText = skillsIndex(skills, "skill_get");
    // CODE carries the builtins; both types carry the artifact pair (publish,
    // read) when the host keeps artifacts, the host's belt and the one
    // find/call pair over everything else.
    const finder = c.catalog.length || c.accounts ? [findToolSpec(c.catalog, !!c.accounts), callToolSpec()] : [];
    // A host entry marked `belt` rides the belt by name (the worker's app
    // doors, 2026-10-07); the rest of the catalog is found.
    const hostBelt: ToolSpec[] = c.catalog.filter((e) => e.belt).map((e) => ({ name: e.name, description: e.description, input_schema: e.inputSchema ?? { type: "object", properties: {} } }));
    const belt: ToolSpec[] = [
      ...(c.space === "code" ? BUILTIN_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })) : []),
      ...(this.deps.artifacts ? [ARTIFACT_PUBLISH_TOOL, ARTIFACT_READ_TOOL].map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })) : []),
      ...lent,
      ...hostBelt,
      ...finder,
    ];
    const spawn = await this.spawnTool(c);
    c.tools = spawn ? [...belt, spawn] : belt;
    return c.tools;
  }

  /** find_tools: this machine's catalog and the gateway's connected accounts, one answer. */
  private async findTools(c: LoopChat, input: unknown, signal: AbortSignal): Promise<{ text: string; failed: boolean }> {
    const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const query = typeof o.query === "string" ? o.query : "";
    const limit = typeof o.limit === "number" && o.limit > 0 ? Math.min(20, Math.floor(o.limit)) : 8;
    if (!query.trim()) return { text: "find_tools needs a query: the task, in plain words", failed: true };
    const local = searchCatalog(c.catalog, query, limit, c.recent).map((e) => ({ name: e.name, from: e.family, description: e.description, input_schema: e.inputSchema ?? { type: "object", properties: {} } }));
    let accounts: unknown = undefined;
    if (c.accounts) {
      try {
        const r = await c.accounts.search.client.callTool(c.accounts.search.realName, { query, top_k: limit }, signal);
        const text = resultText(r);
        try { accounts = JSON.parse(text); } catch { accounts = text; }
      } catch (err) {
        accounts = `connected-account search failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    if (!local.length && (accounts === undefined || (Array.isArray(accounts) && !accounts.length))) {
      return { text: `Nothing matched "${query}". Try describing the task differently, or tell the user no tool for it is available.`, failed: false };
    }
    return { text: JSON.stringify({ on_this_machine: local, ...(accounts !== undefined ? { connected_accounts: accounts } : {}) }, null, 1), failed: false };
  }

  /** call_tool: a catalog tool, a belt tool named through it, or a connected account's. */
  private async callTool(c: LoopChat, input: unknown, signal: AbortSignal): Promise<ToolRun> {
    const { name, args } = GlyphhLoop.callTarget(input);
    if (!name) return { text: "call_tool needs the tool's exact name from find_tools", failed: true };
    const entry = c.catalog.find((e) => e.name === name);
    if (entry) {
      c.recent.set(name, Date.now());
      try { return await entry.run(args, signal); } catch (err) { return { text: err instanceof Error ? err.message : String(err), failed: true }; }
    }
    if (name !== CALL_TOOL && name !== FIND_TOOL && (BUILTIN_TOOLS.some((b) => b.name === name) || name === ARTIFACT_PUBLISH || name === ARTIFACT_READ || c.mcp.has(name))) return this.runTool(c, name, args, signal);
    if (c.accounts?.call) {
      try {
        const r = await c.accounts.call.client.callTool(c.accounts.call.realName, { tool_name: name, arguments: args }, signal);
        return { text: resultText(r), failed: r.isError, images: resultImages(r) };
      } catch (err) {
        return { text: err instanceof Error ? err.message : String(err), failed: true };
      }
    }
    return { text: `unknown tool ${name}: search for it with find_tools first`, failed: true };
  }

  private static promptExtras(c: LoopChat, host: LoopHost | undefined): PromptExtras {
    return {
      hasLocalMcp: c.hasLocalMcp, hasGateway: c.hasGateway, ...(host ? { host } : {}),
      finder: !!c.tools?.some((t) => t.name === FIND_TOOL), skills: c.skillsText,
    };
  }

  private static callTarget(input: unknown): { name: string; args: Record<string, unknown> } {
    const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    const args = o.arguments && typeof o.arguments === "object" && !Array.isArray(o.arguments) ? o.arguments as Record<string, unknown> : {};
    return { name, args };
  }

  static readonly SPAWN_TOOL = "spawn_agent";

  /** ONE TOOL, NOT TWO: the roster rides the tool's own description and its
   *  slug enum, so the model cannot name an agent that does not exist and the
   *  belt does not grow a second "list the agents" call. No agents defined
   *  means no tool at all — a member who has not made any pays nothing for the
   *  feature. A child never gets it: one level of fan-out. */
  private async spawnTool(c: LoopChat): Promise<ToolSpec | null> {
    if (c.as || !this.deps.agents) return null;
    const roster = (await this.deps.agents().catch(() => [] as LoopAgentDef[]))
      .filter((a): a is LoopAgentDef => !!a?.slug && !!a?.prompt);
    c.roster = roster.length ? roster : null;
    if (!roster.length) return null;
    const lines = roster
      .map((a) => `- ${a.slug}: ${a.name}${a.description ? ` — ${a.description}` : ""}${a.kind === "cli" ? ` [a ${a.cli || "CLI"} agent, run headless on this machine${a.model ? ` on ${a.model}` : ""}]` : a.model ? ` [runs on ${a.model}]` : ""}`)
      .join("\n");
    return {
      name: GlyphhLoop.SPAWN_TOOL,
      description:
        "Hand a self-contained piece of work to one of the user's own agents and get its answer back. "
        + "Each agent has a standing brief of its own and may run on a different model. "
        + "Ask for SEVERAL in one message and they work in parallel. "
        + "An agent cannot see this conversation or the other agents, so `task` and `context` must carry everything it needs. "
        + "Worth it for work that is genuinely separable (research a question, review a file, draft a section); do it yourself when it is one short step.\n"
        + `The user's agents:\n${lines}`,
      input_schema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Which agent, by slug", enum: roster.map((a) => a.slug) },
          task: { type: "string", description: "What this agent must do, stated on its own terms" },
          context: { type: "string", description: "What it needs to know and has no way of knowing" },
        },
        required: ["agent", "task"],
      },
    };
  }

  private async runTool(c: LoopChat, name: string, input: unknown, signal: AbortSignal): Promise<ToolRun> {
    if (name === GlyphhLoop.SPAWN_TOOL) return this.spawn(c, input, signal);
    if (name === FIND_TOOL) return this.findTools(c, input, signal);
    if (name === CALL_TOOL) return this.callTool(c, input, signal);
    if (BUILTIN_TOOLS.some((b) => b.name === name)) return runBuiltin(name, input, c.workdir, signal, this.deps.shell);
    if (name === ARTIFACT_PUBLISH) return runArtifactPublish(input, { workdir: c.workdir, hasFolder: c.space === "code", artifacts: this.deps.artifacts ?? null });
    if (name === ARTIFACT_READ) return runArtifactRead(input, { artifacts: this.deps.artifacts ?? null });
    const onBelt = c.catalog.find((e) => e.belt && e.name === name);
    if (onBelt) {
      c.recent.set(name, Date.now());
      try { return await onBelt.run((input && typeof input === "object" ? input : {}) as Record<string, unknown>, signal); }
      catch (err) { return { text: err instanceof Error ? err.message : String(err), failed: true }; }
    }
    const m = c.mcp.get(name);
    if (!m) return { text: `unknown tool ${name}`, failed: true };
    try {
      const r = await m.client.callTool(m.realName, (input && typeof input === "object" ? input : {}) as Record<string, unknown>, signal);
      return { text: resultText(r), failed: r.isError, images: resultImages(r) };
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err), failed: true };
    }
  }

  // ── sub-agents ─────────────────────────────────────────────────────────────

  /** The spawn tool's body: resolve the slug, run the child, hand back its
   *  answer as the tool result. Every failure is an ANSWER, not an exception:
   *  the parent must be able to read what went wrong and carry on. */
  private async spawn(c: LoopChat, input: unknown, signal: AbortSignal): Promise<{ text: string; failed: boolean }> {
    const p = (input && typeof input === "object" ? input : {}) as { agent?: unknown; task?: unknown; context?: unknown };
    const slug = String(p.agent ?? "").trim();
    const task = String(p.task ?? "").trim();
    const context = String(p.context ?? "").trim();
    const def = (c.roster ?? []).find((a) => a.slug === slug);
    if (!def) return { text: `No such agent: ${slug || "(none named)"}. The available ones are listed in this tool's description.`, failed: true };
    if (!task) return { text: `Nothing to do: spawn_agent needs a task for ${def.name}.`, failed: true };
    if (c.spawned >= MAX_SPAWN_PER_RUN) {
      return { text: `This turn has already started ${MAX_SPAWN_PER_RUN} agents, which is the limit. Finish with what they returned, or ask the user to split the work.`, failed: true };
    }
    if (!c.wire) return { text: "The gateway credential for this run is gone; an agent cannot be started.", failed: true };
    return this.runChild(c, def, task, context, c.wire, signal);
  }

  /** ONE CHILD: this same loop, with its own brief, its own model slot and its
   *  own toolbelt, for one piece of work.
   *
   *  It is not in the engine's chat map and keeps no history: a child is a
   *  piece of work, not a conversation. It shares the parent's abort (stopping
   *  a run stops the swarm), its approvals go through the parent (an id has to
   *  name a chat the host can answer into), and its tokens roll up, because
   *  the person pays for the run, not for each agent. */
  private async runChild(
    parent: LoopChat, def: LoopAgentDef, task: string, context: string,
    wire: { baseUrl: string; token: string }, signal: AbortSignal,
  ): Promise<{ text: string; failed: boolean }> {
    parent.spawned += 1;
    const model = (def.model || parent.model).trim();
    const name = def.name || def.slug;
    const ref: LoopAgentRef = { childId: `${parent.runId}#${parent.spawned}`, slug: def.slug, name, model };
    const child: LoopChat = {
      chatId: `${parent.chatId}/${def.slug}#${parent.spawned}`,
      messages: [{ role: "user", content: context ? `${task}\n\nContext from the main agent:\n${context}` : task }],
      model, permission: def.permission ?? parent.permission, workdir: parent.workdir,
      ...((def.effort ?? parent.effort) ? { effort: def.effort ?? parent.effort } : {}),
      runId: parent.runId, emit: parent.emit, abort: parent.abort, running: true,
      nextApproval: 1, approvals: new Map(), usage: { inTokens: 0, outTokens: 0, cacheRead: 0 },
      queued: [], mcp: new Map(), clients: [], tools: null,
      space: def.space ?? parent.space, hasLocalMcp: false, hasGateway: false,
      catalog: [], accounts: null, skillsText: "", recent: new Map(),
      as: ref, owner: parent, spawned: 0, roster: null, wire,
    };
    this.send(parent, { type: "agent", phase: "start", agent: ref, task });
    let answer = "";
    let failed = false;
    // A CLI AGENT runs on the host, headless, not as a loop child (2026-10-07).
    if (def.kind === "cli") {
      const prompt = context ? `${task}

Context from the main agent:
${context}` : task;
      try {
        if (!this.deps.runCliAgent) throw new Error(`"${name}" is a CLI agent, and this host cannot run one headless`);
        const r = await this.deps.runCliAgent(def, prompt, { model, workdir: parent.workdir, signal });
        answer = r.text;
        failed = r.failed;
      } catch (err) {
        failed = true;
        answer = err instanceof Error ? err.message : String(err);
      }
      const saidCli = answer.trim();
      this.send(parent, { type: "agent", phase: "done", agent: ref, failed: failed || !saidCli, summary: preview(saidCli || "(nothing)") });
      if (failed) return { text: `${name} failed: ${saidCli}`, failed: true };
      return { text: saidCli || `${name} returned nothing.`, failed: !saidCli };
    }
    try {
      await this.toolset(child);
      const system: TextParam[] = [
        { type: "text", text: systemPrompt(child.workdir, GlyphhLoop.promptExtras(child, this.deps.host)), cache_control: { type: "ephemeral" } },
        // The agent's own brief, and the shape of its answer: a child reports
        // back to another agent, so a closing question or a "shall I?" is dead
        // air — nobody is there to answer it.
        {
          type: "text",
          text: `You are "${name}", one of the user's agents, working for the main Glyphh agent on one piece of work.\n\n${def.prompt.trim()}\n\n`
            + "Do the work and report what you found or did, in full, in your final message: that message is the whole of what the main agent receives. "
            + "Ask no questions and offer no next steps.",
          cache_control: { type: "ephemeral" },
        },
      ];
      answer = await this.rounds(child, wire, system, signal);
    } catch (err) {
      failed = true;
      answer = err instanceof Error ? err.message : String(err);
    } finally {
      for (const cl of child.clients) void cl.close();
    }
    parent.usage.inTokens += child.usage.inTokens;
    parent.usage.outTokens += child.usage.outTokens;
    parent.usage.cacheRead += child.usage.cacheRead;
    this.send(parent, { type: "progress", inTokens: parent.usage.inTokens, outTokens: parent.usage.outTokens, cacheReadTokens: parent.usage.cacheRead });
    const said = answer.trim();
    this.send(parent, { type: "agent", phase: "done", agent: ref, failed: failed || !said, summary: preview(said || "(nothing)") });
    if (failed) return { text: `${name} failed: ${said}`, failed: true };
    return { text: said || `${name} returned nothing.`, failed: !said };
  }

  /** Park the run on an approval; the host's answer resolves it.
   *
   *  The id names the OWNER chat (a child's parent): `respondApproval` finds a
   *  chat by the id's prefix, and a child is not in the engine's map — so a
   *  child's ask would have been unanswerable. The event still carries the
   *  child's ref, so the person sees who is asking. */
  private askPermission(c: LoopChat, kind: "command" | "edit" | "tool", title: string, detail: string): Promise<boolean> {
    const owner = c.owner ?? c;
    const id = `${owner.chatId}:g${owner.nextApproval++}`;
    return new Promise((resolve) => {
      owner.approvals.set(id, resolve);
      this.send(c, { type: "approval", id, kind, title, detail: detail.slice(0, 2000) });
    });
  }

  // ── the loop ───────────────────────────────────────────────────────────────

  private chatFor(t: LoopTurn, emit: LoopEmit): LoopChat {
    let c = this.chats.get(t.chatId);
    if (!c) {
      const seeded = seedFromChat(t.history ?? [], t.text).map((m): MessageParam => ({ role: m.role, content: m.content }));
      c = {
        chatId: t.chatId, messages: seeded, model: "", permission: t.permission ?? "ask", workdir: t.workdir || "", runId: "", emit,
        abort: null, running: false, nextApproval: 1, approvals: new Map(), usage: { inTokens: 0, outTokens: 0, cacheRead: 0 }, queued: [], mcp: new Map(), clients: [], tools: null,
        space: t.space ?? "code",
        hasLocalMcp: false, hasGateway: false,
        catalog: [], accounts: null, skillsText: "", recent: new Map(),
        spawned: 0, roster: null, wire: null,
      };
      this.chats.set(t.chatId, c);
    }
    c.emit = emit;
    // A thread's type never changes (it is a birth property), but the host
    // re-sends it every turn; honour a correction and drop the cached toolset
    // so the next turn is built with the right belt.
    if (t.space && t.space !== c.space) { c.space = t.space; c.tools = null; }
    if (t.permission) c.permission = t.permission;
    if (t.effort) c.effort = t.effort;
    if (t.workdir) c.workdir = t.workdir;
    return c;
  }

  private async compact(c: LoopChat, wire: { baseUrl: string; token: string }, signal: AbortSignal): Promise<void> {
    const transcript = c.messages.map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content).slice(0, 4000)}`).join("\n\n");
    const res = await streamMessage({
      ...wire, signal, ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      body: {
        model: c.model, max_tokens: 2000,
        system: "Summarize this conversation for the assistant that will continue it: goals, decisions, files touched, open threads, and anything the user asked to remember. Terse, factual, no preamble.",
        messages: [{ role: "user", content: transcript.slice(-400_000) }],
      },
    });
    const summary = res.content.filter(isTextBlock).map((b) => b.text).join("\n");
    c.messages = [{ role: "user", content: `Summary of the conversation so far:\n\n${summary}` }, { role: "assistant", content: "Understood. I have the context and will continue from here." }];
    this.send(c, { type: "delta", delta: "\n\n(compacted the earlier conversation)\n\n" });
  }

  /**
   * THE ROUNDS: model, tools, model again, until it stops asking. Shared by a
   * turn and by every sub-agent, so a child is the same loop and not a lesser
   * copy of it. Returns everything the assistant said, for `capture`.
   */
  private async rounds(c: LoopChat, wire: { baseUrl: string; token: string }, system: TextParam[], signal: AbortSignal): Promise<string> {
    const tools = await this.toolset(c);
    let answer = "";
    for (let round = 0; ; round++) {
      if (signal.aborted) break;
      // THE LIMIT IS SAID OUT LOUD (his report, 2026-10-08). Reaching it used
      // to end the turn as an ordinary done with nothing said, so the work just
      // stopped and the person had to prod. Now the turn says it paused, and
      // the note joins the transcript as the assistant's last word: the
      // conversation still alternates, and "continue" resumes with every tool
      // result of this turn in context.
      if (round >= MAX_TOOL_ROUNDS) {
        const note = roundsPausedMessage(MAX_TOOL_ROUNDS);
        answer += note;
        this.send(c, { type: "delta", delta: note });
        c.messages.push({ role: "assistant", content: [{ type: "text", text: note.trim() }] });
        break;
      }
      // A DROPPED STREAM IS NOT A FAILED TURN (his report, 2026-10-08: "The
      // turn didn't go through — terminated", at random). `terminated` is what
      // fetch says when the gateway's stream closes under it — a deploy, an
      // idle edge, a dead socket. With nothing of this round streamed yet,
      // the request is simply made again; once text has reached the member
      // the error stands, so nothing is shown twice.
      let streamedThisRound = 0;
      const request = (): Promise<AssembledMessage> => streamMessage({
        ...wire, signal, ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
        // The transcript rides with its cache breakpoint on the newest message
        // (withConversationCacheMark): the next round reads every earlier
        // turn from the cache instead of paying for it again.
        body: { model: c.model, max_tokens: MAX_TOKENS_OUT, system, messages: withConversationCacheMark(c.messages), tools, ...(c.effort ? { reasoning_effort: c.effort } : {}) },
        onText: (delta) => { streamedThisRound += delta.length; answer += delta; this.send(c, { type: "delta", delta }); },
        onThinking: (text) => this.send(c, { type: "thinking", chatId: c.chatId, text }),
      });
      let final: AssembledMessage;
      try {
        final = await request();
      } catch (err) {
        if (signal.aborted || streamedThisRound > 0 || !isTransportDrop(err)) throw err;
        await new Promise((r) => setTimeout(r, 800));
        if (signal.aborted) throw err;
        final = await request();
      }
      c.usage.inTokens += final.usage.input_tokens;
      c.usage.outTokens += final.usage.output_tokens;
      c.usage.cacheRead += final.usage.cache_read_input_tokens;
      this.send(c, { type: "progress", inTokens: c.usage.inTokens, outTokens: c.usage.outTokens, cacheReadTokens: c.usage.cacheRead });
      c.messages.push({ role: "assistant", content: final.content as ContentBlock[] });
      const uses = final.content.filter(isToolUseBlock);
      if (final.stop_reason !== "tool_use" || !uses.length) break;
      // VERDICTS FIRST, ONE AT A TIME: an approval is a conversation with a
      // person, and two prompts at once is not one.
      const planned: Array<{ use: typeof uses[number]; title: string; allowed: boolean }> = [];
      for (const use of uses) {
        if (signal.aborted) break;
        // DELEGATING IS NOT THE RISKY PART: a sub-agent touches nothing by
        // existing, and whatever it then tries — an edit, a command — is gated
        // in ITS OWN rounds with the same vocabulary. Asking twice (once to
        // start it, once for what it does) would make Ask mode unusable at the
        // very moment a swarm is worth having.
        // A call_tool is gated as the tool it runs: a read stays a read, a send asks.
        const inner = use.name === CALL_TOOL ? GlyphhLoop.callTarget(use.input) : null;
        const innerEntry = inner ? c.catalog.find((e) => e.name === inner.name) : undefined;
        const kind = use.name === GlyphhLoop.SPAWN_TOOL || use.name === FIND_TOOL ? "read"
          : inner ? toolKind(inner.name, innerEntry ? innerEntry.readOnly === true : c.mcp.get(inner.name)?.readOnly === true)
          : toolKind(use.name, (c.catalog.find((e) => e.belt && e.name === use.name)?.readOnly ?? c.mcp.get(use.name)?.readOnly) === true);
        const title = inner?.name ? toolTitle(inner.name, inner.args) : toolTitle(use.name, use.input);
        let verdict = gate(c.permission, kind);
        // A tool its host marked ask-always asks even in Auto; Plan runs nothing that does.
        if (verdict === "allow" && innerEntry?.ask) verdict = c.permission === "plan" ? "deny" : "ask";
        if (verdict === "ask") {
          const askKind = kind === "exec" ? "command" : kind === "edit" ? "edit" : "tool";
          verdict = (await this.askPermission(c, askKind, title, JSON.stringify(use.input ?? {}, null, 2))) ? "allow" : "deny";
        }
        if (verdict === "deny") this.send(c, { type: "tool", phase: "done", name: use.name, title, failed: true, preview: "not permitted in this mode" });
        planned.push({ use, title, allowed: verdict === "allow" });
      }
      // THEN RUN THEM TOGETHER (his order, 2026-09-29: sub-agent swarms). A
      // model asks for several tools in ONE message; running them in series
      // made every fan-out a queue, which is most of what makes a swarm worth
      // having. Bounded by MAX_PARALLEL_TOOLS, and the results go back to the
      // model in the order it asked, whatever order they finish in.
      const ran = new Map<string, ToolRun>();
      const allowed = planned.filter((x) => x.allowed);
      for (const x of allowed) this.send(c, { type: "tool", phase: "start", name: x.use.name, title: x.title });
      await inPool(allowed, MAX_PARALLEL_TOOLS, async (x) => {
        const r: ToolRun = signal.aborted
          ? { text: "The run was stopped before this step.", failed: true }
          : await this.runTool(c, x.use.name, x.use.input, signal);
        // A built-in says what it did as a detail; anything else shows the
        // person what went in and what came back (capped — the model still
        // gets the whole result).
        const builtin = BUILTIN_TOOLS.some((b) => b.name === x.use.name);
        this.send(c, {
          type: "tool", phase: "done", name: x.use.name, title: x.title, failed: r.failed, preview: preview(r.text),
          ...(r.detail ? { detail: r.detail } : {}),
          ...(!builtin ? { input: JSON.stringify(x.use.input ?? {}, null, 2).slice(0, TOOL_IO_CAP), output: r.text.slice(0, TOOL_IO_CAP) } : {}),
        });
        ran.set(x.use.id, r);
      });
      c.messages.push({
        role: "user",
        content: planned.map((x): ToolResultBlock => {
          const r = ran.get(x.use.id);
          if (!r) {
            return {
              type: "tool_result", tool_use_id: x.use.id, is_error: true,
              content: c.permission === "plan" ? "Not run: plan mode reads only. Describe the change instead." : "The user declined this step.",
            };
          }
          return { type: "tool_result", tool_use_id: x.use.id, is_error: r.failed, content: toolResultContent(r) };
        }),
      });
      if (shouldCompact(final.usage.input_tokens)) await this.compact(c, wire, signal);
    }
    return answer;
  }

  /** One turn. Resolves when the run has settled (done or error emitted). */
  async run(t: LoopTurn, emit: LoopEmit): Promise<{ runId: string }> {
    const c = this.chatFor(t, emit);
    c.runId = `${t.chatId}:${Date.now()}`;
    const fail = (error: string): { runId: string } => {
      this.send(c, { type: "error", error });
      this.send(c, { type: "done", stopped: true });
      return { runId: c.runId };
    };
    // A SEND DURING A RUN IS NOT A REFUSAL (his report, 2026-09-23: a message
    // typed mid-turn "is not automatically sent... it should be"). It waits its
    // turn and goes out the moment this one settles, the way a CLI queues.
    if (c.running) {
      if (t.text || t.images?.length) c.queued.push({ text: t.text, ...(t.images?.length ? { images: t.images } : {}) });
      else return fail(BUSY_MESSAGE);
      return { runId: c.runId };
    }
    const creds = await this.deps.gateway().catch(() => null);
    if (!creds) return fail(GATEWAY_OFF_MESSAGE);
    const model = (t.model ?? "").trim();
    if (!model) return fail(NO_MODEL_MESSAGE);
    // NO FOLDER, NO CODE TURN (his rule, 2026-09-29: the agent is sandboxed to
    // the session's folder). There used to be a silent fallback to the home
    // directory, which is exactly how a turn ended up working somewhere the
    // person never chose. A Work turn has no file or shell tools, so its folder
    // only names where it is.
    if (!c.workdir) {
      if (c.space !== "work") return fail(NO_FOLDER_MESSAGE);
      c.workdir = homedir();
    }
    c.model = model;
    c.running = true;
    c.abort = new AbortController();
    const signal = c.abort.signal;
    const scope = { folder: c.workdir, ...(t.workspace ? { workspace: t.workspace } : {}) };
    const wire = { baseUrl: creds.baseUrl, token: creds.token };
    c.wire = wire;
    c.spawned = 0;
    if (c.toolsStale) {
      for (const cl of c.clients) void cl.close();
      c.clients = [];
      c.mcp.clear();
      c.tools = null;
      c.roster = null;
      c.toolsStale = false;
    }
    this.send(c, { type: "setup", phase: "ready", model, loop: "glyphh" });
    // What the member has told us before, if the host keeps memory. IT RIDES
    // THE USER'S MESSAGE, not the system prompt (his question, 2026-10-07:
    // "why are we not using prompt caching through the gateway?"): as a second
    // system block it changed every turn, and the cache prefix runs tools →
    // system → messages, so nothing after it could ever be read from the cache
    // — the whole transcript was re-sent uncached. In the turn's own message
    // it is part of the history like everything else the member sent, and the
    // prefix before each new turn stays identical.
    const recalled = this.deps.facts && t.text ? await this.deps.facts(t.text, scope).catch(() => "") : "";
    if (t.text || t.images?.length) {
      const blocks: Array<ContentBlock | ToolResultBlock> = [
        ...(t.text ? [{ type: "text", text: t.text } as ContentBlock] : []),
        ...(t.images ?? []) as ContentBlock[],
        ...(recalled.trim() ? [{ type: "text", text: recalled } as ContentBlock] : []),
      ];
      c.messages.push({ role: "user", content: blocks.length === 1 && t.text ? t.text : blocks });
    }
    try {
      // THE BELT BEFORE THE BRIEF: connecting the lent servers is what tells us
      // whether this run has the local tools and the gateway's lookup pair, and
      // the system prompt says so. Built the other way round it always said
      // "no tools" (caught by the MCP test). Cached, so rounds() re-uses it.
      await this.toolset(c);
      const system: TextParam[] = [{ type: "text", text: systemPrompt(c.workdir, GlyphhLoop.promptExtras(c, this.deps.host)), cache_control: { type: "ephemeral" } }];
      // The host's standing text: a second cached block, the same every turn.
      const standing = this.deps.standing ? await this.deps.standing(scope).catch(() => "") : "";
      if (standing.trim()) system.push({ type: "text", text: standing, cache_control: { type: "ephemeral" } });
      const answer = await this.rounds(c, wire, system, signal);
      // The turn is over and it was not aborted: hand the exchange to memory.
      // A stopped turn is not remembered — it is half a thought.
      if (this.deps.capture && t.text && !signal.aborted) {
        try { this.deps.capture(t.text, answer, scope); } catch { /* memory never fails a turn */ }
      }
      this.send(c, { type: "done", stopped: signal.aborted });
    } catch (err) {
      const said = err instanceof Error ? err.message : String(err);
      if (!signal.aborted) this.send(c, { type: "error", error: said });
      // A failure is not a stop: only an abort says stopped. Reporting every
      // error as stopped made hosts that miss the error frame paint the
      // "you stopped it" line over a turn that broke.
      this.send(c, { type: "done", stopped: signal.aborted });
    } finally {
      c.running = false;
      c.abort = null;
      for (const resolve of c.approvals.values()) resolve(false);
      c.approvals.clear();
    }
    // What was typed while this turn ran now goes out as one follow-up turn —
    // unless the user stopped the run, which cancels what was waiting too.
    const waiting = c.queued.splice(0, c.queued.length);
    if (waiting.length && !signal.aborted) {
      const images = waiting.flatMap((q) => q.images ?? []);
      void this.run({
        chatId: t.chatId, text: waiting.map((q) => q.text).filter(Boolean).join("\n\n"), model,
        ...(images.length ? { images } : {}),
        ...(t.workspace ? { workspace: t.workspace } : {}),
      }, emit);
    }
    return { runId: c.runId };
  }

  stop(chatId: string): boolean {
    const c = this.chats.get(chatId);
    if (!c || !c.running) return false;
    c.abort?.abort();
    return true;
  }

  /** What this chat has spent, for the host's context meter. */
  usage(chatId: string): { inTokens: number; outTokens: number; cacheRead: number } {
    return this.chats.get(chatId)?.usage ?? { inTokens: 0, outTokens: 0, cacheRead: 0 };
  }

  /** The tool names a chat's toolset carries — empty before its first turn
   *  (the servers are lent on the first run). */
  toolNames(chatId: string): string[] {
    return this.chats.get(chatId)?.tools?.map((t) => t.name) ?? [];
  }

  /** Compact NOW (a host's /compact): the model summarizes the conversation so
   *  far and the chat continues from the summary. Idle chats only. */
  async compactNow(chatId: string, emit?: LoopEmit): Promise<{ ok: boolean; error?: string }> {
    const c = this.chats.get(chatId);
    if (!c || !c.model || c.messages.length < 2) return { ok: false, error: "nothing to compact yet — run a turn first" };
    if (c.running) return { ok: false, error: BUSY_MESSAGE };
    const creds = await this.deps.gateway().catch(() => null);
    if (!creds) return { ok: false, error: GATEWAY_OFF_MESSAGE };
    if (emit) c.emit = emit;
    c.runId = `${chatId}:compact:${Date.now()}`;
    c.running = true;
    try {
      await this.compact(c, { baseUrl: creds.baseUrl, token: creds.token }, new AbortController().signal);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      c.running = false;
    }
  }

  setPermission(chatId: string, permission: LoopPermission): boolean {
    const c = this.chats.get(chatId);
    if (!c) return false;
    c.permission = permission;
    this.send(c, { type: "permission", permission });
    return true;
  }

  respondApproval(id: string, allow: boolean): boolean {
    const chatId = id.split(":")[0] ?? "";
    const c = this.chats.get(chatId);
    const resolve = c?.approvals.get(id);
    if (!c || !resolve) return false;
    c.approvals.delete(id);
    resolve(allow);
    return true;
  }

  /** Drop one chat (its MCP sessions closed). */
  /**
   * THE HOST'S TOOLS CHANGED — a new agent to spawn, an agent removed. A chat's
   * belt is built once and kept (it is the cache prefix), so without this a
   * member who made an agent mid-conversation could not hand it work until
   * the app restarted. Every chat rebuilds its belt at the start of its next
   * turn; the conversation itself is untouched.
   */
  invalidateTools(): void {
    for (const c of this.chats.values()) c.toolsStale = true;
  }

  forget(chatId: string): void {
    const c = this.chats.get(chatId);
    if (!c) return;
    c.abort?.abort();
    for (const cl of c.clients) void cl.close();
    this.chats.delete(chatId);
  }

  /** Sign-out: nothing of the last member's conversations stays in memory. */
  forgetAll(): void {
    for (const id of [...this.chats.keys()]) this.forget(id);
  }
}
