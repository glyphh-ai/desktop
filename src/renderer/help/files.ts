/**
 * Files — the ARTIFACTS gallery.
 *
 * A first-class object browser over the user's stored artifacts (R2-backed).
 * Read-first: a grid of cards; opening one mounts it in the WORKBENCH by kind
 * (Monaco for code/text/markdown, a preview panel for image/pdf) via the
 * workbench's `__wbOpenArtifact` bridge. "New artifact" → files.create.
 *
 * Transport — the ONE files transport for BOTH surfaces, per settings-api.ts's
 * law that the renderer never holds an SDK client:
 *   • web     — window.glyphhSdk.files (the raw @glyphh/sdk client the web
 *               bridge exposes). Checked FIRST: on web `window.glyphh` is a
 *               Proxy that fabricates a function for ANY name, so the SDK handle
 *               must win (thread-store.ts's trap, mirrored by settings-api.ts).
 *   • desktop — window.glyphh.filesList / filesGet / filesCreate → the
 *               MAIN-process SDK client (files-ipc.ts → getClient().files).
 * Neither present (an old build) → an honest empty + a clear message.
 *
 * The SDK's shapes are mirrored structurally (the renderer can't import
 * @glyphh/sdk across the preload boundary) and match sdk contract/files.ts:
 * FileArtifact carries `mime`/`kind`/`sizeBytes`/`createdAt`; `downloadUrl` is
 * present only on get(id); create takes base64 bytes.
 */

import { escapeHtml, relativeTime, promptAction } from "./shared.js";

// ── SDK shape mirror (matches @glyphh/sdk contract/files.ts) ─────────────────

export type FileArtifactKind = "code" | "text" | "markdown" | "image" | "pdf" | "other";

export interface FileArtifact {
  id: string;
  name: string;
  mime: string;
  kind: FileArtifactKind;
  sessionId: string | null;
  sizeBytes: number;
  /** ISO-8601. */
  createdAt: string;
  /** Short-lived, browser-ready view/download URL — present only on get(id). */
  downloadUrl?: string;
}

export interface FileCreateInput {
  name: string;
  mime?: string;
  /** Artifact bytes, base64-encoded. */
  contentBase64: string;
  sessionId?: string | null;
}

// ── Transport (web SDK handle vs desktop IPC bridge) ─────────────────────────

interface FilesTransport {
  list(): Promise<FileArtifact[]>;
  get(id: string): Promise<FileArtifact>;
  create(input: FileCreateInput): Promise<FileArtifact>;
}

/** The web SDK handle's files resource. */
interface SdkFilesHandle {
  list?: (query?: { sessionId?: string }) => Promise<FileArtifact[]>;
  get?: (id: string) => Promise<FileArtifact>;
  create?: (input: FileCreateInput) => Promise<FileArtifact>;
}
interface SdkWithFiles { files?: SdkFilesHandle }

/** The desktop preload bridge's file methods. */
interface DesktopFilesIpc {
  filesList?: () => Promise<FileArtifact[]>;
  filesGet?: (id: string) => Promise<FileArtifact>;
  filesCreate?: (input: FileCreateInput) => Promise<{ ok: boolean; file?: FileArtifact; error?: string }>;
}

const NO_TRANSPORT = "Artifacts aren't available on this build — the files service isn't reachable here.";

/**
 * The files transport for THIS surface, or null if neither is present.
 *
 * On WEB the SDK handle is the only transport — `window.glyphh` there is a Proxy
 * that fabricates a function for ANY name, so the desktop IPC branch must never
 * be reached on web (it would look present and then fail oddly). We gate on the
 * `__GLYPHH_WEB__` flag the web bridge sets, exactly as settings-api.ts does.
 */
function filesTransport(): FilesTransport | null {
  const isWeb = !!(window as unknown as { __GLYPHH_WEB__?: boolean }).__GLYPHH_WEB__;
  if (isWeb) {
    const f = (window as unknown as { glyphhSdk?: SdkWithFiles }).glyphhSdk?.files;
    if (!f?.list || !f.get || !f.create) return null;
    return {
      list: () => f.list!(),
      get: (id) => f.get!(id),
      create: (input) => f.create!(input),
    };
  }
  // Desktop — the main-process SDK client via the preload IPC bridge.
  const g = (window as unknown as { glyphh?: DesktopFilesIpc }).glyphh;
  if (!g?.filesList || !g.filesGet || !g.filesCreate) return null;
  return {
    list: () => g.filesList!(),
    get: (id) => g.filesGet!(id),
    create: async (input) => {
      const res = await g.filesCreate!(input);
      if (!res?.ok || !res.file) throw new Error(res?.error || "Couldn't create artifact");
      return res.file;
    },
  };
}

/** The workbench bridge that mounts an artifact by kind (code-workbench.ts). */
function openArtifactInWorkbench(a: FileArtifact): void {
  const open = (window as unknown as { __wbOpenArtifact?: (a: FileArtifact) => void }).__wbOpenArtifact;
  if (open) open(a);
}

// ── Kind → icon (matches the settings-nav icon idiom: 24-box line SVGs) ──────

const KIND_ICON: Record<FileArtifactKind, string> = {
  code: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
  markdown: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H19v18H5.5A1.5 1.5 0 0 1 4 19.5z"/><path d="M8 15v-6l3 3 3-3v6"/></svg>`,
  text: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v5h5"/><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="14" y2="17"/></svg>`,
  image: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5-5-9 9"/></svg>`,
  pdf: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v5h5"/><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M9 13h1.5a1.5 1.5 0 0 1 0 3H9zm0 0v4"/><path d="M14.5 13v4M16 13h-1.5"/></svg>`,
  other: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v5h5"/><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/></svg>`,
};

const KIND_LABEL: Record<FileArtifactKind, string> = {
  code: "Code", text: "Text", markdown: "Markdown", image: "Image", pdf: "PDF", other: "File",
};

const normalizeKind = (k?: string): FileArtifactKind =>
  (["code", "text", "markdown", "image", "pdf"].includes(String(k)) ? k : "other") as FileArtifactKind;

/** Best-effort MIME for a new artifact, keyed off its name. */
function mimeForName(name: string): string {
  const lower = name.toLowerCase();
  if (/\.(md|markdown)$/.test(lower)) return "text/markdown";
  if (/\.png$/.test(lower)) return "image/png";
  if (/\.jpe?g$/.test(lower)) return "image/jpeg";
  if (/\.gif$/.test(lower)) return "image/gif";
  if (/\.webp$/.test(lower)) return "image/webp";
  if (/\.svg$/.test(lower)) return "image/svg+xml";
  if (/\.pdf$/.test(lower)) return "application/pdf";
  if (/\.(txt|log)$/.test(lower)) return "text/plain";
  if (/\.csv$/.test(lower)) return "text/csv";
  if (/\.json$/.test(lower)) return "application/json";
  if (/\.[a-z0-9]+$/.test(lower)) return "text/plain";
  return "text/markdown";
}

// ── Rendering ────────────────────────────────────────────────────────────────

const $ = (id: string) => document.getElementById(id);

let allArtifacts: FileArtifact[] = [];

function timeOf(a: FileArtifact): number {
  const t = Date.parse(a.createdAt || "");
  return Number.isNaN(t) ? 0 : t;
}

function renderGallery(list: FileArtifact[]): void {
  const gallery = $("files-gallery");
  const empty = $("files-empty");
  if (!gallery) return;
  gallery.innerHTML = "";
  empty?.classList.toggle("hidden", list.length > 0);
  for (const a of list) {
    const kind = normalizeKind(a.kind);
    const card = document.createElement("button");
    card.type = "button";
    card.className = "file-card";
    card.dataset.id = a.id;
    const when = timeOf(a);
    card.innerHTML = `
      <span class="file-card-icon file-card-icon-${kind}">${KIND_ICON[kind]}</span>
      <span class="file-card-body">
        <span class="file-card-name">${escapeHtml(a.name || "Untitled")}</span>
        <span class="file-card-meta">${KIND_LABEL[kind]}${when ? ` · ${escapeHtml(relativeTime(when))}` : ""}</span>
      </span>`;
    card.addEventListener("click", () => { void openArtifact(a.id); });
    gallery.appendChild(card);
  }
}

function applySearch(): void {
  const q = ($("file-search") as HTMLInputElement | null)?.value.trim().toLowerCase() || "";
  const list = q
    ? allArtifacts.filter((a) => (a.name || "").toLowerCase().includes(q))
    : allArtifacts;
  renderGallery(list);
}

function showError(msg: string | null): void {
  const el = $("files-error");
  if (!el) return;
  el.textContent = msg || "";
  el.classList.toggle("hidden", !msg);
}

async function openArtifact(id: string): Promise<void> {
  const t = filesTransport();
  // Always fetch a fresh get — it carries the short-lived downloadUrl the viewer
  // needs. Fall back to the list row (no downloadUrl) so a card still opens.
  let art = allArtifacts.find((a) => a.id === id);
  if (t) {
    try { art = await t.get(id); }
    catch (e) { showError(`Couldn't open that artifact: ${(e as Error).message}`); }
  }
  if (art) openArtifactInWorkbench({ ...art, kind: normalizeKind(art.kind) });
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Load + render the artifacts gallery. Called by loadActiveSection("files"). */
export async function loadFiles(): Promise<void> {
  showError(null);
  const t = filesTransport();
  if (!t) {
    allArtifacts = [];
    renderGallery([]);
    showError(NO_TRANSPORT);
    return;
  }
  try {
    const items = await t.list();
    allArtifacts = (items || [])
      .map((a) => ({ ...a, kind: normalizeKind(a.kind) }))
      .sort((a, b) => timeOf(b) - timeOf(a));
    applySearch();
  } catch (e) {
    allArtifacts = [];
    renderGallery([]);
    showError(`Couldn't load artifacts: ${(e as Error).message}`);
  }
}

let filesWired = false;

/** Wire the search + "New artifact" controls once, at boot. */
export function initFiles(): void {
  if (filesWired) return;
  filesWired = true;

  ($("file-search") as HTMLInputElement | null)?.addEventListener("input", applySearch);

  $("file-new-btn")?.addEventListener("click", async () => {
    const t = filesTransport();
    if (!t) { showError(NO_TRANSPORT); return; }
    // The app forbids native window.prompt (Electron BrowserViews swallow it) —
    // use the themed prompt modal instead.
    const name = await promptAction("New artifact name", "untitled.md", "e.g. notes.md", "Create");
    if (!name) return;
    try {
      // A new artifact starts empty; the server derives kind from the mime.
      // btoa handles the empty/ASCII body; encodeURIComponent→escape keeps it
      // correct if a default body ever carries non-ASCII.
      const contentBase64 = btoa(unescape(encodeURIComponent("")));
      const created = await t.create({ name, mime: mimeForName(name), contentBase64 });
      await loadFiles();
      // Re-get so the freshly-created artifact opens with a downloadUrl.
      void openArtifact(created.id);
    } catch (e) {
      showError(`Couldn't create that artifact: ${(e as Error).message}`);
    }
  });
}
