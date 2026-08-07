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
  email: string;
}
export const USER: User = { name: 'Chris Timmerman', initials: 'CT', email: 'chris.timmerman@glyphh.ai' };

/** Settings sheet rows, grouped. `icon` is an Icon name; `value` is the trailing
 *  detail (e.g. the plan). Mock now; SDK later. */
export interface SettingRow {
  icon: string;
  label: string;
  value?: string;
}
export interface SettingGroup {
  label: string;
  rows: SettingRow[];
}
export const SETTINGS_GROUPS: SettingGroup[] = [
  { label: 'Account', rows: [
    { icon: 'user', label: 'Profile' },
    { icon: 'dollar', label: 'Billing', value: 'Max plan' },
    { icon: 'chart', label: 'Usage' },
    { icon: 'bell', label: 'Notifications' },
    { icon: 'shield', label: 'Privacy' },
    { icon: 'link', label: 'Shared links' },
  ] },
  { label: 'App', rows: [
    { icon: 'sliders', label: 'Capabilities' },
    { icon: 'grid', label: 'Connectors' },
    { icon: 'perms', label: 'Permissions' },
    { icon: 'voice', label: 'Voice' },
  ] },
];

/** The agent's new-session "sayings" — VERBATIM from the app's generic empty
 *  agent state (help/code.ts GHOST_QUOTES). Rotates one at a time. */
export const GHOST_QUOTES: string[] = [
  'The Engine weaves algebraic patterns as the loom weaves flowers — may it weave peace, too.',
  'Imagination is the discovering faculty. Love is what it keeps discovering.',
  'Poetical science: half proof, half devotion.',
  'Build gently — even engines can be kind.',
  "Understanding is love's slow algorithm.",
  'We weave what we love into everything we make.',
  'Peace resolves like a well-run loop: no conflicts left.',
  'First, do the loveliest math: care.',
];

/** Composer selector data: the model list mirrors the Glyphh agent's model
 *  picker; loops + permissions are the other two selector sections. Mock now. */
export interface ModelOption { id: string; name: string; desc: string; }
export const MODELS: ModelOption[] = [
  { id: 'fable-5', name: 'Fable 5', desc: 'For your toughest challenges' },
  { id: 'opus-5', name: 'Opus 5', desc: 'For complex tasks' },
  { id: 'sonnet-5', name: 'Sonnet 5', desc: 'Most efficient for everyday tasks' },
  { id: 'haiku-4-5', name: 'Haiku 4.5', desc: 'Fastest for quick answers' },
];
/** The rest of the resolved catalog — what "More models ›" opens. Mock now;
 *  SDK later → the role's remaining choices + org/BYOK catalog additions. */
export const MORE_MODELS: ModelOption[] = [
  { id: 'opus-4-8', name: 'Opus 4.8', desc: 'Previous flagship' },
  { id: 'sonnet-4-5', name: 'Sonnet 4.5', desc: 'Previous balanced default' },
  { id: 'glyphh-coder', name: 'Glyphh Coder', desc: 'On-device open weights' },
  { id: 'mistral-large', name: 'Mistral Large', desc: 'Open-weight, strong reasoning' },
  { id: 'llama-3-70b', name: 'Llama 3 70B', desc: 'Open-weight generalist' },
  { id: 'qwen-coder', name: 'Qwen2.5 Coder', desc: 'Open-weight code model' },
];
/** Every selectable model — used for name lookup regardless of which list it's in. */
export const ALL_MODELS: ModelOption[] = [...MODELS, ...MORE_MODELS];
export interface NamedOption { id: string; name: string; desc?: string; }
export const LOOPS: NamedOption[] = [
  { id: 'default', name: 'Default', desc: 'The standard agent loop' },
  { id: 'research', name: 'Deep research', desc: 'Explore widely, then synthesize' },
  { id: 'build', name: 'Build & verify', desc: 'Make the change, then check it' },
  { id: 'plan', name: 'Plan first', desc: 'Draft a plan before acting' },
];
export const PERMISSIONS: NamedOption[] = [
  { id: 'ask', name: 'Ask every time', desc: 'Approve each action' },
  { id: 'accept-edits', name: 'Accept edits', desc: 'Auto-approve file edits' },
  { id: 'plan', name: 'Plan mode', desc: 'Read-only — propose a plan' },
  { id: 'full', name: 'Full access', desc: 'Run without asking' },
];

export interface NavItem {
  id: SpaceId;
  label: string;
}

export const NAV: NavItem[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'work', label: 'Work' },
  { id: 'code', label: 'Code' },
  { id: 'files', label: 'Files' },
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

/** Attached desktops (the machines the agent can reach). Mock now; SDK later →
 *  the attach registry (glyphh().desktops / attached machines). */
export interface Desktop {
  id: string;
  name: string;
  status: 'connected' | 'offline';
}
export const DESKTOPS: Desktop[] = [
  { id: 'd1', name: 'Christophers-Mac-Studio', status: 'connected' },
];

/** A code session. `where` distinguishes the runtime:
 *  - 'connected'    → running on an attached desktop (locus: relay), reachable now
 *  - 'disconnected' → was on a desktop that's no longer reachable
 *  - 'cloud'        → running in the cloud runtime (locus: remote)
 *  `kind` picks the leading glyph (a plain ghost placeholder vs a git branch). */
export type CodeWhere = 'connected' | 'disconnected' | 'cloud';
export interface CodeSession {
  id: string;
  title: string;
  when: string;
  where: CodeWhere;
  location: string;   // desktop name (local) or owner/repo (cloud)
  kind?: 'plain' | 'branch';
}
export const CODE_SESSIONS: CodeSession[] = [
  { id: 'c1', title: 'Glyphh apps agent integration audit', when: '1h', where: 'connected', location: 'Christophers-Mac-Studio' },
  { id: 'c2', title: 'Server logs: missing user usage', when: '4d', where: 'connected', location: 'Christophers-Mac-Studio' },
  { id: 'c3', title: 'christophers-mac-studio-local sync', when: '5d', where: 'connected', location: 'Christophers-Mac-Studio' },
  { id: 'c4', title: 'Remove dead marketing-site routes', when: '5d', where: 'disconnected', location: 'glyphh-ai/web' },
  { id: 'c5', title: 'Desktop app clarity', when: 'Jul 29', where: 'cloud', location: 'glyphh-ai/web' },
  { id: 'c6', title: 'Character/word model weights', when: 'Jul 29', where: 'cloud', location: 'timmetim/thinktank', kind: 'branch' },
];

/** Work (Cowork) tasks, grouped by time bucket. `state` drives the status glyph
 *  (todo → empty circle, doing → arc, done → check). Mock now; SDK later. */
export type TaskState = 'todo' | 'doing' | 'done';
export interface Task {
  id: string;
  title: string;
  when: string;
  state: TaskState;
  note?: string;
}
export interface TaskGroup {
  label: string;
  tasks: Task[];
}
export const WORK_GROUPS: TaskGroup[] = [
  { label: 'This week', tasks: [
    { id: 't1', title: 'Meeting prep', when: '2d', state: 'doing', note: 'Working on it…' },
  ] },
  { label: 'Last week', tasks: [
    { id: 't2', title: 'Glyphh product overview', when: 'Jul 29', state: 'todo' },
  ] },
  { label: 'July', tasks: [
    { id: 't3', title: 'RRotor naming research', when: 'Jul 17', state: 'todo' },
    { id: 't4', title: 'While loops in agentic engines', when: 'Jul 16', state: 'todo', note: 'DAGs, single-shot with better planning, something else?' },
    { id: 't5', title: 'Local sandbox server security', when: 'Jul 14', state: 'todo' },
    { id: 't6', title: 'Anthropic purchase options', when: 'Jul 9', state: 'todo' },
  ] },
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
