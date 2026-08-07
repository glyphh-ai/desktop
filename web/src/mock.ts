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

/** A mock conversation for the session (agent) view. SDK later → session.turn(). */
export interface Message {
  id: string;
  role: 'user' | 'glyphh';
  text: string;
}
export const MESSAGES: Message[] = [
  { id: 'm1', role: 'user', text: 'Build a landing page for a Texas pool supply company.' },
  { id: 'm2', role: 'glyphh', text: 'On it. I’ll scaffold a clean single-page site: a hero with a pool photo and a "Get a free quote" CTA, a products strip (chemicals, pumps, cleaners), a service-area map for South Texas, and a contact form wired to email.' },
  { id: 'm3', role: 'user', text: 'Make the hero headline about crystal-clear water.' },
  { id: 'm4', role: 'glyphh', text: 'Updated the hero to “Crystal-clear water, all season long.” with a subhead on same-day delivery across the Rio Grande Valley. Want me to publish it so you can see it live?' },
  { id: 'm5', role: 'user', text: 'Yes, publish it.' },
];

/** The full session history — shown in the main content when "All Chats" opens.
 *  Mock now; SDK later → glyphh().sessions.list(). */
export const ALL_SESSIONS: Recent[] = [
  { id: 'r1', title: 'Texas pool supply landing page', when: '2 hours ago' },
  { id: 'r2', title: 'Fix the deploy pipeline', when: '5 hours ago' },
  { id: 'r3', title: 'Mobile PWA rail + drawer', when: 'Yesterday' },
  { id: 'r4', title: 'Fly migration cutover plan', when: 'Yesterday' },
  { id: 'r5', title: 'Guardrails firewall wiring', when: '2 days ago' },
  { id: 'r6', title: 'Model catalog redesign', when: '3 days ago' },
  { id: 'r7', title: 'Connector file bridge', when: '5 days ago' },
  { id: 'r8', title: 'Weekend research: HDC memory', when: '1 week ago' },
  { id: 'r9', title: 'Ember palette rollout', when: '1 week ago' },
  { id: 'r10', title: 'WorkOS SSO provisioning', when: '1 week ago' },
  { id: 's11', title: 'Anthropic ↔ OpenAI translator', when: '2 weeks ago' },
  { id: 's12', title: 'rrotor runtime spec', when: '2 weeks ago' },
  { id: 's13', title: 'Attach protocol design', when: '3 weeks ago' },
  { id: 's14', title: 'Guest anonymous model', when: '3 weeks ago' },
  { id: 's15', title: 'Scoped membership + impersonation', when: '3 weeks ago' },
  { id: 's16', title: 'RotorSpec standard draft', when: '1 month ago' },
  { id: 's17', title: 'AdaL memory GTM pivot', when: '1 month ago' },
  { id: 's18', title: 'glyphh-client SDK phases', when: '1 month ago' },
];
