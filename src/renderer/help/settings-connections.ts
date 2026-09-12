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
import { hidePanelsForModal, restorePanelsForModal } from "../yo-modal.js";

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
let page = 0;
let customAllowed = false;
/** A slug/key to auto-expand after a reload — the just-added connection. */
let expandKey: string | null = null;
let wired = false;

export async function loadSettingsConnections(): Promise<void> {
  const host = el("conncfg-accordion");
  if (!host) return;
  if (!wired) {
    wired = true;
    el<HTMLInputElement>("conncfg-search")?.addEventListener("input", () => { page = 0; render(); });
    el("conncfg-new")?.addEventListener("click", () => void openNewConnectionModal());
    el("conncfg-custom")?.addEventListener("click", () => void openCustomMcpModal());
  }
  host.innerHTML = `<div class="crud-empty">Loading…</div>`;
  fail("");
  const [res, custom, gate] = await Promise.all([
    window.glyphh.connectionsList().catch(() => ({ ok: false, connections: [] as Conn[] })),
    window.glyphh.mcpConnectionsList().catch(() => ({ ok: false, connections: [] as McpConn[] })),
    window.glyphh.mcpCustomAllowed?.().catch(() => ({ allowed: false })) ?? Promise.resolve({ allowed: false }),
  ]);
  customAllowed = !!(gate as { allowed?: boolean })?.allowed;
  el("conncfg-custom")?.classList.toggle("hidden", !customAllowed);

  const conns = (res as { connections?: Conn[] })?.connections ?? [];
  const mcps = (custom as { connections?: McpConn[] })?.connections ?? [];
  entries = [
    ...conns.map((c): Entry => ({
      key: `pd:${c.id}`,
      kind: c.org ? "org" : "pipedream",
      name: c.label || c.appName,
      sub: c.org ? "Org connection" : c.appName,
      // ON = at least one tool exposed. hiddenTools carries the truth.
      enabled: true,
      icon: null,
      conn: c,
    })),
    ...mcps.map((m): Entry => ({
      key: `mcp:${m.slug}`,
      kind: m.kind === "org" ? "org" : "custom",
      name: m.name,
      sub: m.kind === "org" ? "Org connection" : "Custom MCP",
      enabled: m.enabled,
      icon: m.iconUrl,
      mcp: m,
    })),
  ].sort((a, b) => a.name.localeCompare(b.name));
  render();
}

function render(): void {
  const host = el("conncfg-accordion");
  if (!host) return;
  const q = (el<HTMLInputElement>("conncfg-search")?.value || "").trim().toLowerCase();
  const filtered = q ? entries.filter((e) => e.name.toLowerCase().includes(q) || e.sub.toLowerCase().includes(q)) : entries;

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
      (panel) => void buildEntryForm(panel, e));
    // The far-left ICON, ahead of the name (his spec).
    const head = acc.querySelector(".loop-acc-head");
    if (head && e.icon) {
      const img = document.createElement("img");
      img.className = "conncfg-icon";
      img.src = e.icon;
      img.alt = "";
      head.insertBefore(img, head.querySelector(".loop-acc-name"));
    }
    // ORG rows are visible, never editable — the toggle goes inert.
    if (e.kind === "org") {
      const box = acc.querySelector<HTMLInputElement>(".loop-acc-toggle input");
      if (box) { box.disabled = true; box.title = "Managed by your organization"; }
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

/** One title-left / value-right row — the loops form grammar. */
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

async function buildEntryForm(panel: HTMLElement, e: Entry): Promise<void> {
  panel.innerHTML = "";
  const readOnly = e.kind === "org";

  // NAME at the top.
  const name = document.createElement("input");
  name.type = "text";
  name.className = "settings-input";
  name.value = e.name;
  name.disabled = readOnly;
  name.addEventListener("change", () => {
    void (async () => {
      try {
        if (e.mcp) await window.glyphh.mcpConnectionsUpdate(e.mcp.slug, { name: name.value });
        else if (e.conn) await window.glyphh.connectionRename(e.conn.id, name.value);
        await loadSettingsConnections();
      } catch (err) { fail(err instanceof Error ? err.message : String(err)); }
    })();
  });
  panel.appendChild(prefRow("Name", readOnly ? "Managed by your organization." : "", name));

  // Custom MCP keeps its endpoint visible (headers stay write-only, set on edit).
  if (e.mcp && e.kind !== "org") {
    const url = document.createElement("input");
    url.type = "text";
    url.className = "settings-input";
    url.value = e.mcp.url;
    url.addEventListener("change", () => {
      void window.glyphh.mcpConnectionsUpdate(e.mcp!.slug, { url: url.value })
        .catch((err) => fail(err instanceof Error ? err.message : String(err)));
    });
    panel.appendChild(prefRow("Server URL", "The MCP endpoint the server dials.", url));
  }

  // MCP TOOLS under the identity — per-tool exposure, the connection's own form.
  const toolsHead = document.createElement("h4");
  toolsHead.className = "acct-row-head";
  toolsHead.textContent = "MCP Tools";
  panel.appendChild(toolsHead);
  const toolsHost = document.createElement("div");
  toolsHost.innerHTML = `<div class="crud-empty">Loading tools…</div>`;
  panel.appendChild(toolsHost);

  try {
    const hidden = new Set(e.mcp ? e.mcp.hiddenTools : e.conn?.hiddenTools ?? []);
    const res = e.mcp
      ? await window.glyphh.mcpConnectionsTools(e.mcp.slug)
      : await window.glyphh.connectionToolsList(e.conn!.id);
    const tools = ((res as { tools?: Array<{ name: string; description?: string }> })?.tools ?? []);
    toolsHost.innerHTML = "";
    if (!tools.length) {
      toolsHost.innerHTML = `<div class="crud-empty">This connection exposes no tools yet.</div>`;
      return;
    }
    for (const t of tools) {
      const sw = document.createElement("label");
      sw.className = "settings-toggle";
      sw.innerHTML = `<input type="checkbox" ${hidden.has(t.name) ? "" : "checked"} ${readOnly ? "disabled" : ""} /><span class="toggle-switch"></span>`;
      const box = sw.querySelector("input") as HTMLInputElement;
      box.addEventListener("change", () => {
        if (box.checked) hidden.delete(t.name); else hidden.add(t.name);
        const list = Array.from(hidden);
        void (e.mcp
          ? window.glyphh.mcpConnectionsUpdate(e.mcp.slug, { hiddenTools: list })
          : window.glyphh.connectionToolsSet(e.conn!.id, list)
        ).catch((err) => fail(err instanceof Error ? err.message : String(err)));
      });
      toolsHost.appendChild(prefRow(t.name, t.description ?? "", sw));
    }
  } catch (err) {
    toolsHost.innerHTML = "";
    fail(err instanceof Error ? err.message : String(err));
  }

  // Delete — personal rows only, the standard confirm.
  if (!readOnly) {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "action-btn danger";
    del.textContent = "Remove connection";
    del.addEventListener("click", () => {
      void confirmAction({
        title: `Remove ${e.name}?`,
        body: "Agents lose its tools immediately. You can connect it again any time.",
        confirmLabel: "Remove",
        danger: true,
      }).then(async (yes) => {
        if (!yes) return;
        if (e.mcp) await window.glyphh.mcpConnectionsDelete(e.mcp.slug);
        else if (e.conn) await window.glyphh.connectionDisconnect(e.conn.id);
        await loadSettingsConnections();
      }).catch((err) => fail(err instanceof Error ? err.message : String(err)));
    });
    const foot = document.createElement("div");
    foot.className = "settings-actions";
    foot.style.marginTop = "12px";
    foot.appendChild(del);
    panel.appendChild(foot);
  }
}

// ── + New connection — the existing connect flow in the standard chrome ──────
async function openNewConnectionModal(): Promise<void> {
  const body = document.createElement("div");
  const search = document.createElement("input");
  search.type = "text";
  search.className = "crud-search";
  search.placeholder = "Search apps…";
  search.spellcheck = false;
  const list = document.createElement("div");
  list.className = "ws-add-member-list";
  body.append(search, list);

  let closing = false;
  // Assigned after mountModal below; the click closures only run once it is.
  let close: () => void = () => {};
  const paintApps = async (): Promise<void> => {
    list.innerHTML = `<div class="crud-empty">Loading…</div>`;
    try {
      const res = await window.glyphh.connectorsGetApps(search.value.trim() || undefined, 0);
      const apps = res?.apps ?? [];
      list.innerHTML = "";
      if (!apps.length) { list.innerHTML = `<div class="crud-empty">No apps match.</div>`; return; }
      for (const a of apps) {
        const rowEl = document.createElement("div");
        rowEl.className = "crud-row";
        rowEl.style.cursor = "pointer";
        rowEl.innerHTML = `${a.icon ? `<img class="conncfg-icon" src="${escapeHtml(a.icon)}" alt="" />` : ""}<div class="crud-cell" style="flex:1;"><b></b><div class="mdl-hint"></div></div>`;
        (rowEl.querySelector("b") as HTMLElement).textContent = a.name;
        (rowEl.querySelector(".mdl-hint") as HTMLElement).textContent = a.description ?? "";
        rowEl.addEventListener("click", () => {
          if (closing) return;
          closing = true;
          close();
          void window.glyphh.connectorsConnect?.(a.id).then(async (r) => {
            if (r && !(r as { ok?: boolean }).ok) { fail((r as { error?: string }).error || "couldn't connect"); return; }
            // Land the new row expanded — find it by app after the reload.
            await loadSettingsConnections();
            const hit = entries.find((x) => x.conn?.appSlug === a.id || x.conn?.appName === a.name);
            if (hit) { expandKey = hit.key; render(); }
          }).catch((err) => fail(err instanceof Error ? err.message : String(err)));
        });
        list.appendChild(rowEl);
      }
    } catch (err) {
      list.innerHTML = "";
      fail(err instanceof Error ? err.message : String(err));
    }
  };
  search.addEventListener("input", () => void paintApps());
  void paintApps();
  close = mountModal("New connection", body);
  search.focus();
}

// ── + Custom MCP — name/url/headers in the standard chrome ───────────────────
async function openCustomMcpModal(): Promise<void> {
  const body = document.createElement("div");
  const nameIn = document.createElement("input");
  nameIn.type = "text"; nameIn.className = "settings-input"; nameIn.placeholder = "e.g. Internal tools";
  const urlIn = document.createElement("input");
  urlIn.type = "text"; urlIn.className = "settings-input"; urlIn.placeholder = "https://mcp.example.com/sse";
  const hdrIn = document.createElement("input");
  hdrIn.type = "text"; hdrIn.className = "settings-input"; hdrIn.placeholder = "Authorization: Bearer …  (optional)";
  body.append(
    prefRow("Name", "", nameIn),
    prefRow("Server URL", "The MCP endpoint the server dials.", urlIn),
    prefRow("Header", "Write-only — stored sealed, never shown again.", hdrIn),
  );
  const close = mountModal("Custom MCP", body, () => {
    const name = nameIn.value.trim();
    const url = urlIn.value.trim();
    if (!name || !url) { fail("a custom MCP needs a name and a URL"); return false; }
    const headers: Record<string, string> = {};
    const raw = hdrIn.value.trim();
    if (raw && raw.includes(":")) {
      const i = raw.indexOf(":");
      headers[raw.slice(0, i).trim()] = raw.slice(i + 1).trim();
    }
    void window.glyphh.mcpConnectionsCreate({ name, url, headers }).then(async (r) => {
      if (r && !(r as { ok?: boolean }).ok) { fail((r as { error?: string }).error || "couldn't add that server"); return; }
      const slug = (r as { connection?: { slug?: string } })?.connection?.slug;
      if (slug) expandKey = `mcp:${slug}`;
      await loadSettingsConnections();
    }).catch((err) => fail(err instanceof Error ? err.message : String(err)));
    return true;
  });
  nameIn.focus();
  void close;
}

/** The standard modal chrome (confirm-head/body/actions + the panel dance).
 *  `onSave` present → Cancel/Save actions; absent → a single Close. Returning
 *  false from onSave keeps the modal open (validation failed). */
function mountModal(title: string, body: HTMLElement, onSave?: () => boolean): () => void {
  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay";
  overlay.innerHTML = `<div class="confirm-box ws-add-member-box" role="dialog" aria-modal="true">
      <div class="confirm-head"><h3></h3></div>
      <div class="confirm-body"></div>
      <div class="confirm-actions">${onSave
        ? `<button type="button" class="action-btn" data-cancel>Cancel</button><button type="button" class="action-btn primary" data-save>Save</button>`
        : `<button type="button" class="action-btn" data-cancel>Close</button>`}</div>
    </div>`;
  (overlay.querySelector("h3") as HTMLElement).textContent = title;
  overlay.querySelector(".confirm-body")!.appendChild(body);
  let hidden = false;
  void hidePanelsForModal().then((h) => { hidden = h; });
  const close = (): void => { overlay.remove(); restorePanelsForModal(hidden); };
  overlay.querySelector("[data-cancel]")?.addEventListener("click", close);
  overlay.querySelector("[data-save]")?.addEventListener("click", () => { if (onSave?.() !== false) close(); });
  overlay.addEventListener("mousedown", (ev) => { if (ev.target === overlay) close(); });
  document.addEventListener("keydown", function esc(ev) {
    if (ev.key !== "Escape") return;
    document.removeEventListener("keydown", esc);
    close();
  });
  document.body.appendChild(overlay);
  return close;
}
