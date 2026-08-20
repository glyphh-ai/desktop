/**
 * nav-badges.ts — the red notification counts on nav icons (his rule,
 * 2026-08-20): Marketplace shows pending review activity (a platform admin
 * sees the queue size; an author sees their changes-requested listings), and
 * Settings shows unread support-case replies. Computed here (the modules with
 * transport access), broadcast as `glyphh:nav-badges` — the command center
 * paints dock slots and page tiles off the event.
 */

import { mkt } from "./marketplace-data.js";
import { listingReviewState } from "./marketplace-dev.js";

export interface NavBadges { marketplace: number; settings: number }

async function marketplaceCount(): Promise<number> {
  // Platform admin first: the review queue IS the pending work.
  try {
    const q = await mkt.adminQueue();
    if (Array.isArray(q.releases)) return q.releases.length;
  } catch { /* not an admin — fall through to the author's view */ }
  // Author: listings with changes requested (a ruling waiting on them).
  try {
    const apps = (await mkt.myApps()).apps.filter((a) => a.kind === "glyphh" && a.owned === true).slice(0, 12);
    const states = await Promise.all(apps.map(async (a) => {
      try { return listingReviewState((await mkt.releases(a.slug)).releases); }
      catch { return null; }
    }));
    return states.filter((s) => s?.cls === "rejected").length;
  } catch { return 0; }
}

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
  const [marketplace, settings] = await Promise.all([marketplaceCount(), settingsCount()]);
  window.dispatchEvent(new CustomEvent<NavBadges>("glyphh:nav-badges", { detail: { marketplace, settings } }));
}

/** Start the poll: first pass after boot settles, then every 3 minutes.
 *  Anything that changes the counts can call refreshNavBadges() directly. */
export function startNavBadges(): void {
  if (timer) return;
  window.setTimeout(() => void refreshNavBadges(), 6000);
  timer = window.setInterval(() => void refreshNavBadges(), 180_000);
}
