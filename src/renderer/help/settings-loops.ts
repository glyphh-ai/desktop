/**
 * settings-loops.ts — Settings › Loops and the agent defaults in Settings ›
 * General.
 *
 * A loop is configuration, not a record anyone creates: Glyphh's own and the
 * vendor CLIs (Claude, Codex, Gemini, Cursor, Copilot) always exist, and the
 * member turns each on or off and sets how it opens — its model, command,
 * working folder, session, permission and the Glyphh tools (MCP). Main keeps
 * the record (cli-agents.ts, loops/<cli>/agent.json); this page only reads
 * the roster and patches one field at a time.
 *
 * Each row also says whether the CLI is installed on this machine, with the
 * two actions a missing or signed-out CLI needs: Install (the line to run,
 * copied) and Sign in (the CLI's own login, in the system terminal).
 */

import { confirmAction } from "./shared.js";
import { toastError, toastOk } from "./toast.js";
import type { CliAgentPatch, CliAgentRow, MissingCli } from "./cli-types.js";
import {
  CLI_GATEWAY_PREF, DEFAULT_LOOP_PREF, DEFAULT_VIEW_PREF, LOOP_BLURBS, LOOP_IDS, PERMISSION_LABELS, SESSION_LABELS,
  cliModelChoices, defaultViewOf, isVendorLoop, settle,
} from "./cli-loops.js";

interface Doors {
  cliAgentsList?: () => Promise<{ ok: boolean; agents: CliAgentRow[]; gatewayDefault?: boolean; gatewayReady?: boolean; error?: string }>;
  cliAgentsSave?: (patch: CliAgentPatch) => Promise<{ ok: boolean; agent?: CliAgentRow; error?: string }>;
  cliAgentsMissing?: () => Promise<{ ok: boolean; missing: Record<string, MissingCli | null>; error?: string }>;
  cliLogin?: (cli: string) => Promise<{ ok: true; data: { command: string } } | { ok: false; error: string }>;
  layoutsPickFolder?: () => Promise<string | null>;
  loopModels?: (loopId: string, force?: boolean) => Promise<{ ok: boolean; models: Array<{ id: string; name: string; providerSlug: string; utility?: boolean }> }>;
  copyToClipboard?: (text: string) => Promise<unknown> | void;
  getPreference?: (k: string, d?: unknown) => Promise<unknown>;
  setPreference?: (k: string, v: unknown) => void;
}
const doors = (): Doors => (window.glyphh ?? {}) as unknown as Doors;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;
const h = (tag: string, cls?: string, text?: string): HTMLElement => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const button = (label: string, cls = "action-btn"): HTMLButtonElement => {
  const b = h("button", cls, label) as HTMLButtonElement;
  b.type = "button";
  return b;
};
function select(options: Array<{ value: string; label: string }>, value: string, onChange: (v: string) => void): HTMLSelectElement {
  const s = h("select", "settings-input") as HTMLSelectElement;
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    s.appendChild(opt);
  }
  s.value = value;
  s.addEventListener("change", () => onChange(s.value));
  return s;
}
function prefRow(title: string, desc: string, control: HTMLElement): HTMLElement {
  const row = h("div", "set-pref-row");
  const text = h("div", "set-pref-text");
  text.appendChild(h("div", "set-pref-title", title));
  if (desc) text.appendChild(h("div", "set-pref-desc", desc));
  const value = h("div", "set-pref-value");
  value.appendChild(control);
  row.append(text, value);
  return row;
}

function showError(msg: string): void {
  const e = $("loops-error");
  if (!e) return;
  e.textContent = msg;
  e.classList.toggle("hidden", !msg);
}

/** The accordion row: a header that expands, with the on/off toggle pinned
 *  right. The body builds on first open — six collapsed forms are six model
 *  lists nobody asked for. */
function accordion(title: string, sub: string, on: boolean, toggleLocked: string | null, onToggle: (v: boolean) => void, body: (host: HTMLElement) => void): HTMLElement {
  const wrap = h("div", "loop-acc");
  const head = h("div", "loop-acc-head");
  head.innerHTML = `<svg class="loop-acc-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;
  head.append(h("span", "loop-acc-name", title), h("span", "loop-acc-sub", sub), h("span", "loop-acc-spacer"));
  const sw = h("label", "settings-toggle ws-model-allow loop-acc-toggle");
  sw.innerHTML = `<input type="checkbox" /><span class="toggle-switch"></span>`;
  const box = sw.querySelector("input") as HTMLInputElement;
  box.checked = on;
  box.disabled = !!toggleLocked;
  if (toggleLocked) sw.title = toggleLocked;
  // The toggle is not the expander.
  sw.addEventListener("click", (e) => e.stopPropagation());
  box.addEventListener("change", () => onToggle(box.checked));
  head.appendChild(sw);
  const panel = h("div", "loop-acc-body hidden");
  let built = false;
  head.addEventListener("click", () => {
    const closed = panel.classList.toggle("hidden");
    wrap.classList.toggle("open", !closed);
    if (!closed && !built) { built = true; body(panel); }
  });
  wrap.append(head, panel);
  return wrap;
}

// ── Settings › Loops ─────────────────────────────────────────────────────────

let rows: CliAgentRow[] = [];
let missing: Record<string, MissingCli | null> = {};
/** The router's chat models, for Glyphh's own model field. */
let routerModels: Array<{ id: string; name: string; providerSlug: string }> = [];

async function save(patch: CliAgentPatch): Promise<boolean> {
  const r: { ok: boolean; agent?: CliAgentRow; error?: string } | undefined = await doors().cliAgentsSave?.(patch)
    .catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  if (!r) return false;
  if (!r.ok) { showError(r.error || "That loop could not be saved."); return false; }
  showError("");
  if (r.agent) rows = rows.map((x) => (x.id === r.agent!.id ? r.agent! : x));
  return true;
}

/** The install dialog: the line to run, copied by the primary button. */
async function askInstall(m: MissingCli): Promise<void> {
  const signIn = m.login ? ` Then sign in with \`${m.login}\`${m.note ? ` (${m.note})` : ""}.` : "";
  const body = m.install
    ? `${m.name} is not on this machine's PATH. Install it from a terminal: ${m.install}${signIn}`
    : `${m.name} is not on this machine's PATH. Install it and make sure a terminal can run it.`;
  const copy = await confirmAction({ title: `Install ${m.name}`, body, confirmLabel: m.install ? "Copy install command" : "OK", cancelLabel: "Close" });
  if (copy && m.install) { void doors().copyToClipboard?.(m.install); toastOk("Install command copied"); }
}

async function signIn(cli: string, name: string): Promise<void> {
  const r = await doors().cliLogin?.(cli).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
  if (!r) return;
  if (r.ok) toastOk(`${name}'s sign-in is open in the terminal`, { detail: r.data.command });
  else toastError(r.error || `${name}'s sign-in could not be opened.`);
}

export async function loadSettingsLoops(): Promise<void> {
  const host = $("loops-accordion");
  if (!host) return;
  showError("");
  const [list, miss, models] = await Promise.all([
    settle(doors().cliAgentsList?.(), null),
    settle(doors().cliAgentsMissing?.(), null),
    settle(doors().loopModels?.("glyphh"), null),
  ]);
  if (!list?.ok) { showError(list?.error || "The loops could not be read."); return; }
  rows = list.agents;
  missing = miss?.ok ? miss.missing : {};
  routerModels = models?.ok ? models.models.filter((m) => !m.utility) : [];
  host.textContent = "";
  const order = (id: string): number => { const i = (LOOP_IDS as readonly string[]).indexOf(id); return i < 0 ? LOOP_IDS.length : i; };
  for (const row of [...rows].sort((a, b) => order(a.id) - order(b.id))) {
    const gone = missing[row.id];
    const sub = gone ? "Not installed" : row.id === "glyphh" ? "Default · always on" : "";
    host.appendChild(accordion(
      row.name, sub, row.enabled,
      row.id === "glyphh" ? "Glyphh is the default loop and stays on." : null,
      (v) => { void save({ id: row.id, enabled: v }); },
      (panel) => buildForm(panel, row),
    ));
  }
}

/** One loop's configuration, one field per row, each saved as it changes. */
function buildForm(panel: HTMLElement, row: CliAgentRow): void {
  const id = row.id;
  panel.appendChild(h("p", "settings-hint", LOOP_BLURBS[id]));

  // INSTALLED / SIGNED IN — the two things a vendor CLI needs from its owner.
  if (isVendorLoop(row.cli)) {
    const gone = missing[id];
    const state = h("div", "loops-state");
    state.appendChild(h("span", gone ? "loops-state-missing" : "loops-state-ok", gone ? "Not installed on this machine" : "Installed"));
    if (gone) {
      const install = button("Install…");
      install.addEventListener("click", () => { void askInstall(gone); });
      state.appendChild(install);
    }
    const login = button("Sign in");
    login.title = "Opens the CLI's own sign-in in a terminal";
    login.addEventListener("click", () => { void signIn(row.cli, row.name); });
    state.appendChild(login);
    panel.appendChild(prefRow("This machine", "The CLI runs on its own login; sign in again when it expires.", state));
  }

  // MODEL — the CLI's own names (any name its --model takes is accepted), or
  // for Glyphh one of the chat models set up in Settings › Models.
  const choices = isVendorLoop(row.cli)
    ? cliModelChoices(row.cli).map((m) => ({ value: m.id, label: m.id ? `${m.name} (${m.id})` : m.name }))
    : [{ value: "", label: "Your default chat model" }, ...routerModels.map((m) => ({ value: m.id, label: `${m.name} · ${m.providerSlug}` }))];
  if (row.model && !choices.some((c) => c.value === row.model)) choices.push({ value: row.model, label: row.model });
  const model = select(choices, row.model, (v) => { void save({ id, model: v }); });
  panel.appendChild(prefRow("Model", isVendorLoop(row.cli) ? "What a session on this loop starts on; a session can pick another." : "What a Glyphh session starts on when it picks none.", model));

  // COMMAND — vendor CLIs only: Glyphh's terminal is the bundled CLI.
  if (isVendorLoop(row.cli)) {
    const cmd = h("input", "settings-input") as HTMLInputElement;
    cmd.type = "text";
    cmd.spellcheck = false;
    cmd.value = row.cmd;
    cmd.placeholder = row.cli;
    cmd.addEventListener("change", () => { void save({ id, cmd: cmd.value.trim() || row.cli }); });
    panel.appendChild(prefRow("Command", "The binary a terminal and a chat run — flags welcome.", cmd));
  }

  // WORKING FOLDER
  const folderRow = h("div", "layout-folder-row");
  const cwd = h("input", "settings-input") as HTMLInputElement;
  cwd.readOnly = true;
  cwd.style.cursor = "pointer";
  cwd.placeholder = "None — the session's own folder";
  cwd.value = row.cwd;
  const pick = button("", "layout-folder-icon pick");
  pick.title = "Choose folder";
  pick.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
  const clear = button("", "layout-folder-icon clear");
  clear.title = "Clear";
  clear.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>`;
  const choose = (): void => {
    void doors().layoutsPickFolder?.().then((dir) => {
      if (!dir) return;
      cwd.value = dir;
      void save({ id, cwd: dir });
    });
  };
  cwd.addEventListener("click", choose);
  pick.addEventListener("click", choose);
  clear.addEventListener("click", () => { cwd.value = ""; void save({ id, cwd: "" }); });
  folderRow.append(cwd, pick, clear);
  panel.appendChild(prefRow("Working folder", "Where its terminal starts when the session names no folder.", folderRow));

  // SESSION + PERMISSION
  const sess = select((["keep", "new", "last"] as const).map((v) => ({ value: v, label: SESSION_LABELS[v] })), row.session, (v) => {
    if (v === "keep" || v === "new" || v === "last") void save({ id, session: v });
  });
  panel.appendChild(prefRow("Session", "What opening this loop's terminal does with the session it had.", sess));
  const perm = select((["safe", "ask", "auto"] as const).map((v) => ({ value: v, label: PERMISSION_LABELS[v] })), row.permission, (v) => {
    if (v === "safe" || v === "ask" || v === "auto") void save({ id, permission: v });
  });
  panel.appendChild(prefRow("Permissions", "What a new session on this loop starts with; the composer's mode changes it per session.", perm));

  // MCP
  const mcp = h("label", "settings-toggle set-pref-row");
  mcp.innerHTML = `<div class="set-pref-text"><div class="set-pref-title">Glyphh tools (MCP)</div><div class="set-pref-desc">Gives the loop Glyphh's tools: your apps, workspaces, memory and tasks.</div></div><input type="checkbox" /><span class="toggle-switch"></span>`;
  const mcpBox = mcp.querySelector("input") as HTMLInputElement;
  mcpBox.checked = row.mcp;
  mcpBox.addEventListener("change", () => { void save({ id, mcp: mcpBox.checked }); });
  panel.appendChild(mcp);
}

// ── Settings › General: the agent defaults ───────────────────────────────────

/** Default loop, default view and the CLIs' default route. Each is a plain
 *  preference; every open panel follows the change (preference-changed). */
export async function loadAgentDefaults(): Promise<void> {
  const loopSel = $<HTMLSelectElement>("set-default-loop");
  const viewSel = $<HTMLSelectElement>("set-default-loop-view");
  const gwBox = $<HTMLInputElement>("toggle-cli-gateway");
  const gwDesc = $("cli-gateway-desc");
  if (!loopSel && !viewSel && !gwBox) return;
  const d = doors();
  const [list, loop, view] = await Promise.all([
    settle(d.cliAgentsList?.(), null),
    settle(d.getPreference?.(DEFAULT_LOOP_PREF, ""), ""),
    settle(d.getPreference?.(DEFAULT_VIEW_PREF, "last"), "last"),
  ]);
  const roster = list?.ok ? list.agents.filter((a) => a.enabled) : [];
  if (loopSel) {
    loopSel.textContent = "";
    const ids = roster.length ? roster.map((a) => a.id as string) : ["glyphh"];
    for (const id of LOOP_IDS.filter((x) => ids.includes(x))) {
      const o = document.createElement("option");
      o.value = id;
      o.textContent = roster.find((a) => a.id === id)?.name ?? "Glyphh";
      loopSel.appendChild(o);
    }
    const want = typeof loop === "string" && ids.includes(loop) ? loop : "glyphh";
    loopSel.value = want;
    loopSel.onchange = () => { d.setPreference?.(DEFAULT_LOOP_PREF, loopSel.value === "glyphh" ? "" : loopSel.value); };
  }
  if (viewSel) {
    viewSel.value = defaultViewOf(view);
    viewSel.onchange = () => { d.setPreference?.(DEFAULT_VIEW_PREF, viewSel.value); };
  }
  if (gwBox) {
    gwBox.checked = !!list?.gatewayDefault;
    const ready = !!list?.gatewayReady;
    gwBox.disabled = !ready && !gwBox.checked;
    if (gwDesc) {
      gwDesc.textContent = ready
        ? "Claude runs on your own providers through Glyphh's local router unless a workspace or a session says otherwise. The other CLIs always use their own login."
        : "Add a chat model in Settings › Models to route Claude through your own providers.";
    }
    gwBox.onchange = () => { d.setPreference?.(CLI_GATEWAY_PREF, gwBox.checked); };
  }
}

export function initSettingsLoops(): void {
  // A loop turned on or off elsewhere (another window, the composer's
  // picker) — the page and General's default list follow.
  (window.glyphh as unknown as { onCliAgentsChanged?: (cb: () => void) => void }).onCliAgentsChanged?.(() => {
    if ($("loops-accordion")?.isConnected && $("loops-accordion")?.closest(".settings-panel")?.classList.contains("active")) void loadSettingsLoops();
    void loadAgentDefaults();
  });
  void loadAgentDefaults();
}
