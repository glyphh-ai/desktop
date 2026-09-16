/**
 * wall-tour.ts — the first-run guided tour ON the command center itself.
 *
 * Replaces the old static card tutorial (sections/tutorial.html): instead of
 * five illustrated cards divorced from the product, the tour dims the live
 * wall and points ARROWS at the real controls, in the order a new user should
 * meet them:
 *
 *   1. Connections  — the dock slot: wire Gmail/Slack/Drive first.
 *   2. Add apps     — two arrows: the Marketplace dock slot + a wall tile
 *                     (Design) showing where installed apps land.
 *   3. Workspaces   — two arrows: the Workspaces dock slot + a saved layout
 *                     tile ("click to open").
 *   4. The agent    — the composer: ask it to do anything. Get started.
 *
 * Each card carries a small CSS-drawn mock of the screen behind the arrow —
 * themed, no bitmaps to ship or go stale. Completion persists SERVER-side
 * (`wallTourDone` via /api/me/prefs) so the tour runs once per USER, not per
 * device. Esc or "Skip tour" ends it; every path marks it done.
 */

interface TourAnchor {
  /** CSS selector for the element the arrow lands on. */
  selector: string;
  /** Small label drawn beside the arrowhead. */
  label?: string;
}

interface TourStep {
  title: string;
  copy: string;
  /** Inline HTML for the mock screenshot area (theme-var CSS only). */
  mock: string;
  anchors: TourAnchor[];
  /** Park the card mid-page instead of beside its anchors. */
  center?: boolean;
}

const PREF_KEY = "wallTourDone";
const IS_MAC = /Mac|iP(hone|ad|od)/.test(navigator.platform);

const STEPS: TourStep[] = [
  {
    title: "Make connections",
    copy: "Wire up Gmail, Slack, Drive, GitHub and 3,500+ more. Everything you connect becomes a tool the agent — and your apps — can use.",
    mock: `
      <div class="wtour-mock">
        <div class="wtour-mock-bar"><span></span><span></span><span></span></div>
        <div class="wtour-mock-row"><i class="wtour-dot" style="background:#ea4335"></i><b>Gmail</b><em class="on">Connected</em></div>
        <div class="wtour-mock-row"><i class="wtour-dot" style="background:#611f69"></i><b>Slack</b><em class="on">Connected</em></div>
        <div class="wtour-mock-row"><i class="wtour-dot" style="background:#1a73e8"></i><b>Drive</b><em>Connect</em></div>
      </div>`,
    anchors: [{ selector: '.echo-dock-btn[data-dock="connections"]', label: "Connections" }],
  },
  {
    title: "Add apps",
    copy: "The Marketplace has ready-made apps — and everything you install lands right here on the wall, like Design. The agent can build you new ones.",
    mock: `
      <div class="wtour-mock">
        <div class="wtour-mock-bar"><span></span><span></span><span></span></div>
        <div class="wtour-mock-grid">
          <div class="wtour-mock-app"><i style="background:#e91e8c"></i>Design</div>
          <div class="wtour-mock-app"><i style="background:#8c3bf2"></i>Memory</div>
          <div class="wtour-mock-app"><i style="background:#0891b2"></i>Sheets</div>
          <div class="wtour-mock-app wtour-mock-ghost">+ Install</div>
        </div>
      </div>`,
    anchors: [
      { selector: '.echo-dock-btn[data-dock="marketplace"]', label: "Marketplace" },
    ],
  },
  {
    title: "Workspaces",
    copy: "A workspace arranges apps into one screen — and remembers how you left it. Build your own in Workspaces, or click a saved one to open it.",
    mock: `
      <div class="wtour-mock">
        <div class="wtour-mock-bar"><span></span><span></span><span></span></div>
        <div class="wtour-mock-splits">
          <div style="grid-area:1/1/3/2"></div>
          <div style="grid-area:1/2/2/3"></div>
          <div style="grid-area:2/2/3/3"></div>
        </div>
      </div>`,
    anchors: [
      { selector: '.echo-dock-btn[data-dock="layouts"]', label: "Workspaces" },
      { selector: '.echo-app-btn[data-key^="layout:"]', label: "Click to open" },
    ],
    center: true,
  },
  {
    title: "Open it from anywhere",
    copy: IS_MAC
      ? "In the desktop app, press ⌘⇧Space in any app — Glyphh fronts and the command center opens over whatever you're doing."
      : "In the desktop app, press Ctrl+Shift+Space in any app — Glyphh fronts and the command center opens over whatever you're doing.",
    mock: IS_MAC
      ? `<div class="wtour-mock wtour-mock-keys"><span class="wtour-key">⌘</span><span class="wtour-key">⇧</span><span class="wtour-key wtour-key-wide">Space</span></div>`
      : `<div class="wtour-mock wtour-mock-keys"><span class="wtour-key">Ctrl</span><span class="wtour-key">Shift</span><span class="wtour-key wtour-key-wide">Space</span></div>`,
    anchors: [],
    center: true,
  },
  {
    title: "Ask the agent to do anything",
    copy: "Build an app, wire a report to your inbox, arrange a workspace, automate the boring parts — describe it and the agent does it. This is the whole product; everything above is what it works with.",
    mock: `
      <div class="wtour-mock wtour-mock-agent">
        <div class="wtour-mock-prompt">Build me a CRM from my Gmail contacts…</div>
        <div class="wtour-mock-send">⏎</div>
      </div>`,
    anchors: [{ selector: ".code-input-card, #code-input", label: "Ask anything" }],
  },
];

let running = false;

const yo = (): {
  getPreference?: (k: string, d?: unknown) => Promise<unknown>;
  setPreference?: (k: string, v: unknown) => void;
} => (window as unknown as { glyphh?: Record<string, never> }).glyphh ?? {};

/** Resolve an anchor NOW — visible elements only (a hidden dock slot is no target). */
function resolveAnchor(a: TourAnchor): HTMLElement | null {
  const el = document.querySelector<HTMLElement>(a.selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return null;
  return el;
}

/** Wait until at least the FIRST step's anchor exists (the wall paints async). */
function waitForWall(tries = 40): Promise<boolean> {
  return new Promise((resolve) => {
    const tick = (n: number): void => {
      if (resolveAnchor(STEPS[0]!.anchors[0]!)) { resolve(true); return; }
      if (n <= 0) { resolve(false); return; }
      setTimeout(() => tick(n - 1), 150);
    };
    tick(tries);
  });
}

/**
 * Start the tour if this user has never finished it. Call after the wall has
 * been built + restored; no-ops while a previous invocation is still up.
 */
export async function maybeStartWallTour(): Promise<void> {
  if (running) return;
  try {
    const done = await yo().getPreference?.(PREF_KEY, false);
    if (done) return;
  } catch { return; } // can't read the pref (pre-auth/offline) — never nag blind
  if (!(await waitForWall())) return;
  startWallTour();
}

/** Start unconditionally (the Help menu's "Take the tour" re-entry point). */
export function startWallTour(): void {
  if (running) return;
  running = true;

  const root = document.createElement("div");
  root.className = "wtour";
  root.innerHTML = `
    <svg class="wtour-svg" aria-hidden="true">
      <defs>
        <marker id="wtour-arrowhead" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent, #8c3bf2)"></path>
        </marker>
      </defs>
      <path class="wtour-dim" fill-rule="evenodd"></path>
      <g class="wtour-rings"></g>
      <g class="wtour-arrows"></g>
    </svg>
    <div class="wtour-labels"></div>
    <div class="wtour-card" role="dialog" aria-modal="true">
      <div class="wtour-step-num"></div>
      <h3 class="wtour-title"></h3>
      <p class="wtour-copy"></p>
      <div class="wtour-visual"></div>
      <div class="wtour-foot">
        <button type="button" class="action-btn wtour-skip">Skip tour</button>
        <div class="wtour-dots"></div>
        <div class="wtour-nav">
          <button type="button" class="action-btn wtour-back">Back</button>
          <button type="button" class="action-btn primary wtour-next">Next</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(root);

  const svg = root.querySelector<SVGSVGElement>(".wtour-svg")!;
  const dim = root.querySelector<SVGPathElement>(".wtour-dim")!;
  const rings = root.querySelector<SVGGElement>(".wtour-rings")!;
  const arrows = root.querySelector<SVGGElement>(".wtour-arrows")!;
  const labels = root.querySelector<HTMLElement>(".wtour-labels")!;
  const card = root.querySelector<HTMLElement>(".wtour-card")!;
  let step = 0;

  const rr = (n: number): number => Math.round(n);

  /** One rounded-rect hole, as path segments for the even-odd dim. */
  const hole = (r: DOMRect, pad: number): string => {
    const x = rr(r.left - pad), y = rr(r.top - pad), w = rr(r.width + pad * 2), h = rr(r.height + pad * 2);
    const rad = Math.min(14, w / 2, h / 2);
    const hw = w - rad * 2, vh2 = h - rad * 2;
    return `M${x + rad} ${y} h${hw} a${rad} ${rad} 0 0 1 ${rad} ${rad} v${vh2} a${rad} ${rad} 0 0 1 -${rad} ${rad} h-${hw} a${rad} ${rad} 0 0 1 -${rad} -${rad} v-${vh2} a${rad} ${rad} 0 0 1 ${rad} -${rad} z`;
  };

  const paint = (): void => {
    const s = STEPS[step]!;
    const vw = window.innerWidth, vh = window.innerHeight;
    svg.setAttribute("viewBox", `0 0 ${vw} ${vh}`);
    svg.setAttribute("width", String(vw));
    svg.setAttribute("height", String(vh));

    // Card content first — its rect is where the arrows start from.
    root.querySelector(".wtour-step-num")!.textContent = `${step + 1} / ${STEPS.length}`;
    root.querySelector(".wtour-title")!.textContent = s.title;
    root.querySelector(".wtour-copy")!.textContent = s.copy;
    root.querySelector(".wtour-visual")!.innerHTML = s.mock;
    root.querySelector<HTMLElement>(".wtour-back")!.style.visibility = step === 0 ? "hidden" : "visible";
    root.querySelector(".wtour-next")!.textContent = step === STEPS.length - 1 ? "Get started" : "Next";
    const dots = root.querySelector(".wtour-dots")!;
    dots.innerHTML = STEPS.map((_, i) => `<span class="wtour-dot-nav${i === step ? " active" : ""}"></span>`).join("");

    // Resolve this step's LIVE anchors — a missing one (no layout tile yet,
    // Design filed into a folder) just means one fewer arrow, never a break.
    const found = s.anchors.map((a) => ({ a, el: resolveAnchor(a) })).filter((x) => x.el) as Array<{ a: TourAnchor; el: HTMLElement }>;
    const rects = found.map((f) => f.el.getBoundingClientRect());

    dim.setAttribute("d", `M0 0 H${vw} V${vh} H0 z ` + rects.map((r) => hole(r, 8)).join(" "));
    rings.innerHTML = rects.map((r) => {
      const rad = Math.min(16, (r.width + 16) / 2, (r.height + 16) / 2);
      return `<rect class="wtour-ring" x="${rr(r.left - 8)}" y="${rr(r.top - 8)}" width="${rr(r.width + 16)}" height="${rr(r.height + 16)}" rx="${rr(rad)}"></rect>`;
    }).join("");

    // Park the card NEAR the targets without COVERING any of them — a step
    // about the dock should not point across the whole screen, and a card
    // over the second anchor hides exactly what the arrow introduces. Sit
    // below the LOWEST anchor when the primary is top-half, above the
    // HIGHEST when it is bottom-half; clamped to the viewport either way.
    const prime = rects[0];
    {
      const cw = card.offsetWidth || 460;
      const ch = card.offsetHeight || 320;
      let left: number, top: number;
      if (s.center || !prime) {
        left = Math.max((vw - cw) / 2, 24);
        top = Math.max((vh - ch) / 2, 24);
      } else {
        const cx = rects.reduce((n, r) => n + r.left + r.width / 2, 0) / rects.length;
        left = Math.min(Math.max(cx - cw / 2, 24), vw - cw - 24);
        if (prime.top + prime.height / 2 < vh / 2) {
          const low = Math.max(...rects.map((r) => r.bottom));
          top = Math.min(low + 72, vh - ch - 24);
        } else {
          const high = Math.min(...rects.map((r) => r.top));
          top = Math.max(high - 48 - ch, 24);
        }
      }
      // The clamps can slide the card OVER an anchor (small windows, a
      // target near a corner). Covering the thing an arrow introduces is the
      // one hard failure, so the card gives way — a CENTERED card nudges
      // vertically (staying in the middle, per his call), an anchor-parked
      // card dodges sideways past the offender.
      for (const r of rects) {
        // Corridor = ring + pill + room for a READABLE arrow. A card merely
        // grazing the pill zone hides the arrow behind itself (the SVG paints
        // under the card), which presents as "the second arrow is missing".
        const padT = r.top - 12, padB = r.bottom + 96;
        const overlapsY = top < padB && top + ch > padT;
        const overlapsX = left < r.right + 16 && left + cw > r.left - 16;
        if (!overlapsY || !overlapsX) continue;
        if (s.center || !prime) {
          top = r.top + r.height / 2 < vh / 2
            ? Math.min(padB + 8, vh - ch - 24)
            : Math.max(padT - ch - 8, 24);
        } else {
          const anchorCx = r.left + r.width / 2;
          left = anchorCx < vw / 2
            ? Math.min(r.right + 28, vw - cw - 24)
            : Math.max(r.left - cw - 28, 24);
        }
      }
      card.style.left = `${rr(left)}px`;
      card.style.top = `${rr(top)}px`;
      card.style.bottom = "auto";
      card.style.transform = "none";
    }

    // Arrows: from the card's nearest edge to each hole's nearest edge.
    const c = card.getBoundingClientRect();
    arrows.innerHTML = "";
    labels.innerHTML = "";
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i]!;
      const tx = r.left + r.width / 2;
      const above = r.top + r.height / 2 < c.top;
      const lab = found[i]!.a.label;
      const labTop = above ? r.bottom + 16 : r.top - 42;
      if (lab) {
        const el = document.createElement("div");
        el.className = "wtour-arrow-label";
        el.textContent = lab;
        el.style.left = `${rr(tx)}px`;
        el.style.top = `${rr(labTop)}px`;
        labels.appendChild(el);
      }
      // The arrow lands at the PILL, not on the target edge the pill already
      // occupies. A target beside the card (or too close above/below it for a
      // vertical run to read) is approached from the card's SIDE — an arrow
      // is only ever skipped when start and end practically touch.
      const ty = above ? labTop + 34 : labTop - 8;
      let sx: number, sy: number;
      if (tx > c.right + 16 || tx < c.left - 16
          || (above && c.top - 8 - ty < 36) || (!above && ty - c.bottom - 8 < 36)) {
        sx = tx > (c.left + c.right) / 2 ? c.right + 6 : c.left - 6;
        sy = Math.min(Math.max(ty, c.top + 28), c.bottom - 28);
      } else {
        sx = Math.min(Math.max(tx, c.left + 36), c.right - 36);
        sy = above ? c.top - 8 : c.bottom + 8;
      }
      if (Math.hypot(tx - sx, ty - sy) < 28) continue;
      const mx = (sx + tx) / 2, my = (sy + ty) / 2 + (above ? 24 : -24);
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", `M${rr(sx)} ${rr(sy)} Q${rr(mx)} ${rr(my)} ${rr(tx)} ${rr(ty)}`);
      p.setAttribute("class", "wtour-arrow");
      p.setAttribute("marker-end", "url(#wtour-arrowhead)");
      arrows.appendChild(p);
    }
  };

  // The card's size settles a frame after content lands — paint twice.
  const rePaint = (): void => { paint(); requestAnimationFrame(paint); };

  const finish = (started: boolean): void => {
    running = false;
    window.removeEventListener("resize", rePaint);
    document.removeEventListener("keydown", onKey, true);
    root.remove();
    yo().setPreference?.(PREF_KEY, true);
    if (started) {
      // "Get started" hands the caret to the composer — the next thing a new
      // user does is ASK, and the focus guard keeps it theirs from here.
      (document.getElementById("code-input") as HTMLTextAreaElement | null)?.focus();
    }
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") { e.stopPropagation(); finish(false); }
  };

  root.querySelector(".wtour-skip")!.addEventListener("click", () => finish(false));
  root.querySelector(".wtour-back")!.addEventListener("click", () => { if (step > 0) { step--; rePaint(); } });
  root.querySelector(".wtour-next")!.addEventListener("click", () => {
    if (step < STEPS.length - 1) { step++; rePaint(); } else finish(true);
  });
  window.addEventListener("resize", rePaint);
  document.addEventListener("keydown", onKey, true);
  rePaint();
}
