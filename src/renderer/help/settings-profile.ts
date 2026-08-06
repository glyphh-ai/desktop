/**
 * settings-profile.ts — Settings › Account, the editable half.
 *
 * Ported from the platform's Settings → Profile page
 * (platform/app/(app)/settings/profile/page.js): first/last name, the avatar
 * image URL, the read-only email + role, and the timezone the server keeps on
 * the user record (users.timezone — the same field the platform edits, and the
 * one Settings › General already wrote through a narrower IPC).
 *
 * Only CHANGED fields are sent, so a save never overwrites something another
 * surface just edited.
 */

import { accountApi, type Profile, type ProfileUpdate } from "./settings-api.js";

/** The last profile the server gave us — the baseline every dirty-check
 *  measures against. Null until the first successful load. */
let saved: Profile | null = null;
let wired = false;
let statusTimer = 0;
let saveTimer = 0;
/** True while hydrate() is writing values in, so its own input events don't
 *  bounce straight back to the server as a "change". */
let hydrating = false;

const $ = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

function field(id: string): HTMLInputElement | null { return $<HTMLInputElement>(id); }

/** The full IANA zone list where the browser supports it; falls back to UTC +
 *  this device's own zone so the control never renders empty. */
function timezoneOptions(): string[] {
  try {
    const all = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
    return all.includes("UTC") ? all : ["UTC", ...all];
  } catch {
    return [...new Set(["UTC", deviceTimezone()])];
  }
}

function deviceTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

/** The one place a save reports itself, now that there's no Save button. */
function setStatus(msg: string, kind: "success" | "error" | ""): void {
  const el = $("profile-status");
  if (!el) return;
  el.textContent = msg;
  el.className = `set-save-state${kind ? ` ${kind}` : ""}`;
  window.clearTimeout(statusTimer);
  if (kind === "success") statusTimer = window.setTimeout(() => { el.textContent = ""; }, 2500);
}

function setError(msg: string): void {
  const el = $("profile-error");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

/** Paint the identity header's avatar from whatever URL is in the box, falling
 *  back to the server's resolved avatar (Gravatar) when the box is empty. The
 *  initials underneath stay put and show through whenever neither resolves —
 *  including when the URL is a dud, which `onerror` catches. */
function paintAvatar(): void {
  const img = $<HTMLImageElement>("profile-avatar");
  if (!img) return;
  const typed = field("profile-image-url")?.value.trim() || "";
  const src = typed || saved?.avatarUrl || "";
  img.classList.toggle("hidden", !src);
  if (src && img.src !== src) img.src = src;
}

/** Initials from the name, else the email's first letter — never empty. */
function paintIdentity(): void {
  const nameEl = $("account-name");
  const initialsEl = $("account-initials");
  const first = (saved?.firstName || "").trim();
  const last = (saved?.lastName || "").trim();
  const full = `${first} ${last}`.trim();
  if (nameEl) nameEl.textContent = full || saved?.email || "—";
  if (initialsEl) {
    const letters = (first.charAt(0) + last.charAt(0)).trim() || (saved?.email || "").charAt(0);
    initialsEl.textContent = letters.toUpperCase() || "—";
  }
}

/** Fill the form from the last-saved profile. Only the initial load calls this
 *  — an auto-save must NOT rewrite the boxes underneath the caret. */
function hydrate(): void {
  if (!saved) return;
  hydrating = true;
  const first = field("profile-first");
  const last = field("profile-last");
  const image = field("profile-image-url");
  const tz = $<HTMLSelectElement>("profile-timezone");
  if (first) first.value = saved.firstName || "";
  if (last) last.value = saved.lastName || "";
  if (image) image.value = saved.imageUrl || "";
  const emailEl = $("profile-email");
  if (emailEl) emailEl.textContent = saved.email || "—";
  const roleEl = $("profile-role");
  if (roleEl) roleEl.textContent = (saved.role || "").replace(/_/g, " ") || "—";
  if (tz) {
    const zone = saved.timezone || "UTC";
    // A zone the browser doesn't enumerate must still be selectable, or saving
    // would silently move the user to another timezone.
    if (!Array.from(tz.options).some((o) => o.value === zone)) {
      const opt = document.createElement("option");
      opt.value = zone;
      opt.textContent = zone.replace(/_/g, " ");
      tz.appendChild(opt);
    }
    tz.value = zone;
  }
  paintAvatar();
  paintIdentity();
  setError("");
  setStatus("", "");
  hydrating = false;
}

/** Only the fields that actually changed — an empty patch means nothing to do. */
function patch(): ProfileUpdate {
  const out: ProfileUpdate = {};
  if (!saved) return out;
  const first = field("profile-first")?.value.trim() ?? "";
  const last = field("profile-last")?.value.trim() ?? "";
  const image = field("profile-image-url")?.value.trim() ?? "";
  const tz = $<HTMLSelectElement>("profile-timezone")?.value || "UTC";
  if (first !== (saved.firstName || "")) out.firstName = first;
  if (last !== (saved.lastName || "")) out.lastName = last;
  if (tz !== (saved.timezone || "UTC")) out.timezone = tz;
  if (image !== (saved.imageUrl || "")) out.imageUrl = image || null;
  return out;
}

async function save(): Promise<void> {
  const first = field("profile-first")?.value.trim() ?? "";
  // An empty first name isn't a failed save, it's an unfinished edit — say so
  // and wait, rather than writing a nameless profile the moment the box clears.
  if (!first) { setError("First name cannot be empty."); setStatus("", ""); return; }
  const body = patch();
  if (!Object.keys(body).length) { setStatus("", ""); return; }

  setError("");
  setStatus("Saving…", "");
  try {
    const res = await accountApi().updateProfile(body);
    if (!res.ok) { setError(res.error); setStatus("Not saved", "error"); return; }
    saved = res.data;
    // The header follows the save; the INPUTS deliberately don't get rewritten,
    // or a keystroke landing mid-flight would be yanked back to the old value.
    paintIdentity();
    paintAvatar();
    setStatus("Saved", "success");
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err));
    setStatus("Not saved", "error");
  }
}

/**
 * Commit after the user stops typing. Every field routes through here, so a
 * burst of keystrokes is one request and a picker change lands right away.
 */
function scheduleSave(delay = 700): void {
  if (hydrating) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => { void save(); }, delay);
}

export function initProfile(): void {
  if (wired) return;
  wired = true;

  const tz = $<HTMLSelectElement>("profile-timezone");
  if (tz) {
    for (const zone of timezoneOptions()) {
      const opt = document.createElement("option");
      opt.value = zone;
      opt.textContent = zone.replace(/_/g, " ");
      tz.appendChild(opt);
    }
  }
  $("profile-tz-browser")?.addEventListener("click", () => {
    const sel = $<HTMLSelectElement>("profile-timezone");
    if (!sel) return;
    const zone = deviceTimezone();
    if (!Array.from(sel.options).some((o) => o.value === zone)) {
      const opt = document.createElement("option");
      opt.value = zone;
      opt.textContent = zone.replace(/_/g, " ");
      sel.appendChild(opt);
    }
    sel.value = zone;
    scheduleSave(0);
  });
  // Typing waits for a pause; picking a zone is a finished decision.
  for (const id of ["profile-first", "profile-last", "profile-image-url"]) {
    field(id)?.addEventListener("input", () => scheduleSave());
    // Leaving a field commits it immediately rather than sitting on the timer.
    field(id)?.addEventListener("blur", () => scheduleSave(0));
  }
  $<HTMLSelectElement>("profile-timezone")?.addEventListener("change", () => scheduleSave(0));
  field("profile-image-url")?.addEventListener("input", paintAvatar);
  // A URL that 404s would otherwise leave a broken-image glyph sitting where
  // the face goes; hiding it lets the initials underneath take over.
  $<HTMLImageElement>("profile-avatar")?.addEventListener("error", () => {
    $("profile-avatar")?.classList.add("hidden");
  });
}

/** Fetch the caller's profile and paint the form. A failure says so — the
 *  fields stay empty rather than showing a blank profile as if it were real. */
export async function loadProfile(): Promise<void> {
  initProfile();
  try {
    saved = await accountApi().profile();
    hydrate();
  } catch (err) {
    setError(`Couldn't load your profile — ${err instanceof Error ? err.message : String(err)}`);
  }
}
