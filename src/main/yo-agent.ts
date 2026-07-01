/**
 * YoAgent — Claude Agent SDK powered orchestrator.
 *
 * Uses sdk.query() with in-process MCP tools via createSdkMcpServer.
 * All substrate tools (search, skills, navigation, layout, etc.) are
 * registered as MCP tools. The SDK handles the agent loop, tool calling,
 * and streaming.
 */

import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { z } from "zod/v4";
import { getShellPath } from "./shell-path";
import { asarSafeQueryOptions, proxyAnthropicEnv } from "./sdk-llm";
import { ensureFreshToken, forceTokenRefresh } from "./auth";
import { getConnectorCatalog } from "./connector-tools-client";
import { getWorkingDirectory, setWorkingDirectory } from "./working-directory";

/** Working directory the right-rail .Yo agent runs in. Follows the user's
 *  workdir pick (set via the workdir bar above the input), shared with
 *  Workbench / file watchers / etc. Falls back to ~/yo only when no
 *  folder has ever been picked. */
function rightRailCwd(): string {
  const picked = getWorkingDirectory();
  if (picked) {
    try { fs.mkdirSync(picked, { recursive: true }); } catch { /* ignore */ }
    return picked;
  }
  const dir = path.join(os.homedir(), "yo");
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}
import { promptLog } from "./prompt-log";
import { guardPrompt } from "./firewall";
import { execSync } from "child_process";
import { LLMConfig } from "./llm-config";

import { getAgentToolSpec, executeTool } from "./substrate/tools";
import { usageTracker } from "./usage-tracker";
import { usageQueue } from "./usage-queue";
import type { MemoryStore } from "./memory-store";
import type { CaptureStore } from "./capture-store";
import type { SessionCache } from "./session-cache";
import type { SkillEngine } from "./skill-engine";
import type { NoteStore } from "./note-store";
import { getAgentMode, gate } from "./action-gate";
import type { AgentMode } from "./action-gate";
import { getPreference } from "./preferences";
// Compaction prefs read from the SQLite store — the same one the renderer's
// window.yo.setPreference writes to (main's get/set-preference IPC → preferences-db).
// The file-based getPreference above is a separate store, so reading these from
// it would never see what the user saved in Settings.
import { getPreference as getDbPreference } from "./stores/preferences-db";
import { getKey as getProviderKey } from "./provider-keys";

const dynamicImport = new Function("specifier", "return import(specifier)") as
  (specifier: string) => Promise<any>;

export type ApprovalCallback = (toolName: string, input: Record<string, unknown>) => Promise<boolean>;

export type AskQuestionOption = { label: string; description?: string };
export type AskQuestion = { question: string; header?: string; options: AskQuestionOption[]; multiSelect?: boolean };
export type AskCallback = (questions: AskQuestion[]) => Promise<Array<string | null>>;
export type PreviewCallback = (url: string) => Promise<boolean>;

export interface YoAgentCallbacks {
  onText: (delta: string) => void;
  onToolUse: (id: string, name: string, input: unknown) => void;
  onToolResult?: (id: string, detail: string) => void;
  onToolProgress?: (id: string, status: string) => void;
  /** Fires for every sub-agent lifecycle event the loop emits — Task tool
   *  spawns + their results, and (later) our saved-agent wrappers. The
   *  Workbench Sub-Agents view subscribes via the subagent:event IPC. */
  onSubAgent?: (evt: {
    id: string;
    /** Structured lifecycle so the Sub-Agents panel can drive the SAME
     *  ChatRenderer the main yo panel uses (collapsible tool wrappers, braille
     *  spinner, markdown text). `token` is kept as an alias for `text` for the
     *  swarm/bus path that streams pre-flattened fragments. */
    kind: "spawn" | "text" | "token" | "tool" | "tool_result" | "result" | "error";
    source: "task" | "yo-agent";
    name?: string;
    description?: string;
    text?: string;
    toolId?: string;
    toolName?: string;
    toolInput?: unknown;
    toolOutput?: string;
  }) => void;
  onDone: (fullText: string) => void;
  onError: (error: string) => void;
  /** Current conversation context size vs the compaction window, after each
   *  turn — drives the compaction gauge in the composer. `windowTokens` is the
   *  budget the context may grow to before the SDK auto-compacts. */
  onContextUsage?: (usedTokens: number, windowTokens: number) => void;
}

const SYSTEM_PROMPT = `You are yo — a fast, concise assistant backed by a capture store and connected tools.

RULES:
- NEVER narrate. No "Let me...", "I'll start by...", "I found...", "Here's what I can do...". Just act and respond.
- Call tools immediately. Zero preamble.
- RECALL = SEARCH THE STORE FIRST. The capture store (vector DB) holds everything the user has captured — their history, notes, prior work, conversations, decisions. For ANY question about the user's past or what you know — "history", "what did I", "find / remember / look up", "what do you know about X", "my <anything>" — your FIRST action is ALWAYS search_captures (then search_notes for exact terms). Lead with what the store returns. Only reach for shell, files, panels, or .yo/inbox if the store genuinely has nothing relevant, and say so. Never substitute a shell/file lookup for the store on a recall question.
- Responses: 1-3 sentences max unless the user asks for detail. Return actual content, not descriptions of it.
- No bullet-point alternatives. No follow-up questions unless truly stuck with zero options.
- If a tool fails or doesn't exist, say so in one sentence and stop.
- Plain text only. No markdown formatting — no headers, no bold, no bullets, no italic. Just plain sentences. Only exception: use code fences (\`\`\`) when returning actual code. Bare URLs are fine — they will be auto-linked.
- search_captures uses vector search — descriptive phrases, not keywords.
- search_notes uses keyword search — specific terms.
- web_search + web_read for live web content. Search first, then read specific URLs.
- scan_panel FIRST for element discovery. Use click_element/type_text with those selectors.
- grab_panel is EXPENSIVE (~10K tokens). Only when you need full page text.
- For workspace arrangement use split_view, grid_layout, switch_panel.
- For the user's connected apps (Gmail, Slack, Calendar, …), follow the "Connected apps" section below — it tells you whether their tools are already loaded or must be fetched with find_tools. For other specialized actions (skills, data stores, layouts, drips, workspace coordination), call find_tools to find the right tool, then call_tool to run it.
- For multi-choice questions to the user, use mcp__glyphh__ask_user_question (the built-in AskUserQuestion is unavailable). It renders a proper "Input required" card with side-by-side code/markdown previews. Provide 2–4 distinct options with short labels and one-line descriptions; mark one Recommended if you have a default. Add a "preview" markdown field when the choice is between layouts, code snippets, or mockups.
- When the user asks you to "build me an X" or "make a tool that does Y" and a single-page web app fits, use create_app — it scaffolds a static HTML bundle under ~/yo/apps/<id>/, registers it in the Apps list, and the file watcher makes it appear without restart. Then open it with open_app to show the user. For follow-up edits use write_app_file. Prefer vanilla HTML/CSS/JS or React-via-CDN; no build step.
- Delegate via spawn_background, call_agent, or create_swarm — they run detached and stream into the Sub-Agents panel. If you need a sub-agent's result within THIS turn to continue, call request_dev_tools first to load the foreground Task tool.`;

// Appended to the LIGHT-mode system prompt only. Teaches the agent that the
// heavy developer toolset is loaded on demand: it must call request_dev_tools
// before touching files/shell/code, and must NOT escalate for things its light
// tools already cover. This is what makes the lazy preset work — a fresh
// conversation pays the small light prompt unless real dev work is needed.
const LIGHT_ESCALATION_GUIDANCE = `# Loading developer tools on demand

Your current toolset is fast and lightweight: the capture store, panels/apps, skills, data stores, and web search. You do NOT currently have file-editing, shell, or code tools loaded.

The MOMENT a request needs to read or edit files on disk, run shell/terminal commands, inspect or modify a codebase, or build/run software, call request_dev_tools FIRST — before replying or taking any other action. The turn restarts with the full developer toolset (Read, Edit, Write, Bash, Grep, Glob, …) available and you continue seamlessly. Do not apologize or announce that you're switching — just call it and proceed.

Do NOT call request_dev_tools for work your light tools already handle: answering from the capture store, opening/arranging panels, building a single-page app via create_app, running a web search, or managing skills/stores. Only escalate when you genuinely need the filesystem, the shell, or a codebase.`;

// Appended to BOTH modes. Only a focused CORE of tools is loaded in-context;
// the long tail (connected apps, skill authoring, layout/store/drip management,
// workspace coordination, and other specialized actions) is discovered on
// demand. Without this the model wouldn't know those capabilities are reachable.
const TOOL_DISCOVERY_GUIDANCE = `# Your tools

A focused core toolset is loaded (capture store, panels, apps, web search/read, delegation, light file reads) — call those directly, no lookup.

A large set of tools is NOT loaded (to keep messages small): skill authoring, layout/store/drip management, workspace coordination, and other specialized actions. For ANY of those:
1. find_tools(query) — search by keywords (e.g. 'save layout', 'create skill', 'post to workspace'). It returns matching tool names + input fields.
2. call_tool(name, input) — run the one you found.

The user's connected apps (Gmail, Calendar, …) are handled separately — see the "Connected apps" section, which says whether their tools are already loaded or must be fetched with find_tools.`;

// Above this many connected-app (MCP) tool schemas, loading them all in-context
// would bloat every prompt, so we fall back to find_tools discovery. At or below
// it (the common case), connectors load directly — far more reliable, and cheap
// now that the static prefix is cached. ~400 tok/tool, so ~100 ≈ 40K cached.
const CONNECTOR_INLINE_MAX = 100;

/** True when the connector catalog is small enough to load directly in-context. */
function connectorsInline(): boolean {
  const n = getConnectorCatalog().length;
  return n > 0 && n <= CONNECTOR_INLINE_MAX;
}

// Dynamic awareness of the user's connected apps for the system prompt (app slug
// + tool count). Phrasing depends on whether the connectors are loaded directly
// (inline) or must be fetched via find_tools (discovery, for huge catalogs).
function connectedAppsBlock(inline: boolean): string {
  const catalog = getConnectorCatalog();
  if (!catalog.length) return "";
  const bySlug = new Map<string, number>();
  for (const t of catalog) bySlug.set(t.slug, (bySlug.get(t.slug) || 0) + 1);
  const entries = [...bySlug.entries()].sort((a, b) => b[1] - a[1]);
  const CAP = 60;
  const shown = entries.slice(0, CAP).map(([s, n]) => `${s} (${n})`).join(", ");
  const more = entries.length > CAP ? `, +${entries.length - CAP} more` : "";
  const how = inline
    ? "Their tools ARE loaded — call them directly (e.g. a gmail_* / google_calendar_* tool); do NOT use find_tools for these."
    : 'Their tools are NOT preloaded — call find_tools with the app + action (e.g. "gmail send email"), then run the result with call_tool.';
  return `# Connected apps\nThe user has these apps connected (tool counts in parentheses). ${how}\n${shown}${more}`;
}

// Trim a tool's free-text description for the in-context prefix — external
// connector descriptions are often paragraphs. Keep the gist (~220 chars,
// snapped to a sentence boundary when possible).
function leanToolDescription(desc: string | undefined): string {
  if (!desc) return "";
  const d = String(desc).replace(/\s+/g, " ").trim();
  if (d.length <= 220) return d;
  const cut = d.slice(0, 220);
  const stop = cut.lastIndexOf(". ");
  return (stop > 120 ? cut.slice(0, stop + 1) : cut).trim() + "…";
}

// Strip the bloat from a tool's JSON Schema before it's loaded: keep type,
// properties, required, enum (capped), items, format + a SHORT per-field
// description; drop examples/default/title/$schema/additionalProperties and
// over-long enums. The agent still gets every param name/type it needs to call
// the tool correctly — just far fewer tokens. Bounded recursion.
function leanJsonSchema(schema: any, depth = 0): any {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map((s) => leanJsonSchema(s, depth + 1));
  if (depth > 5) return { type: schema.type || "string" };
  const out: any = {};
  if (schema.type) out.type = schema.type;
  if (schema.format) out.format = schema.format;
  if (schema.description) out.description = String(schema.description).replace(/\s+/g, " ").slice(0, 100);
  if (Array.isArray(schema.enum)) out.enum = schema.enum.slice(0, 30);
  if (schema.items) out.items = leanJsonSchema(schema.items, depth + 1);
  if (schema.properties && typeof schema.properties === "object") {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) out.properties[k] = leanJsonSchema(v, depth + 1);
  }
  if (Array.isArray(schema.required)) out.required = schema.required;
  if (Array.isArray(schema.anyOf)) out.anyOf = schema.anyOf.map((s: any) => leanJsonSchema(s, depth + 1));
  if (Array.isArray(schema.oneOf)) out.oneOf = schema.oneOf.map((s: any) => leanJsonSchema(s, depth + 1));
  return out;
}

const CHATS_DIR = path.join(os.homedir(), "yo", "chats");

// Fallback compaction budget (tokens) for the gauge when the user hasn't set an
// explicit autoCompactWindow — approximates where the SDK auto-compacts a
// 200K-context model with headroom reserved for the reply.
const DEFAULT_COMPACT_WINDOW = 160_000;
// The Claude Code CLI validates autoCompactWindow against `min(100_000).max(
// 1_000_000)` with `.catch(undefined)` — so ANY value outside [100K, 1M] is
// silently discarded and the CLI falls back to the model's full window. (That's
// why an 8K setting did nothing: it was rejected, not honored.) Clamp to the
// CLI's real range so what the user sets is actually applied. Mirrors the
// Settings → Agent input guard; also corrects an already-stored out-of-range
// value at runtime.
const MIN_COMPACT_WINDOW = 100_000;
const MAX_COMPACT_WINDOW = 1_000_000;
function resolveCompactWindow(): number {
  const win = getDbPreference<number>("autoCompactWindow", 0);
  if (win <= 0) return DEFAULT_COMPACT_WINDOW;
  return Math.min(Math.max(win, MIN_COMPACT_WINDOW), MAX_COMPACT_WINDOW);
}

// Reasoning effort — the composer slider (Faster · Balanced · Smarter ·
// Ultracode) stores 0-3 in the "effortLevel" preference, mapped to the SDK's
// EffortLevel. Ultracode → "max" (the SDK falls back per-model where a level
// isn't supported). Default Balanced.
const EFFORT_BY_LEVEL = ["low", "medium", "high", "max"] as const;
function resolveEffort(): (typeof EFFORT_BY_LEVEL)[number] {
  const lvl = getDbPreference<number>("effortLevel", 1);
  return EFFORT_BY_LEVEL[Math.max(0, Math.min(3, Math.round(Number(lvl) || 0)))];
}

// Appended to every yo-agent turn. Teaches the model that delegation has two
// modes — in-turn (blocking) vs detached (non-blocking) — and when to pick
// each. Without this the model defaults to the in-turn Task tool for
// everything, so the user is blocked even on long, independent work.
const DELEGATION_GUIDANCE = `# Delegating to sub-agents — foreground vs background

You can delegate work two ways. Choose deliberately:

FOREGROUND (in-turn) — the \`Task\` tool.
- Runs the sub-agent INSIDE your current turn; you are blocked until it returns.
- Its result comes straight back to you as the tool result, so you can reason over it and keep going in the same turn.
- Use when you NEED the output to continue (research you must synthesize, a sub-task whose answer shapes your next step) AND it's short enough that the user waiting is fine.

BACKGROUND (detached) — \`spawn_background\` (one ephemeral agent), \`call_agent\` (one of the user's saved agents), or \`create_swarm\` (a team).
- Launches the agent(s) and returns IMMEDIATELY with a "started" acknowledgement; your turn finishes right away so the user can keep chatting.
- Their live activity streams into the Workbench Sub-Agents panel. When a background agent finishes, its result is delivered back to you as a new message so you can follow up.
- Use when the work is long-running or independent, when the user shouldn't be blocked, or when you can keep helping with other things while it runs.

Default to BACKGROUND for anything that will take a while or that the user doesn't need answered before they continue. Use FOREGROUND only when the sub-agent's output is required to finish the very response you're writing. Do not block the user on long delegations.`;

export interface ChatSummary {
  id: string;
  title: string;
  created: string;
  messageCount: number;
  /** "run" for persisted scheduled/manual task runs; undefined for normal chats. */
  type?: string;
  /** Owning skill name (run chats only). */
  skillName?: string;
}

/** A persisted task run, surfaced in the Activity view + schedule detail. */
export interface RunSummary {
  id: string;
  skillName: string;
  title: string;
  created: string;
  trigger: string;
  ok: boolean;
}

/** A persisted chat message. Assistant turns may carry the ordered
 *  tool calls that ran during them so reloaded history is complete. */
export interface ChatMessage {
  role: string;
  content: string;
  tools?: Array<{ name: string; input?: unknown }>;
}

/** Pick a short, human-readable descriptor from a tool's input so the
 *  Sub-Agents transcript can show "Read src/foo.ts" rather than raw JSON.
 *  Falls back to the first stringy field, then empty. */
function briefToolArg(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const key of ["file_path", "path", "command", "pattern", "query", "url", "description", "prompt"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) {
      const s = v.trim().replace(/\s+/g, " ");
      return s.length > 80 ? `${s.slice(0, 80)}…` : s;
    }
  }
  return "";
}

export class YoAgent {
  private chatId: string | null = null;
  private chatTitle: string = "";
  // Swarm activity is appended to the active chat record so the thread
  // restores in full. Batched + debounced — a swarm emits many events.
  private _pendingSwarm: Array<{ role: string; content: string }> = [];
  private _swarmFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private llmConfig: LLMConfig | null = null;
  private memoryStore: MemoryStore | null = null;
  private captureStore: CaptureStore | null = null;
  private sessionCache: SessionCache | null = null;
  private skillEngine: SkillEngine | null = null;
  private noteStore: NoteStore | null = null;
  private abortController: AbortController | null = null;
  private _mode: AgentMode = getAgentMode();
  private _planDelivered = false;
  // Lazy preset: the right-rail agent runs LIGHT by default (no claude_code
  // preset — keeps its cached system prompt small, ~tens of credits cheaper per
  // fresh conversation). It calls request_dev_tools to pull in the full
  // developer toolset; _devMode then stays on for the rest of the conversation
  // (the preset is already cached → cheap cache-reads, no point reverting).
  // _escalatePending is the in-flight signal set by that tool's handler.
  private _devMode = false;
  private _escalatePending = false;
  private _approvalCallback: ApprovalCallback | null = null;
  private _onModeChange: ((mode: AgentMode) => void) | null = null;
  private sessionId: string | null = null;
  private sdk: any = null;
  private mcpServer: any = null;

  // ── Setters ──────────────────────────────────────────────

  setLLMConfig(config: LLMConfig): void { this.llmConfig = config; }
  setMemoryStore(store: MemoryStore): void { this.memoryStore = store; }
  setCaptureStore(store: CaptureStore): void { this.captureStore = store; }
  private workspaceGetter: (() => string) | null = null;
  setWorkspaceGetter(fn: () => string): void { this.workspaceGetter = fn; }
  setSessionCache(cache: SessionCache): void { this.sessionCache = cache; }
  setSkillEngine(engine: SkillEngine): void { this.skillEngine = engine; }
  setNoteStore(store: NoteStore): void { this.noteStore = store; }
  private appsProvider: (() => Array<{ id: string; name: string }>) | null = null;
  /** Lets the agent know which apps the user has configured (for open_app). */
  setAppsProvider(fn: () => Array<{ id: string; name: string }>): void { this.appsProvider = fn; }
  getMode(): AgentMode { return this._mode; }
  setMode(mode: AgentMode): void {
    const changed = this._mode !== mode;
    this._mode = mode;
    if (changed) this.sessionId = null;
  }
  setApprovalCallback(cb: ApprovalCallback | null): void { this._approvalCallback = cb; }
  /** Hook fired for every tool_use block the agent emits. Used by main to
   *  side-effect on specific tools (e.g. drop out of plan mode the moment
   *  ExitPlanMode is called, so the gate releases in lockstep with the SDK). */
  private _toolUseSeen: ((toolName: string, input: unknown) => void) | null = null;
  onToolUseSeen(cb: (toolName: string, input: unknown) => void): void { this._toolUseSeen = cb; }
  private _askCallback: AskCallback | null = null;
  setAskCallback(cb: AskCallback | null): void { this._askCallback = cb; }
  private _previewCallback: PreviewCallback | null = null;
  setPreviewCallback(cb: PreviewCallback | null): void { this._previewCallback = cb; }
  onModeChange(cb: (mode: AgentMode) => void): void { this._onModeChange = cb; }

  abort(): void {
    // A user Stop must cancel any in-flight escalation. request_dev_tools aborts
    // the controller directly (not via this method), so clearing the flag here
    // distinguishes "user stopped" from "agent asked for dev tools": the former
    // takes the clean-stop path, the latter re-runs with the full preset.
    this._escalatePending = false;
    this.abortController?.abort();
  }

  // ── SDK initialization ─────────────────────────────────

  private async ensureSDK(): Promise<any> {
    if (!this.sdk) {
      this.sdk = await dynamicImport("@anthropic-ai/claude-agent-sdk");
    }
    return this.sdk;
  }

  private async ensureMcpServer(): Promise<any> {
    const sdk = await this.ensureSDK();
    const tools = this.buildSdkMcpTools(sdk);
    this.mcpServer = sdk.createSdkMcpServer({
      name: "glyphh",
      version: "1.0.0",
      tools,
      alwaysLoad: true,
    });
    return this.mcpServer;
  }

  private buildSdkMcpTools(_sdk: any): any[] {
    // Core substrate kit, PLUS the connected-app (MCP) catalog when it's small
    // enough to be affordable in-context (connectorsInline()). Loading them
    // directly is far more reliable than find_tools discovery; only app-heavy
    // accounts (>CONNECTOR_INLINE_MAX tools) fall back to discovery. Either way
    // we LEAN every tool's description + schema so the in-context prefix stays
    // small (external connector schemas are especially verbose).
    const toolSpecs = getAgentToolSpec(undefined, connectorsInline(), true);
    const substrateTools = toolSpecs.map((spec) => ({
      name: spec.name,
      description: leanToolDescription(spec.description),
      inputSchema: this.jsonSchemaToZod(leanJsonSchema(spec.input_schema)),
      handler: async (args: Record<string, unknown>) => {
        try {
          const result = await executeTool(spec.name, args);
          return { content: [{ type: "text" as const, text: result }] };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      },
    }));

    // Custom ask tool — mirrors Claude Code's built-in AskUserQuestion shape
    // but routes through our own renderer card (purple "Input required"). The
    // handler blocks until the user picks; the returned content goes straight
    // back into the model's next turn as the tool result.
    const askTool = {
      name: "ask_user_question",
      description: "Ask the user a multiple-choice question and wait for their answer. Use this when you need a decision from the user that's better picked from a short list than typed out. Prefer it over plain text questions when there are clear, distinct options. The user sees a purple 'Input required' card with the question and choices; their answer comes back as the tool result.",
      inputSchema: {
        questions: z.array(z.object({
          question: z.string().describe("The full question text shown to the user."),
          header: z.string().optional().describe("Optional short tag/chip shown above the question."),
          options: z.array(z.object({
            label: z.string().describe("Short label shown on the option row."),
            description: z.string().optional().describe("Subtitle explaining the option."),
            recommended: z.boolean().optional().describe("Mark one option as the recommended default. Pre-selected on render so the user can just Submit."),
            preview: z.string().optional().describe("Optional markdown preview shown side-by-side with the option list — use for code snippets, mockups, or layout comparisons that help the user choose."),
          })).min(2).max(6),
          multiSelect: z.boolean().optional().describe("Allow multiple selections (default false)."),
        })).min(1),
      },
      handler: async (args: Record<string, unknown>) => {
        const questions = (args.questions as AskQuestion[]) || [];
        if (!this._askCallback) {
          return { content: [{ type: "text" as const, text: "ask_user_question is not wired in this surface." }] };
        }
        const answers = await this._askCallback(questions);
        // Mirror the AskUserQuestion built-in's result shape — a JSON object
        // keyed by question text, value = the chosen option label (or null).
        const result: Record<string, string | null> = {};
        questions.forEach((q, i) => { result[q.question] = answers[i] ?? null; });
        return { content: [{ type: "text" as const, text: JSON.stringify({ answers: result }, null, 2) }] };
      },
    };

    // preview_url — show a URL in the Workbench Preview slot. Same routing
    // pattern as plan: agent calls the tool; host attaches a BrowserView at
    // the active Preview slot's bounds.
    const previewTool = {
      name: "preview_url",
      description: "Show a URL in the user's Workbench Preview panel (e.g. a local dev server, a docs page, the app you just built). Use this instead of opening a new browser panel — the URL appears inline alongside the user's code, not floating over the workspace. If no Preview panel is open, the user sees a hint to add one.",
      inputSchema: {
        url: z.string().describe("HTTP/HTTPS/file URL to load in the preview."),
      },
      handler: async (args: Record<string, unknown>) => {
        const url = String(args.url ?? "").trim();
        if (!url) return { content: [{ type: "text" as const, text: "Error: url is required" }], isError: true };
        if (!this._previewCallback) {
          return { content: [{ type: "text" as const, text: "Preview is not wired in this surface." }] };
        }
        const ok = await this._previewCallback(url);
        return { content: [{ type: "text" as const, text: ok ? `Preview set to ${url}` : `No Workbench Preview panel is open. Tell the user to add one (Workbench app → split → Preview view).` }] };
      },
    };

    // request_dev_tools — the lazy-preset escalation hatch. The LIGHT agent
    // ships without the claude_code preset (to keep its cached prompt small);
    // when it needs real dev tools it calls this. The handler flips dev mode and
    // aborts the current turn — the run loop catches that and re-runs the turn
    // with the full preset (Read/Edit/Bash/…), history intact via context
    // recovery. In DEV mode this tool is hidden (disallowedTools), so it can't
    // loop. (Returns a benign result in case the turn isn't aborted in time.)
    const devToolsTool = {
      name: "request_dev_tools",
      description: "Load the full developer toolset — read/edit/write files, run shell commands, search code (Read, Edit, Write, Bash, Grep, Glob, …). Call this FIRST, before replying, the moment a task needs to touch the filesystem, the shell, or a codebase. The turn restarts with those tools available and you continue seamlessly; you don't need to repeat anything.",
      inputSchema: {
        reason: z.string().optional().describe("Briefly, what you need the developer tools for."),
      },
      handler: async (_args: Record<string, unknown>) => {
        this._escalatePending = true;
        this.abortController?.abort();
        return { content: [{ type: "text" as const, text: "Loading developer tools — continuing." }] };
      },
    };

    return [...substrateTools, askTool, previewTool, devToolsTool];
  }

  private jsonSchemaToZod(schema: Record<string, unknown>): Record<string, any> {
    const props = (schema.properties || {}) as Record<string, any>;
    const required = new Set((schema.required || []) as string[]);
    const shape: Record<string, any> = {};

    for (const [key, prop] of Object.entries(props)) {
      let field: any;
      switch (prop.type) {
        case "string":
          field = z.string();
          if (prop.enum) field = z.enum(prop.enum);
          break;
        case "number":
          field = z.number();
          break;
        case "boolean":
          field = z.boolean();
          break;
        case "array":
          field = z.array(z.any());
          break;
        case "object":
          field = z.record(z.string(), z.any());
          break;
        default:
          field = z.any();
      }
      if (!required.has(key)) {
        field = field.optional();
      }
      shape[key] = field;
    }

    return shape;
  }

  // ── Send (public API) ──────────────────────────────────

  /**
   * Run a prompt headlessly through the full agent (tools + MCP, multi-turn)
   * and return the final text. Used by scheduled / manual task runs so a task
   * like "read my email and summarize" actually has tools — unlike the skill
   * engine's plain single-turn completion. Does NOT touch the active chat
   * (chatId/sessionId/title) so the user's live conversation is untouched.
   */
  async runForResult(prompt: string, chatId?: string): Promise<{ text: string; error?: string }> {
    let sdk: any;
    try { sdk = await this.ensureSDK(); }
    catch (err: any) { return { text: "", error: `Failed to load agent SDK: ${err?.message || err}` }; }

    let mcpServer: any;
    try { mcpServer = await this.ensureMcpServer(); }
    catch (err: any) { return { text: "", error: `Failed to initialize MCP tools: ${err?.message || err}` }; }

    const shellPath = getShellPath();
    const model = this.llmConfig?.model || "claude-haiku-4-5-20251001";

    const options: Record<string, any> = {
      model,
      maxTurns: getPreference<number>("maxTurns", 200),
      effort: resolveEffort(),
      // Isolate from filesystem settings — blocks CLAUDE.md AND any file-based
      // MCP (e.g. the user's claude.ai connectors) so ONLY our Glyphh connectors
      // are available; otherwise the agent grabs a competing, broken connector.
      settingSources: [],
      ...asarSafeQueryOptions(rightRailCwd()),
      // Headless: no UI to approve tool calls, so bypass permissions.
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      // Built-in Claude Code tools (Read/Edit/Bash/Grep/…) plus our MCP tools.
      tools: { type: "preset", preset: "claude_code" },
      mcpServers: { "yo": mcpServer },
      // This headless helper always carries the full preset, so pair it with the
      // full (dev) system prompt.
      systemPrompt: this.buildSystemPrompt(true),
      includePartialMessages: true,
      // Route through the credit proxy (same as send()) so scheduled/manual task
      // runs are metered — and attribute their credits to the run id when given.
      env: (() => {
        const base: Record<string, string | undefined> = {
          ...process.env,
          PATH: shellPath,
          CLAUDE_AGENT_SDK_CLIENT_APP: "yosup/3.0.0",
        };
        const proxy = proxyAnthropicEnv();
        if (proxy.ANTHROPIC_BASE_URL) {
          Object.assign(base, proxy);
          delete base.ANTHROPIC_API_KEY;
          if (chatId) base.ANTHROPIC_CUSTOM_HEADERS = `x-glyphh-chat-id: ${chatId}`;
        } else {
          const byok = (() => { try { return getProviderKey("anthropic"); } catch { return null; } })();
          if (byok) base.ANTHROPIC_API_KEY = byok;
        }
        return base;
      })(),
    };

    let text = "";
    try {
      const gen = sdk.query({ prompt, options });
      for await (const msg of gen) {
        if (msg.type === "stream_event") {
          const event = msg.event;
          if (event?.type === "content_block_delta") {
            const delta = (event as any).delta;
            if (delta?.type === "text_delta" && delta.text) text += delta.text;
          }
        } else if (msg.type === "result") {
          if (msg.usage) this.reportUsage(msg.usage.input_tokens || 0, msg.usage.output_tokens || 0, model);
          if (msg.is_error && msg.result) return { text, error: msg.result };
        }
      }
    } catch (err: any) {
      return { text, error: err?.message || String(err) };
    }

    return { text: text.trim() };
  }

  async send(message: string, cb: YoAgentCallbacks, isRetry = false): Promise<void> {
    // Credits are enforced server-side by the proxy (402 when the org is out).
    // We surface that as a soft "out of credits → Manage plan" notice from the
    // error path below, rather than guessing from a stale local balance.

    // Prompt-injection firewall.
    const guard = guardPrompt(message, "yo-agent");
    if (!guard.allowed) {
      cb.onError(`Message blocked by prompt-injection firewall: ${guard.reason}`);
      return;
    }

    // Plan mode auto-exit: if agent already delivered a plan (previous turn
    // set planDelivered), the user's next message is implicit approval.
    if (this._mode === "plan" && this._planDelivered) {
      this._mode = "default";
      this._planDelivered = false;
      this._onModeChange?.("default");
    }

    if (!this.chatTitle) {
      this.chatTitle = message.slice(0, 80).replace(/\n/g, " ").trim();
    }
    if (!this.chatId) {
      this.chatId = `${Date.now()}`;
    }

    // Pre-flight: the Glyphh agent runs through the platform proxy, so all we
    // need is a logged-in session (no Anthropic key). ensureCcAuth() returns
    // true when signed in; only if signed out does it surface the legacy modal.
    {
      const { ensureCcAuth } = await import("./cc-bootstrap");
      if (!ensureCcAuth()) return;
      // Top up the session token before the turn. The SDK subprocess freezes
      // whatever token is in its env at spawn, so a turn that starts on a
      // near-expired token (idle/backgrounded → throttled refresh timer) would
      // 401 at the proxy. Proactively refresh so the turn begins with full life.
      await ensureFreshToken();
    }

    let sdk: any;
    try {
      sdk = await this.ensureSDK();
    } catch (err: any) {
      cb.onError(`Failed to load .Yo agent SDK: ${err.message}`);
      return;
    }

    let mcpServer: any;
    try {
      mcpServer = await this.ensureMcpServer();
    } catch (err: any) {
      cb.onError(`Failed to initialize MCP tools: ${err.message}`);
      return;
    }

    this.abortController = new AbortController();
    const shellPath = getShellPath();

    const model = this.llmConfig?.model || "claude-haiku-4-5-20251001";
    const isBypass = this._mode === "bypassPermissions";
    // Captures a hard CC process crash so a turn that dies without throwing
    // (stream just ends) still surfaces an error instead of a silent no-op.
    // SIGTERM/SIGINT are how abort() stops the process, so those are ignored.
    let processExit: { code: number | null; signal: string | null; stderr: string } | null = null;
    const options: Record<string, any> = {
      model,
      maxTurns: getPreference<number>("maxTurns", 200),
      effort: resolveEffort(),
      // Isolate from filesystem settings — blocks CLAUDE.md AND file-based MCP
      // (e.g. the user's claude.ai connectors) so ONLY our Glyphh connectors are
      // loaded; otherwise the agent grabs a competing, broken connector.
      settingSources: [],
      // The right-rail .Yo agent always runs at ~/yo/ — it spans every
      // folder the user touches and does not follow per-app folder picks.
      ...asarSafeQueryOptions(rightRailCwd(), (info) => {
        const aborted = info.signal === "SIGTERM" || info.signal === "SIGINT" || info.code === 143 || info.code === 130;
        if (!aborted && info.code && info.code !== 0) processExit = info;
      }),
      permissionMode: isBypass ? "bypassPermissions" : this._mode,
      allowDangerouslySkipPermissions: isBypass,
      ...(isBypass ? {} : {
        canUseTool: async (toolName: string, input: Record<string, unknown>) => {
          // Generic invokers (call_tool / mcp_tool_call) run a tool BY NAME.
          // Gate on the INNER tool so a destructive one still prompts with its
          // real name instead of an opaque "call_tool" approval card. Unwrap
          // ITERATIVELY so a nested invoker (call_tool → mcp_tool_call → X)
          // can't launder X past the gate.
          let gateName = toolName;
          let gateInput = input;
          for (let depth = 0; depth < 5; depth++) {
            const bare = gateName.replace(/^mcp__[^_]+__/, "");
            if ((bare === "call_tool" || bare === "mcp_tool_call") && typeof gateInput?.name === "string") {
              const inner = gateInput.name as string;
              gateInput = (gateInput.input as Record<string, unknown>) || {};
              gateName = inner;
            } else break;
          }
          const decision = gate(gateName, this._mode);
          if (decision === "execute") return { behavior: "allow", updatedInput: input };
          if (decision === "skip") return { behavior: "deny", message: `Tool "${gateName}" denied by mode "${this._mode}".` };
          const approved = this._approvalCallback
            ? await this._approvalCallback(gateName, gateInput)
            : false;
          return approved
            ? { behavior: "allow", updatedInput: input }
            : { behavior: "deny", message: "User denied tool call." };
        },
      }),
      // Lazy preset: LIGHT turns ship NO claude_code preset (tools: []) — just
      // the yo MCP tools — so the cached system prefix stays small. DEV turns
      // (after the agent called request_dev_tools) carry the full preset
      // (Read/Edit/Bash/Grep/…). Permission gating is handled by canUseTool /
      // permissionMode above.
      tools: this._devMode ? { type: "preset", preset: "claude_code" } : [],
      // Strip native tools that this surface can't honor, so the model can't
      // reach for them (they'd render as dead cards or silently shift context
      // with no UI). Removed from the model's context entirely:
      //   - AskUserQuestion → use mcp__glyphh__ask_user_question (composer wizard).
      //   - EnterWorktree / ExitWorktree → git worktrees have no UI in the
      //     right-rail .Yo (it runs at ~/yo/); switching trees invisibly would
      //     be deeply confusing. Sub-agents/Bash cover any real need.
      // Everything else in the claude_code preset is either handled specially
      // (Agent → Sub-Agents panel, ExitPlanMode → .yo/plan.md, TodoWrite →
      // todo capture) or renders fine as a generic tool card. In DEV mode the
      // escalation tool is also hidden — the agent already has dev tools.
      disallowedTools: ["AskUserQuestion", "EnterWorktree", "ExitWorktree",
        ...(this._devMode ? ["mcp__glyphh__request_dev_tools"] : [])],
      mcpServers: { "yo": mcpServer },
      systemPrompt: this.buildSystemPrompt(this._devMode),
      abortController: this.abortController,
      includePartialMessages: true,
      // Forward sub-agent (Task / call_agent) text + thinking as assistant/user
      // messages tagged with parent_tool_use_id. Without this the SDK only
      // emits the sub-agent's tool_use/tool_result blocks, so the Workbench
      // Sub-Agents panel can't show a live transcript. We route every parented
      // message to cb.onSubAgent({ kind: "token" }) below.
      forwardSubagentText: true,
      persistSession: true,
      todoFeatureEnabled: true,
      // Context compaction — user-configurable in Settings → Agent Defaults.
      // autoCompactWindow is the token budget the conversation may grow to
      // before the SDK auto-summarizes older turns. We always forward an
      // explicit value (the user's, or DEFAULT_COMPACT_WINDOW) so the actual
      // compaction point matches the number the composer gauge measures against.
      settings: (() => {
        return {
          autoCompactEnabled: getDbPreference<boolean>("autoCompactEnabled", true),
          autoCompactWindow: resolveCompactWindow(),
        } as Record<string, unknown>;
      })(),
      // The Glyphh agent runs through the platform proxy: Anthropic models
      // fronted by platform keys and metered as credits, authenticated with the
      // logged-in session JWT. No user key required. (The user's own Anthropic
      // key, if set in Settings → Providers, is for the Agents coding agents —
      // not this agent.) If somehow signed out, fall back to a BYOK key.
      env: (() => {
        const base: Record<string, string | undefined> = {
          ...process.env,
          PATH: shellPath,
          CLAUDE_AGENT_SDK_CLIENT_APP: "yosup/3.0.0",
        };
        const proxy = proxyAnthropicEnv();
        if (proxy.ANTHROPIC_BASE_URL) {
          Object.assign(base, proxy);
          delete base.ANTHROPIC_API_KEY;
          // Attribute this turn's metered credits to the active chat — the CLI
          // forwards ANTHROPIC_CUSTOM_HEADERS as request headers, and the proxy
          // reads x-glyphh-chat-id into llm_usage_events.chat_id.
          if (this.chatId) base.ANTHROPIC_CUSTOM_HEADERS = `x-glyphh-chat-id: ${this.chatId}`;
          console.log(`[yo-agent] proxy mode → ${proxy.ANTHROPIC_BASE_URL} (model=${model})`);
        } else {
          const byok = (() => { try { return getProviderKey("anthropic"); } catch { return null; } })();
          if (byok) base.ANTHROPIC_API_KEY = byok;
          console.log(`[yo-agent] BYOK mode — no session token; key=${byok ? "set" : "MISSING"} (model=${model})`);
        }
        return base;
      })(),
    };

    if (this.sessionId) {
      options.resume = this.sessionId;
    }

    let fullText = "";
    const startTs = Date.now();
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheCreation = 0;
    let totalCacheRead = 0;
    const toolsUsed = new Set<string>();
    // Full, ordered tool calls for this turn — persisted with the
    // assistant message so reloaded history shows the complete run
    // (not just the final answer text).
    const turnTools: Array<{ name: string; input?: unknown }> = [];
    // Tool-use blocks tracked by streaming index for the current assistant
    // message. Emitting onToolUse from the streaming events (in block order)
    // — rather than from the buffered `assistant` message that lands at
    // message-end — keeps tool rows interleaved with text in true stream
    // order. Keyed by content-block index; reset at each message_start.
    let toolBlocks = new Map<number, { id: string; name: string; inputJson: string }>();
    // Parent tool-use ids whose sub-agent text already arrived via partial
    // stream events this message, so the buffered assistant message can skip
    // re-emitting it. forwardSubagentText forwards sub-agent turns as buffered
    // assistant/user messages; whether partials are *also* emitted per
    // sub-agent isn't guaranteed, so we cover both paths and dedup here.
    const subAgentStreamed = new Set<string>();

    // This turn's controller. If a new turn (or clear()) supersedes us, the
    // instance field moves on — we compare against this local so a superseded
    // turn can neither keep streaming nor re-set sessionId on the new session.
    const myController = this.abortController;

    // Persist the turn (chat record + prompt log) on EVERY terminal outcome —
    // success, error, AND user-stop — so the user's message and any partial
    // response are never lost. Re-run paths (escalation, auth/stale retry) do
    // NOT call this; their re-run persists the real turn. Idempotent.
    let persisted = false;
    const persistTurn = (force = false) => {
      if (persisted) return;
      // On an error/stop that produced NO output, the prompt is already
      // preserved by the composer (restored) + input history, so don't save an
      // empty turn — it would duplicate the user's message on resend. A real
      // completion (force) always saves; a partial (some streamed text) saves.
      if (!force && !fullText.trim()) return;
      persisted = true;
      this.saveChatRecord(message, fullText, startTs, turnTools);
      promptLog.record({
        id: `${startTs}-${Math.random().toString(36).slice(2, 8)}`,
        startTs,
        endTs: Date.now(),
        prompt: message.slice(0, 2000),
        response: fullText.slice(0, 2000),
        inputTokens: totalInput,
        outputTokens: totalOutput,
        cacheCreationTokens: totalCacheCreation,
        cacheReadTokens: totalCacheRead,
        model,
        provider: "anthropic",
        mode: this._mode,
        toolsUsed: [...toolsUsed],
      });
    };

    try {
      const gen = sdk.query({ prompt: message, options });

      for await (const msg of gen) {
        if (myController?.signal.aborted || this.abortController !== myController) break;

        switch (msg.type) {
          case "system":
            if (msg.subtype === "init" && msg.session_id && this.abortController === myController) {
              this.sessionId = msg.session_id;
            }
            break;

          case "assistant": {
            const content = msg.message?.content;
            if (!Array.isArray(content)) break;
            const asstParentId = (msg as any).parent_tool_use_id as string | null | undefined;
            if (asstParentId) {
              // Buffered sub-agent message (forwardSubagentText). Surface its
              // text + tool calls in the Sub-Agents panel transcript. Text is
              // emitted here UNLESS it already streamed token-by-token via
              // stream_event above (dedup), so it shows up exactly once whether
              // or not the SDK emits partials per sub-agent.
              const alreadyStreamed = subAgentStreamed.has(asstParentId);
              for (const block of content as any[]) {
                if (block.type === "text" && block.text) {
                  if (!alreadyStreamed) {
                    cb.onSubAgent?.({ id: asstParentId, kind: "text", source: "task", text: block.text });
                  }
                } else if (block.type === "thinking" && block.thinking) {
                  if (!alreadyStreamed) {
                    cb.onSubAgent?.({ id: asstParentId, kind: "text", source: "task", text: block.thinking });
                  }
                } else if (block.type === "tool_use") {
                  // Structured tool event → the panel renders a real collapsible
                  // tool widget (same as the main stream), not a "→ Read" line.
                  cb.onSubAgent?.({
                    id: asstParentId,
                    kind: "tool",
                    source: "task",
                    toolId: block.id,
                    toolName: block.name,
                    toolInput: block.input,
                  });
                }
              }
              subAgentStreamed.delete(asstParentId);
              break;
            }
            for (const block of content) {
              if (block.type === "tool_use") {
                if (block.name === "TodoWrite" && Array.isArray((block.input as any)?.todos)) {
                  this._lastTodos = (block.input as any).todos;
                }
                toolsUsed.add(block.name);
                turnTools.push({ name: block.name, input: block.input });
                // NOTE: cb.onToolUse is emitted from the streaming events
                // (content_block_stop) so tool rows interleave with text in
                // true stream order. The buffered `assistant` message lands at
                // message-end and would push every tool row below the text.
                // The side effects below still read the fully-formed block
                // input here (order-insensitive: they hit other views/files).
                // The SDK's internal sub-agent tool. Surface it in the Workbench
                // Sub-Agents view as a new tab; the result closes the tab via
                // "result" below. NOTE: the @anthropic-ai/claude-agent-sdk names
                // this tool "Agent" (older Claude Code called it "Task") — match
                // both so the panel actually spawns. This was the bug where the
                // panel showed "No sub-agents running" forever: we only matched
                // "Task" but the SDK emits "Agent".
                if (block.name === "Agent" || block.name === "Task") {
                  const taskInput = (block.input as { description?: string; prompt?: string; subagent_type?: string }) || {};
                  cb.onSubAgent?.({
                    id: block.id,
                    kind: "spawn",
                    source: "task",
                    name: taskInput.subagent_type || (taskInput.description?.slice(0, 40)) || "agent",
                    description: taskInput.prompt || taskInput.description,
                  });
                }
                // mcp__glyphh__call_agent / create_swarm surface in the Workbench
                // Sub-Agents view too, but the panel tab + live transcript are
                // driven by the swarm lifecycle in main.ts (runSwarm spawns a
                // tab per roster agent keyed `swarm:<agentId>`, and the cypher
                // bus streams each agent's activity into it). We deliberately
                // do NOT spawn a tab here keyed by this tool_use_id — that
                // would create an empty duplicate that never receives tokens,
                // since the agent's work runs in the swarm process, not under
                // this top-level tool block.
                // ExitPlanMode — Claude Code's canonical plan-mode artifact
                // hook. The agent calls it with { plan: "..." } when planning
                // finishes; we route that markdown straight to .yo/plan.md so
                // the Workbench Plan slot renders it automatically (same
                // pattern Claude Code Desktop uses to surface plans in its
                // plan panel — the host watches a known path).
                if (block.name === "ExitPlanMode") {
                  const planText = (block.input as { plan?: string } | null)?.plan || "";
                  if (planText.trim()) {
                    try {
                      const planDir = path.join(rightRailCwd(), ".yo");
                      fs.mkdirSync(planDir, { recursive: true });
                      fs.writeFileSync(path.join(planDir, "plan.md"), planText, { mode: 0o600 });
                    } catch { /* ignore — best-effort */ }
                  }
                }
              }
            }
            break;
          }

          case "stream_event": {
            const event = msg.event as any;
            if (!event) break;
            const subParentId = (msg as any).parent_tool_use_id as string | null | undefined;
            if (subParentId) {
              // Sub-agent streaming text → live tokens in the Sub-Agents panel
              // (only when the SDK emits partials per sub-agent). We mark the
              // parent as "streamed" so the buffered assistant message below
              // doesn't re-emit the same text. Tool blocks are surfaced from
              // the buffered message (formatted, in order), and we keep the
              // sub-agent out of the top-level toolBlocks index space.
              if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
                cb.onSubAgent?.({ id: subParentId, kind: "text", source: "task", text: event.delta.text });
                subAgentStreamed.add(subParentId);
              }
              break;
            }
            if (event.type === "message_start") {
              // New assistant message — block indices restart at 0.
              toolBlocks = new Map();
            } else if (event.type === "content_block_start") {
              const block = event.content_block;
              if (block?.type === "tool_use") {
                toolBlocks.set(event.index, { id: block.id, name: block.name, inputJson: "" });
              }
            } else if (event.type === "content_block_delta") {
              const delta = event.delta;
              if (delta?.type === "text_delta" && delta.text) {
                fullText += delta.text;
                cb.onText(delta.text);
              } else if (delta?.type === "input_json_delta") {
                const tb = toolBlocks.get(event.index);
                if (tb) tb.inputJson += delta.partial_json || "";
              }
            } else if (event.type === "content_block_stop") {
              // A tool-use block just finished streaming. Emit it now, in
              // stream order, so its row lands before any text that follows.
              const tb = toolBlocks.get(event.index);
              if (tb) {
                let input: unknown = {};
                try { input = tb.inputJson ? JSON.parse(tb.inputJson) : {}; } catch { /* partial/empty — keep {} */ }
                cb.onToolUse(tb.id, tb.name, input);
                try { this._toolUseSeen?.(tb.name, input); } catch { /* hook is best-effort */ }
                toolBlocks.delete(event.index);
              }
            }
            break;
          }

          case "user": {
            const content = msg.message?.content;
            if (!Array.isArray(content)) break;
            const userParentId = (msg as any).parent_tool_use_id as string | null | undefined;
            for (const block of content as any[]) {
              if (block.type === "tool_result" && block.tool_use_id) {
                const text = typeof block.content === "string"
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content.map((c: any) => c.text || "").join("")
                    : "";
                if (userParentId) {
                  // A sub-agent's OWN internal tool result. Attach it to the
                  // matching tool widget in the panel (collapsible Output) — do
                  // NOT close the parent tab (that happens when the top-level
                  // Task tool_result lands below, with parent_tool_use_id null).
                  cb.onSubAgent?.({
                    id: userParentId,
                    kind: "tool_result",
                    source: "task",
                    toolId: block.tool_use_id,
                    toolOutput: text.slice(0, 2000),
                  });
                  continue;
                }
                cb.onToolResult?.(block.tool_use_id, text.slice(0, 500));
                // Close out any sub-agent tab keyed by this tool_use_id (Task
                // tool or mcp__glyphh__call_agent). The Sub-Agents view ignores
                // events with unknown ids, so emitting unconditionally is safe.
                cb.onSubAgent?.({
                  id: block.tool_use_id,
                  kind: "result",
                  source: "task",
                  text,
                });
              }
            }
            break;
          }

          case "tool_progress": {
            cb.onToolProgress?.(msg.tool_use_id, msg.tool_name?.replace(/_/g, " ") || "working");
            break;
          }

          case "result": {
            const usage = msg.usage;
            if (usage) {
              totalInput += usage.input_tokens || 0;
              totalOutput += usage.output_tokens || 0;
              totalCacheCreation += usage.cache_creation_input_tokens || 0;
              totalCacheRead += usage.cache_read_input_tokens || 0;
              usageTracker.record("orchestrator", {
                inputTokens: usage.input_tokens || 0,
                outputTokens: usage.output_tokens || 0,
                cacheCreation: usage.cache_creation_input_tokens || 0,
                cacheRead: usage.cache_read_input_tokens || 0,
              });
              this.reportUsage(usage.input_tokens || 0, usage.output_tokens || 0, model);
              // Context size ≈ everything fed in this turn (fresh input + cached
              // prompt prefix). That's what grows toward the compaction window.
              const contextTokens = (usage.input_tokens || 0)
                + (usage.cache_read_input_tokens || 0)
                + (usage.cache_creation_input_tokens || 0);
              // Immediate, approximate gauge from this turn's usage…
              cb.onContextUsage?.(contextTokens, resolveCompactWindow());
              // …then override with the SDK's AUTHORITATIVE view when available:
              // its real total + the actual auto-compact threshold. The SDK
              // compacts near the model's context limit and clamps tiny window
              // settings, so measuring against our setting reads "100%, never
              // compacts". This makes the gauge reflect when compaction WILL
              // really fire (and reset). Best-effort, non-blocking.
              const cuPromise = (gen as any).getContextUsage?.();
              if (cuPromise && typeof cuPromise.then === "function") {
                cuPromise
                  .then((cu: any) => {
                    if (!cu) return;
                    const used = typeof cu.totalTokens === "number" ? cu.totalTokens : contextTokens;
                    const window = cu.autoCompactThreshold || cu.maxTokens || resolveCompactWindow();
                    if (window > 0) cb.onContextUsage?.(used, window);
                  })
                  .catch(() => {});
              }
            }
            if (msg.is_error && msg.result) {
              if (this.abortController?.signal.aborted || /abort/i.test(msg.result)) break;
              // The proxy rejected the session token (expired/invalid). If the
              // turn produced no output yet, transparently refresh + retry once
              // so the user never sees it. If output already streamed (a long
              // turn that outlived its token), refresh silently and ask them to
              // resend rather than duplicating the partial response.
              if (this.isAuthError(msg.result)) {
                const refreshed = await forceTokenRefresh();
                // The failed turn's SDK session already committed this user
                // message (persistSession), so resuming it on the retry — or on
                // the user's manual resend — would duplicate the turn and replay
                // any partial state. Drop it so we mint a fresh session; the
                // context-recovery block in buildSystemPrompt refills recent
                // history from disk (same as the stale-session path below).
                this.sessionId = null;
                if (!isRetry && !fullText.trim() && refreshed) {
                  await this.send(message, cb, true); // transparent retry on a fresh token
                  return;
                }
                persistTurn();
                cb.onError(refreshed
                  ? "Your session expired mid-task and has been refreshed — please resend your message."
                  : "Your session has expired. Please sign in again.");
                return;
              }
              persistTurn();
              cb.onError(this.creditsAware(msg.result));
              return;
            }
            break;
          }
        }
      }

      // Lazy preset: the light agent called request_dev_tools (its handler
      // aborts the turn — usually caught below; this covers a clean drain). Re-
      // run with the full claude_code preset; fresh session + context-recovery
      // refill history (same pattern as the stale-session/auth-retry paths).
      if (this._escalatePending) { await this.escalateToDevTools(message, cb, isRetry); return; }

      // The CC process crashed mid-turn without the stream throwing — the
      // loop just drained empty. Surface it instead of a silent dead turn.
      if (processExit && !fullText.trim() && !this.abortController.signal.aborted) {
        const ex = processExit as { code: number | null; signal: string | null; stderr: string };
        const tail = ex.stderr.trim().split("\n").slice(-3).join("\n").slice(0, 300);
        persistTurn();
        cb.onError(`The agent process exited unexpectedly (code ${ex.code}).${tail ? `\n${tail}` : ""}`);
        return;
      }

      // Mark that the plan was delivered — next user message triggers transition.
      if (this._mode === "plan") {
        this._planDelivered = true;
      }

      // Save chat record + prompt log (also runs on the error/abort paths below).
      persistTurn(true);

      // Ingest structured turn into capture store
      if (this.captureStore && fullText.trim()) {
        const structured = this.buildStructuredCapture(message, fullText);
        this.captureStore.ingest("yo-agent", structured, this.workspaceGetter?.()).catch(() => {});
      }

      cb.onDone(fullText);
    } catch (err: any) {
      const msg: string = err?.message || String(err || "");
      const isAbort = err?.name === "AbortError" || /\b(abort(ed)?|cancell?ed)\b/i.test(msg);
      // Lazy preset: request_dev_tools aborted the light turn so we re-run it
      // with the full preset. Only when the throw IS that abort — a coincident
      // non-abort error (process death, session error) must take its own path,
      // not get silently converted into an escalation.
      if (this._escalatePending && isAbort) { await this.escalateToDevTools(message, cb, isRetry); return; }
      this._escalatePending = false; // a real error supersedes a pending escalation
      // Treat anything abort-flavored as a clean stop. AbortError is the
      // standard signal, but the SDK also surfaces text-only abort messages
      // ("process aborted by user", "aborted") that aren't AbortError
      // instances — those used to leak into the panel as red error rows.
      if (isAbort) {
        persistTurn(); // user-stop: keep the message + whatever streamed so far
        cb.onDone(fullText);
        return;
      }
      // SDK's session storage expired on its side ("No conversation found
      // with session ID: …"). Our cached sessionId is now stale — drop it
      // so the next turn starts fresh (the SDK will mint a new session),
      // and retry this turn once without --resume so the user doesn't have
      // to send it again. The context-recovery block in buildSystemPrompt
      // fills in the recent history from disk for the fresh session.
      if (this.sessionId && /No conversation found with session ID/i.test(msg)) {
        console.log(`[yo-agent] stale session ${this.sessionId} — dropping + retrying without resume`);
        this.sessionId = null;
        try {
          await this.send(message, cb);
          return;
        } catch { /* fall through to error path below */ }
      }
      // A bare/opaque SDK error often means the CC child died — fold in its
      // stderr tail so the panel shows something actionable, not just "Error".
      const ex = processExit as { code: number | null; signal: string | null; stderr: string } | null;
      const tail = ex?.stderr?.trim().split("\n").slice(-3).join("\n").slice(0, 300);
      persistTurn();
      cb.onError(this.creditsAware(tail && msg.length < 40 ? `${msg}\n${tail}` : msg));
    }
  }

  /**
   * If an SDK/proxy error means the org is out of credits (the proxy returns a
   * 402), return a notice the renderer turns into an "out of credits" card with
   * a "Manage plan" link. Otherwise pass the error through unchanged. The
   * "__CREDITS__" sentinel is matched in yo-agent-renderer.ts showError().
   */
  /** Re-run the current turn with the full claude_code preset after the light
   *  agent called request_dev_tools. Drops the SDK session so the retry mints a
   *  fresh one (buildSystemPrompt's context-recovery refills recent history);
   *  _devMode is sticky for the rest of the conversation — the preset is now
   *  cache-warm, so later turns pay cheap cache-reads, not another write. */
  private async escalateToDevTools(message: string, cb: YoAgentCallbacks, isRetry: boolean): Promise<void> {
    this._escalatePending = false;
    this._devMode = true;
    this.sessionId = null;
    await this.send(message, cb, isRetry);
  }

  /** True when a proxy/SDK error is an auth failure (expired/invalid session
   *  token) — distinct from a 402 out-of-credits, which creditsAware handles. */
  private isAuthError(raw: string): boolean {
    const s = raw || "";
    // A 402/out-of-credits message (handled by creditsAware) must never be
    // misread as an auth failure — that would burn a refresh + pointless retry.
    if (/\b402\b|out of credits|insufficient credit|payment required/i.test(s)) return false;
    return /\b401\b|invalid or expired token|unauthor(i[sz]ed)?|failed to authenticate/i.test(s);
  }

  private creditsAware(raw: string): string {
    if (/\b402\b|out of credits|insufficient credit|buyMore|payment required/i.test(raw || "")) {
      return "__CREDITS__You're out of credits. Add more on the platform to keep using the Glyphh agent.";
    }
    return raw;
  }

  getLastResponse(): string {
    return "";
  }

  getChatId(): string | null { return this.chatId; }
  getChatTitle(): string { return this.chatTitle; }

  // ── Structured capture ─────────────────────────────────

  private _lastTodos: Array<{ content: string; status: string }> = [];

  updateTodos(todos: Array<{ content: string; status: string }>): void {
    this._lastTodos = todos;
  }

  private buildStructuredCapture(userMessage: string, assistantText: string): string {
    const meta: string[] = [];
    if (this.chatId) meta.push(`chatId: ${this.chatId}`);
    if (this.sessionId) meta.push(`sessionId: ${this.sessionId}`);
    if (this.chatTitle) meta.push(`intent: ${this.chatTitle}`);
    if (this._lastTodos.length > 0) {
      const progress = this._lastTodos.map((t) => {
        const icon = t.status === "completed" ? "✓" : t.status === "in_progress" ? "→" : "○";
        return `${icon} ${t.content}`;
      }).join("\n");
      meta.push(`progress:\n${progress}`);
    }
    const header = meta.length > 0 ? `[meta]\n${meta.join("\n")}\n\n` : "";
    return `${header}[user]\n${userMessage}\n\n[assistant]\n${assistantText}`;
  }

  // ── System prompt builder ────────────────────���─────────

  private buildSystemPrompt(devMode: boolean): string | { type: "preset"; preset: "claude_code"; append?: string } {
    // On a resumed chat without a live SDK session, recover recent history —
    // without it the model has zero memory of prior turns in this thread.
    const recovery = (this.chatId && !this.sessionId) ? this.buildContextRecovery() : null;
    // Compact, dynamic awareness of the user's connected apps so the agent KNOWS
    // what's reachable (and goes straight to find_tools) without their schemas
    // being preloaded.
    const apps = connectedAppsBlock(connectorsInline());

    if (!devMode) {
      // LIGHT mode — replace the claude_code preset system prompt entirely with
      // our compact assistant prompt. This (plus dropping the preset's built-in
      // tools) is what shrinks the cached prefix on chat/ask turns. The agent
      // escalates via request_dev_tools when it needs real dev tools. We do NOT
      // append DELEGATION_GUIDANCE here — it steers to the foreground Task tool,
      // which is a preset built-in absent in light mode; SYSTEM_PROMPT's own
      // delegation rule covers the background tools that ARE loaded.
      const parts = [SYSTEM_PROMPT, LIGHT_ESCALATION_GUIDANCE, TOOL_DISCOVERY_GUIDANCE];
      if (apps) parts.push(apps);
      if (recovery) parts.push(recovery);
      return parts.join("\n\n");
    }
    // FULL (dev) mode — stock Claude Code behavior plus our delegation guidance.
    const parts: string[] = [DELEGATION_GUIDANCE, TOOL_DISCOVERY_GUIDANCE];
    if (apps) parts.push(apps);
    if (recovery) parts.push(recovery);
    return { type: "preset", preset: "claude_code", append: parts.join("\n\n") };
  }

  private buildContextRecovery(): string | null {
    if (!this.chatId) return null;
    const filepath = path.join(CHATS_DIR, `${this.chatId}.md`);
    if (!fs.existsSync(filepath)) return null;
    try {
      const raw = fs.readFileSync(filepath, "utf-8");
      const jsonMatch = raw.match(/```json\n([\s\S]*?)\n```/);
      if (!jsonMatch) return null;
      const all: Array<{ role: string; content: string }> = JSON.parse(jsonMatch[1]);
      // Only the actual conversation feeds context recovery — swarm-activity
      // entries are thread history, not turns the model should replay.
      const messages = all.filter((m) => m.role === "user" || m.role === "assistant");
      if (messages.length === 0) return null;
      // Take last 6 messages (3 exchanges) for context window efficiency
      const recent = messages.slice(-6);
      const summary = recent.map((m) => {
        const tag = m.role === "user" ? "User" : "You";
        const text = m.content.length > 500 ? m.content.slice(0, 500) + "..." : m.content;
        return `${tag}: ${text}`;
      }).join("\n\n");
      return `CONTINUED CONVERSATION — this thread was resumed. Recent context:\n${summary}`;
    } catch {
      return null;
    }
  }

  // ── Usage reporting ────────────────────────────────────

  private reportUsage(inputTokens: number, outputTokens: number, model: string): void {
    // Client sends raw tokens — server is the authority on yos calculation
    usageQueue.enqueue({
      inputTokens,
      outputTokens,
      model,
      yosConsumed: 0,
      agent: "orchestrator",
    });
  }

  // ── Chat management ────────────────────────────────────

  clear(): void {
    // Abort any in-flight turn FIRST. Otherwise a still-draining stream can set
    // `this.sessionId` from a late `init` message (see the result loop) AFTER we
    // reset below — and the next message would resume the OLD session, bleeding
    // the previous conversation into the new one.
    this.abort();
    // Flush buffered swarm activity into the outgoing chat before we drop it.
    this.flushSwarmEntries();
    this.sessionId = null;
    this.chatId = null;
    this.chatTitle = "";
    this.mcpServer = null;
    // Reset per-conversation flags so a new session carries nothing over from
    // the old one (e.g. a plan already delivered, or dev tools escalated).
    this._planDelivered = false;
    this._devMode = false;
    this._escalatePending = false;
  }

  loadChat(id: string): Array<{ role: string; text: string; tools?: Array<{ name: string; input?: unknown }> }> | null {
    const filepath = path.join(CHATS_DIR, `${id}.md`);
    if (!fs.existsSync(filepath)) return null;
    try {
      const raw = fs.readFileSync(filepath, "utf-8");
      const parsed = this.parseChatFile(raw);
      this.chatId = id;
      this.chatTitle = parsed.title;
      this.sessionId = parsed.sessionId || null;
      this._planDelivered = false;
      // A loaded chat starts light; it re-escalates if the next turn needs dev
      // tools. (We don't persist dev-mode — re-deriving it is cheap and safe.)
      this._devMode = false;
      this._escalatePending = false;
      // Restore the chat's working directory if it still exists, so the
      // agent + files view re-point to the same folder.
      if (parsed.workingDirectory && fs.existsSync(parsed.workingDirectory)) {
        setWorkingDirectory(parsed.workingDirectory);
      }
      return parsed.display;
    } catch {
      return null;
    }
  }

  listChats(): ChatSummary[] {
    fs.mkdirSync(CHATS_DIR, { recursive: true });
    try {
      // Recents = real conversations only. Scheduled/manual task runs
      // (run-*.md) are surfaced in the Scheduled section via runsList, not here.
      const files = fs.readdirSync(CHATS_DIR)
        .filter((f) => f.endsWith(".md") && !f.startsWith("run-"));

      const summaries = files.map((f) => {
        try {
          const raw = fs.readFileSync(path.join(CHATS_DIR, f), "utf-8");
          const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
          let title = f.replace(/\.md$/, "");
          let created = "";
          let messageCount = 0;
          let type: string | undefined;
          let skillName: string | undefined;
          if (fmMatch) {
            const fm = fmMatch[1];
            const t = fm.match(/^title:\s*(.+)$/m);
            if (t) title = t[1].trim();
            const c = fm.match(/^created:\s*(.+)$/m);
            if (c) created = c[1].trim();
            const m = fm.match(/^messages:\s*(\d+)$/m);
            if (m) messageCount = parseInt(m[1], 10);
            const ty = fm.match(/^type:\s*(.+)$/m);
            if (ty) type = ty[1].trim();
            const sk = fm.match(/^skillName:\s*(.+)$/m);
            if (sk) skillName = sk[1].trim();
          }
          return { id: f.replace(/\.md$/, ""), title, created, messageCount, type, skillName };
        } catch {
          return { id: f.replace(/\.md$/, ""), title: f, created: "", messageCount: 0 };
        }
      });
      // Newest first by actual created timestamp (ISO strings sort lexically).
      summaries.sort((a, b) => (b.created || "").localeCompare(a.created || ""));
      return summaries;
    } catch {
      return [];
    }
  }

  deleteChat(id: string): boolean {
    try {
      fs.unlinkSync(path.join(CHATS_DIR, `${id}.md`));
      return true;
    } catch { return false; }
  }

  /** Delete all persisted run-*.md chats for a given task/skill name. */
  deleteRunsForSkill(skillName: string): number {
    let removed = 0;
    try {
      for (const f of fs.readdirSync(CHATS_DIR).filter((f) => f.startsWith("run-") && f.endsWith(".md"))) {
        try {
          const raw = fs.readFileSync(path.join(CHATS_DIR, f), "utf-8");
          const m = raw.match(/^skillName:\s*(.+)$/m);
          if (m && m[1].trim() === skillName) { fs.unlinkSync(path.join(CHATS_DIR, f)); removed++; }
        } catch { /* skip */ }
      }
    } catch { /* no dir */ }
    return removed;
  }

  /**
   * Persist a completed task run as a special `type: run` chat so it can be
   * opened in the agent panel and listed in Activity / the schedule detail.
   * Lives in CHATS_DIR alongside chats but is filtered out of Recents.
   */
  saveRunChat(opts: {
    skillName: string;
    trigger: string;
    output?: unknown;
    error?: string;
    startedAt: number;
    instructions?: string;
  }): string {
    fs.mkdirSync(CHATS_DIR, { recursive: true });
    const id = `run-${opts.startedAt}-${crypto.randomBytes(3).toString("hex")}`;
    const label = opts.trigger === "schedule" ? "Ran scheduled task" : "Ran task";
    const outText = opts.error
      ? `**Run failed**\n\n${opts.error}`
      : (typeof opts.output === "string" ? opts.output : "```json\n" + JSON.stringify(opts.output ?? null, null, 2) + "\n```");
    const messages: ChatMessage[] = [
      { role: "run", content: label, tools: [{ name: opts.skillName }] },
      ...(opts.instructions ? [{ role: "user", content: opts.instructions } as ChatMessage] : []),
      { role: "assistant", content: outText },
    ];
    const startedIso = new Date(Number.isFinite(opts.startedAt) ? opts.startedAt : Date.now()).toISOString();
    const lines = [
      "---",
      `title: ${opts.skillName}`,
      `created: ${startedIso}`,
      `messages: 1`,
      `type: run`,
      `skillName: ${opts.skillName}`,
      `trigger: ${opts.trigger}`,
      ...(opts.error ? ["status: error"] : ["status: ok"]),
      "---",
      "",
      "```json",
      JSON.stringify(messages, null, 2),
      "```",
    ];
    fs.writeFileSync(path.join(CHATS_DIR, `${id}.md`), lines.join("\n"), "utf-8");
    // Keep run history bounded — prune oldest run files beyond a cap.
    this.pruneRuns();
    return id;
  }

  /** Read a single run's display messages without making it the active chat. */
  getRun(id: string): { title: string; messages: Array<{ role: string; text: string; tools?: Array<{ name: string; input?: unknown }> }> } | null {
    const filepath = path.join(CHATS_DIR, `${id}.md`);
    if (!fs.existsSync(filepath)) return null;
    try {
      const parsed = this.parseChatFile(fs.readFileSync(filepath, "utf-8"));
      return { title: parsed.title, messages: parsed.display };
    } catch { return null; }
  }

  /** List persisted task runs (optionally for one skill), newest first. */
  listRuns(skillName?: string): RunSummary[] {
    fs.mkdirSync(CHATS_DIR, { recursive: true });
    try {
      return fs.readdirSync(CHATS_DIR)
        .filter((f) => f.startsWith("run-") && f.endsWith(".md"))
        .map((f) => {
          const raw = fs.readFileSync(path.join(CHATS_DIR, f), "utf-8");
          const fm = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] || "";
          const get = (k: string) => fm.match(new RegExp(`^${k}:\\s*(.+)$`, "m"))?.[1].trim() || "";
          return {
            id: f.replace(/\.md$/, ""),
            skillName: get("skillName") || get("title"),
            title: get("title"),
            created: get("created"),
            trigger: get("trigger") || "manual",
            ok: get("status") !== "error",
          } as RunSummary;
        })
        .filter((r) => !skillName || r.skillName === skillName)
        .sort((a, b) => (b.created || "").localeCompare(a.created || ""));
    } catch { return []; }
  }

  /** Cap stored run files (keep the newest 100). */
  private pruneRuns(): void {
    try {
      const runs = fs.readdirSync(CHATS_DIR).filter((f) => f.startsWith("run-") && f.endsWith(".md")).sort();
      const excess = runs.length - 100;
      for (let i = 0; i < excess; i++) {
        try { fs.unlinkSync(path.join(CHATS_DIR, runs[i])); } catch {}
      }
    } catch {}
  }

  // ── Persistence ────────────────────────────────────────

  /** Read the message array out of the current chat's .md file. */
  private readChatMessages(): ChatMessage[] {
    if (!this.chatId) return [];
    const filepath = path.join(CHATS_DIR, `${this.chatId}.md`);
    if (!fs.existsSync(filepath)) return [];
    try {
      const raw = fs.readFileSync(filepath, "utf-8");
      const m = raw.match(/```json\n([\s\S]*?)\n```/);
      return m ? JSON.parse(m[1]) : [];
    } catch { return []; }
  }

  /** Write the message array back, regenerating frontmatter. */
  private writeChatFile(messages: ChatMessage[]): void {
    if (!this.chatId) return;
    fs.mkdirSync(CHATS_DIR, { recursive: true });
    const userMsgs = messages.filter((m) => m.role === "user").length;
    // chatId is usually a Date.now() string, but a loaded chat can carry a
    // non-numeric id (e.g. "run-…") — guard so toISOString() never throws
    // "Invalid time value".
    const createdTs = parseInt(this.chatId, 10);
    const createdIso = new Date(Number.isFinite(createdTs) ? createdTs : Date.now()).toISOString();
    const lines = [
      "---",
      `title: ${this.chatTitle}`,
      `created: ${createdIso}`,
      `messages: ${userMsgs}`,
      // Capture the folder this chat works in so reopening it restores
      // the same context (agent cwd + files view).
      `workingDirectory: ${getWorkingDirectory()}`,
      ...(this.sessionId ? [`sessionId: ${this.sessionId}`] : []),
      "---",
      "",
      "```json",
      JSON.stringify(messages, null, 2),
      "```",
    ];
    fs.writeFileSync(path.join(CHATS_DIR, `${this.chatId}.md`), lines.join("\n"), "utf-8");
  }

  private saveChatRecord(
    userMessage: string,
    assistantText: string,
    _startTs: number,
    tools?: Array<{ name: string; input?: unknown }>,
  ): void {
    if (!this.chatId) return;
    const existing = this.readChatMessages();
    existing.push({ role: "user", content: userMessage });
    // Persist the assistant turn even when it produced no text, so a
    // tool-only turn still shows its tool timeline on reload.
    if (assistantText || (tools && tools.length > 0)) {
      const msg: ChatMessage = { role: "assistant", content: assistantText };
      if (tools && tools.length > 0) msg.tools = tools;
      existing.push(msg);
    }
    this.writeChatFile(existing);
    // Swarm activity that fired during this turn belongs after it — flush now
    // so the buffered entries are appended in chronological order.
    this.flushSwarmEntries();
  }

  /**
   * Append a swarm-activity entry (kind "swarm" or "swarm-start") to the
   * active chat so the thread restores in full. Buffered + debounced.
   */
  appendSwarmEntry(role: "swarm" | "swarm-start", content: string): void {
    if (!this.chatId) return;
    this._pendingSwarm.push({ role, content });
    if (!this._swarmFlushTimer) {
      this._swarmFlushTimer = setTimeout(() => {
        this._swarmFlushTimer = null;
        this.flushSwarmEntries();
      }, 1500);
    }
  }

  private flushSwarmEntries(): void {
    if (this._swarmFlushTimer) { clearTimeout(this._swarmFlushTimer); this._swarmFlushTimer = null; }
    if (!this.chatId || this._pendingSwarm.length === 0) return;
    const pending = this._pendingSwarm.splice(0);
    const existing = this.readChatMessages();
    existing.push(...pending);
    this.writeChatFile(existing);
  }

  private parseChatFile(raw: string): {
    title: string;
    sessionId: string | null;
    workingDirectory: string | null;
    display: Array<{ role: string; text: string; tools?: Array<{ name: string; input?: unknown }> }>;
  } {
    let title = "";
    let sessionId: string | null = null;
    let workingDirectory: string | null = null;
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const t = fmMatch[1].match(/^title:\s*(.+)$/m);
      if (t) title = t[1].trim();
      const s = fmMatch[1].match(/^sessionId:\s*(.+)$/m);
      if (s) sessionId = s[1].trim();
      const w = fmMatch[1].match(/^workingDirectory:\s*(.+)$/m);
      if (w) workingDirectory = w[1].trim();
    }

    const jsonMatch = raw.match(/```json\n([\s\S]*?)\n```/);
    let messages: ChatMessage[] = [];
    if (jsonMatch) {
      try { messages = JSON.parse(jsonMatch[1]); } catch {}
    }

    // Carry tools through so the renderer can replay the tool timeline.
    const display = messages.map((m) => ({
      role: m.role,
      text: m.content || "",
      ...(m.tools && m.tools.length > 0 ? { tools: m.tools } : {}),
    }));

    return { title, sessionId, workingDirectory, display };
  }
}
