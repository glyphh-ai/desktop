/**
 * settings-loops.ts — LOOPS AS SETTINGS (his ruling, 2026-09-12: "they are
 * fixed settings -> loops").
 *
 * A loop is CONFIG, not a record anyone creates. The same fixed set always
 * exists — there is no New and no Delete. Two surfaces, one accordion:
 *
 *   Settings -> Loops        the member's own: turn a loop on and configure
 *                            it. Only loops the org -> role policy allows are
 *                            listed at all.
 *   Organization -> Loops    the org's support list. Off here is off for
 *                            every member, whatever their role says.
 *
 * The header carries the name and the toggle on the far right; expanding
 * shows that loop's configuration — the shape the model catalog uses.
 */


/** A loop the caller may use, as /api/loops/available resolves it. */
interface AvailableLoop {
  cli: string;
  name: string;
  provider: string;
  /** The role's default model for this loop; "" = the CLI's own. */
  model: string;
  isDefault: boolean;
}

/** The org's support row, as /api/org/loops lists it. */
interface OrgLoop { cli: string; name: string; provider: string; enabled: boolean }

/** The member's local config for one loop. */
interface LoopConfig {
  id: string;
  name: string;
  cli: string;
  cmd: string;
  model: string;
  mcp: boolean;
  cwd: string;
  session: string;
  permission?: string;
  apiKey: { name: string; hint: string } | null;
  enabled?: boolean;
}

const api = () => window.glyphh as unknown as {
  loopsAvailable?: () => Promise<{ ok: boolean; data?: AvailableLoop[]; error?: string }>;
  orgLoopsList?: () => Promise<{ ok: boolean; data?: OrgLoop[]; error?: string }>;
  orgLoopSet?: (cli: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
  cliAgentsList?: () => Promise<{ ok: boolean; agents: LoopConfig[] }>;
  cliAgentsSave?: (input: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
  layoutsPickFolder?: () => Promise<string | null>;
  workspacesModelCatalog?: () => Promise<{ ok: boolean; models?: Array<{ id: string; name: string; providerSlug?: string }> }>;
};

const el = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

function fail(hostId: string, msg: string): void {
  const e = el(hostId);
  if (!e) return;
  e.textContent = msg;
  e.classList.toggle("hidden", !msg);
}

/** The accordion row: a header that expands, with a toggle pinned right. */
function row(
  title: string, sub: string, on: boolean,
  onToggle: (v: boolean) => void,
  body: (host: HTMLElement) => void,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "loop-acc";
  const head = document.createElement("div");
  head.className = "loop-acc-head";
  head.innerHTML = `
    <svg class="loop-acc-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
    <span class="loop-acc-name"></span>
    <span class="loop-acc-sub"></span>
    <span class="loop-acc-spacer"></span>`;
  (head.querySelector(".loop-acc-name") as HTMLElement).textContent = title;
  (head.querySelector(".loop-acc-sub") as HTMLElement).textContent = sub;

  const sw = document.createElement("label");
  sw.className = "settings-toggle loop-acc-toggle";
  sw.innerHTML = `<input type="checkbox" /><span class="toggle-switch"></span>`;
  const box = sw.querySelector("input") as HTMLInputElement;
  box.checked = on;
  // The toggle is NOT the expander — clicking it must never open the row.
  sw.addEventListener("click", (e) => e.stopPropagation());
  box.addEventListener("change", () => onToggle(box.checked));
  head.appendChild(sw);

  const panel = document.createElement("div");
  panel.className = "loop-acc-body hidden";
  let built = false;
  head.addEventListener("click", () => {
    const open = panel.classList.toggle("hidden");
    wrap.classList.toggle("open", !open);
    // Build on FIRST open — a page of five collapsed forms is five model
    // lists nobody asked for.
    if (!built && !open) { built = true; body(panel); }
  });
  wrap.append(head, panel);
  return wrap;
}

// ── Settings → Loops (the member's own) ──────────────────────────────────────

let models: Array<{ id: string; name: string; providerSlug?: string }> = [];

export async function loadSettingsLoops(): Promise<void> {
  const host = el("loops-accordion");
  if (!host) return;
  host.innerHTML = `<div class="crud-empty">Loading…</div>`;
  fail("loops-error", "");

  const [availRes, cfgRes, catalog] = await Promise.all([
    api().loopsAvailable?.().catch(() => null) ?? Promise.resolve(null),
    api().cliAgentsList?.().catch(() => null) ?? Promise.resolve(null),
    api().workspacesModelCatalog?.().catch(() => null) ?? Promise.resolve(null),
  ]);
  models = catalog?.ok ? catalog.models ?? [] : [];
  const allowed = availRes?.ok ? availRes.data ?? [] : [];
  const configs = new Map((cfgRes?.ok ? cfgRes.agents : []).map((c) => [c.cli, c]));

  host.innerHTML = "";
  if (!allowed.length) {
    host.innerHTML = `<div class="crud-empty">No loops are available to you — your organization hasn't turned any on, or your role doesn't allow them.</div>`;
    return;
  }
  for (const loop of allowed) {
    const cfg = configs.get(loop.cli);
    const sub = loop.isDefault ? "Default" : "";
    host.appendChild(row(
      loop.name, sub, cfg?.enabled !== false,
      (v) => { void save(loop.cli, { enabled: v }); },
      (panel) => buildConfigForm(panel, loop, cfg),
    ));
  }
}

/** One field at a time — main PATCHES an existing loop, so a toggle does not
 *  have to post the whole row back. */
async function save(cli: string, patch: Record<string, unknown>): Promise<void> {
  const r = await api().cliAgentsSave?.({ id: cli, cli, ...patch });
  if (r && !r.ok) fail("loops-error", r.error || "couldn't save that loop");
}

/** One loop's configuration. The fields the old Loops → edit form carried,
 *  minus the ones a FIXED loop can't have: no name, no CLI picker, no
 *  delete. */
function buildConfigForm(panel: HTMLElement, loop: AvailableLoop, cfg: LoopConfig | undefined): void {
  const cli = loop.cli;
  const mk = (html: string): HTMLElement => {
    const d = document.createElement("div");
    d.innerHTML = html;
    return d.firstElementChild as HTMLElement;
  };

  // MODEL — the role's allowed models for this loop's provider. The role's
  // own default is the first option, so "unset" means "what my role says".
  const modelLabel = mk(`<label class="settings-label">Model</label>`);
  const modelSel = document.createElement("select");
  modelSel.className = "settings-input";
  const pool = models.filter((m) => !loop.provider || m.providerSlug === loop.provider);
  const list = pool.length ? pool : models;
  const roleDefault = document.createElement("option");
  roleDefault.value = "";
  roleDefault.textContent = loop.model
    ? `Your role's default — ${models.find((m) => m.id === loop.model)?.name ?? loop.model}`
    : "The CLI's own default";
  modelSel.appendChild(roleDefault);
  for (const m of list) {
    const o = document.createElement("option");
    o.value = m.id;
    o.textContent = m.name || m.id;
    modelSel.appendChild(o);
  }
  modelSel.value = cfg?.model ?? "";
  modelSel.addEventListener("change", () => void save(cli, { model: modelSel.value }));

  // COMMAND
  const cmdLabel = mk(`<label class="settings-label">Command <span class="settings-hint-inline">what the terminal runs — flags welcome</span></label>`);
  const cmd = document.createElement("input");
  cmd.type = "text";
  cmd.className = "settings-input";
  cmd.spellcheck = false;
  cmd.value = cfg?.cmd ?? cli;
  cmd.addEventListener("change", () => void save(cli, { cmd: cmd.value }));

  // WORKING FOLDER
  const cwdLabel = mk(`<label class="settings-label" style="margin-top:14px;">Working folder</label>`);
  const cwdHint = mk(`<div class="settings-hint" style="margin:-2px 0 8px;">Opening this loop starts its terminal here. Empty uses the current folder.</div>`);
  const cwdRow = mk(`<div class="layout-folder-row"></div>`);
  const cwd = document.createElement("input");
  cwd.className = "settings-input";
  cwd.readOnly = true;
  cwd.style.cursor = "pointer";
  cwd.placeholder = "No folder — uses the current one";
  cwd.value = cfg?.cwd ?? "";
  const pick = mk(`<button type="button" class="layout-folder-icon" title="Choose folder"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></button>`);
  const clear = mk(`<button type="button" class="layout-folder-icon" title="Clear"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button>`);
  const choose = (): void => {
    void api().layoutsPickFolder?.().then((dir) => {
      if (!dir) return;
      cwd.value = dir;
      void save(cli, { cwd: dir });
    });
  };
  cwd.addEventListener("click", choose);
  pick.addEventListener("click", choose);
  clear.addEventListener("click", () => { cwd.value = ""; void save(cli, { cwd: "" }); });
  cwdRow.append(cwd, pick, clear);

  // SESSION + PERMISSION
  const sessLabel = mk(`<label class="settings-label" style="margin-top:14px;">Session</label>`);
  const sess = document.createElement("select");
  sess.className = "settings-input";
  sess.innerHTML = `
    <option value="keep">Keep the current session</option>
    <option value="new">Start a new session</option>
    <option value="last">Resume the last session</option>`;
  sess.value = cfg?.session ?? "keep";
  sess.addEventListener("change", () => void save(cli, { session: sess.value }));

  const permLabel = mk(`<label class="settings-label" style="margin-top:14px;">Permissions</label>`);
  const permHint = mk(`<div class="settings-hint" style="margin:-2px 0 6px;">One Glyphh vocabulary, enforced by the CLI's own controls.</div>`);
  const perm = document.createElement("select");
  perm.className = "settings-input";
  perm.innerHTML = `
    <option value="safe">Safe — read &amp; plan only</option>
    <option value="ask">Ask — the CLI's own prompting</option>
    <option value="auto">Auto — run without prompting</option>`;
  perm.value = cfg?.permission ?? "ask";
  perm.addEventListener("change", () => void save(cli, { permission: perm.value }));

  // MCP
  const mcp = mk(`<label class="settings-toggle set-pref-row" style="margin-top:14px;">
      <div class="set-pref-text"><div class="set-pref-title">Connect Glyphh tools (MCP)</div></div>
      <input type="checkbox" /><span class="toggle-switch"></span>
    </label>`);
  const mcpBox = mcp.querySelector("input") as HTMLInputElement;
  mcpBox.checked = cfg?.mcp !== false;
  mcpBox.addEventListener("change", () => void save(cli, { mcp: mcpBox.checked }));

  panel.append(modelLabel, modelSel, cmdLabel, cmd, cwdLabel, cwdHint, cwdRow,
    sessLabel, sess, permLabel, permHint, perm, mcp);
}

// ── Organization → Loops (the org's support list) ────────────────────────────

export async function loadOrgLoops(): Promise<void> {
  const host = el("org-loops-accordion");
  if (!host) return;
  host.innerHTML = `<div class="crud-empty">Loading…</div>`;
  fail("org-loops-error", "");

  const res = await api().orgLoopsList?.().catch(() => null) ?? null;
  if (!res?.ok) {
    host.innerHTML = "";
    fail("org-loops-error", res?.error || "couldn't load the organization's loops");
    return;
  }
  host.innerHTML = "";
  for (const loop of res.data ?? []) {
    host.appendChild(row(
      loop.name, loop.provider, loop.enabled,
      (v) => {
        void api().orgLoopSet?.(loop.cli, v).then((r) => {
          if (r && !r.ok) { fail("org-loops-error", r.error || "couldn't change that loop"); void loadOrgLoops(); }
        });
      },
      (panel) => {
        panel.innerHTML = `<p class="settings-hint">Members configure this loop for themselves in Settings → Loops. Turning it off here removes it from everyone, whatever their role allows.</p>`;
      },
    ));
  }
}

// ── Settings → General: the agent defaults ───────────────────────────────────

/**
 * The default LOOP and MODEL a new session opens with.
 *
 * Both lists come from the org → role policy, so neither can name something
 * the member may not use. "Use my role's default" is the first option in each
 * and the stored value for it is "" — that way a policy change follows the
 * member automatically instead of freezing whatever was true the day they
 * last opened this page.
 */
export async function loadAgentDefaults(): Promise<void> {
  const loopSel = el<HTMLSelectElement>("set-default-loop");
  const modelSel = el<HTMLSelectElement>("set-default-model");
  const hint = el("set-default-hint");
  if (!loopSel || !modelSel) return;

  const prefs = window.glyphh as unknown as {
    getPreference?: (k: string, d: unknown) => Promise<unknown>;
    setPreference?: (k: string, v: unknown) => void;
  };
  const [availRes, catalog, savedLoop, savedModel] = await Promise.all([
    api().loopsAvailable?.().catch(() => null) ?? Promise.resolve(null),
    api().workspacesModelCatalog?.().catch(() => null) ?? Promise.resolve(null),
    prefs.getPreference?.("defaultLoop", "") ?? Promise.resolve(""),
    prefs.getPreference?.("defaultModel", "") ?? Promise.resolve(""),
  ]);
  const loops = availRes?.ok ? availRes.data ?? [] : [];
  models = catalog?.ok ? catalog.models ?? [] : [];

  if (!loops.length) {
    loopSel.innerHTML = `<option value="">No loops available</option>`;
    modelSel.innerHTML = `<option value="">No loops available</option>`;
    loopSel.disabled = true;
    modelSel.disabled = true;
    if (hint) hint.textContent = "Your organization hasn't turned on any loops, or your role doesn't allow them.";
    return;
  }
  loopSel.disabled = false;
  modelSel.disabled = false;

  const roleLoop = loops.find((l) => l.isDefault) ?? loops[0]!;
  loopSel.innerHTML = "";
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = `Use my role's default — ${roleLoop.name}`;
  loopSel.appendChild(auto);
  for (const l of loops) {
    const o = document.createElement("option");
    o.value = l.cli;
    o.textContent = l.name;
    loopSel.appendChild(o);
  }
  const wantLoop = String(savedLoop ?? "");
  loopSel.value = loops.some((l) => l.cli === wantLoop) ? wantLoop : "";

  /** The model list follows whichever loop is selected. */
  const paintModels = (selected: string): void => {
    const active = loops.find((l) => l.cli === (loopSel.value || roleLoop.cli)) ?? roleLoop;
    const pool = models.filter((m) => !active.provider || m.providerSlug === active.provider);
    const list = pool.length ? pool : models;
    modelSel.innerHTML = "";
    const inherit = document.createElement("option");
    inherit.value = "";
    inherit.textContent = active.model
      ? `Use my role's default — ${models.find((m) => m.id === active.model)?.name ?? active.model}`
      : `Use ${active.name}'s own default`;
    modelSel.appendChild(inherit);
    for (const m of list) {
      const o = document.createElement("option");
      o.value = m.id;
      o.textContent = m.name || m.id;
      modelSel.appendChild(o);
    }
    modelSel.value = list.some((m) => m.id === selected) ? selected : "";
    if (hint) {
      hint.textContent = `A new workspace and a fresh agent panel open with ${active.name}`
        + `${modelSel.value ? ` on ${list.find((m) => m.id === modelSel.value)?.name ?? modelSel.value}` : ""}.`;
    }
  };
  paintModels(String(savedModel ?? ""));

  loopSel.addEventListener("change", () => {
    prefs.setPreference?.("defaultLoop", loopSel.value);
    // A model from the previous loop's vendor is meaningless under the new
    // one — reset rather than silently keeping an unreachable binding.
    prefs.setPreference?.("defaultModel", "");
    paintModels("");
  });
  modelSel.addEventListener("change", () => {
    prefs.setPreference?.("defaultModel", modelSel.value);
    paintModels(modelSel.value);
  });
}
