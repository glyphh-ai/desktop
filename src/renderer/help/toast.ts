/**
 * toast.ts — THE app's notifications (his order, 2026-09-17).
 *
 * Installing a skill said nothing anywhere, and every page had invented its
 * own inline banner in its own corner: skills reused its error row for good
 * news, schedules and connections had error divs that never spoke on success.
 * One stack, top right, above everything including the settings overlay.
 *
 * The look is the house toast the downloader and the updater already wear
 * (--toast-bg, the accent hairline, toast-in) so nothing here is a new visual
 * language — only a new position and a stack.
 *
 * Use it for what just happened: `toastOk("Design installed")`,
 * `toastError("Couldn't install that", detail)`. Anything that needs an
 * answer is still a modal (confirmAction / confirmChoice), never a toast.
 */

export type ToastKind = "ok" | "error" | "info";

export interface ToastOptions {
  kind?: ToastKind;
  /** A second line: the server's own words, a path, a reason. */
  detail?: string;
  /** One action, e.g. "Open" or "Undo". Dismisses the toast when taken. */
  action?: { label: string; onPick: () => void };
  /** Override the default life: ok/info 5s, error 12s. 0 keeps it until dismissed. */
  timeoutMs?: number;
}

const STACK_ID = "toast-stack";
const LIFE: Record<ToastKind, number> = { ok: 5000, error: 12000, info: 6000 };
const MAX_SHOWN = 4;

const MARK: Record<ToastKind, string> = {
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5"/><path d="M12 16.5v.5"/><circle cx="12" cy="12" r="9"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.5v.5"/></svg>',
};

/** The stack lives on <body>: the settings modal is body-mounted too, and a
 *  toast inside any panel would be capped by that panel's stacking context. */
function stack(): HTMLElement {
  let host = document.getElementById(STACK_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = STACK_ID;
    host.setAttribute("role", "status");
    host.setAttribute("aria-live", "polite");
    document.body.appendChild(host);
  } else if (host.parentElement !== document.body) {
    document.body.appendChild(host);
  }
  return host;
}

function dismiss(node: HTMLElement): void {
  if (!node.isConnected || node.dataset.going === "1") return;
  node.dataset.going = "1";
  node.classList.add("going");
  const done = (): void => node.remove();
  node.addEventListener("animationend", done, { once: true });
  // Animation disabled (reduced motion, a hidden window): never leave it up.
  window.setTimeout(done, 400);
}

/**
 * Say what just happened. Returns a handle so a long job can update its own
 * line ("Installing…" → "Installed") instead of stacking two toasts.
 */
export function toast(message: string, opts: ToastOptions = {}): { update: (message: string, o?: ToastOptions) => void; close: () => void } {
  const kind: ToastKind = opts.kind ?? "info";
  const host = stack();
  const node = document.createElement("div");
  node.className = `toast toast-${kind}`;
  node.innerHTML = `<span class="toast-mark"></span><div class="toast-body"><div class="toast-msg"></div><div class="toast-detail hidden"></div></div><div class="toast-right"></div>`;
  const markEl = node.querySelector(".toast-mark") as HTMLElement;
  const msgEl = node.querySelector(".toast-msg") as HTMLElement;
  const detailEl = node.querySelector(".toast-detail") as HTMLElement;
  const rightEl = node.querySelector(".toast-right") as HTMLElement;

  let timer = 0;
  const arm = (ms: number): void => {
    window.clearTimeout(timer);
    if (ms > 0) timer = window.setTimeout(() => dismiss(node), ms);
  };
  const paint = (text: string, o: ToastOptions): void => {
    const k: ToastKind = o.kind ?? kind;
    node.className = `toast toast-${k}${node.dataset.going === "1" ? " going" : ""}`;
    markEl.innerHTML = MARK[k];
    msgEl.textContent = text;
    detailEl.textContent = o.detail ?? "";
    detailEl.classList.toggle("hidden", !o.detail);
    rightEl.textContent = "";
    if (o.action) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "toast-action";
      btn.textContent = o.action.label;
      btn.addEventListener("click", (e) => { e.stopPropagation(); o.action?.onPick(); dismiss(node); });
      rightEl.appendChild(btn);
    }
    const x = document.createElement("button");
    x.type = "button";
    x.className = "toast-x";
    x.title = "Dismiss";
    x.setAttribute("aria-label", "Dismiss");
    x.textContent = "✕";
    x.addEventListener("click", (e) => { e.stopPropagation(); dismiss(node); });
    rightEl.appendChild(x);
    arm(o.timeoutMs ?? LIFE[k]);
  };

  // Reading it is not dismissing it: the clock stops while the pointer is on it.
  node.addEventListener("mouseenter", () => window.clearTimeout(timer));
  node.addEventListener("mouseleave", () => arm(opts.timeoutMs ?? LIFE[kind]));

  paint(message, opts);
  host.appendChild(node);
  // Newest at the bottom of the stack; the oldest leaves rather than growing
  // a column that covers the window.
  while (host.children.length > MAX_SHOWN) dismiss(host.children[0] as HTMLElement);

  return {
    update: (text: string, o: ToastOptions = {}) => { if (node.isConnected) paint(text, { ...opts, ...o }); },
    close: () => dismiss(node),
  };
}

export const toastOk = (message: string, opts: Omit<ToastOptions, "kind"> = {}): ReturnType<typeof toast> => toast(message, { ...opts, kind: "ok" });
export const toastError = (message: string, opts: Omit<ToastOptions, "kind"> = {}): ReturnType<typeof toast> => toast(message, { ...opts, kind: "error" });
export const toastInfo = (message: string, opts: Omit<ToastOptions, "kind"> = {}): ReturnType<typeof toast> => toast(message, { ...opts, kind: "info" });

/** The workbench bundle can't import help modules; it reaches the same stack
 *  through this, the way it reaches the confirm modal. */
(window as unknown as { __toast?: unknown }).__toast = { toast, ok: toastOk, error: toastError, info: toastInfo };
