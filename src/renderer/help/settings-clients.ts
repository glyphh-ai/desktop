/**
 * settings-clients.ts — Organization › Clients (his order, 2026-09-02): the
 * agency surface. An org_admin creates client workspaces, funds them from the
 * org's own credits (transfers, never mints — the server refuses a dry
 * parent), and hops inside via the same active-org switch the workspace
 * dropdown uses. Strictly org_admin, like Billing — this page moves money.
 */

import { formModal } from "./settings-list-page.js";

const $ = (id: string) => document.getElementById(id);
const fmtCredits = (micro: number): string => (micro / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 });

let wired = false;

function showPanel(on: boolean): void {
  $("cl-admin-only")?.classList.toggle("hidden", on);
  $("cl-body")?.classList.toggle("hidden", !on);
}

function fail(msg: string): void {
  const el = $("cl-error");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
}

async function openClient(orgId: string): Promise<void> {
  const sdk = (window as unknown as { glyphhSdk?: { memberships?: { setActiveOrg?: (id: string) => Promise<unknown> } } }).glyphhSdk?.memberships;
  if (!sdk?.setActiveOrg) { fail("Switching workspaces isn't available here."); return; }
  await sdk.setActiveOrg(orgId);
  location.reload();
}

async function paint(): Promise<void> {
  const list = $("cl-list");
  if (!list) return;
  const res = await window.glyphh.orgClients();
  if (!res.ok) { fail(res.error || "Couldn't load client workspaces."); return; }
  $("cl-error")?.classList.add("hidden");
  list.innerHTML = "";
  if (!res.clients.length) {
    list.innerHTML = `<div class="crud-empty">No client workspaces yet — create one and it becomes a full organization you run and fund.</div>`;
    return;
  }
  const table = document.createElement("table");
  table.className = "lib-table";
  table.innerHTML = `<thead><tr><th>Client</th><th>Members</th><th>Credits</th><th></th><th></th></tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const c of res.clients) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="lib-table-name"></td>
      <td class="lib-table-dim">${c.members}</td>
      <td class="lib-table-dim">${fmtCredits(c.creditsMicro)}</td>
      <td style="text-align:right;"><button type="button" class="action-btn cl-fund" style="height:26px;font-size:12px;">Add credits</button></td>
      <td style="text-align:right;"><button type="button" class="action-btn primary cl-open" style="height:26px;font-size:12px;">Open</button></td>`;
    (tr.querySelector(".lib-table-name") as HTMLElement).textContent = c.name;
    tr.querySelector(".cl-fund")!.addEventListener("click", () => {
      void formModal({
        title: `Add credits to ${c.name}`,
        fields: [{ key: "credits", label: "Credits", placeholder: "100", required: true,
          validate: (v) => (Number(v) > 0 ? null : "Enter a positive number of credits.") }],
        submitLabel: "Transfer",
        onSubmit: async (values) => {
          const r = await window.glyphh.orgClientFund(c.id, Number(values.credits));
          if (!r.ok) return { ok: false as const, error: r.error || "Couldn't transfer." };
          await paint();
          return { ok: true as const };
        },
      });
    });
    tr.querySelector(".cl-open")!.addEventListener("click", () => void openClient(c.id));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  list.appendChild(table);
}

export async function loadClientsPanel(): Promise<void> {
  const account = await window.glyphh.getAccountInfo().catch(() => null);
  const role = account?.role || "";
  const on = ["org_admin", "super_admin"].includes(role);
  showPanel(on);
  document.getElementById("nav-clients")?.classList.toggle("hidden", !on);
  if (!on) return;
  if (!wired) {
    wired = true;
    $("cl-new-btn")?.addEventListener("click", () => {
      void formModal({
        title: "New client workspace",
        fields: [{ key: "name", label: "Client name", placeholder: "Dental Office A", required: true }],
        submitLabel: "Create",
        onSubmit: async (values) => {
          const r = await window.glyphh.orgClientCreate(values.name!.trim());
          if (!r.ok) return { ok: false as const, error: r.error || "Couldn't create the workspace." };
          await paint();
          return { ok: true as const };
        },
      });
    });
  }
  await paint();
}
