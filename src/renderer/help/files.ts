/**
 * Files — the ARTIFACTS gallery.
 *
 * A first-class object browser over the user's stored artifacts (R2-backed,
 * reached through the SDK's `files` resource on `window.glyphhSdk`, the same
 * raw @glyphh/sdk client the rest of the surface uses). Read-first: a grid of
 * cards; opening one mounts it in the WORKBENCH by kind (Monaco for
 * code/text/markdown, a preview panel for image/pdf) via the workbench's
 * `__wbOpenArtifact` bridge. "New artifact" → `files.create`.
 *
 * The SDK types live in a separate repo, so — as remote-run.ts / settings-api.ts
 * do — the FileArtifact shape and the files resource are mirrored here
 * structurally and every call is guarded, so a build without the resource
 * degrades to an empty gallery + a clear message rather than throwing.
 */

import { escapeHtml, relativeTime, promptAction } from "./shared.js";

// ── SDK mirror (window.glyphhSdk.files) ──────────────────────────────────────

export type FileArtifactKind = "code" | "text" | "markdown" | "image" | "pdf" | "other";

/** A stored artifact, mirroring the SDK's FileArtifact contract. Fields beyond
 *  id/name/kind are optional so a leaner server payload still renders. */
export interface FileArtifact {
  id: string;
  name: string;
  kind: FileArtifactKind;
  /** Presigned GET URL for the object (image/pdf viewers, content fetch). */
  url?: string;
  /** Inline content when the server returns it (code/text/markdown). */
  content?: string;
  size?: number;
  mimeType?: string;
  updatedAt?: number | string;
  createdAt?: number | string;
}

export interface FileCreateInput {
  name: string;
  kind: FileArtifactKind;
  content?: string;
}

interface SdkFiles {
  list?: (query?: string) => Promise<FileArtifact[] | { items: FileArtifact[] }>;
  get?: (id: string) => Promise<FileArtifact>;
  create?: (input: FileCreateInput) => Promise<FileArtifact>;
}

interface SdkWithFiles { files?: SdkFiles }

function filesApi(): SdkFiles | undefined {
  return (window as unknown as { glyphhSdk?: SdkWithFiles }).glyphhSdk?.files;
}

/** The workbench bridge that mounts an artifact by kind (added in
 *  code-workbench.ts). Absent only if the workbench hasn't initialised yet. */
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

// ── Rendering ────────────────────────────────────────────────────────────────

const $ = (id: string) => document.getElementById(id);

let allArtifacts: FileArtifact[] = [];

function timeOf(a: FileArtifact): number {
  const v = a.updatedAt ?? a.createdAt;
  if (typeof v === "number") return v;
  if (typeof v === "string") { const t = Date.parse(v); return Number.isNaN(t) ? 0 : t; }
  return 0;
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
  const api = filesApi();
  // Prefer a fresh get (it carries a presigned url + content); fall back to the
  // list row we already have so a card still opens without a get endpoint.
  let art = allArtifacts.find((a) => a.id === id);
  try {
    if (api?.get) art = await api.get(id);
  } catch (e) {
    showError(`Couldn't open that artifact: ${(e as Error).message}`);
  }
  if (art) openArtifactInWorkbench({ ...art, kind: normalizeKind(art.kind) });
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Load + render the artifacts gallery. Called by loadActiveSection("files"). */
export async function loadFiles(): Promise<void> {
  showError(null);
  const api = filesApi();
  if (!api?.list) {
    allArtifacts = [];
    renderGallery([]);
    showError("Artifacts aren't available on this build — the files service isn't reachable here.");
    return;
  }
  try {
    const res = await api.list();
    const items = Array.isArray(res) ? res : (res?.items ?? []);
    allArtifacts = items
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
    const api = filesApi();
    if (!api?.create) { showError("Creating artifacts isn't available on this build."); return; }
    // The app forbids native window.prompt (Electron BrowserViews swallow it) —
    // use the themed prompt modal instead.
    const name = await promptAction("New artifact name", "untitled.md", "e.g. notes.md", "Create");
    if (!name) return;
    const lower = name.toLowerCase();
    const kind: FileArtifactKind =
      /\.(md|markdown)$/.test(lower) ? "markdown" :
      /\.(png|jpe?g|gif|webp|svg)$/.test(lower) ? "image" :
      /\.pdf$/.test(lower) ? "pdf" :
      /\.(txt|log|csv)$/.test(lower) ? "text" :
      /\.[a-z0-9]+$/.test(lower) ? "code" : "text";
    try {
      const created = await api.create({ name, kind, content: "" });
      await loadFiles();
      openArtifactInWorkbench({ ...created, kind: normalizeKind(created.kind) });
    } catch (e) {
      showError(`Couldn't create that artifact: ${(e as Error).message}`);
    }
  });
}
