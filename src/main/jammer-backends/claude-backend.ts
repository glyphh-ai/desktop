/**
 * ClaudeBackend — the jammer agent loop on Anthropic's Claude Agent SDK.
 *
 * This is the original AgentRunner agent loop, lifted behind the JammerBackend
 * interface unchanged: same SDK options, same path-gate, same resume/replay
 * dedup. It owns translating raw SDK messages into the normalized JammerEvent
 * stream; AgentRunner does the rest.
 */

import os from "os";
import { getShellPath } from "../shell-path";
import { asarSafeQueryOptions } from "../sdk-llm";
import type {
  AgentConfig,
  JammerBackend,
  JammerBackendHooks,
  JammerContentBlock,
  JammerEvent,
  JammerTurnRequest,
} from "./types";

const dynamicImport = new Function("specifier", "return import(specifier)") as
  (specifier: string) => Promise<any>;

/** SDK module is process-wide — cache it across every jammer. */
let sdkModule: any = null;
async function loadSdk(): Promise<any> {
  if (!sdkModule) {
    sdkModule = await dynamicImport("@anthropic-ai/claude-agent-sdk");
  }
  return sdkModule;
}

export class ClaudeBackend implements JammerBackend {
  readonly provider = "anthropic";

  private sdk: any = null;
  private baseOptions: Record<string, any> = {};
  /** Active SDK query — held so abort() can close it mid-turn. */
  private activeQuery: any = null;
  /** Resume replays prior messages; dedup them across turns by uuid. */
  private seenUuids = new Set<string>();

  /** Pre-flight Claude Code OAuth. Pops the in-app login modal if creds are
   *  missing; returns ok:false to abort the start (the modal owns the UX). */
  async preflight(): Promise<{ ok: boolean }> {
    const { ensureCcAuth } = await import("../cc-bootstrap");
    return { ok: await ensureCcAuth() };
  }

  async init(config: AgentConfig, hooks: JammerBackendHooks): Promise<void> {
    this.sdk = await loadSdk();

    const shellPath = getShellPath();
    const agentCwd = config.cwd || os.homedir();

    const baseOptions: Record<string, any> = {
      ...asarSafeQueryOptions(agentCwd),
      executable: "node" as const,
      executableArgs: [],
      model: config.model || "claude-sonnet-4-6",
      maxTurns: config.guardrails?.max_turns ?? 25,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      allowedTools: [
        "Bash", "Read", "Edit", "Write", "Grep", "Glob",
        "WebFetch", "WebSearch", "Agent", "TodoWrite",
      ],
      // Phase 4 of THE-PIVOT-BYOK: SDK uses CC OAuth creds directly,
      // not the proxy. ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY removed so
      // the SDK auto-discovers ~/.claude/.credentials.json (the user's
      // Claude Code subscription).
      env: {
        ...process.env,
        PATH: shellPath,
        YO_AGENT_NAME: config.name,
        YO_AGENT_ROLE: config.role,
        YO_WORKSPACE: config.workspace,
        CLAUDE_AGENT_SDK_CLIENT_APP: "yosup/2.5.0",
      },
    };

    if (config.prompt) {
      baseOptions.systemPrompt = config.prompt;
    }
    if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
      baseOptions.mcpServers = config.mcpServers;
      // allowedTools is a strict allowlist — without an entry per MCP server
      // the SDK silently blocks every mcp__<server>__<tool>, including the
      // swarm coordination tools (assign_task / accept_task / report_status /
      // complete_task / post / post_to). That leaves a swarm unable to
      // coordinate. `mcp__<server>` allows every tool from that server.
      for (const serverName of Object.keys(config.mcpServers)) {
        baseOptions.allowedTools.push(`mcp__${serverName}`);
      }
    }

    // Path-gate: in swarm mode, every tool call resolves through the
    // agent's sandbox. Anything escaping it is denied; three strikes ⇒
    // self-stop.
    if (config.cypherId) {
      const { checkToolCall } = await import("../substrate/path-gate");
      const violationCounts = { count: 0 };
      const agentLocalId = config.name;
      baseOptions.canUseTool = async (toolName: string, input: Record<string, unknown>) => {
        const violation = checkToolCall(input, { cypherSandbox: config.cwd });
        if (!violation) return { behavior: "allow", updatedInput: input };

        violationCounts.count += 1;
        // Self-stop after three sandbox-escape strikes.
        if (violationCounts.count >= 3) {
          console.warn(`[claude-backend] ${agentLocalId} hit 3 path-gate strikes; stopping`);
          hooks.requestStop();
        }
        return { behavior: "deny", message: `Path-gate violation: ${violation}` };
      };
    }

    this.baseOptions = baseOptions;
  }

  async *runTurn(req: JammerTurnRequest): AsyncGenerator<JammerEvent> {
    if (!this.sdk) throw new Error("ClaudeBackend.runTurn called before init");

    const options = { ...this.baseOptions };
    if (req.resumeSessionId) options.resume = req.resumeSessionId;

    const gen = this.sdk.query({ prompt: req.prompt, options });
    this.activeQuery = gen;
    try {
      for await (const msg of gen) {
        // Skip replayed messages from previous turns (resume dedup).
        if (msg.isReplay) continue;
        if (msg.uuid && msg.type !== "system") {
          if (this.seenUuids.has(msg.uuid)) continue;
          this.seenUuids.add(msg.uuid);
        }
        const event = translate(msg);
        if (event) yield event;
      }
    } finally {
      this.activeQuery = null;
    }
  }

  abort(): void {
    this.activeQuery?.close?.();
    this.activeQuery = null;
  }
}

/** Translate one raw Claude Agent SDK message into a normalized JammerEvent. */
function translate(msg: any): JammerEvent | null {
  switch (msg.type) {
    case "system": {
      if (msg.subtype === "init") {
        return {
          kind: "init",
          sessionId: msg.session_id || null,
          model: msg.model,
          tools: msg.tools,
          mcpServers: msg.mcp_servers,
        };
      }
      if (msg.subtype === "status") {
        return { kind: "status", status: msg.status || msg.subtype };
      }
      if (msg.subtype === "session_state_changed") {
        return { kind: "state", state: msg.state };
      }
      return null;
    }

    case "assistant": {
      const content = msg.message?.content || [];
      const blocks: JammerContentBlock[] = [];
      for (const block of content) {
        if (block.type === "text") {
          blocks.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use") {
          blocks.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
        }
      }
      return { kind: "assistant", blocks, parentToolUseId: msg.parent_tool_use_id || null };
    }

    case "stream_event": {
      const evt = msg.event;
      if (!evt) return null;
      if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
        return { kind: "partial_text", text: evt.delta.text, index: evt.index };
      }
      if (evt.type === "content_block_start" && evt.content_block?.type === "tool_use") {
        return { kind: "tool_start", id: evt.content_block.id, name: evt.content_block.name };
      }
      return null;
    }

    case "result":
      return {
        kind: "result",
        subtype: msg.subtype || "",
        text: msg.result || "",
        inputTokens: msg.usage?.input_tokens || 0,
        outputTokens: msg.usage?.output_tokens || 0,
        costUsd: msg.total_cost_usd || 0,
        numTurns: msg.num_turns || 0,
        durationMs: msg.duration_ms || 0,
        isError: msg.is_error || false,
      };

    case "tool_progress":
      return {
        kind: "tool_progress",
        toolUseId: msg.tool_use_id,
        toolName: msg.tool_name,
        elapsed: msg.elapsed_time_seconds,
      };

    default:
      return null;
  }
}
