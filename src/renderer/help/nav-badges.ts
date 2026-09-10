/**
 * nav-badges.ts — the red notification counts on nav icons (his rule,
 * 2026-08-20). THE PURGE: the marketplace half died with the storefront;
 * Settings' unread support-case replies remain — computed here (the module
 * with transport access), broadcast as `glyphh:nav-badges`, painted by the
 * command center off the event.
 */

export interface NavBadges { settings: number }

async function settingsCount(): Promise<number> {
  try {
    const sdkSupport = (window as unknown as { glyphhSdk?: { support?: { tickets?: () => Promise<Array<{ unread?: boolean }>> } } }).glyphhSdk?.support;
    const g = (window as unknown as { glyphh?: { supportTickets?: () => Promise<Array<{ unread?: boolean }>> } }).glyphh;
    const tickets = sdkSupport?.tickets ? await sdkSupport.tickets()
      : typeof g?.supportTickets === "function" ? await g.supportTickets()
      : [];
    return (tickets ?? []).filter((t) => t?.unread === true).length;
  } catch { return 0; }
}

let timer = 0;

export async function refreshNavBadges(): Promise<void> {
  const settings = await settingsCount();
  window.dispatchEvent(new CustomEvent<NavBadges>("glyphh:nav-badges", { detail: { settings } }));
}

/** Start the poll: first pass after boot settles, then every 3 minutes.
 *  Anything that changes the counts can call refreshNavBadges() directly. */
export function startNavBadges(): void {
  if (timer) return;
  window.setTimeout(() => void refreshNavBadges(), 6000);
  timer = window.setInterval(() => void refreshNavBadges(), 180_000);
}
