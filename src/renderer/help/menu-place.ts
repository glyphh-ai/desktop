/**
 * menu-place.ts — WHERE A POP-UP MENU GOES, as one pure rule (his report,
 * 2026-10-04: with the agent panel on the right of the screen the recents
 * dropdown and its filter menu opened rightwards off the viewport, cut off).
 *
 * Given the anchor's rect, the menu's size and the box it must live in (the
 * viewport, or a clipping ancestor), `placeMenu` answers with the top-left
 * corner, the side it opens on and the size caps:
 *
 *   · HORIZONTAL — the menu hangs from the preferred edge of its anchor
 *     (left-to-left or right-to-right). When that runs off the box it FLIPS
 *     to the other edge; when neither fits it is clamped inside, and its
 *     width is capped to the box so it can never be wider than the room.
 *   · VERTICAL — `side: "auto"` opens on the preferred side (below) and
 *     flips above when the room there is short and the other side is
 *     roomier; `side: "above"` / `"below"` never flip (the composer's
 *     drop-ups must not cover the input) — they cap the height to the room
 *     on that side instead, and the menu scrolls.
 *
 * Nothing here touches the DOM; `placeFixedMenu` below is the one thin
 * applier for a body-mounted `position: fixed` menu, and the chip drops in
 * code-source-chip.ts feed it their clip box instead of the window.
 */

export interface AnchorRect { left: number; top: number; width: number; height: number }
export interface MenuSize { width: number; height: number }
/** The box the menu must stay inside, in the same coordinates as the anchor. */
export interface PlaceBox { left: number; top: number; width: number; height: number }

export type MenuAlign = "left" | "right";
export type MenuSide = "below" | "above";

export interface PlaceOptions {
  /** The anchor edge the menu hangs from first. Default "left". */
  align?: MenuAlign;
  /** "auto" (default) flips to the roomier side; a fixed side never flips. */
  side?: MenuSide | "auto";
  /** Space between the anchor and the menu. Default 4. */
  gap?: number;
  /** The breathing room kept from every edge of the box. Default 8. */
  margin?: number;
  /** ONE FIXED WIDTH, whatever the content measures (his report, 2026-10-05:
   *  the recents dropdown re-sized with its rows). Capped to the room. */
  width?: number;
  /** The region that scrolls INSIDE the menu (its list) — the menu itself
   *  then keeps its overflow hidden and its pinned rows (search, tabs) stay
   *  put. Without it the whole menu scrolls. */
  scrollEl?: HTMLElement;
}

/** The frame a placed menu wears: its width (the fixed one, capped to the
 *  room, or null = whatever it measures) and its height cap, and which part
 *  scrolls. Pure — placeFixedMenu applies it; the test pins it. */
export interface MenuFrame { width: number | null; maxHeight: number; scroll: "menu" | "region" }
export function menuFrame(p: Pick<Placement, "maxWidth" | "maxHeight">, opts: { width?: number; scrollRegion?: boolean }): MenuFrame {
  return {
    width: opts.width != null ? Math.min(opts.width, p.maxWidth) : null,
    maxHeight: p.maxHeight,
    scroll: opts.scrollRegion ? "region" : "menu",
  };
}

export interface Placement {
  left: number;
  top: number;
  /** The edge the menu ended up hanging from. */
  align: MenuAlign;
  /** The side the menu ended up opening on. */
  side: MenuSide;
  /** The most room the menu may take, after the flip and the clamp. */
  maxWidth: number;
  maxHeight: number;
}

/** Pure: anchor + menu size + box → placement. */
export function placeMenu(anchor: AnchorRect, menu: MenuSize, box: PlaceBox, opts: PlaceOptions = {}): Placement {
  const gap = opts.gap ?? 4;
  const margin = opts.margin ?? 8;
  const boxLeft = box.left + margin;
  const boxRight = box.left + box.width - margin;
  const boxTop = box.top + margin;
  const boxBottom = box.top + box.height - margin;
  const maxWidth = Math.max(0, boxRight - boxLeft);
  const width = Math.min(menu.width, maxWidth);
  const anchorRight = anchor.left + anchor.width;
  const anchorBottom = anchor.top + anchor.height;

  // ── horizontal: preferred edge, flip, clamp ────────────────────────────
  const preferred: MenuAlign = opts.align ?? "left";
  const leftAligned = anchor.left;
  const rightAligned = anchorRight - width;
  const fitsLeft = leftAligned + width <= boxRight;
  const fitsRight = rightAligned >= boxLeft;
  let align: MenuAlign = preferred;
  if (preferred === "left" && !fitsLeft && fitsRight) align = "right";
  else if (preferred === "right" && !fitsRight && fitsLeft) align = "left";
  let left = align === "left" ? leftAligned : rightAligned;
  left = Math.max(boxLeft, Math.min(left, boxRight - width));

  // ── vertical: preferred side, flip when auto, cap to the room ──────────
  const roomBelow = Math.max(0, boxBottom - (anchorBottom + gap));
  const roomAbove = Math.max(0, anchor.top - gap - boxTop);
  const want: MenuSide = opts.side === "above" ? "above" : "below";
  let side: MenuSide = want;
  if (opts.side === undefined || opts.side === "auto") {
    const roomWanted = want === "below" ? roomBelow : roomAbove;
    const roomOther = want === "below" ? roomAbove : roomBelow;
    if (menu.height > roomWanted && roomOther > roomWanted) side = want === "below" ? "above" : "below";
  }
  const maxHeight = side === "below" ? roomBelow : roomAbove;
  const height = Math.min(menu.height, maxHeight);
  let top = side === "below" ? anchorBottom + gap : anchor.top - gap - height;
  top = Math.max(boxTop, Math.min(top, boxBottom - height));

  return { left: Math.round(left), top: Math.round(top), align, side, maxWidth: Math.round(maxWidth), maxHeight: Math.round(maxHeight) };
}

/** The viewport as a PlaceBox. */
export function viewportBox(): PlaceBox {
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
}

/**
 * Place a `position: fixed` menu against its anchor inside the viewport:
 * mounts it on <body> when it is not in the DOM yet, measures it hidden so
 * the first paint lands in place, then applies `placeMenu`. Returns the
 * placement so a caller can style by side.
 */
export function placeFixedMenu(anchor: HTMLElement, menu: HTMLElement, opts: PlaceOptions = {}): Placement {
  const r = anchor.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.visibility = "hidden";   // measure before showing
  if (!menu.isConnected) document.body.appendChild(menu);
  const box = viewportBox();
  // A fixed width is the menu's size from the start — the rows never set it.
  const measured = opts.width ?? menu.offsetWidth;
  const p = placeMenu(
    { left: r.left, top: r.top, width: r.width, height: r.height },
    { width: measured, height: menu.offsetHeight },
    box,
    opts,
  );
  const frame = menuFrame(p, { ...(opts.width != null ? { width: opts.width } : {}), scrollRegion: !!opts.scrollEl });
  menu.style.left = `${p.left}px`;
  menu.style.top = `${p.top}px`;
  menu.style.right = "auto";
  menu.style.bottom = "auto";
  // A menu wider than the room is capped to it. CSS min-width beats
  // max-width, so a stylesheet `min-width: 340px` has to be overridden too,
  // or the cap does nothing in a panel narrower than that.
  if (frame.width != null) {
    menu.style.minWidth = "0";
    menu.style.width = `${frame.width}px`;
    menu.style.maxWidth = `${frame.width}px`;
  } else if (measured > p.maxWidth) {
    menu.style.minWidth = "0";
    menu.style.width = `${p.maxWidth}px`;
    menu.style.maxWidth = `${p.maxWidth}px`;
  }
  menu.style.maxHeight = `${frame.maxHeight}px`;
  if (frame.scroll === "region" && opts.scrollEl) {
    menu.style.overflowY = "hidden";
    opts.scrollEl.style.minHeight = "0";
    opts.scrollEl.style.overflowY = "auto";
  } else {
    menu.style.overflowY = "auto";
  }
  menu.dataset.side = p.side;
  menu.dataset.align = p.align;
  menu.style.visibility = "";
  return p;
}
