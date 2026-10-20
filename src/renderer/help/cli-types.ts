/**
 * cli-types.ts — renderer-side mirrors of the loops' wire shapes
 * (main/cli-agents.ts, cli-route.ts, cli-sessions.ts).
 *
 * The renderer cannot import from main (preload boundary), so the shapes are
 * restated here, once, for every surface that lists loops, opens a CLI's
 * terminal or adopts one of its sessions. If a field changes there, it
 * changes here.
 */

/** Glyphh's own loop, and the vendor CLIs. */
export type CliId = "glyphh" | "claude" | "codex" | "gemini" | "copilot" | "cursor";
export type VendorCliId = Exclude<CliId, "glyphh">;

/** The session's mode — the composer's chip, one vocabulary for every loop. */
export type SessionPermission = "ask" | "plan" | "acceptEdits" | "auto";

/** direct = the CLI on its own login; gateway = the CLI on the local router
 *  with the user's own providers (Claude today). */
export type CliRoute = "direct" | "gateway";

/** Where a CLI's route was chosen, most specific first: the session's pick,
 *  the workspace cell's `gateway`, the workspace's `gateway`. Absent or null
 *  leaves the choice to the next level; the member's default (preference
 *  `cliGateway`) fills the rest. */
export interface CliRouteHints { session?: boolean | null; cell?: boolean | null; layout?: boolean | null }

/** One loop as `cli-agents-list` serves it. */
export interface CliAgentRow {
  id: CliId;
  name: string;
  cli: CliId;
  cmd: string;
  /** The model a launch starts on when the session names none ("" = the CLI's own). */
  model: string;
  mcp: boolean;
  cwd: string;
  session: "keep" | "new" | "last";
  /** The permission a loop opens with, in Settings' words. */
  permission: "safe" | "ask" | "auto";
  /** The member's own switch; Glyphh is always on. */
  enabled: boolean;
  updatedAt?: string;
  /** The line a terminal plays with no overrides. */
  command: string;
  /** Runs unattended (task slots, schedules). */
  headless: boolean;
  /** The session modes the agent panel can honor on this loop. */
  modes: SessionPermission[];
  /** The router can carry it — the gateway choice is greyed elsewhere. */
  gatewayCapable: boolean;
}

/** A `cli-agents-save` patch: only what changed. */
export interface CliAgentPatch {
  id: CliId;
  cmd?: string;
  model?: string;
  mcp?: boolean;
  cwd?: string;
  session?: "keep" | "new" | "last";
  permission?: "safe" | "ask" | "auto";
  enabled?: boolean;
}

/** What a terminal open may override. resume: true = the CLI's continue-last,
 *  a string = that exact session. */
export interface CliOpenOverrides {
  model?: string;
  cwd?: string;
  resume?: boolean | string;
  prompt?: string;
  light?: boolean;
  permission?: SessionPermission;
  route?: CliRouteHints;
}

/** What the install dialog shows when a loop's binary is not on the PATH. */
export interface MissingCli { cli: string; name: string; bin: string; install: string; login: string; note?: string }

/** One session in a vendor CLI's own store (the recents). */
export interface CliSessionRow { id: string; cli: VendorCliId; title: string; cwd: string; mtime: number }

/** A CLI session read back as chat turns (`glyphh-agent-transcript`). */
export type CliTranscript =
  | { ok: true; cli: VendorCliId; title: string; cwd: string; turns: Array<{ role: "user" | "assistant"; text: string }> }
  | { ok: false; error: string };
