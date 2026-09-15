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

/* The region picker is a standard form DROPDOWN (settings grammar), not a
   row-button list — left-aligned like every other field on General. */
function render(): void {
  const sel = $("runtime-region-select") as HTMLSelectElement | null;
  if (!sel) return;
  const regions = infra?.regions?.length ? infra.regions : [{ id: "nam", label: "NAM" }];
  const current = infra?.region ?? "nam";
  sel.innerHTML = "";
  for (const o of regions) {
    const opt = document.createElement("option");
    opt.value = o.id;
    opt.textContent = `${regionName(o.id, o.label)} — ${REGION_DESC[o.id] || "Shared runtime"}`;
    sel.appendChild(opt);
  }
  sel.value = current;
  sel.disabled = !!busy;
  if (!sel.dataset.wired) {
    sel.dataset.wired = "1";
    sel.addEventListener("change", () => void pick(sel.value));
  }
  const st = $("runtime-region-status");
  if (st && busy) { st.textContent = "Saving…"; st.className = "set-save-state"; }
}

async function pick(id: string): Promise<void> {
  const current = infra?.region ?? "nam";
  if (busy || current === id) return;
  const t = transport();
  if (!t) { setError(NO_TRANSPORT); render(); return; }
  busy = id; setError(""); render();
  const st = $("runtime-region-status");
  try {
    infra = await t.choose(id);
    busy = ""; render();
    if (st) {
      st.textContent = "Saved";
      st.className = "set-save-state success";
      setTimeout(() => { st.textContent = ""; }, 1600);
    }
  } catch (e) {
    busy = ""; render();   // render resets the select back to the real current
    if (st) st.textContent = "";
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
