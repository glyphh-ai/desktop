/**
 * Dashboard (Home) — the landing section: a welcome, the composer, the
 * starters, the space columns and the recent runs of this machine's
 * schedules (local-library.ts schedule-recent-runs).
 */

import { escapeHtml, paginate, renderPaginationBar } from "./shared.js";
import { seedNewSession, openRunSession, adoptComposer } from "./code.js";
import { SPACE_LABEL, spacePillHtml, type Space } from "./space-meta.js";
import { mascotSvg, type Mascot } from "./mascots.js";
import { openStarterLayout, type STARTER_LAYOUTS } from "./starter-layouts.js";

export function greeting(name: string): string {
  const h = new Date().getHours();
  const part = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  return name ? `${part}, ${name}` : "Welcome back";
}

// ── The glyphh.ai desktop page's hero backdrop, ported VERBATIM from the
// web repo's HeroFlow.js (home-refactor branch): flowing data streams —
// animated dashed bezier strokes converging on the center from both edges,
// bright pulses riding some of them, twinkling scatter clusters at the
// stream ends, and a center vignette. Desktop page config exactly:
// mode "converge", purple/amber/pink colors, seed 2025. The background is
// untouched — this draws over whatever is behind it. Self-stops when the
// landing leaves the screen; restarts on the next load. ──
let particlesRaf = 0;
let particlesVariant = "";
let particlesCleanup: (() => void) | null = null;
// Three surfaces, three orientations of the ONE HeroFlow engine (web's
// DashParticles component, verbatim): Work runs "converge" (streams entering
// from both edges, meeting mid-canvas — purple/amber/pink), Chat runs "fall"
// (the CLI page's cascade, streams falling like terminal output — teal/
// emerald), and Code runs "rise" (streams flowing UP). Code is now the ONE
// session type, so its backdrop must match the SPLASH screen's palette exactly
// (index.template.html COLORS/PULSE — light-purple / purple / pink) rather than
// the old per-space greens.
export type FlowVariant = "cowork" | "chat" | "code";
const FLOW_VARIANTS: Record<FlowVariant, { mode: "converge" | "fall" | "rise"; colors: readonly string[]; pulse: string; seed: number }> = {
  cowork: { mode: "converge", colors: ["179, 107, 251", "245, 158, 11", "236, 72, 153"], pulse: "255, 236, 180", seed: 2025 },
  chat: { mode: "fall", colors: ["94, 234, 212", "52, 211, 153", "179, 107, 251"], pulse: "190, 242, 255", seed: 4242 },
  code: { mode: "rise", colors: ["179, 107, 251", "140, 59, 242", "236, 72, 153"], pulse: "255, 236, 180", seed: 1337 },
};

/** Is the ACTIVE theme light? Read from the theme's own --bg rather than a
 *  theme name, so custom/alt themes classify correctly too. The dark vignette
 *  reads as a dirty grey smudge on a light ground — this guard skips it. */
function isLightTheme(): boolean {
  const bg = (getComputedStyle(document.documentElement).getPropertyValue("--bg") || "").trim();
  const m = /^#([0-9a-f]{3,8})$/i.exec(bg) || /rgba?\(([^)]+)\)/i.exec(bg);
  if (!m) return false;
  let r = 0, g = 0, b = 0;
  if (bg.startsWith("#")) {
    const hex = m[1]!.length === 3 ? m[1]!.split("").map((c) => c + c).join("") : m[1]!.slice(0, 6);
    r = parseInt(hex.slice(0, 2), 16); g = parseInt(hex.slice(2, 4), 16); b = parseInt(hex.slice(4, 6), 16);
  } else {
    const parts = m[1]!.split(",").map((v) => parseFloat(v));
    [r, g, b] = [parts[0] || 0, parts[1] || 0, parts[2] || 0];
  }
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 128;
}

/**
 * Run the HeroFlow engine on ONE canvas for a given variant. Self-contained
 * (own ResizeObserver + RAF), returns a cleanup that stops it. Used by the
 * dashboard singleton (Chat/Work) and the Code landing (its own canvas).
 */
export function runHeroFlow(canvas: HTMLCanvasElement, variantKey: FlowVariant): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => { /* no context — nothing to stop */ };
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const V = FLOW_VARIANTS[variantKey];
  const mode: "converge" | "fall" | "rise" = V.mode;
  const COLORS: readonly string[] = V.colors;
  const PULSE = V.pulse;
  const WHITE = "255, 255, 255";
  const N = 28;
  const SEED = V.seed;
  let raf = 0;

  const mulberry = (seed: number): (() => number) => () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rand = mulberry(SEED);
  interface Scatter { dx: number; dy: number; s: number; a: number; tw: number; tr: number; tint: number }
  interface Stream { y0: number; endX: number; y1: number; mirror: boolean; alpha: number; tint: number; dashSpeed: number; dashPhase: number; pulse: boolean; pSpeed: number; pPhase: number; scatter: Scatter[] }
  const streams: Stream[] = Array.from({ length: N }, (_, i) => {
    const y0 = 0.5 + (rand() - 0.5) * 0.14;
    const endRaw = rand();
    // converge stops mid-canvas so the two sides meet; fall runs most of the way
    const endX = mode === "converge" ? 0.34 + endRaw * 0.28 : 0.42 + endRaw * 0.56;
    const y1 = 0.5 + (rand() - 0.5) * 0.95;
    return {
      y0, endX, y1,
      mirror: mode === "converge" && i % 2 === 1,   // converge: odd streams enter from the far edge
      alpha: 0.12 + rand() * 0.24,
      tint: rand() < 0.72 ? 0 : rand() < 0.6 ? 1 : 2,
      dashSpeed: 0.02 + rand() * 0.05,
      dashPhase: rand() * 40,
      pulse: rand() < 0.5,
      pSpeed: 0.00010 + rand() * 0.00014,
      pPhase: rand(),
      scatter: Array.from({ length: 4 + Math.floor(rand() * 7) }, () => ({
        dx: rand() * 46, dy: (rand() - 0.5) * 26,
        s: 1 + rand() * 2, a: 0.3 + rand() * 0.6,
        tw: rand() * Math.PI * 2, tr: 0.5 + rand() * 1.5,
        tint: rand() < 0.5 ? 0 : rand() < 0.5 ? 2 : 3,
      })),
    };
  });

  let w = 0, h = 0;
  const resize = (): void => {
    const rect = canvas.parentElement?.getBoundingClientRect();
    if (!rect) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = rect.width; h = rect.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const ro = new ResizeObserver(resize);
  if (canvas.parentElement) ro.observe(canvas.parentElement);
  resize();

  type Pt = [number, number];
  // fall cascades top-down; rise flows bottom-up; converge runs edge-inward.
  const mapPt = (S: Stream, run: number, fan: number): Pt =>
    mode === "fall" ? [fan * w, run * h]
      : mode === "rise" ? [fan * w, (1 - run) * h]
      : [S.mirror ? (1 - run) * w : run * w, fan * h];
  const ctrl = (S: Stream): [Pt, Pt, Pt, Pt] => [
    mapPt(S, 0, S.y0),
    mapPt(S, S.endX * 0.42, S.y0),
    mapPt(S, S.endX * 0.72, S.y1),
    mapPt(S, S.endX, S.y1),
  ];
  const pointAt = (P: [Pt, Pt, Pt, Pt], t: number): Pt => {
    const u = 1 - t;
    return [
      u * u * u * P[0][0] + 3 * u * u * t * P[1][0] + 3 * u * t * t * P[2][0] + t * t * t * P[3][0],
      u * u * u * P[0][1] + 3 * u * u * t * P[1][1] + 3 * u * t * t * P[2][1] + t * t * t * P[3][1],
    ];
  };

  const frame = (now: number): void => {
    // Truly removed from the DOM → stop for good + clean up.
    if (!canvas.isConnected) {
      raf = 0;
      ro.disconnect();
      return;
    }
    // Temporarily hidden (an occluding panel, a collapsed/animating layout, a
    // backgrounded tab) or not yet sized → keep the loop ALIVE but skip drawing,
    // so it RESUMES cleanly on re-show instead of FREEZING on a stale, trail-
    // smeared frame (the "locked-up hero" bug). The ResizeObserver stays
    // connected so a resize that happens while hidden still lands.
    if (canvas.offsetParent === null || w === 0 || h === 0) {
      raf = requestAnimationFrame(frame);
      return;
    }
    ctx.clearRect(0, 0, w, h);

    // streams (animated dashes)
    ctx.lineWidth = 1;
    ctx.lineCap = "round";
    for (const S of streams) {
      const P = ctrl(S);
      ctx.setLineDash([2, 5]);
      ctx.lineDashOffset = reduced ? 0 : -(now * S.dashSpeed) - S.dashPhase;
      ctx.strokeStyle = `rgba(${COLORS[S.tint]}, ${S.alpha})`;
      ctx.beginPath();
      ctx.moveTo(P[0][0], P[0][1]);
      ctx.bezierCurveTo(P[1][0], P[1][1], P[2][0], P[2][1], P[3][0], P[3][1]);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // end scatter clusters + pulses (additive glow)
    ctx.globalCompositeOperation = "lighter";
    for (const S of streams) {
      const P = ctrl(S);
      const ex = P[3][0], ey = P[3][1];
      for (const d of S.scatter) {
        const tw = reduced ? 0.8 : 0.45 + 0.55 * Math.sin(now * 0.0018 * d.tr + d.tw);
        const col = d.tint === 3 ? WHITE : COLORS[d.tint];
        // scatter spreads toward the entering edge for converge, along the
        // flow axis for fall/rise.
        const axisSwap = mode === "fall" || mode === "rise";
        const sx = axisSwap ? d.dy : (S.mirror ? -d.dx : d.dx);
        const sy = axisSwap ? d.dx : d.dy;
        ctx.fillStyle = `rgba(${col}, ${d.a * tw})`;
        ctx.beginPath();
        ctx.arc(ex + sx, ey + sy, d.s / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      if (S.pulse && !reduced) {
        const t = (now * S.pSpeed + S.pPhase) % 1;
        const [x, y] = pointAt(P, t);
        const g = Math.sin(t * Math.PI);
        ctx.fillStyle = `rgba(${PULSE}, ${0.9 * g})`;
        ctx.shadowColor = `rgba(${COLORS[S.tint]}, 0.9)`;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(x, y, 1.7, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }
    ctx.globalCompositeOperation = "source-over";

    // Center vignette so the copy stays legible on a DARK ground. On a LIGHT
    // theme it reads as a dirty grey smudge — skip it entirely there.
    if (!isLightTheme()) {
      const vg = ctx.createRadialGradient(w / 2, h * 0.46, 0, w / 2, h * 0.46, h * 0.62);
      vg.addColorStop(0, "rgba(8, 6, 12, 0.6)");
      vg.addColorStop(0.55, "rgba(8, 6, 12, 0.12)");
      vg.addColorStop(1, "rgba(8, 6, 12, 0)");
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, w, h);
    }

    if (reduced) { raf = 0; return; } // one static frame honors reduced-motion
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return () => { if (raf) cancelAnimationFrame(raf); raf = 0; ro.disconnect(); };
}

/** The dashboard's Chat/Work singleton — one HeroFlow on #dash-particles,
 *  variant chosen by the active rail space. */
function startDashParticles(): void {
  const canvas = document.getElementById("dash-particles") as HTMLCanvasElement | null;
  if (!canvas || particlesRaf) return;
  const space = document.body.dataset.railSpace;
  const variantKey: FlowVariant = space === "chat" ? "chat" : space === "code" ? "code" : "cowork";
  particlesVariant = variantKey;
  particlesRaf = 1; // mark running (the engine owns its own RAF handle)
  const stop = runHeroFlow(canvas, variantKey);
  particlesCleanup = () => { stop(); particlesRaf = 0; };
}

/** Code's right column: the user's SESSIONS (pending + recent), newest first —
 *  a click resumes one. Reads the live store via the __agentSessions bridge. */
let sessionsPage = 0;
const SESSIONS_PER_PAGE = 15;

function renderSessionsList(): void {
  const host = document.getElementById("dash-sessions-list");
  if (!host) return;
  const api = (window as unknown as {
    __agentSessions?: { list(): Array<{ id: string; title: string; createdAt: number; mode: string; pinned?: boolean }>; switch(id: string): void };
  }).__agentSessions;
  // The column belongs to the ACTIVE space (Work or Code) — PINNED first, then
  // alphabetical by title, paginated. A click opens that agent.
  const space = document.body.dataset.railSpace === "code" ? "code" : "cowork";
  const all = (api?.list() || []).filter((s2) => s2.mode === space)
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)
      || (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" }));
  const pages = Math.max(1, Math.ceil(all.length / SESSIONS_PER_PAGE));
  if (sessionsPage >= pages) sessionsPage = pages - 1;
  const sessions = all.slice(sessionsPage * SESSIONS_PER_PAGE, (sessionsPage + 1) * SESSIONS_PER_PAGE);
  host.innerHTML = "";
  if (!sessions.length) {
    const empty = document.createElement("div");
    empty.className = "dash-tasks-empty";
    empty.textContent = "No sessions yet — start one below.";
    host.appendChild(empty);
    return;
  }
  for (const sess of sessions) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "dash-rec dash-session-row";
    row.innerHTML = `<span class="dash-rec-ico"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg></span><span class="dash-rec-text"></span><span class="dash-session-when"></span>`;
    (row.querySelector(".dash-rec-text") as HTMLElement).textContent = sess.title || "Untitled session";
    (row.querySelector(".dash-session-when") as HTMLElement).textContent = agoLabel(sess.createdAt);
    row.addEventListener("click", () => api?.switch(sess.id));
    host.appendChild(row);
  }
  if (pages > 1) {
    const pager = document.createElement("div");
    pager.className = "dash-sessions-pager";
    const mk = (label: string, delta: number, disabled: boolean): HTMLButtonElement => {
      const btn = document.createElement("button");
      btn.type = "button"; btn.className = "code-icon-btn"; btn.textContent = label;
      btn.disabled = disabled;
      btn.addEventListener("click", () => { sessionsPage += delta; renderSessionsList(); });
      return btn;
    };
    pager.append(mk("‹", -1, sessionsPage === 0));
    const at = document.createElement("span");
    at.className = "dash-sessions-page-at";
    at.textContent = `${sessionsPage + 1} / ${pages}`;
    pager.append(at, mk("›", 1, sessionsPage >= pages - 1));
    host.appendChild(pager);
  }
}

function agoLabel(ts: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** Paint the landing's two columns. Home is the ONE landing now:
 *  LEFT = CONTINUE (the user's recent sessions), RIGHT = the cross-agent TASKS
 *  list (scheduled-task runs). */
function paintSpaceColumns(): void {
  // The landing's chrome is CSS-driven off body[data-session-space]; keep it
  // correct whenever the landing repaints (boot included).
  (window as unknown as { __syncSpaceAttrs?: () => void }).__syncSpaceAttrs?.();
  // Minimal Home (intro + input only) has no columns — nothing to paint here.
  if (!document.getElementById("dash-tasks-list")) return;
  // RIGHT — TASKS: the scheduled-task runs list, ungated from the old
  // chat-space check (spaces collapsed to one session type).
  document.getElementById("dash-right-label")!.textContent = "Tasks";
  document.getElementById("dash-tasks-list")?.classList.remove("hidden");
  document.getElementById("dash-tasks-search")?.classList.remove("hidden");
  document.getElementById("dash-tasks-pager")?.classList.remove("hidden");
  // LEFT — CONTINUE: the user's recent sessions (was hidden; now the left
  // column). The old "Recommended for you" recs stay hidden — the full-width
  // starter strip above covers that ground.
  document.getElementById("dash-sessions-list")?.classList.remove("hidden");
  sessionsPage = 0;
  renderSessionsList();
  renderRuns();
}

// Switching Chat ↔ Work while the landing is up swaps the flow's orientation
// (fall ↔ converge) — restart the engine with the new variant.
/**
 * Reconcile the landing's flow with the active space. Safe to call on every
 * landing paint — a no-op when the right variant is already running.
 *
 * A space switch made while the landing was COVERED (an open command centre,
 * a card, a populated workbench) used to be dropped on the floor: the handler
 * saw a canvas with no offsetParent and returned, leaving the previous
 * space's engine running against a zero-sized canvas. Coming back via Home
 * then showed a frozen backdrop belonging to the tab you left. Hidden now
 * means TEAR DOWN, so the next paint starts the current variant clean.
 */
export function syncDashParticles(): void {
  const canvas = document.getElementById("dash-particles") as HTMLCanvasElement | null;
  if (!canvas) return;
  const stop = (): void => { particlesCleanup?.(); particlesCleanup = null; particlesVariant = ""; };
  if (canvas.offsetParent === null) { stop(); return; }
  const sp = document.body.dataset.railSpace;
  const want: FlowVariant = sp === "chat" ? "chat" : sp === "code" ? "code" : "cowork";
  if (particlesRaf && want === particlesVariant) return;
  stop();
  startDashParticles();
}

// Switching spaces while the landing is up swaps the flow's orientation
// (fall ↔ converge ↔ rise) — restart the engine with the new variant.
window.addEventListener("rail-space-changed", () => {
  paintSpaceColumns();
  syncDashParticles();
});

// The "Continue" column mirrors the live session store — a new session, a
// rename, a delete, or the store simply arriving after the first paint all
// fire this, so the list populates and stays fresh while Home is up.
window.addEventListener("agent-sessions-changed", () => {
  if (!document.getElementById("dash-sessions-list")?.classList.contains("hidden")) {
    renderSessionsList();
  }
});

export async function loadDashboard(): Promise<void> {
  syncDashParticles();

  // The landing's STRUCTURE never waits on the server: composer adoption,
  // starters, and the space columns paint first — a failed/slow data call only
  // costs the greeting name, not the whole screen (which is exactly what
  // happened on web when the data path threw).
  // RETRY the adoption until the code section has actually built its composer —
  // a straight call silently no-ops when Home paints first.
  const adoptWhenReady = (tries = 0): void => {
    const slot = document.getElementById("dash-composer-slot");
    if (!slot) return;
    if (document.querySelector(".code-composer")) { adoptComposer(slot); return; }
    if (tries < 60) setTimeout(() => adoptWhenReady(tries + 1), 50);
  };
  adoptWhenReady();
  renderStarters();
  paintSpaceColumns();
  void loadRuns();
  paintDashGreeting();
}

// ── Recommended for you: three starters; a click = a fresh session with the
// prompt injected, ready to send. ──
// Per-SPACE prompt sets — the left column must speak the space's language:
// Chat/Work get task prompts, Code gets engineering prompts.
const RECOMMENDATIONS: Array<{ prompt: string; icon: string }> = [
  {
    prompt: "Read my inbox and give me a brief of what actually needs me today",
    icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>`,
  },
  {
    prompt: "Build a slide deck from my Q3 folder in Drive, on our corporate template",
    icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
  },
  {
    prompt: "Set up an agent that digests my email and Slack every morning at 8",
    icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  },
];

// ── Chat landing starters — the front door to ALL THREE spaces ──────────
// Every card names the space it opens into and wears that space's pill, so
// "Research a topic" visibly takes you to Work (it drives NotebookLM over
// RPA, which only Work can do) and "Build an app" takes you to Code. A card
// switches the tab, lands on a fresh session, and seeds the composer — it
// never sends; the user finishes the thought and hits enter.
interface Starter {
  space: Space; title: string; blurb: string; mascot: Mascot;
  /** Plain-English seed — always safe, used when no skill backs the card. */
  seed: string;
  /** The workspace this starter opens into, if any (Chat starters need none). */
  layout?: keyof typeof STARTER_LAYOUTS;
  /** The skill that does this properly — seeded server-side at signup, so
   *  the reference simply resolves. */
  skill?: { slug: string; seed: string };
}
const STARTERS: Starter[] = [
  {
    space: "cowork", title: "Research a topic",
    blurb: "NotebookLM does the digging — sources imported, deck built, findings remembered.",
    seed: "Research this topic end to end and build me a deck on it: ",
    layout: "research",
    skill: { slug: "notebook-research", seed: "/notebook-research " },
    mascot: { name: "Scout", key: "scout", color: "#2dd4bf" },
  },
  {
    space: "code", title: "Build an app",
    blurb: "From one sentence to a running app in your workspace.",
    seed: "Build me an app that ",
    layout: "dev",
    skill: { slug: "build-glyphh-app", seed: "/build-glyphh-app " },
    mascot: { name: "Byte", key: "byte", color: "#a78bfa" },
  },
  {
    space: "cowork", title: "Triage my inbox",
    blurb: "What actually needs you today — and drafts for the easy ones.",
    seed: "Read my inbox and give me a brief of what actually needs me today, with drafts for anything routine.", layout: "email",
    mascot: { name: "Post", key: "post", color: "#fbbf24" },
  },
  {
    space: "code", title: "Fix a bug",
    blurb: "Point at the symptom; the agent reads the folder and lands the fix.",
    seed: "In my working folder, find and fix: ", layout: "dev",
    mascot: { name: "Patch", key: "patch", color: "#fb7185" },
  },
  {
    space: "chat", title: "Explain something",
    blurb: "A straight answer, no tools, no workspace — just the explanation.",
    seed: "Explain, simply and concretely: ",
    mascot: { name: "Sage", key: "sage", color: "#60a5fa" },
  },
  {
    space: "chat", title: "Weigh a decision",
    blurb: "Lay out the options, the trade-offs, and a recommendation.",
    seed: "Help me decide between: ",
    mascot: { name: "Tally", key: "tally", color: "#4ade80" },
  },
];

/** Open the starter's workspace, then seed its prompt. */
async function runStarter(s: Starter): Promise<void> {
  if (s.layout) await openStarterLayout(s.layout);
  seedNewSession(s.skill ? s.skill.seed : s.seed);
}

function renderStarters(): void {
  const host = document.getElementById("dash-starters");
  if (!host || host.childElementCount) return;
  for (const s of STARTERS) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `dash-starter dash-starter-${s.space}`;
    card.innerHTML =
      `<span class="dash-starter-top">` +
      `<span class="dash-starter-title"></span>` +
      spacePillHtml(s.space) +
      `</span>` +
      `<span class="dash-starter-blurb"></span>`;
    card.querySelector(".dash-starter-title")!.textContent = s.title;
    card.querySelector(".dash-starter-blurb")!.textContent = s.blurb;
    card.title = `Opens in ${SPACE_LABEL[s.space]}`;
    card.addEventListener("click", () => { void runStarter(s); });
    host.appendChild(card);
  }
}

const CODE_RECOMMENDATIONS: Array<{ prompt: string; icon: string }> = [
  {
    prompt: "Review my working branch and flag anything risky before I open the PR",
    icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" y1="9" x2="6" y2="21"/></svg>`,
  },
  {
    prompt: "Find and fix the failing tests in this repo",
    icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/></svg>`,
  },
  {
    prompt: "Explain this codebase — architecture, key modules, where things live",
    icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
  },
];

function renderRecommendations(): void {
  const host = document.getElementById("dash-recs");
  if (!host) return;
  host.innerHTML = "";
  const set = document.body.dataset.railSpace === "code" ? CODE_RECOMMENDATIONS : RECOMMENDATIONS;
  for (const rec of set) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "dash-rec";
    row.innerHTML = `<span class="dash-rec-ico">${rec.icon}</span><span class="dash-rec-text">${escapeHtml(rec.prompt)}</span>`;
    row.addEventListener("click", () => seedNewSession(rec.prompt));
    host.appendChild(row);
  }
}

// ── Recent runs: every schedule firing on this machine, newest first. A click
// opens the run as a chat session — the full output, rendered like a turn. ──
interface DashRun {
  runId: string; agentId: string; agentName: string; taskName: string; target: string;
  startedAt: string; durationMs: number | null; status: string; error: string | null; output: string | null;
}

let allRuns: DashRun[] = [];
let runsPage = 0;
const RUNS_PAGE_SIZE = 15;

function renderRuns(): void {
  const listEl = document.getElementById("dash-tasks-list");
  const pagerEl = document.getElementById("dash-tasks-pager");
  const search = (document.getElementById("dash-tasks-search") as HTMLInputElement | null)?.value.trim().toLowerCase() ?? "";
  if (!listEl || !pagerEl) return;

  const filtered = search
    ? allRuns.filter((run) => `${run.taskName} ${run.target} ${run.agentName}`.toLowerCase().includes(search))
    : allRuns;

  listEl.innerHTML = "";
  pagerEl.innerHTML = "";
  if (!allRuns.length) {
    listEl.innerHTML = `<div class="crud-empty">No runs yet — schedule a task and its firings land here.</div>`;
    return;
  }
  if (!filtered.length) {
    listEl.innerHTML = `<div class="crud-empty">No runs matching "${escapeHtml(search)}"</div>`;
    return;
  }

  const { items, state } = paginate(filtered, runsPage, RUNS_PAGE_SIZE);
  runsPage = state.page;
  for (const run of items) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "dash-run-row";
    const when = new Date(run.startedAt).toLocaleString();
    const err = run.status === "error";
    row.innerHTML = `
      <span class="dash-run-task"></span>
      <span class="dash-task-agent"></span>
      <span class="dash-run-when">${escapeHtml(when)}</span>
      <span class="lib-run-badge ${err ? "err" : "ok"}">${err ? "Failed" : "Success"}</span>`;
    row.querySelector(".dash-run-task")!.textContent = run.taskName;
    row.querySelector(".dash-task-agent")!.textContent = run.agentName;
    row.addEventListener("click", () => openRunSession(run));
    listEl.appendChild(row);
  }
  if (state.totalPages > 1) pagerEl.appendChild(renderPaginationBar(state, (p) => { runsPage = p; renderRuns(); }));
}

/** A schedule-recent-runs row (local-library.ts). */
interface LocalRun {
  id: string; scheduleName: string | null; taskSlug: string | null;
  startedAt: string; durationMs: number | null; status: string; error: string | null; output: string | null;
}

async function loadRuns(): Promise<void> {
  const env = await window.glyphh.scheduleRecentRuns?.();
  if (!env?.ok) return;
  allRuns = ((env.data ?? []) as LocalRun[]).map((r) => ({
    runId: r.id, agentId: "", agentName: "Schedule",
    taskName: r.scheduleName || r.taskSlug || "Run", target: r.taskSlug || "",
    startedAt: r.startedAt, durationMs: r.durationMs, status: r.status, error: r.error, output: r.output,
  }));
  runsPage = 0;
  renderRuns();
}

/** "Good afternoon, Chris" — time of day + the local user's first name. */
export function paintDashGreeting(): void {
  const el = document.getElementById("dash-greeting");
  if (!el) return;
  void (async () => {
    let first = "";
    let email = "";
    try {
      const info = await Promise.resolve(window.glyphh.getAccountInfo?.());
      first = (info?.firstName || "").trim();
      email = (info?.email || "").trim();
    } catch { /* fall through */ }
    if (!first && email) {
      // Last resort: the email local part ("chris.timmerman@…" → "Chris") —
      // the greeting always carries a first name.
      const raw = email.split("@")[0]?.split(/[._-]/)[0] || "";
      first = raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "";
    }
    el.textContent = greeting(first);
  })();
}

let wired = false;
export function initDashboardEvents(): void {
  if (wired) return;
  wired = true;

  // The header's primary action is the community (his order, 2026-08-25).
  document.getElementById("dash-discord")?.addEventListener("click", () => {
    // typeof guard: on web window.glyphh is a Proxy that fabricates a FUNCTION
    // for any name — a truthy || would "open" that function, not a URL.
    const raw = (window.glyphh as unknown as { discordInvite?: unknown }).discordInvite;
    window.open(typeof raw === "string" && raw ? raw : "https://discord.gg/P3yynv4v9", "_blank", "noopener");
  });
  paintDashGreeting();
  document.getElementById("dash-tasks-search")?.addEventListener("input", () => { runsPage = 0; renderRuns(); });
}
