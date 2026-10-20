/**
 * pipedream-connect-modal.ts — PIPEDREAM'S CONNECT LINK IN A MODAL (his report,
 * 2026-10-20: a browser panel opened beside Customize sat under it). The
 * sign-in page loads in a webview on Glyphh's own browser session (the
 * persist:yo partition every browser panel shares, so a pipedream.com
 * sign-in carries over), over whatever page is open. Main polls the accounts
 * meanwhile; the modal closes when the account lands, and closing it first
 * cancels the connect.
 */

import { guardWebviewsForModal } from "./shared.js";

let open: { app: string; overlay: HTMLElement; off: (e: KeyboardEvent) => void } | null = null;

/** Show `url` (one app's Connect Link) in the modal; a second call for the
 *  same app keeps the one already up. */
export function openPipedreamConnectModal(app: string, appName: string, url: string): void {
  if (!/^https:\/\//i.test(url)) return;
  if (open?.app === app) return;
  closePipedreamConnectModal();
  const overlay = document.createElement("div");
  overlay.className = "conn-modal pd-connect-modal";
  overlay.innerHTML = `
    <div class="conn-modal-backdrop"></div>
    <div class="conn-modal-panel pd-connect-panel" role="dialog" aria-modal="true">
      <div class="conn-modal-header">
        <h3 class="conn-modal-title"></h3>
        <button type="button" class="conn-modal-close" title="Cancel">✕</button>
      </div>
      <webview class="pd-connect-view" partition="persist:yo"></webview>
    </div>`;
  (overlay.querySelector(".conn-modal-title") as HTMLElement).textContent = `Connect ${appName}`;
  const view = overlay.querySelector(".pd-connect-view") as HTMLElement;
  view.setAttribute("src", url);
  const cancel = (): void => {
    void window.glyphh.pipedreamConnectCancel(app).catch(() => undefined);
    closePipedreamConnectModal();
  };
  overlay.querySelector(".conn-modal-close")?.addEventListener("click", cancel);
  overlay.querySelector(".conn-modal-backdrop")?.addEventListener("click", cancel);
  const off = (e: KeyboardEvent): void => { if (e.key === "Escape") { e.preventDefault(); cancel(); } };
  document.addEventListener("keydown", off);
  document.body.appendChild(overlay);
  guardWebviewsForModal(true);
  open = { app, overlay, off };
}

/** Close the modal (the connect finished, failed or was cancelled). */
export function closePipedreamConnectModal(app?: string): void {
  if (!open || (app && open.app !== app)) return;
  document.removeEventListener("keydown", open.off);
  open.overlay.remove();
  open = null;
  guardWebviewsForModal(false);
}
