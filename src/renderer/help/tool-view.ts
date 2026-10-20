/**
 * tool-view.ts — WHAT THE AGENT DID, drawn (his order, 2026-09-29: "file
 * changes etc <+ adds green> <- removes red> foldable with inline adds
 * highlighted in green, removes highlighted in red… Way more robust viewing of
 * the tool calls with the commands that are ran by the agent… this needs to be
 * world class").
 *
 * A turn's steps are one foldable group ("Ran 6 commands, created
 * agent-tools.ts +92 −0"), and every step inside it folds on its own:
 *
 *   Ran / Created / Edited / Read / Searched / Called / Asked — what it was,
 *   on what, and how it went (a spinner, a check, the exit code, the time).
 *
 * Opened, a step shows the thing itself: a file change as a real diff (line
 * numbers on both sides, every added line green, every removed line red,
 * syntax-coloured, context folded); a command as `$ command` with its output
 * and exit code; a lent tool as its arguments and what came back.
 *
 * The data is the engine's own (sdk tools.ts ToolDetail), recorded on the step
 * as it lands — nothing here is guessed from a label. Old transcripts without
 * it keep their one-line rows.
 */

import { highlight, languageOf } from "../highlight.js";

// ── the step record (mirrors the SDK's ToolDetail; the renderer never imports it) ──

export type DiffLine = { t: " " | "+" | "-"; s: string };
export interface DiffHunk { oldStart: number; newStart: number; lines: DiffLine[] }
export type ToolDetail =
  | { kind: "diff"; path: string; created: boolean; hunks: DiffHunk[]; added: number; removed: number; truncated: boolean }
  | { kind: "command"; command: string; exitCode: number | null; stdout: string; stderr: string; truncated: boolean; ms: number }
  | { kind: "read"; path: string; lines: number; from?: number }
  | { kind: "list"; path: string; count: number }
  | { kind: "search"; pattern: string; path: string; matches: number };

export interface ToolRec {
  name: string;
  title: string;
  state: "running" | "done" | "failed";
  detail?: ToolDetail;
  input?: string;
  output?: string;
  /** The one-line preview the engine sends for every step. */
  preview?: string;
  startedAt: number;
  endedAt?: number;
}

/** What a step keeps on disk: the transcript is saved on every event, so a
 *  step's body is bounded — the whole diff and output were shown live. */
export function trimForStore(r: ToolRec): ToolRec {
  const cut = (s: string | undefined, n: number): string | undefined => (s && s.length > n ? `${s.slice(0, n)}\n…` : s);
  const out: ToolRec = { ...r, input: cut(r.input, 4000), output: cut(r.output, 4000), preview: cut(r.preview, 300) };
  if (out.input === undefined) delete out.input;
  if (out.output === undefined) delete out.output;
  if (out.preview === undefined) delete out.preview;
  const d = r.detail;
  if (d?.kind === "diff") {
    let kept = 0;
    const hunks: DiffHunk[] = [];
    let truncated = d.truncated;
    for (const h of d.hunks) {
      if (kept >= 240) { truncated = true; break; }
      const lines = h.lines.slice(0, 240 - kept);
      if (lines.length < h.lines.length) truncated = true;
      hunks.push({ ...h, lines });
      kept += lines.length;
    }
    out.detail = { ...d, hunks, truncated };
  } else if (d?.kind === "command") {
    const so = cut(d.stdout, 6000) ?? "";
    const se = cut(d.stderr, 3000) ?? "";
    out.detail = { ...d, stdout: so, stderr: se, truncated: d.truncated || so !== d.stdout || se !== d.stderr };
  }
  return out;
}

// ── small pieces ───────────────────────────────────────────────────────────

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const nameOf = (p: string): string => p.split(/[\\/]/).pop() || p;
const extOf = (p: string): string => (nameOf(p).split(".").slice(1).pop() || "").toLowerCase();
const shortPath = (p: string): string => p.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");

const CHEV = `<svg class="tv-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>`;
const CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
const CROSS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
const COPY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`;

function duration(r: ToolRec): string {
  if (!r.endedAt) return "";
  const ms = r.endedAt - r.startedAt;
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s < 10 ? s.toFixed(1) : Math.round(s)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function badge(added: number, removed: number): string {
  return `<span class="tv-badge"><span class="tv-add">+${added}</span><span class="tv-del">−${removed}</span></span>`;
}

/** The same badge as nodes, for appending beside other nodes. */
function badgeEl(added: number, removed: number): HTMLElement {
  const b = document.createElement("span");
  b.className = "tv-badge";
  const a = document.createElement("span");
  a.className = "tv-add";
  a.textContent = `+${added}`;
  const r = document.createElement("span");
  r.className = "tv-del";
  r.textContent = `−${removed}`;
  b.append(a, r);
  return b;
}

/** Markup this module built itself (escaped, highlighted), appended as nodes. */
function appendMarkup(parent: HTMLElement, html: string): void {
  const t = document.createElement("template");
  t.innerHTML = html;
  parent.append(t.content);
}

/** A fold between hunks: "⋯ 12 unchanged lines". */
function gapEl(text: string): HTMLElement {
  const g = document.createElement("div");
  g.className = "tv-gap";
  const s = document.createElement("span");
  s.textContent = text;
  g.appendChild(s);
  return g;
}

function copyButton(text: () => string, label = "Copy"): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "tv-copy";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.innerHTML = COPY;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(text()).then(() => {
      b.classList.add("done");
      b.innerHTML = CHECK;
      setTimeout(() => { b.classList.remove("done"); b.innerHTML = COPY; }, 1400);
    }).catch(() => { /* the text is still selectable */ });
  });
  return b;
}

// ── what a step IS, in words ───────────────────────────────────────────────

type StepKind = "command" | "create" | "edit" | "read" | "search" | "list" | "agent" | "tool";

function kindOf(r: ToolRec): StepKind {
  const d = r.detail;
  if (d?.kind === "command" || r.name === "bash") return "command";
  if (d?.kind === "diff") return d.created ? "create" : "edit";
  if (r.name === "write_file") return "create";
  if (r.name === "edit_file") return "edit";
  if (d?.kind === "read" || r.name === "read_file") return "read";
  if (d?.kind === "search" || r.name === "grep" || r.name === "glob") return "search";
  if (d?.kind === "list" || r.name === "list_dir") return "list";
  if (r.name === "spawn_agent") return "agent";
  return "tool";
}

/** The step's subject, from the engine's title ("bash npm test" → "npm test"). */
function subjectOf(r: ToolRec): string {
  const t = r.title || r.name;
  return t.startsWith(`${r.name} `) ? t.slice(r.name.length + 1) : t;
}

const VERB: Record<StepKind, [string, string]> = {
  command: ["Running", "Ran"],
  create: ["Creating", "Created"],
  edit: ["Editing", "Edited"],
  read: ["Reading", "Read"],
  search: ["Searching", "Searched"],
  list: ["Listing", "Listed"],
  agent: ["Asking", "Asked"],
  tool: ["Calling", "Called"],
};

function stepHead(r: ToolRec): HTMLElement {
  const kind = kindOf(r);
  const head = document.createElement("div");
  head.className = "tv-step-head";
  const verb = document.createElement("span");
  verb.className = "tv-verb";
  verb.textContent = VERB[kind][r.state === "running" ? 0 : 1];
  head.appendChild(verb);

  const subj = document.createElement("span");
  const d = r.detail;
  if (kind === "create" || kind === "edit" || kind === "read") {
    subj.className = "tv-file";
    const path = d && "path" in d ? d.path : subjectOf(r);
    subj.textContent = nameOf(path);
    subj.title = path;
  } else {
    subj.className = kind === "command" ? "tv-cmd" : "tv-subj";
    subj.textContent = kind === "command" && d?.kind === "command" ? d.command.replace(/\s+/g, " ") : subjectOf(r);
    subj.title = subj.textContent;
  }
  head.appendChild(subj);

  const meta = document.createElement("span");
  meta.className = "tv-meta";
  if (d?.kind === "diff") meta.innerHTML = badge(d.added, d.removed);
  else if (d?.kind === "read") meta.textContent = `${d.lines} line${d.lines === 1 ? "" : "s"}`;
  else if (d?.kind === "search") meta.textContent = `${d.matches} match${d.matches === 1 ? "" : "es"}`;
  else if (d?.kind === "list") meta.textContent = `${d.count} item${d.count === 1 ? "" : "s"}`;
  else if (d?.kind === "command" && d.exitCode && d.exitCode !== 0) meta.innerHTML = `<span class="tv-exit">exit ${d.exitCode}</span>`;
  const dur = duration(r);
  if (dur) {
    const span = document.createElement("span");
    span.className = "tv-dur";
    span.textContent = dur;
    meta.appendChild(span);
  }
  head.appendChild(meta);

  const state = document.createElement("span");
  state.className = `tv-state ${r.state}`;
  state.innerHTML = r.state === "running" ? `<span class="tv-spin" aria-label="running"></span>` : r.state === "failed" ? CROSS : CHECK;
  head.appendChild(state);
  return head;
}

// ── the bodies ─────────────────────────────────────────────────────────────

/** A REAL DIFF: both line numbers, the marker, the line — coloured by the
 *  file's language, green for added, red for removed; hunks separated by the
 *  unchanged lines they skip. */
export function diffEl(d: Extract<ToolDetail, { kind: "diff" }>): HTMLElement {
  const box = document.createElement("div");
  box.className = "tv-diff";
  const bar = document.createElement("div");
  bar.className = "tv-path";
  const p = document.createElement("span");
  p.textContent = shortPath(d.path);
  p.title = d.path;
  bar.append(p);
  bar.appendChild(badgeEl(d.added, d.removed));
  box.appendChild(bar);

  const lang = languageOf(extOf(d.path)) ? extOf(d.path) : "";
  const table = document.createElement("div");
  table.className = "tv-lines";
  let prevEnd: { o: number; n: number } | null = null;
  for (const h of d.hunks) {
    if (prevEnd && h.oldStart > prevEnd.o) {
      const gap = h.oldStart - prevEnd.o;
      table.appendChild(gapEl(`⋯ ${gap} unchanged line${gap === 1 ? "" : "s"}`));
    } else if (!prevEnd && h.oldStart > 1 && !d.created) {
      table.appendChild(gapEl(`⋯ ${h.oldStart - 1} line${h.oldStart - 1 === 1 ? "" : "s"} above`));
    }
    let o = h.oldStart;
    let n = h.newStart;
    const rows: string[] = [];
    for (const l of h.lines) {
      const code = lang ? highlight(l.s, lang) : esc(l.s);
      const cls = l.t === "+" ? "add" : l.t === "-" ? "del" : "ctx";
      const on = l.t === "+" ? "" : String(o);
      const nn = l.t === "-" ? "" : String(n);
      rows.push(`<div class="tv-row ${cls}"><span class="tv-no">${on}</span><span class="tv-no">${nn}</span><span class="tv-mk">${l.t === " " ? "" : l.t === "+" ? "+" : "−"}</span><span class="tv-code tk">${code || " "}</span></div>`);
      if (l.t !== "+") o++;
      if (l.t !== "-") n++;
    }
    appendMarkup(table, rows.join(""));
    prevEnd = { o, n };
  }
  if (!d.hunks.length) table.appendChild(gapEl("No changes"));
  box.appendChild(table);
  if (d.truncated) {
    const t = document.createElement("div");
    t.className = "tv-note";
    t.textContent = `Showing part of the change — ${d.added} added and ${d.removed} removed in all. Open the file to see everything.`;
    box.appendChild(t);
  }
  return box;
}

/** A COMMAND: `$ command`, then what it printed — errors in red, the exit
 *  code when it was not zero. */
export function commandEl(d: Extract<ToolDetail, { kind: "command" }>): HTMLElement {
  const box = document.createElement("div");
  box.className = "tv-term";
  const cmd = document.createElement("div");
  cmd.className = "tv-term-cmd";
  cmd.innerHTML = `<span class="tv-prompt">$</span><code class="tk">${highlight(d.command, "bash")}</code>`;
  cmd.appendChild(copyButton(() => d.command, "Copy command"));
  box.appendChild(cmd);
  const out = (d.stdout || "").replace(/\s+$/, "");
  const err = (d.stderr || "").replace(/\s+$/, "");
  if (out || err) {
    const pre = document.createElement("pre");
    pre.className = "tv-term-out";
    if (out) pre.appendChild(document.createTextNode(out));
    if (err) {
      const e = document.createElement("span");
      e.className = "tv-stderr";
      e.textContent = `${out ? "\n" : ""}${err}`;
      pre.appendChild(e);
    }
    box.appendChild(pre);
  } else {
    box.insertAdjacentHTML("beforeend", `<div class="tv-term-empty">No output</div>`);
  }
  const foot = document.createElement("div");
  foot.className = "tv-term-foot";
  foot.innerHTML = `${d.exitCode === 0 ? `<span class="tv-ok">exit 0</span>` : `<span class="tv-exit">exit ${d.exitCode ?? "?"}</span>`}${d.truncated ? `<span>output trimmed</span>` : ""}`;
  box.appendChild(foot);
  return box;
}

function jsonOrText(s: string): string {
  const t = s.trim();
  if ((t.startsWith("{") || t.startsWith("[")) && t.length < 200_000) {
    try { return highlight(JSON.stringify(JSON.parse(t), null, 2), "json"); } catch { /* not JSON */ }
  }
  return esc(s);
}

/** A LENT TOOL: what went in, what came back. */
function ioEl(r: ToolRec): HTMLElement {
  const box = document.createElement("div");
  box.className = "tv-io";
  const part = (label: string, body: string, raw: string): void => {
    const h = document.createElement("div");
    h.className = "tv-io-head";
    h.textContent = label;
    h.appendChild(copyButton(() => raw, `Copy ${label.toLowerCase()}`));
    const pre = document.createElement("pre");
    pre.className = "tv-io-pre";
    const code = document.createElement("code");
    code.className = "tk";
    code.innerHTML = body;
    pre.appendChild(code);
    box.append(h, pre);
  };
  if (r.input && r.input.trim() && r.input.trim() !== "{}") part("Arguments", jsonOrText(r.input), r.input);
  const result = r.output ?? r.preview ?? "";
  if (result.trim()) part(r.state === "failed" ? "Error" : "Result", jsonOrText(result), result);
  if (!box.childElementCount) box.innerHTML = `<div class="tv-term-empty">${r.state === "running" ? "Waiting for the result…" : "Nothing came back."}</div>`;
  return box;
}

function bodyOf(r: ToolRec): HTMLElement {
  const d = r.detail;
  if (d?.kind === "diff") return diffEl(d);
  if (d?.kind === "command") return commandEl(d);
  if (d?.kind === "read" || d?.kind === "list" || d?.kind === "search") {
    const m = document.createElement("div");
    m.className = "tv-note tv-meta-line";
    const where = shortPath(d.path);
    m.textContent = d.kind === "read"
      ? `${d.lines} line${d.lines === 1 ? "" : "s"}${d.from ? ` from line ${d.from}` : ""} of ${where}`
      : d.kind === "list" ? `${d.count} item${d.count === 1 ? "" : "s"} in ${where}` : `${d.matches} match${d.matches === 1 ? "" : "es"} for ${d.pattern} in ${where}`;
    return m;
  }
  // A running command has no detail yet: show what is being run.
  if (r.name === "bash" && r.state === "running") {
    return commandEl({ kind: "command", command: subjectOf(r), exitCode: null, stdout: "", stderr: "", truncated: false, ms: 0 });
  }
  return ioEl(r);
}

// ── a step, and a group of them ────────────────────────────────────────────

/** One foldable step. `open` is the caller's (it survives repaints). */
export function stepEl(r: ToolRec, open: boolean, onToggle: () => void): HTMLElement {
  const el = document.createElement("div");
  el.className = `tv-step ${kindOf(r)} ${r.state}${open ? " open" : ""}`;
  const head = stepHead(r);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "tv-step-btn";
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  btn.appendChild(head);
  appendMarkup(btn, CHEV);
  btn.addEventListener("click", onToggle);
  el.appendChild(btn);
  if (open) {
    const body = document.createElement("div");
    body.className = "tv-step-body";
    body.appendChild(bodyOf(r));
    el.appendChild(body);
  }
  return el;
}

/** The group's one line: counts by kind, the one file by name, the total diff. */
export function summaryOf(recs: ToolRec[], live: boolean): { html: string; failed: number } {
  const failed = recs.filter((r) => r.state === "failed").length;
  if (live) {
    const cur = [...recs].reverse().find((r) => r.state === "running");
    const what = cur ? `${VERB[kindOf(cur)][0]} ${esc(kindOf(cur) === "create" || kindOf(cur) === "edit" || kindOf(cur) === "read" ? nameOf(cur.detail && "path" in cur.detail ? cur.detail.path : subjectOf(cur)) : subjectOf(cur).slice(0, 80))}` : "Working";
    return { html: `${what}<span class="tv-count">${recs.length} step${recs.length === 1 ? "" : "s"}</span>`, failed };
  }
  const n = (k: StepKind): number => recs.filter((r) => kindOf(r) === k).length;
  const files = (created: boolean): string[] => [...new Set(recs.flatMap((r) => (r.detail?.kind === "diff" && r.detail.created === created ? [r.detail.path] : [])))];
  const made = files(true);
  const changed = files(false).filter((p) => !made.includes(p));
  let added = 0;
  let removed = 0;
  for (const r of recs) if (r.detail?.kind === "diff") { added += r.detail.added; removed += r.detail.removed; }
  const bits: string[] = [];
  const cmds = n("command");
  if (cmds) bits.push(`ran ${cmds} command${cmds === 1 ? "" : "s"}`);
  if (made.length) bits.push(made.length === 1 ? `created <span class="tv-file">${esc(nameOf(made[0]!))}</span>` : `created ${made.length} files`);
  if (changed.length) bits.push(changed.length === 1 ? `edited <span class="tv-file">${esc(nameOf(changed[0]!))}</span>` : `edited ${changed.length} files`);
  const reads = n("read");
  if (reads) bits.push(`read ${reads} file${reads === 1 ? "" : "s"}`);
  const looks = n("search") + n("list");
  if (looks) bits.push(`searched ${looks} time${looks === 1 ? "" : "s"}`);
  const agents = n("agent");
  if (agents) bits.push(`asked ${agents} agent${agents === 1 ? "" : "s"}`);
  const tools = n("tool");
  if (tools) bits.push(`called ${tools} tool${tools === 1 ? "" : "s"}`);
  const text = bits.join(", ") || "no steps";
  let html = text.charAt(0).toUpperCase() + text.slice(1);
  if (added || removed) html += ` ${badge(added, removed)}`;
  if (failed) html += ` <span class="tv-failed">· ${failed} failed</span>`;
  return { html, failed };
}
