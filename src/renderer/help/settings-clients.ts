/**
 * settings-clients.ts — Organization › Clients (his orders, 2026-09-02), on
 * the shared list-page scaffold (settings-list-page.ts) so it is IDENTICAL to
 * every other admin page by construction: search + "+ New client workspace",
 * a lib-table with headers + pagination, and an inline editor a row opens.
 *
 * The agency surface: each client is a full org that spends from THIS org's
 * credit pool up to the MONTHLY LIMIT set here (0 = closed; their own lots
 * drain first). Open hops inside via the active-org switch. Delete DETACHES —
 * the client org lives on, unmanaged and unfunded; nothing is destroyed.
 * Strictly org_admin, like Billing — this page moves money.
 */

import { mountListPage, type ListPageHandle, type EditCtx } from "./settings-list-page.js";

const $ = (id: string) => document.getElementById(id);
const esc = (v: unknown): string =>
  String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmtCredits = (micro: number): string => (micro / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 });

type ClientRow = {
  id: string; name: string; createdAt: string;
  creditsMicro: number; members: number; monthlyCapMicro: number; monthUsedMicro: number;
};

async function openClient(orgId: string, onFail: (msg: string) => void): Promise<void> {
  const sdk = (window as unknown as { glyphhSdk?: { memberships?: { setActiveOrg?: (id: string) => Promise<unknown> } } }).glyphhSdk?.memberships;
  if (!sdk?.setActiveOrg) { onFail("Switching workspaces isn't available here."); return; }
  await sdk.setActiveOrg(orgId);
  location.reload();
}

function renderEdit(c: ClientRow, body: HTMLElement, ctx: EditCtx): void {
  body.innerHTML = `
    <div class="lp-sec">
      <label class="settings-label">Monthly limit</label>
      <p class="section-desc" style="margin:4px 0 8px;">Credits this workspace may spend from your pool per calendar month. 0 closes the gate; their own credits always spend first.</p>
      <input id="cl-edit-cap" class="settings-input" type="number" min="0" step="1" style="max-width:180px;"
             value="${Math.round(c.monthlyCapMicro / 1_000_000)}" />
      <p class="settings-hint" style="margin:8px 0 0;">Used ${fmtCredits(c.monthUsedMicro)} of ${c.monthlyCapMicro > 0 ? fmtCredits(c.monthlyCapMicro) : "0 (closed)"} this month · resets on the 1st.</p>
    </div>
    <div class="lp-sec">
      <label class="settings-label">Workspace</label>
      <p class="settings-hint" style="margin:6px 0 8px;">${c.members} member${c.members === 1 ? "" : "s"} · ${fmtCredits(c.creditsMicro)} own credits · created ${esc(new Date(c.createdAt).toLocaleDateString())}</p>
      <button id="cl-edit-open" class="action-btn" type="button">Open workspace</button>
    </div>`;
  body.querySelector<HTMLButtonElement>("#cl-edit-open")?.addEventListener("click", () => {
    void openClient(c.id, ctx.error);
  });
  ctx.onSave(async () => {
    const raw = Number((body.querySelector("#cl-edit-cap") as HTMLInputElement | null)?.value ?? "0");
    if (!Number.isFinite(raw) || raw < 0) return { ok: false as const, error: "Enter 0 or more credits per month." };
    const r = await window.glyphh.orgClientCap(c.id, raw);
    return r.ok ? { ok: true as const } : { ok: false as const, error: r.error || "Couldn't set the limit." };
  });
}

let handle: ListPageHandle | null = null;

function showPanel(on: boolean): void {
  $("cl-admin-only")?.classList.toggle("hidden", on);
  $("cl-body")?.classList.toggle("hidden", !on);
}

export async function loadClientsPanel(): Promise<void> {
  const account = await window.glyphh.getAccountInfo().catch(() => null);
  const role = account?.role || "";
  const on = ["org_admin", "super_admin"].includes(role);
  showPanel(on);
  document.getElementById("nav-clients")?.classList.toggle("hidden", !on);
  if (!on) return;

  if (!handle) {
    handle = mountListPage<ClientRow>({
      rootId: "cl-root",
      objectName: "client workspace",
      objectPlural: "Clients",
      title: "Clients",
      description: "Workspaces you create for your clients. Each is a full organization — its own apps, members, and data — that spends from <em>your</em> credits up to the monthly limit you set; you invoice them however you like.",
      columns: [
        { header: "Client", cell: (c) => esc(c.name) },
        { header: "Members", cell: (c) => String(c.members), dim: true },
        { header: "This month", cell: (c) => fmtCredits(c.monthUsedMicro), dim: true },
        { header: "Monthly limit", cell: (c) => (c.monthlyCapMicro > 0 ? fmtCredits(c.monthlyCapMicro) : `<span class="lib-badge">Closed</span>`) },
      ],
      rowId: (c) => c.id,
      searchText: (c) => c.name,
      load: async () => {
        const r = await window.glyphh.orgClients();
        if (!r.ok) throw new Error(r.error || "Couldn't load client workspaces.");
        return r.clients;
      },
      newFields: [
        { key: "name", label: "Client name", placeholder: "Dental Office A", required: true },
      ],
      create: async (values) => {
        const r = await window.glyphh.orgClientCreate(values.name!.trim());
        if (!r.ok || !r.id) return { ok: false as const, error: r.error || "Couldn't create the workspace." };
        return {
          ok: true as const,
          row: { id: r.id, name: values.name!.trim(), createdAt: new Date().toISOString(),
                 creditsMicro: 0, members: 1, monthlyCapMicro: 0, monthUsedMicro: 0 },
        };
      },
      editTitle: (c) => c.name,
      editBadge: (c) => (c.monthlyCapMicro > 0 ? `<span class="lib-badge on">Funded</span>` : `<span class="lib-badge">Gate closed</span>`),
      renderEdit,
      remove: async (c) => {
        const r = await window.glyphh.orgClientDetach(c.id);
        return r.ok ? { ok: true as const } : { ok: false as const, error: r.error || "Couldn't detach the client." };
      },
      deleteBody: () => "Detaches the workspace — it keeps existing with its members, apps, and data, but stops spending from your credits. Nothing is destroyed.",
    });
  }
  await handle.reload();
}
