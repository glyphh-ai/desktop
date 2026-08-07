// mock.ts — MOCK data for the mobile app (look + behavior pass).
//
// This is the swappable seam: components consume these shapes, not the SDK.
// The SDK-wiring pass replaces the bodies here (and RECENTS with
// glyphh().sessions.list(), etc.) — the components don't change.

export type SpaceId = 'chat' | 'work' | 'code' | 'files' | 'desktop';

export interface NavItem {
  id: SpaceId;
  label: string;
}

export const NAV: NavItem[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'work', label: 'Work' },
  { id: 'code', label: 'Code' },
  { id: 'files', label: 'Files' },
  { id: 'desktop', label: 'Desktop' },
];

/** Recents = the user's recent CHAT sessions (the ones shown on the main).
 *  Mock now; SDK later (sessions.list / threads). */
export interface Recent {
  id: string;
  title: string;
  when: string;
}

export const RECENTS: Recent[] = [
  { id: 'r1', title: 'Texas pool supply landing page', when: '2h' },
  { id: 'r2', title: 'Fix the deploy pipeline', when: '5h' },
  { id: 'r3', title: 'Mobile PWA rail + drawer', when: 'Yesterday' },
  { id: 'r4', title: 'Fly migration cutover plan', when: 'Yesterday' },
  { id: 'r5', title: 'Guardrails firewall wiring', when: 'Tue' },
  { id: 'r6', title: 'Model catalog redesign', when: 'Mon' },
  { id: 'r7', title: 'Connector file bridge', when: 'Aug 1' },
  { id: 'r8', title: 'Weekend research: HDC memory', when: 'Jul 30' },
];
