/**
 * Glyphh spinner — the app's working indicator.
 *
 * A transparent wireframe cube tumbles through 3D, shedding tiny particles:
 * mostly theme-colored, with random flashes of accent purple and — rarer
 * still — confetti. Beside it a working phrase types itself out quickly.
 * Every 5 seconds the phrase rotates and the cube changes tumble direction
 * (eased, with a little particle burst to mark the beat).
 *
 * Theme-controllable: the cube + particles draw with the element's computed
 * `color` (white in dark themes, near-black in light — override with CSS),
 * and the purple flashes read `--accent` live.
 *
 * Usage:
 *   const s = createGlyphhSpinner();
 *   host.appendChild(s.el);
 *   …
 *   s.destroy();
 *
 * The loop self-stops if the element leaves the DOM (a re-render dropped
 * it), so a forgotten instance can't leak a rAF loop.
 */

export interface GlyphhSpinner { el: HTMLElement; destroy: () => void }

const PHRASES = [
  "Glyphhing…", "Twiddling…", "Noodling…", "Conjuring…", "Brewing…",
  "Weaving…", "Dreaming in glyphs…", "Sprinkling love…", "Braiding bits…",
  "Polishing pixels…", "Humming along…", "Summoning sparks…",
  "Untangling threads…", "Stitching starlight…", "Folding space…",
  "Counting fireflies…", "Charming electrons…", "Percolating…",
  "Doodling in the margins…", "Whistling to the wires…", "Tending the loom…",
  "Chasing semicolons…", "Warming the cube…", "Peace, love & glyphhs…",
  "Wooing the pixels…", "Composing tiny magic…", "Skipping stones on data…",
  "Growing ideas…", "Tickling the machine…", "Painting with logic…",
];

const CONFETTI = ["#ff5f56", "#ffbd2e", "#27c93f", "#4fc3f7", "#ff6ec7", "#ffd166", "#9b5de5"];

interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; max: number; size: number; color: string;
}

export function createGlyphhSpinner(opts?: { size?: number; phrases?: boolean }): GlyphhSpinner {
  const size = opts?.size ?? 44;
  const showPhrases = opts?.phrases !== false;
  const root = document.createElement("span");
  root.className = "glyphh-spinner";
  const canvas = document.createElement("canvas");
  canvas.className = "gs-cube";
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  root.appendChild(canvas);
  const phraseEl = document.createElement("span");
  phraseEl.className = "gs-phrase";
  if (showPhrases) root.appendChild(phraseEl);
  const ctx = canvas.getContext("2d")!;

  // ── Cube geometry ──
  const s = size * 0.21; // half-edge (CSS px)
  const V: Array<[number, number, number]> = [];
  for (const x of [-s, s]) for (const y of [-s, s]) for (const z of [-s, s]) V.push([x, y, z]);
  const E = [[0, 1], [0, 2], [1, 3], [2, 3], [4, 5], [4, 6], [5, 7], [6, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  let ax = Math.random() * Math.PI, ay = Math.random() * Math.PI, az = Math.random() * Math.PI;
  const rnd = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
  const spin = () => {
    const sgn = () => (Math.random() < 0.5 ? -1 : 1);
    return { x: sgn() * rnd(0.006, 0.026), y: sgn() * rnd(0.006, 0.026), z: sgn() * rnd(0.003, 0.018) };
  };
  let vel = spin();    // current angular velocity
  let target = vel;    // eased toward on each beat

  // ── Colors follow the theme (re-read on every beat) ──
  let wire = "#ffffff";
  let accent = "#8c3bf2";
  const readColors = () => {
    try {
      wire = getComputedStyle(root).color || wire;
      accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || accent;
    } catch { /* detached — keep last */ }
  };

  // ── Particles ──
  const parts: Particle[] = [];
  const pickColor = () => {
    const r = Math.random();
    if (r < 0.015) return CONFETTI[Math.floor(Math.random() * CONFETTI.length)];
    if (r < 0.09) return accent;
    return wire;
  };

  // ── Phrase typing ──
  let typeTimer: ReturnType<typeof setInterval> | null = null;
  let lastIdx = -1;
  const typePhrase = () => {
    if (!showPhrases) return;
    let i = lastIdx;
    while (i === lastIdx) i = Math.floor(Math.random() * PHRASES.length);
    lastIdx = i;
    const text = PHRASES[i];
    if (typeTimer) clearInterval(typeTimer);
    phraseEl.textContent = "";
    phraseEl.classList.add("typing");
    let n = 0;
    typeTimer = setInterval(() => {
      n++;
      phraseEl.textContent = text.slice(0, n);
      if (n >= text.length) {
        if (typeTimer) clearInterval(typeTimer);
        typeTimer = null;
        phraseEl.classList.remove("typing");
      }
    }, 24);
  };

  // ── The 5s beat: new phrase, new tumble direction, a pinch of confetti ──
  let burst = 0;
  const beat = setInterval(() => {
    if (!root.isConnected) return;
    readColors();
    typePhrase();
    target = spin();
    burst = 6;
  }, 5000);

  let raf = 0;
  let dead = false;
  const cx = size / 2, cy = size / 2;
  const persp = size * 1.6;

  const frame = () => {
    if (dead) return;
    if (!root.isConnected) { destroy(); return; } // dropped by a re-render
    // Ease the tumble toward its target direction.
    vel = {
      x: vel.x + (target.x - vel.x) * 0.04,
      y: vel.y + (target.y - vel.y) * 0.04,
      z: vel.z + (target.z - vel.z) * 0.04,
    };
    ax += vel.x; ay += vel.y; az += vel.z;
    const ca = Math.cos(ax), sa = Math.sin(ax);
    const cb = Math.cos(ay), sb = Math.sin(ay);
    const cc = Math.cos(az), sc = Math.sin(az);
    const proj = V.map(([x, y, z]) => {
      const y1 = y * ca - z * sa, z1 = y * sa + z * ca; // rot X
      const x2 = x * cb + z1 * sb, z2 = -x * sb + z1 * cb; // rot Y
      const x3 = x2 * cc - y1 * sc, y3 = x2 * sc + y1 * cc; // rot Z
      const k = persp / (persp - z2);
      return [cx + x3 * k, cy + y3 * k, z2] as const;
    });

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    // Particles (under the wires).
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.x += p.vx; p.y += p.vy; p.life--;
      if (p.life <= 0) { parts.splice(i, 1); continue; }
      ctx.globalAlpha = Math.min(0.85, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x, p.y, p.size, p.size);
    }
    ctx.globalAlpha = 1;

    // Emit from a random vertex — steady trickle, plus the beat burst.
    const emits = (Math.random() < 0.45 ? 1 : 0) + (burst > 0 ? 2 : 0);
    if (burst > 0) burst--;
    for (let e = 0; e < emits && parts.length < 70; e++) {
      const [px, py] = proj[Math.floor(Math.random() * proj.length)];
      const ang = Math.atan2(py - cy, px - cx) + rnd(-0.6, 0.6);
      const sp = rnd(0.12, 0.5);
      const max = Math.round(rnd(34, 70));
      parts.push({
        x: px, y: py,
        vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
        life: max, max, size: rnd(1, 1.8), color: pickColor(),
      });
    }

    // The cube — depth-shaded strokes only, no fill (transparent).
    for (const [a, b] of E) {
      const [x1, y1, z1] = proj[a], [x2, y2, z2] = proj[b];
      const nz = Math.max(-1, Math.min(1, (z1 + z2) / (2 * s * 1.75)));
      ctx.globalAlpha = 0.42 + 0.34 * (nz + 1) / 2; // nearer = brighter
      ctx.strokeStyle = wire;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    raf = requestAnimationFrame(frame);
  };

  const destroy = () => {
    if (dead) return;
    dead = true;
    cancelAnimationFrame(raf);
    clearInterval(beat);
    if (typeTimer) clearInterval(typeTimer);
    root.remove();
  };

  readColors();
  typePhrase();
  raf = requestAnimationFrame(frame);
  return { el: root, destroy };
}
