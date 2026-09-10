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
  | 'profile' | 'billing' | 'org' | 'members' | 'appearance' | 'help'
  | 'padmin-plans' | 'padmin-orgs';

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
    { icon: 'building', label: 'Organization', sub: 'org', admin: true },
    { icon: 'users', label: 'Members', sub: 'members', admin: true },
  ] },
  { label: 'App', rows: [
    { icon: 'contrast', label: 'Appearance', sub: 'appearance' },
  ] },
  { label: 'Platform', rows: [
    { icon: 'dollar', label: 'Plans', sub: 'padmin-plans', super: true },
    { icon: 'building', label: 'Organizations', sub: 'padmin-orgs', super: true },
  ] },
  { label: 'Support', rows: [
    { icon: 'help', label: 'Help & Support', sub: 'help' },
  ] },
];
