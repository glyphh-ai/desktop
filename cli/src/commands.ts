/**
 * commands.ts — the slash commands, the set every agent CLI has (his order,
 * 2026-09-21: "mirror how the other CLIs work"): /help /clear /compact /config
 * /cost /effort /exit /mcp /model /permissions /resume /status /theme
 * /version. There is no /login: turns run on the user's own key (local.ts).
 * Each is a small, testable function over a CommandCtx the App supplies. The
 * list doubles as the autocomplete menu that opens when a line starts with "/".
 */

import { compactChat, toolsFor } from "./loop.js";
import { availableModels, defaultModelId, isKnownModel, type ModelChoice } from "./models.js";
import { readPrefs } from "./prefs.js";
import { agoLabel, listGlyphhChats, touchedAt } from "./sessions.js";
import { THEMES, DEFAULT_THEME } from "./theme.js";
import { EFFORTS, EFFORT_DETAIL, EFFORT_LABEL, PERMISSION_LABEL, PERMISSION_MODES, effortOf, permissionModeOf, type Effort, type PermissionMode } from "./types.js";
import type { PickerSpec } from "./components/Picker.js";

/** What the session has spent so far — /cost reads it. */
export interface SessionCost {
  turns: number;
  tokensUp: number;
  tokensDown: number;
  /** Wall time inside turns, ms. */
  durationMs: number;
  startedAt: number;
}

export interface CommandCtx {
  version: string;
  cwd: string;
  /** Is there an Anthropic key for turns to run on (environment or key file)? */
  keyed: boolean;
  /** The model the user picked; null = the catalog's default. */
  model: string | null;
  permission: PermissionMode;
  /** The effort dial the next turn runs at. */
  effort: Effort;
  /** This conversation's id (the loop keeps its messages under it). */
  chatId: string;
  cost: SessionCost;
  /** Pick the model: persisted on this device, or for THIS session only. */
  setModel: (id: string | null, opts?: { session?: boolean }) => void;
  setPermission: (mode: PermissionMode) => void;
  /** Set the effort dial: persisted on this device, or for THIS session only. */
  setEffort: (effort: Effort, opts?: { session?: boolean }) => void;
  /** Apply + persist a theme by name (repaints the whole tree). */
  setTheme: (name: string) => void;
  clearChat: () => void;
  quit: () => void;
  /** Update the running command's `└ …` lines mid-flight (e.g. "compacting…"). */
  emit: (lines: string[]) => void;
  /** Append a transcript note (a compaction's summary marker). */
  note: (text: string) => void;
  /** Open a selector in the strip (the other CLIs' /model flow). */
  openPicker: (spec: PickerSpec) => void;
  /** The chat store shared with the desktop (local.ts chatStoreFile). */
  sessionsFile: string;
  /** Swap the transcript for a stored chat, in place. */
  resumeChat: (id: string) => Promise<string[]>;
}

export interface SlashCommand {
  name: string;
  aliases?: string[];
  summary: string;
  usage?: string;
  run: (ctx: CommandCtx, args: string[]) => Promise<string[]> | string[];
}

/** The model list as command output, the current pick marked. */
export function modelLines(models: ModelChoice[], current: string | null): string[] {
  const lines = ["your chat models (Settings › Models):"];
  for (const m of models) {
    const mark = m.id === (current ?? defaultModelId()) ? "  ← current" : "";
    lines.push(`  ${m.id.padEnd(20)} ${m.detail}${mark}`);
  }
  lines.push(current ? `pick:  /model <id>    the default (${defaultModelId()}):  /model default` : `pick:  /model <id>    (running on the default, ${defaultModelId()})`);
  return lines;
}

/** /permissions output: every mode, the current one marked. */
export function permissionLines(current: PermissionMode): string[] {
  return [
    "permission modes:",
    ...PERMISSION_MODES.map((m) => `  ${m === current ? "▸" : " "} ${m.padEnd(12)} ${PERMISSION_LABEL[m]}`),
    "set:  /permissions <mode>    cycle default → acceptEdits → plan:  shift+tab",
  ];
}

/** /effort output: every step, the current one marked. */
export function effortLines(current: Effort): string[] {
  return [
    "effort — how hard the model thinks on a turn:",
    ...EFFORTS.map((e) => `  ${e === current ? "▸" : " "} ${e.padEnd(8)} ${EFFORT_LABEL[e].padEnd(11)} ${EFFORT_DETAIL[e]}`),
    "set:  /effort <level>",
  ];
}

const fmtDuration = (ms: number): string => (ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);

const COMMANDS: SlashCommand[] = [
  {
    name: "help",
    aliases: ["?"],
    summary: "show these commands and the keys",
    run() {
      return [
        ...COMMANDS.map((c) => `/${c.name}${c.usage ? c.usage.slice(c.name.length + 1) : ""} — ${c.summary}`),
        "",
        "keys: enter send · shift+tab permission mode · esc stop the turn · ctrl+o expand tool output",
        "      ↑/↓ prompt history · pgup/pgdn scroll · ctrl+c clear the line, twice to quit",
      ];
    },
  },
  {
    name: "clear",
    summary: "clear the transcript and start a new conversation",
    run(ctx) {
      ctx.clearChat();
      return [];
    },
  },
  {
    name: "compact",
    summary: "fold the conversation so far into a summary (frees context)",
    async run(ctx) {
      ctx.emit(["compacting…"]);
      const r = await compactChat(ctx.chatId);
      if (!r.ok) return [r.error ?? "could not compact"];
      ctx.note("(compacted the earlier conversation — the loop continues from a summary)");
      return ["compacted"];
    },
  },
  {
    name: "config",
    aliases: ["settings"],
    summary: "show this device's settings",
    run(ctx) {
      const p = readPrefs();
      return [
        `theme        ${p.theme ?? DEFAULT_THEME}          /theme <name>`,
        `permissions  ${ctx.permission}        /permissions <mode>`,
        `model        ${p.model ?? `the default (${defaultModelId()})`}   /model <id>`,
        `effort       ${ctx.effort} · ${EFFORT_LABEL[ctx.effort]}   /effort <level>`,
        `providers    ${ctx.keyed ? "set" : "not set"}   Settings › Models, or ~/.glyphh/users/local/providers.json`,
        "file         ~/.glyphh/config.json",
      ];
    },
  },
  {
    name: "cost",
    summary: "tokens and time spent this session",
    run(ctx) {
      const c = ctx.cost;
      if (!c.turns) return ["nothing spent yet this session"];
      return [
        `${c.turns} turn${c.turns === 1 ? "" : "s"} · ${c.tokensUp}↑ ${c.tokensDown}↓ tokens · ${fmtDuration(c.durationMs)} working`,
        `session up ${fmtDuration(Date.now() - c.startedAt)} · billed by Anthropic to your own key`,
      ];
    },
  },
  {
    name: "effort",
    aliases: ["think", "reasoning"],
    summary: "show or set how hard the model thinks: low, medium, high, xhigh, max",
    usage: "/effort [level]",
    run(ctx, args) {
      const raw = args[0];
      if (!raw) {
        ctx.openPicker({
          title: "Select effort",
          description: "How hard the model thinks on each turn. Enter makes it this device's default; s uses it for this session only.",
          options: EFFORTS.map((e) => ({ id: e, label: EFFORT_LABEL[e], detail: `${e} · ${EFFORT_DETAIL[e]}`, current: e === ctx.effort })),
          secondary: { key: "s", label: "use this session only" },
          enterLabel: "set as default",
          onPick: (id, session) => {
            const effort = effortOf(id);
            if (!effort) return;
            ctx.setEffort(effort, { session });
            ctx.note(`effort → ${EFFORT_LABEL[effort]}${session ? " (this session)" : ""}`);
          },
        });
        return [];
      }
      if (raw === "list" || raw === "?") return effortLines(ctx.effort);
      const effort = effortOf(raw);
      if (!effort) return [`unknown effort: ${raw} — one of ${EFFORTS.join(", ")}`];
      ctx.setEffort(effort);
      return [`effort → ${effort} · ${EFFORT_LABEL[effort]}`];
    },
  },
  {
    name: "exit",
    aliases: ["quit", "q"],
    summary: "leave the TUI",
    run(ctx) {
      ctx.quit();
      return ["bye"];
    },
  },
  {
    name: "mcp",
    summary: "the tools this conversation carries (built-in and lent)",
    run(ctx) {
      const t = toolsFor(ctx.chatId);
      if (!t.builtin.length && !t.lent.length) return ["tools connect on the first turn — send a message, then /mcp lists them"];
      const lines = [`built-in (${t.builtin.length}):  ${t.builtin.join(", ")}`];
      lines.push(t.lent.length ? `lent (${t.lent.length}):  ${t.lent.slice(0, 40).join(", ")}${t.lent.length > 40 ? ` … +${t.lent.length - 40}` : ""}` : "lent: none — the desktop's tools join when the desktop opens this terminal");
      return lines;
    },
  },
  {
    name: "model",
    aliases: ["models"],
    summary: "pick the model turns run on: /model <id> (or default, or list)",
    usage: "/model [id|default|list]",
    run(ctx, args) {
      const models = availableModels();
      const pick = args[0];
      if (!pick) {
        const current = ctx.model;
        ctx.openPicker({
          title: "Select model",
          description: "Your chat models (Settings › Models). Enter makes it this device's default; s uses it for this session only.",
          options: [
            { id: "", label: "Default", detail: `currently ${defaultModelId()}`, current: current === null },
            ...models.map((m) => ({ id: m.id, label: m.id, detail: m.detail, current: m.id === current })),
          ],
          secondary: { key: "s", label: "use this session only" },
          enterLabel: "set as default",
          onPick: (id, session) => {
            ctx.setModel(id || null, { session });
            ctx.note(`model → ${id || `the default (${defaultModelId()})`}${session ? " (this session)" : ""}`);
          },
        });
        return [];
      }
      if (pick === "list" || pick === "?") return modelLines(models, ctx.model);
      if (pick === "default") {
        ctx.setModel(null);
        return [`model → the default (${defaultModelId()})`];
      }
      if (!isKnownModel(pick)) return [`${pick} is not a model Glyphh runs — /model list shows them`];
      ctx.setModel(pick);
      return [`model → ${pick}`];
    },
  },
  {
    name: "permissions",
    aliases: ["permission", "mode"],
    summary: "show or set the permission mode: default, acceptEdits, plan, bypass",
    usage: "/permissions [mode]",
    run(ctx, args) {
      const raw = args[0];
      if (!raw) {
        ctx.openPicker({
          title: "Permission mode",
          description: "How the loop treats edits and commands. shift+tab cycles the first three.",
          options: PERMISSION_MODES.map((m) => ({ id: m, label: m, detail: PERMISSION_LABEL[m], current: m === ctx.permission })),
          enterLabel: "set",
          onPick: (id) => {
            const mode = permissionModeOf(id);
            if (!mode) return;
            ctx.setPermission(mode);
            ctx.note(`permissions → ${mode} · ${PERMISSION_LABEL[mode]}`);
          },
        });
        return [];
      }
      const mode = permissionModeOf(raw);
      if (!mode) return [`unknown mode: ${raw} — one of ${PERMISSION_MODES.join(", ")}`];
      ctx.setPermission(mode);
      return [`permissions → ${mode} · ${PERMISSION_LABEL[mode]}`];
    },
  },
  {
    name: "resume",
    aliases: ["sessions", "chats"],
    summary: "pick up an earlier conversation (shared with the desktop): /resume [id]",
    usage: "/resume [id]",
    async run(ctx, args) {
      if (args[0]) return ctx.resumeChat(args[0]);
      const chats = listGlyphhChats(ctx.sessionsFile, 30).filter((c) => c.id !== ctx.chatId);
      if (!chats.length) return ["no earlier Glyphh-loop conversations yet — this one lands in the desktop's recents after its first answer"];
      ctx.openPicker({
        title: "Resume a conversation",
        description: "Glyphh-loop chats on this machine, newest first — the same list the desktop's recents show.",
        options: chats.map((c) => ({ id: c.id, label: c.title.length > 34 ? `${c.title.slice(0, 33)}…` : c.title, detail: `${c.messages.length} msg · ${agoLabel(touchedAt(c))}${c.workdir ? ` · ${c.workdir.replace(/^\/Users\/[^/]+/, "~")}` : ""}` })),
        enterLabel: "resume",
        onPick: (id) => { void ctx.resumeChat(id).then((lines) => { for (const l of lines) ctx.note(l); }); },
      });
      return [];
    },
  },
  {
    name: "status",
    summary: "key, model, effort, permissions and folder",
    run(ctx) {
      return [
        ctx.keyed ? "providers set · turns run on your own keys" : "no model provider · add one in Settings › Models, or set ANTHROPIC_API_KEY",
        `model ${ctx.model ?? `the default (${defaultModelId()})`} · effort ${EFFORT_LABEL[ctx.effort]} · permissions ${ctx.permission}`,
        `folder ${ctx.cwd}`,
        `glyphh ${ctx.version}`,
      ];
    },
  },
  {
    name: "theme",
    summary: "list themes, or switch: /theme <name>",
    usage: "/theme [name]",
    run(ctx, args) {
      const name = args[0]?.toLowerCase();
      if (!name) {
        const cur = readPrefs().theme ?? DEFAULT_THEME;
        ctx.openPicker({
          title: "Theme",
          options: THEMES.map((t) => ({ id: t.name, label: t.label, detail: t.description, current: t.name === cur })),
          enterLabel: "apply",
          onPick: (id) => { ctx.setTheme(id); ctx.note(`theme → ${id}`); },
        });
        return [];
      }
      const match = THEMES.find((t) => t.name === name);
      if (!match) return [`unknown theme: ${name} — try ${THEMES.map((t) => t.name).join(", ")}`];
      ctx.setTheme(match.name);
      return [`theme set to ${match.label}`];
    },
  },
  {
    name: "version",
    aliases: ["release-notes", "whatsnew"],
    summary: "version and what's new",
    run(ctx) {
      return [`glyphh ${ctx.version}`, ...RELEASE_NOTES];
    },
  },
];

/** The "What's new" panel copy (also shown by `/version`). */
export const RELEASE_NOTES: string[] = [
  "The Glyphh loop runs in your terminal, on your own Anthropic key",
  "One package: glyphh is this terminal, glyphh desktop opens the app",
  "Conversations are shared with the desktop: /resume picks one up",
  "/model, /permissions and /theme open selectors; ↑ recalls prompts",
  "/effort or --effort sets how hard the model thinks, low → ultra; its thinking shows as it works",
];

/** The left panel's tips (shown until the first turn). */
export const TIPS: string[] = [
  "Ask in plain words — the files here and the shell are tools",
  "shift+tab cycles permissions; / opens the command menu",
  "Esc stops a turn · ctrl+o expands tool output",
];

const BY_NAME = new Map<string, SlashCommand>();
for (const c of COMMANDS) {
  BY_NAME.set(c.name, c);
  for (const a of c.aliases ?? []) BY_NAME.set(a, c);
}

/** The commands whose NAME starts with `prefix` (no slash), for the menu; an
 *  alias counts only when typed in full (so `m` is mcp and model, not `/mode`). */
export function matchCommands(prefix: string): SlashCommand[] {
  const p = prefix.toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(p) || (p.length > 0 && (c.aliases ?? []).includes(p)));
}

/** Parse + run a `/command args` line. Returns the result lines (or an error line). */
export async function runSlash(ctx: CommandCtx, line: string): Promise<string[]> {
  const [head, ...rest] = line.replace(/^\//, "").trim().split(/\s+/);
  const cmd = head ? BY_NAME.get(head.toLowerCase()) : undefined;
  if (!cmd) return [`unknown command: /${head ?? ""} — try /help`];
  try {
    return await cmd.run(ctx, rest);
  } catch (err) {
    return [`/${cmd.name} failed: ${(err as Error).message}`];
  }
}

export const SLASH_NAMES = COMMANDS.map((c) => c.name);
