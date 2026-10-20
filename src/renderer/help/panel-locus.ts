/**
 * panel-locus.ts — WHERE a streamed panel renders, as pure rules (his order,
 * 2026-10-04: on the web a URL app panel renders on a CLOUD browser worker,
 * never through a tunnel into the member's desktop).
 *
 * A streamed panel (panel-stream.ts) is a page rendered somewhere this tab
 * cannot reach, relayed through the server's `/ws/panel` and drawn on a
 * canvas. Two sources satisfy the same wire — the member's attached DESKTOP
 * and a CLOUD browser worker — and the pick between them is the one decision
 * this module owns:
 *
 *   web      → cloud    (the point: no desktop in the path)
 *   desktop  → desktop  (the app's own machine streams to its own web views)
 *   a caller may name one explicitly (`requested`), which always wins.
 *
 * The locus rides `panel.open` as `locus`, which the relay reads to pick the
 * member's browser worker or a desktop; the rest of the wire is identical.
 * The copy and the dead-end cards differ per locus — a cloud panel never asks
 * about an attached desktop — and that mapping is pure here so the renderer
 * stays a thin shell (test/main/panel-locus.test.ts).
 */

export type PanelLocus = "cloud" | "desktop";

/** Which source a panel opens on. */
export function pickPanelLocus(i: { web: boolean; requested?: PanelLocus | undefined }): PanelLocus {
  if (i.requested === "cloud" || i.requested === "desktop") return i.requested;
  return i.web ? "cloud" : "desktop";
}

/** Only a desktop panel needs the member's machine attached before it tries. */
export function panelNeedsDesktop(locus: PanelLocus): boolean {
  return locus === "desktop";
}

/** The `panel.open` params for a locus — one shape on both sources, the
 *  locus named so the relay never has to guess. */
export function panelOpenParams(locus: PanelLocus, open: { url: string; width: number; height: number; quality: number }): {
  url: string; width: number; height: number; quality: number; locus: PanelLocus;
} {
  return { url: open.url, width: open.width, height: open.height, quality: open.quality, locus };
}

/** The line shown while the socket and the open round-trip. */
export const PANEL_CONNECT_COPY: Readonly<Record<PanelLocus, string>> = {
  cloud: "Starting a cloud browser…",
  desktop: "Connecting to your desktop…",
};

/** The dead ends a streamed panel can hit. */
export type PanelDeadCause =
  | "signed-out"        // no SDK token
  | "desktop-offline"   // desktop locus: the attach check said no machine
  | "connect-failed"    // the relay socket never opened
  | "open-failed"       // panel.open was refused (detail = the server's reason)
  | "dropped"           // the relay socket closed mid-panel
  | "machine-detached"; // the far machine went away (the relay's 4410)

/** The panel state cards (browser-error-page.ts PanelStateKey) this maps onto. */
export type PanelDeadState = "desktop-offline" | "disconnected" | "signed-out" | "failed" | "worker-unavailable";

export interface PanelDeadCard {
  state: PanelDeadState;
  /** A line that replaces the card's default detail, when the cause has one. */
  detail?: string;
}

/** Which card, and what it says, for a dead end on a locus. A cloud panel
 *  never shows a desktop card: its failures are the worker's. */
export function panelDeadCard(locus: PanelLocus, cause: PanelDeadCause, detail?: string): PanelDeadCard {
  if (cause === "signed-out") return { state: "signed-out" };
  if (locus === "desktop") {
    switch (cause) {
      case "desktop-offline": return { state: "desktop-offline" };
      case "connect-failed": return { state: "disconnected" };
      case "open-failed": return detail ? { state: "failed", detail } : { state: "failed" };
      case "dropped": return { state: "disconnected" };
      case "machine-detached": return { state: "disconnected", detail: "Your desktop detached from the server. When it is attached again, try again." };
    }
  }
  switch (cause) {
    case "desktop-offline":   // a cloud panel never asked; treat as a worker fault
    case "connect-failed":
      return { state: "worker-unavailable", detail: "This panel runs on a cloud browser worker, and the connection to the server dropped before one answered. Try again in a moment." };
    case "open-failed":
      return { state: "worker-unavailable", detail: detail ? `This panel runs on a cloud browser worker, which could not open it: ${detail}` : "This panel runs on a cloud browser worker, and none could take it right now. Try again in a moment." };
    case "dropped":
    case "machine-detached":
      return { state: "worker-unavailable", detail: "The cloud browser behind this panel went away. Try again to start a fresh one." };
  }
}
