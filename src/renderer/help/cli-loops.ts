/**
 * cli-loops.ts — THE LOOP CHOICES THE RENDERER MAKES, as pure rules.
 *
 * A session runs on a loop (Glyphh's own, or a vendor CLI the user signed in
 * to), in a view (the chat panel or the loop's own terminal), on a route
 * (the CLI's own login, or the local router with the user's providers), with
 * a model from that route's vocabulary. The composer's chips, the recents,
 * the workspace open and Settings all ask the same questions, so the answers
 * live here, with no DOM and no IPC, and the tests run them bare.
 *
 * Main decides the route again at launch (main/cli-route.ts resolveCliRoute)
 * — the renderer cannot import from main, so the rule is restated once here
 * and only ever used to paint what main will do.
 */

import type { CliId, CliRoute, CliRouteHints, SessionPermission, VendorCliId } from "./cli-types.js";
import { DEFAULT_LOOP } from "./cli-session-binding.js";

/**
 * An answer from a bridge door that may not be there: on the web every name
 * is a function and a desktop-only one answers undefined (not a promise), so
 * `door?.().catch(…)` would throw. Whatever comes back — a promise, a value,
 * nothing, a rejection — settles to the answer or the fallback.
 */
export function settle<A, F>(answer: PromiseLike<A> | A | undefined, fallback: F): Promise<NonNullable<A> | F> {
  return Promise.resolve(answer).then((v) => (v ?? fallback) as NonNullable<A> | F, () => fallback);
}

// ── the loops ────────────────────────────────────────────────────────────────

/** Glyphh first: it is the default loop, and every list shows it first. */
export const LOOP_IDS: readonly CliId[] = ["glyphh", "claude", "codex", "gemini", "cursor", "copilot"];
export const LOOP_NAMES: Record<CliId, string> = {
  glyphh: "Glyphh", claude: "Claude", codex: "Codex", gemini: "Gemini", cursor: "Cursor", copilot: "Copilot",
};
export const isLoopId = (v: unknown): v is CliId => typeof v === "string" && (LOOP_IDS as readonly string[]).includes(v);
export const isVendorLoop = (v: unknown): v is VendorCliId => isLoopId(v) && v !== "glyphh";

/** One line under each loop's name in the pickers. */
export const LOOP_BLURBS: Record<CliId, string> = {
  glyphh: "Glyphh's own loop, on the models you set up.",
  claude: "Claude Code, on your Claude login or your providers.",
  codex: "OpenAI's Codex CLI, on your ChatGPT login.",
  gemini: "Google's Gemini CLI, on your Google login.",
  cursor: "Cursor's agent CLI, on your Cursor login.",
  copilot: "GitHub Copilot CLI, on your GitHub login.",
};

// ── preferences ──────────────────────────────────────────────────────────────

/** Settings › General: the loop a new session opens on. */
export const DEFAULT_LOOP_PREF = "defaultLoop";
/** Settings › General: the face an agent opens with ("chat" | "terminal" | "last"). */
export const DEFAULT_VIEW_PREF = "defaultLoopView";
/** Settings › General: route the CLIs through the user's providers by default. */
export const CLI_GATEWAY_PREF = "cliGateway";
/** UI state: the face the user last left an agent on (what "last" reads). */
export const AGENT_LAST_VIEW_KEY = "agentLastView";

/**
 * The loop a session opens on when it names none: the member's default when
 * that loop is still turned on, else Glyphh — never a loop that cannot run.
 */
export function defaultLoopOf(pref: unknown, enabled: readonly string[]): string {
  const p = typeof pref === "string" ? pref.trim() : "";
  return p && enabled.includes(p) ? p : DEFAULT_LOOP;
}

/**
 * The loop a session starts on in a workspace: the agent cell's own, then the
 * workspace's, then the member's default. A loop that is turned off (or
 * unknown) at any level is passed over rather than opened and refused.
 */
export function resolveStartLoop(cellLoop: string | null | undefined, layoutLoop: string | null | undefined, defaultLoop: string, enabled: readonly string[]): string {
  for (const v of [cellLoop, layoutLoop]) {
    const id = String(v ?? "").trim();
    if (id && enabled.includes(id)) return id;
  }
  return enabled.includes(defaultLoop) ? defaultLoop : DEFAULT_LOOP;
}

// ── the view ─────────────────────────────────────────────────────────────────

/** The face an agent opens with. Workspaces store it as "glyphh" | "cli". */
export type AgentView = "chat" | "terminal";
export type DefaultViewPref = AgentView | "last";

export const defaultViewOf = (v: unknown): DefaultViewPref => (v === "chat" || v === "terminal" ? v : "last");

/** A stored workspace view ("glyphh" | "cli") as a face; anything else has no opinion. */
export function storedView(v: unknown): AgentView | null {
  return v === "glyphh" ? "chat" : v === "cli" ? "terminal" : null;
}
/** A face as a workspace stores it. */
export const toStoredView = (v: AgentView): "glyphh" | "cli" => (v === "chat" ? "glyphh" : "cli");

/**
 * WHICH FACE AN AGENT OPENS WITH. The most specific setting wins: the agent's
 * own workspace cell, then the workspace, then the member's default, and only
 * when that says "last", the face the user last left an agent on. Nothing at
 * all is the chat — the panel every loop has.
 */
export function resolveAgentView(cellView: unknown, layoutView: unknown, pref: unknown, lastView: unknown): AgentView {
  const cell = storedView(cellView);
  if (cell) return cell;
  const layout = storedView(layoutView);
  if (layout) return layout;
  const p = defaultViewOf(pref);
  if (p !== "last") return p;
  return lastView === "terminal" ? "terminal" : "chat";
}

// ── the route ────────────────────────────────────────────────────────────────

/** What the route rules need to know about a loop (a `cli-agents-list` row). */
export interface RouteLoop { cli: string; name?: string; gatewayCapable: boolean }

/** A workspace's stored "on" | "off" as a hint; anything else has no opinion. */
export function gatewayHintOf(v: unknown): boolean | null {
  return v === "on" ? true : v === "off" ? false : null;
}
/** A hint as a workspace stores it; null leaves the choice to the next level. */
export const toStoredGateway = (v: boolean | null): "on" | "off" | null => (v === true ? "on" : v === false ? "off" : null);

/**
 * The route a turn on this loop takes: the session's pick, then the
 * workspace cell's, then the workspace's, then the member's default — and the
 * gateway only on a loop the router can carry, with a chat model it can call.
 * Main applies the same rule at launch; this one paints the chip.
 */
export function resolveRoute(loop: RouteLoop | undefined, hints: CliRouteHints | undefined, prefDefault: boolean, gatewayReady: boolean): CliRoute {
  if (!loop || loop.cli === "glyphh" || !loop.gatewayCapable || !gatewayReady) return "direct";
  const pick = [hints?.session, hints?.cell, hints?.layout].find((v): v is boolean => typeof v === "boolean");
  return (pick ?? prefDefault) ? "gateway" : "direct";
}

/**
 * Why the gateway cannot be picked on this loop right now, in the words the
 * greyed control shows; null when it can. Glyphh has no route to pick: it
 * always runs on the user's providers.
 */
export function gatewayBlockedWhy(loop: RouteLoop | undefined, gatewayReady: boolean): string | null {
  if (!loop || loop.cli === "glyphh") return "Glyphh always runs on your own providers.";
  const name = loop.name || LOOP_NAMES[loop.cli as CliId] || loop.cli;
  if (!loop.gatewayCapable) return `${name} only talks to its own service. The gateway carries Claude today.`;
  if (!gatewayReady) return "Add a chat model in Settings › Models";
  return null;
}

export const ROUTE_LABELS: Record<CliRoute, string> = { direct: "Direct", gateway: "Gateway" };
export const ROUTE_HINTS: Record<CliRoute, string> = {
  direct: "The CLI on its own login and account.",
  gateway: "The CLI on your own providers, through Glyphh's local router.",
};

// ── the model ────────────────────────────────────────────────────────────────

/** One model a loop can be asked for; "" is the CLI's own default. */
export interface CliModelChoice { id: string; name: string }

export const CLI_DEFAULT_MODEL_LABEL = "Default (the CLI's own)";

/**
 * THE NAMES EACH CLI'S OWN LOGIN TAKES on its --model flag, kept short and
 * conservative: the aliases and names the CLIs document. Anything beyond
 * these is set as the loop's model in Settings › Loops, which takes any name.
 */
export const CLI_MODELS: Record<VendorCliId, readonly CliModelChoice[]> = {
  // Claude Code's aliases always resolve to the newest model of that family.
  claude: [
    { id: "opus", name: "Opus" },
    { id: "sonnet", name: "Sonnet" },
    { id: "haiku", name: "Haiku" },
  ],
  codex: [
    { id: "gpt-5.5", name: "GPT-5.5" },
    { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
    { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
  ],
  gemini: [
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
  ],
  cursor: [
    { id: "gpt-5", name: "GPT-5" },
    { id: "sonnet-4-thinking", name: "Sonnet 4 Thinking" },
  ],
  // "auto" lets Copilot pick per turn (copilot --help).
  copilot: [
    { id: "auto", name: "Auto" },
  ],
};

/** A CLI's own model list, its default first. */
export function cliModelChoices(cli: string): CliModelChoice[] {
  const own = isVendorLoop(cli) ? CLI_MODELS[cli] : [];
  return [{ id: "", name: CLI_DEFAULT_MODEL_LABEL }, ...own];
}

/**
 * Whose vocabulary the model picker speaks: the router's chat models (Glyphh,
 * and any CLI on the gateway) or the CLI's own names (a CLI on its login).
 */
export type ModelLane = "router" | "cli";
export function modelLaneOf(cli: string, route: CliRoute): ModelLane {
  return isVendorLoop(cli) && route === "direct" ? "cli" : "router";
}

/**
 * Where a session keeps its pick for a lane. The router pick stays under
 * "default" (the slot every older session already has); each CLI's own pick
 * gets its own key, so flipping a route never sends a router id to a CLI
 * login or a CLI alias to the router.
 */
export function modelSlotOf(lane: ModelLane, cli: string): string {
  return lane === "cli" ? `direct:${cli}` : "default";
}

// ── the session's mode ───────────────────────────────────────────────────────

const ALL_MODES: readonly SessionPermission[] = ["ask", "plan", "acceptEdits", "auto"];

/** The modes a loop can honor (its row's `modes`); a row not loaded yet offers every mode. */
export function modesOf(loop: { modes?: readonly string[] } | undefined): SessionPermission[] {
  const m = (loop?.modes ?? []).filter((x): x is SessionPermission => (ALL_MODES as readonly string[]).includes(x));
  return m.length ? m : [...ALL_MODES];
}

/**
 * A mode the loop cannot honor is not a mode: the session moves to the
 * nearest one it can — asking where the loop can ask, else its first mode —
 * so the chip never says one thing while the turn sends another.
 */
export function coerceMode(mode: SessionPermission, allowed: readonly SessionPermission[]): SessionPermission {
  if (allowed.includes(mode)) return mode;
  return allowed.includes("ask") ? "ask" : allowed[0] ?? "ask";
}

// ── the hop back from the terminal ───────────────────────────────────────────

/** A CLI session as the recents list carries it. */
export interface HopSession { id: string; cwd: string; mtime?: number; cli?: string }

const normDir = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");

/**
 * The sessions the hop back to chat may adopt, newest first: this loop's own
 * CLI only, in the terminal's own folder first, else the loop's folder, else
 * every one of them. A CLI's store holds every session on the machine; the
 * folder is what keeps an unrelated one from being adopted.
 */
export function scopedHopSessions<T extends HopSession>(rows: readonly T[], cli: string, folders: ReadonlyArray<string | undefined>): T[] {
  const mine = rows.filter((r) => !r.cli || r.cli === cli).sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
  for (const f of folders) {
    if (!f) continue;
    const inScope = mine.filter((r) => normDir(r.cwd) === normDir(f));
    if (inScope.length) return inScope;
  }
  return mine;
}

/** The >_ hop that left a chat for the terminal: which chat ("" = a new one) and when. */
export interface CliHop { chatId: string; at: number }

/** What the hop back to chat does. */
export type HopBack =
  | { kind: "adopt"; sessionId: string; chatId?: string }
  | { kind: "open"; chatId: string }
  | { kind: "new" };

/** Clock slack between the terminal's write and the hop's stamp. */
const HOP_SLACK_MS = 2000;

/**
 * BACK TO THE CHAT YOU LEFT. The terminal's newest session lands in that chat
 * only when it was written after the hop (a terminal nobody typed in adopts
 * nothing); a hop from a new chat comes back to a new chat, adopting the
 * terminal's session only if one was made; with no hop at all, the newest
 * session in scope is adopted, else a new chat opens.
 */
export function hopBack(newest: HopSession | undefined, hop: CliHop | null, chatExists: (id: string) => boolean): HopBack {
  const typedSince = !!newest && !!hop && (newest.mtime ?? 0) >= hop.at - HOP_SLACK_MS;
  if (hop?.chatId && chatExists(hop.chatId)) {
    return typedSince && newest ? { kind: "adopt", sessionId: newest.id, chatId: hop.chatId } : { kind: "open", chatId: hop.chatId };
  }
  if (hop) return typedSince && newest ? { kind: "adopt", sessionId: newest.id } : { kind: "new" };
  return newest ? { kind: "adopt", sessionId: newest.id } : { kind: "new" };
}

// ── Settings › Loops ─────────────────────────────────────────────────────────

export const PERMISSION_LABELS: Record<"safe" | "ask" | "auto", string> = {
  safe: "Safe — read and plan only",
  ask: "Ask — every action asks first",
  auto: "Auto — runs without asking",
};
export const SESSION_LABELS: Record<"keep" | "new" | "last", string> = {
  keep: "Keep the open session",
  new: "Start a new session",
  last: "Resume the CLI's last session",
};
