/**
 * App-level loading overlay — the standard Glyphh spinner (the same cube that
 * marks a new chat and every other wait) centered over the ENTIRE app,
 * blocking interaction until hidden.
 *
 * One global instance. Use for cross-window handoffs where the whole app is
 * busy — e.g. finishing a Pipedream connection after the OAuth window closes.
 *
 *   showAppOverlay("Finishing slack");   // meta prefix next to the phrases
 *   …
 *   hideAppOverlay();
 */

import { createGlyphhSpinner, type GlyphhSpinner } from "./glyphh-spinner.js";

let overlay: HTMLDivElement | null = null;
let spinner: GlyphhSpinner | null = null;

export function showAppOverlay(meta?: string): void {
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "app-overlay";
    document.body.appendChild(overlay);
  }
  if (!spinner) {
    spinner = createGlyphhSpinner({ size: 56 });
    overlay.appendChild(spinner.el);
  }
  spinner.setMeta(meta || "");
  overlay.classList.add("visible");
}

export function hideAppOverlay(): void {
  spinner?.destroy(); // stops the rAF loop and removes itself
  spinner = null;
  overlay?.classList.remove("visible");
}
