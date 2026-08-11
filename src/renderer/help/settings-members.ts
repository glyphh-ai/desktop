/**
 * settings-members.ts — Settings › Members.
 *
 * Ported from the platform's configure/members page and its data layer
 * (platform/app/lib/members/hooks.js): the roster with self excluded (a UI
 * rule, not a server one), the seat gate, invite-by-email with the shareable
 * accept link, per-member name and system role, and remove.
 *
 * The platform drives edits through two MODALS (invite, edit member). This
 * port has neither: invite is a row that's always there, and a member's name
 * and role are edited in place and save themselves — the same contract as
 * every other field in Settings now.
 *
 * Two columns the platform shows are deliberately absent. `Member` carries no
 * `status` and no `orgRoleId`, so a Status badge would render undefined and an
 * Access-role picker would show the wrong current value while happily moving
 * people between workspaces (the platform's own hook flags this as an sdk-gap).
 * They come back when members.list() returns those fields.
 */

import { confirmAction } from "./shared.js";
import { accountApi, type Member, type Org } from "./settings-api.js";

/** Roles an admin may assign. org_admin is granted by invite, never here. */
const ASSIGNABLE: Array<{ value: string; label: string }> = [
  { value: "user", label: "User" },
  { value: "admin", label: "Admin" },
];

const roleLabel = (r: string): string =>
  r === "org_admin" ? "Org Admin" : r === "admin" ? "Admin" : "User";

let members: Member[] = [];
let org: Org | null = null;
let selfId = "";
let wired = false;
let statusTimer = 0;
const saveTimers = new Map<string, number>();

const $ = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

function setStatus(msg: string, kind: "success" | "error" | ""): void {
  const el = $("members-status");
  if (!el) return;
  el.textContent = msg;
  el.className = `set-save-state${kind ? ` ${kind}` : ""}`;
  window.clearTimeout(statusTimer);
  if (kind === "success") statusTimer = window.setTimeout(() => { el.textContent = ""; }, 2500);
}

function setError(msg: string): void {
  const el = $("members-error");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

/** Everyone but the signed-in admin — you don't manage yourself in this list. */
function visible(): Member[] {
  const q = ($<HTMLInputElement>("members-search")?.value || "").trim().toLowerCase();
  const rest = members.filter((m) => m.userId !== selfId);
  if (!q) return rest;
  return rest.filter((m) => `${m.email} ${m.name || ""}`.toLowerCase().includes(q));
}

function seatsFull(): boolean {
  if (!org) return false;
  return (org.seatsUsed ?? members.length) >= (org.maxSeats ?? 1);
}

/** The seat gate. The server rejects an over-limit invite; say so up front. */
function paintSeats(): void {
  const note = $("members-seat-note");
  if (!note) return;
  const full = seatsFull();
  note.classList.toggle("hidden", !full);
  // ALWAYS reconcile the button with the current seat state — the old one-way
  // disable LATCHED: the first paint (org not loaded yet → reads as full)
  // disabled Invite and nothing ever re-enabled it.
  const invite = $<HTMLButtonElement>("members-invite-btn");
  if (invite) invite.disabled = full;
  if (!full) return;
  note.textContent = (org?.tier || "free") === "free"
    ? "The Free plan is single-seat — change your plan under Billing to invite your team."
    : `All ${org?.maxSeats} seats are in use — change your plan under Billing to add more.`;
}

/** Debounced write for a member's name, keyed per row so two edits can't
 *  cancel each other. */
function scheduleName(userId: string, input: HTMLInputElement): void {
  window.clearTimeout(saveTimers.get(userId));
  saveTimers.set(userId, window.setTimeout(() => { void saveName(userId, input); }, 700));
}

async function saveName(userId: string, input: HTMLInputElement): Promise<void> {
  const member = members.find((m) => m.userId === userId);
  if (!member) return;
  const full = input.value.trim();
  if (full === (member.name || "").trim()) return;
  // The server takes first/last; the roster only carries a display name, so
  // the split is on the first space — everything after it is the last name.
  const cut = full.indexOf(" ");
  const patch = cut === -1
    ? { firstName: full, lastName: "" }
    : { firstName: full.slice(0, cut), lastName: full.slice(cut + 1).trim() };

  setStatus("Saving…", "");
  const res = await accountApi().updateMemberProfile(userId, patch);
  if (!res.ok) { setError(res.error); setStatus("Not saved", "error"); return; }
  member.name = full;
  setError("");
  setStatus("Saved", "success");
}

async function setRole(userId: string, role: string, select: HTMLSelectElement): Promise<void> {
  const member = members.find((m) => m.userId === userId);
  const previous = member?.role || "user";
  setStatus("Saving…", "");
  const res = await accountApi().setMemberRole(userId, role);
  if (!res.ok) {
    select.value = previous;   // the row must not claim a role the server refused
    setError(res.error);
    setStatus("Not saved", "error");
    return;
  }
  if (member) member.role = role;
  setError("");
  setStatus("Saved", "success");
}

async function remove(m: Member): Promise<void> {
  const ok = await confirmAction({
    title: `Remove ${m.name || m.email}?`,
    body: "They lose access to this organization immediately. Their seat frees up.",
    confirmLabel: "Remove",
    danger: true,
  });
  if (!ok) return;
  const res = await accountApi().removeMember(m.userId);
  if (!res.ok) { setError(res.error); return; }
  setError("");
  await loadMembers();
}

function paintList(): void {
  const list = $("members-list");
  if (!list) return;
  const rows = visible();
  list.innerHTML = "";
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "crud-empty";
    empty.textContent = ($<HTMLInputElement>("members-search")?.value || "").trim()
      ? "No members match your search."
      : "No team members yet — invite someone above.";
    list.appendChild(empty);
    return;
  }

  for (const m of rows) {
    const row = document.createElement("div");
    row.className = "mbr-row";
    const owner = m.role === "org_admin";

    const name = document.createElement("input");
    name.className = "settings-input mbr-name";
    name.value = m.name || "";
    name.placeholder = "No name set";
    name.addEventListener("input", () => scheduleName(m.userId, name));
    name.addEventListener("blur", () => { void saveName(m.userId, name); });

    const email = document.createElement("span");
    email.className = "mbr-email";
    email.textContent = m.email;

    const roleCell = document.createElement("span");
    if (owner) {
      // The org admin's role is not ours to change — the server owns it.
      roleCell.className = "acct-chip";
      roleCell.textContent = roleLabel(m.role);
    } else {
      const select = document.createElement("select");
      select.className = "settings-input mbr-role";
      for (const r of ASSIGNABLE) {
        const opt = document.createElement("option");
        opt.value = r.value;
        opt.textContent = r.label;
        select.appendChild(opt);
      }
      select.value = ASSIGNABLE.some((r) => r.value === m.role) ? m.role : "user";
      select.addEventListener("change", () => { void setRole(m.userId, select.value, select); });
      roleCell.appendChild(select);
    }

    row.append(name, email, roleCell);
    if (!owner) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "action-btn danger mbr-remove";
      del.textContent = "Remove";
      del.addEventListener("click", () => { void remove(m); });
      row.appendChild(del);
    } else {
      row.appendChild(document.createElement("span"));
    }
    list.appendChild(row);
  }
}

/** Invite. On success the accept link stays on screen — the email can fail to
 *  arrive (or be logged rather than sent), and the link is the way through. */
async function invite(): Promise<void> {
  const emailEl = $<HTMLInputElement>("members-invite-email");
  const roleEl = $<HTMLSelectElement>("members-invite-role");
  const btn = $<HTMLButtonElement>("members-invite-btn");
  const email = (emailEl?.value || "").trim();
  if (!email) { setError("Email is required."); return; }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { setError("Enter a valid email address."); return; }

  setError("");
  if (btn) btn.disabled = true;
  setStatus("Inviting…", "");
  try {
    const res = await accountApi().inviteMember(email, roleEl?.value || "user");
    if (!res.ok) { setError(res.error); setStatus("", ""); return; }
    if (emailEl) emailEl.value = "";
    setStatus(`Invited ${email}`, "success");
    paintInviteLink(res.data?.acceptUrl || "");
    await loadMembers();
  } finally {
    if (btn) btn.disabled = seatsFull();
  }
}

function paintInviteLink(url: string): void {
  const wrap = $("members-invite-link-wrap");
  const field = $<HTMLInputElement>("members-invite-link");
  if (!wrap || !field) return;
  wrap.classList.toggle("hidden", !url);
  field.value = url;
}

export function initMembers(): void {
  if (wired) return;
  wired = true;
  $("members-search")?.addEventListener("input", paintList);
  $("members-invite-btn")?.addEventListener("click", () => { void invite(); });
  $("members-invite-email")?.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") void invite();
  });
  $("members-invite-link-copy")?.addEventListener("click", () => {
    const field = $<HTMLInputElement>("members-invite-link");
    const btn = $("members-invite-link-copy");
    if (!field?.value || !btn) return;
    void navigator.clipboard.writeText(field.value).then(() => {
      btn.classList.add("copied");
      window.setTimeout(() => btn.classList.remove("copied"), 1400);
    }).catch(() => { /* clipboard denied — the link is selectable */ });
  });
}

/** Show the panel only to an org admin — the same rule the Organization
 *  section uses, and the same rule the server enforces on every write. */
function showPanel(on: boolean): void {
  $("members-admin-only")?.classList.toggle("hidden", on);
  $("members-body")?.classList.toggle("hidden", !on);
  document.querySelector<HTMLElement>('.settings-nav .settings-nav-item[data-sub="members"]')
    ?.classList.toggle("hidden", !on);
}

export async function loadMembers(): Promise<void> {
  initMembers();
  try {
    const account = await window.glyphh.getAccountInfo().catch(() => null);
    selfId = "";
    const role = account?.role || "";
    if (!role || !["org_admin", "super_admin"].includes(role)) { showPanel(false); return; }
    showPanel(true);

    const [list, orgRes] = await Promise.allSettled([accountApi().members(), accountApi().org()]);
    members = list.status === "fulfilled" ? (list.value || []) : [];
    org = orgRes.status === "fulfilled" ? orgRes.value : null;
    // The roster carries no "this is you" flag, so self is matched by the
    // signed-in email — the one identifier both surfaces agree on.
    selfId = members.find((m) => m.email === account?.email)?.userId || "";
    if (list.status === "rejected") {
      setError(`Couldn't load members — ${list.reason instanceof Error ? list.reason.message : String(list.reason)}`);
    } else {
      setError("");
    }
    paintSeats();
    paintList();
  } catch (err) {
    setError(`Couldn't load members — ${err instanceof Error ? err.message : String(err)}`);
  }
}
