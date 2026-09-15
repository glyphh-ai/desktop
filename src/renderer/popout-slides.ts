/**
 * popout-slides.ts — the Slides panel standing alone in a popped-out window.
 *
 * Same module as the in-app panel (wb-gpoint), same preload IPC to the org
 * deck library — just a whole window for a body and no rail-slot header
 * (Present lives in the reader bar; presenting goes real fullscreen via the
 * data-gp-popout flag the presenter checks).
 */

import { initGPoint, type GPointSlotState } from "./wb-gpoint.js";
import { yoConfirm } from "./yo-modal.js";

// The main window applies the user's theme as html[data-theme] at boot — this
// window does the same (the page ships data-theme="dark" so there's no white
// flash before the preference answers).
void (window as unknown as { wb?: { getTheme?: () => Promise<string> } }).wb?.getTheme?.()
  .then((t) => { if (t) document.documentElement.setAttribute("data-theme", t); })
  .catch(() => { /* keep the dark default */ });

const params = new URLSearchParams(location.search);
const root = document.getElementById("gp-root")!;
const slot: GPointSlotState = {
  id: 1,
  file: params.get("file") || undefined,
  slideIdx: 0,
};

const panel = initGPoint({
  confirm: (o) => yoConfirm({ title: o.title, message: o.body ?? "", confirmText: o.confirmLabel, danger: o.danger }),
  slotById: (id) => (id === slot.id ? slot : undefined),
  icon: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3.5" width="20" height="13" rx="2.5" style="fill:#af5fff;stroke:none"/><path d="M11 16.5h2v2.2h3.2a.9.9 0 1 1 0 1.8H7.8a.9.9 0 1 1 0-1.8H11z" style="fill:#6d28d9;stroke:none"/><path d="M10 7.2 15.4 10 10 12.8z" style="fill:#ffffff;stroke:none"/></svg>`,
});

void panel.renderIntoSlot(root as HTMLElement, slot, root as HTMLElement);
