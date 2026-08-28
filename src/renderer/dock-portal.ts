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
 *   - parking freezes the dock at its EXACT at-rest size (his rule): the
 *     zoom code looks the dock up through the STAGE, so a parked dock is
 *     invisible to it, and any transforms it left behind are cleared here.
 *
 * Everything is wrapped so a failure degrades to "dock stays in the stage"
 * — never to a dead wall.
 */

let layer: HTMLDivElement | null = null;
let home: HTMLDivElement | null = null;
// The icon size measured while the wall is VISIBLE. In the stage the slots
// flex-shrink to the seat's width; a parked bar sizes against the viewport
// and would relax wider — his rule is the parked dock keeps the EXACT wall
// geometry, so the at-rest size is cached here and frozen onto every slot
// at park time (offsetWidth: layout size, immune to the hover zoom's
// transforms). The wall is display:none once panels cover it, so this can
// only be measured ahead of time — never at park time.
let restSize = 0;

function ensureLayer(): HTMLDivElement {
  if (layer && layer.isConnected) return layer;
  layer = document.createElement("div");
  layer.id = "echo-dock-layer";
  document.body.appendChild(layer);
  return layer;
}

function sync(): void {
  try {
    const stageBar = document.querySelector<HTMLElement>(".ws-echo-body .echo-topbar");
    const parked = layer?.querySelector<HTMLElement>(".echo-topbar") ?? null;
    // The wall re-rendered while a bar was parked — the parked one is stale.
    if (stageBar && parked) { parked.remove(); home = null; }
    const bar = stageBar ?? parked;
    if (!bar) return;
    const overPanels = document.body.classList.contains("echo-wall-hidden");
    if (!overPanels && bar === stageBar) {
      const probe = bar.querySelector<HTMLElement>(".echo-dock-btn");
      if (probe && probe.offsetWidth > 20) restSize = probe.offsetWidth;
    }
    if (overPanels && bar === stageBar) {
      if (!home || !home.isConnected) {
        home = document.createElement("div");
        home.className = "echo-topbar-home";
        bar.before(home);
      }
      // Freeze at-rest geometry: clear any magnification the zoom left
      // behind, and pin every slot (the CC-only ones included) to the
      // cached wall size so nothing relaxes wider than its wall seat.
      bar.querySelectorAll<HTMLElement>(".echo-dock-btn").forEach((b) => {
        b.style.transform = "";
        if (restSize > 20) { b.style.width = `${restSize}px`; b.style.height = `${restSize}px`; }
      });
      ensureLayer().appendChild(bar);
    } else if (!overPanels && bar === parked && home?.isConnected) {
      bar.querySelectorAll<HTMLElement>(".echo-dock-btn").forEach((b) => { b.style.width = ""; b.style.height = ""; });
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
