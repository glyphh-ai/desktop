/**
 * Files — the ARTIFACTS library.
 *
 * His ruling, 2026-09-18: artifacts are LOCAL files, in `app-data/artifacts/
 * files/` like every other library the app shows. The old R2 transport asked a
 * route the fork never implemented, so the page only ever showed
 * "Couldn't load artifacts: ApiError: HTTP 404".
 *
 * The page reads like Skills and the other library pages, with one addition he
 * asked for: a grid/table toggle. Grid tiles render an actual preview, the
 * opening lines for text and code and the image itself for a picture, because a
 * wall of identical file icons tells you nothing about which artifact is which.
 *
 * Opening one mounts it in the WORKBENCH by kind through `__wbOpenArtifact`.
 */

import { escapeHtml, relativeTime, promptAction, confirmAction } from "./shared.js";
import { ROW_MENU_ICONS, openRowMenu, type RowMenuItem } from "./lib-editor.js";
import { closeSettingsModal } from "./navigation.js";

export type FileArtifactKind = "code" | "text" | "markdown" | "image" | "pdf" | "other";

export interface FileArtifact {
  id: string;
  name: string;
  mime: string;
  kind: FileArtifactKind;
  sessionId: string | null;
  sizeBytes: number;
  createdAt: string;
  /** Absolute path on this machine. */
  path?: string;
  /** file:// — an image or PDF the viewer renders directly. */
  downloadUrl?: string;
}

interface FilesBridge {
  filesList?: () => Promise<FileArtifact[]>;
  filesGet?: (id: string) => Promise<FileArtifact>;
  filesPeek?: (id: string) => Promise<string>;
  filesCreate?: (input: { name: string; content?: string }) => Promise<{ ok: boolean; file?: FileArtifact; error?: string }>;
  filesRename?: (id: string, name: string) => Promise<{ ok: boolean; file?: FileArtifact; error?: string }>;
  filesDelete?: (id: string) => Promise<{ ok: boolean; error?: string }>;
}

const NO_TRANSPORT = "Artifacts need the desktop app.";

/** What "+ New artifact" types into the agent. Left UNSENT on purpose. */
const NEW_ARTIFACT_PROMPT =
  "I want to make an artifact: a web page published with the Artifact tool. " +
  "Ask me a few questions about what it should show, then build it and publish it.";

/** The settings dialog is a modal over the workbench, so it has to get out of
 *  the way before the composer can take the text. */
function closeSettingsOverlay(): void {
  closeSettingsModal();
}

function bridge(): FilesBridge | null {
  const g = (window as unknown as { glyphh?: FilesBridge }).glyphh;
  return g?.filesList ? g : null;
}

/** The workbench bridge that mounts an artifact by kind (code-workbench.ts). */
function openArtifactInWorkbench(a: FileArtifact): void {
  const open = (window as unknown as { __wbOpenArtifact?: (a: FileArtifact) => void }).__wbOpenArtifact;
  if (open) open(a);
}

// ── Kind → icon (the settings-nav idiom: 24-box line SVGs) ───────────────────

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

function fmtSize(bytes: number): string {
  if (!bytes) return "0 KB";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${Math.round(kb)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

// ── State ────────────────────────────────────────────────────────────────────

const $ = (id: string) => document.getElementById(id);

let allArtifacts: FileArtifact[] = [];
let view: "grid" | "table" = "grid";
/** Preview text per id, fetched once and kept for the session. */
const peeks = new Map<string, string>();

function timeOf(a: FileArtifact): number {
  const t = Date.parse(a.createdAt || "");
  return Number.isNaN(t) ? 0 : t;
}

function showError(msg: string | null): void {
  const el = $("files-error");
  if (!el) return;
  el.textContent = msg || "";
  el.classList.toggle("hidden", !msg);
}

/** The ⋯ button both views hang off, same menu in each. */
function menuFor(a: FileArtifact): HTMLElement {
  const items = (): RowMenuItem[] => [
    { icon: ROW_MENU_ICONS.view, label: "Open", onClick: () => { void openArtifact(a.id); } },
    { icon: ROW_MENU_ICONS.edit, label: "Rename", onClick: () => { void renameArtifact(a); } },
    { icon: ROW_MENU_ICONS.delete, label: "Delete", danger: true, onClick: () => { void deleteArtifact(a); } },
  ];
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "lib-row-kebab";
  btn.title = "More";
  btn.textContent = "⋮";
  btn.addEventListener("click", (e) => { e.stopPropagation(); openRowMenu(btn, items()); });
  return btn;
}

/** A tile's preview: the picture itself, or the opening lines of the text. */
function previewInto(tile: HTMLElement, a: FileArtifact): void {
  if (a.kind === "image" && a.downloadUrl) {
    const img = document.createElement("img");
    img.className = "artifact-tile-img";
    img.src = a.downloadUrl;
    img.alt = "";
    img.loading = "lazy";
    tile.appendChild(img);
    return;
  }
  if (a.kind === "pdf" || a.kind === "other") {
    tile.innerHTML = `<span class="artifact-tile-glyph">${KIND_ICON[a.kind]}</span>`;
    return;
  }
  const pre = document.createElement("pre");
  pre.className = "artifact-tile-pre";
  const cached = peeks.get(a.id);
  pre.textContent = cached ?? "";
  tile.appendChild(pre);
  if (cached !== undefined) return;
  void bridge()?.filesPeek?.(a.id).then((text) => {
    peeks.set(a.id, text || "");
    pre.textContent = text || "";
  }).catch(() => { peeks.set(a.id, ""); });
}

function renderGrid(host: HTMLElement, list: FileArtifact[]): void {
  const grid = document.createElement("div");
  grid.className = "artifact-grid";
  for (const a of list) {
    const card = document.createElement("div");
    card.className = "artifact-card";
    card.dataset.id = a.id;

    const tile = document.createElement("div");
    tile.className = `artifact-tile artifact-tile-${a.kind}`;
    previewInto(tile, a);
    tile.addEventListener("click", () => { void openArtifact(a.id); });
    card.appendChild(tile);

    const foot = document.createElement("div");
    foot.className = "artifact-card-foot";
    foot.innerHTML = `
      <span class="artifact-card-icon">${KIND_ICON[a.kind]}</span>
      <span class="artifact-card-text">
        <span class="artifact-card-name">${escapeHtml(a.name)}</span>
        <span class="artifact-card-meta">${KIND_LABEL[a.kind]} · ${escapeHtml(fmtSize(a.sizeBytes))}${timeOf(a) ? ` · ${escapeHtml(relativeTime(timeOf(a)))}` : ""}</span>
      </span>`;
    foot.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".lib-row-kebab")) return;
      void openArtifact(a.id);
    });
    foot.appendChild(menuFor(a));
    card.appendChild(foot);
    grid.appendChild(card);
  }
  host.appendChild(grid);
}

function renderTable(host: HTMLElement, list: FileArtifact[]): void {
  const table = document.createElement("table");
  table.className = "lib-table";
  table.innerHTML = `<thead><tr><th>Name</th><th>Kind</th><th>Size</th><th>Modified</th><th class="lib-row-kebab-cell"></th></tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const a of list) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="lib-table-name"><span class="artifact-row-icon">${KIND_ICON[a.kind]}</span>${escapeHtml(a.name)}</td>
      <td class="lib-table-dim">${KIND_LABEL[a.kind]}</td>
      <td class="lib-table-dim">${escapeHtml(fmtSize(a.sizeBytes))}</td>
      <td class="lib-table-dim">${timeOf(a) ? escapeHtml(relativeTime(timeOf(a))) : "—"}</td>`;
    tr.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".lib-row-kebab")) return;
      void openArtifact(a.id);
    });
    const cell = document.createElement("td");
    cell.className = "lib-row-kebab-cell";
    cell.appendChild(menuFor(a));
    tr.appendChild(cell);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.appendChild(table);
}

function paint(): void {
  const host = $("files-gallery");
  const empty = $("files-empty");
  if (!host) return;
  const q = ($("file-search") as HTMLInputElement | null)?.value.trim().toLowerCase() || "";
  const list = q ? allArtifacts.filter((a) => a.name.toLowerCase().includes(q)) : allArtifacts;
  host.innerHTML = "";
  if (empty) {
    empty.textContent = q ? "No artifacts match your search." : "No artifacts yet — create one, or ask the agent to.";
    empty.classList.toggle("hidden", list.length > 0);
  }
  const count = $("files-count");
  if (count) count.textContent = allArtifacts.length ? `${allArtifacts.length} artifact${allArtifacts.length === 1 ? "" : "s"}` : "";
  if (!list.length) return;
  if (view === "grid") renderGrid(host, list);
  else renderTable(host, list);
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function openArtifact(id: string): Promise<void> {
  const b = bridge();
  let art = allArtifacts.find((a) => a.id === id);
  if (b?.filesGet) {
    try { art = await b.filesGet(id); }
    catch (e) { showError(`Couldn't open that artifact: ${(e as Error).message}`); }
  }
  if (art) openArtifactInWorkbench({ ...art, kind: normalizeKind(art.kind) });
}

async function renameArtifact(a: FileArtifact): Promise<void> {
  const b = bridge();
  if (!b?.filesRename) return;
  const name = await promptAction("Rename artifact", a.name, "e.g. notes.md", "Rename");
  if (!name || name === a.name) return;
  const r = await b.filesRename(a.id, name);
  if (!r.ok) { showError(r.error || "Couldn't rename that artifact"); return; }
  peeks.delete(a.id);
  await loadFiles();
}

async function deleteArtifact(a: FileArtifact): Promise<void> {
  const b = bridge();
  if (!b?.filesDelete) return;
  const ok = await confirmAction({
    title: "Delete this artifact?",
    body: `${a.name} is deleted from this machine. That cannot be undone.`,
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  const r = await b.filesDelete(a.id);
  if (!r.ok) { showError(r.error || "Couldn't delete that artifact"); return; }
  peeks.delete(a.id);
  await loadFiles();
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Load + render the artifacts library. Called by loadActiveSection("files"). */
export async function loadFiles(): Promise<void> {
  showError(null);
  const b = bridge();
  if (!b?.filesList) {
    allArtifacts = [];
    paint();
    showError(NO_TRANSPORT);
    return;
  }
  try {
    const items = await b.filesList();
    allArtifacts = (items || [])
      .map((a) => ({ ...a, kind: normalizeKind(a.kind) }))
      .sort((x, y) => timeOf(y) - timeOf(x));
    paint();
  } catch (e) {
    allArtifacts = [];
    paint();
    showError(`Couldn't load artifacts: ${(e as Error).message}`);
  }
}

let filesWired = false;

/** Wire search, the view toggle and "New artifact" once, at boot. */
export function initFiles(): void {
  if (filesWired) return;
  filesWired = true;

  ($("file-search") as HTMLInputElement | null)?.addEventListener("input", paint);

  const setView = (next: "grid" | "table") => {
    view = next;
    $("file-view-grid")?.classList.toggle("active", next === "grid");
    $("file-view-table")?.classList.toggle("active", next === "table");
    void (window as unknown as { glyphh?: { setPreference?: (k: string, v: unknown) => Promise<void> } })
      .glyphh?.setPreference?.("artifactsView", next);
    paint();
  };
  $("file-view-grid")?.addEventListener("click", () => setView("grid"));
  $("file-view-table")?.addEventListener("click", () => setView("table"));
  void (window as unknown as { glyphh?: { getPreference?: (k: string, d: unknown) => Promise<unknown> } })
    .glyphh?.getPreference?.("artifactsView", "grid")
    .then((v) => { if (v === "table") setView("table"); })
    .catch(() => {});

  // NEW ARTIFACT IS A CONVERSATION (his order, 2026-09-18): the button opens
  // the default agent with the ask already typed and NOT sent, so the first
  // thing that happens is the agent asking what it should show, rather than an
  // empty file appearing with a name nobody chose.
  $("file-new-btn")?.addEventListener("click", () => {
    const compose = (window as unknown as { __wbComposeToAgent?: (text: string) => void }).__wbComposeToAgent;
    if (!compose) { showError("Open the workbench to start an artifact."); return; }
    closeSettingsOverlay();
    compose(NEW_ARTIFACT_PROMPT);
  });
}
