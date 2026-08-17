/**
 * code-anchor.ts — WHERE THE AGENT SITS.
 *
 * The agent used to own a fixed column beside the workbench. This module lets it
 * dock instead, so the layout manager can have the rest of the screen:
 *
 *   rail    the agent is a workbench SLOT (`view:"coding"`) — the long-standing
 *           default. Every layout with no opinion resolves here, so nothing
 *           changes for anyone until they opt in.
 *   left    the agent docks to the left edge; the ENTIRE right side is layout.
 *   right   mirrored.
 *   center  the agent becomes a one-line bar along the BOTTOM and the layout
 *           takes everything above it. This is COLLAPSED MODE.
 *   none    no agent on screen.
 *
 * `center` IS collapsed mode. There is deliberately no second `collapsed` flag —
 * that would be two sources of truth for one thing.
 *
 * THREE INVARIANTS, each of which cost a real bug to learn:
 *
 *  1. LEFT/RIGHT flip with CSS `order`, never by moving DOM. `parkAgent()` in
 *     code-workbench.ts re-asserts the agent's DOM position before every rails
 *     rebuild, so a DOM-move approach fights the workbench on every render.
 *  2. Collapsed mode RELOCATES the session buttons by MOVING the nodes.
 *     `#code-session-new` / `#code-session-history` are wired with
 *     addEventListener on the node itself (help/code.ts), so appendChild keeps
 *     their handlers — but any innerHTML near them silently unwires them.
 *  3. The header is HIDDEN, never deleted. `#code-session-back`, `-title`,
 *     `-locus`, `-kebab` and the view toggles must survive so flipping back to
 *     left/right restores a working header.
 */

export type AnchorMode = "rail" | "left" | "right" | "center" | "none";

const MODES: Array<{ id: AnchorMode; label: string; hint: string }> = [
  { id: "rail", label: "In the workspace", hint: "The agent is a panel, like today" },
  { id: "left", label: "Dock left", hint: "Agent on the left, layout fills the right" },
  { id: "center", label: "Dock bottom", hint: "One line along the bottom, layout above" },
  { id: "right", label: "Dock right", hint: "Agent on the right, layout fills the left" },
];

const MODE_PREF = "glyphhAnchorMode";
const FRAC_PREF = "glyphhAnchorFraction";
const DEFAULT_FRACTION = 0.32;
/** Same band `clampFraction` uses in main/screen-layout.ts — one dock, one range. */
const clampFraction = (f: number): number => Math.max(0.2, Math.min(0.6, f));

let mode: AnchorMode = "rail";
let fraction = DEFAULT_FRACTION;

const root = (): HTMLElement | null => document.querySelector<HTMLElement>(".code-root");
const byId = (id: string): HTMLElement | null => document.getElementById(id);
/** Preference bridge via a cast, not the global Window.glyphh declaration —
 *  this module is also bundled into code-workbench-bundle.js, which is
 *  typechecked standalone (no renderer.ts globals in scope there).
 *
 *  getPreference/setPreference are the SERVER prefs map (preferences-db.ts →
 *  client.profile.prefs) — the DB via the SDK, not local disk. The read WAITS for
 *  the map to load when signed in (get-preference IPC), so a boot-time read gets
 *  the saved value, not the default. */
type PrefsBridge = {
  getPreference?: (k: string, d?: unknown) => Promise<unknown>;
  setPreference?: (k: string, v: unknown) => Promise<unknown> | void;
};
const prefs = (): PrefsBridge => (window as unknown as { glyphh?: PrefsBridge }).glyphh ?? {};

/** The LIVE mode comes from the DOM, not the module variable: this module is
 *  bundled into BOTH the help build and the code-workbench bundle (a layout's
 *  anchor opinion applies from there), and two module instances would each
 *  keep their own `mode`. body[data-glyphh-anchor] is the one shared truth —
 *  every applyAnchor writes it, so both instances always agree. */
function domMode(): AnchorMode {
  const m = document.body.dataset.glyphhAnchor as AnchorMode | undefined;
  return m && MODES.some((x) => x.id === m) ? m : mode;
}

export function anchorMode(): AnchorMode { return domMode(); }
export function isCollapsed(): boolean { return domMode() === "center"; }

// ── Applying the mode ───────────────────────────────────────────────────────

/**
 * Move the session controls between the header and the composer's source row.
 * MOVES nodes (append/insertBefore keep listeners); never re-creates them.
 */
function relocateActions(collapsed: boolean): void {
  const bar = byId("code-bar-actions");
  const head = document.querySelector<HTMLElement>(".session-head-actions");
  if (!bar || !head) return;
  // ONE consistent order EVERYWHERE the agent loads (docked, hosted, or full):
  //   <chat icon> <anchor> <recents> <new session> <three-dots>
  // Move the anchor + kebab WRAPS (button AND their popup menu) — moving only the
  // button orphaned the menu, which is why the anchor popup did nothing when docked.
  const target = collapsed ? bar : head;
  // Move the anchor WRAP (button + its menu) so the popup works wherever the row
  // lives. The three-dots (code-view-more) is NOT touched — it stays at the far
  // right where it has always been.
  for (const id of ["code-transcript-btn", "code-anchor-wrap", "code-session-history", "code-session-new"]) {
    const node = byId(id);
    if (node) target.appendChild(node);
  }
}

/** The live dock fraction, DOM-first for the same two-instance reason as
 *  domMode(): the drag handler lives in the help instance, but a layout's
 *  anchor opinion applies from the workbench bundle — without this, that
 *  apply would reset a dragged width to the default. */
function domFraction(): number {
  const raw = parseFloat(root()?.style.getPropertyValue("--agent-dock-frac") || "");
  return Number.isFinite(raw) && raw > 0 ? clampFraction(raw) : fraction;
}

/** Paint the dock width custom property (left/right only). */
function applyFraction(): void {
  const el = root();
  if (!el) return;
  el.style.setProperty("--agent-dock-frac", String(fraction));
}

export function applyAnchor(next: AnchorMode = domMode()): void {
  mode = next;
  fraction = domFraction();
  const el = root();
  if (!el) return;
  // `none` with nothing else on screen would leave a blank window and no way
  // back, so it degrades to the workspace default.
  if (mode === "none" && !document.querySelector("#code-wb-rails .ws-right-rail")) mode = "rail";
  el.dataset.anchor = mode;
  document.body.dataset.glyphhAnchor = mode;
  // A DOCK mode needs the agent as `.code-root`'s DIRECT child (out of any Echo card,
  // `agent-hosted` cleared) or none of the dock CSS above matches — the agent stays
  // wherever it was hosted and NOTHING moves. Ask the workbench to re-home it.
  if (mode === "left" || mode === "right" || mode === "center") {
    (window as unknown as { __wbParkAgent?: () => void }).__wbParkAgent?.();
  }
  applyFraction();
  const collapsed = mode === "center";
  relocateActions(collapsed);
  const status = byId("code-status-line");
  if (status) (status as HTMLButtonElement).hidden = !collapsed;
  if (!collapsed) closePeek();
  paintAnchorMenu();
  // The dock changes how much room the rails have; the workbench owns that math.
  (window as unknown as { __wbReflow?: () => void }).__wbReflow?.();
}

export function setAnchor(next: AnchorMode): void {
  applyAnchor(next);
  console.log(`[anchor] setAnchor persisting glyphhAnchorMode="${mode}"`);
  void Promise.resolve(prefs().setPreference?.(MODE_PREF, mode))
    .then(() => console.log(`[anchor] setAnchor SAVED glyphhAnchorMode="${mode}"`))
    .catch((e) => console.warn(`[anchor] setAnchor FAILED to save`, e));
}

// ── Peek ────────────────────────────────────────────────────────────────────
//
// The peek does NOT copy messages. `renderThread()` wipes #code-thread's
// children on every repaint, so any clone is stale within a frame — and the
// streamer writes into that same element. Peek therefore just REPOSITIONS the
// live thread as an overlay; "the last few messages" falls out of the existing
// bottom-pinned scroll plus a max-height.

export function isPeeking(): boolean { return root()?.classList.contains("peeking") ?? false; }

export function closePeek(): void {
  root()?.classList.remove("peeking");
  document.body.classList.remove("peek-open");
}

export function togglePeek(): void {
  if (!isCollapsed()) return;
  const el = root();
  if (!el) return;
  // The transcript panel owns the thread when it is open; peeking would steal
  // it out of the panel. One home, one owner.
  if (el.classList.contains("thread-hosted")) {
    (window as unknown as { __wbFlashThread?: () => void }).__wbFlashThread?.();
    return;
  }
  const open = el.classList.toggle("peeking");
  document.body.classList.toggle("peek-open", open);
  if (open) {
    const thread = byId("code-thread");
    if (thread) thread.scrollTop = thread.scrollHeight;
    byId("code-status-line")?.classList.remove("has-unread");
  }
}

// ── The picker ──────────────────────────────────────────────────────────────

function paintAnchorMenu(): void {
  const menu = byId("code-anchor-menu");
  if (!menu || menu.classList.contains("hidden")) return;
  buildAnchorMenu(menu);
}

function buildAnchorMenu(menu: HTMLElement): void {
  menu.textContent = "";
  const cur = domMode();
  for (const m of MODES) {
    const item = document.createElement("button");
    item.className = "code-drop-item" + (m.id === cur ? " selected" : "");
    item.type = "button";
    const lines = document.createElement("span");
    lines.className = "drop-lines";
    const label = document.createElement("span");
    label.textContent = m.label;
    const hint = document.createElement("span");
    hint.className = "drop-hint";
    hint.textContent = m.hint;
    lines.append(label, hint);
    item.appendChild(lines);
    if (m.id === cur) {
      item.insertAdjacentHTML("beforeend",
        `<svg class="drop-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`);
    }
    item.addEventListener("click", () => {
      setAnchor(m.id);
      menu.classList.add("hidden");
    });
    menu.appendChild(item);
  }
}

// ── The dock splitter ───────────────────────────────────────────────────────

function wireDockEdge(): void {
  const edge = byId("code-agent-edge");
  const el = root();
  if (!edge || !el) return;
  edge.addEventListener("mousedown", (e) => {
    const m = domMode();
    if (m !== "left" && m !== "right") return;
    e.preventDefault();
    edge.classList.add("dragging");
    document.body.classList.add("wb-mouse-drag");
    const rootW = el.getBoundingClientRect().width || 1;
    const onMove = (ev: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      // Right-anchored, the dock grows as the pointer moves LEFT.
      const raw = m === "left" ? (ev.clientX - rect.left) / rootW : (rect.right - ev.clientX) / rootW;
      fraction = clampFraction(raw);
      applyFraction();
    };
    const onUp = () => {
      edge.classList.remove("dragging");
      document.body.classList.remove("wb-mouse-drag");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      void prefs().setPreference?.(FRAC_PREF, fraction);
      (window as unknown as { __wbReflow?: () => void }).__wbReflow?.();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// ── Boot ────────────────────────────────────────────────────────────────────

/** Read the device's anchor preference and apply it. Called from loadCode(). */
export async function initAnchor(): Promise<void> {
  try {
    const savedMode = (await prefs().getPreference?.(MODE_PREF, "rail")) as AnchorMode;
    console.log(`[anchor] initAnchor read glyphhAnchorMode="${savedMode}"`);
    if (MODES.some((m) => m.id === savedMode)) mode = savedMode;
    const savedFrac = Number(await prefs().getPreference?.(FRAC_PREF, DEFAULT_FRACTION));
    fraction = clampFraction(Number.isFinite(savedFrac) && savedFrac > 0 ? savedFrac : DEFAULT_FRACTION);
  } catch {
    /* first run / prefs unavailable — the workspace default is correct */
  }
  applyAnchor(mode);
}

let prefsReadyWired = false;

/** One-time event wiring. Safe to call once at init. */
export function initAnchorEvents(): void {
  // The server prefs map may finish loading AFTER this view booted (the boot read
  // races the fetch). Re-read + re-apply the saved anchor when it lands. Registered
  // once even if initAnchorEvents runs again.
  if (!prefsReadyWired) {
    prefsReadyWired = true;
    (window as unknown as { glyphh?: { onPrefsReady?: (cb: () => void) => void } })
      .glyphh?.onPrefsReady?.(() => { void initAnchor(); });
  }
  // DELEGATED, not bound to a node: the anchor button + menu are relocated and
  // re-homed as the agent moves (rail → Echo card → dock), so a listener pinned
  // to the boot-time node goes stale — the dead dropdown when docked. Re-query
  // by id on every click instead.
  document.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    const menu = byId("code-anchor-menu");
    if (t.closest("#code-anchor-btn")) {
      ev.stopPropagation();
      if (!menu) return;
      const show = menu.classList.contains("hidden");
      document.querySelectorAll(".code-drop").forEach((d) => d.classList.add("hidden"));
      if (show) { buildAnchorMenu(menu); menu.classList.remove("hidden"); }
      return;
    }
    // Outside click dismisses an open menu.
    if (menu && !menu.classList.contains("hidden") && !menu.contains(t)) menu.classList.add("hidden");
  });

  byId("code-status-line")?.addEventListener("click", (ev) => { ev.stopPropagation(); togglePeek(); });

  // The transcript PANEL is the "thread" workbench slot. Until that lands the
  // button still has to do something honest, so it falls back to the peek —
  // and upgrades itself the moment __wbOpenThread exists.
  byId("code-transcript-btn")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const open = (window as unknown as { __wbOpenThread?: () => void }).__wbOpenThread;
    if (open) open();
    else togglePeek();
  });

  // Dismissal: click outside the agent, or Escape.
  document.addEventListener("pointerdown", (ev) => {
    if (!isPeeking()) return;
    if (!(ev.target as HTMLElement).closest(".code-agent")) closePeek();
  }, true);
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && isPeeking()) { ev.stopPropagation(); closePeek(); }
  });

  wireDockEdge();
}
