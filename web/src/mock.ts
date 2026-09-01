// mock.ts — static shapes shared by the mobile app.
//
// This started as the swappable mock seam; the session/loop/model data is now
// SDK-backed (see mobile.tsx). What remains here is the small set of STATIC data
// the UI still consumes: the settings-sheet layout, the agent ghost quotes, and
// the Icon-key / Recent / Message shapes.

// Icon-name keys that used to double as "space" ids. The Chat/Work/Code spaces
// concept is gone — every session is one type now — but these names survive as
// ICON dictionary keys, so the union stays.
export type SpaceId = 'chat' | 'work' | 'code' | 'files' | 'desktop';

/* The signed-in user now comes from the SDK (glyphh().me()); see mobile.tsx. */

/** Settings sheet rows, grouped. `icon` is an Icon name; `value` is the trailing
 *  detail (e.g. the plan). */
export type SettingSub =
  | 'profile' | 'billing' | 'usage' | 'general' | 'apikeys' | 'runtime'
  | 'connections' | 'appearance' | 'help' | 'voice'
  | 'org' | 'members' | 'guardrails' | 'models' | 'workspaces' | 'domains'
  | 'apps' | 'artifacts'   // 'apps' opens the Apps sheet, not a tray; 'org*/models/workspaces' = admin
  | 'padmin-usage' | 'padmin-plans' | 'padmin-orgs';   // super_admin platform section
export interface SettingRow {
  icon: string;
  label: string;
  value?: string;
  sub: SettingSub;
  admin?: boolean;   // org_admin-only (also visible to super_admin)
  super?: boolean;   // super_admin-only (platform administration)
}
export interface SettingGroup {
  label: string;
  rows: SettingRow[];
}
// Reconciled to the real Glyphh domains that the SDK backs today. Notifications /
// Privacy / Shared links / Capabilities / Voice are hidden until they exist
// server+SDK-side. `sub` is the tray key; icon is an Icon name.
export const SETTINGS_GROUPS: SettingGroup[] = [
  { label: 'Account', rows: [
    { icon: 'user', label: 'Profile', sub: 'profile' },
    { icon: 'dollar', label: 'Billing', sub: 'billing' },
    { icon: 'chart', label: 'Usage', sub: 'usage' },
    { icon: 'key', label: 'API keys', sub: 'apikeys' },
    { icon: 'building', label: 'Organization', sub: 'org', admin: true },
    { icon: 'users', label: 'Members', sub: 'members', admin: true },
  ] },
  { label: 'App', rows: [
    { icon: 'cloud', label: 'Runtime', sub: 'runtime' },
    { icon: 'sliders', label: 'General', sub: 'general' },
    { icon: 'voice', label: 'Voice', sub: 'voice' },
    { icon: 'grid', label: 'Connections', sub: 'connections' },
    { icon: 'grid', label: 'Apps', sub: 'apps' },
    { icon: 'filedoc', label: 'Artifacts', sub: 'artifacts' },
    { icon: 'contrast', label: 'Appearance', sub: 'appearance' },
  ] },
  { label: 'Admin', rows: [
    { icon: 'sliders', label: 'Models', sub: 'models', admin: true },
    { icon: 'grid', label: 'Workspaces', sub: 'workspaces', admin: true },
    { icon: 'link', label: 'Domains', sub: 'domains', admin: true },
    { icon: 'shield', label: 'Guardrails', sub: 'guardrails', admin: true },
  ] },
  { label: 'Platform', rows: [
    { icon: 'chart', label: 'Usage', sub: 'padmin-usage', super: true },
    { icon: 'dollar', label: 'Plans', sub: 'padmin-plans', super: true },
    { icon: 'building', label: 'Organizations', sub: 'padmin-orgs', super: true },
  ] },
  { label: 'Support', rows: [
    { icon: 'help', label: 'Help & Support', sub: 'help' },
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

/** A session row in the unified list / rail recents (SDK thread → this shape). */
export interface Recent {
  id: string;
  title: string;
  when: string;
}

/** One turn in the session (agent) view. SDK-backed via session.turn(). */
export interface Message {
  id: string;
  role: 'user' | 'glyphh';
  text: string;
  /** The flat list of tool calls this turn ran (header "Changes" rollup +
   *  working label). Shape mirrors md.tsx's ToolStep. */
  steps?: Array<{ name: string; status: 'running' | 'ok' | 'denied' | 'failed'; thought?: string; title?: string; diff?: string; error?: string }>;
  /** Text + tool-groups in STREAM ORDER, so tool-action rows interleave between
   *  narration blocks. Each 'tools' part shares its step objects with `steps`. */
  parts?: Array<
    | { kind: 'text'; text: string }
    | { kind: 'tools'; steps: Array<{ name: string; status: 'running' | 'ok' | 'denied' | 'failed'; thought?: string; title?: string; diff?: string; error?: string }> }
  >;
  /** Per-turn usage footer: credits (micro) the runtime metered + wall-clock ms. */
  meta?: { creditsMicro?: number; ms?: number };
  /** User turns: image attachment preview URLs (dataURLs), rendered as thumbs. */
  images?: string[];
}
