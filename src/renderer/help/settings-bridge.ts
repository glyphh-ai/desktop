/**
 * Settings → Bridge (his order, 2026-09-21): Bridge Mode's switches, the URL to
 * paste into Claude Desktop, and what the bridge is doing. Main owns the
 * listener; this page only reads its state and flips two server-side
 * preferences. When the organization forces Bridge Mode both switches are on
 * and locked.
 */

type BridgeState = { running: boolean; url: string; port: number; wanted: boolean; forced: boolean; background: boolean; enabled: boolean; member: string | null; sessions: number; clients: number; activity: string[] };
type Doors = {
  bridgeState?: () => Promise<BridgeState>;
  bridgeSetEnabled?: (on: boolean) => Promise<unknown>;
  bridgeSetBackground?: (on: boolean) => Promise<unknown>;
};

const el = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;
let poll: number | null = null;

function paint(st: BridgeState): void {
  const enabled = el<HTMLInputElement>("toggle-bridge-enabled");
  const background = el<HTMLInputElement>("toggle-bridge-background");
  if (enabled) { enabled.checked = st.forced || st.enabled; enabled.disabled = st.forced; }
  if (background) { background.checked = st.background; background.disabled = st.forced || !(st.forced || st.enabled); }
  const desc = el("bridge-enabled-desc");
  if (desc) desc.textContent = st.forced ? "Required by your organization." : st.enabled ? "On. The bridge runs whenever you are signed in." : "Off. Turn it on to run the bridge whenever you are signed in.";
  el("bridge-forced-note")?.style.setProperty("display", st.forced ? "" : "none");
  const url = el("bridge-url");
  if (url) url.textContent = st.url;
  const status = el("bridge-status");
  if (status) {
    status.textContent = !st.running
      ? (st.wanted ? "Starting…" : "Not running.")
      : `Listening on ${st.url}${st.member ? ` as ${st.member}` : ""} · ${st.clients} client${st.clients === 1 ? "" : "s"} connected · ${st.sessions} Claude session${st.sessions === 1 ? "" : "s"}.`;
  }
  const log = el("bridge-activity");
  if (log) log.textContent = st.activity.slice(-60).join("\n");
}

export async function loadBridgeSettings(): Promise<void> {
  const g = window.glyphh as unknown as Doors;
  if (!g.bridgeState) return;
  const refresh = async () => { try { paint(await g.bridgeState!()); } catch { /* main away */ } };
  await refresh();
  const enabled = el<HTMLInputElement>("toggle-bridge-enabled");
  if (enabled) enabled.onchange = () => { void g.bridgeSetEnabled?.(enabled.checked).then(refresh); };
  const background = el<HTMLInputElement>("toggle-bridge-background");
  if (background) background.onchange = () => { void g.bridgeSetBackground?.(background.checked).then(refresh); };
  const copy = el<HTMLButtonElement>("bridge-copy-url");
  if (copy) copy.onclick = () => { void navigator.clipboard.writeText(el("bridge-url")?.textContent ?? ""); copy.textContent = "Copied"; window.setTimeout(() => { copy.textContent = "Copy URL"; }, 1500); };
  const open = el<HTMLButtonElement>("bridge-open-tui");
  if (open) open.onclick = () => { void (window as unknown as { __wbOpenBridgeTui?: () => Promise<void> }).__wbOpenBridgeTui?.(); };
  if (poll) window.clearInterval(poll);
  poll = window.setInterval(() => {
    const panel = document.querySelector<HTMLElement>('.settings-panel[data-sub="bridge"]');
    if (!panel || panel.offsetParent === null) { if (poll) window.clearInterval(poll); poll = null; return; }
    void refresh();
  }, 3000);
}
