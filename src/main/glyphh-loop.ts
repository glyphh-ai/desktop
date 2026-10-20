/**
 * glyphh-loop.ts — THE GLYPHH LOOP in the desktop (his order, 2026-09-21): our
 * own agent loop, a supported loop beside claude/codex/gemini, on ANY model the
 * gateway serves. The ENGINE is the SDK's (`@glyphh/sdk/loop`, one loop for
 * every host — the `glyphh` CLI runs the same class); this file is the
 * desktop's seat: the member's gateway credential, the app's local MCP server
 * and the gateway's connection tools lent as MCP servers, memory read and
 * written natively (memory.ts, since the bridge went), and the loop's events
 * sent to the Agent panel on the renderer channels it listens to
 * (glyphh-agent:setup/delta/tool/approval/progress/permission/done/error).
 *
 * State is process memory (nothing of ours on disk); the chat re-seeds from the
 * renderer's stored turns after a restart and is forgotten on sign-out.
 */

import type { WebContents } from "electron";
import { GlyphhLoop, LOOP_EFFORTS, type LoopAgentDef, type LoopCatalogEntry, type LoopEvent, type LoopMcpServer, type LoopPermission, type LoopSkill, type SeedTurn } from "@glyphh/sdk/loop";
import { createHash } from "node:crypto";
import { listSkills } from "./skills-fs.js";
import { callInstanceTool, listInstanceTools } from "./app-instances.js";
import { callConnectionTool, connectionSources, listConnectionTools } from "./mcp-connections.js";
import { connectionCatalogEntries } from "./connection-catalog.js";
import { preferencesByPrefix } from "./stores/preferences-db.js";
import { createRouterFetch } from "@glyphh/sdk/router";
import { routerConfig, routerCreds } from "./providers.js";
import { memoryFacts, memoryCapture } from "./memory.js";
import { loopArtifacts } from "./loop-artifacts.js";
import { startLocalMcpServer, localMcpStatus, localMcpGenToken } from "./local-mcp-server.js";
import { connectionsAvailable, defaultChatModel, modelRef } from "./org-models.js";
import { listAgents, onAgentsChanged } from "./local-agents.js";
import { getWorkingDirectory } from "./working-directory.js";
import { onModelStateChanged } from "./model-watch.js";
import { agentLive, noteRunDelta, registerRunRebinder } from "./agent-live.js";
import { frameTargets, isRelaySink } from "./attach-run-frames.js";
import { openRing, recordFrame } from "./attach-run-ring.js";
import { attachmentImageRefs, attachmentPromptBlock, validAttachments, type AttachRef } from "./glyphh-agent-attachments.js";
import { commitBackgroundTurn } from "./agent-ipc.js";
import { lendSplit } from "./mcp-lend.js";
import { UNATTENDED_HIDDEN, UNATTENDED_MCP_PATH, isScreenFamily } from "./unattended-tools.js";
import { mineSync as tabRows } from "./apps-store.js";
import { dispatchRelayMethod } from "./relay-client.js";
import { commandToolSpec, rpaOf, sequenceToolSpec } from "../shared/rpa.js";

export type { LoopPermission };

export interface LoopRunPayload {
  chatId: string;
  permission?: LoopPermission;
  model?: string;
  /** The composer's effort dial (his order, 2026-10-04). Any name the SDK
   *  does not know is ignored, and the turn runs on the chat's last effort. */
  effort?: string;
  workdir?: string;
  workspace?: string;
  /** The chat's stored turns, to seed a conversation this process has not seen. */
  history?: SeedTurn[];
  /** What the composer attached: images ride as vision blocks, files and
   *  folders as a manifest the loop's read tools open. */
  attachments?: AttachRef[];
}

/**
 * THE FIXED BELTS (his order, 2026-09-29: "this list of tools can get massive
 * with connections also. So how should we handle this for scale?").
 *
 * What rides every message is the SAME SIZE however much is installed or
 * connected: the file and shell builtins (Code), these few Glyphh tools, and
 * the engine's find_tools / call_tool pair. Everything else — tasks,
 * schedules, memory, layouts, tabs, agents, each installed app's tools, the
 * member's own MCP connections, every connected account — is in the catalog,
 * found by search and run by name (@glyphh/sdk/loop catalog.ts). It is the
 * desktop's design before the rebuild (per-mode packs, 8802425b; the
 * find_tools escape hatch, 095dcf48; search-first connectors, aef8d0f6).
 */
// ONE BELT (his order, 2026-10-08: "just code"): the one type's belt is the
// union of what the two carried.
const CORE_BELT: ReadonlySet<string> = new Set(["panels_open", "panels_list", "panels_close", "panels_available", "rpa_read", "rpa_screenshot", "settings_open", "skill_get"]);
const CORE: Readonly<{ work: ReadonlySet<string>; code: ReadonlySet<string> }> = { work: CORE_BELT, code: CORE_BELT };

const safe = (s: string): string => s.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
const asText = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

/** Each installed app's tools, and each connection's tools (the member's own
 *  MCP servers and connected Pipedream apps), as catalog entries. A connection
 *  that will not answer in a few seconds simply has no entries this time; an
 *  unattended run carries only the connection tools set to Always allow. */
async function catalogEntries(unattended = false): Promise<LoopCatalogEntry[]> {
  const out: LoopCatalogEntry[] = [];
  const apps = await listInstanceTools().catch(() => []);
  for (const a of apps) {
    for (const t of a.tools) {
      out.push({
        name: safe(`${a.app}_${t.name}`), description: (t.description || `${a.name}: ${t.name}`).slice(0, 1000), family: `app: ${a.name}`,
        ...(t.inputSchema ? { inputSchema: t.inputSchema } : {}),
        run: async (args) => {
          try { return { text: asText(await callInstanceTool(a.app, t.name, args)), failed: false }; }
          catch (err) { return { text: err instanceof Error ? err.message : String(err), failed: true }; }
        },
      });
    }
  }
  // RPA ON A TAB (his order, 2026-10-07): every command mapped on a saved tab,
  // and every sequence, is a tool of its own, <tab>_<key>, that drives the
  // tab's panel on screen. The family is the tab, so "do X in Gmail" finds it.
  for (const row of tabRows()) {
    const cfg = rpaOf(row.config);
    const call = (method: string, params: Record<string, unknown>) => async () => {
      try { return { text: asText(await dispatchRelayMethod(method, params)), failed: false }; }
      catch (err) { return { text: err instanceof Error ? err.message : String(err), failed: true }; }
    };
    for (const cmd of Object.values(cfg.commands)) {
      const spec = commandToolSpec(row.slug, cmd);
      out.push({
        name: spec.name, description: spec.description, family: `rpa: ${row.name}`, inputSchema: spec.inputSchema, readOnly: spec.readOnly,
        run: async (args) => call("rpa.run", { app: row.slug, command: cmd.key, ...(args.value !== undefined ? { value: String(args.value) } : {}) })(),
      });
    }
    for (const seq of Object.values(cfg.sequences)) {
      const spec = sequenceToolSpec(row.slug, seq);
      out.push({
        name: spec.name, description: spec.description, family: `rpa: ${row.name}`, inputSchema: spec.inputSchema,
        run: async (args) => call("rpa.sequenceRun", { app: row.slug, sequence: seq.name, args })(),
      });
    }
  }
  if (connectionsAvailable()) {
    const conns = await Promise.race([
      listConnectionTools().catch(() => []),
      new Promise<[]>((res) => setTimeout(() => res([]), 5000)),
    ]);
    out.push(...connectionCatalogEntries(conns, callConnectionTool, unattended));
  }
  return out;
}

/** The member's enabled skills, for the prompt's index (read with skill_get). */
async function skillIndex(): Promise<LoopSkill[]> {
  try {
    return listSkills("skill")
      // Not the house "glyphh" skill: it is written for OUTSIDE clients over MCP
      // (relay_ping, app_list_tools, connector_call) and would steer the loop to
      // tools it no longer carries. The loop's own prompt says how Glyphh works.
      .filter((sk) => sk.enabled && sk.id.slice(sk.id.indexOf(":") + 1) !== "glyphh")
      .map((sk) => ({ slug: sk.id.slice(sk.id.indexOf(":") + 1), name: sk.name, description: sk.description }));
  } catch { return []; }
}

/** WHAT IS INSTALLED, as one fingerprint: a skill, app, task or plugin added,
 *  removed, edited or switched, or a connection added or turned off, changes
 *  it, and the next turn of every chat rebuilds its belt and catalog. Read at
 *  each turn, so every way in (Discover, skill_save, a folder dropped in,
 *  the Skills page) is covered by the same check. */
let lastLibrary = "";
function libraryChanged(): boolean {
  let sig = "";
  try {
    const skills = listSkills(["skill", "task", "plugin"]).map((sk) => `${sk.id}:${sk.updatedAt}:${sk.enabled ? 1 : 0}`).sort();
    // A connection on or off, a Pipedream app connected or removed, or a
    // tool's permission changed all change what the catalog carries.
    const conns = connectionSources().map((c) => `${c.connection}:${c.hidden.join(",")}`).sort();
    conns.push(JSON.stringify(preferencesByPrefix("connToolModes:")));
    // A tab's RPA mapping changed (a command mapped, a sequence saved) → the
    // catalog carries a new tool; the tab rows ride the fingerprint for it.
    const tabs = tabRows().map((t) => `${t.slug}:${t.updatedAt}`).sort();
    sig = createHash("sha1").update([...skills, "|", ...conns, "|", ...tabs].join("\n")).digest("hex");
  } catch { return false; }
  if (sig === lastLibrary) return false;
  const first = lastLibrary === "";
  lastLibrary = sig;
  return !first;
}

/** The servers this desktop lends a run: the app's own local MCP (this
 *  machine's windows, folders and loopback apps) and the gateway's /mcp (the
 *  member's library, the cloud clock, the app instances on the farm, the
 *  connected accounts' lookup pair). The names collide by design and
 *  mcp-lend.ts says who answers which; with the connections lane off neither
 *  side lends anything that bills through Pipedream. */
async function mcpServers(): Promise<LoopMcpServer[]> { return mcpServersFor(false); }
/** The servers lent to a chat — or to an UNATTENDED run (his report,
 *  2026-10-08: "the terminal window keeps randomly showing up"): the local
 *  server's unattended door, with every tool that touches the screen left
 *  out, so a schedule or a task slot can never open a panel. */
async function mcpServersFor(unattended: boolean): Promise<LoopMcpServer[]> {
  const out: LoopMcpServer[] = [];
  const connections = connectionsAvailable();
  const local = await startLocalMcpServer().then(() => localMcpStatus().port).catch((err) => {
    console.warn("[glyphh-loop] local MCP unavailable:", err instanceof Error ? err.message : err);
    return 0;
  });
  // No Glyphh server: the app's own local MCP server is the only one lent.
  const split = lendSplit({ localUp: local > 0, gatewayUp: false, connections, belt: new Set(CORE_BELT) });
  if (local > 0) {
    const token = localMcpGenToken(unattended ? "glyphh-loop-unattended" : "glyphh-loop", 365).token;
    out.push({
      name: "glyphh-app", url: `http://127.0.0.1:${local}${unattended ? UNATTENDED_MCP_PATH : "/mcp"}`,
      headers: { Authorization: `Bearer ${token}` }, tag: "Glyphh", core: CORE,
      allow: unattended ? (t: string) => split.local(t) && !UNATTENDED_HIDDEN.has(t) : split.local,
    });
  }
  return out;
}

/**
 * THE MEMBER'S OWN AGENTS, as definitions the loop can spawn (his order,
 * 2026-09-29: "I just want the local agent to spawn sub-agents for now based on
 * definitions the user can create with model slots running our full agent
 * loop").
 *
 * These are the agent records that already exist — a name, a standing prompt
 * and a model slot (local-agents.ts) — so a member defines a sub-agent where
 * they always defined an agent, and nothing new has to be invented or stored.
 * An agent with no prompt is not a brief, and the engine drops it; a member
 * with no agents gets no spawn tool at all.
 *
 * (The CLI agents went on 2026-10-08: every agent runs on this loop.)
 */
async function agentDefs(): Promise<LoopAgentDef[]> {
  try {
    return listAgents()
      .filter((a) => String(a.prompt || "").trim())
      .map((a) => ({
        slug: a.slug,
        name: a.name || a.slug,
        description: a.description || "",
        prompt: a.prompt,
        // Its own model, bare (records hold catalog ids); empty runs it on the
        // parent's model, which is the honest default for "no slot chosen".
        ...(modelRef(a.model ?? "") ? { model: modelRef(a.model) } : {}),
      }));
  } catch (err) {
    console.warn("[glyphh-loop] agent roster unreadable:", err instanceof Error ? err.message : err);
    return [];
  }
}

/** Every model call the loop makes goes through the router, which reads the
 *  user's providers per call (providers.ts), so a key saved in Settings applies
 *  to the next turn. Any other request (an MCP server) passes straight through. */
const routerFetch = createRouterFetch(routerConfig);

/** How long the last memory recall took — part of the turn timing line. */
let lastFactsMs = 0;
const loop = new GlyphhLoop({
  host: "desktop",
  gateway: routerCreds,
  fetch: routerFetch,
  mcpServers,
  agents: agentDefs,
  catalog: catalogEntries,
  skills: skillIndex,
  facts: async (text, scope) => { const t0 = Date.now(); try { return await memoryFacts(text, scope); } finally { lastFactsMs = Date.now() - t0; } },
  capture: memoryCapture,
  artifacts: loopArtifacts,
  warn: (m) => console.warn(m),
});
/** THE UNATTENDED LOOP (his report, 2026-10-08): every headless run — a
 *  schedule, a task slot's turn, skill_run — runs here, on the local server's
 *  unattended door and a catalog without the tabs' RPA tools, so nothing a
 *  clock starts can open a panel, a workspace, Settings or a terminal. */
const unattendedLoop = new GlyphhLoop({
  host: "desktop",
  gateway: routerCreds,
  fetch: routerFetch,
  mcpServers: () => mcpServersFor(true),
  agents: agentDefs,
  catalog: async () => (await catalogEntries(true)).filter((e) => !isScreenFamily(e.family)),
  skills: skillIndex,
  facts: async (text, scope) => { const t0 = Date.now(); try { return await memoryFacts(text, scope); } finally { lastFactsMs = Date.now() - t0; } },
  capture: memoryCapture,
  artifacts: loopArtifacts,
  warn: (m) => console.warn(m),
});
// An agent made or removed anywhere is on the next turn of every open chat.
onAgentsChanged(() => { loop.invalidateTools(); unattendedLoop.invalidateTools(); });
// THE CONNECTIONS LANE MOVED (the first connection added, or the last one
// removed): the next run lends, or withholds, the connection tools.
let connectionsLent = connectionsAvailable();
onModelStateChanged((c) => {
  if (c.connectionsOn === connectionsLent) return;
  connectionsLent = c.connectionsOn;
  loop.invalidateTools();
  unattendedLoop.invalidateTools();
});

/** The stored-turn count the engine last seeded from, per chat: a jump of more
 *  than one exchange means another host (the terminal) wrote turns into the
 *  shared store, so the engine's copy is stale and re-seeds from the history. */
const seenTurns = new Map<string, number>();
/** Where each chat's frames go — the panel that started the turn, until
 *  another panel adopts the run (agent-live.ts re-points it here). */
const loopSenders = new Map<string, WebContents>();
registerRunRebinder((chatId, sender, opts) => {
  if (!loop.has(chatId)) return { rebound: false, previous: null };
  const previous = loopSenders.get(chatId) ?? null;
  // Orphans only: a live holder keeps its run (the panel that shows it is not
  // robbed by a sibling's ledger retry); a destroyed one (workspace jump
  // closed the panel) hands the frames to whoever asks.
  if (opts.orphanOnly && previous && previous !== sender && !previous.isDestroyed()) return { rebound: false, previous };
  loopSenders.set(chatId, sender);
  return { rebound: true, previous };
});

export function glyphhLoopHas(chatId: string): boolean { return loop.has(chatId); }
export const isGlyphhApproval = (id: string): boolean => GlyphhLoop.isApproval(id);

export async function runGlyphhLoopTurn(sender: WebContents, p: LoopRunPayload, text: string): Promise<{ runId: string }> {
  // The model the panel picked, else the one the org requires; the engine
  // refuses in its own words when neither names one. With neither (or no plan
  // on record) the org's answer is read fresh first: a person who just signed
  // up, or just bought a plan, must not be judged on the last account's gates.
  const model = modelRef(p.model ?? "") || defaultChatModel();
  const n = p.history?.length ?? 0;
  const prev = seenTurns.get(p.chatId);
  if (prev !== undefined && n - prev > 2) loop.forget(p.chatId);
  seenTurns.set(p.chatId, n);
  // THE LEDGER IS MARKED FROM THE STREAM (his report, 2026-09-29: "the left
  // rail should show the flashing green dot"). It used to be marked AFTER
  // `await loop.run(...)` — but the engine's run resolves when the turn is
  // OVER, so a running turn was never on the ledger at all and no other
  // surface could show it. The engine's own events are the truth:
  //
  //   setup    → working (green): the turn has a model and is on the wire
  //   approval → waiting (yellow): it is on the person now
  //   delta    → working: the person answered and it is moving again
  //   error    → error (red): kept after done, so an idle row can still say so
  //   done     → clear (grey), unless the turn failed
  loopSenders.set(p.chatId, sender);
  const clock = { start: Date.now(), ready: 0, first: 0 };
  // The ledger names the CURRENT holder of the frames, not the panel that
  // started the turn: after an adoption every delta used to write the old
  // sender back, so the rail fronted the wrong (or a dead) panel.
  const holderId = (): number => (loopSenders.get(p.chatId) ?? sender).id;
  const mark = (status: "working" | "waiting" | "error", runId: string): void => {
    if (status === "working" && !agentLive.list().some((r) => r.chatId === p.chatId && r.status !== "error")) {
      agentLive.start({ chatId: p.chatId, cliSessionId: p.chatId, cli: "glyphh", runId, senderId: holderId() });
      return;
    }
    agentLive.update(p.chatId, { status, runId, senderId: holderId() });
  };
  // The turn's own words, for a done nobody is listening to (below).
  let answer = "";
  let ringStarted = false;
  const emit = (ev: LoopFrame): void => {
    const { type, ...payload } = ev;
    // A SUB-AGENT'S WORDS ARE NOT THE ANSWER (his order, 2026-09-29): a child's
    // deltas are its own feed, so they must never join the parent's reply or
    // the turn's committed text — the person would read the swarm's thinking
    // spliced into one answer.
    const child = !!ev.agent;
    if (type === "setup") { mark("working", ev.runId); clock.ready ||= Date.now(); }
    else if (type === "approval") mark("waiting", ev.runId);
    else if (type === "error" && !child) mark("error", ev.runId);
    if (type === "done") {
      const now = Date.now();
      console.warn(`[loop] turn ${p.chatId}: ready=${clock.ready ? clock.ready - clock.start : -1}ms first=${clock.first ? clock.first - clock.start : -1}ms total=${now - clock.start}ms facts=${lastFactsMs}ms`);
      agentLive.done(p.chatId, ev.runId);
    }
    else if (type === "delta" && !child) {
      const d = String((payload as { delta?: string }).delta ?? "");
      clock.first ||= Date.now();
      answer += d;
      noteRunDelta(p.chatId, d);
      mark("working", ev.runId);
    }
    const to = loopSenders.get(p.chatId) ?? sender;
    // NOBODY IS LISTENING (his order, 2026-09-29): the panel that started this
    // turn is gone, so the renderer that would have committed the answer on
    // `done` no longer exists. Main writes it into the shared store instead —
    // the thread kept working and the conversation shows it.
    if (type === "done" && (!to || to.isDestroyed())) commitBackgroundTurn(p.chatId, answer);
    if (type === "done") loopSenders.delete(p.chatId);
    // The chat id IS the terminal's session id: the panel binds it per CLI, and
    // the >_ hop opens `glyphh --resume <id>` on the same conversation.
    const extra = type === "setup" ? { cliSessionId: p.chatId } : {};
    // A relayed turn's originator (the web, the phone) keeps its frames even
    // after a desktop panel adopts the thread (attach-run-frames.ts frameTargets).
    for (const target of frameTargets(sender, to)) {
      try { if (!target.isDestroyed()) target.send(`glyphh-agent:${type}`, { ...payload, ...extra }); } catch { /* window closed */ }
    }
    // EVERY TURN HAS A RING (his report, 2026-10-08): a turn a desktop panel
    // started had no frames off the machine, so the web page watching the same
    // thread saw nothing until the thread synced at the end. A relayed turn's
    // sink writes its own ring; a panel's turn is recorded here, prompt first.
    if (!isRelaySink(sender)) {
      if (!ringStarted) { ringStarted = true; openRing(ev.runId, p.chatId); recordFrame(ev.runId, p.chatId, "glyphh-agent:prompt", { text }); }
      recordFrame(ev.runId, p.chatId, `glyphh-agent:${type}`, { ...payload, ...extra });
    }
  };
  // ATTACHMENTS (the composer's paperclip, paste and drop). Images always
  // become real vision blocks; a file rides as a path manifest its read tools
  // open themselves, which beats pouring a large file into every turn.
  // A FREE ORG RUNS TOO (his order, 2026-10-04): the server lists only the
  // free-plan models for it, and the gateway refuses any other with a 402 the
  // panel draws as the plan card. Nothing is judged here before the model.
  // Something installed or removed since the last turn: every chat rebuilds its belt.
  if (libraryChanged()) { loop.invalidateTools(); unattendedLoop.invalidateTools(); }
  const atts = validAttachments(p.attachments);
  const files = atts.filter((a) => a.kind !== "image");
  const manifest = attachmentPromptBlock(files);
  const images = attachmentImageRefs(atts).map((im) => ({ type: "image" as const, source: { type: "base64" as const, media_type: im.mediaType, data: im.data } }));
  const effort = LOOP_EFFORTS.find((e) => e === p.effort);
  const started = await loop.run({
    chatId: p.chatId, text: [text, manifest].filter(Boolean).join("\n\n"), model,
    ...(images.length ? { images } : {}),
    ...(effort ? { effort } : {}),
    ...(p.permission ? { permission: p.permission } : {}),
    ...(p.workdir ? { workdir: p.workdir } : {}),
    ...(p.workspace ? { workspace: p.workspace } : {}),
    ...(p.history ? { history: p.history } : {}),
  }, emit);
  return started;
}

/** One engine event as the host sees it: the run it belongs to, and the
 *  sub-agent it came from when it is a child's. */
export type LoopFrame = LoopEvent & { runId: string; agent?: { childId: string; slug: string; name: string; model: string } };

/**
 * A TURN WITH NO PANEL — a schedule firing, a skill run, a task's slot (his
 * order, 2026-09-28: unattended work used to shell out to a vendor CLI; now it
 * rides the same loop the panel does). The answer comes back as text.
 *
 * Unattended means no one can answer an approval, so the run is `auto`: the
 * user put this program on a clock, and a prompt nobody can see would just
 * hang it. The thread is forgotten as soon as it answers.
 */
export async function runGlyphhHeadless(
  prompt: string,
  opts: { model?: string; workdir?: string } = {},
): Promise<{ ok: boolean; text: string; error?: string }> {
  const chatId = `headless-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let text = "";
  let error = "";
  try {
    await unattendedLoop.run({
      chatId, text: prompt, model: modelRef(opts.model ?? "") || defaultChatModel(), permission: "auto",
      // ONE TYPE (2026-10-08): a run with no folder of its own works in the
      // member's working folder (the set folder, else home).
      workdir: opts.workdir || getWorkingDirectory(),
    }, (ev) => {
      if (ev.type === "delta") text += String((ev as { delta?: string }).delta ?? "");
      else if (ev.type === "error") error = String((ev as { error?: string }).error ?? "");
    });
  } finally {
    unattendedLoop.forget(chatId);
  }
  return error ? { ok: false, text, error } : { ok: true, text };
}

export function stopGlyphhLoop(chatId: string): boolean { return loop.stop(chatId); }
/** The chat's spend so far, for the composer's context meter. */
export function glyphhLoopUsage(chatId: string): { inTokens: number; outTokens: number; cacheRead: number } { return loop.usage(chatId); }
/** /compact from the composer: the model summarizes and the chat continues. */
export function compactGlyphhLoop(chatId: string): Promise<{ ok: boolean; error?: string }> { return loop.compactNow(chatId); }
export function setGlyphhLoopPermission(chatId: string, permission: LoopPermission): boolean { return loop.setPermission(chatId, permission); }
export function respondGlyphhApproval(id: string, allow: boolean): boolean { return loop.respondApproval(id, allow); }

/** Sign-out: nothing of the last member's conversations stays in memory. */
export function forgetGlyphhLoops(): void { loop.forgetAll(); seenTurns.clear(); }
