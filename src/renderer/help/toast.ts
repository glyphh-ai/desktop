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
 * answer is still a modal (confirmAction / confirmChoice), never a toast —
 * with one exception he named (2026-10-05): an app asking to notify the
 * member rides a toast with an Allow action and a "Don't ask me again" box
 * (`check`), where the notification itself would have shown.
 */

export type ToastKind = "ok" | "error" | "info";

export interface ToastOptions {
  kind?: ToastKind;
  /** A second line: the server's own words, a path, a reason. */
  detail?: string;
  /** One action, e.g. "Open" or "Undo". Dismisses the toast when taken. */
  action?: { label: string; onPick: () => void };
  /** A checkbox under the message ("Don't ask me again"); read it with the
   *  handle's `checked()` from the action or from `onDismiss`. */
  check?: { label: string };
  /** The toast went without the action: ✕, its clock, or the stack's cap. */
  onDismiss?: () => void;
  /** Override the default life: ok/info 5s, error 12s. 0 keeps it until dismissed. */
  timeoutMs?: number;
}

export interface ToastHandle {
  update: (message: string, o?: ToastOptions) => void;
  close: () => void;
  /** The `check` box's state (false without one). */
  checked: () => boolean;
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

/** A toast that asked something: told once, the moment it starts going. */
const onGone = new WeakMap<HTMLElement, () => void>();

function dismiss(node: HTMLElement): void {
  if (!node.isConnected || node.dataset.going === "1") return;
  node.dataset.going = "1";
  onGone.get(node)?.();
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
export function toast(message: string, opts: ToastOptions = {}): ToastHandle {
  const kind: ToastKind = opts.kind ?? "info";
  const host = stack();
  const node = document.createElement("div");
  node.className = `toast toast-${kind}`;
  node.innerHTML = `<span class="toast-mark"></span><div class="toast-body"><div class="toast-msg"></div><div class="toast-detail hidden"></div><label class="toast-check hidden"><input type="checkbox" /><span></span></label></div><div class="toast-right"></div>`;
  const markEl = node.querySelector(".toast-mark") as HTMLElement;
  const msgEl = node.querySelector(".toast-msg") as HTMLElement;
  const detailEl = node.querySelector(".toast-detail") as HTMLElement;
  const checkEl = node.querySelector(".toast-check") as HTMLElement;
  const boxEl = checkEl.querySelector("input") as HTMLInputElement;
  const rightEl = node.querySelector(".toast-right") as HTMLElement;
  // The action, once taken, is the answer: a dismissal after it says nothing.
  let answered = false;

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
    (checkEl.querySelector("span") as HTMLElement).textContent = o.check?.label ?? "";
    checkEl.classList.toggle("hidden", !o.check);
    rightEl.textContent = "";
    if (o.action) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "toast-action";
      btn.textContent = o.action.label;
      btn.addEventListener("click", (e) => { e.stopPropagation(); answered = true; o.action?.onPick(); dismiss(node); });
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
  // However it goes — ✕, the clock, the cap, close() — a toast that asked
  // something and got no action tells its caller so, once.
  if (opts.onDismiss) onGone.set(node, () => { if (!answered) { answered = true; opts.onDismiss?.(); } });

  paint(message, opts);
  host.appendChild(node);
  // Newest at the bottom of the stack; the oldest leaves rather than growing
  // a column that covers the window.
  while (host.children.length > MAX_SHOWN) dismiss(host.children[0] as HTMLElement);

  return {
    update: (text: string, o: ToastOptions = {}) => { if (node.isConnected) paint(text, { ...opts, ...o }); },
    close: () => dismiss(node),
    checked: () => boxEl.checked,
  };
}

export const toastOk = (message: string, opts: Omit<ToastOptions, "kind"> = {}): ReturnType<typeof toast> => toast(message, { ...opts, kind: "ok" });
export const toastError = (message: string, opts: Omit<ToastOptions, "kind"> = {}): ReturnType<typeof toast> => toast(message, { ...opts, kind: "error" });
export const toastInfo = (message: string, opts: Omit<ToastOptions, "kind"> = {}): ReturnType<typeof toast> => toast(message, { ...opts, kind: "info" });

/** The workbench bundle can't import help modules; it reaches the same stack
 *  through this, the way it reaches the confirm modal. */
(window as unknown as { __toast?: unknown }).__toast = { toast, ok: toastOk, error: toastError, info: toastInfo };
