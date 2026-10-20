/**
 * artifacts.ts — WHAT THE AGENT MADE, as cards with previews (his order,
 * 2026-09-29: "the big artifacts, images, links, modals inline to open that
 * content and all related").
 *
 * When a turn writes or edits a file, the thread gets a card for it: what it
 * is, where it lives, and a look at it — a thumbnail for a picture, the first
 * lines (highlighted) for code and text, the opening of a document. The card
 * opens the whole thing in a modal without leaving the conversation, and from
 * there in the surface it belongs in (the editor, the browser) beside the
 * panel.
 *
 * A PAGE PREVIEWS AS A PAGE (his report, 2026-09-29: "preview -> web view,
 * Open in browser should be as a render not as source, Edit -> open in Editor").
 * The preview is a SANDBOXED frame — scripts run, but with no
 * `allow-same-origin` the page gets an opaque origin: it cannot reach the app
 * document (itself a file:// page) or its bridges, and nothing in the app
 * listens for its messages. Open in browser renders it in the browser panel;
 * Edit opens the source in the editor. Source is never what "preview" means.
 */

import { formatMarkdown } from "../format-markdown.js";
import { highlight, languageOf } from "../highlight.js";

export interface ArtifactRef { path: string; verb: "Created" | "Edited" }

type Kind = "image" | "html" | "markdown" | "text" | "pdf" | "other";

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"]);
const HTML = new Set(["html", "htm"]);
const MARKDOWN = new Set(["md", "markdown", "mdx"]);
const PLAIN = new Set(["txt", "log", "csv", "tsv", "env", "gitignore", "lock", "text"]);
const PREVIEW_LINES = 14;
const MODAL_MAX_CHARS = 200_000;

const extOf = (p: string): string => (p.split(/[\\/]/).pop() ?? "").split(".").slice(1).pop()?.toLowerCase() ?? "";
const nameOf = (p: string): string => p.split(/[\\/]/).pop() || p;
const dirOf = (p: string): string => p.slice(0, Math.max(0, p.length - nameOf(p).length - 1));

function kindOf(p: string): Kind {
  const e = extOf(p);
  if (IMAGE.has(e)) return "image";
  if (HTML.has(e)) return "html";
  if (MARKDOWN.has(e)) return "markdown";
  if (e === "pdf") return "pdf";
  if (PLAIN.has(e) || languageOf(e)) return "text";
  return "other";
}

export function fileUrl(p: string): string {
  const s = String(p || "").replace(/\\/g, "/");
  return "file://" + (s.startsWith("/") ? s : `/${s}`).split("/").map(encodeURIComponent).join("/");
}

/** A home-relative display path: the person reads "~/app/src", not the full
 *  absolute path, on a card that is about the file. */
function shortDir(d: string): string {
  return d.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

interface WbFiles { readFile?: (p: string) => Promise<{ content?: string; error?: string }> }
const wbFiles = (): WbFiles => ((window as unknown as { wb?: WbFiles }).wb ?? {});

/**
 * The last text read for a path, kept so a REBUILT card paints its preview
 * synchronously. The thread is re-rendered on every tool frame of a live run;
 * when each rebuild had to wait on an async read, the card painted short, then
 * grew — the view lurched to the buttons and flickered while the agent typed.
 * A card first paints from here, then refreshes from disk when the read lands.
 */
const textCache = new Map<string, string>();

async function readText(p: string): Promise<{ text: string } | { error: string }> {
  try {
    const r = await wbFiles().readFile?.(p);
    if (!r) return { error: "This surface can't read files." };
    if (r.error) return { error: r.error };
    const text = String(r.content ?? "");
    textCache.set(p, text);
    return { text };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

type Door = "__wbOpenFile" | "__wbBrowseFile" | "__wbEditFile";
const door = (d: Door, p: string): void => { (window as unknown as Record<Door, ((path: string) => void) | undefined>)[d]?.(p); };
/** RENDERED, in the browser panel beside the agent. */
const browse = (p: string): void => door("__wbBrowseFile", p);
/** The SOURCE, in the editor, whatever the file is. */
const edit = (p: string): void => door("__wbEditFile", p);
/** Whatever the workbench thinks best (a file with no preview of its own). */
const openSmart = (p: string): void => door("__wbOpenFile", p);

/** A live, sandboxed render of a page (see the header for why it is safe). */
function pageFrame(p: string, className: string): HTMLIFrameElement {
  const f = document.createElement("iframe");
  f.className = className;
  f.src = fileUrl(p);
  f.setAttribute("sandbox", "allow-scripts allow-forms allow-modals allow-popups");
  f.setAttribute("referrerpolicy", "no-referrer");
  f.loading = "lazy";
  f.title = nameOf(p);
  return f;
}

/** WHICH FILE A TOOL STEP WROTE — from the step's own title ("write_file
 *  <path>"), resolved against the thread's folder when the model used a
 *  relative path. Anything that is not a successful write is not an artifact. */
export function artifactFromTool(name: string, title: string | undefined, workdir: string | undefined, failed: boolean): ArtifactRef | null {
  if (failed) return null;
  const verb = name === "write_file" ? "Created" : name === "edit_file" ? "Edited" : null;
  if (!verb || !title?.startsWith(`${name} `)) return null;
  const raw = title.slice(name.length + 1).trim();
  if (!raw) return null;
  const abs = raw.startsWith("/") || /^[a-z]:[\\/]/i.test(raw) ? raw : workdir ? `${workdir.replace(/\/$/, "")}/${raw.replace(/^\.\//, "")}` : raw;
  return { path: abs, verb };
}

const ICON: Record<Kind, string> = {
  image: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="M3 17l5.5-5 4 3.5 3-2.5L21 17"/></svg>`,
  html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.8 2.6 2.8 15.4 0 18M12 3c-2.8 2.6-2.8 15.4 0 18"/></svg>`,
  markdown: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M7 15V9l2.5 3L12 9v6M16 9v6M14 13l2 2 2-2"/></svg>`,
  text: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 7 4 12 9 17"/><polyline points="15 7 20 12 15 17"/></svg>`,
  pdf: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/><path d="M9 15h6M9 12h6"/></svg>`,
  other: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/></svg>`,
};

function button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `art-btn${primary ? " primary" : ""}`;
  b.textContent = label;
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
  return b;
}

function copyPath(p: string, b: HTMLButtonElement): void {
  void navigator.clipboard.writeText(p).then(() => {
    const was = b.textContent;
    b.textContent = "Copied";
    b.classList.add("copied");
    setTimeout(() => { b.textContent = was; b.classList.remove("copied"); }, 1400);
  }).catch(() => { /* clipboard refused: the path is on the card */ });
}

/** The card a turn's file lands as. Its preview loads lazily and degrades to
 *  the file's name and actions when the file cannot be read (moved, too big). */
export function artifactCardEl(a: ArtifactRef, lightbox: (src: string, name: string) => void): HTMLElement {
  const kind = kindOf(a.path);
  const card = document.createElement("div");
  card.className = `art-card ${kind}`;
  card.title = a.path;

  const head = document.createElement("div");
  head.className = "art-head";
  head.innerHTML = `<span class="art-ic">${ICON[kind]}</span>`;
  const meta = document.createElement("div");
  meta.className = "art-meta";
  const name = document.createElement("span");
  name.className = "art-name";
  name.textContent = nameOf(a.path);
  const dir = document.createElement("span");
  dir.className = "art-dir";
  dir.textContent = shortDir(dirOf(a.path));
  meta.append(name, dir);
  const verb = document.createElement("span");
  verb.className = `art-verb ${a.verb === "Created" ? "created" : "edited"}`;
  verb.textContent = a.verb;
  head.append(meta, verb);
  card.appendChild(head);

  const preview = document.createElement("div");
  preview.className = "art-preview";
  if (kind === "image") {
    const img = document.createElement("img");
    img.src = fileUrl(a.path);
    img.alt = nameOf(a.path);
    img.loading = "lazy";
    img.draggable = false;
    img.onerror = () => { preview.remove(); };
    img.addEventListener("click", (e) => { e.stopPropagation(); lightbox(img.src, nameOf(a.path)); });
    preview.appendChild(img);
    card.appendChild(preview);
  } else if (kind === "html") {
    // A THUMBNAIL OF THE PAGE ITSELF: a full-width render, scaled down, that
    // does not take clicks (the card opens the real preview).
    preview.classList.add("art-page");
    const thumb = pageFrame(a.path, "art-page-frame");
    // A thumbnail shows the top of the page, not a scrollbar.
    thumb.setAttribute("scrolling", "no");
    thumb.tabIndex = -1;
    preview.appendChild(thumb);
    card.appendChild(preview);
  } else if (kind === "text" || kind === "markdown") {
    card.appendChild(preview);
    let painted: string | null = null;
    const paint = (text: string): void => {
      if (text === painted) return; // same bytes → leave the DOM alone (no flicker)
      painted = text;
      preview.textContent = "";
      const lines = text.split("\n");
      const head14 = lines.slice(0, PREVIEW_LINES).join("\n");
      const pre = document.createElement("pre");
      pre.className = "art-code";
      const code = document.createElement("code");
      code.className = "tk";
      code.innerHTML = highlight(head14, kind === "markdown" ? "md" : extOf(a.path));
      pre.appendChild(code);
      preview.appendChild(pre);
      if (lines.length > PREVIEW_LINES) {
        const more = document.createElement("div");
        more.className = "art-more";
        more.textContent = `${lines.length - PREVIEW_LINES} more line${lines.length - PREVIEW_LINES === 1 ? "" : "s"}`;
        preview.appendChild(more);
      }
    };
    // Paint what we last read RIGHT NOW so the card is full height on first
    // layout; then refresh from disk (the agent may still be writing it).
    const cached = textCache.get(a.path);
    if (cached !== undefined) paint(cached);
    void readText(a.path).then((r) => {
      if ("error" in r) { if (painted === null) preview.remove(); return; }
      paint(r.text);
    });
  }

  const acts = document.createElement("div");
  acts.className = "art-acts";
  // PREVIEW is a look without leaving the thread; OPEN IN BROWSER renders it
  // beside the panel; EDIT is always the source, in the editor.
  if (kind === "html") {
    acts.append(
      button("Preview", () => openArtifactModal(a.path, lightbox), true),
      button("Open in browser", () => browse(a.path)),
      button("Edit", () => edit(a.path)),
    );
  } else if (kind === "text" || kind === "markdown") {
    acts.append(button("Preview", () => openArtifactModal(a.path, lightbox), true), button("Edit", () => edit(a.path)));
  } else if (kind === "image") {
    acts.append(button("Open", () => lightbox(fileUrl(a.path), nameOf(a.path)), true));
  } else if (kind === "pdf") {
    acts.append(button("Open in browser", () => browse(a.path), true));
  } else {
    acts.append(button("Open", () => openSmart(a.path), true));
  }
  const cp = button("Copy path", () => copyPath(a.path, cp));
  acts.appendChild(cp);
  card.appendChild(acts);
  // The card itself opens the preview — the most common thing to want.
  card.addEventListener("click", () => {
    if (kind === "image") lightbox(fileUrl(a.path), nameOf(a.path));
    else if (kind === "pdf") browse(a.path);
    else if (kind === "other") openSmart(a.path);
    else openArtifactModal(a.path, lightbox);
  });
  return card;
}

/** WHERE THE MODAL MOUNTS: the visible agent panel, so the preview stays
 *  inside the window it was opened from (a workspace card, a rail seat) rather
 *  than covering the whole app. With no agent showing it falls back to the
 *  body, where it covers the window as before. */
function modalHost(): { host: HTMLElement; inPanel: boolean } {
  const agent = document.querySelector<HTMLElement>(".ws-agent-holder > .code-agent")
    ?? document.querySelector<HTMLElement>(".code-agent");
  if (agent) {
    const r = agent.getBoundingClientRect();
    if (r.width > 120 && r.height > 120 && agent.offsetParent !== null) return { host: agent, inPanel: true };
  }
  return { host: document.body, inPanel: false };
}

/** THE INLINE MODAL: the whole file, over the conversation, without leaving
 *  it. Markdown renders, code highlights, a picture goes to the lightbox, and
 *  a page offers the browser — never a frame (see the header). */
export function openArtifactModal(path: string, lightbox: (src: string, name: string) => void): void {
  const kind = kindOf(path);
  if (kind === "image") { lightbox(fileUrl(path), nameOf(path)); return; }
  if (kind === "pdf") { browse(path); return; }
  if (kind === "other") { openSmart(path); return; }
  document.querySelector(".art-modal")?.remove();
  const { host, inPanel } = modalHost();

  const overlay = document.createElement("div");
  overlay.className = `art-modal${inPanel ? " in-panel" : ""}`;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", nameOf(path));
  const panel = document.createElement("div");
  panel.className = "art-modal-panel";

  const head = document.createElement("div");
  head.className = "art-modal-head";
  head.innerHTML = `<span class="art-ic">${ICON[kind]}</span>`;
  const meta = document.createElement("div");
  meta.className = "art-meta";
  const name = document.createElement("span");
  name.className = "art-name";
  name.textContent = nameOf(path);
  const dir = document.createElement("span");
  dir.className = "art-dir";
  dir.textContent = shortDir(dirOf(path));
  meta.append(name, dir);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "art-close";
  close.setAttribute("aria-label", "Close");
  close.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
  head.append(meta, close);

  const body = document.createElement("div");
  body.className = "art-modal-body";
  body.textContent = "Loading…";

  const foot = document.createElement("div");
  foot.className = "art-modal-foot";
  const cp = button("Copy path", () => copyPath(path, cp));
  const editBtn = button("Edit", () => { dismiss(); edit(path); });
  if (kind === "html") foot.append(cp, editBtn, button("Open in browser", () => { dismiss(); browse(path); }, true));
  else { editBtn.classList.add("primary"); foot.append(cp, editBtn); }

  panel.append(head, body, foot);
  overlay.appendChild(panel);
  host.appendChild(overlay);

  const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") { e.stopPropagation(); dismiss(); } };
  const dismiss = (): void => { overlay.remove(); document.removeEventListener("keydown", onKey, true); };
  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) dismiss(); });
  close.addEventListener("click", dismiss);
  requestAnimationFrame(() => close.focus());

  if (kind === "html") {
    // THE PAGE, RENDERED (his order, 2026-09-29: "preview -> web view"). The
    // source is one click away (Edit); a preview is what the page looks like.
    body.innerHTML = "";
    body.classList.add("art-modal-page");
    panel.classList.add("wide");
    body.appendChild(pageFrame(path, "art-modal-frame"));
    return;
  }
  void readText(path).then((r) => {
    body.innerHTML = "";
    if ("error" in r) {
      const e = document.createElement("div");
      e.className = "art-note";
      e.textContent = `This file couldn't be read: ${r.error}`;
      body.appendChild(e);
      return;
    }
    const text = r.text.length > MODAL_MAX_CHARS ? `${r.text.slice(0, MODAL_MAX_CHARS)}\n…` : r.text;
    if (kind === "markdown") {
      const md = document.createElement("div");
      md.className = "art-md code-agent-text";
      md.innerHTML = formatMarkdown(text);
      body.appendChild(md);
      return;
    }
    const pre = document.createElement("pre");
    pre.className = "art-code full";
    const code = document.createElement("code");
    code.className = "tk";
    code.innerHTML = highlight(text, extOf(path));
    pre.appendChild(code);
    body.appendChild(pre);
  });
}
