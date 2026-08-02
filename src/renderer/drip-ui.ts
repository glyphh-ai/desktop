// drip-ui.ts — Drip effects system extracted from renderer.ts

const DRIP_COLORS = ["#ff0", "#f0f", "#0ff", "#f44", "#4f4", "#ff6600", "#ff00ff", "#00ffcc"];

const EFFECT_EMOJI: Record<string, string> = {
  fireworks: "🎆", hearts: "❤️", confetti: "🎊", stars: "⭐",
  rain: "🌧️", bubbles: "🫧", sparkle: "✨", spiral: "🌀",
  emoji: "😀", wave: "🌊", thumbsup: "👍", peace: "✌️",
  cat: "🐱", matrix: "🟩", aurora: "🌌", nebula: "💜",
  plasma: "🔮", fireflies: "🪲", starfield: "🌠",
};

function dripFireworks() {
  const overlay = document.createElement("div");
  overlay.className = "drip-overlay";
  document.body.appendChild(overlay);

  const bursts = [
    { x: window.innerWidth * 0.5, y: window.innerHeight * 0.4 },
    { x: window.innerWidth * 0.25, y: window.innerHeight * 0.35 },
    { x: window.innerWidth * 0.75, y: window.innerHeight * 0.35 },
  ];

  interface Particle { el: HTMLElement; x: number; y: number; vx: number; vy: number; life: number }
  const particles: Particle[] = [];

  bursts.forEach((burst, bi) => {
    setTimeout(() => {
      for (let i = 0; i < 50; i++) {
        const el = document.createElement("div");
        const size = 3 + Math.random() * 5;
        el.style.cssText = `position:absolute;border-radius:50%;width:${size}px;height:${size}px;background:${DRIP_COLORS[Math.floor(Math.random() * DRIP_COLORS.length)]};`;
        overlay.appendChild(el);
        const angle = Math.random() * Math.PI * 2;
        const speed = 2 + Math.random() * 6;
        particles.push({
          el, x: burst.x, y: burst.y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 3,
          life: 1,
        });
      }
    }, bi * 300);
  });

  function animate() {
    let alive = false;
    for (const p of particles) {
      if (p.life <= 0) continue;
      alive = true;
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.08;
      p.life -= 0.012;
      p.el.style.left = `${p.x}px`;
      p.el.style.top = `${p.y}px`;
      p.el.style.opacity = String(Math.max(0, p.life));
    }
    if (alive) requestAnimationFrame(animate);
    else overlay.remove();
  }
  requestAnimationFrame(animate);
}

function playDrip(effect: string) {
  switch (effect) {
    case "fireworks": dripFireworks(); break;
    default: dripFireworks(); break;
  }
}

function makeDripTile(name: string, recipe: string, emoji: string, closePicker: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "drip-picker-tile";
  btn.innerHTML = `<span class="drip-tile-icon">${emoji}</span><span class="drip-tile-label">${name}</span>`;
  btn.addEventListener("click", () => {
    window.glyphh.dripsPreview(recipe);
    closePicker();
  });
  return btn;
}

export function initDrip(): { openDripPicker: () => void; closeDripPicker: () => void } {
  // Register drip effect handler — this must stay wired unconditionally: it's
  // how .drip commands (from the command center) render their in-app effect,
  // independent of the manual picker UI below.
  window.glyphh.onDripEffect(playDrip);

  // DOM elements for the manual picker — these lived inside the now-removed
  // #yo-panel markup, so the picker has no UI home right now. Skip wiring it
  // rather than crash; .drip/.dip commands still work via the handler above.
  const dripPickerEl = document.getElementById("drip-picker");
  const dripPickerBuiltinEl = document.getElementById("drip-picker-builtin");
  const dripPickerCustomEl = document.getElementById("drip-picker-custom");
  const dripPickerDividerEl = document.getElementById("drip-picker-custom-divider");
  const dripBtnEl = document.getElementById("yo-panel-drip");
  if (!dripPickerEl || !dripPickerBuiltinEl || !dripPickerCustomEl || !dripPickerDividerEl || !dripBtnEl) {
    return { openDripPicker: () => {}, closeDripPicker: () => {} };
  }
  const dripPicker = dripPickerEl;
  const dripPickerBuiltin = dripPickerBuiltinEl;
  const dripPickerCustom = dripPickerCustomEl;
  const dripPickerDivider = dripPickerDividerEl;
  const dripBtn = dripBtnEl;
  let dripPickerOpen = false;

  async function populateDripPicker() {
    dripPickerBuiltin.innerHTML = "";
    dripPickerCustom.innerHTML = "";
    const [builtins, customs] = await Promise.all([
      window.glyphh.dripsBuiltinEffects().catch(() => [] as string[]),
      window.glyphh.dripsList().catch(() => [] as Array<{ name: string; recipe: string }>),
    ]);
    for (const name of builtins) {
      dripPickerBuiltin.appendChild(makeDripTile(name, name, EFFECT_EMOJI[name] || "🎨", closeDripPicker));
    }
    if (customs.length > 0) {
      dripPickerDivider.style.display = "";
      for (const c of customs) {
        dripPickerCustom.appendChild(makeDripTile(c.name, c.recipe, "🎨", closeDripPicker));
      }
    } else {
      dripPickerDivider.style.display = "none";
    }
  }

  function openDripPicker() {
    populateDripPicker();
    // Open UPWARD as a tray above the input — that's where there's room to show
    // all the drips (the trigger lives in the workdir bar, but the tray belongs
    // down here above the composer).
    const inputWrap = document.querySelector(".yo-panel-input-wrap") as HTMLElement;
    const controls = document.querySelector(".yo-panel-controls") as HTMLElement;
    const offset = (inputWrap?.offsetHeight || 70) + (controls?.offsetHeight || 30) + 6;
    dripPicker.style.bottom = offset + "px";
    dripPicker.style.top = "auto";
    dripPicker.classList.remove("hidden");
    requestAnimationFrame(() => dripPicker.classList.add("visible"));
    dripPickerOpen = true;
  }

  function closeDripPicker() {
    dripPicker.classList.remove("visible");
    dripPickerOpen = false;
    setTimeout(() => { if (!dripPickerOpen) dripPicker.classList.add("hidden"); }, 150);
  }

  dripBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (dripPickerOpen) closeDripPicker();
    else openDripPicker();
  });

  document.addEventListener("click", (e) => {
    if (dripPickerOpen && !dripPicker.contains(e.target as Node) && e.target !== dripBtn) {
      closeDripPicker();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && dripPickerOpen) closeDripPicker();
  });

  return { openDripPicker, closeDripPicker };
}
