/**
 * settings-connections.ts — CONNECTIONS AS SETTINGS (his spec, 2026-09-12:
 * "It should look exactly like loops").
 *
 * The same accordion grammar as Settings → Loops: icon + name on the far
 * left, the enable toggle on the far right, and the connection's form under
 * the expand — Name at the top, MCP Tools beneath, title-left/value-right
 * rows throughout. Search on top, paginated, two actions: + Custom MCP and
 * + New connection (the existing flows, same modals in the standard chrome).
 * A freshly added connection lands in the list EXPANDED.
 *
 * ORG connections render in the same list but are NOT editable — managed on
 * the platform by an admin; here they only show what they expose.
 *
 * The enable toggle's meaning per kind:
 *   custom MCP  → the row's real `enabled` flag.
 *   pipedream   → whether its tools are exposed to agents (off = every tool
 *                 hidden; on = all restored). Per-tool choices live in the
 *                 expanded MCP Tools list.
 */

import { escapeHtml, paginate, renderPaginationBar, confirmAction } from "./shared.js";
import { row } from "./settings-loops.js";
import { kebabCell, ROW_MENU_ICONS, openRowMenu } from "./lib-editor.js";
import { appIconInner, primeConnectedIcons } from "./app-icon.js";
import { adoptConnectionsInto, onConnectionsChanged, openConnDetail, openCustomDetail, closeConnDetail, setConnectionsToolsHost } from "./connections.js";

type Conn = Awaited<ReturnType<typeof window.glyphh.connectionsList>>["connections"][number];
type McpConn = Awaited<ReturnType<typeof window.glyphh.mcpConnectionsList>>["connections"][number];

/** One row of the merged list, whatever lane it came from. */
interface Entry {
  key: string;
  kind: "pipedream" | "custom" | "org";
  name: string;
  sub: string;
  enabled: boolean;
  icon: string | null;
  conn?: Conn;
  mcp?: McpConn;
}

const el = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

function fail(msg: string): void {
  const e = el("conncfg-error");
  if (!e) return;
  e.textContent = msg;
  e.classList.toggle("hidden", !msg);
}

let entries: Entry[] = [];
/** Admin? Decides whether org rows render at all. */
let isAdminUser = false;
let page = 0;
let customAllowed = false;
/** A slug/key to auto-expand after a reload — the just-added connection. */
let expandKey: string | null = null;
/** The key set BEFORE an add flow ran. Whatever is new afterwards is the row
 *  the user just created, and it opens itself so they can name it and pick
 *  its tools without hunting for it (his spec, 2026-09-12). */
let keysBeforeAdd: Set<string> | null = null;
/** While an ORIGINAL flow is running (the catalog connect), its own
 *  loadConnections + openConnDetail must not be repainted over by this page —
 *  the two fought and the page flickered (his report, 2026-09-12). One
 *  refresh happens when the flow ends. */
let suspendRefresh = false;
let wired = false;

export async function loadSettingsConnections(): Promise<void> {
  const host = el("conncfg-accordion");
  if (!host) return;
  if (!wired) {
    wired = true;
    el<HTMLInputElement>("conncfg-search")?.addEventListener("input", () => { page = 0; render(); });
    el("conncfg-new")?.addEventListener("click", () => driveOriginal("conn-add-btn"));
    el("conncfg-custom")?.addEventListener("click", () => driveOriginal("conn-add-custom-btn"));
  }
  host.innerHTML = `<div class="crud-empty">Loading…</div>`;
  fail("");
  ensureAdopted();
  // Resolved WITH the reads, before the first paint — a late answer would
  // flash the wrong set.
  const account = await window.glyphh.getAccountInfo?.().catch(() => null);
  isAdminUser = !!account?.role && ["org_admin", "admin", "super_admin"].includes(account.role);
  const [res, custom, gate] = await Promise.all([
    window.glyphh.connectionsList().catch(() => ({ ok: false, connections: [] as Conn[] })),
    window.glyphh.mcpConnectionsList().catch(() => ({ ok: false, connections: [] as McpConn[] })),
    window.glyphh.mcpCustomAllowed?.().catch(() => ({ allowed: false })) ?? Promise.resolve({ allowed: false }),
  ]);
  customAllowed = !!(gate as { allowed?: boolean })?.allowed;
  el("conncfg-custom")?.classList.toggle("hidden", !customAllowed);

  const conns = (res as { connections?: Conn[] })?.connections ?? [];
  const mcps = (custom as { connections?: McpConn[] })?.connections ?? [];
  // Members SEE org connections too — that is where they connect their own
  // account (his ruling, 2026-09-14, superseding the 09-12 members-only list);
  // only the shaping stays admin-only.
  const mine = <T extends { org?: boolean; kind?: string }>(rows: T[]): T[] => rows;
  // DEDUPE: the uniform /api/connections list already carries custom-MCP
  // rows, so listing both lanes showed the same connection twice — and the
  // copy from the wrong lane routed its writes to the org routes, which
  // answered "requires an organization administrator" (his reports,
  // 2026-09-12). The MCP lane wins; the uniform row is dropped.
  const mcpSlugs = new Set(mcps.map((m) => m.slug));
  entries = [
    ...mine(conns).filter((c) => !mcpSlugs.has(c.appSlug) && !mcpSlugs.has(c.id)).map((c): Entry => ({
      key: `pd:${c.id}`,
      kind: c.org ? "org" : "pipedream",
      name: c.label || c.appName,
      sub: c.org
        ? ((c as { connected?: boolean }).connected ? "Org connection · connected as you" : "Org connection · not connected")
        : c.appName,
      // ON = at least one tool exposed. hiddenTools carries the truth.
      enabled: true,
      icon: null,
      conn: c,
    })),
    ...mine(mcps).map((m): Entry => ({
      key: `mcp:${m.slug}`,
      kind: m.kind === "org" ? "org" : "custom",
      name: m.name,
      sub: m.kind === "org" ? "Org connection" : "Custom MCP",
      enabled: m.enabled,
      icon: m.iconUrl,
      mcp: m,
    })),
  ].sort((a, b) => a.name.localeCompare(b.name));
  // Opened an add flow? Whatever wasn't here before is the new connection.
  if (keysBeforeAdd) {
    const fresh = entries.find((e) => !keysBeforeAdd!.has(e.key));
    // KEEP the marker until the row actually shows up. The connect flow is
    // long (an OAuth popup), and clearing it on the first refresh meant the
    // row that landed later was never expanded (his report, 2026-09-12).
    if (fresh) { expandKey = fresh.key; keysBeforeAdd = null; }
  }
  render();
  // Real catalog icons arrive async, then the list repaints ONCE. Priming
  // from inside render() would re-enter it on every resolved icon — an
  // infinite repaint that hung the page (his report, 2026-09-12).
  void primeConnectedIcons(
    entries.filter((x) => x.conn).map((x) => ({ connection: { accountId: x.conn!.accountId, pipedreamSlug: x.conn!.appSlug } })),
    render,
  );
}

function render(): void {
  const host = el("conncfg-accordion");
  if (!host) return;
  const q = (el<HTMLInputElement>("conncfg-search")?.value || "").trim().toLowerCase();
  const filtered = q ? entries.filter((e) => e.name.toLowerCase().includes(q) || e.sub.toLowerCase().includes(q)) : entries;

  parkBorrowed();
  host.innerHTML = "";
  if (!filtered.length) {
    host.innerHTML = q
      ? `<div class="crud-empty">No connections matching "${escapeHtml(q)}"</div>`
      : `<div class="crud-empty">No connections yet — <b>+ New connection</b> links an app; <b>+ Custom MCP</b> adds your own server.</div>`;
    return;
  }
  const { items, state } = paginate(filtered, page);
  page = state.page;

  for (const e of items) {
    const acc = row(e.name, e.sub, e.enabled,
      (on) => void toggleEntry(e, on),
      (panel) => void buildEntryForm(panel, e),
      true); // the tools pane is shared — rebuild on every open
    const head = acc.querySelector(".loop-acc-head");
    // ICON on the FAR LEFT, ahead of the name (his spec, asked twice) — the
    // same icon path the connections page uses: the catalog icon for a
    // Pipedream account, the row's own iconUrl for an MCP server.
    if (head) {
      const ico = document.createElement("span");
      ico.className = "conncfg-icon";
      ico.innerHTML = e.conn
        ? appIconInner({ connection: { accountId: e.conn.accountId, pipedreamSlug: e.conn.appSlug } }, e.name, "conncfg-icon-initial")
        : e.icon
          ? `<img src="${escapeHtml(e.icon)}" alt="" />`
          : `<span class="conncfg-icon-initial">${escapeHtml((e.name || "?").charAt(0).toUpperCase())}</span>`;
      head.insertBefore(ico, head.querySelector(".loop-acc-chev")?.nextSibling ?? head.firstChild);
    }
    // ORG rows are visible, never editable — the toggle goes inert.
    if (e.kind === "org") {
      const box = acc.querySelector<HTMLInputElement>(".loop-acc-toggle input");
      if (box) { box.disabled = true; box.title = "Managed by your organization"; }
    }
    // The ⋮ menu sits to the RIGHT of the toggle; Delete is its one item
    // (his spec) — the form no longer carries a Remove button.
    //
    // The SLOT is always reserved, even on org rows that have no menu: a
    // missing kebab let those rows' toggles sit flush right while every other
    // toggle was pushed left by one button width (his report, 2026-09-12).
    if (head) {
      const slot = document.createElement("span");
      slot.className = "loop-acc-kebab-slot";
      if (e.kind !== "org") {
        const kebab = document.createElement("button");
        kebab.type = "button";
        kebab.className = "lib-row-kebab";
        kebab.title = "More";
        kebab.textContent = "⋮";
        kebab.addEventListener("click", (ev) => {
          ev.stopPropagation();
          openRowMenu(kebab, [
            { icon: ROW_MENU_ICONS.delete, label: "Delete", danger: true, onClick: () => void removeEntry(e) },
          ]);
        });
        slot.appendChild(kebab);
      }
      head.appendChild(slot);
    }
    host.appendChild(acc);
    if (expandKey === e.key) {
      (acc.querySelector(".loop-acc-head") as HTMLElement | null)?.click();
      expandKey = null;
    }
  }

  if (state.totalPages > 1) host.appendChild(renderPaginationBar(state, (p) => { page = p; render(); }));
}

async function toggleEntry(e: Entry, on: boolean): Promise<void> {
  try {
    if (e.kind === "org") return; // inert — belt and braces beside the disabled box
    if (e.mcp) {
      const r = await window.glyphh.mcpConnectionsUpdate(e.mcp.slug, { enabled: on });
      if (r && !(r as { ok?: boolean }).ok) throw new Error((r as { error?: string }).error || "couldn't change that connection");
    } else if (e.conn) {
      // Pipedream: off = hide every tool from agents; on = restore all.
      const tools = await window.glyphh.connectionToolsList(e.conn.id);
      const names = ((tools as { tools?: Array<{ name: string }> })?.tools ?? []).map((t) => t.name);
      const r = await window.glyphh.connectionToolsSet(e.conn.id, on ? [] : names);
      if (r && !(r as { ok?: boolean }).ok) throw new Error((r as { error?: string }).error || "couldn't change that connection");
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    void loadSettingsConnections();
  }
}

/**
 * The expanded row hosts the REAL connection detail — the same form and the
 * same TOOLS PANE the Connections page uses, Select all and all (his report,
 * 2026-09-12: my hand-rolled list dropped both). The pane is a single node,
 * so it moves into whichever row is open and parks back on close.
 */

/**
 * Put the BORROWED singletons back before anything clears a container.
 *
 * The tools pane and the detail node are one-of-a-kind and live inside
 * whichever row is open. Clearing the accordion (a delete, a search, a page
 * change) would destroy them with the row, and no later expand could show
 * tools again (his report, 2026-09-12). Everything that wipes DOM calls this
 * first.
 */
function parkBorrowed(): void {
  closeConnDetail();
  const bin = el("conncfg-legacy");
  const detail = document.getElementById("conn-detail");
  if (bin && detail && !detail.closest(".conncfg-modal")) bin.appendChild(detail);
}

/** One title-left / value-right row — the accordion form grammar. */
function prefRow(title: string, desc: string, control: HTMLElement): HTMLElement {
  const r = document.createElement("div");
  r.className = "set-pref-row";
  const text = document.createElement("div");
  text.className = "set-pref-text";
  text.innerHTML = `<div class="set-pref-title"></div>${desc ? `<div class="set-pref-desc"></div>` : ""}`;
  (text.querySelector(".set-pref-title") as HTMLElement).textContent = title;
  if (desc) (text.querySelector(".set-pref-desc") as HTMLElement).textContent = desc;
  const value = document.createElement("div");
  value.className = "set-pref-value";
  value.appendChild(control);
  r.append(text, value);
  return r;
}

/** A text field that COMMITS ON CHANGE — there is no Save in an accordion. */
function fieldRow(
  title: string, desc: string, value: string, placeholder: string,
  readOnly: boolean, commit: (v: string) => Promise<unknown>,
  /** A SECRET renders masked — the original form's OAuth secret field is a
   *  password input, and a secret typed in the clear is a secret leaked to
   *  anyone over the shoulder or in a screen share. */
  secret = false,
): HTMLElement {
  const input = document.createElement("input");
  input.type = secret ? "password" : "text";
  input.autocomplete = secret ? "new-password" : "off";
  input.className = "settings-input";
  input.value = value;
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.disabled = readOnly;
  input.addEventListener("change", () => {
    void commit(input.value).catch((err) => fail(err instanceof Error ? err.message : String(err)));
  });
  return prefRow(title, desc, input);
}

/**
 * The row's form: label LEFT, value RIGHT, every field saving on change —
 * no Save, no Cancel, no Delete (his ruling, 2026-09-12; Delete is the ⋮
 * menu's). Only the TOOLS PANE is borrowed from the real page, because it
 * carries Select all and the clamped descriptions.
 */
async function buildEntryForm(panel: HTMLElement, e: Entry): Promise<void> {
  parkBorrowed();
  panel.innerHTML = "";
  const readOnly = e.kind === "org";

  panel.appendChild(fieldRow("Name", readOnly ? "Managed by your organization." : "",
    e.name, "", readOnly, (v) => e.mcp
      ? window.glyphh.mcpConnectionsUpdate(e.mcp.slug, { name: v })
      : window.glyphh.connectionRename(e.conn!.id, v)));

  if (e.mcp && !readOnly) {
    panel.appendChild(fieldRow("Remote MCP server URL", "The endpoint the server dials.",
      e.mcp.url, "https://mcp.example.com/mcp", false,
      (v) => window.glyphh.mcpConnectionsUpdate(e.mcp!.slug, { url: v })));

    const headers = document.createElement("textarea");
    headers.className = "settings-input";
    headers.rows = 3;
    headers.placeholder = "Authorization: Bearer …";
    headers.spellcheck = false;
    headers.style.cssText = "resize:vertical;font-family:var(--font-mono);font-size:12px;";
    headers.addEventListener("change", () => {
      const map: Record<string, string> = {};
      for (const line of headers.value.split("\n")) {
        const k = line.indexOf(":");
        if (k > 0) map[line.slice(0, k).trim()] = line.slice(k + 1).trim();
      }
      void window.glyphh.mcpConnectionsUpdate(e.mcp!.slug, { headers: map })
        .then(() => { headers.value = ""; })
        .catch((err) => fail(err instanceof Error ? err.message : String(err)));
    });
    panel.appendChild(prefRow("Headers",
      e.mcp.headerKeys?.length ? `Stored: ${e.mcp.headerKeys.join(", ")} — write-only, enter a line to replace.` : "Write-only — stored sealed, never shown again.",
      headers));

    panel.appendChild(fieldRow("OAuth client ID", "For servers that sign you in on first connect.",
      "", "", false, (v) => window.glyphh.mcpConnectionsUpdate(e.mcp!.slug, { oauth: { clientId: v } })));
    panel.appendChild(fieldRow("OAuth client secret", "Write-only — never shown again.",
      "", "", false, (v) => window.glyphh.mcpConnectionsUpdate(e.mcp!.slug, { oauth: { clientSecret: v } }), true));
  }

  // MCP TOOLS — rendered HERE, from the same data and with the SAME markup
  // the Connections page uses (ws-tools-head + the master toggle, then
  // conn-tool-row/set-pref-row lines with clamped descriptions that expand on
  // click). Relocating the page's single pane could not serve more than one
  // row: every delete, search or second expand destroyed it. Same grammar,
  // per-row instance, no singleton.
  await buildToolsPane(panel, e, readOnly);
}

/** The tools list: a head with Select all, then one line per tool. */
async function buildToolsPane(panel: HTMLElement, e: Entry, readOnly: boolean): Promise<void> {
  const pane = document.createElement("div");
  pane.className = "conn-tools-pane conncfg-tools";
  // The SECTION ITSELF collapses (his spec, 2026-09-12) — a connection with
  // forty tools should not push its own fields off the screen. The head is
  // the disclosure; the master toggle still lives at its right and never
  // toggles the section.
  pane.innerHTML = `
    <div class="ws-tools-head conncfg-tools-head">
      <svg class="conncfg-tools-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      <h3 class="settings-subheading" style="margin:0;">Tools exposed to your AI</h3>
      <span style="flex:1;"></span>
      <label class="settings-toggle ws-model-allow conncfg-select-all hidden" title="Toggle every tool">
        <input type="checkbox" /><span class="toggle-switch"></span>
      </label>
    </div>
    <div class="conncfg-tools-body">
      <p class="settings-hint" style="margin-top:2px;"></p>
      <div class="conn-tools"></div>
    </div>`;
  panel.appendChild(pane);
  const head = pane.querySelector(".conncfg-tools-head") as HTMLElement;
  const bodyEl = pane.querySelector(".conncfg-tools-body") as HTMLElement;
  head.addEventListener("click", (ev) => {
    // The master toggle is its own control — clicking it must not collapse.
    if ((ev.target as HTMLElement).closest(".conncfg-select-all")) return;
    pane.classList.toggle("open");
  });
  // CLOSED on open (his ruling, 2026-09-12) — a row is its fields first;
  // the tool list is a drawer you pull when you want it.
  void bodyEl;
  const hint = pane.querySelector("p") as HTMLElement;
  const list = pane.querySelector(".conn-tools") as HTMLElement;
  const allWrap = pane.querySelector(".conncfg-select-all") as HTMLElement;
  const allBox = allWrap.querySelector("input") as HTMLInputElement;
  list.innerHTML = `<div class="crud-empty">Loading tools…</div>`;

  let tools: Array<{ name: string; description?: string; hidden?: boolean }> = [];
  try {
    const res = e.mcp
      ? await window.glyphh.mcpConnectionsTools(e.mcp.slug)
      : await window.glyphh.connectionToolsList(e.conn!.id);
    if (!(res as { ok?: boolean })?.ok) throw new Error((res as { error?: string }).error || "couldn't load tools");
    tools = (res as { tools?: typeof tools }).tools ?? [];
  } catch (err) {
    list.innerHTML = `<div class="crud-empty">Couldn't load tools.</div>`;
    fail(err instanceof Error ? err.message : String(err));
    return;
  }
  if (!tools.length) {
    list.innerHTML = `<div class="crud-empty">This connection publishes no tools yet.</div>`;
    return;
  }

  const hidden = new Set(tools.filter((t) => t.hidden).map((t) => t.name));
  const commit = async (): Promise<void> => {
    const list2 = Array.from(hidden);
    try {
      if (e.mcp) await window.glyphh.mcpConnectionsUpdate(e.mcp.slug, { hiddenTools: list2 });
      else await window.glyphh.connectionToolsSet(e.conn!.id, list2);
    } catch (err) { fail(err instanceof Error ? err.message : String(err)); }
  };
  const paintHead = (): void => {
    const on = tools.length - hidden.size;
    hint.textContent = `Turn a tool off to hide it — your AI won't see or be able to call it. ${on} of ${tools.length} exposed.`;
    allBox.checked = hidden.size === 0;
    allWrap.classList.toggle("hidden", readOnly);
  };
  allBox.addEventListener("change", () => {
    hidden.clear();
    if (!allBox.checked) for (const t of tools) hidden.add(t.name);
    list.querySelectorAll<HTMLInputElement>(".conn-tool-check").forEach((b) => { b.checked = allBox.checked; });
    paintHead();
    void commit();
  });

  list.innerHTML = "";
  for (const t of tools) {
    const row = document.createElement("div");
    row.className = "conn-tool-row set-pref-row ws-tool-line";
    const text = document.createElement("div");
    text.className = "set-pref-text";
    const title = document.createElement("div");
    title.className = "set-pref-title";
    title.textContent = t.name;
    text.appendChild(title);
    if (t.description) {
      const d = document.createElement("div");
      d.className = "set-pref-desc";
      d.textContent = t.description;
      text.appendChild(d);
      // Clamped by default; a click opens the full text — the page's grammar.
      text.addEventListener("click", () => row.classList.toggle("expanded"));
    }
    const sw = document.createElement("label");
    sw.className = "settings-toggle ws-model-allow";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "conn-tool-check";
    box.checked = !hidden.has(t.name);
    box.disabled = readOnly;
    box.addEventListener("change", () => {
      if (box.checked) hidden.delete(t.name); else hidden.add(t.name);
      paintHead();
      void commit();
    });
    const knob = document.createElement("span");
    knob.className = "toggle-switch";
    sw.append(box, knob);
    row.append(text, sw);
    list.appendChild(row);
  }
  paintHead();
}

/** Delete from the row's ⋮ menu — the standard confirm, then the real
 *  removal (his spec: no Remove button inside the form). */
async function removeEntry(e: Entry): Promise<void> {
  const yes = await confirmAction({
    title: `Delete ${e.name}?`,
    body: "Agents lose its tools immediately. You can connect it again any time.",
    confirmLabel: "Delete",
    danger: true,
  });
  if (!yes) return;
  try {
    if (e.mcp) await window.glyphh.mcpConnectionsDelete(e.mcp.slug);
    else if (e.conn) await window.glyphh.connectionDisconnect(e.conn.id);
    await loadSettingsConnections();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Re-read after the real page changed the set (connect / install / delete).
 *
 * RE-ENTRANCY GUARDED: adopting the section calls its loadConnections, which
 * fires this hook, which loads this page again — a loop that repaints while
 * a row is mid-build. One in-flight refresh at a time.
 */
let refreshing = false;
async function refreshFromStore(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try { await loadSettingsConnections(); } finally { refreshing = false; }
}

// ── The two ACTIONS reuse the REAL page (his ruling, 2026-09-12: "why not
// just use what was already there?") ────────────────────────────────────────
//
// sections/connections.html owns the catalog modal and the Custom MCP form,
// both already built and styled. Rather than a second implementation, the
// section's nodes are ADOPTED into a host inside this panel (its list and
// toolbar hidden) and the buttons here simply drive the originals. One flow,
// one set of modals, one source of truth.

let adopted = false;
/** Adoption runs the section's OWN loadConnections, which fires the change
 *  hook we just registered — the page then loaded a second time on every
 *  open (his report, 2026-09-12: "loads then resets and loads again"). That
 *  first firing is ours; swallow exactly one. */
let selfTriggered = false;
function ensureAdopted(): void {
  const host = el("conncfg-legacy");
  if (!host || adopted) return;
  adopted = true;
  selfTriggered = true;
  adoptConnectionsInto(host, [], null);
  onConnectionsChanged(() => {
    if (selfTriggered) { selfTriggered = false; return; }
    if (suspendRefresh) return;
    // Never repaint while a row is open — the user is working in it, and the
    // adopted detail lives inside it (his report, 2026-09-12: expanding reset
    // the page). The next open/close picks the new data up.
    if (document.querySelector("#conncfg-accordion .loop-acc.open")) return;
    void refreshFromStore();
  });
}

/**
 * Click the real button — the real flow, the real modal.
 *
 * The Custom MCP form lives in #conn-detail, which this page keeps hidden (it
 * doubles as the page-level editor). Reveal the host for that flow and put it
 * back the moment the form closes — watched on the node's own `hidden` class
 * so every exit (Cancel, Save, breadcrumb) is covered, not just the ones with
 * a handler here.
 */
function driveOriginal(id: string): void {
  const btn = document.getElementById(id) as HTMLElement | null;
  if (!btn) return;
  // Snapshot what exists, so the row that appears afterwards can open itself.
  keysBeforeAdd = new Set(entries.map((e) => e.key));
  if (id === "conn-add-custom-btn") { void openCustomMcpModal(); return; }
  // The catalog runs the page's own connect flow end to end. Stand back until
  // its modal closes, then refresh once.
  suspendRefresh = true;
  btn.click();
  const modal = document.getElementById("conn-modal");
  if (modal) {
    const obs = new MutationObserver(() => {
      if (!modal.classList.contains("hidden")) return;
      obs.disconnect();
      suspendRefresh = false;
      // Poll briefly: the account lands asynchronously after the OAuth, so a
      // single refresh can easily fire before the server knows about it.
      let tries = 0;
      const tick = (): void => {
        void refreshFromStore().then(() => {
          if (++tries < 8 && keysBeforeAdd) setTimeout(tick, 1500);
        });
      };
      setTimeout(tick, 400);
    });
    obs.observe(modal, { attributes: true, attributeFilter: ["class"] });
  } else {
    suspendRefresh = false;
  }
}

/**
 * + Custom MCP uses the app's STANDARD form modal (formModal) — the same
 * validated, field-based modal every other "+ New" uses.
 *
 * The previous attempt stuffed the page's own editor into modal chrome, which
 * gave two headers and a clipped footer (his report, 2026-09-12). A form
 * belongs in the form modal; the page editor belongs on the page.
 */
async function openCustomMcpModal(): Promise<void> {
  const { formModal } = await import("./settings-list-page.js");
  await formModal({
    title: "Custom MCP",
    submitLabel: "Add & Connect",
    fields: [
      { key: "name", label: "Name", required: true, placeholder: "My MCP server" },
      {
        key: "url", label: "Remote MCP server URL", required: true,
        placeholder: "https://mcp.example.com/mcp",
        validate: (v) => /^https?:\/\//i.test(v.trim()) ? null : "must start with http:// or https://",
      },
      { key: "headers", label: "Headers (optional)", placeholder: "Authorization: Bearer …" },
      { key: "clientId", label: "OAuth client ID (optional)" },
      { key: "clientSecret", label: "OAuth client secret (optional)" },
    ],
    onSubmit: async (v) => {
      const headers: Record<string, string> = {};
      for (const line of (v.headers ?? "").split("\n")) {
        const k = line.indexOf(":");
        if (k > 0) headers[line.slice(0, k).trim()] = line.slice(k + 1).trim();
      }
      const res = await window.glyphh.mcpConnectionsCreate({
        name: v.name.trim(),
        url: v.url.trim(),
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(v.clientId ? { oauth: { clientId: v.clientId.trim(), ...(v.clientSecret ? { clientSecret: v.clientSecret.trim() } : {}) } } : {}),
      });
      if (!res?.ok) return { ok: false as const, error: res?.error || "couldn't add that server" };
      const slug = res.connection?.slug;
      if (slug) expandKey = `mcp:${slug}`;
      // Refresh AFTER the modal is told to close, never before: awaiting the
      // reload here meant any hiccup in it left the modal open on a
      // connection that had already been created (his report, 2026-09-12).
      setTimeout(() => { void loadSettingsConnections(); }, 0);
      return { ok: true as const };
    },
  });
}
