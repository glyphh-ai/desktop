/**
 * code-anchor.ts — THE AGENT IS THE BOTTOM COMPOSER, period.
 *
 * The anchor SYSTEM is GONE (his rule, 2026-08-18: "remove the entire
 * anchoring system — that is just making this too complicated"): no picker,
 * no rail/left/right/none modes, no dock splitter, no saved fraction. The
 * agent's input floats bottom-center over the workspace (the old "center"
 * presentation, restyled), the status line + caret PEEK the live thread as
 * an overlay dialog, and opening it never closes a panel.
 *
 * What survives here is the residue other modules still call:
 *   - anchorMode()/isCollapsed(): constant — the one presentation.
 *   - applyAnchor(): asserts the mode on the DOM (data-anchor="center"),
 *     parks the agent as `.code-root`'s direct child (the only DOM position
 *     the CSS styles), relocates the session buttons into the composer row,
 *     and asks the workbench to reflow.
 *   - the peek (isPeeking/togglePeek/closePeek) — the caret's dialog.
 *
 * INVARIANT that cost a real bug to learn: relocateActions MOVES nodes
 * (appendChild keeps their listeners) — any innerHTML near them silently
 * unwires them.
 */

export type AnchorMode = "center";

const root = (): HTMLElement | null => document.querySelector<HTMLElement>(".code-root");
const byId = (id: string): HTMLElement | null => document.getElementById(id);

export function anchorMode(): AnchorMode { return "center"; }
export function isCollapsed(): boolean { return true; }

// ── Applying the one mode ───────────────────────────────────────────────────

export function applyAnchor(): void {
  const el = root();
  if (!el) return;
  el.dataset.anchor = "center";
  document.body.dataset.glyphhAnchor = "center";
  // The agent must be `.code-root`'s DIRECT child (its flex home) or none of
  // the bottom-composer CSS matches. The workbench re-homes it there and
  // drops any stale overlay hosting. (The session controls — transcript,
  // recents, + — are STATIC DOM in the card's right chip group now; no
  // relocation step.)
  (window as unknown as { __wbParkAgent?: () => void }).__wbParkAgent?.();
  const status = byId("code-status-line");
  if (status) (status as HTMLButtonElement).hidden = false;
  (window as unknown as { __wbReflow?: () => void }).__wbReflow?.();
}

// ── Peek — the caret's dialog ───────────────────────────────────────────────
//
// The peek does NOT copy messages. `renderThread()` wipes #code-thread's
// children on every repaint, so any clone is stale within a frame — and the
// streamer writes into that same element. Peek therefore just REPOSITIONS the
// live thread as an overlay; "the last few messages" falls out of the existing
// bottom-pinned scroll plus a max-height. It never closes a panel.

export function isPeeking(): boolean { return root()?.classList.contains("peeking") ?? false; }

/**
 * Size + place the open panel CONNECTED to the input (his rule, 2026-08-19):
 * exactly the pill's width, and pulled DOWN so its bottom edge tucks BEHIND
 * the input card (the card sits at a higher z, so the panel reads as growing
 * out of it). The card's width moves with the side band, so this measures at
 * open time and on resize instead of hardcoding the geometry in CSS.
 */
function fitPeek(): void {
  const agent = root()?.querySelector<HTMLElement>(".code-agent");
  // Align to the OUTER fused pill (.code-pill-row) — the panel must sit
  // EXACTLY over the shape it connects to, edge for edge.
  const card = agent?.querySelector<HTMLElement>(".code-pill-row")
    ?? agent?.querySelector<HTMLElement>(".code-input-card");
  const thread = byId("code-thread");
  if (!agent || !card || !thread) return;
  const a = agent.getBoundingClientRect();
  const c = card.getBoundingClientRect();
  thread.style.left = `${Math.round(c.left - a.left)}px`;
  thread.style.width = `${Math.round(c.width)}px`;
  thread.style.transform = "none";                                  // beats the CSS centering fallback
  thread.style.bottom = `${Math.round(a.bottom - c.bottom + 8)}px`; // bottom edge BEHIND the pill
  thread.style.paddingBottom = `${Math.round(c.height + 10)}px`;    // content clears the overlapping pill
  // NEVER grow into the dock (his report, 2026-08-30: bubbles rendered
  // through the dock's gaps). While the dock is VISIBLE — in the stage or
  // parked in the body-level portal, and not tucked off the top — the panel's
  // ceiling is the dock's bottom edge. CSS min() keeps the user's height
  // slider (--echo-agent-max-h) and the 860px cap in force alongside it.
  const dock = document.querySelector<HTMLElement>(".echo-topbar");
  const tucked = document.body.classList.contains("echo-dock-tucked") && !document.body.classList.contains("echo-dock-peek");
  let ceiling = 0;
  if (dock && !tucked) {
    const r = dock.getBoundingClientRect();
    if (r.height > 0 && r.bottom > 0) ceiling = r.bottom + 8;
  }
  const avail = Math.max(160, Math.round((c.bottom - 8) - ceiling));
  thread.style.maxHeight = `min(var(--echo-agent-max-h, 76vh), 860px, ${avail}px)`;
}
const refitPeek = (): void => { if (isPeeking()) fitPeek(); };
window.addEventListener("resize", refitPeek);
// LIVE GEOMETRY (his rule, 2026-08-20): the feed panel resizes WITH the
// input — width/X drags fire this event, and a ResizeObserver on the card
// catches growth the drags don't (chips, autoGrow).
window.addEventListener("glyphh:agent-geometry", refitPeek);
// Dock tuck/peek flips ride BODY CLASSES (no resize, no geometry event) —
// watch them so an appearing dock immediately pushes the panel's ceiling down.
new MutationObserver(refitPeek).observe(document.body, { attributes: true, attributeFilter: ["class"] });
{
  const card = root()?.querySelector<HTMLElement>(".code-input-card");
  if (card) new ResizeObserver(refitPeek).observe(card);
}

export function closePeek(): void {
  root()?.classList.remove("peeking");
  document.body.classList.remove("peek-open");
  // Drop the measured geometry so the closed thread returns to its CSS state.
  const thread = byId("code-thread");
  if (thread) { thread.style.left = ""; thread.style.width = ""; thread.style.transform = ""; thread.style.bottom = ""; thread.style.paddingBottom = ""; thread.style.maxHeight = ""; }
}

export function togglePeek(): void {
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
    fitPeek();
    const thread = byId("code-thread");
    if (thread) thread.scrollTop = thread.scrollHeight;
    byId("code-status-line")?.classList.remove("has-unread");
  } else {
    closePeek();   // one close path: also clears the measured geometry
  }
}

// ── Boot ────────────────────────────────────────────────────────────────────

/** Assert the one presentation. Called from loadCode()/boot. (Async residue —
 *  callers still `void initAnchor()`; there is no pref to read anymore.) */
export async function initAnchor(): Promise<void> {
  applyAnchor();
}

/** One-time event wiring. Safe to call once at init. */
export function initAnchorEvents(): void {
  byId("code-status-line")?.addEventListener("click", (ev) => { ev.stopPropagation(); togglePeek(); });
  // (The transcript button is gone — the droplet took its spot on the card;
  // the status-line caret is the one thread opener.)

  // Dismissal: click outside the agent, or Escape. (Panels are untouched —
  // the peek is an overlay, closing it just lowers the dialog.)
  document.addEventListener("pointerdown", (ev) => {
    if (!isPeeking()) return;
    const t = ev.target as HTMLElement;
    // Switching sessions is USING the peek, not leaving it (his rule,
    // 2026-08-27): a click in the rail — a recents row, the search, the
    // disclosure — keeps the dialog up streaming the newly picked thread.
    if (t.closest(".code-agent") || t.closest("#code-history")
      || t.closest("#recents-toggle") || t.closest(".app-rail-search")) return;
    closePeek();
  }, true);
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && isPeeking()) { ev.stopPropagation(); closePeek(); }
  });
}
