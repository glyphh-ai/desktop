/**
 * md-doc.ts — the DOCUMENT markdown renderer: marked (GFM) + DOMPurify.
 *
 * Docs preview/thumbnails/PDF render through a real markdown engine, not the
 * chat formatter (his bug, 2026-08-25: a paper full of `&nbsp;` spacing and
 * inline HTML rendered the entities as literal text — the chat formatter
 * escapes `&` wholesale, which is right for LLM chat output and wrong for a
 * document). Same engine + sanitizer pair the web's md.tsx uses; bundled, no
 * CDN. Chat keeps format-markdown.ts (its `.dip` command affordances and
 * hard-escape posture are chat features, not document ones).
 *
 * Glyphh Docs directives survive: `:::glyphh …` (the style directive) renders
 * nothing; `:::callout|note|tip|warning|info|important [title]` and
 * `:::columns` become the same structured blocks the old renderer emitted,
 * their inner markdown rendered recursively.
 */

import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: false });

const CALLOUTS: Record<string, string> = {
  callout: "note", note: "note", tip: "tip", warning: "warning", info: "info", important: "warning",
};

/** Expand Glyphh `:::` container directives into HTML shells whose INNER
 *  markdown is rendered recursively; drop the `:::glyphh` style block. */
function expandDirectives(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const dir = lines[i]!.match(/^:::(\w+)(?:\s+(.*))?$/);
    if (!dir) { out.push(lines[i]!); i++; continue; }
    const kind = dir[1]!.toLowerCase();
    const title = (dir[2] ?? "").trim();
    i++;
    const inner: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== ":::") { inner.push(lines[i]!); i++; }
    if (i < lines.length) i++; // consume closing :::
    if (kind === "glyphh") continue; // style directive → render nothing
    if (kind === "columns") {
      const cols = inner.join("\n").split(/^\s*---\s*$/m);
      out.push(`<div class="gdoc-columns">${cols.map((c) => `<div class="gdoc-column">${renderDocMarkdown(c)}</div>`).join("")}</div>`);
      continue;
    }
    const cls = CALLOUTS[kind];
    if (cls) {
      const head = title ? `<div class="gdoc-callout-title">${escapeText(title)}</div>` : "";
      out.push(`<div class="gdoc-callout gdoc-callout-${cls}">${head}${renderDocMarkdown(inner.join("\n"))}</div>`);
      continue;
    }
    // Unknown directive — render its body as plain markdown rather than eating it.
    out.push(renderDocMarkdown(inner.join("\n")));
  }
  return out.join("\n");
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Render DOCUMENT markdown to sanitized HTML. */
export function renderDocMarkdown(md: string): string {
  if (!md) return "";
  const html = marked.parse(expandDirectives(md), { async: false }) as string;
  return DOMPurify.sanitize(html, {
    // Documents legitimately carry inline HTML (alignment wrappers, &nbsp;
    // spacing, <br>, tables); scripts/handlers/iframes are stripped.
    ADD_ATTR: ["align"],
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form"],
  });
}
