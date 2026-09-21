/** Lightweight markdown -> HTML renderer for LLM output.
 *  Handles: code fences, headers, bold, italic, inline code, links,
 *  unordered/ordered lists, blockquotes, horizontal rules, paragraphs. */
/** Blocks the agent means as commands: they get a run action beside copy. */
const SHELL_LANGS: ReadonlySet<string> = new Set(["bash", "sh", "zsh", "shell", "console", "terminal", "cmd", "powershell", "ps1", "fish"]);
const COPY_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const CHECK_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const RUN_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>';

/** The command a shell block types into a terminal: prompt markers stripped,
 *  one Enter per line. */
export function shellCommandOf(code: string): string {
  return code.split("\n").map((l) => l.replace(/^\s*(\$|>|%)\s+/, "")).filter((l) => l.trim() !== "").join("\r");
}

/** ONE delegated handler for every code block on the page, wherever it was
 *  rendered (chat thread, docs, the workbench's markdown preview) and however
 *  often that host re-renders: copy flips the icon to a check for a moment; run
 *  hands the command to the workbench, which opens a terminal panel and types
 *  it. Installed once per window on module load. */
function installCodeBlockActions(): void {
  if (typeof document === "undefined") return;
  const w = window as unknown as { __yoMdActions?: boolean; __wbRunInTerminal?: (cmd: string) => void };
  if (w.__yoMdActions) return;
  w.__yoMdActions = true;
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    const btn = t?.closest<HTMLButtonElement>(".yo-md-copy-btn, .yo-md-run-btn");
    if (!btn) return;
    const code = btn.closest(".yo-md-codeblock")?.querySelector("pre code")?.textContent ?? "";
    e.preventDefault();
    e.stopPropagation();
    if (btn.classList.contains("yo-md-run-btn")) {
      const run = w.__wbRunInTerminal;
      if (run) { run(shellCommandOf(code)); return; }
    }
    void navigator.clipboard.writeText(code).then(() => {
      btn.innerHTML = CHECK_SVG;
      btn.classList.add("yo-copied");
      btn.title = "Copied";
      setTimeout(() => { btn.innerHTML = btn.classList.contains("yo-md-run-btn") ? RUN_SVG : COPY_SVG; btn.classList.remove("yo-copied"); btn.title = btn.classList.contains("yo-md-run-btn") ? "Run in a terminal" : "Copy"; }, 1500);
    }).catch(() => { /* clipboard refused: the block is still selectable */ });
  }, true);
}
installCodeBlockActions();

export function formatMarkdown(text: string): string {
  if (!text) return "";

  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const inline = (s: string) =>
    s
      .replace(/`([^`]+)`/g, (_m: string, code: string) => {
        if (/^\.(dip|yo|sup|drip)\s/.test(code)) {
          return `<code class="yo-md-inline yo-md-cmd" data-cmd="${code}" title="Click to copy">${code}</code>`;
        }
        return `<code class="yo-md-inline">${code}</code>`;
      })
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match: string, text: string, url: string) => {
        const trimmed = url.trim().toLowerCase();
        if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("mailto:")) {
          // target=_blank is LOAD-BEARING: a plain href top-level-navigates the
          // home view (the whole app UI) away to the site — unrecoverable. As a
          // window-open it routes into a workspace browser panel instead (the
          // home view's handler denies the OS window). Guarded main-side too.
          return `<a class="yo-md-link" href="${url}" target="_blank" rel="noreferrer" title="${url}">${text}</a>`;
        }
        return `<span class="yo-md-link" title="[blocked: unsafe URL]">${text}</span>`;
      })
      .replace(/(^|[^"=])(https?:\/\/[^\s<>&]+)/g, (_match: string, prefix: string, url: string) =>
        `${prefix}<a class="yo-md-link" href="${url}" target="_blank" rel="noreferrer" title="${url}">${url}</a>`
      );

  // Some models emit a whole pipe table on ONE LINE (rows joined with spaces:
  // "…| Use Case | | :--- | :--- | | Pinecone |…"). Re-split rows on the
  // "| |" boundary — only for paragraphs that really are tables (a ":---"
  // separator cell present), so prose with pipes is never touched.
  const repaired = text.replace(/^.*\|\s*:?-{3,}.*$/gm, (para) =>
    /\|\s+\|/.test(para) && /\|\s*:?-{3,}:?\s*\|/.test(para)
      ? para.replace(/\|\s+\|/g, "|\n|")
      : para,
  );

  const lines = repaired.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Container directives (Glyphh Docs): `:::glyphh …` is inert metadata (the
    // document's style directive); `:::callout|note|tip|warning|info [title]`
    // and `:::columns` are structured blocks that render richly. Closed by a
    // lone `:::`. Safe/additive for chat too (`:::` blocks are rare there).
    const dir = line.match(/^:::(\w+)(?:\s+(.*))?$/);
    if (dir) {
      const kind = dir[1].toLowerCase();
      if (kind === "glyphh") { i++; continue; }   // style directive → render nothing
      const CALLOUTS: Record<string, string> = { callout: "note", note: "note", tip: "tip", warning: "warning", info: "info", important: "warning" };
      i++;
      const inner: string[] = [];
      while (i < lines.length && lines[i].trim() !== ":::") { inner.push(lines[i]); i++; }
      if (i < lines.length) i++;   // consume closing :::
      if (kind === "columns") {
        const cols = inner.join("\n").split(/^\+\+\+\s*$/m);
        out.push(`<div class="yo-md-columns">${cols.map((c) => `<div class="yo-md-col">${formatMarkdown(c.trim())}</div>`).join("")}</div>`);
      } else {
        const cls = CALLOUTS[kind] ?? "note";
        const title = dir[2] ? `<div class="yo-md-callout-t">${inline(esc(dir[2]))}</div>` : "";
        out.push(`<div class="yo-md-callout yo-md-callout-${cls}">${title}<div class="yo-md-callout-b">${formatMarkdown(inner.join("\n"))}</div></div>`);
      }
      continue;
    }

    // Fenced code block
    const fenceMatch = line.match(/^```(\w*)/);
    if (fenceMatch) {
      const lang = fenceMatch[1] || "";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(esc(lines[i]));
        i++;
      }
      if (i < lines.length) i++;
      const label = lang || "code";
      const codeId = `yo-code-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const runBtn = SHELL_LANGS.has(lang.toLowerCase())
        ? `<button class="yo-md-run-btn" type="button" title="Run in a terminal" aria-label="Run in a terminal">${RUN_SVG}</button>`
        : "";
      out.push(
        `<div class="yo-md-codeblock" data-code-id="${codeId}" data-lang="${esc(lang)}">` +
          `<div class="yo-md-codeblock-header">` +
            `<span class="yo-md-codeblock-lang">${esc(label)}</span>` +
            `<span class="yo-md-codeblock-actions">` +
              `<button class="yo-md-copy-btn" type="button" title="Copy" aria-label="Copy">${COPY_SVG}</button>` +
              runBtn +
            `</span>` +
          `</div>` +
          `<pre class="yo-md-pre"><code>${codeLines.join("\n")}</code></pre>` +
        `</div>`
      );
      continue;
    }

    // Heading
    const hMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (hMatch) {
      const level = hMatch[1].length;
      out.push(`<h${level} class="yo-md-h${level}">${inline(esc(hMatch[2]))}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr class="yo-md-hr">');
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith("> ") || line === ">") {
      const quoteLines: string[] = [];
      while (i < lines.length && (lines[i].startsWith("> ") || lines[i] === ">")) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push(`<blockquote class="yo-md-quote">${inline(esc(quoteLines.join("\n")))}</blockquote>`);
      continue;
    }

    // Table — a header row of pipes with a :--- separator line under it.
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const cells = (row: string): string[] =>
        row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(cells(lines[i]));
        i++;
      }
      // Wide tables scroll in their own container — the bubble never does.
      out.push(
        `<div class="yo-md-tablewrap"><table class="yo-md-table"><thead><tr>` +
          head.map((h) => `<th>${inline(esc(h))}</th>`).join("") +
        `</tr></thead><tbody>` +
          rows.map((r) => `<tr>${head.map((_h, ci) => `<td>${inline(esc(r[ci] ?? ""))}</td>`).join("")}</tr>`).join("") +
        `</tbody></table></div>`,
      );
      continue;
    }

    // Unordered list
    if (/^[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
        items.push(inline(esc(lines[i].replace(/^[-*+]\s+/, ""))));
        i++;
      }
      out.push(`<ul class="yo-md-ul">${items.map((li) => `<li>${li}</li>`).join("")}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(inline(esc(lines[i].replace(/^\d+\.\s+/, ""))));
        i++;
      }
      out.push(`<ol class="yo-md-ol">${items.map((li) => `<li>${li}</li>`).join("")}</ol>`);
      continue;
    }

    // Blank line
    if (line.trim() === "") { i++; continue; }

    // Paragraph
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].match(/^```/) &&
      !lines[i].match(/^#{1,4}\s/) &&
      !lines[i].match(/^[-*+]\s+/) &&
      !lines[i].match(/^\d+\.\s+/) &&
      !lines[i].startsWith("> ") &&
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]) &&
      // a table header (pipe row with a :--- separator under it) starts its
      // own block - the paragraph must not swallow it
      !(/^\s*\|.*\|\s*$/.test(lines[i]) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1]) && lines[i + 1].includes("-"))
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    out.push(`<p class="yo-md-p">${inline(esc(paraLines.join("\n")))}</p>`);
  }

  return out.join("");
}
