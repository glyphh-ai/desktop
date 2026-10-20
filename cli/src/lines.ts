/**
 * lines.ts — the transcript LINE MODEL (ported from rrotor's TUI). The viewport
 * owns scrolling, so every item flattens to styled lines: slicing a window of
 * lines is exact (no layout estimation), scrolling is array math, and ctrl+o
 * re-expansion is retroactive by construction — lines regenerate from items
 * every render.
 */

import type { TurnStep } from "./types.js";

export type LineStyle =
  | "logo"
  | "user"
  | "command"
  | "result"
  | "head"
  | "headErr"
  | "detail"
  | "hint"
  | "answer"
  | "meta"
  | "note"
  | "blank"
  | "cardEdge"
  | "cardTitle"
  | "cardBody";

export interface Line {
  text: string;
  style: LineStyle;
}

const COLLAPSED_LINES = 3;

/** Greedy word-wrap into `width` columns with a hanging indent. */
export function wrap(text: string, width: number, indent: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    let line = "";
    for (const word of raw.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if ([...candidate].length > width && line) {
        out.push(out.length === 0 ? line : indent + line);
        line = word;
      } else {
        line = candidate;
      }
    }
    out.push(out.length === 0 ? line : indent + line);
  }
  return out;
}

/** Typed input leads with the prompt glyph `❯`, the way the other CLIs echo it. */
export function userLines(text: string, width: number): Line[] {
  const wrapped = wrap(`❯ ${text}`, width, "  ");
  return [{ text: "", style: "blank" }, ...wrapped.map((t) => ({ text: t, style: "user" as const }))];
}

/** A slash command + its `└ …` result lines (mutable mid-flight via patch). */
export function commandLines(text: string, result: string[] | undefined, width: number): Line[] {
  const out: Line[] = [{ text: "", style: "blank" }];
  for (const t of wrap(`❯ ${text}`, width, "  ")) out.push({ text: t, style: "command" });
  const results = (result ?? []).filter(Boolean);
  results.forEach((line, i) => {
    for (const w of wrap((i === 0 ? "  └ " : "    ") + line, width, "      ")) {
      out.push({ text: w, style: "result" });
    }
  });
  return out;
}

export function answerLines(text: string, width: number): Line[] {
  const wrapped = wrap(`● ${text}`, width - 2, "  ");
  return [
    { text: "", style: "blank" },
    ...wrapped.map((t) => ({ text: `  ${t}`, style: "answer" as const })),
  ];
}

export function sectionLines(step: TurnStep, expanded: boolean): Line[] {
  const meta: string[] = [];
  if (step.secs !== undefined) meta.push(`${step.secs.toFixed(1)}s`);
  if (step.tokens) meta.push(`${step.tokens.up}↑ ${step.tokens.down}↓`);
  if (step.error) meta.push(step.error);
  // Fold glyph: only sections with more to show get an affordance.
  const foldable = step.details.length > COLLAPSED_LINES;
  const fold = foldable ? (expanded ? "▾ " : "▸ ") : "⏺ ";
  const head = `${fold}${step.label}${meta.length ? ` · ${meta.join(" · ")}` : ""}`;
  const lines: Line[] = [{ text: head, style: step.ok ? "head" : "headErr" }];
  const body = expanded ? step.details : step.details.slice(0, COLLAPSED_LINES);
  for (const d of body) lines.push({ text: `  │ ${d}`, style: "detail" });
  const hidden = step.details.length - body.length;
  if (hidden > 0) lines.push({ text: `  │ … +${hidden} lines (ctrl+o to expand)`, style: "hint" });
  return lines;
}

export function noteLines(text: string): Line[] {
  return [{ text: `  ${text}`, style: "note" }];
}

// ── The launch banner as SCROLLABLE lines ────────────────────────────────────
// ONE card, two panels (the shape every agent CLI opens with): the welcome,
// the mascot, the model and folder on the left; tips and what's new on the
// right. Narrow terminals stack the two. As transcript lines it scrolls away.

export interface HeaderInfo {
  version: string;
  cwd: string;
  /** The model the next turn runs on. */
  model: string;
  /** Is there a key for turns to run on? Without one the card says how to set it. */
  keyed: boolean;
  /** Tips for getting started (left blank = none). */
  tips: string[];
  /** What's new. */
  notes: string[];
}

/** Box + quadrant glyphs are single-width, so code-point length IS columns. */
const clen = (s: string): number => [...s].length;
const padCell = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - clen(s)));
const centerCell = (s: string, w: number): string => {
  const pad = Math.max(0, w - clen(s));
  const left = Math.floor(pad / 2);
  return " ".repeat(left) + s + " ".repeat(pad - left);
};
const clipEnd = (s: string, w: number): string =>
  clen(s) <= w ? s : [...s].slice(0, Math.max(0, w - 1)).join("") + "…";
const clipStart = (s: string, w: number): string =>
  clen(s) <= w ? s : "…" + [...s].slice(clen(s) - (w - 1)).join("");

/** Two panels need this much; below it the card stacks. */
const TWO_PANEL_MIN = 78;

export function headerLines(width: number, mark: readonly string[], info: HeaderInfo): Line[] {
  const w = Math.max(30, width);
  const inner = w - 2;
  const label = `Glyphh ${info.version}`;
  const out: Line[] = [{ text: "", style: "blank" }, {
    text: `┌─ ${clipEnd(label, inner - 5)} ${"─".repeat(Math.max(0, inner - clen(label) - 5))}─┐`,
    style: "cardTitle",
  }];
  const key = info.keyed ? "your own providers" : "no model provider";
  const left: string[] = ["Welcome to Glyphh", "", ...mark, "", info.model, key, info.cwd];
  const right: string[] = [];
  if (info.tips.length) right.push("Tips for getting started", ...info.tips, "");
  right.push("What's new", ...info.notes, "/version for more");

  if (w >= TWO_PANEL_MIN) {
    const leftW = Math.max(30, Math.min(44, Math.floor(inner * 0.4)));
    const rightW = inner - leftW - 1;
    const l = left.map((t) => centerCell(clipEnd(t === info.cwd ? clipStart(t, leftW - 2) : t, leftW - 2), leftW));
    const r = right.map((t) => ` ${clipEnd(t, rightW - 2)}`);
    const n = Math.max(l.length, r.length);
    for (let i = 0; i < n; i++) out.push({ text: `│${padCell(l[i] ?? "", leftW)}│${padCell(r[i] ?? "", rightW)}│`, style: "cardBody" });
  } else {
    const row = (t: string): void => { out.push({ text: `│${padCell(clipEnd(t, inner), inner)}│`, style: "cardBody" }); };
    for (const t of left) row(t === info.cwd ? ` ${clipStart(t, inner - 2)}` : ` ${t}`);
    row("");
    for (const t of right) row(` ${t}`);
  }
  out.push({ text: `└${"─".repeat(inner)}┘`, style: "cardEdge" });
  out.push({ text: "", style: "blank" });
  return out;
}
