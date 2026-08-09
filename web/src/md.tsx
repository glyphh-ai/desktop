/**
 * Mobile markdown — a real renderer for agent messages.
 *
 * Block structure is REAL React (so code blocks carry live copy/fold buttons and
 * checkboxes are interactive); inline formatting (bold / italic / links / inline
 * code) is produced by `marked.parseInline` and sanitised with DOMPurify before
 * it ever touches the DOM. No CDN — `marked` + `dompurify` are bundled.
 *
 * Highlighting is intentionally small and self-contained: diff hunks get +/-
 * line colouring; other code gets a conservative token pass (strings, comments,
 * numbers, keywords). Enough to read like a proper editor without a 200 KB lib.
 */
import React, { useMemo, useState } from 'react';
import { marked, type Token, type Tokens } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

/* ── Inline: rich but sanitised ─────────────────────────────────────────────*/
function inlineHtml(src: string): string {
  let html: string;
  try { html = marked.parseInline(src ?? '', { async: false }) as string; }
  catch { html = escapeHtml(src ?? ''); }
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'rel'] });
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}
const Inline = ({ src, tag = 'span', className }: { src: string; tag?: string; className?: string }) =>
  React.createElement(tag, { className, dangerouslySetInnerHTML: { __html: inlineHtml(src) } });

/* ── Tiny inline icons (kept local so md.tsx has no dep on mobile.tsx) ───────*/
const I = {
  copy: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>,
  check: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>,
  chevron: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>,
};

/* ── Syntax highlight (self-contained) ──────────────────────────────────────*/
const KEYWORDS = new Set(
  ('const let var function return if else for while do switch case break continue new class extends super this import export from default async await yield try catch finally throw typeof instanceof in of void delete null undefined true false public private protected static readonly interface type enum namespace as is keyof def elif except with lambda pass raise print None True False and or not fn pub mut match use struct impl trait where select insert update delete where group order limit')
    .split(' '),
);
function highlightCode(code: string): React.ReactNode {
  // Split into tokens with one combined pass; wrap matches in coloured spans.
  const re = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d_.eExXaAbBcCdDfF]*\b)|([A-Za-z_$][\w$]*)/g;
  const out: React.ReactNode[] = [];
  let last = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(code))) {
    if (m.index > last) out.push(code.slice(last, m.index));
    if (m[1]) out.push(<span key={k++} className="tk-com">{m[1]}</span>);
    else if (m[2]) out.push(<span key={k++} className="tk-str">{m[2]}</span>);
    else if (m[3]) out.push(<span key={k++} className="tk-num">{m[3]}</span>);
    else if (m[4]) out.push(KEYWORDS.has(m[4]) ? <span key={k++} className="tk-kw">{m[4]}</span> : m[4]);
    last = re.lastIndex;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}
function diffLines(code: string): React.ReactNode {
  return code.split('\n').map((ln, i) => {
    const c = ln[0];
    const cls = c === '+' ? 'df-add' : c === '-' ? 'df-del' : ln.startsWith('@@') ? 'df-hunk' : ln.startsWith('diff ') || ln.startsWith('index ') ? 'df-meta' : '';
    return <span key={i} className={`df-line ${cls}`}>{ln || ' '}</span>;
  });
}

/* ── Code block: language chip + copy + fold (diffs auto-fold when long) ─────*/
function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const language = (lang || '').trim().toLowerCase();
  const isDiff = language === 'diff' || language === 'patch';
  const lineCount = code.replace(/\n$/, '').split('\n').length;
  const [copied, setCopied] = useState(false);
  const [folded, setFolded] = useState(lineCount > 24);   // long blocks start folded
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1400); }
    catch { /* clipboard blocked */ }
  };
  return (
    <div className={`m-cb${isDiff ? ' m-cb-diff' : ''}`}>
      <div className="m-cb-bar">
        <span className="m-cb-lang">{language || 'text'}</span>
        <span className="m-cb-spacer" />
        {lineCount > 8 && (
          <button className="m-cb-btn" onClick={() => setFolded((f) => !f)}>
            <span className="m-cb-chev" data-folded={folded}>{I.chevron}</span>
            {folded ? `${lineCount} lines` : 'Collapse'}
          </button>
        )}
        <button className="m-cb-btn" onClick={copy}>{copied ? I.check : I.copy}{copied ? 'Copied' : 'Copy'}</button>
      </div>
      {!folded && (
        <pre className="m-cb-pre"><code>{isDiff ? diffLines(code) : highlightCode(code)}</code></pre>
      )}
    </div>
  );
}

/* ── Block dispatch ─────────────────────────────────────────────────────────*/
function ListItem({ item }: { item: Tokens.ListItem }) {
  // Task-list items become interactive-looking checkboxes; nested blocks recurse.
  const child = item.tokens ?? [];
  const leadText = child.find((t) => t.type === 'text') as Tokens.Text | undefined;
  const rest = child.filter((t) => t !== leadText && t.type !== 'space');
  return (
    <li className={`m-md-li${item.task ? ' m-md-task' : ''}`}>
      {item.task && <span className={`m-md-check${item.checked ? ' on' : ''}`}>{item.checked ? I.check : null}</span>}
      {leadText && <Inline src={leadText.text} />}
      {rest.map((t, i) => <Block key={i} t={t} />)}
    </li>
  );
}

function Block({ t }: { t: Token }): React.ReactElement | null {
  switch (t.type) {
    case 'code':
      return <CodeBlock code={(t as Tokens.Code).text} lang={(t as Tokens.Code).lang} />;
    case 'heading': {
      const h = t as Tokens.Heading;
      return <Inline tag={`h${Math.min(h.depth, 4)}`} className={`m-md-h m-md-h${Math.min(h.depth, 4)}`} src={h.text} />;
    }
    case 'paragraph':
      return <Inline tag="p" className="m-md-p" src={(t as Tokens.Paragraph).text} />;
    case 'blockquote': {
      const q = t as Tokens.Blockquote;
      return <blockquote className="m-md-quote">{(q.tokens ?? []).map((x, i) => <Block key={i} t={x} />)}</blockquote>;
    }
    case 'list': {
      const l = t as Tokens.List;
      const items = l.items.map((it, i) => <ListItem key={i} item={it} />);
      return l.ordered
        ? <ol className="m-md-ol" start={typeof l.start === 'number' ? l.start : 1}>{items}</ol>
        : <ul className="m-md-ul">{items}</ul>;
    }
    case 'table': {
      const tb = t as Tokens.Table;
      return (
        <div className="m-md-table-wrap">
          <table className="m-md-table">
            <thead><tr>{tb.header.map((c, i) => <th key={i} style={{ textAlign: tb.align[i] ?? 'left' }}><Inline src={c.text} /></th>)}</tr></thead>
            <tbody>{tb.rows.map((row, r) => <tr key={r}>{row.map((c, i) => <td key={i} style={{ textAlign: tb.align[i] ?? 'left' }}><Inline src={c.text} /></td>)}</tr>)}</tbody>
          </table>
        </div>
      );
    }
    case 'hr': return <hr className="m-md-hr" />;
    case 'space': return null;
    default:
      return <Inline tag="p" className="m-md-p" src={(t as { raw?: string }).raw ?? ''} />;
  }
}

/* ── Public: <Markdown text> ─────────────────────────────────────────────────*/
export function Markdown({ text }: { text: string }): React.ReactElement {
  const tokens = useMemo(() => { try { return marked.lexer(text || ''); } catch { return []; } }, [text]);
  return <div className="m-md">{tokens.map((t, i) => <Block key={i} t={t} />)}</div>;
}

/* Copy the whole message (plain source). Used by the message action row. */
export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/* ── Tool steps (Work / Code) ───────────────────────────────────────────────*/
export interface ToolStep {
  name: string;
  status: 'running' | 'ok' | 'denied' | 'failed';
  thought?: string;
  title?: string;
  diff?: string;   // "[+N -M]"
  error?: string;
}

/** "[+10 -3]" → coloured add/del counts. */
export function DiffBadge({ diff }: { diff: string }): React.ReactElement | null {
  const m = /\[\+(\d+)\s*-(\d+)\]/.exec(diff);
  if (!m) return null;
  return (
    <span className="m-diffbadge">
      <span className="m-diff-add">+{m[1]}</span>
      <span className="m-diff-del">−{m[2]}</span>
    </span>
  );
}

/* ── Tool-action summary row (interleaved between narration in Work/Code) ────*/
const VERB: Record<string, { verb: string; noun: string }> = {
  read: { verb: 'Read', noun: 'a file' },
  edit: { verb: 'Edited', noun: 'a file' },
  write: { verb: 'Wrote', noun: 'a file' },
  multiedit: { verb: 'Edited', noun: 'a file' },
  notebookedit: { verb: 'Edited', noun: 'a file' },
  bash: { verb: 'Ran', noun: 'a command' },
  glob: { verb: 'Searched', noun: 'the files' },
  grep: { verb: 'Searched', noun: 'the code' },
  todowrite: { verb: 'Updated', noun: 'the plan' },
  webfetch: { verb: 'Fetched', noun: 'a page' },
  websearch: { verb: 'Searched', noun: 'the web' },
  task: { verb: 'Ran', noun: 'an agent' },
};
const verbOf = (name: string) => VERB[name.toLowerCase()] ?? { verb: name, noun: '' };

/** A file name out of a tool title ("Edit /a/b/mobile.tsx" → "mobile.tsx"). */
export function fileFromTitle(title?: string): string | undefined {
  if (!title) return undefined;
  const toks = title.split(/\s+/);
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i].replace(/[),.:;]+$/, '');
    if (/[/.]/.test(t) && /[A-Za-z0-9]/.test(t) && !/^https?:$/.test(t)) return t.split(/[/\\]/).pop() || t;
  }
  return undefined;
}
function sumDiffs(steps: ToolStep[]) {
  return steps.reduce((a, s) => { const m = /\[\+(\d+)\s*-(\d+)\]/.exec(s.diff || ''); if (m) { a.add += +m[1]; a.del += +m[2]; } return a; }, { add: 0, del: 0 });
}
/** The verb for one tool ("Read" / "Edited" / "Ran"…), for tray headings. */
export function stepVerb(name: string): string { return verbOf(name).verb; }

/** "Read a file, edited a file" / "Read `mobile.tsx`" from a batch of steps. */
export function summarize(steps: ToolStep[]): { lead: string; file?: string } {
  const done = steps.filter((s) => s.status !== 'denied');
  if (done.length === 1) {
    const s = done[0]; const v = verbOf(s.name); const file = fileFromTitle(s.title);
    return file ? { lead: v.verb, file } : { lead: `${v.verb} ${v.noun}`.trim() };
  }
  const phrases: string[] = [];
  for (const s of done) { const v = verbOf(s.name); const p = `${v.verb} ${v.noun}`.trim(); if (!phrases.includes(p)) phrases.push(p); }
  const lead = phrases.map((p, i) => i === 0 ? p : p.charAt(0).toLowerCase() + p.slice(1)).join(', ');
  return { lead };
}

/** One interleaved tool-action row: a muted summary + diff badge + chevron; taps
 *  open the actions tray (which slides up like the model selector). */
export function ToolActionRow({ steps, onOpen }: { steps: ToolStep[]; onOpen: () => void }): React.ReactElement | null {
  if (!steps.length) return null;
  const running = steps.some((s) => s.status === 'running');
  const failed = steps.some((s) => s.status === 'denied' || s.status === 'failed');
  const { lead, file } = summarize(steps);
  const { add, del } = sumDiffs(steps);
  return (
    <button className={`m-toolrow${failed ? ' m-toolrow-bad' : ''}`} onClick={onOpen}>
      {running && <span className="m-toolrow-spin" aria-hidden="true" />}
      <span className="m-toolrow-lead">{lead}{file && <> <code>{file}</code></>}</span>
      {(add > 0 || del > 0) && <span className="m-toolrow-diff"><span className="m-diff-add">+{add}</span><span className="m-diff-del">−{del}</span></span>}
      <span className="m-toolrow-chev">{I.chevron}</span>
    </button>
  );
}

const glyphFor = (s: ToolStep['status']) =>
  s === 'running' ? <span className="m-tool-spin" /> : s === 'ok' ? <span className="m-tool-ok">{I.check}</span> : <span className="m-tool-bad">✕</span>;

/**
 * A run's tool calls, collapsed into one summary row ("Ran 4 tools · 1 failed")
 * that expands to the individual steps. Tapping a step opens the detail tray
 * (onOpenDetail) — the "sub-task list that opens from a tray".
 */
export function ToolGroup({ steps, onOpenDetail }: { steps: ToolStep[]; onOpenDetail?: (s: ToolStep) => void }): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  if (!steps.length) return null;
  const running = steps.some((s) => s.status === 'running');
  const failed = steps.filter((s) => s.status === 'denied' || s.status === 'failed').length;
  const n = steps.length;
  const summary = running
    ? `Running ${n} tool${n > 1 ? 's' : ''}…`
    : `Ran ${n} tool${n > 1 ? 's' : ''}${failed ? ` · ${failed} failed` : ''}`;
  return (
    <div className={`m-tools${running ? ' m-tools-live' : ''}`}>
      <button className="m-tools-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="m-tools-chev" data-open={open}>{I.chevron}</span>
        <span className="m-tools-summary">{summary}</span>
        {running && <span className="m-tools-livedot" aria-hidden="true" />}
      </button>
      {open && (
        <ul className="m-tools-list">
          {steps.map((s, i) => (
            <li key={i}>
              <button className="m-tool-row" data-status={s.status} onClick={() => onOpenDetail?.(s)}>
                <span className="m-tool-glyph">{glyphFor(s.status)}</span>
                <span className="m-tool-name">{s.title || s.name}</span>
                {s.diff && <DiffBadge diff={s.diff} />}
                {onOpenDetail && <span className="m-tool-more">{I.chevron}</span>}
              </button>
              {s.error && <div className="m-tool-err">{s.error}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
