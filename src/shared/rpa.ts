/**
 * rpa.ts — RPA ON A TAB (his order, 2026-10-07; restored from the April
 * 2026 app connector + DOM picker + vibes, 941df3db^, onto today's tabs).
 *
 * A tab carries, in its launch config under `rpa`:
 *   commands   named actions mapped onto the page — a selector and what to do
 *              with it (click, type, read, goto, custom script), with a guide
 *              that makes the agent reliable (precondition, expected result,
 *              a verify selector, a recovery hint, a delay)
 *   sequences  named shortcuts: ordered steps over those commands, with values
 *              and {{placeholders}} filled at run time
 *
 * The user maps them with the picker on the Tabs page; the Glyphh agent and
 * the CLIs map and run them through tools; every command and sequence is a
 * tool named <tab>_<key> in the loop's catalog. Pure: no DOM, no Electron.
 */

export type RpaAction = "click" | "type" | "read" | "readHtml" | "goto" | "custom";
export const RPA_ACTIONS: readonly RpaAction[] = ["click", "type", "read", "readHtml", "goto", "custom"];
export const RPA_KEY = "rpa";
export const RPA_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,48}$/;
export const RPA_COMMANDS_MAX = 64;
export const RPA_SEQUENCES_MAX = 32;
export const RPA_STEPS_MAX = 40;

export interface RpaGuide {
  /** What must be true before running ("the compose window is open"). */
  pre?: string;
  /** What to expect after success ("the mail is sent; the compose window closes"). */
  post?: string;
  /** A selector that must exist after the action, or the run failed. */
  verify?: string;
  /** What to try when it fails ("try the icon button instead"). */
  recover?: string;
  /** Milliseconds to wait after the action before verifying. */
  delay?: number;
}

export interface RpaCommand {
  key: string;
  description: string;
  action: RpaAction;
  /** The element: required for click, type, read, readHtml. */
  selector?: string;
  /** type: the text, with {{value}} for the caller's value. */
  text?: string;
  /** goto: the address, with {{value}}. */
  url?: string;
  /** custom: JavaScript run in the page; `value` is in scope as VALUE. */
  script?: string;
  /** A selector to wait for before acting. */
  waitFor?: string;
  guide?: RpaGuide;
}

export interface RpaStep { command: string; value?: string; waitFor?: string }
export interface RpaSequence { name: string; description: string; steps: RpaStep[] }
export interface RpaConfig { commands: Record<string, RpaCommand>; sequences: Record<string, RpaSequence> }

const str = (v: unknown, cap = 4000): string => (typeof v === "string" ? v.trim().slice(0, cap) : "");
const keyOf = (v: unknown): string => str(v, 60).toLowerCase().replace(/\s+/g, "-");

export function emptyRpa(): RpaConfig { return { commands: {}, sequences: {} }; }

/** The tab's RPA config, read loosely off its launch config. */
export function rpaOf(launchConfig: unknown): RpaConfig {
  const raw = (launchConfig as { rpa?: unknown } | null)?.rpa as { commands?: unknown; sequences?: unknown } | null | undefined;
  const out = emptyRpa();
  if (!raw || typeof raw !== "object") return out;
  const cmds = raw.commands && typeof raw.commands === "object" ? (raw.commands as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(cmds)) { try { const c = normalizeCommand({ ...(v as object), key: k }); out.commands[c.key] = c; } catch { /* a bad row is left out */ } }
  const seqs = raw.sequences && typeof raw.sequences === "object" ? (raw.sequences as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(seqs)) { try { const s = normalizeSequence({ ...(v as object), name: k }); out.sequences[s.name] = s; } catch { /* same */ } }
  return out;
}

export function normalizeGuide(v: unknown): RpaGuide | undefined {
  if (!v || typeof v !== "object") return undefined;
  const g = v as Record<string, unknown>;
  const out: RpaGuide = {};
  if (str(g.pre)) out.pre = str(g.pre, 500);
  if (str(g.post)) out.post = str(g.post, 500);
  if (str(g.verify)) out.verify = str(g.verify, 500);
  if (str(g.recover)) out.recover = str(g.recover, 500);
  if (typeof g.delay === "number" && Number.isFinite(g.delay) && g.delay > 0) out.delay = Math.min(30_000, Math.round(g.delay));
  return Object.keys(out).length ? out : undefined;
}

/** A command as stored: the key and action checked, the fields the action needs present. */
export function normalizeCommand(input: unknown): RpaCommand {
  const c = (input ?? {}) as Record<string, unknown>;
  const key = keyOf(c.key);
  if (!RPA_KEY_RE.test(key)) throw new Error("a command key is lowercase letters, digits, _ or - (up to 49 characters)");
  const action = str(c.action, 20) as RpaAction;
  if (!RPA_ACTIONS.includes(action)) throw new Error(`action is one of ${RPA_ACTIONS.join(", ")}`);
  const selector = str(c.selector, 1000);
  const text = str(c.text);
  const url = str(c.url, 2000);
  const script = str(c.script, 20_000);
  if ((action === "click" || action === "type" || action === "read" || action === "readHtml") && !selector) throw new Error(`${action} needs a selector (pick one on the page, or rpa_pick)`);
  if (action === "goto" && !url) throw new Error("goto needs a url");
  if (action === "custom" && !script) throw new Error("custom needs a script");
  const out: RpaCommand = { key, description: str(c.description, 500) || key, action };
  if (selector) out.selector = selector;
  if (text) out.text = text;
  if (url) out.url = url;
  if (script) out.script = script;
  if (str(c.waitFor, 1000)) out.waitFor = str(c.waitFor, 1000);
  const guide = normalizeGuide(c.guide);
  if (guide) out.guide = guide;
  return out;
}

export function normalizeSequence(input: unknown): RpaSequence {
  const s = (input ?? {}) as Record<string, unknown>;
  const name = keyOf(s.name);
  if (!RPA_KEY_RE.test(name)) throw new Error("a sequence name is lowercase letters, digits, _ or - (up to 49 characters)");
  const raw = Array.isArray(s.steps) ? s.steps : [];
  if (!raw.length) throw new Error("a sequence needs at least one step");
  if (raw.length > RPA_STEPS_MAX) throw new Error(`a sequence holds at most ${RPA_STEPS_MAX} steps`);
  const steps: RpaStep[] = raw.map((st, i) => {
    const o = (st ?? {}) as Record<string, unknown>;
    const command = keyOf(o.command);
    if (!RPA_KEY_RE.test(command)) throw new Error(`step ${i + 1} names no command`);
    const step: RpaStep = { command };
    if (str(o.value)) step.value = str(o.value);
    if (str(o.waitFor, 1000)) step.waitFor = str(o.waitFor, 1000);
    return step;
  });
  return { name, description: str(s.description, 500) || name, steps };
}

export function withCommand(cfg: RpaConfig, cmd: RpaCommand): RpaConfig {
  if (!(cmd.key in cfg.commands) && Object.keys(cfg.commands).length >= RPA_COMMANDS_MAX) throw new Error(`a tab maps at most ${RPA_COMMANDS_MAX} commands`);
  return { ...cfg, commands: { ...cfg.commands, [cmd.key]: cmd } };
}
export function withoutCommand(cfg: RpaConfig, key: string): RpaConfig {
  const commands = { ...cfg.commands }; delete commands[keyOf(key)];
  return { ...cfg, commands };
}
export function withSequence(cfg: RpaConfig, seq: RpaSequence): RpaConfig {
  for (const st of seq.steps) if (!(st.command in cfg.commands)) throw new Error(`step "${st.command}" is not a mapped command of this tab`);
  if (!(seq.name in cfg.sequences) && Object.keys(cfg.sequences).length >= RPA_SEQUENCES_MAX) throw new Error(`a tab keeps at most ${RPA_SEQUENCES_MAX} sequences`);
  return { ...cfg, sequences: { ...cfg.sequences, [seq.name]: seq } };
}
export function withoutSequence(cfg: RpaConfig, name: string): RpaConfig {
  const sequences = { ...cfg.sequences }; delete sequences[keyOf(name)];
  return { ...cfg, sequences };
}

/** {{value}} and {{name}} placeholders, filled from the caller's args. */
export function substitute(text: string, args: Record<string, unknown>): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, k: string) => {
    const v = args[k];
    return v === undefined || v === null ? "" : String(v);
  });
}

const safeName = (s: string): string => s.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);

/** The tool a mapped command is in the loop's catalog and on the local MCP. */
export function commandToolSpec(slug: string, cmd: RpaCommand): { name: string; description: string; inputSchema: Record<string, unknown>; readOnly: boolean } {
  const takesValue = cmd.action === "type" || cmd.action === "goto" || cmd.action === "custom";
  const props: Record<string, unknown> = takesValue ? { value: { type: "string", description: cmd.action === "type" ? "The text to type ({{value}} in the mapping)" : cmd.action === "goto" ? "The address ({{value}} in the mapping)" : "VALUE for the script" } } : {};
  const guide = cmd.guide ? [cmd.guide.pre ? `Before: ${cmd.guide.pre}.` : "", cmd.guide.post ? `After: ${cmd.guide.post}.` : "", cmd.guide.recover ? `If it fails: ${cmd.guide.recover}.` : ""].filter(Boolean).join(" ") : "";
  return {
    name: safeName(`${slug}_${cmd.key}`),
    description: `${cmd.description} (RPA on the ${slug} tab's panel: ${cmd.action}${cmd.selector ? ` ${cmd.selector}` : ""}; the panel opens on the member's screen).${guide ? ` ${guide}` : ""}`.slice(0, 1000),
    inputSchema: { type: "object", properties: props, ...(takesValue && cmd.action !== "custom" ? { required: ["value"] } : {}) },
    readOnly: cmd.action === "read" || cmd.action === "readHtml",
  };
}

/** The tool a sequence is. Its args: every {{placeholder}} its steps name. */
export function sequenceToolSpec(slug: string, seq: RpaSequence): { name: string; description: string; inputSchema: Record<string, unknown>; readOnly: boolean } {
  const names = new Set<string>();
  for (const st of seq.steps) for (const m of String(st.value ?? "").matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)) names.add(m[1]!);
  const props: Record<string, unknown> = {};
  for (const n of names) props[n] = { type: "string" };
  return {
    name: safeName(`${slug}_${seq.name}`),
    description: `${seq.description} (an RPA sequence of ${seq.steps.length} ${seq.steps.length === 1 ? "step" : "steps"} on the ${slug} tab's panel: ${seq.steps.map((s) => s.command).join(" → ")}).`.slice(0, 1000),
    inputSchema: { type: "object", properties: props, ...(names.size ? { required: [...names] } : {}) },
    readOnly: false,
  };
}
