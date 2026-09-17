/**
 * lib-runs.ts — ONE run list, wherever runs are shown (his order, 2026-09-17).
 *
 * A bundle's Runs tab and a schedule's Run history were two renderers of the
 * same thing: the schedule page showed a status, a time and a raw error, while
 * the bundle showed the whole story. Both read the same rows out of loop_runs,
 * so both render here — expand a run and you get what it was handed, every
 * agent turn with its prompt and its full output, every connection call, every
 * checkpoint, and what it returned.
 */

import { escapeHtml } from "./shared.js";

export interface RunEventLite extends Record<string, unknown> { t: string; kind: string }
export interface RunRowLite {
  id: string;
  startedAt: string;
  durationMs: number | null;
  status: string;
  error: string | null;
  trigger?: string | null;
  input?: unknown;
  result?: unknown;
  output?: string | null;
  journal?: { checkpoints?: Record<string, unknown>; events?: RunEventLite[] } | null;
}

export interface RunListOpts {
  /** Shown when there is nothing at all. */
  empty?: string;
  /** Offered while a run is still going. */
  onCancel?: (id: string) => void | Promise<void>;
  /** Continue an agent turn in a session, seeded with its own prompt. */
  onOpenAgent?: (prompt: string) => void;
  /** Which run is expanded; the caller keeps it so a repaint does not collapse. */
  openId?: string | null;
  onToggle?: (id: string | null) => void;
}

const rel = (ms: number): string => {
  const a = Math.abs(ms);
  const u = a < 60_000 ? ["s", 1000] as const : a < 3_600_000 ? ["m", 60_000] as const : a < 86_400_000 ? ["h", 3_600_000] as const : ["d", 86_400_000] as const;
  return `${Math.round(a / u[1])}${u[0]} ago`;
};
const show = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

export function renderRunList(host: HTMLElement, runs: RunRowLite[], opts: RunListOpts = {}): void {
  host.textContent = "";
  if (!runs.length) { host.innerHTML = `<div class="crud-empty">${escapeHtml(opts.empty || "No runs.")}</div>`; return; }
  let openId = opts.openId ?? null;
  for (const run of runs) {
    const events = run.journal?.events ?? [];
    const e = document.createElement("div");
    e.className = "ws-task-run" + (run.status === "ok" ? "" : run.status === "running" ? " running" : " failed") + (openId === run.id ? " open" : "");
    const when = new Date(run.startedAt);
    e.innerHTML = `<div class="ws-task-run-head">`
      + `<span class="ws-task-chip ${run.status === "ok" ? "ok" : run.status === "running" ? "" : "err"}">${escapeHtml(run.status)}</span>`
      + (run.trigger ? `<span class="ws-task-run-trigger">${escapeHtml(run.trigger)}</span>` : "")
      + `<span class="ws-task-run-when" title="${escapeHtml(when.toLocaleString())}">${escapeHtml(rel(when.getTime() - Date.now()))}</span>`
      + (run.durationMs != null ? `<span class="ws-task-run-dur">${(run.durationMs / 1000).toFixed(1)}s</span>` : "")
      + (events.length ? `<span class="ws-task-run-count">${events.length} events</span>` : "")
      + (run.status === "running" && opts.onCancel ? `<button class="action-btn ws-task-cancel" type="button">Cancel</button>` : "")
      + `</div><div class="task-story hidden"></div>`;
    const head = e.querySelector(".ws-task-run-head") as HTMLElement;
    const story = e.querySelector(".task-story") as HTMLElement;
    head.addEventListener("click", (ev) => {
      if ((ev.target as HTMLElement).closest(".ws-task-cancel")) return;
      openId = openId === run.id ? null : run.id;
      opts.onToggle?.(openId);
      e.classList.toggle("open", openId === run.id);
      story.classList.toggle("hidden", openId !== run.id);
      if (openId === run.id && !story.childElementCount) paintStory(story, run, opts);
    });
    e.querySelector(".ws-task-cancel")?.addEventListener("click", () => { void opts.onCancel?.(run.id); });
    if (openId === run.id) paintStory(story, run, opts);
    host.appendChild(e);
  }
}

/** The run, whole. An agent turn carries the prompt it was given and the
 *  output it gave back, with a door into a session to carry it on. */
export function paintStory(host: HTMLElement, run: RunRowLite, opts: RunListOpts = {}): void {
  host.textContent = "";
  const line = (kind: string, title: string, body?: string, cls = ""): HTMLElement => {
    const d = document.createElement("div");
    d.className = `task-event task-event-${kind}${cls ? ` ${cls}` : ""}`;
    d.innerHTML = `<div class="task-event-head"><span class="task-event-kind">${escapeHtml(kind)}</span><span class="task-event-title"></span><span class="task-event-actions"></span></div>${body ? `<pre class="task-event-body"></pre>` : ""}`;
    (d.querySelector(".task-event-title") as HTMLElement).textContent = title;
    const pre = d.querySelector(".task-event-body") as HTMLElement | null; if (pre) pre.textContent = body || "";
    host.appendChild(d);
    return d;
  };
  if (run.input && typeof run.input === "object" && Object.keys(run.input as object).length) line("input", "what it got", show(run.input));
  for (const ev of run.journal?.events ?? []) {
    const t = new Date(ev.t).toLocaleTimeString();
    if (ev.kind === "agent") {
      const row = line("agent", `${t} · ${String(ev.agent || ev.slot)} took the ${String(ev.slot)} slot${ev.error ? " · failed" : ""}`,
        `${show(ev.prompt)}\n\n→ ${ev.error ? show(ev.error) : show(ev.json ?? ev.output)}`, ev.error ? "failed" : "");
      const actions = row.querySelector(".task-event-actions") as HTMLElement;
      const copy = document.createElement("button");
      copy.type = "button"; copy.className = "task-event-btn"; copy.textContent = "Copy";
      copy.title = "Copy this turn's output";
      copy.addEventListener("click", (e) => {
        e.stopPropagation();
        const text = ev.error ? show(ev.error) : show(ev.json ?? ev.output);
        (window as unknown as { glyphh?: { copyToClipboard?: (t: string) => void } }).glyphh?.copyToClipboard?.(text);
        copy.textContent = "Copied";
        window.setTimeout(() => { copy.textContent = "Copy"; }, 1200);
      });
      actions.appendChild(copy);
      if (opts.onOpenAgent && typeof ev.prompt === "string") {
        const open = document.createElement("button");
        open.type = "button"; open.className = "task-event-btn"; open.textContent = "Open in agent";
        open.title = "Carry this turn on in a session";
        open.addEventListener("click", (e) => { e.stopPropagation(); opts.onOpenAgent?.(String(ev.prompt)); });
        actions.appendChild(open);
      }
    }
    else if (ev.kind === "connection") line("connection", `${t} · ${String(ev.app)} · ${String(ev.tool)}${ev.error ? " · failed" : ""}`, `${show(ev.args)}\n\n→ ${ev.error ? show(ev.error) : show(ev.result)}`, ev.error ? "failed" : "");
    else if (ev.kind === "data") line("data", `${t} · ${String(ev.repo)}${ev.rows != null ? ` · ${String(ev.rows)} rows` : ev.changes != null ? ` · ${String(ev.changes)} changed` : ""}${ev.error ? " · failed" : ""}`, `${show(ev.sql)}${ev.error ? `\n\n→ ${show(ev.error)}` : ""}`, ev.error ? "failed" : "");
    else if (ev.kind === "checkpoint") line("checkpoint", `${t} · ${String(ev.key)}${ev.replayed ? " · replayed" : ""}`);
    else if (ev.kind === "log") line("log", `${t} · ${show(ev.message)}`, ev.detail != null ? show(ev.detail) : undefined);
    else if (ev.kind === "resume") line("resume", `${t} · picked up after a restart`);
  }
  // A schedule that ran a SKILL has no journal — its output is the whole story.
  const shown = !(run.journal?.events ?? []).length && run.output ? String(run.output) : "";
  if (shown) line("output", "what the agent said", shown);
  // NOT TWICE (his report, 2026-09-17): a failed headless run stores the same
  // text as its output AND its error, which printed the whole stack trace
  // again under FAILED. The error line is for what the output does not say.
  const flat = (v: string): string => v.replace(/\s+/g, " ").trim();
  const already = shown && run.error ? flat(shown).includes(flat(run.error)) : false;
  if (run.error && !already) line("failed", run.error, undefined, "failed");
  if (run.status === "ok" && run.result !== undefined && run.result !== null) line("result", "what it returned", show(run.result));
}
