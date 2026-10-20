/**
 * artifacts-panel.ts — THE ARTIFACTS PANEL (his order, 2026-10-05): the
 * list (a search, rows with a type icon, "Edited <date>", a ⋮ with Rename /
 * Delete, newest first grouped by month), the VIEWER (the title, Comment,
 * Start chat; the content in a SANDBOXED frame — scripts run, no
 * allow-same-origin — an image as <img>, markdown and text as text) and the
 * COMMENTS OVERLAY (a Comment mode where the pointer draws a dashed region
 * over the frame, a numbered pin with the thread, replies, Resolve, Delete,
 * and "Send to Glyphh" which puts the thread into the agent's composer and
 * sends it).
 *
 * LOCAL ONLY (2026-10-18): the artifacts are this machine's files and the
 * one user's, so there is no Share, no access level and no Yours / Shared
 * split — one list.
 *
 * One body for both surfaces: on the desktop it is an ordinary work panel
 * (code-workbench.ts mounts it into a card; the viewer swaps in with a back
 * arrow); on the web it fills the full-screen host (surface.ts
 * webPanelOpensFullScreen) whose own header carries "‹ Artifacts". The rules
 * are artifact-rules.ts's; the transport is `window.glyphh.artifacts*` — the
 * desktop's IPC into main (artifacts-ipc.ts) or the web's SDK shims
 * (web-contract.js) — every answer an `{ ok, data | error }` envelope.
 *
 * The content bytes never reach this document's origin as a page: the web
 * frames `/a/<id>/raw`, a same-origin proxy of the content route
 * (web/artifact-proxy.mjs) that carries the session as a path-scoped
 * cookie; the desktop fetches the bytes through main into a blob URL. Both
 * land in a frame with `sandbox="allow-scripts"` and nothing else.
 */

import {
  artifactKind, artifactRender, commentAge, editPrompt, editedLabel, groupByMonth, initialOf, orderThreads, pinNumbers,
  pinPoint, regionFromDrag, regionIsReal, regionToRect, searchArtifacts, startChatLine, threadText,
  type ArtifactComment, type ArtifactMeta, type CommentRegion,
} from "./artifact-rules.js";
import { formatMarkdown } from "../format-markdown.js";
import { createGlyphhSpinner, type GlyphhSpinner } from "../glyphh-spinner.js";
import { highlight } from "../highlight.js";
import { confirmAction, promptAction } from "./shared.js";
import { toast } from "./toast.js";
import { onWeb } from "./web-surface.js";
import { openRowMenu, ROW_MENU_ICONS } from "./lib-editor.js";

type Env<T> = { ok: true; data: T } | { ok: false; error?: string };

/** The transport, both surfaces (preload.ts / web-contract.js). */
export interface ArtifactsBridge {
  artifactsList?: () => Promise<Env<ArtifactMeta[]>>;
  artifactsGet?: (id: string) => Promise<Env<ArtifactMeta>>;
  /** DESKTOP: the bytes, base64, with their mime (main read the file). */
  artifactsContent?: (id: string) => Promise<Env<{ base64: string; mime: string }>>;
  /** A rename; the answer is the row under its new id (the id is the filename). */
  artifactsUpdate?: (id: string, patch: { name: string }) => Promise<Env<ArtifactMeta>>;
  artifactsDelete?: (id: string) => Promise<Env<unknown>>;
  artifactsCommentsList?: (id: string) => Promise<Env<ArtifactComment[]>>;
  artifactsCommentAdd?: (id: string, input: { text: string; region?: CommentRegion | null; parentId?: string; agent?: boolean }) => Promise<Env<ArtifactComment>>;
  artifactsCommentPatch?: (id: string, cid: string, patch: { resolved: boolean }) => Promise<Env<ArtifactComment>>;
  artifactsCommentDelete?: (id: string, cid: string) => Promise<Env<unknown>>;
  /** WEB: parks the session as the `/a`-scoped cookie the proxy turns into the bearer. */
  artifactsViewerPrepare?: () => Promise<void>;
}

const bridge = (): ArtifactsBridge => ((window as unknown as { glyphh?: ArtifactsBridge }).glyphh ?? {});

/** The doors into the agent (code-workbench.ts). */
interface AgentDoors {
  __wbSendToAgent?: (text: string, opts?: { newSession?: boolean; artifact?: { id: string; name: string } }) => Promise<boolean> | void;
}
const doors = (): AgentDoors => window as unknown as AgentDoors;

export interface ArtifactsPanelOptions {
  /** What the host shows in its own header; the web's full-screen host reads it. */
  onNav?: (nav: { view: "list" | "viewer"; title: string }) => void;
  /** After a message went to the agent (the web closes its full screen so the agent shows). */
  onSentToAgent?: () => void;
  /** Full screen, the panel's own rows are the page's only header and carry the ✕. */
  onClose?: () => void;
}

export interface ArtifactsPanelHandle {
  /** The host header's back: true when the panel took it (viewer → list). */
  back: () => boolean;
  refresh: () => Promise<void>;
  open: (id: string) => Promise<void>;
  destroy: () => void;
}

const KIND_ICON: Record<string, string> = {
  code: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 7 4 12 9 17"/><polyline points="15 7 20 12 15 17"/></svg>`,
  doc: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/><path d="M9 15h6M9 12h6"/></svg>`,
  image: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="M3 17l5.5-5 4 3.5 3-2.5L21 17"/></svg>`,
  file: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/></svg>`,
};
const KEBAB_SVG = `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>`;
const CLOSE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>`;
const BACK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 6 9 12 15 18"/></svg>`;
const COMMENT_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
const CHAT_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>`;
const CHECK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 12 10 17 19 8"/></svg>`;
const X_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>`;
const SEND_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="6 11 12 5 18 11"/></svg>`;
const SEARCH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/></svg>`;

const el = (tag: string, cls?: string, html?: string): HTMLElement => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};
const btn = (cls: string, html: string, title?: string): HTMLButtonElement => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.innerHTML = html;
  if (title) b.title = title;
  return b;
};
const err = (r: { ok: false; error?: string } | undefined, fallback: string): string => r?.error || fallback;

/** The web frames the same-origin proxy; the desktop frames the bytes main fetched. */
const webRawUrl = (id: string): string => `/a/${encodeURIComponent(id)}/raw`;
function bytesOf(base64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The artifact's content as a URL for a frame / image, and as text when it is text. */
async function loadContent(meta: ArtifactMeta): Promise<{ url: string; text: () => Promise<string>; revoke: () => void } | { error: string }> {
  if (onWeb()) {
    try { await bridge().artifactsViewerPrepare?.(); } catch { /* the proxy answers 401 and the frame says so */ }
    const url = webRawUrl(meta.id);
    return {
      url,
      text: async () => { const r = await fetch(url, { credentials: "same-origin" }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); },
      revoke: () => {},
    };
  }
  const content = bridge().artifactsContent;
  if (!content) return { error: "This surface can't read artifacts." };
  const r = await content(meta.id);
  if (!r.ok) return { error: err(r, "Couldn't read the artifact.") };
  const bytes = bytesOf(r.data.base64);
  const blob = new Blob([bytes], { type: r.data.mime || meta.mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  return { url, text: async () => new TextDecoder().decode(bytes), revoke: () => URL.revokeObjectURL(url) };
}

export function mountArtifactsPanel(host: HTMLElement, opts: ArtifactsPanelOptions = {}): ArtifactsPanelHandle {
  const web = onWeb();
  host.classList.add("artp-host");
  const root = el("div", "artp");
  host.appendChild(root);

  // ── THE LIST ──────────────────────────────────────────────────────────────
  // THE SAME HEADER AS CUSTOMIZE (his order, 2026-10-09: "same with
  // artifacts... doesn't need two headers and it should match customize"):
  // the title row (46px, the rule, the ✕ when full screen), then one row —
  // the count, and the search at its right end — right above the list.
  const list = el("div", "artp-list");
  const closeBtn = (): HTMLButtonElement => {
    const x = btn("ws-icon-btn settings-group-close artp-close", CLOSE_SVG, "Close");
    x.addEventListener("click", () => opts.onClose?.());
    return x;
  };
  const titlebar = el("div", "settings-group-titlebar");
  titlebar.appendChild(el("h1", "settings-group-title", "Artifacts"));
  if (opts.onClose) titlebar.appendChild(closeBtn());
  list.appendChild(titlebar);
  const head = el("div", "settings-group-head artp-head");
  const tools = el("div", "settings-group-tools");
  const search = el("div", "skills-search", SEARCH_SVG);
  const q = document.createElement("input");
  q.type = "text";
  q.placeholder = "Search artifacts";
  q.spellcheck = false;
  q.autocomplete = "off";
  q.addEventListener("input", () => paintList());
  search.appendChild(q);
  tools.appendChild(search);
  const count = el("span", "skills-count artp-count", "");
  head.append(count, tools);
  list.appendChild(head);
  const groups = el("div", "artp-groups");
  list.appendChild(groups);
  root.appendChild(list);

  let rows: ArtifactMeta[] = [];
  let loadError = "";

  function paintList(): void {
    groups.innerHTML = "";
    if (loadError) { count.textContent = ""; groups.appendChild(el("div", "crud-empty", "")).textContent = loadError; return; }
    const shown = searchArtifacts(rows, q.value);
    count.textContent = `${shown.length} ${shown.length === 1 ? "artifact" : "artifacts"}`;
    if (!shown.length) {
      groups.appendChild(el("div", "crud-empty", "")).textContent = rows.length ? "Nothing matches." : "No artifacts yet. Ask Glyphh to make one.";
      return;
    }
    for (const g of groupByMonth(shown)) {
      const grp = el("div", "skill-group", "");
      const gh = el("div", "skill-group-head", "");
      gh.appendChild(el("span", "", g.label));
      gh.appendChild(el("span", "skill-group-count", `· ${g.items.length}`));
      grp.appendChild(gh);
      for (const a of g.items) grp.appendChild(rowEl(a));
      groups.appendChild(grp);
    }
  }

  function rowEl(a: ArtifactMeta): HTMLElement {
    const row = el("div", "skill-row openable artp-row");
    row.dataset.id = a.id;
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    row.appendChild(el("div", `skill-tile-icon artp-row-icon ${artifactKind(a)}`, KIND_ICON[artifactKind(a)]));
    const main = el("div", "skill-row-main");
    const name = el("div", "skill-row-name");
    name.textContent = a.name;
    main.appendChild(name);
    const sub = el("div", "skill-row-sub");
    const desc = el("span", "skill-row-desc");
    desc.textContent = editedLabel(a);
    sub.appendChild(desc);
    main.appendChild(sub);
    row.appendChild(main);
    const ed = el("span", "skill-row-date");
    ed.textContent = editedLabel(a).replace(/^Edited\s+/i, "");
    row.appendChild(ed);
    const k = btn("skills-kebab artp-row-kebab", KEBAB_SVG, "More");
    k.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openRowMenu(k, [
        { icon: ROW_MENU_ICONS.edit, label: "Rename", onClick: () => void rename(a) },
        { icon: ROW_MENU_ICONS.delete, label: "Delete", danger: true, onClick: () => void remove(a) },
      ]);
    });
    row.appendChild(k);
    const open = (): void => { void openViewer(a); };
    row.addEventListener("click", open);
    row.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); } });
    return row;
  }

  /** A row changed under `id` — a rename moves it to a new id (the filename). */
  function replaceRow(id: string, m: ArtifactMeta): void {
    rows = rows.map((r) => (r.id === id ? m : r));
    if (current?.id === id) { current = m; paintViewerHead(); }
    paintList();
  }

  async function rename(a: ArtifactMeta): Promise<void> {
    const name = await promptAction("Rename artifact", a.name, "Name", "Rename");
    if (name == null || !name.trim() || name.trim() === a.name) return;
    const update = bridge().artifactsUpdate;
    if (!update) return;
    const r = await update(a.id, { name: name.trim() });
    if (!r.ok) { toast("Couldn't rename", { kind: "error", detail: err(r, "") }); return; }
    replaceRow(a.id, r.data);
  }

  async function remove(a: ArtifactMeta): Promise<void> {
    const ok = await confirmAction({ title: `Delete "${a.name}"?`, body: "It is deleted from this machine, with its comments.", confirmLabel: "Delete", danger: true });
    if (!ok) return;
    const del = bridge().artifactsDelete;
    if (!del) return;
    const r = await del(a.id);
    if (!r.ok) { toast("Couldn't delete", { kind: "error", detail: err(r, "") }); return; }
    rows = rows.filter((x) => x.id !== a.id);
    if (current?.id === a.id) showList();
    paintList();
  }

  async function refresh(): Promise<void> {
    const listDoor = bridge().artifactsList;
    if (!listDoor) { loadError = "This surface can't list artifacts."; paintList(); return; }
    if (!rows.length) groups.innerHTML = `<div class="crud-empty">Loading…</div>`;
    const r = await listDoor();
    if (!r.ok) { loadError = err(r, "Couldn't load your artifacts."); paintList(); return; }
    loadError = "";
    rows = r.data;
    paintList();
  }

  // ── THE VIEWER ────────────────────────────────────────────────────────────
  const viewer = el("div", "artp-viewer hidden");
  const vhead = el("div", "artp-viewer-head");
  const back = btn("ws-icon-btn artp-back", BACK_SVG, "Back to Artifacts");
  back.addEventListener("click", () => showList());
  // The viewer's own back on every surface: the full-screen "‹ Artifacts"
  // row is gone (his order, 2026-10-09).
  vhead.appendChild(back);
  const vtitle = el("span", "artp-viewer-title");
  vhead.appendChild(vtitle);
  const vactions = el("div", "artp-viewer-actions");
  const commentBtn = btn("btn btn-secondary artp-comment-btn", `${COMMENT_SVG}<span>Comment</span>`, "Comment on an area");
  commentBtn.setAttribute("aria-pressed", "false");
  const chatBtn = btn("btn btn-secondary artp-chat-btn", `${CHAT_SVG}<span>Start chat</span>`, "Start a session from this artifact");
  vactions.append(commentBtn, chatBtn);
  vhead.appendChild(vactions);
  if (opts.onClose) vhead.appendChild(closeBtn());
  viewer.appendChild(vhead);
  const stage = el("div", "artp-stage");
  const content = el("div", "artp-content");
  const overlay = el("div", "artp-overlay");
  const pins = el("div", "artp-pins");
  stage.append(content, overlay, pins);
  viewer.appendChild(stage);
  root.appendChild(viewer);

  let current: ArtifactMeta | null = null;
  let revoke: (() => void) | null = null;
  let threads: ArtifactComment[] = [];
  let commentMode = false;
  /** THE MINI CHAT (his order, 2026-10-05): "Send to Glyphh" never leaves
   *  the artifact. The comment is saved, the prompt goes through the seated
   *  agent (the turn lands on the main thread as any turn does), and the
   *  reply paints back into the thread's pane as a Glyphh line — a spinner
   *  while it works. Replies are kept per thread while the panel is open. */
  const agentReplies = new Map<string, Array<{ text: string; at: number; stopped: boolean }>>();
  const agentBusy = new Set<string>();
  /** The pane's spinner — the house cube (glyphh-spinner.ts), the same one
   *  every other surface shows (his order, 2026-10-05); one at a time. */
  let paneSpinner: GlyphhSpinner | null = null;
  const dropPaneSpinner = (): void => { paneSpinner?.destroy(); paneSpinner = null; };
  const onTurnFinished = (ev: Event): void => {
    const d = (ev as CustomEvent<{ chatId: string; text: string; stopped: boolean }>).detail;
    const waiting = [...agentBusy];
    if (!waiting.length) return;
    const id = waiting[waiting.length - 1];
    agentBusy.delete(id);
    const text = d?.text || "";
    const stopped = !!d?.stopped || !text;
    // GLYPHH'S REPLY PERSISTS WITH THE THREAD (his order, 2026-10-05: closing
    // the artifact and reopening the comment showed no response): posted back
    // as a reply flagged agent, so every reader sees it, now and later.
    const a = current;
    const add = bridge().artifactsCommentAdd;
    if (!stopped && a && add) {
      void add(a.id, { text, parentId: id, agent: true }).then((r) => {
        if (r.ok) {
          const t = threads.find((x) => x.id === id);
          if (t) t.replies = [...(t.replies ?? []), r.data];
          const open = stage.querySelector<HTMLElement>(`.artp-pop[data-thread="${CSS.escape(id)}"]`);
          if (open && t) threadPopover(t, pinAnchor(t));
          else paintAgentExchange(id);
        } else {
          const list = agentReplies.get(id) ?? [];
          list.push({ text, at: Date.now(), stopped: false });
          agentReplies.set(id, list);
          paintAgentExchange(id);
        }
      });
      return;
    }
    const list = agentReplies.get(id) ?? [];
    list.push({ text, at: Date.now(), stopped });
    agentReplies.set(id, list);
    paintAgentExchange(id);
  };
  document.addEventListener("glyphh-agent:turn-finished", onTurnFinished);
  let activeThread: string | null = null;

  function paintViewerHead(): void {
    if (!current) return;
    vtitle.textContent = current.name;
    vtitle.title = current.name;
  }

  function showList(): void {
    current = null;
    setCommentMode(false);
    revoke?.();
    revoke = null;
    content.innerHTML = "";
    pins.innerHTML = "";
    overlay.innerHTML = "";
    viewer.classList.add("hidden");
    list.classList.remove("hidden");
    opts.onNav?.({ view: "list", title: "Artifacts" });
  }

  async function openViewer(a: ArtifactMeta): Promise<void> {
    current = a;
    threads = [];
    activeThread = null;
    list.classList.add("hidden");
    viewer.classList.remove("hidden");
    paintViewerHead();
    opts.onNav?.({ view: "viewer", title: a.name });
    content.innerHTML = `<div class="crud-empty artp-loading">Loading…</div>`;
    pins.innerHTML = "";
    overlay.innerHTML = "";
    const loaded = await loadContent(a);
    if (current !== a) return;   // moved on while it loaded
    content.innerHTML = "";
    if ("error" in loaded) { content.appendChild(el("div", "crud-empty", "")).textContent = loaded.error; return; }
    revoke = loaded.revoke;
    const render = artifactRender(a);
    if (render === "frame") {
      const f = document.createElement("iframe");
      f.className = "artp-frame";
      f.setAttribute("sandbox", "allow-scripts");
      f.setAttribute("referrerpolicy", "no-referrer");
      f.title = a.name;
      f.src = loaded.url;
      content.appendChild(f);
    } else if (render === "image") {
      const img = document.createElement("img");
      img.className = "artp-image";
      img.alt = a.name;
      img.draggable = false;
      img.src = loaded.url;
      content.appendChild(img);
    } else if (render === "text") {
      try {
        const text = await loaded.text();
        if (current !== a) return;
        const ext = a.name.split(".").pop()?.toLowerCase() || "";
        if (a.mime === "text/markdown" || ext === "md" || ext === "markdown") {
          content.appendChild(el("div", "artp-markdown md", formatMarkdown(text)));
        } else {
          const pre = el("pre", "artp-text");
          const code = el("code", "tk", highlight(text, ext || "txt"));
          pre.appendChild(code);
          content.appendChild(pre);
        }
      } catch (e) {
        content.appendChild(el("div", "crud-empty", "")).textContent = `Couldn't read the artifact: ${e instanceof Error ? e.message : String(e)}`;
      }
    } else {
      const d = el("div", "crud-empty artp-download");
      const link = document.createElement("a");
      link.href = loaded.url;
      link.download = a.name;
      link.textContent = `Download ${a.name}`;
      d.append("This kind of file has no preview. ", link);
      content.appendChild(d);
    }
    await loadThreads();
  }

  // ── COMMENTS ──────────────────────────────────────────────────────────────
  async function loadThreads(): Promise<void> {
    const a = current;
    const door = bridge().artifactsCommentsList;
    if (!a || !door) return;
    const r = await door(a.id);
    if (current !== a) return;
    if (!r.ok) { toast("Couldn't load the comments", { kind: "error", detail: err(r, "") }); return; }
    threads = r.data;
    paintPins();
  }

  const stageSize = (): { w: number; h: number } => ({ w: stage.clientWidth || 1, h: stage.clientHeight || 1 });

  /** Every open thread's region (faint) and pin; the active thread's region solid. */
  function paintPins(): void {
    pins.innerHTML = "";
    overlay.querySelectorAll(".artp-region:not(.drawing)").forEach((n) => n.remove());
    const { w, h } = stageSize();
    const numbers = pinNumbers(threads);
    for (const t of orderThreads(threads)) {
      if (t.resolved) continue;
      if (t.region) {
        const rg = el("div", `artp-region${t.id === activeThread ? " active" : ""}`);
        const rect = regionToRect(t.region, w, h);
        Object.assign(rg.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
        rg.dataset.thread = t.id;
        overlay.appendChild(rg);
      }
      const p = pinPoint(t.region);
      const pin = btn(`artp-pin${t.id === activeThread ? " active" : ""}`, "");
      pin.textContent = String(numbers.get(t.id) ?? "");
      pin.dataset.thread = t.id;
      pin.style.left = `${p.x * w}px`;
      pin.style.top = `${p.y * h}px`;
      pin.title = t.text;
      pin.addEventListener("click", (ev) => { ev.stopPropagation(); openThread(t.id, pin); });
      pins.appendChild(pin);
    }
  }

  function closePopover(): void {
    dropPaneSpinner();
    stage.querySelector(".artp-pop")?.remove();
    activeThread = null;
    overlay.querySelector(".artp-region.drawing")?.remove();
    stage.querySelector(".artp-pin.draft")?.remove();
    paintPins();
  }

  /** Where a popover sits: right of the pin, kept inside the stage. */
  function placePopover(pop: HTMLElement, at: { x: number; y: number }): void {
    const { w, h } = stageSize();
    const pw = pop.offsetWidth || 320, ph = pop.offsetHeight || 160;
    let left = at.x + 18, top = at.y - 12;
    if (left + pw > w - 8) left = Math.max(8, at.x - pw - 18);
    if (top + ph > h - 8) top = Math.max(8, h - ph - 8);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }

  /** The composer's foot: the "Send to Glyphh" checkbox (on by default, as
   *  the screenshot) and the send arrow. */
  function sendRow(onGo: () => void): HTMLElement & { wantsAgent: () => boolean } {
    const row = el("div", "artp-pop-send") as HTMLElement & { wantsAgent: () => boolean };
    const label = el("label", "artp-pop-check");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    label.append(cb, el("span", "", "Send to Glyphh"));
    const go = btn("artp-pop-go", SEND_SVG, "Send");
    go.addEventListener("click", onGo);
    row.append(label, go);
    row.wantsAgent = () => cb.checked;
    return row;
  }

  function sendToAgent(a: ArtifactMeta, threadId: string, region: CommentRegion | null, lines: string[]): void {
    const send = doors().__wbSendToAgent;
    if (!send) { toast("Open the agent to send this", { kind: "error" }); return; }
    const [first, ...rest] = lines;
    agentBusy.add(threadId);
    paintAgentExchange(threadId);
    void Promise.resolve(send(editPrompt(a, region, first || "", rest), { artifact: { id: a.id, name: a.name } })).then((sent) => {
      if (sent !== false) return;
      // The agent was mid-turn and the send never left: say so, stop waiting.
      agentBusy.delete(threadId);
      paintAgentExchange(threadId);
      toast("Glyphh is busy with another turn — send again when it finishes", { kind: "error" });
    });
  }

  /** The thread pane's exchange with Glyphh: every reply so far as a Glyphh
   *  line, then a one-line spinner while a turn is running. Painted into the
   *  open pane for that thread, if any. */
  function paintAgentExchange(threadId: string): void {
    const pop = stage.querySelector<HTMLElement>(`.artp-pop[data-thread="${CSS.escape(threadId)}"]`);
    if (!pop) return;
    const host = pop.querySelector<HTMLElement>(".artp-pop-agent");
    if (!host) return;
    dropPaneSpinner();
    host.innerHTML = "";
    for (const r of agentReplies.get(threadId) ?? []) {
      const m = el("div", "artp-msg artp-msg-agent");
      const top = el("div", "artp-msg-top");
      const av = el("span", "artp-avatar artp-avatar-glyphh", "G");
      const who = el("span", "artp-msg-who");
      who.appendChild(el("strong", "", "Glyphh"));
      who.appendChild(el("small", "", "")).textContent = commentAge(new Date(r.at).toISOString());
      top.append(av, who);
      m.appendChild(top);
      m.appendChild(el("div", "artp-msg-text", "")).textContent = r.stopped && !r.text ? "Glyphh stopped before replying." : r.text;
      host.appendChild(m);
    }
    if (agentBusy.has(threadId)) {
      const line = el("div", "artp-pop-working");
      paneSpinner = createGlyphhSpinner({ size: 18, phrases: false });
      paneSpinner.setMeta("Glyphh is working…");
      line.appendChild(paneSpinner.el);
      const openConv = btn("artp-link", "Open conversation");
      openConv.addEventListener("click", () => opts.onSentToAgent?.());
      line.appendChild(openConv);
      host.appendChild(line);
    }
    // The pane scrolls to the newest line (it caps its height and scrolls).
    const scroller = pop.querySelector<HTMLElement>(".artp-pop-scroll");
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  function threadPopover(t: ArtifactComment, anchor: { x: number; y: number }): void {
    dropPaneSpinner();
    stage.querySelector(".artp-pop")?.remove();
    const a = current!;
    const pop = el("div", "artp-pop");
    pop.dataset.thread = t.id;
    pop.appendChild(el("div", "artp-pop-eyebrow", t.region ? "Selected area" : "Comment"));
    const msgs = el("div", "artp-pop-msgs");
    const line = (c: ArtifactComment, first: boolean): void => {
      const m = el("div", "artp-msg");
      const av = el("span", c.agent ? "artp-avatar artp-avatar-glyphh" : "artp-avatar");
      if (c.agent) av.textContent = "G";
      else if (c.author?.avatarUrl) { const img = document.createElement("img"); img.src = c.author.avatarUrl; img.alt = ""; av.appendChild(img); }
      else av.textContent = initialOf(c.author?.name || "");
      const who = el("span", "artp-msg-who");
      who.appendChild(el("strong", "", "")).textContent = c.agent ? "Glyphh" : (c.author?.name || "Someone");
      who.appendChild(el("small", "", "")).textContent = commentAge(c.createdAt);
      const top = el("div", "artp-msg-top");
      top.append(av, who);
      if (first) {
        const acts = el("span", "artp-msg-acts");
        const res = btn("ws-icon-btn", CHECK_SVG, t.resolved ? "Reopen" : "Resolve");
        res.addEventListener("click", async () => {
          const patch = bridge().artifactsCommentPatch;
          if (!patch) return;
          const r = await patch(a.id, t.id, { resolved: !t.resolved });
          if (!r.ok) { toast("Couldn't update the comment", { kind: "error", detail: err(r, "") }); return; }
          threads = threads.map((x) => (x.id === t.id ? r.data : x));
          closePopover();
        });
        const del = btn("ws-icon-btn", X_SVG, "Delete");
        del.addEventListener("click", async () => {
          const ok = await confirmAction({ title: "Delete this comment?", confirmLabel: "Delete", danger: true });
          if (!ok) return;
          const d = bridge().artifactsCommentDelete;
          if (!d) return;
          const r = await d(a.id, t.id);
          if (!r.ok) { toast("Couldn't delete the comment", { kind: "error", detail: err(r, "") }); return; }
          threads = threads.filter((x) => x.id !== t.id);
          closePopover();
        });
        acts.append(res, del);
        top.appendChild(acts);
      }
      m.appendChild(top);
      m.appendChild(el("div", "artp-msg-text", "")).textContent = c.text;
      msgs.appendChild(m);
    };
    line(t, true);
    for (const r of t.replies ?? []) line(r, false);
    // The thread + the exchange scroll together under a height cap (his
    // order, 2026-10-05: "max out at a reasonable height and start scrolling").
    const scroll = el("div", "artp-pop-scroll");
    scroll.append(msgs, el("div", "artp-pop-agent"));
    pop.appendChild(scroll);
    const reply = document.createElement("textarea");
    reply.className = "artp-pop-input";
    reply.rows = 2;
    reply.placeholder = "What do you want to edit?";
    pop.appendChild(reply);
    const row = sendRow(() => void submit());
    pop.appendChild(row);
    const submit = async (): Promise<void> => {
      const text = reply.value.trim();
      if (text) {
        const add = bridge().artifactsCommentAdd;
        if (!add) return;
        const r = await add(a.id, { text, parentId: t.id });
        if (!r.ok) { toast("Couldn't reply", { kind: "error", detail: err(r, "") }); return; }
        t.replies = [...(t.replies ?? []), r.data];
        reply.value = "";
        msgs.innerHTML = "";
        line(t, true);
        for (const x of t.replies) line(x, false);
      }
      if (row.wantsAgent()) sendToAgent(a, t.id, t.region, threadText(t));
    };
    reply.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); void submit(); } });
    stage.appendChild(pop);
    paintAgentExchange(t.id);
    placePopover(pop, anchor);
    reply.focus();
  }

  /** Where a thread's pane opens: beside its pin (his report, 2026-10-05: it
   *  opened at the page's top-left — paintPins had replaced the pin element,
   *  so the detached one measured 0,0). The region decides, not the element. */
  function pinAnchor(t: ArtifactComment): { x: number; y: number } {
    const { w, h } = stageSize();
    const p = pinPoint(t.region);
    return { x: p.x * w, y: p.y * h };
  }
  function openThread(id: string, _pin: HTMLElement): void {
    activeThread = id;
    paintPins();
    const t = threads.find((x) => x.id === id);
    if (!t) return;
    threadPopover(t, pinAnchor(t));
  }

  /** A fresh region's pin + composer: the first comment of a new thread. */
  function draftPopover(region: CommentRegion): void {
    const a = current!;
    stage.querySelector(".artp-pop")?.remove();
    stage.querySelector(".artp-pin.draft")?.remove();
    const { w, h } = stageSize();
    const p = pinPoint(region);
    const pin = btn("artp-pin draft", "");
    pin.textContent = String(threads.filter((t) => !t.resolved).length + 1);
    pin.style.left = `${p.x * w}px`;
    pin.style.top = `${p.y * h}px`;
    stage.appendChild(pin);
    const pop = el("div", "artp-pop draft");
    const eyebrow = el("div", "artp-pop-eyebrow", "");
    eyebrow.textContent = a.name;
    pop.appendChild(eyebrow);
    pop.appendChild(el("div", "artp-pop-sub", "Selected area"));
    const ta = document.createElement("textarea");
    ta.className = "artp-pop-input";
    ta.rows = 2;
    ta.placeholder = "What do you want to edit?";
    pop.appendChild(ta);
    const note = el("div", "artp-pop-note hidden", "Sent to Glyphh.");
    pop.appendChild(note);
    const row = sendRow(() => void submit());
    pop.appendChild(row);
    const submit = async (): Promise<void> => {
      const text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      const add = bridge().artifactsCommentAdd;
      if (!add) { toast("This surface can't save comments.", { kind: "error" }); return; }
      const r = await add(a.id, { text, region });
      if (!r.ok) { toast("Couldn't post the comment", { kind: "error", detail: err(r, "") }); return; }
      threads = [...threads, r.data];
      const wants = row.wantsAgent();
      overlay.querySelector(".artp-region.drawing")?.remove();
      pin.remove();
      pop.remove();
      activeThread = r.data.id;
      paintPins();
      threadPopover(r.data, pinAnchor(r.data));
      if (wants) sendToAgent(a, r.data.id, region, [text]);
    };
    ta.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); void submit(); }
    });
    stage.appendChild(pop);
    placePopover(pop, { x: pin.offsetLeft, y: pin.offsetTop });
    ta.focus();
  }

  // THE DRAW: a transparent layer above the sandboxed frame takes the drag;
  // the region is stored as fractions of the stage so it survives a resize.
  let drag: { x0: number; y0: number; rg: HTMLElement } | null = null;
  overlay.addEventListener("pointerdown", (ev) => {
    if (!commentMode || ev.button !== 0) return;
    if ((ev.target as HTMLElement).closest(".artp-pop")) return;
    ev.preventDefault();
    stage.querySelector(".artp-pop")?.remove();
    stage.querySelector(".artp-pin.draft")?.remove();
    overlay.querySelector(".artp-region.drawing")?.remove();
    const r = stage.getBoundingClientRect();
    const rg = el("div", "artp-region drawing");
    overlay.appendChild(rg);
    drag = { x0: ev.clientX - r.left, y0: ev.clientY - r.top, rg };
    overlay.setPointerCapture(ev.pointerId);
  });
  overlay.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const r = stage.getBoundingClientRect();
    const { w, h } = stageSize();
    const region = regionFromDrag(drag.x0, drag.y0, ev.clientX - r.left, ev.clientY - r.top, w, h);
    const rect = regionToRect(region, w, h);
    Object.assign(drag.rg.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  });
  overlay.addEventListener("pointerup", (ev) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    const r = stage.getBoundingClientRect();
    const { w, h } = stageSize();
    const region = regionFromDrag(d.x0, d.y0, ev.clientX - r.left, ev.clientY - r.top, w, h);
    if (!regionIsReal(region, w, h)) { d.rg.remove(); return; }
    draftPopover(region);
  });

  function setCommentMode(on: boolean): void {
    commentMode = on;
    stage.classList.toggle("commenting", on);
    commentBtn.classList.toggle("active", on);
    commentBtn.setAttribute("aria-pressed", on ? "true" : "false");
    if (!on) { drag = null; closePopover(); }
  }
  commentBtn.addEventListener("click", () => setCommentMode(!commentMode));
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape" && commentMode && !viewer.classList.contains("hidden")) { ev.stopPropagation(); setCommentMode(false); }
  };
  document.addEventListener("keydown", onKey, true);

  chatBtn.addEventListener("click", () => {
    if (!current) return;
    const send = doors().__wbSendToAgent;
    if (!send) { toast("Open the agent to start a chat", { kind: "error" }); return; }
    send(startChatLine(current), { newSession: true, artifact: { id: current.id, name: current.name } });
    opts.onSentToAgent?.();
  });

  // A resize moves the pins and regions with the page.
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => { if (current) paintPins(); }) : null;
  ro?.observe(stage);

  void refresh();
  opts.onNav?.({ view: "list", title: "Artifacts" });

  return {
    back: () => { if (current) { showList(); return true; } return false; },
    refresh,
    open: async (id) => {
      let a = rows.find((x) => x.id === id);
      if (!a) {
        const get = bridge().artifactsGet;
        const r = get ? await get(id) : null;
        if (r?.ok) a = r.data;
      }
      if (a) await openViewer(a);
    },
    destroy: () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("glyphh-agent:turn-finished", onTurnFinished);
      dropPaneSpinner();
      ro?.disconnect();
      revoke?.();
      root.remove();
      host.classList.remove("artp-host");
    },
  };
}
