// mock.ts — MOCK data for the mobile app (look + behavior pass).
//
// This is the swappable seam: components consume these shapes, not the SDK.
// The SDK-wiring pass replaces the bodies here (and RECENTS with
// glyphh().sessions.list(), etc.) — the components don't change.

export type SpaceId = 'chat' | 'work' | 'code' | 'files' | 'desktop';

/** The signed-in user (mock; SDK later → glyphh().me()). */
export interface User {
  name: string;
  initials: string;
}
export const USER: User = { name: 'Chris Timmerman', initials: 'CT' };

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
  { id: 'r9', title: 'Ember palette rollout', when: 'Jul 29' },
  { id: 'r10', title: 'WorkOS SSO provisioning', when: 'Jul 28' },
];

/** The full session history — shown in the main content when "All Chats" opens.
 *  Mock now; SDK later → glyphh().sessions.list(). */
export const ALL_SESSIONS: Recent[] = [
  ...RECENTS,
  { id: 's11', title: 'Anthropic ↔ OpenAI translator', when: 'Jul 27' },
  { id: 's12', title: 'rrotor runtime spec', when: 'Jul 26' },
  { id: 's13', title: 'Attach protocol design', when: 'Jul 24' },
  { id: 's14', title: 'Guest anonymous model', when: 'Jul 23' },
  { id: 's15', title: 'Scoped membership + impersonation', when: 'Jul 21' },
  { id: 's16', title: 'RotorSpec standard draft', when: 'Jul 19' },
  { id: 's17', title: 'AdaL memory GTM pivot', when: 'Jul 16' },
  { id: 's18', title: 'glyphh-client SDK phases', when: 'Jul 14' },
];
