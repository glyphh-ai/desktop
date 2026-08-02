/**
 * yo-modal.ts — theme-aware in-app dialogs.
 *
 * Replaces the browser's native `confirm()` / `alert()` (which render as raw OS
 * chrome that ignores the app theme) with a themed modal built from the same
 * CSS variables the rest of the shell uses. Returns a Promise so async click
 * handlers can `await yoConfirm(...)` exactly where they used to call confirm().
 */

export interface YoConfirmOpts {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  /** Style the confirm button as destructive (red) instead of accent. */
  danger?: boolean;
}

/** Themed replacement for window.confirm — resolves true on confirm, false on
 *  cancel / Escape / backdrop click. Only one dialog shows at a time. */
/**
 * Freeze the native app panels (BrowserViews) behind a screenshot and hide
 * them, so a DOM modal — which Electron paints UNDERNEATH BrowserViews — is
 * actually visible and clickable. Returns whether panels were hidden; pass that
 * to `restorePanelsForModal` when the modal closes. Any DOM modal must call
 * this, or it renders behind open app web views.
 */
export async function hidePanelsForModal(): Promise<boolean> {
  const screenshots = document.getElementById("panel-screenshots");
  try {
    const yo = (window as unknown as { glyphh?: {
      capturePanels?: () => Promise<Array<{ dataUrl: string; bounds: { x: number; y: number; width: number; height: number } }>>;
      panelsHide?: () => void;
    } }).glyphh;
    if (!yo?.capturePanels || !yo?.panelsHide || !screenshots) return false;
    const caps = await yo.capturePanels();
    for (const cap of caps) {
      const div = document.createElement("div");
      div.className = "panel-screenshot yo-modal-panel-screenshot";
      div.style.left = `${cap.bounds.x}px`;
      div.style.top = `${cap.bounds.y}px`;
      div.style.width = `${cap.bounds.width}px`;
      div.style.height = `${cap.bounds.height}px`;
      div.style.backgroundImage = `url(${cap.dataUrl})`;
      screenshots.appendChild(div);
    }
    yo.panelsHide();
    return true;
  } catch {
    return false;
  }
}

/** Restore panels + drop the freeze-frames a modal painted on its way in. */
export function restorePanelsForModal(wasHidden: boolean): void {
  if (wasHidden) {
    const yo = (window as unknown as { glyphh?: { panelsShow?: () => void } }).glyphh;
    try { yo?.panelsShow?.(); } catch { /* */ }
  }
  document.getElementById("panel-screenshots")
    ?.querySelectorAll(".yo-modal-panel-screenshot").forEach((el) => el.remove());
}

export function yoConfirm(opts: YoConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => {
    // Guard against stacking — if a dialog is already up, dismiss it first.
    document.querySelectorAll(".yo-modal").forEach((el) => el.remove());

    // Hide BrowserView panels while the modal is up — they render ABOVE
    // the renderer's HTML in Electron, so a DOM modal sits underneath them
    // and the user can't see/click it. Take a freeze-frame screenshot in
    // their place so the workspace doesn't visually disappear.
    let panelsWereHidden = false;
    const screenshots = document.getElementById("panel-screenshots");
    void (async () => {
      try {
        const yo = (window as unknown as { glyphh?: {
          capturePanels?: () => Promise<Array<{ dataUrl: string; bounds: { x: number; y: number; width: number; height: number } }>>;
          panelsHide?: () => void;
        } }).glyphh;
        if (!yo?.capturePanels || !yo?.panelsHide || !screenshots) return;
        const caps = await yo.capturePanels();
        for (const cap of caps) {
          const div = document.createElement("div");
          div.className = "panel-screenshot yo-modal-panel-screenshot";
          div.style.left = `${cap.bounds.x}px`;
          div.style.top = `${cap.bounds.y}px`;
          div.style.width = `${cap.bounds.width}px`;
          div.style.height = `${cap.bounds.height}px`;
          div.style.backgroundImage = `url(${cap.dataUrl})`;
          screenshots.appendChild(div);
        }
        yo.panelsHide();
        panelsWereHidden = true;
      } catch { /* best-effort — modal still shows even if hiding fails */ }
    })();

    const overlay = document.createElement("div");
    overlay.className = "yo-modal";

    const backdrop = document.createElement("div");
    backdrop.className = "yo-modal-backdrop";

    const panel = document.createElement("div");
    panel.className = "yo-modal-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");

    if (opts.title) {
      const title = document.createElement("div");
      title.className = "yo-modal-title";
      title.textContent = opts.title;
      panel.appendChild(title);
    }

    const body = document.createElement("div");
    body.className = "yo-modal-message";
    body.textContent = opts.message;
    panel.appendChild(body);

    const actions = document.createElement("div");
    actions.className = "yo-modal-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "yo-modal-btn yo-modal-btn-cancel";
    cancelBtn.textContent = opts.cancelText ?? "Cancel";

    const confirmBtn = document.createElement("button");
    confirmBtn.className = "yo-modal-btn yo-modal-btn-confirm" + (opts.danger ? " yo-modal-btn-danger" : "");
    confirmBtn.textContent = opts.confirmText ?? "Continue";

    // An explicit empty cancelText makes this an OK-only info dialog (no Cancel).
    if (opts.cancelText !== "") actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    panel.appendChild(actions);

    overlay.appendChild(backdrop);
    overlay.appendChild(panel);

    function close(result: boolean): void {
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      // Restore panels + drop freeze-frames the modal painted on its way in.
      if (panelsWereHidden) {
        const yo = (window as unknown as { glyphh?: { panelsShow?: () => void } }).glyphh;
        try { yo?.panelsShow?.(); } catch { /* */ }
      }
      if (screenshots) {
        screenshots.querySelectorAll(".yo-modal-panel-screenshot").forEach((el) => el.remove());
      }
      resolve(result);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(false); }
      else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); close(true); }
    }

    cancelBtn.addEventListener("click", () => close(false));
    confirmBtn.addEventListener("click", () => close(true));
    backdrop.addEventListener("click", () => close(false));
    document.addEventListener("keydown", onKey, true);

    document.body.appendChild(overlay);
    // Defer focus a tick so the dialog is painted before it grabs focus.
    requestAnimationFrame(() => confirmBtn.focus());
  });
}
