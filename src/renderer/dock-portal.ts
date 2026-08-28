/**
 * dock-portal.ts — the dock's body-level portal, ISOLATED.
 *
 * The dock must render above the agent (z-118) and app (z-120) body layers
 * whenever panels cover the wall, and no z-index inside the wall's DOM can
 * do that — an ancestor stacking context caps it (three failed attempts
 * prove it). The working pattern is the agent holder's: reparent to a
 * body-level layer. The last attempt threaded that through the wall's own
 * render path and a mid-function failure killed every click handler bound
 * after it — so THIS module owns the whole behavior from the outside:
 *
 *   - it observes body classes the workbench already maintains
 *     (echo-wall-hidden / echo-dock-tucked / echo-dock-peek) and parks the
 *     `.echo-topbar` into #echo-dock-layer (z-2000) while panels are up,
 *     returning it to its stage home when the wall is the surface;
 *   - a stale parked bar (the wall re-rendered and minted a fresh one) is
 *     removed on the next tick — no ghosts;
 *   - parking never resizes anything (his rule): the slots keep their
 *     stylesheet size — the same clamp() the wall uses — and any transforms
 *     the zoom left behind are cleared on the way over.
 *
 * Everything is wrapped so a failure degrades to "dock stays in the stage"
 * — never to a dead wall.
 */

let layer: HTMLDivElement | null = null;
let home: HTMLDivElement | null = null;

function ensureLayer(): HTMLDivElement {
  if (layer && layer.isConnected) return layer;
  layer = document.createElement("div");
  layer.id = "echo-dock-layer";
  document.body.appendChild(layer);
  return layer;
}

function sync(): void {
  try {
    // A drag is in flight — re-parenting the bar now would cancel it (the
    // node under the pointer disappears). The next tick reconciles.
    if (document.body.classList.contains("echo-icon-dragging")) return;
    const stageBar = document.querySelector<HTMLElement>(".ws-echo-body .echo-topbar");
    const parked = layer?.querySelector<HTMLElement>(".echo-topbar") ?? null;
    // The wall re-rendered while a bar was parked — the parked one is stale.
    if (stageBar && parked) { parked.remove(); home = null; }
    const bar = stageBar ?? parked;
    if (!bar) return;
    const overPanels = document.body.classList.contains("echo-wall-hidden");
    if (overPanels && bar === stageBar) {
      if (!home || !home.isConnected) {
        home = document.createElement("div");
        home.className = "echo-topbar-home";
        bar.before(home);
      }
      // Clear any magnification the zoom left behind. NOTHING here resizes:
      // the slots keep their stylesheet size — the same clamp() the wall
      // uses — so the parked bar matches the CC exactly, by construction.
      bar.querySelectorAll<HTMLElement>(".echo-dock-btn").forEach((b) => { b.style.transform = ""; });
      ensureLayer().appendChild(bar);
    } else if (!overPanels && bar === parked && home?.isConnected) {
      home.after(bar);
    }
  } catch { /* degrade to in-stage — never take the wall down */ }
}

/** Wire once, from anywhere, any time — resilient to the wall not existing yet. */
export function initDockPortal(): void {
  try {
    ensureLayer();
    new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ["class"] });
    // Re-renders replace the bar without a class change — a slow tick reconciles.
    window.setInterval(sync, 600);
    sync();
  } catch { /* the dock simply stays in the stage */ }
}
