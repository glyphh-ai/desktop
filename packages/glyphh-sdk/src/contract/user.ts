/**
 * contract/user.ts — the SELF-PROFILE wire shapes. The caller's own editable
 * account view (name + timezone; email is identity and role is read-only). Distinct
 * from `Identity` (contract/auth.ts), which is the minimal authenticated principal.
 */

export interface SelfProfile {
  id: string;
  email: string;
  name: string | null;
  firstName: string;
  lastName: string;
  timezone: string;
  role: string;
  /** The user-set image URL, or null when unset (zero-storage: only the URL is kept). */
  imageUrl: string | null;
  /** The resolved avatar: `imageUrl` when set, else a Gravatar identicon for the email. */
  avatarUrl: string;
}

/** The editable fields. `name` (when given) wins; otherwise first/last are joined. */
export interface SelfProfileUpdate {
  firstName?: string;
  lastName?: string;
  name?: string;
  timezone?: string;
  /** An http(s) URL to use as the avatar, or `null` to clear it (fall back to Gravatar). */
  imageUrl?: string | null;
}
