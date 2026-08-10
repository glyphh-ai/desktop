/**
 * settings-runtime.ts — Settings › Runtime (the org's regional runtime + stator).
 *
 * One region choice for the whole org — where sessions run and memory lives.
 * infra() is any-member (reads current region + choice state); chooseInfra is
 * org_admin (a non-admin's 403 is reported inline). Ported from mobile.tsx
 * RuntimeTray. Admin-gating on the nav item is handled in navigation.ts.
 *
 * Transport — web → window.glyphhSdk.org.infra/chooseInfra; desktop →
 * window.glyphh.orgInfraGet/orgChooseInfra IPC (account-ipc.ts).
 */

interface OrgInfra { mode?: string; region: string | null; tier?: string | null; status?: string; regionChosen: boolean; regions: Array<{ id: string; label?: string }> }

interface SdkOrgInfra {
  infra?: () => Promise<OrgInfra>;
  chooseInfra?: (choice: { region: string; tier: string }) => Promise<OrgInfra>;
}
interface DesktopRuntimeIpc {
  orgInfraGet?: () => Promise<OrgInfra>;
  orgChooseInfra?: (choice: { region: string; tier: string }) => Promise<{ ok: boolean; infra?: OrgInfra; error?: string }>;
}

interface RuntimeTransport {
  infra(): Promise<OrgInfra>;
  choose(region: string): Promise<OrgInfra>;
}

const NO_TRANSPORT = "The runtime region isn't available on this build.";
const isWeb = (): boolean => !!(window as unknown as { __GLYPHH_WEB__?: boolean }).__GLYPHH_WEB__;

/** Region label + one-liner (mirrors the mobile tray's REGION_DESC). */
const REGION_LABEL: Record<string, string> = { nam: "North America", eur: "Europe", apac: "Asia-Pacific" };
const REGION_DESC: Record<string, string> = {
  nam: "Shared runtime — the default", eur: "Shared runtime", apac: "Shared runtime",
};
const regionName = (id: string, label?: string): string => label || REGION_LABEL[id] || id.toUpperCase();

function transport(): RuntimeTransport | null {
  if (isWeb()) {
    const o = (window as unknown as { glyphhSdk?: { org?: SdkOrgInfra } }).glyphhSdk?.org;
    if (!o?.infra || !o.chooseInfra) return null;
    return { infra: () => o.infra!(), choose: (region) => o.chooseInfra!({ region, tier: "shared" }) };
  }
  const g = (window as unknown as { glyphh?: DesktopRuntimeIpc }).glyphh;
  if (!g?.orgInfraGet || !g.orgChooseInfra) return null;
  return {
    infra: () => g.orgInfraGet!(),
    choose: async (region) => {
      const r = await g.orgChooseInfra!({ region, tier: "shared" });
      if (!r?.ok || !r.infra) throw new Error(r?.error || "Could not change the region.");
      return r.infra;
    },
  };
}

const $ = (id: string) => document.getElementById(id);
let infra: OrgInfra | null = null;
let busy = "";

function setError(msg: string): void {
  const el = $("runtime-error");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

const TICK_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

function render(): void {
  const host = $("runtime-regions");
  if (!host) return;
  const regions = infra?.regions?.length ? infra.regions : [{ id: "nam", label: "NAM" }];
  const current = infra?.region ?? "nam";
  host.innerHTML = "";
  for (const o of regions) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "set-list-row";
    row.disabled = !!busy;
    const chosen = current === o.id;
    row.innerHTML =
      `<span class="set-list-main"><span class="set-list-name">${regionName(o.id, o.label)}</span><span class="set-list-sub">${REGION_DESC[o.id] || "Shared runtime"}</span></span>` +
      `<span class="set-list-aside">${busy === o.id ? '<span class="set-spinner"></span>' : chosen ? TICK_SVG : ""}</span>`;
    row.addEventListener("click", () => void pick(o.id));
    host.appendChild(row);
  }
}

async function pick(id: string): Promise<void> {
  const current = infra?.region ?? "nam";
  if (busy || current === id) return;
  const t = transport();
  if (!t) { setError(NO_TRANSPORT); return; }
  busy = id; setError(""); render();
  try { infra = await t.choose(id); busy = ""; render(); }
  catch (e) {
    busy = ""; render();
    const msg = (e as Error).message || "";
    setError(/forbidden|403|admin/i.test(msg) ? "Only an org admin can change the region." : "Could not change the region.");
  }
}

export async function loadRuntime(): Promise<void> {
  setError("");
  const t = transport();
  if (!t) { infra = { region: "nam", regionChosen: true, regions: [{ id: "nam", label: "NAM" }] }; render(); setError(NO_TRANSPORT); return; }
  try { infra = await t.infra(); render(); }
  catch {
    // Offline / no-org — fall back to the sole default so the picker still reads.
    infra = { region: "nam", regionChosen: true, regions: [{ id: "nam", label: "NAM" }] };
    render();
  }
}
