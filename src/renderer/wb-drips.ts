/**
 * wb-drips.ts — the DRIPS workpanel (his order, 2026-09-10: the dock card
 * opens a real panel, like every other workpanel app).
 *
 * Effects preview WINDOWED and time-bounded (main's drip-manager enforces
 * it); presets persist to the local SQLite drips table via the drips-* IPC.
 */

interface BuiltinEffect { name: string; kind: "one-shot" | "loop" }
interface CustomDrip { name: string; recipe: string }

const api = () => (window as unknown as { glyphh?: {
  dripsList?: () => Promise<CustomDrip[]>;
  dripsSave?: (name: string, recipe: string) => Promise<string>;
  dripsDelete?: (name: string) => Promise<string>;
  dripsPreview?: (recipe: string) => Promise<string>;
  dripsBuiltinEffects?: () => Promise<BuiltinEffect[]>;
  dripsStop?: () => Promise<string>;
  dripsRunning?: () => Promise<string[]>;
} }).glyphh ?? {};

export interface DripsHost {
  confirm: (opts: { title: string; body?: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function renderDripsIntoSlot(body: HTMLElement, host: DripsHost): Promise<void> {
  body.classList.add("ws-drips-body");
  body.innerHTML = `
    <div class="ws-drips">
      <div class="ws-drips-head">
        <h2>Drips</h2>
        <span class="ws-drips-sub">Visual effects — click to preview; save your own recipes. <code>.drip &lt;effect&gt;</code> works everywhere.</span>
        <button type="button" class="action-btn ws-drips-stop">Stop all</button>
      </div>
      <div class="ws-drips-sect">Effects</div>
      <div class="ws-drips-grid" data-role="builtins"></div>
      <div class="ws-drips-sect">My drips</div>
      <div class="ws-drips-customs" data-role="customs"></div>
      <form class="ws-drips-form">
        <input type="text" class="settings-input" data-role="name" placeholder="name" spellcheck="false" autocomplete="off" />
        <input type="text" class="settings-input" data-role="recipe" placeholder="recipe — e.g. 3 fireworks confetti" spellcheck="false" autocomplete="off" />
        <button type="submit" class="action-btn primary">Save</button>
      </form>
      <div class="ws-drips-status" data-role="status"></div>
    </div>`;

  const q = <T extends HTMLElement>(sel: string): T | null => body.querySelector<T>(sel);
  const status = (msg: string): void => { const el = q<HTMLElement>('[data-role="status"]'); if (el) el.textContent = msg; };

  if (!body.isConnected && !body.closest("body")) return;

  body.querySelector<HTMLButtonElement>(".ws-drips-stop")?.addEventListener("click", () => {
    void api().dripsStop?.().then((r) => status(r || "stopped"));
  });

  const builtins = (await api().dripsBuiltinEffects?.().catch(() => [])) ?? [];
  const grid = q<HTMLElement>('[data-role="builtins"]');
  if (grid) {
    grid.innerHTML = builtins.length
      ? builtins.map((b) => `<button type="button" class="ws-drips-fx" data-fx="${esc(b.name)}" title="${b.kind === "loop" ? "looping effect" : "one-shot"}">${esc(b.name)}${b.kind === "loop" ? " ∞" : ""}</button>`).join("")
      : `<div class="ws-drips-empty">No effects available.</div>`;
    grid.addEventListener("click", (ev) => {
      const b = (ev.target as HTMLElement).closest<HTMLElement>(".ws-drips-fx");
      if (!b?.dataset.fx) return;
      void api().dripsPreview?.(b.dataset.fx).then((r) => status(r || ""));
    });
  }

  const renderCustoms = async (): Promise<void> => {
    const rows = (await api().dripsList?.().catch(() => [])) ?? [];
    const wrap = q<HTMLElement>('[data-role="customs"]');
    if (!wrap) return;
    wrap.innerHTML = rows.length
      ? rows.map((c) => `
        <div class="ws-drips-row" data-name="${esc(c.name)}">
          <button type="button" class="ws-drips-fx" data-fx="${esc(c.recipe)}" title="preview">${esc(c.name)}</button>
          <span class="ws-drips-recipe">${esc(c.recipe)}</span>
          <button type="button" class="ws-drips-del" title="Delete">✕</button>
        </div>`).join("")
      : `<div class="ws-drips-empty">No saved drips yet — name a recipe below.</div>`;
  };
  q<HTMLElement>('[data-role="customs"]')?.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    const row = t.closest<HTMLElement>(".ws-drips-row");
    if (!row?.dataset.name) return;
    if (t.closest(".ws-drips-del")) {
      void host.confirm({ title: `Delete drip "${row.dataset.name}"?`, danger: true, confirmLabel: "Delete" }).then((yes) => {
        if (!yes) return;
        void api().dripsDelete?.(row.dataset.name!).then((r) => { status(r || ""); void renderCustoms(); });
      });
      return;
    }
    const fx = t.closest<HTMLElement>(".ws-drips-fx")?.dataset.fx;
    if (fx) void api().dripsPreview?.(fx).then((r) => status(r || ""));
  });

  body.querySelector<HTMLFormElement>(".ws-drips-form")?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const name = q<HTMLInputElement>('[data-role="name"]')?.value.trim().toLowerCase() ?? "";
    const recipe = q<HTMLInputElement>('[data-role="recipe"]')?.value.trim() ?? "";
    if (!name || !recipe) { status("a drip needs a name and a recipe"); return; }
    void api().dripsSave?.(name, recipe).then((r) => {
      status(r || "");
      const n = q<HTMLInputElement>('[data-role="name"]'); if (n) n.value = "";
      const rc = q<HTMLInputElement>('[data-role="recipe"]'); if (rc) rc.value = "";
      void renderCustoms();
    });
  });

  await renderCustoms();
}
