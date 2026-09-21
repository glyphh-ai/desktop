/**
 * bridge-mode.ts — the Electron shell around the Bridge Mode listener
 * (app/docs/BRIDGE-MODE.md). Claude Desktop → this bridge → the gateway or a
 * headless `claude` on the member's own login. What lives here is only what
 * needs the app: who is signed in, the member's gateway credential, the loop
 * env `claude` runs in, the memory bridge's wrap, the IPC the renderer uses.
 *
 * WHEN IT RUNS. After sign-in, when the org forces it (plan gates
 * `forceBridge`), when the member turned it on (server-side preference
 * `bridgeModeEnabled`), or when the app was launched with `--bridge`. It stops
 * on sign-out, and sign-out revokes every token it minted. Nothing is written
 * to disk: keys, tokens and sessions are process memory, by the law.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { ipcMain } from "electron";
import { BridgeServer, type BridgeUsage } from "./bridge/server.js";
import { parseRows, type RoutingRow } from "./bridge/routing.js";
import { PERMISSION_FLAG, type SpawnOptions } from "./bridge/claude-session.js";
import type { Member } from "./bridge/oidc-local.js";
import { getAccountInfo, getHeartbeatInfo, isAuthenticated } from "./auth.js";
import { gatewayCreds } from "./gateway-token.js";
import { getClient } from "./glyphh-client.js";
import { bridgeWrap } from "./memory-bridge.js";
import { getPreference, setPreference } from "./stores/preferences-db.js";
import { accountLanePrefix, agentRowFor, ensureLoopEnv } from "./cli-agents.js";

export const BRIDGE_PORT = Number(process.env.GLYPHH_BRIDGE_PORT || 4747);
const ROUTING_TTL_MS = 30_000;
const ACTIVITY_CAP = 200;

let server: BridgeServer | null = null;
let forced = false;
let starting: Promise<void> | null = null;
const activity: string[] = [];
let routingCache: { at: number; rows: RoutingRow[] } | null = null;

const argvBridge = (): boolean => process.argv.includes("--bridge");

/** Bridge Mode is on for this member: the org forces it, they chose it, or the app was launched for it. */
export function bridgeWanted(): boolean {
  return forced || argvBridge() || getPreference<boolean>("bridgeModeEnabled", false) === true;
}

/** The app keeps running with its window closed: forced, or the member's own choice. */
export function bridgeBackground(): boolean {
  return forced || (bridgeWanted() && getPreference<boolean>("bridgeRunInBackground", false) === true);
}

export function bridgeForced(): boolean { return forced; }

function note(line: string): void {
  activity.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
  if (activity.length > ACTIVITY_CAP) activity.splice(0, activity.length - ACTIVITY_CAP);
  console.warn("[bridge]", line);
}

function member(): Member | null {
  const acct = getAccountInfo();
  const id = getHeartbeatInfo()?.user?.id;
  if (!acct || !id || !isAuthenticated()) return null;
  return { userId: String(id), email: acct.email, name: [acct.firstName, acct.lastName].filter(Boolean).join(" ") || null, orgSlug: acct.orgSlug ?? null };
}

async function routing(): Promise<RoutingRow[]> {
  if (routingCache && Date.now() - routingCache.at < ROUTING_TTL_MS) return routingCache.rows;
  try {
    const r = await getClient().gateway.routing();
    routingCache = { at: Date.now(), rows: parseRows(r.rows) };
  } catch (err) {
    note(`routing table unavailable: ${err instanceof Error ? err.message : String(err)}`);
    routingCache = routingCache ?? { at: Date.now(), rows: [] };
  }
  return routingCache.rows;
}

export function invalidateRouting(): void { routingCache = null; }

const q = (s: string): string => (/^[\w./=:-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

/** A headless `claude` on the member's own login, the bridge in its path for memory, tools per the row. */
function spawnClaude(opts: SpawnOptions): ChildProcessWithoutNullStreams {
  const row = agentRowFor("claude");
  const parts = [
    row?.cmd || "claude", "-p",
    "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--verbose",
    "--permission-mode", PERMISSION_FLAG[opts.permission],
    "--permission-prompt-tool", "stdio",
  ];
  if (opts.model) parts.push("--model", opts.model);
  if (opts.resume) parts.push("--resume", opts.resume);
  if (opts.appendSystem) parts.push("--append-system-prompt", opts.appendSystem.slice(0, 20_000));
  if (opts.chatOnly) parts.push("--disallowedTools", "Bash,Edit,Write,MultiEdit,NotebookEdit,Read,Glob,Grep,WebFetch,WebSearch,Task");
  const line = (row ? accountLanePrefix(row) : "") + parts.map(q).join(" ");
  return spawn(process.env.SHELL || "/bin/zsh", ["-lc", line], { cwd: homedir(), env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] });
}

async function reportUsage(u: BridgeUsage): Promise<void> {
  await getClient().gateway.reportBridgeUsage({ conversation: u.conversation, model: u.model, inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens, durationMs: u.durationMs });
}

async function start(): Promise<void> {
  if (server) return;
  const s = new BridgeServer({
    port: BRIDGE_PORT,
    member,
    gateway: () => gatewayCreds(),
    routing,
    forward: (upstream) => bridgeWrap(upstream, { folder: "claude-desktop" }),
    spawnClaude,
    reportUsage,
    onActivity: note,
  });
  try {
    await s.start();
    server = s;
    const row = agentRowFor("claude");
    if (row) await ensureLoopEnv(row).catch(() => undefined);
  } catch (err) {
    note(`bridge failed to start on port ${BRIDGE_PORT}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function stopBridge(): void {
  if (!server) return;
  server.revokeAll();
  server.stop();
  server = null;
  note("bridge stopped");
}

/** Start or stop to match what is wanted. Called after sign-in, when the org's gates move, and when the member flips the switch. */
export async function syncBridgeMode(gates?: { forceBridge?: unknown }): Promise<void> {
  if (gates) forced = gates.forceBridge === true;
  if (starting) await starting;
  const wanted = bridgeWanted() && isAuthenticated();
  if (wanted && !server) { starting = start(); await starting; starting = null; }
  else if (!wanted && server) stopBridge();
}

/** The member signed out: every Claude Desktop token dies with the sessions. */
export function bridgeSignedOut(): void {
  forced = false;
  routingCache = null;
  stopBridge();
}

export interface BridgeState {
  running: boolean; url: string; port: number; wanted: boolean; forced: boolean; background: boolean; enabled: boolean;
  member: string | null; sessions: number; clients: number; activity: string[];
}

export function bridgeState(): BridgeState {
  const st = server?.status();
  return {
    running: !!server, url: `http://127.0.0.1:${BRIDGE_PORT}`, port: BRIDGE_PORT, wanted: bridgeWanted(), forced, background: bridgeBackground(),
    enabled: getPreference<boolean>("bridgeModeEnabled", false) === true,
    member: st?.member ?? member()?.email ?? null, sessions: st?.sessions ?? 0, clients: st?.clients ?? 0, activity: [...activity],
  };
}

/** The shell line the terminal overlay runs: the Glyphh TUI in bridge mode, or a plain note when it is not installed. */
export function bridgeTuiCommand(): string {
  const url = `http://127.0.0.1:${BRIDGE_PORT}`;
  return `clear; if command -v glyphh >/dev/null 2>&1; then GLYPHH_BRIDGE_URL=${q(url)} glyphh --bridge; else echo "Glyphh bridge is running at ${url}"; echo "Point Claude Desktop's gateway and issuer at it. Install the Glyphh CLI for the TUI here: npm i -g @glyphh-ai/cli"; exec "$SHELL" -l; fi`;
}

export function registerBridgeModeIpc(): void {
  if (ipcMain.listenerCount("bridge-state")) return;
  ipcMain.handle("bridge-state", async () => bridgeState());
  ipcMain.handle("bridge-set-enabled", async (_e, on: boolean) => {
    setPreference("bridgeModeEnabled", on === true);
    await syncBridgeMode();
    return bridgeState();
  });
  ipcMain.handle("bridge-set-background", async (_e, on: boolean) => {
    setPreference("bridgeRunInBackground", on === true);
    return bridgeState();
  });
  ipcMain.handle("bridge-tui-command", async () => ({ ok: true, command: bridgeTuiCommand() }));
}
