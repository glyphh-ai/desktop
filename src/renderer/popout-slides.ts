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
  icon: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="13" rx="2" style="stroke:#a78bfa"/><polygon points="10 6.5 15 9.5 10 12.5" style="stroke:#8c3bf2;fill:#8c3bf2"/><line x1="12" y1="16" x2="12" y2="20" style="stroke:#a78bfa"/><line x1="8" y1="20" x2="16" y2="20" style="stroke:#a78bfa"/></svg>`,
});

void panel.renderIntoSlot(root as HTMLElement, slot, root as HTMLElement);
