/** Lightweight markdown -> HTML renderer for LLM output.
 *  Handles: code fences, headers, bold, italic, inline code, links,
 *  unordered/ordered lists, blockquotes, horizontal rules, paragraphs. */
import { highlight } from "./highlight.js";

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

/** `path/with/a.ext` or `/abs/path.ext`, with an optional `:line[:col]`. */
const FILE_REF = /^((?:\.{1,2})?\/?(?:[\w@.+-]+\/)+[\w@.+-]+\.[A-Za-z0-9]{1,8})(?::\d+(?::\d+)?)?$/;

/** An image source the renderer may show: the web, an inline raster, or a file
 *  on this machine. Anything else (javascript:, relative paths we cannot
 *  resolve) is not an image. SVG is allowed because an <img> never runs it. */
function safeImageSrc(raw: string): string | null {
  const u = raw.trim().replace(/&amp;/g, "&");
  if (/^https?:\/\//i.test(u)) return u;
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif|svg\+xml);base64,[a-z0-9+/=\s]+$/i.test(u)) return u;
  if (/^file:\/\//i.test(u)) return u;
  const local = localPathOf(u);
  return local ? fileUrlOf(local) : null;
}

/** An absolute path on this machine, from a bare path or a file:// URL. */
function localPathOf(raw: string): string | null {
  const u = raw.trim().replace(/&amp;/g, "&");
  if (/^file:\/\//i.test(u)) {
    try { return decodeURIComponent(u.replace(/^file:\/\//i, "")) || null; } catch { return null; }
  }
  if (u.startsWith("/") && !u.startsWith("//")) return u;
  if (/^[a-z]:[\\/]/i.test(u)) return u;
  return null;
}

function fileUrlOf(p: string): string {
  const s = p.replace(/\\/g, "/");
  return "file://" + (s.startsWith("/") ? s : `/${s}`).split("/").map(encodeURIComponent).join("/");
}

/** ONE delegated handler for images and file links, installed once, like the
 *  code-block actions: a picture opens the lightbox, a file opens the preview
 *  (or, where no preview host exists, the file itself beside the panel). A
 *  picture that will not load says so rather than leaving a broken frame. */
function installMediaActions(): void {
  if (typeof document === "undefined") return;
  const w = window as unknown as {
    __yoMdMedia?: boolean;
    __glyphhLightbox?: (src: string, alt: string) => void;
    __glyphhOpenArtifact?: (path: string) => void;
    __wbOpenFile?: (path: string) => void;
  };
  if (w.__yoMdMedia) return;
  w.__yoMdMedia = true;
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    const img = t?.closest<HTMLImageElement>("img.yo-md-img");
    if (img) {
      e.preventDefault();
      e.stopPropagation();
      if (w.__glyphhLightbox) w.__glyphhLightbox(img.currentSrc || img.src, img.alt);
      else window.open(img.currentSrc || img.src, "_blank", "noopener");
      return;
    }
    const file = t?.closest<HTMLElement>("a.yo-md-file, code.yo-md-path");
    if (file?.dataset.path) {
      e.preventDefault();
      e.stopPropagation();
      // A relative reference is relative to the folder the agent works in.
      const raw = file.dataset.path;
      const folder = (window as unknown as { __glyphhCurrentFolder?: () => string | null }).__glyphhCurrentFolder?.() || "";
      const abs = raw.startsWith("/") || /^[a-z]:[\\/]/i.test(raw) || !folder ? raw : `${folder.replace(/\/$/, "")}/${raw.replace(/^\.\//, "")}`;
      if (w.__glyphhOpenArtifact) w.__glyphhOpenArtifact(abs);
      else w.__wbOpenFile?.(abs);
    }
  }, true);
  document.addEventListener("error", (e) => {
    const img = e.target as HTMLElement | null;
    if (img instanceof HTMLImageElement && img.classList.contains("yo-md-img")) img.closest(".yo-md-figure")?.classList.add("broken");
  }, true);
}
installMediaActions();

/** WHERE A STREAMING REPLY MAY BE CUT: the end of its last blank line that is
 *  not inside a code fence. Everything before it is finished markdown that will
 *  not change, so it is rendered once (help/code.ts paintBubble). */
export function streamStableCut(text: string): number {
  let inFence = false;
  let cut = 0;
  let pos = 0;
  for (const line of text.split("\n")) {
    const end = pos + line.length + 1;
    if (/^```/.test(line)) inFence = !inFence;
    else if (!inFence && line.trim() === "" && end <= text.length) cut = end;
    pos = end;
  }
  return cut;
}

export function formatMarkdown(text: string): string {
  if (!text) return "";

  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  /** An attribute value: `esc` leaves quotes alone, and a quote in a URL used
   *  to END the attribute — `[x](https://a" onmouseover="…)` put a handler on
   *  the link, script inside the app's renderer (found 2026-09-29). */
  const attr = (v: string): string => v.replace(/"/g, "&quot;");
  const emph = (s: string): string =>
    s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>").replace(/~~(.+?)~~/g, "<del>$1</del>");

  const inline = (s: string): string => {
    // HELD SPANS: code, images and links are finished HTML the later passes
    // must not touch — a code span showing `[text](url)` is literal, and a URL
    // inside a link's text must not become a second link inside the first.
    const held: string[] = [];
    const hold = (html: string): string => `\u0000${held.push(html) - 1}\u0000`;
    const out = s
      .replace(/`([^`]+)`/g, (_m: string, code: string) => {
        if (/^\.(dip|yo|sup|drip)\s/.test(code)) {
          return hold(`<code class="yo-md-inline yo-md-cmd" data-cmd="${attr(code)}" title="Click to copy">${code}</code>`);
        }
        // A FILE REFERENCE (`src/main/loop.ts:348`) opens the file: a path with
        // a folder and an extension, optionally a line. Anything looser stays
        // plain code — a false link is worse than no link.
        const ref = FILE_REF.exec(code);
        if (ref) return hold(`<code class="yo-md-inline yo-md-path" data-path="${attr(ref[1]!)}" title="Open ${attr(ref[1]!)}">${code}</code>`);
        return hold(`<code class="yo-md-inline">${code}</code>`);
      })
      // IMAGES (his order, 2026-09-29: "artifacts, images, links, modals
      // inline"): `![alt](src)` is a link with a bang, so it goes first. A
      // source we cannot vouch for stays as the text it was written as.
      .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m: string, alt: string, src: string) => {
        const safe = safeImageSrc(src);
        return safe
          ? hold(`<span class="yo-md-figure"><img class="yo-md-img" src="${attr(safe)}" alt="${attr(alt)}" loading="lazy" draggable="false">${alt ? `<span class="yo-md-caption">${alt}</span>` : ""}</span>`)
          : m;
      })
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match: string, text: string, url: string) => {
        const u = url.trim();
        const lower = u.toLowerCase();
        if (lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("mailto:")) {
          // target=_blank is LOAD-BEARING: a plain href top-level-navigates the
          // home view (the whole app UI) away to the site — unrecoverable. As a
          // window-open it routes into a workspace browser panel instead (the
          // home view's handler denies the OS window). Guarded main-side too.
          return hold(`<a class="yo-md-link" href="${attr(u)}" target="_blank" rel="noreferrer" title="${attr(u)}">${emph(text)}</a>`);
        }
        // A FILE ON THIS MACHINE opens where it belongs (the preview modal, or
        // the editor/browser beside the panel) — never as a navigation.
        const local = localPathOf(u);
        if (local) return hold(`<a class="yo-md-link yo-md-file" href="#" data-path="${attr(local)}" title="${attr(local)}">${emph(text)}</a>`);
        return hold(`<span class="yo-md-link" title="[blocked: unsafe URL]">${emph(text)}</span>`);
      })
      .replace(/(^|[^"=\u0000\d])(https?:\/\/[^\s<>&\u0000]+)/g, (_match: string, prefix: string, url: string) =>
        `${prefix}${hold(`<a class="yo-md-link" href="${attr(url)}" target="_blank" rel="noreferrer" title="${attr(url)}">${url}</a>`)}`,
      );
    return emph(out).replace(/\u0000(\d+)\u0000/g, (_m: string, i: string) => held[Number(i)] ?? "");
  };

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
    const fenceMatch = line.match(/^```([\w+#.-]*)/);
    if (fenceMatch) {
      const lang = fenceMatch[1] || "";
      // RAW lines: the highlighter escapes as it colours (his order,
      // 2026-09-29: "code highlighting… theme aligned per selected theme").
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
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
          `<pre class="yo-md-pre"><code class="tk">${highlight(codeLines.join("\n"), lang)}</code></pre>` +
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
      let tasks = false;
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
        const body = lines[i].replace(/^[-*+]\s+/, "");
        // A TASK LIST (`- [ ] todo`, `- [x] done`): a plan an agent keeps as
        // it works reads as one, with the done ones visibly done.
        const task = /^\[([ xX])\]\s+/.exec(body);
        if (task) {
          tasks = true;
          const done = task[1] !== " ";
          items.push(`<span class="yo-md-check${done ? " on" : ""}" aria-hidden="true"></span><span class="${done ? "yo-md-task-done" : ""}">${inline(esc(body.slice(task[0].length)))}</span>`);
        } else {
          items.push(inline(esc(body)));
        }
        i++;
      }
      out.push(`<ul class="yo-md-ul${tasks ? " yo-md-tasks" : ""}">${items.map((li) => `<li>${li}</li>`).join("")}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      // A list KEEPS ITS NUMBERS: "3." after a paragraph (a loose list, or a
      // reply still streaming in two parts) is item three, not a second item one.
      const start = Number(/^(\d+)\./.exec(line)?.[1] ?? "1");
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(inline(esc(lines[i].replace(/^\d+\.\s+/, ""))));
        i++;
      }
      out.push(`<ol class="yo-md-ol"${start > 1 ? ` start="${start}"` : ""}>${items.map((li) => `<li>${li}</li>`).join("")}</ol>`);
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
