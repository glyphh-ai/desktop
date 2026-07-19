import { BrowserWindow, screen } from "electron";
import { getClient } from "./glyphh-client";

// ── Color palettes ──────────────────────────────────────────

const DRIP_COLORS = ["#25C75E", "#1ae052", "#10a37f", "#00ffcc", "#4fffb0", "#fff", "#cff5e0", "#88ffbb", "#33ff99", "#a0ffd0"];
const DRIP_WARM = ["#ff4444", "#ff1493", "#ff6b6b", "#ff9ff3", "#feca57", "#ff9f43", "#ee5a24", "#f368e0", "#ff4757", "#ff69b4"];
const DRIP_COOL = ["#25C75E", "#00ffcc", "#48dbfb", "#0abde3", "#a0ffd0", "#fff", "#54a0ff", "#c8d6e5"];
const DRIP_RAINBOW = ["#ff0000", "#ff8800", "#ffff00", "#00ff00", "#00ffff", "#0088ff", "#8800ff", "#ff00ff"];
const DRIP_FIREWORK = ["#ff4444", "#ffaa00", "#ffee44", "#44ff44", "#44ffff", "#ff44ff", "#ff6600", "#ffffff", "#ff69b4", "#44aaff", "#ffd700", "#ff1493"];

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }
function rng(min: number, max: number): number { return min + Math.random() * (max - min); }

// ── HTML wrappers ───────────────────────────────────────────

function dripWrap(w: number, h: number, keyframes: string, divs: string, dur: number): string {
  return `<html><head><style>
*{margin:0;padding:0}
html,body{width:${w}px;height:${h}px;overflow:hidden;background:rgba(0,0,0,0)}
${keyframes}
</style></head><body>
${divs}
<script>setTimeout(function(){console.log("__drip_close__")},${dur})</${"script"}>
</body></html>`;
}

function dripWrapLoop(w: number, h: number, keyframes: string, divs: string, opacity: number): string {
  return `<html><head><style>
*{margin:0;padding:0}
html,body{width:${w}px;height:${h}px;overflow:hidden;background:rgba(0,0,0,0)}
body{opacity:${opacity}}
${keyframes}
</style></head><body>
${divs}
</body></html>`;
}

// ── One-shot effects ────────────────────────────────────────

function dripFireworks(w: number, h: number): string {
  const bursts = [
    { x: w * 0.5, y: h * 0.22, d: 0 }, { x: w * 0.15, y: h * 0.18, d: 300 },
    { x: w * 0.82, y: h * 0.2, d: 500 }, { x: w * 0.35, y: h * 0.35, d: 800 },
    { x: w * 0.68, y: h * 0.3, d: 1000 }, { x: w * 0.1, y: h * 0.4, d: 1300 },
    { x: w * 0.9, y: h * 0.38, d: 1500 }, { x: w * 0.5, y: h * 0.15, d: 1800 },
    { x: w * 0.25, y: h * 0.5, d: 2100 }, { x: w * 0.75, y: h * 0.45, d: 2300 },
  ];
  let kf = "", dv = "", id = 0;
  for (const b of bursts) {
    const c1 = pick(DRIP_FIREWORK), c2 = Math.random() > 0.4 ? pick(DRIP_FIREWORK) : c1;
    const tn = `t${id++}`;
    kf += `@keyframes ${tn}{0%{height:0;opacity:0.9;bottom:0}70%{opacity:0.7}100%{height:${h - b.y + 40}px;opacity:0}}\n`;
    dv += `<div style="position:absolute;left:${b.x}px;bottom:0;width:2px;background:linear-gradient(to top,transparent,${c1});animation:${tn} ${0.4 + b.d / 4000}s ease-in ${Math.max(0, b.d - 300)}ms forwards;opacity:0"></div>`;
    for (let i = 0; i < 70; i++) {
      const a = Math.random() * Math.PI * 2, sp = rng(120, 600);
      const dx = Math.cos(a) * sp, dy = Math.sin(a) * sp;
      const gravity = rng(180, 350);
      const sz = rng(3, 8), c = Math.random() > 0.5 ? c1 : c2;
      const dur = rng(1.2, 2.2), n = `p${id++}`;
      const trail = sz > 5 ? `box-shadow:0 0 ${sz * 2}px ${c},0 0 ${sz * 4}px ${c}66;` : `box-shadow:0 0 ${sz}px ${c};`;
      kf += `@keyframes ${n}{0%{transform:translate(0,0) scale(1.2);opacity:1}40%{opacity:0.9}70%{opacity:0.5}100%{transform:translate(${dx}px,${dy + gravity}px) scale(0.1);opacity:0}}\n`;
      dv += `<div style="position:absolute;left:${b.x}px;top:${b.y}px;width:${sz}px;height:${sz}px;border-radius:50%;background:${c};${trail}animation:${n} ${dur}s ease-out ${b.d}ms forwards;opacity:0"></div>`;
    }
    for (let s = 0; s < 3; s++) {
      const sa = Math.random() * Math.PI * 2, ssp = rng(100, 250);
      const sx = b.x + Math.cos(sa) * ssp, sy = b.y + Math.sin(sa) * ssp * 0.6;
      const sDelay = b.d + rng(600, 1000);
      const sc = pick(DRIP_FIREWORK);
      for (let j = 0; j < 15; j++) {
        const ja = Math.random() * Math.PI * 2, jsp = rng(40, 150);
        const jdx = Math.cos(ja) * jsp, jdy = Math.sin(ja) * jsp + rng(30, 80);
        const jsz = rng(2, 5), jn = `q${id++}`;
        kf += `@keyframes ${jn}{0%{transform:translate(0,0);opacity:1}100%{transform:translate(${jdx}px,${jdy}px);opacity:0}}\n`;
        dv += `<div style="position:absolute;left:${sx}px;top:${sy}px;width:${jsz}px;height:${jsz}px;border-radius:50%;background:${sc};box-shadow:0 0 ${jsz * 2}px ${sc};animation:${jn} 0.8s ease-out ${sDelay}ms forwards;opacity:0"></div>`;
      }
    }
  }
  for (const b of bursts) {
    const fn = `fl${id++}`;
    kf += `@keyframes ${fn}{0%{opacity:0}10%{opacity:0.15}100%{opacity:0}}\n`;
    dv += `<div style="position:absolute;left:${b.x - 150}px;top:${b.y - 150}px;width:300px;height:300px;border-radius:50%;background:radial-gradient(circle,#fff,transparent 70%);animation:${fn} 0.4s ease-out ${b.d}ms forwards;opacity:0"></div>`;
  }
  return dripWrap(w, h, kf, dv, 4800);
}

function dripHearts(w: number, h: number): string {
  let kf = "", dv = "", id = 0;
  const heartEmojis = ["❤️", "🩷", "💕", "💖", "💗", "💓"];
  for (let i = 0; i < 45; i++) {
    const x = rng(w * 0.05, w * 0.95), delay = rng(0, 2000);
    const rise = rng(h * 0.4, h * 0.8), sway = rng(-120, 120), dur = rng(2, 3.5), sz = rng(24, 56);
    const n = `h${id++}`, heart = pick(heartEmojis);
    kf += `@keyframes ${n}{0%{transform:translate(0,0) scale(0.2);opacity:0}15%{opacity:1;transform:translate(${sway*0.15}px,${-rise*0.15}px) scale(1)}70%{opacity:1;transform:translate(${sway*0.7}px,${-rise*0.7}px) scale(1.3)}85%{opacity:0.8}100%{transform:translate(${sway}px,${-rise}px) scale(0.4);opacity:0}}\n`;
    dv += `<div style="position:absolute;left:${x}px;top:${h*0.8}px;font-size:${sz}px;filter:drop-shadow(0 0 8px rgba(255,50,100,0.6));animation:${n} ${dur}s ease-out ${delay}ms forwards;opacity:0">${heart}</div>`;
    for (let j = 0; j < 12; j++) {
      const a = Math.random() * Math.PI * 2, sp = rng(60, 180);
      const sdx = Math.cos(a) * sp, sdy = Math.sin(a) * sp - 40;
      const sn = `s${id++}`, sc = pick(DRIP_WARM), ssz = rng(3, 8);
      kf += `@keyframes ${sn}{0%{transform:translate(0,0) scale(1);opacity:1}100%{transform:translate(${sdx}px,${sdy}px) scale(0.2);opacity:0}}\n`;
      dv += `<div style="position:absolute;left:${x+sway}px;top:${h*0.8-rise}px;width:${ssz}px;height:${ssz}px;border-radius:50%;background:${sc};box-shadow:0 0 ${ssz*2}px ${sc};animation:${sn} 0.9s ease-out ${delay + dur*1000 - 300}ms forwards;opacity:0"></div>`;
    }
  }
  return dripWrap(w, h, kf, dv, 5500);
}

function dripConfetti(w: number, h: number): string {
  let kf = "", dv = "", id = 0;
  const shapes = ["rect", "circle", "strip"];
  for (let i = 0; i < 150; i++) {
    const x = rng(-20, w + 20), delay = rng(0, 2500), dur = rng(2.5, 5);
    const drift = rng(-180, 180), spin = rng(540, 1800);
    const c = pick(DRIP_RAINBOW), n = `c${id++}`, shape = pick(shapes);
    let style: string;
    if (shape === "circle") { const sz = rng(8, 18); style = `width:${sz}px;height:${sz}px;border-radius:50%;background:${c};box-shadow:0 0 ${sz}px ${c}88;`; }
    else if (shape === "strip") { style = `width:${rng(3, 6)}px;height:${rng(18, 35)}px;background:${c};border-radius:2px;box-shadow:0 0 6px ${c}66;`; }
    else { style = `width:${rng(10, 20)}px;height:${rng(6, 12)}px;background:${c};border-radius:2px;box-shadow:0 0 6px ${c}66;`; }
    kf += `@keyframes ${n}{0%{transform:translate(0,0) rotate(0deg) scaleX(1);opacity:1}25%{transform:translate(${drift*0.25}px,${(h+60)*0.25}px) rotate(${spin*0.25}deg) scaleX(0.5)}50%{transform:translate(${drift*0.5}px,${(h+60)*0.5}px) rotate(${spin*0.5}deg) scaleX(1)}75%{transform:translate(${drift*0.75}px,${(h+60)*0.75}px) rotate(${spin*0.75}deg) scaleX(0.5)}100%{transform:translate(${drift}px,${h+60}px) rotate(${spin}deg) scaleX(1);opacity:0.5}}\n`;
    dv += `<div style="position:absolute;left:${x}px;top:-30px;${style}animation:${n} ${dur}s ease-in ${delay}ms forwards;opacity:0"></div>`;
  }
  return dripWrap(w, h, kf, dv, 7500);
}

function dripStars(w: number, h: number): string {
  const starEmojis = ["⭐", "✨", "🌟", "⚡"];
  let kf = "", dv = "", id = 0;
  for (let i = 0; i < 80; i++) {
    const x = rng(0, w), y = rng(h * 0.1, h * 0.95), delay = rng(0, 3000), dur = rng(2, 4);
    const drift = rng(-100, 100), rise = rng(150, 500), sz = rng(22, 52), n = `st${id++}`;
    kf += `@keyframes ${n}{0%{transform:translate(0,0) scale(0) rotate(0deg);opacity:0}20%{opacity:1;transform:translate(${drift*0.2}px,${-rise*0.2}px) scale(1.4) rotate(72deg)}50%{opacity:1;transform:translate(${drift*0.5}px,${-rise*0.5}px) scale(0.9) rotate(144deg)}75%{opacity:0.8;transform:translate(${drift*0.75}px,${-rise*0.75}px) scale(1.2) rotate(216deg)}100%{transform:translate(${drift}px,${-rise}px) scale(0.3) rotate(360deg);opacity:0}}\n`;
    dv += `<div style="position:absolute;left:${x}px;top:${y}px;font-size:${sz}px;filter:drop-shadow(0 0 12px rgba(255,215,0,0.7));animation:${n} ${dur}s ease-in-out ${delay}ms forwards;opacity:0">${pick(starEmojis)}</div>`;
  }
  return dripWrap(w, h, kf, dv, 7000);
}

function dripRain(w: number, h: number): string {
  let kf = "", dv = "", id = 0;
  for (let i = 0; i < 120; i++) {
    const x = rng(0, w), delay = rng(0, 3000), dur = rng(0.6, 1.8);
    const n = `r${id++}`, c = pick(DRIP_COOL), sz = rng(2, 6), streak = rng(25, 70);
    kf += `@keyframes ${n}{0%{transform:translateY(0);opacity:0.9}100%{transform:translateY(${h+30}px);opacity:0}}\n`;
    dv += `<div style="position:absolute;left:${x}px;top:-${streak}px;width:${sz}px;height:${streak}px;background:linear-gradient(${c},${c}88,transparent);border-radius:${sz}px;box-shadow:0 0 ${sz*2}px ${c}44;animation:${n} ${dur}s linear ${delay}ms forwards;opacity:0"></div>`;
    if (i < 40) {
      const sn = `rs${id++}`, splashDelay = delay + dur * 1000 - 100;
      kf += `@keyframes ${sn}{0%{transform:scaleX(0.3) scaleY(1);opacity:0.8}100%{transform:scaleX(2.5) scaleY(0);opacity:0}}\n`;
      dv += `<div style="position:absolute;left:${x-4}px;top:${h-4}px;width:8px;height:4px;border-radius:50%;background:${c};box-shadow:0 0 8px ${c};animation:${sn} 0.4s ease-out ${splashDelay}ms forwards;opacity:0"></div>`;
    }
  }
  return dripWrap(w, h, kf, dv, 5000);
}

function dripBubbles(w: number, h: number): string {
  let kf = "", dv = "", id = 0;
  for (let i = 0; i < 50; i++) {
    const x = rng(w * 0.02, w * 0.98), delay = rng(0, 2500), dur = rng(2.5, 5);
    const sway = rng(-140, 140), rise = rng(h * 0.5, h * 0.95), sz = rng(30, 90), n = `b${id++}`;
    const c = pick(DRIP_COOL), wobble = rng(20, 50);
    kf += `@keyframes ${n}{0%{transform:translate(0,0) scale(0.2);opacity:0}10%{opacity:0.7;transform:translate(${wobble*0.3}px,${-rise*0.05}px) scale(1)}30%{transform:translate(${-wobble*0.5}px,${-rise*0.3}px) scale(1.05)}50%{transform:translate(${sway*0.4}px,${-rise*0.5}px) scale(0.95)}70%{transform:translate(${-wobble*0.3+sway*0.5}px,${-rise*0.7}px) scale(1.05)}90%{opacity:0.5;transform:translate(${sway*0.9}px,${-rise*0.9}px) scale(1.15)}100%{transform:translate(${sway}px,${-rise}px) scale(1.8);opacity:0}}\n`;
    dv += `<div style="position:absolute;left:${x}px;top:${h*0.9}px;width:${sz}px;height:${sz}px;border-radius:50%;border:2px solid ${c}88;background:radial-gradient(circle at 35% 35%,rgba(255,255,255,0.2),transparent 50%);box-shadow:inset -${sz/3}px -${sz/3}px ${sz/2}px rgba(255,255,255,0.08),0 0 ${sz}px ${c}33,0 0 ${sz*2}px ${c}11;animation:${n} ${dur}s ease-out ${delay}ms forwards;opacity:0"></div>`;
    const popDelay = delay + dur * 1000 - 200;
    for (let j = 0; j < 6; j++) {
      const pa = Math.random() * Math.PI * 2, psp = rng(20, sz);
      const pdx = Math.cos(pa) * psp, pdy = Math.sin(pa) * psp;
      const pn = `bp${id++}`, psz = rng(2, 5);
      kf += `@keyframes ${pn}{0%{transform:translate(0,0);opacity:1}100%{transform:translate(${pdx}px,${pdy}px);opacity:0}}\n`;
      dv += `<div style="position:absolute;left:${x+sway+sz/2}px;top:${h*0.9-rise}px;width:${psz}px;height:${psz}px;border-radius:50%;background:#fff;box-shadow:0 0 6px ${c};animation:${pn} 0.5s ease-out ${popDelay}ms forwards;opacity:0"></div>`;
    }
  }
  return dripWrap(w, h, kf, dv, 7500);
}

function dripSparkle(w: number, h: number): string {
  const sparkEmojis = ["✨", "🌟", "⭐", "⚡"];
  let kf = "", dv = "", id = 0;
  for (let wave = 0; wave < 3; wave++) {
    const waveDelay = wave * 1200;
    for (let i = 0; i < 40; i++) {
      const x = rng(0, w), y = rng(0, h), delay = waveDelay + rng(0, 800), dur = rng(0.4, 1.0);
      const sz = rng(20, 50), n = `sp${id++}`;
      kf += `@keyframes ${n}{0%{transform:scale(0) rotate(0deg);opacity:0}40%{transform:scale(1.5) rotate(90deg);opacity:1}60%{transform:scale(1.2) rotate(135deg);opacity:1}100%{transform:scale(0) rotate(360deg);opacity:0}}\n`;
      dv += `<div style="position:absolute;left:${x}px;top:${y}px;font-size:${sz}px;filter:drop-shadow(0 0 8px rgba(255,215,0,0.5));animation:${n} ${dur}s ease-in-out ${delay}ms forwards;opacity:0">${pick(sparkEmojis)}</div>`;
    }
  }
  return dripWrap(w, h, kf, dv, 5500);
}

function dripSpiral(w: number, h: number): string {
  let kf = "", dv = "", id = 0;
  const cx = w / 2, cy = h / 2, maxR = Math.min(w, h) * 0.45;
  for (let i = 0; i < 120; i++) {
    const baseAngle = (i / 120) * Math.PI * 8;
    const r = rng(maxR * 0.3, maxR), dur = rng(1.8, 3.5), delay = (i / 120) * 2000;
    const endX = Math.cos(baseAngle) * r, endY = Math.sin(baseAngle) * r;
    const mid1 = r * 0.3, mid2 = r * 0.65;
    const m1x = Math.cos(baseAngle - 0.8) * mid1, m1y = Math.sin(baseAngle - 0.8) * mid1;
    const m2x = Math.cos(baseAngle - 0.3) * mid2, m2y = Math.sin(baseAngle - 0.3) * mid2;
    const sz = rng(4, 12), c = pick(DRIP_RAINBOW), n = `sp${id++}`;
    kf += `@keyframes ${n}{0%{transform:translate(0,0) scale(0);opacity:0}15%{opacity:1;transform:translate(${m1x}px,${m1y}px) scale(1.3)}50%{opacity:0.9;transform:translate(${m2x}px,${m2y}px) scale(1)}100%{transform:translate(${endX}px,${endY}px) scale(0.15);opacity:0}}\n`;
    dv += `<div style="position:absolute;left:${cx}px;top:${cy}px;width:${sz}px;height:${sz}px;border-radius:50%;background:${c};box-shadow:0 0 ${sz*2}px ${c},0 0 ${sz*4}px ${c}44;animation:${n} ${dur}s ease-out ${delay}ms forwards;opacity:0"></div>`;
  }
  return dripWrap(w, h, kf, dv, 6000);
}

function dripEmoji(w: number, h: number): string {
  const faces = ["😀", "😂", "🤩", "🥳", "😎", "😜", "🤪", "😍", "✌️", "🤙", "🤘", "🙌", "🚀", "🎉", "🎊"];
  let kf = "", dv = "", id = 0;
  for (let i = 0; i < 60; i++) {
    const x = rng(10, w - 50), delay = rng(0, 3000), dur = rng(2.5, 4);
    const bounce = h * rng(0.55, 0.82), drift = rng(-80, 80);
    const sz = rng(30, 60), n = `e${id++}`, face = pick(faces);
    const bounceH = rng(80, 160), spin1 = rng(180, 400), spin2 = rng(400, 700);
    kf += `@keyframes ${n}{0%{transform:translate(0,0) rotate(0deg) scale(0.5);opacity:1}55%{transform:translate(${drift*0.55}px,${bounce}px) rotate(${spin1}deg) scale(1.1);opacity:1}68%{transform:translate(${drift*0.68}px,${bounce-bounceH}px) rotate(${spin1+60}deg) scale(1.2);opacity:1}80%{transform:translate(${drift*0.8}px,${bounce}px) rotate(${spin2}deg) scale(1);opacity:0.9}88%{transform:translate(${drift*0.88}px,${bounce-bounceH*0.3}px) rotate(${spin2+30}deg) scale(1.1)}95%{transform:translate(${drift*0.95}px,${bounce+10}px) rotate(${spin2+50}deg) scale(1)}100%{transform:translate(${drift}px,${bounce+40}px) rotate(${spin2+70}deg) scale(0.8);opacity:0}}\n`;
    dv += `<div style="position:absolute;left:${x}px;top:-60px;font-size:${sz}px;animation:${n} ${dur}s ease-in ${delay}ms forwards;opacity:0">${face}</div>`;
  }
  return dripWrap(w, h, kf, dv, 7000);
}

function dripWave(w: number, h: number): string {
  let kf = "", dv = "", id = 0;
  const cx = w / 2, cy = h / 2, maxR = Math.max(w, h) * 0.55;
  const origins = [{ x: cx, y: cy, d: 0 }, { x: w * 0.25, y: h * 0.4, d: 800 }, { x: w * 0.75, y: h * 0.6, d: 1600 }];
  for (const o of origins) {
    for (let i = 0; i < 6; i++) {
      const delay = o.d + i * 200, n = `w${id++}`, c = pick(DRIP_RAINBOW);
      kf += `@keyframes ${n}{0%{width:0;height:0;margin-left:0;margin-top:0;opacity:0.9;border-width:4px}50%{opacity:0.5}100%{width:${maxR*2}px;height:${maxR*2}px;margin-left:${-maxR}px;margin-top:${-maxR}px;opacity:0;border-width:1px}}\n`;
      dv += `<div style="position:absolute;left:${o.x}px;top:${o.y}px;border-radius:50%;border:4px solid ${c};box-shadow:0 0 20px ${c}66,0 0 40px ${c}22;animation:${n} 2.5s ease-out ${delay}ms forwards;opacity:0"></div>`;
    }
  }
  return dripWrap(w, h, kf, dv, 5500);
}

function dripThumbsup(w: number, h: number): string {
  let kf = "", dv = "", id = 0;
  const cx = w / 2, cy = h / 2;
  const thumbs = ["👍", "👍🏻", "👍🏼", "👍🏽", "👍🏾", "👍🏿"];
  kf += `@keyframes bigthumb{0%{transform:scale(0) rotate(-30deg);opacity:0}15%{transform:scale(1.8) rotate(10deg);opacity:1}25%{transform:scale(1.5) rotate(0deg)}40%{transform:scale(1.7) rotate(-5deg)}55%{transform:scale(1.5) rotate(5deg)}70%{transform:scale(2.2) rotate(0deg);opacity:1}85%{transform:scale(3) rotate(0deg);opacity:0.6}100%{transform:scale(4) rotate(0deg);opacity:0}}\n`;
  dv += `<div style="position:absolute;left:${cx}px;top:${cy}px;font-size:120px;transform-origin:center;margin-left:-60px;margin-top:-60px;animation:bigthumb 2.5s ease-in-out forwards;opacity:0;filter:drop-shadow(0 0 30px rgba(255,200,0,0.5))">👍</div>`;
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2, sp = rng(200, 500);
    const dx = Math.cos(a) * sp, dy = Math.sin(a) * sp;
    const sz = rng(30, 60), dur = rng(1.2, 2.0), n = `tb${id++}`;
    kf += `@keyframes ${n}{0%{transform:translate(0,0) scale(0) rotate(0deg);opacity:0}20%{opacity:1;transform:translate(${dx*0.15}px,${dy*0.15}px) scale(1.2) rotate(${rng(-30,30)}deg)}100%{transform:translate(${dx}px,${dy+80}px) scale(0.4) rotate(${rng(-180,180)}deg);opacity:0}}\n`;
    dv += `<div style="position:absolute;left:${cx}px;top:${cy}px;font-size:${sz}px;animation:${n} ${dur}s ease-out ${600 + i * 60}ms forwards;opacity:0">${pick(thumbs)}</div>`;
  }
  for (let i = 0; i < 60; i++) {
    const a = Math.random() * Math.PI * 2, sp = rng(150, 600);
    const dx = Math.cos(a) * sp, dy = Math.sin(a) * sp;
    const sz = rng(4, 10), c = pick([...DRIP_RAINBOW, "#ffd700", "#ffd700", "#ffaa00"]);
    const dur = rng(1.0, 2.0), n = `tc${id++}`;
    kf += `@keyframes ${n}{0%{transform:translate(0,0) scale(1);opacity:1}100%{transform:translate(${dx}px,${dy + rng(50, 150)}px) scale(0.2);opacity:0}}\n`;
    dv += `<div style="position:absolute;left:${cx}px;top:${cy}px;width:${sz}px;height:${sz}px;border-radius:50%;background:${c};box-shadow:0 0 ${sz*2}px ${c};animation:${n} ${dur}s ease-out ${rng(400, 1200)}ms forwards;opacity:0"></div>`;
  }
  for (let i = 0; i < 20; i++) {
    const x = rng(w * 0.05, w * 0.95), delay = rng(800, 2500), dur = rng(1.5, 3);
    const rise = rng(200, h * 0.6), sway = rng(-60, 60), sz = rng(24, 44), n = `td${id++}`;
    kf += `@keyframes ${n}{0%{transform:translate(0,0) scale(0.3);opacity:0}25%{opacity:1;transform:translate(${sway*0.2}px,${-rise*0.2}px) scale(1)}100%{transform:translate(${sway}px,${-rise}px) scale(0.5);opacity:0}}\n`;
    dv += `<div style="position:absolute;left:${x}px;top:${h*0.7}px;font-size:${sz}px;animation:${n} ${dur}s ease-out ${delay}ms forwards;opacity:0">${pick(thumbs)}</div>`;
  }
  return dripWrap(w, h, kf, dv, 5000);
}

function dripPeace(w: number, h: number): string {
  let kf = "", dv = "", id = 0;
  const cx = w / 2, cy = h / 2;
  const peaceSigns = ["✌️", "✌🏻", "✌🏼", "✌🏽", "✌🏾", "✌🏿"];
  const calm = ["☮️", "🕊️", "🌿"];
  // Big center peace sign — slow zen entrance
  kf += `@keyframes bigpeace{0%{transform:scale(0) rotate(-15deg);opacity:0}20%{transform:scale(2.2) rotate(0deg);opacity:1}55%{transform:scale(2) rotate(4deg);opacity:1}75%{transform:scale(2.4) rotate(-3deg);opacity:1}100%{transform:scale(3.6) rotate(0deg);opacity:0}}\n`;
  dv += `<div style="position:absolute;left:${cx}px;top:${cy}px;font-size:120px;transform-origin:center;margin-left:-60px;margin-top:-60px;animation:bigpeace 3s ease-out forwards;opacity:0;filter:drop-shadow(0 0 30px rgba(80,255,180,0.6))">✌️</div>`;
  // Ring of peace signs radiating outward
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2, sp = rng(220, 480);
    const dx = Math.cos(a) * sp, dy = Math.sin(a) * sp;
    const sz = rng(34, 56), dur = rng(1.5, 2.4), n = `pp${id++}`;
    kf += `@keyframes ${n}{0%{transform:translate(0,0) scale(0) rotate(0deg);opacity:0}25%{opacity:1;transform:translate(${dx*0.2}px,${dy*0.2}px) scale(1.1) rotate(${rng(-15,15)}deg)}100%{transform:translate(${dx}px,${dy+40}px) scale(0.5) rotate(${rng(-90,90)}deg);opacity:0}}\n`;
    dv += `<div style="position:absolute;left:${cx}px;top:${cy}px;font-size:${sz}px;animation:${n} ${dur}s ease-out ${700 + i * 80}ms forwards;opacity:0">${pick(peaceSigns)}</div>`;
  }
  // Cool-palette glow particles
  for (let i = 0; i < 50; i++) {
    const a = Math.random() * Math.PI * 2, sp = rng(140, 520);
    const dx = Math.cos(a) * sp, dy = Math.sin(a) * sp;
    const sz = rng(3, 8), c = pick(DRIP_COOL);
    const dur = rng(1.2, 2.2), n = `pg${id++}`;
    kf += `@keyframes ${n}{0%{transform:translate(0,0) scale(1);opacity:1}100%{transform:translate(${dx}px,${dy + rng(40, 120)}px) scale(0.2);opacity:0}}\n`;
    dv += `<div style="position:absolute;left:${cx}px;top:${cy}px;width:${sz}px;height:${sz}px;border-radius:50%;background:${c};box-shadow:0 0 ${sz*2}px ${c};animation:${n} ${dur}s ease-out ${rng(500, 1300)}ms forwards;opacity:0"></div>`;
  }
  // Peace signs and calm symbols rising from below
  for (let i = 0; i < 18; i++) {
    const x = rng(w * 0.05, w * 0.95), delay = rng(900, 2800), dur = rng(2.2, 3.5);
    const rise = rng(h * 0.4, h * 0.75), sway = rng(-100, 100), sz = rng(26, 48), n = `pf${id++}`;
    const sym = pick([...peaceSigns, ...calm]);
    kf += `@keyframes ${n}{0%{transform:translate(0,0) scale(0.3);opacity:0}20%{opacity:1;transform:translate(${sway*0.2}px,${-rise*0.2}px) scale(1)}100%{transform:translate(${sway}px,${-rise}px) scale(0.5);opacity:0}}\n`;
    dv += `<div style="position:absolute;left:${x}px;top:${h*0.8}px;font-size:${sz}px;filter:drop-shadow(0 0 8px rgba(80,255,180,0.5));animation:${n} ${dur}s ease-out ${delay}ms forwards;opacity:0">${sym}</div>`;
  }
  // Doves gliding sideways
  for (let i = 0; i < 4; i++) {
    const fromLeft = i % 2 === 0;
    const startX = fromLeft ? -80 : w + 80;
    const travel = fromLeft ? w + 160 : -(w + 160);
    const y = rng(h * 0.15, h * 0.55), delay = 800 + i * 600, dur = rng(3.5, 4.5);
    const n = `pd${id++}`;
    const flip = fromLeft ? "" : "scaleX(-1)";
    kf += `@keyframes ${n}{0%{transform:translate(0,0) ${flip};opacity:0}15%{opacity:1}85%{opacity:1}100%{transform:translate(${travel}px,0) ${flip};opacity:0}}\n`;
    dv += `<div style="position:absolute;top:${y}px;left:${startX}px;font-size:48px;filter:drop-shadow(0 0 10px rgba(255,255,255,0.7));animation:${n} ${dur}s linear ${delay}ms forwards;opacity:0">🕊️</div>`;
  }
  return dripWrap(w, h, kf, dv, 5500);
}

function dripTimme(w: number, h: number): string {
  const quote = "The only true currency in this bankrupt world is what you share with someone else when you're uncool.";
  const attribution = "— Lester Bangs";
  let kf = "", dv = "";
  kf += `@keyframes bgfade{0%{opacity:0}10%{opacity:1}85%{opacity:1}100%{opacity:0}}\n`;
  dv += `<div style="position:absolute;inset:0;background:radial-gradient(ellipse at center,#0a1a0f 0%,#000 70%);animation:bgfade 15s ease-in-out forwards;opacity:0"></div>`;
  let id = 0;
  for (let i = 0; i < 40; i++) {
    const x = rng(0, w), y = rng(0, h), delay = rng(0, 8000), dur = rng(4, 8);
    const drift = rng(-100, 100), rise = rng(-150, 150), sz = rng(2, 5);
    const c = pick(DRIP_COOL), n = `a${id++}`;
    kf += `@keyframes ${n}{0%{transform:translate(0,0);opacity:0}30%{opacity:0.6}70%{opacity:0.6}100%{transform:translate(${drift}px,${rise}px);opacity:0}}\n`;
    dv += `<div style="position:absolute;left:${x}px;top:${y}px;width:${sz}px;height:${sz}px;border-radius:50%;background:${c};box-shadow:0 0 ${sz*3}px ${c};animation:${n} ${dur}s ease-in-out ${delay}ms forwards;opacity:0"></div>`;
  }
  const words = quote.split(" ");
  let wordDivs = "";
  const startDelay = 1500, wordGap = 200;
  for (let i = 0; i < words.length; i++) {
    const d = startDelay + i * wordGap, wn = `tw${i}`;
    kf += `@keyframes ${wn}{0%{opacity:0;transform:translateY(8px)}100%{opacity:1;transform:translateY(0)}}\n`;
    wordDivs += `<span style="display:inline-block;opacity:0;animation:${wn} 0.6s ease-out ${d}ms forwards;margin-right:7px">${words[i]}</span>`;
  }
  const attrDelay = startDelay + words.length * wordGap + 800;
  kf += `@keyframes attrin{0%{opacity:0;transform:translateY(10px)}100%{opacity:0.6;transform:translateY(0)}}\n`;
  kf += `@keyframes qfade{0%{opacity:0}8%{opacity:1}82%{opacity:1}100%{opacity:0}}\n`;
  dv += `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;animation:qfade 15s ease-in-out forwards;opacity:0;z-index:2">`;
  dv += `<div style="max-width:${Math.min(w * 0.7, 600)}px;text-align:center;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;font-size:${Math.min(24, w * 0.03)}px;font-weight:300;color:#cff5e0;line-height:1.7;letter-spacing:0.02em;text-shadow:0 0 30px #25C75E44">${wordDivs}</div>`;
  dv += `<div style="margin-top:24px;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;font-size:${Math.min(16, w * 0.02)}px;font-style:italic;color:#25C75E;letter-spacing:0.05em;animation:attrin 0.8s ease-out ${attrDelay}ms forwards;opacity:0">${attribution}</div></div>`;
  const finaleStart = 12000;
  for (let i = 0; i < 60; i++) {
    const a = Math.random() * Math.PI * 2, sp = rng(100, 350);
    const dx = Math.cos(a) * sp, dy = Math.sin(a) * sp - 100;
    const sz = rng(3, 7), c = pick(DRIP_COLORS), dur = rng(1.2, 2.0), n = `f${id++}`;
    kf += `@keyframes ${n}{0%{transform:translate(0,0) scale(1);opacity:1}100%{transform:translate(${dx}px,${dy+80}px) scale(0.2);opacity:0}}\n`;
    dv += `<div style="position:absolute;left:${w/2}px;top:${h/2}px;width:${sz}px;height:${sz}px;border-radius:50%;background:${c};box-shadow:0 0 ${sz*2}px ${c};animation:${n} ${dur}s ease-out ${finaleStart + rng(0, 400)}ms forwards;opacity:0;z-index:3"></div>`;
  }
  return dripWrap(w, h, kf, dv, 16000);
}

// ── Looping background effects ──────────────────────────────

function dripMatrix(w: number, h: number, opacity: number): string {
  const cols = Math.floor(w / 18);
  let kf = "", dv = "";
  const chars = "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789ABCDEF";
  kf += `@keyframes mfall{0%{transform:translateY(-100%)}100%{transform:translateY(${h + 200}px)}}\n`;
  kf += `@keyframes mflicker{0%,100%{opacity:0.8}50%{opacity:0.3}}\n`;
  for (let c = 0; c < cols; c++) {
    const x = c * 18 + rng(-2, 2), dur = rng(4, 12), delay = rng(0, 8), len = Math.floor(rng(8, 30));
    let colHtml = "";
    for (let r = 0; r < len; r++) {
      const ch = chars[Math.floor(Math.random() * chars.length)];
      const bright = r === 0 ? "color:#fff;text-shadow:0 0 8px #0f0,0 0 20px #0f0;" : r < 3 ? "color:#4f4;text-shadow:0 0 6px #0f0;" : `color:rgba(0,${Math.floor(rng(120, 255))},0,${rng(0.3, 0.8)});`;
      colHtml += `<div style="font-size:14px;font-family:monospace;line-height:18px;${bright}animation:mflicker ${rng(1, 3)}s ease-in-out ${rng(0, 2)}s infinite">${ch}</div>`;
    }
    dv += `<div style="position:absolute;left:${x}px;top:0;animation:mfall ${dur}s linear ${delay}s infinite">${colHtml}</div>`;
  }
  return dripWrapLoop(w, h, kf, dv, opacity);
}

function dripAurora(w: number, h: number, opacity: number): string {
  let kf = "", dv = "";
  kf += `@keyframes ashift1{0%{transform:translateX(0) scaleY(1)}25%{transform:translateX(60px) scaleY(1.2)}50%{transform:translateX(-40px) scaleY(0.8)}75%{transform:translateX(80px) scaleY(1.1)}100%{transform:translateX(0) scaleY(1)}}\n`;
  kf += `@keyframes ashift2{0%{transform:translateX(0) scaleY(1)}33%{transform:translateX(-70px) scaleY(1.3)}66%{transform:translateX(50px) scaleY(0.9)}100%{transform:translateX(0) scaleY(1)}}\n`;
  kf += `@keyframes apulse{0%,100%{opacity:0.4}50%{opacity:0.7}}\n`;
  const bands = [
    { colors: "#00ff8855,#00ffcc33,transparent", top: "5%", h: "35%", dur: 12, anim: "ashift1" },
    { colors: "#25C75E44,#4fffb044,transparent", top: "10%", h: "30%", dur: 16, anim: "ashift2" },
    { colors: "#0088ff33,#00ffcc22,transparent", top: "2%", h: "40%", dur: 20, anim: "ashift1" },
    { colors: "#8800ff22,#ff00ff11,transparent", top: "8%", h: "25%", dur: 14, anim: "ashift2" },
  ];
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    dv += `<div style="position:absolute;left:-100px;right:-100px;top:${b.top};height:${b.h};background:linear-gradient(180deg,${b.colors});filter:blur(40px);animation:${b.anim} ${b.dur}s ease-in-out infinite,apulse ${b.dur * 0.7}s ease-in-out ${i * 2}s infinite;border-radius:50%"></div>`;
  }
  return dripWrapLoop(w, h, kf, dv, opacity);
}

function dripNebula(w: number, h: number, opacity: number): string {
  let kf = "", dv = "";
  kf += `@keyframes ndrift{0%{transform:translate(0,0) rotate(0deg) scale(1)}33%{transform:translate(40px,-30px) rotate(3deg) scale(1.05)}66%{transform:translate(-30px,20px) rotate(-2deg) scale(0.95)}100%{transform:translate(0,0) rotate(0deg) scale(1)}}\n`;
  const clouds = [
    { x: "20%", y: "30%", sz: 400, c1: "#25C75E15", c2: "#00ffcc08", dur: 25 },
    { x: "60%", y: "20%", sz: 500, c1: "#8800ff12", c2: "#ff00ff06", dur: 30 },
    { x: "40%", y: "60%", sz: 450, c1: "#0088ff10", c2: "#00ffcc08", dur: 35 },
    { x: "75%", y: "50%", sz: 350, c1: "#ff440008", c2: "#ffaa0005", dur: 20 },
    { x: "15%", y: "70%", sz: 380, c1: "#25C75E10", c2: "#4fffb008", dur: 28 },
  ];
  for (let i = 0; i < clouds.length; i++) {
    const c = clouds[i];
    dv += `<div style="position:absolute;left:${c.x};top:${c.y};width:${c.sz}px;height:${c.sz}px;border-radius:50%;background:radial-gradient(circle,${c.c1},${c.c2},transparent 70%);filter:blur(60px);animation:ndrift ${c.dur}s ease-in-out ${i * 3}s infinite"></div>`;
  }
  for (let i = 0; i < 60; i++) {
    const x = rng(0, w), y = rng(0, h), sz = rng(1, 3);
    kf += `@keyframes ns${i}{0%,100%{opacity:${rng(0.2, 0.5)}}50%{opacity:${rng(0.6, 1)}}}\n`;
    dv += `<div style="position:absolute;left:${x}px;top:${y}px;width:${sz}px;height:${sz}px;border-radius:50%;background:#fff;animation:ns${i} ${rng(2, 6)}s ease-in-out ${rng(0, 4)}s infinite"></div>`;
  }
  return dripWrapLoop(w, h, kf, dv, opacity);
}

function dripPlasma(w: number, h: number, opacity: number): string {
  let kf = "", dv = "";
  kf += `@keyframes pmove1{0%{transform:translate(0,0)}25%{transform:translate(${w*0.15}px,${h*0.1}px)}50%{transform:translate(${-w*0.1}px,${h*0.2}px)}75%{transform:translate(${w*0.2}px,${-h*0.1}px)}100%{transform:translate(0,0)}}\n`;
  kf += `@keyframes pmove2{0%{transform:translate(0,0)}33%{transform:translate(${-w*0.12}px,${-h*0.15}px)}66%{transform:translate(${w*0.18}px,${h*0.08}px)}100%{transform:translate(0,0)}}\n`;
  kf += `@keyframes pmove3{0%{transform:translate(0,0)}50%{transform:translate(${w*0.1}px,${-h*0.12}px)}100%{transform:translate(0,0)}}\n`;
  const blobs = [
    { x: "30%", y: "30%", sz: Math.min(w, h) * 0.5, c: "#25C75E20", anim: "pmove1", dur: 15 },
    { x: "60%", y: "50%", sz: Math.min(w, h) * 0.45, c: "#0088ff18", anim: "pmove2", dur: 20 },
    { x: "45%", y: "25%", sz: Math.min(w, h) * 0.55, c: "#8800ff15", anim: "pmove3", dur: 18 },
    { x: "20%", y: "65%", sz: Math.min(w, h) * 0.4, c: "#ff008818", anim: "pmove1", dur: 22 },
    { x: "70%", y: "30%", sz: Math.min(w, h) * 0.35, c: "#ffaa0012", anim: "pmove2", dur: 16 },
  ];
  for (const b of blobs) {
    dv += `<div style="position:absolute;left:${b.x};top:${b.y};width:${b.sz}px;height:${b.sz}px;border-radius:50%;background:radial-gradient(circle,${b.c},transparent 70%);filter:blur(50px);animation:${b.anim} ${b.dur}s ease-in-out infinite;mix-blend-mode:screen"></div>`;
  }
  return dripWrapLoop(w, h, kf, dv, opacity);
}

function dripCat(w: number, h: number): string {
  const cx = Math.floor(w / 2);
  const by = h - 10;
  const sz = 48;
  const half = sz / 2;
  const dur = 700;
  const kf = `
@keyframes catrise{0%{transform:translateY(${half}px);opacity:0}25%{transform:translateY(0);opacity:1}75%{transform:translateY(0);opacity:1}100%{transform:translateY(${half}px);opacity:0}}
`;
  const cat = `<canvas id="c" width="${sz}" height="${sz}" style="position:absolute;left:${cx - half}px;top:${by - sz}px;width:${sz}px;height:${sz}px;image-rendering:pixelated;animation:catrise ${dur}ms ease-in-out forwards"></canvas>`;
  const script = `<script>
var c=document.getElementById("c").getContext("2d");
function P(x,y,w,h,f){c.fillStyle=f;c.fillRect(x*2,y*2,w*2,h*2)}
var g="#555",w="#fff",pk="#f9a8d4";
P(4,0,3,3,g);P(17,0,3,3,g);P(5,3,2,2,g);P(17,3,2,2,g);
P(4,5,16,12,g);
P(5,1,1,2,pk);P(18,1,1,2,pk);
P(7,9,3,3,w);P(14,9,3,3,w);P(8,10,2,2,"#222");P(15,10,2,2,"#222");
P(11,13,2,1,pk);P(10,14,1,1,g);P(13,14,1,1,g);P(11,15,2,1,g);
P(1,11,4,1,g);P(19,11,4,1,g);P(2,13,3,1,g);P(19,13,3,1,g);
setTimeout(function(){
  c.clearRect(0,0,${sz},${sz});
  P(4,0,3,3,g);P(17,0,3,3,g);P(5,3,2,2,g);P(17,3,2,2,g);
  P(4,5,16,12,g);P(5,1,1,2,pk);P(18,1,1,2,pk);
  P(7,10,3,1,w);P(14,10,3,1,w);
  P(11,13,2,1,pk);P(10,14,1,1,g);P(13,14,1,1,g);P(11,15,2,1,g);
  P(1,11,4,1,g);P(19,11,4,1,g);P(2,13,3,1,g);P(19,13,3,1,g);
  setTimeout(function(){
    c.clearRect(0,0,${sz},${sz});
    P(4,0,3,3,g);P(17,0,3,3,g);P(5,3,2,2,g);P(17,3,2,2,g);
    P(4,5,16,12,g);P(5,1,1,2,pk);P(18,1,1,2,pk);
    P(7,9,3,3,w);P(14,9,3,3,w);P(8,10,2,2,"#222");P(15,10,2,2,"#222");
    P(11,13,2,1,pk);P(10,14,1,1,g);P(13,14,1,1,g);P(11,15,2,1,g);
    P(1,11,4,1,g);P(19,11,4,1,g);P(2,13,3,1,g);P(19,13,3,1,g);
  },80);
},320);
setTimeout(function(){console.log("__drip_close__")},${dur + 100});
</${"script"}>`;
  return dripWrap(w, h, kf, cat + script, dur + 100);
}

function dripFireflies(w: number, h: number, opacity: number): string {
  let kf = "", dv = "";
  for (let i = 0; i < 40; i++) {
    const x = rng(w * 0.05, w * 0.95), y = rng(h * 0.1, h * 0.9);
    const dx = rng(-120, 120), dy = rng(-120, 120), dur = rng(6, 14);
    const sz = rng(3, 8), c = pick(["#25C75E", "#4fffb0", "#ffee44", "#ffe066"]);
    kf += `@keyframes ff${i}{0%{transform:translate(0,0);opacity:0}15%{opacity:${rng(0.5, 1)}}50%{transform:translate(${dx}px,${dy}px);opacity:${rng(0.3, 0.8)}}85%{opacity:${rng(0.4, 0.9)}}100%{transform:translate(0,0);opacity:0}}\n`;
    dv += `<div style="position:absolute;left:${x}px;top:${y}px;width:${sz}px;height:${sz}px;border-radius:50%;background:${c};box-shadow:0 0 ${sz*3}px ${c},0 0 ${sz*6}px ${c}44;animation:ff${i} ${dur}s ease-in-out ${rng(0, 6)}s infinite"></div>`;
  }
  return dripWrapLoop(w, h, kf, dv, opacity);
}

function dripStarfield(w: number, h: number, opacity: number): string {
  let kf = "", dv = "";
  const cx = w / 2, cy = h / 2;
  for (let i = 0; i < 100; i++) {
    const a = Math.random() * Math.PI * 2, maxDist = Math.max(w, h) * 0.8;
    const endX = Math.cos(a) * maxDist, endY = Math.sin(a) * maxDist;
    const dur = rng(2, 6), delay = rng(0, 4), sz = rng(1, 3);
    kf += `@keyframes sf${i}{0%{transform:translate(0,0) scaleX(1);opacity:0}10%{opacity:0.8}80%{opacity:1}100%{transform:translate(${endX}px,${endY}px) scaleX(${rng(3, 8)});opacity:0}}\n`;
    dv += `<div style="position:absolute;left:${cx}px;top:${cy}px;width:${sz}px;height:${sz}px;border-radius:50%;background:#fff;box-shadow:0 0 ${sz*2}px #fff;animation:sf${i} ${dur}s linear ${delay}s infinite"></div>`;
  }
  return dripWrapLoop(w, h, kf, dv, opacity);
}

// ── Effect registries ───────────────────────────────────────

const LOOP_EFFECTS: Record<string, (w: number, h: number, opacity: number) => string> = {
  matrix: dripMatrix, aurora: dripAurora, nebula: dripNebula,
  plasma: dripPlasma, fireflies: dripFireflies, starfield: dripStarfield,
};

function wrapOneShot(builder: (w: number, h: number, opacity: number) => string): (w: number, h: number) => string {
  return (w, h) => {
    const html = builder(w, h, 0.8);
    return html.replace("</body></html>", `<script>setTimeout(function(){console.log("__drip_close__")},8000)</${"script"}></body></html>`);
  };
}

const ONE_SHOT_EFFECTS: Record<string, (w: number, h: number) => string> = {
  fireworks: dripFireworks, hearts: dripHearts, confetti: dripConfetti,
  stars: dripStars, rain: dripRain, bubbles: dripBubbles,
  sparkle: dripSparkle, spiral: dripSpiral, emoji: dripEmoji,
  wave: dripWave, thumbsup: dripThumbsup, peace: dripPeace, cat: dripCat, timme: dripTimme,
  matrix: wrapOneShot(dripMatrix), aurora: wrapOneShot(dripAurora),
  nebula: wrapOneShot(dripNebula), plasma: wrapOneShot(dripPlasma),
  fireflies: wrapOneShot(dripFireflies), starfield: wrapOneShot(dripStarfield),
};

export const BUILTIN_EFFECTS = Object.keys(ONE_SHOT_EFFECTS).filter(k => k !== "timme");

// ── Custom drip presets ──────────────────────��──────────────

export interface CustomDrip {
  name: string;
  recipe: string;
}

interface ServerDrip { id: string; name: string; recipe: string; }

// ── DripManager ─────────────────────────────────────────────
//
// Custom drip presets are server-authoritative (yo-server's saved_drips, the
// same table the platform Drips page writes to). The in-memory `customs` cache
// keeps the synchronous `.drip` command path working; `ids` maps name→server
// UUID for patch/delete. The command path saves optimistically (updates the
// cache + writes in the background); the Drips tab IPC awaits the server.

// Module singleton — main.ts registers its instance so tool surfaces
// (Glyphh, relay) can reach the running manager without importing main.
let current: DripManager | null = null;
export function setDripManagerInstance(m: DripManager): void { current = m; }
export function getDripManagerInstance(): DripManager | null { return current; }

export class DripManager {
  private customs: Record<string, string> = {};   // name → recipe (cache)
  private ids: Record<string, string> = {};       // name → server UUID
  private persistent = new Map<string, BrowserWindow>();
  private mainWindow: BrowserWindow | null = null;

  constructor() {
    // Pull presets in the background; the cache serves until the fetch lands.
    void this.refreshFromServer();
  }

  setMainWindow(win: BrowserWindow): void { this.mainWindow = win; }

  /** Refresh the cache from the server (non-fatal offline / pre-auth). */
  async refreshFromServer(): Promise<void> {
    try {
      const items = await getClient().drips.list();
      const customs: Record<string, string> = {};
      const ids: Record<string, string> = {};
      for (const item of items) {
        const recipe = (item.data as { recipe?: string } | null)?.recipe;
        if (typeof recipe !== "string") continue;
        customs[item.name] = recipe;
        ids[item.name] = item.id;
      }
      this.customs = customs;
      this.ids = ids;
    } catch { /* keep existing cache */ }
  }

  /** Refresh then list — used by the drips-list IPC so the tab shows server truth. */
  async refreshAndList(): Promise<CustomDrip[]> {
    await this.refreshFromServer();
    return this.listCustoms();
  }

  listCustoms(): CustomDrip[] {
    return Object.entries(this.customs).map(([name, recipe]) => ({ name, recipe }));
  }

  private async persistSave(name: string, recipe: string): Promise<void> {
    const id = this.ids[name];
    const saved = await getClient().drips.save({ name, data: { recipe }, ...(id ? { id } : {}) });
    this.ids[name] = saved.id;
    const savedRecipe = (saved.data as { recipe?: string } | null)?.recipe;
    if (typeof savedRecipe === "string") this.customs[name] = savedRecipe;
  }

  /** Optimistic save for the `.drip save` command (execute()) — updates the
   *  cache now, writes to the server in the background. */
  saveCustom(name: string, recipe: string): string {
    this.customs[name] = recipe;
    void this.persistSave(name, recipe).catch(() => {});
    return `saved drip "${name}" → ${recipe}`;
  }

  /** Awaitable save for the Drips tab IPC — server-confirmed before returning. */
  async saveCustomAsync(name: string, recipe: string): Promise<string> {
    this.customs[name] = recipe;
    try { await this.persistSave(name, recipe); return `saved drip "${name}"`; }
    catch (err) { return `failed to save drip "${name}": ${err instanceof Error ? err.message : String(err)}`; }
  }

  private async persistDelete(name: string): Promise<void> {
    const id = this.ids[name];
    delete this.customs[name];
    delete this.ids[name];
    if (id) await getClient().drips.delete(id);
  }

  /** Optimistic delete for the command path. */
  deleteCustom(name: string): string {
    if (!(name in this.customs)) return `no custom drip "${name}"`;
    void this.persistDelete(name).catch(() => {});
    return `deleted drip "${name}"`;
  }

  /** Awaitable delete for the Drips tab IPC. */
  async deleteCustomAsync(name: string): Promise<string> {
    if (!(name in this.customs)) return `no custom drip "${name}"`;
    try { await this.persistDelete(name); return `deleted drip "${name}"`; }
    catch (err) { return `failed to delete drip "${name}": ${err instanceof Error ? err.message : String(err)}`; }
  }

  isEffect(name: string): boolean {
    return name in ONE_SHOT_EFFECTS || name in this.customs;
  }

  /** Parse and execute a drip command. Returns status string.
   *  `.drip .` (leading "." arg) plays IN-APP (windowed over the yo window);
   *  otherwise the effect plays FULL-SCREEN over every app (OS overlay). */
  execute(args: string[]): string {
    let fullscreen = true;
    if (args.length > 0 && args[0] === ".") { fullscreen = false; args = args.slice(1); }

    if (args.length === 0) { this.fireOneShot("fireworks", -1, fullscreen); return ""; }

    const sub = args[0].toLowerCase();

    if (sub === "save" && args.length >= 3) {
      return this.saveCustom(args[1].toLowerCase(), args.slice(2).join(" "));
    }
    if (sub === "delete" && args[1]) {
      return this.deleteCustom(args[1].toLowerCase());
    }
    if (sub === "list") {
      const customs = this.listCustoms();
      const built = BUILTIN_EFFECTS.join(", ");
      const custom = customs.length ? customs.map(c => `${c.name} → ${c.recipe}`).join(", ") : "(none)";
      return `effects: ${built}\ncustom: ${custom}`;
    }
    if (sub === "stop") {
      this.stopAll();
      return "stopped all persistent effects";
    }

    // Check if first non-number arg is a custom
    if (args.length === 1 && this.customs[sub]) {
      return this.executeRaw(this.customs[sub], fullscreen);
    }

    return this.executeRaw(args.join(" "), fullscreen);
  }

  /** Parse raw drip string: [count] [effects...] or [-1] [opacity] [effects...] */
  private executeRaw(raw: string, fullscreen: boolean): string {
    const parts = raw.trim().split(/\s+/);
    let count = 1;
    let opacity = -1;
    const effects: string[] = [];

    for (const p of parts) {
      const n = parseFloat(p);
      if (p === "-1") { count = -1; }
      else if (!isNaN(n) && n > 0 && n < 1) { opacity = n; }
      else if (!isNaN(n) && Number.isInteger(n) && n > 0) { count = Math.min(n, 10); }
      else {
        const name = p.toLowerCase();
        if (this.customs[name]) {
          effects.push(...this.resolveCustomEffects(name));
        } else {
          effects.push(name);
        }
      }
    }

    if (effects.length === 0) effects.push("fireworks");

    if (count === -1) {
      const op = opacity > 0 ? opacity : 0.5;
      for (const effect of effects) this.firePersistent(effect, op, fullscreen);
      return `drip: ${effects.join(" + ")} constant`;
    }

    for (let i = 0; i < count; i++) {
      for (let j = 0; j < effects.length; j++) {
        const delay = (i * effects.length + j) * 1500;
        const eff = effects[j];
        const op = opacity > 0 ? opacity : -1;
        setTimeout(() => this.fireOneShot(eff, op, fullscreen), delay);
      }
    }

    return count > 1 ? `drip: ${effects.join(" + ")} x${count}` : `drip: ${effects.join(" + ")}`;
  }

  private resolveCustomEffects(name: string): string[] {
    const recipe = this.customs[name];
    if (!recipe) return [name];
    return recipe.split(/\s+/).filter(p => {
      const n = parseFloat(p);
      return isNaN(n) || (n >= 1 && Number.isInteger(n));
    }).filter(p => p !== "-1");
  }

  // Full screen of the display under the cursor (where the user is working).
  private displayBounds(): Electron.Rectangle {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds;
  }

  private overlayBounds(fullscreen: boolean): Electron.Rectangle | null {
    if (fullscreen) return this.displayBounds();
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return null;
    return this.mainWindow.getBounds();
  }

  private fireOneShot(effect: string, opacity = -1, fullscreen = false): void {
    const bounds = this.overlayBounds(fullscreen);
    if (!bounds) return;
    let html = this.buildOneShotHtml(effect, bounds.width, bounds.height);
    if (opacity > 0) html = html.replace("<body>", `<body style="opacity:${opacity}">`);
    const overlay = this.createOverlay(bounds, fullscreen);
    overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    overlay.webContents.on("console-message", (_e, _level, msg) => {
      if (msg === "__drip_close__" && !overlay.isDestroyed()) overlay.close();
    });
    const safetyMs = effect === "timme" ? 17000 : 8000;
    setTimeout(() => { if (!overlay.isDestroyed()) overlay.close(); }, safetyMs);
  }

  private firePersistent(effect: string, opacity: number, fullscreen = false): void {
    const existing = this.persistent.get(effect);
    if (existing && !existing.isDestroyed()) {
      existing.close();
      this.persistent.delete(effect);
      return;
    }
    const bounds = this.overlayBounds(fullscreen);
    if (!bounds) return;
    const html = this.buildLoopHtml(effect, bounds.width, bounds.height, opacity);
    const overlay = this.createOverlay(bounds, fullscreen);
    overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    overlay.on("closed", () => this.persistent.delete(effect));
    this.persistent.set(effect, overlay);
  }

  stopAll(): void {
    for (const ov of this.persistent.values()) { if (!ov.isDestroyed()) ov.close(); }
    this.persistent.clear();
  }

  cleanup(): void { this.stopAll(); }

  private createOverlay(bounds: Electron.Rectangle, fullscreen = false): BrowserWindow {
    const overlay = new BrowserWindow({
      // Full-screen: a top-level window so it floats over EVERY app. Windowed:
      // parented to the yo window so it only shows inside the app.
      ...(fullscreen ? {} : { parent: this.mainWindow! }),
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
      frame: false, transparent: true, hasShadow: false, resizable: false,
      backgroundColor: "#00000000", skipTaskbar: true, show: false,
      ...(fullscreen ? { alwaysOnTop: true, focusable: false } : {}),
      // backgroundThrottling: false — stacked drips cover each other, and
      // Chromium's occlusion tracker would throttle the covered overlays'
      // requestAnimationFrame to ~1fps (the "first drip stalls when the
      // second layers in" bug). Never throttle an effect overlay.
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    if (fullscreen) {
      overlay.setAlwaysOnTop(true, "screen-saver");
      overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    overlay.setIgnoreMouseEvents(true);
    overlay.once("ready-to-show", () => { if (!overlay.isDestroyed()) overlay.showInactive(); });
    return overlay;
  }

  private buildOneShotHtml(effect: string, w: number, h: number): string {
    const builder = ONE_SHOT_EFFECTS[effect] || ONE_SHOT_EFFECTS.fireworks;
    return builder(w, h);
  }

  private buildLoopHtml(effect: string, w: number, h: number, opacity: number): string {
    const builder = LOOP_EFFECTS[effect];
    if (builder) return builder(w, h, opacity);
    const oneShot = ONE_SHOT_EFFECTS[effect] || ONE_SHOT_EFFECTS.fireworks;
    return oneShot(w, h);
  }
}
