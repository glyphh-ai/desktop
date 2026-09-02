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

import { confirmAction, paginate, renderPaginationBar } from "./shared.js";
import { kebabCell, ROW_MENU_ICONS } from "./lib-editor.js";
import { formModal } from "./settings-list-page.js";
import { accountApi, type Member, type Org, type PendingInvite } from "./settings-api.js";

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
  const invite2 = $<HTMLButtonElement>("members-invite-btn2");
  if (invite2) invite2.disabled = full;
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

const MBR_PAGE_SIZE = 10;
let mbrPage = 0;

async function setDisabled(m: Member, disabled: boolean, toggle: HTMLInputElement): Promise<void> {
  setStatus("Saving…", "");
  const res = await accountApi().setMemberStatus(m.userId, disabled);
  if (!res.ok) {
    toggle.checked = !disabled;   // the row must not claim a state the server refused
    setError(res.error);
    setStatus("Not saved", "error");
    return;
  }
  m.disabled = disabled;
  setError("");
  setStatus(disabled ? "Disabled" : "Enabled", "success");
  paintList();
}

/** View usage → the Dashboard, chart pre-narrowed to this member. */
function viewUsage(m: Member): void {
  try { sessionStorage.setItem("glyphhDashMemberFilter", m.userId); } catch { /* private mode */ }
  document.querySelector<HTMLElement>('.settings-nav-item[data-sub="dash"]')?.click();
}

function paintList(): void {
  const list = $("members-list");
  if (!list) return;
  const rows = visible();
  list.innerHTML = "";
  const pagerHost = $("members-pager");
  if (pagerHost) pagerHost.textContent = "";
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "crud-empty";
    empty.textContent = ($<HTMLInputElement>("members-search")?.value || "").trim()
      ? "No members match your search."
      : "No team members yet — invite someone above.";
    list.appendChild(empty);
    return;
  }

  // The console-style member table (his spec, 2026-08-25): Name (editable),
  // Email, Role, an ENABLED toggle, and the kebab (View usage / Delete…).
  const table = document.createElement("table");
  table.className = "lib-table mbr-table";
  table.innerHTML = `<thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Enabled</th><th class="lib-row-kebab-cell"></th></tr></thead>`;
  const tbody = document.createElement("tbody");

  const pg = paginate(rows, mbrPage, MBR_PAGE_SIZE);
  mbrPage = pg.state.page;
  for (const m of pg.items) {
    const owner = m.role === "org_admin";
    const tr = document.createElement("tr");
    if (m.disabled) tr.classList.add("mbr-disabled");

    const nameTd = document.createElement("td");
    nameTd.className = "lib-table-name";
    const name = document.createElement("input");
    name.className = "settings-input mbr-name";
    name.value = m.name || "";
    name.placeholder = "No name set";
    name.addEventListener("input", () => scheduleName(m.userId, name));
    name.addEventListener("blur", () => { void saveName(m.userId, name); });
    nameTd.appendChild(name);

    const emailTd = document.createElement("td");
    emailTd.className = "lib-table-dim";
    emailTd.textContent = m.email;

    const roleTd = document.createElement("td");
    if (owner) {
      const chip = document.createElement("span");
      chip.className = "acct-chip";
      chip.textContent = roleLabel(m.role);
      roleTd.appendChild(chip);
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
      roleTd.appendChild(select);
    }

    const toggleTd = document.createElement("td");
    if (!owner) {
      const label = document.createElement("label");
      label.className = "settings-toggle mbr-toggle";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = !m.disabled;
      box.addEventListener("change", () => { void setDisabled(m, !box.checked, box); });
      const knob = document.createElement("span");
      knob.className = "toggle-switch";
      label.append(box, knob);
      toggleTd.appendChild(label);
    }

    tr.append(nameTd, emailTd, roleTd, toggleTd);
    if (!owner) {
      tr.appendChild(kebabCell(() => [
        { icon: ROW_MENU_ICONS.view, label: "View usage", onClick: () => viewUsage(m) },
        { icon: ROW_MENU_ICONS.delete, label: "Delete…", danger: true, onClick: () => { void remove(m); } },
      ]));
    } else {
      tr.appendChild(document.createElement("td"));
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  list.appendChild(table);
  if (pagerHost && pg.state.totalPages > 1) {
    pagerHost.appendChild(renderPaginationBar(pg.state, (p) => { mbrPage = p; paintList(); }));
  }
}

/** Invite — the standard validated modal (his spec, 2026-09-01). On success
 *  the accept link stays on screen — the email can fail to arrive (or be
 *  logged rather than sent), and the link is the way through. */
function inviteModal(): void {
  void formModal({
    title: "Invite a member",
    fields: [
      { key: "email", label: "Email", type: "email", placeholder: "colleague@company.com", required: true,
        validate: (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? null : "Enter a valid email address." },
      { key: "role", label: "Role", type: "select", options: [
        { value: "user", label: "User" }, { value: "admin", label: "Admin" },
      ] },
    ],
    submitLabel: "Invite",
    onSubmit: async (v) => {
      const res = await accountApi().inviteMember(v.email!, v.role || "user");
      if (!res.ok) return { ok: false as const, error: res.error };
      setError("");
      setStatus(`Invited ${v.email}`, "success");
      paintInviteLink(res.data?.acceptUrl || "");
      await loadMembers();
      return { ok: true as const };
    },
  });
}

function paintInviteLink(url: string): void {
  const wrap = $("members-invite-link-wrap");
  const field = $<HTMLInputElement>("members-invite-link");
  if (!wrap || !field) return;
  wrap.classList.toggle("hidden", !url);
  field.value = url;
}

// ── The Invited tab: pending (unaccepted) invites ────────────────────────
let invited: PendingInvite[] = [];

function setMembersTab(tab: string): void {
  document.querySelectorAll<HTMLElement>("#members-tabs .app-detail-tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.mtab === tab);
  });
  document.getElementById("members-tab-members")?.classList.toggle("hidden", tab !== "members");
  document.getElementById("members-tab-invited")?.classList.toggle("hidden", tab !== "invited");
}

const INV_PAGE_SIZE = 10;
let invPage = 0;

function paintInvited(): void {
  const host = document.getElementById("members-invited-list");
  if (!host) return;
  host.innerHTML = "";
  const pagerHost = document.getElementById("members-invited-pager");
  if (pagerHost) pagerHost.textContent = "";
  const q = ($<HTMLInputElement>("members-invited-search")?.value || "").trim().toLowerCase();
  const rows = q ? invited.filter((i) => i.email.toLowerCase().includes(q) || (i.invitedByEmail || "").toLowerCase().includes(q)) : invited;
  if (!rows.length) {
    host.innerHTML = `<div class="crud-empty">${q ? "No invites match your search." : "No pending invites — everyone you've invited has joined (or the invites expired)."}</div>`;
    return;
  }
  const table = document.createElement("table");
  table.className = "lib-table";
  table.innerHTML = `<thead><tr><th>Email</th><th>Role</th><th>Invited by</th><th>Expires</th><th class="lib-row-kebab-cell"></th></tr></thead>`;
  const tbody = document.createElement("tbody");
  const day = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const pg = paginate(rows, invPage, INV_PAGE_SIZE);
  invPage = pg.state.page;
  if (pagerHost && pg.state.totalPages > 1) {
    pagerHost.appendChild(renderPaginationBar(pg.state, (p) => { invPage = p; paintInvited(); }));
  }
  for (const inv of pg.items) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td class="lib-table-name"></td>` +
      `<td class="lib-table-desc"></td>` +
      `<td class="lib-table-dim"></td>` +
      `<td class="lib-table-dim">${day(inv.expiresAt)}</td>`;
    (tr.children[0] as HTMLElement).textContent = inv.email;
    (tr.children[1] as HTMLElement).textContent = inv.role === "org_admin" ? "Admin" : "User";
    (tr.children[2] as HTMLElement).textContent = inv.invitedByEmail || "—";
    tr.appendChild(kebabCell(() => [
      { icon: ROW_MENU_ICONS.delete, label: "Revoke invite", danger: true, onClick: () => {
        void (async () => {
          if (!(await confirmAction({ title: `Revoke the invite to ${inv.email}?`, body: "Their invite link stops working immediately.", confirmLabel: "Revoke", danger: true }))) return;
          const r = await accountApi().revokeInvite(inv.id);
          if (r.ok) { invited = invited.filter((x) => x.id !== inv.id); paintInvited(); paintInvitedCount(); }
          else setError(r.error);
        })();
      } },
    ]));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.appendChild(table);
}

/** The tab label carries the pending count so admins see it at a glance. */
function paintInvitedCount(): void {
  const b = document.querySelector<HTMLElement>('#members-tabs .app-detail-tab[data-mtab="invited"]');
  if (b) b.textContent = invited.length ? `Invited (${invited.length})` : "Invited";
}

export function initMembers(): void {
  if (wired) return;
  wired = true;
  document.querySelectorAll<HTMLElement>("#members-tabs .app-detail-tab").forEach((b) => {
    b.addEventListener("click", () => setMembersTab(b.dataset.mtab || "members"));
  });
  $("members-search")?.addEventListener("input", () => { mbrPage = 0; paintList(); });
  $("members-invited-search")?.addEventListener("input", () => { invPage = 0; paintInvited(); });
  $("members-invite-btn")?.addEventListener("click", () => inviteModal());
  $("members-invite-btn2")?.addEventListener("click", () => inviteModal());
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
    if (!role || !["org_admin", "admin", "super_admin"].includes(role)) { showPanel(false); return; }
    showPanel(true);

    const [list, orgRes, invRes] = await Promise.allSettled([accountApi().members(), accountApi().org(), accountApi().pendingInvites()]);
    members = list.status === "fulfilled" ? (list.value || []) : [];
    org = orgRes.status === "fulfilled" ? orgRes.value : null;
    invited = invRes.status === "fulfilled" ? (invRes.value || []) : [];
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
    paintInvited();
    paintInvitedCount();
  } catch (err) {
    setError(`Couldn't load members — ${err instanceof Error ? err.message : String(err)}`);
  }
}
