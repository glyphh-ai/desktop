/**
 * Shared utilities and types used across help sections.
 */

declare const Chart: any;

// ── Utility functions ──────────────────────────────────────

export function $a<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

/** The library pages' loading state (his order, 2026-09-16): a spinner and a line saying what is happening. */
export function loadingHtml(label: string): string {
  return `<div class="lib-loading"><span class="lib-spinner"></span><span>${escapeHtml(label)}</span></div>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "agent";
}

export function formatYos(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + "k yos";
  return `${n} yos`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function relativeTime(ts: number): string {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ── Fixed popover placement ────────────────────────────────

/**
 * Place a body-appended, position:fixed menu against its anchor: right-aligned
 * to the anchor but clamped inside the viewport, below the anchor but FLIPPED
 * ABOVE it when the bottom would clip (the drop-up case — anchors along the
 * collapsed bar always flip). Appends the menu to <body> if it isn't mounted,
 * and measures before showing so the first paint lands in place.
 */
export function placeDropup(anchor: HTMLElement, menu: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.visibility = "hidden";   // measure before showing
  if (!menu.isConnected) document.body.appendChild(menu);
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const left = Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8));
  const top = r.bottom + 6 + mh > window.innerHeight - 8
    ? Math.max(8, r.top - mh - 6)
    : r.bottom + 6;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.visibility = "";
}

// ── Drop-up detail pane ────────────────────────────────────

/**
 * The ⓘ on a chip's row opens its detail IN PLACE: the list slides out, the
 * detail slides in with a back arrow at the top. One popup, one surface —
 * never a tooltip stacked on a menu.
 *
 * `listPane` is whatever the menu normally shows (search + rows); it is
 * hidden while the detail is up and restored by the back arrow.
 */
export function showDropDetail(
  menu: HTMLElement,
  listPane: HTMLElement,
  detail: { title: string; body: string },
): void {
  menu.querySelector(".drop-detail")?.remove();
  const pane = document.createElement("div");
  pane.className = "drop-detail";
  const head = document.createElement("div");
  head.className = "drop-detail-head";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "drop-detail-back";
  back.title = "Back";
  back.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`;
  const title = document.createElement("span");
  title.className = "drop-detail-title";
  title.textContent = detail.title;
  head.append(back, title);
  const body = document.createElement("div");
  body.className = "drop-detail-body";
  body.textContent = detail.body;
  pane.append(head, body);
  back.addEventListener("click", (ev) => {
    ev.stopPropagation();
    pane.remove();
    listPane.classList.remove("hidden");
  });
  pane.addEventListener("click", (ev) => ev.stopPropagation());
  listPane.classList.add("hidden");
  menu.appendChild(pane);
}

// ── Confirm modal ──────────────────────────────────────────

/** <webview> composites ABOVE all page content regardless of z-index, so any
 *  modal renders UNDER the workspace panels. While a modal is up, the
 *  workbench webviews go invisible (their slots keep their size and come
 *  right back on close). Counted, so overlapping modals can't flicker. */
let modalGuardCount = 0;
export function guardWebviewsForModal(on: boolean): void {
  modalGuardCount = Math.max(0, modalGuardCount + (on ? 1 : -1));
  document.body.classList.toggle("wb-modal-open", modalGuardCount > 0);
}

export interface ConfirmOptions {
  /** Header — the question, short and specific ("Delete this layout?"). */
  title: string;
  /** Body — optional consequence line ("It disappears from your library."). */
  body?: string;
  /** Footer primary label; defaults to "Confirm". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive action → filled red confirm button. */
  danger?: boolean;
}

/**
 * The standard confirm dialog — header / body / footer, one look everywhere.
 * Enter confirms, Escape or clicking the backdrop cancels.
 */
export function confirmAction(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.getElementById("confirm-modal")!;
    // PORTAL: the overlay is authored inside #help-overlay, whose ancestor
    // stacking context caps it BELOW the body-mounted settings modal — no
    // z-index can win from in there (the revoke-key confirm opened invisibly
    // behind settings). Re-parent to <body> once; fixed positioning is
    // unaffected and every getElementById keeps resolving.
    if (overlay.parentElement !== document.body) document.body.appendChild(overlay);
    const titleEl = document.getElementById("confirm-title")!;
    const bodyWrap = overlay.querySelector<HTMLElement>(".confirm-body")!;
    const msgEl = document.getElementById("confirm-message")!;
    const yesBtn = document.getElementById("confirm-yes") as HTMLButtonElement;
    const noBtn = document.getElementById("confirm-no") as HTMLButtonElement;

    titleEl.textContent = opts.title;
    msgEl.textContent = opts.body || "";
    bodyWrap.classList.toggle("hidden", !opts.body);
    yesBtn.textContent = opts.confirmLabel || "Confirm";
    noBtn.textContent = opts.cancelLabel || "Cancel";
    yesBtn.classList.toggle("danger", !!opts.danger);
    overlay.classList.remove("hidden");
    guardWebviewsForModal(true);
    yesBtn.focus();

    function cleanup() {
      overlay.classList.add("hidden");
      guardWebviewsForModal(false);
      yesBtn.removeEventListener("click", onYes);
      noBtn.removeEventListener("click", onNo);
      overlay.removeEventListener("mousedown", onOverlay);
      document.removeEventListener("keydown", onKey);
    }
    function onYes() { cleanup(); resolve(true); }
    function onNo() { cleanup(); resolve(false); }
    function onOverlay(e: MouseEvent) { if (e.target === overlay) onNo(); }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); onNo(); }
      else if (e.key === "Enter") { e.preventDefault(); onYes(); }
    }

    yesBtn.addEventListener("click", onYes);
    noBtn.addEventListener("click", onNo);
    overlay.addEventListener("mousedown", onOverlay);
    document.addEventListener("keydown", onKey);
  });
}

export function clearInvalid(el: HTMLElement) {
  el.addEventListener("input", () => el.classList.remove("invalid"), { once: true });
}

/** Simple prompt modal (Electron BrowserViews don't support window.prompt). */
export function promptAction(message: string, defaultValue = "", placeholder = "", confirmLabel = "OK"): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.getElementById("skill-ask-user-modal");
    const qEl = document.getElementById("skill-ask-user-question");
    const ansEl = document.getElementById("skill-ask-user-answer") as HTMLTextAreaElement | null;
    const submitBtn = document.getElementById("skill-ask-user-submit");
    const cancelBtn = document.getElementById("skill-ask-user-cancel");
    if (!overlay || !qEl || !ansEl || !submitBtn || !cancelBtn) {
      resolve(null);
      return;
    }
    qEl.textContent = message;
    submitBtn.textContent = confirmLabel;
    ansEl.value = defaultValue;
    ansEl.placeholder = placeholder;
    overlay.classList.remove("hidden");
    guardWebviewsForModal(true);
    ansEl.focus();

    function cleanup() {
      overlay!.classList.add("hidden");
      guardWebviewsForModal(false);
      submitBtn!.removeEventListener("click", onSubmit);
      cancelBtn!.removeEventListener("click", onCancel);
      ansEl!.removeEventListener("keydown", onKey);
    }
    function onSubmit() { const v = ansEl!.value; cleanup(); resolve(v); }
    function onCancel() { cleanup(); resolve(null); }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSubmit(); }
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    }
    submitBtn.addEventListener("click", onSubmit);
    cancelBtn.addEventListener("click", onCancel);
    ansEl.addEventListener("keydown", onKey);
  });
}

// ── Pagination utility ──────────────────────────────────────

export const PAGE_SIZE = 15;

/**
 * The platform's web origin, as a STRING.
 *
 * `window.glyphh.platformUrl` is a real string on the desktop build (preload
 * sets it), but on web `window.glyphh` is a Proxy that fabricates a FUNCTION for
 * any name it doesn't know — so reading it there yields a function, and
 * `.replace(...)` on it throws. Every caller goes through here.
 */
export function platformUrl(): string {
  const raw = (window as unknown as { glyphh?: { platformUrl?: unknown } }).glyphh?.platformUrl;
  if (typeof raw === "string" && raw) return raw.replace(/\/+$/, "");
  // On web the app is served beside the platform; fall back to this origin so a
  // hand-off still lands somewhere real rather than "undefined/billing".
  try { return window.location.origin.replace(/\/+$/, ""); } catch { return ""; }
}

export interface PaginationState {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
}

export function renderPaginationBar(state: PaginationState, onPage: (page: number) => void): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "pagination-bar";
  if (state.totalPages <= 1) return bar;

  const info = document.createElement("span");
  info.className = "pagination-info";
  const start = state.page * state.pageSize + 1;
  const end = Math.min((state.page + 1) * state.pageSize, state.total);
  info.textContent = `${start}–${end} of ${state.total}`;

  const nav = document.createElement("div");
  nav.className = "pagination-nav";

  const prev = document.createElement("button");
  prev.className = "pagination-btn";
  prev.textContent = "‹ Prev";
  prev.disabled = state.page === 0;
  prev.addEventListener("click", () => onPage(state.page - 1));

  // Page buttons — show max 7 with ellipsis
  const pages: (number | "...")[] = [];
  const tp = state.totalPages;
  const cp = state.page;
  if (tp <= 7) {
    for (let i = 0; i < tp; i++) pages.push(i);
  } else {
    pages.push(0);
    if (cp > 2) pages.push("...");
    for (let i = Math.max(1, cp - 1); i <= Math.min(tp - 2, cp + 1); i++) pages.push(i);
    if (cp < tp - 3) pages.push("...");
    pages.push(tp - 1);
  }

  const next = document.createElement("button");
  next.className = "pagination-btn";
  next.textContent = "Next ›";
  next.disabled = state.page >= state.totalPages - 1;
  next.addEventListener("click", () => onPage(state.page + 1));

  nav.appendChild(prev);
  for (const p of pages) {
    if (p === "...") {
      const ell = document.createElement("span");
      ell.className = "pagination-ellipsis";
      ell.textContent = "…";
      nav.appendChild(ell);
    } else {
      const btn = document.createElement("button");
      btn.className = "pagination-btn" + (p === state.page ? " active" : "");
      btn.textContent = String(p + 1);
      btn.addEventListener("click", () => onPage(p));
      nav.appendChild(btn);
    }
  }
  nav.appendChild(next);

  bar.appendChild(info);
  bar.appendChild(nav);
  return bar;
}

export function paginate<T>(items: T[], page: number, pageSize: number = PAGE_SIZE): { items: T[]; state: PaginationState } {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  return {
    items: items.slice(safePage * pageSize, (safePage + 1) * pageSize),
    state: { page: safePage, totalPages, total: items.length, pageSize },
  };
}

export function buildPaginationBar(offset: number, pageSize: number, total: number, onNavigate: (newOffset: number) => void): HTMLElement {
  const page = Math.floor(offset / pageSize) + 1;
  const pages = Math.ceil(total / pageSize);
  const bar = document.createElement("div");
  bar.className = "pagination-bar";

  const prev = document.createElement("button");
  prev.className = "action-btn";
  prev.textContent = "←";
  prev.disabled = page <= 1;
  prev.addEventListener("click", () => onNavigate(Math.max(0, offset - pageSize)));
  bar.appendChild(prev);

  const label = document.createElement("span");
  label.className = "pagination-label";
  label.textContent = `${page} / ${pages}`;
  bar.appendChild(label);

  const next = document.createElement("button");
  next.className = "action-btn";
  next.textContent = "→";
  next.disabled = page >= pages;
  next.addEventListener("click", () => onNavigate(offset + pageSize));
  bar.appendChild(next);

  return bar;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
}

// ── Help overlay state (shared so sections can close without circular deps) ──

const overlay = document.getElementById("help-overlay")!;
let helpTransitioning = false;

export function closeHelp() {
  if (helpTransitioning) return;
  helpTransitioning = true;
  setTimeout(() => { helpTransitioning = false; }, 300);
  overlay.classList.add("hidden");
  window.glyphh.panelsShow();
}

export function getHelpOverlay(): HTMLElement {
  return overlay;
}

export function getHelpTransitioning(): boolean {
  return helpTransitioning;
}

export function setHelpTransitioning(v: boolean) {
  helpTransitioning = v;
}

/** Downscale a picked image to fit an avatar/logo slot (≤`max` px on the long
 *  side, webp) so a 4MB phone photo never bounces off a 512KB upload limit.
 *  Small files pass through untouched (keeps GIF animation); anything the
 *  browser can't decode passes through raw and the server's sniffer rules. */
export async function downscaleImage(file: File, max = 512, passThroughBytes = 480 * 1024): Promise<Uint8Array> {
  if (file.size <= passThroughBytes) return new Uint8Array(await file.arrayBuffer());
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/webp", 0.85));
    if (blob?.size) return new Uint8Array(await blob.arrayBuffer());
  } catch { /* undecodable — let the server's sniffer say so honestly */ }
  return new Uint8Array(await file.arrayBuffer());
}
