// tab-bar-ui.ts — Tab bar system extracted from renderer.ts

import { yoConfirm } from "./yo-modal.js";

type TabInfo = { id: string; name: string; favicon?: string; layoutFavicons?: string[]; pinned?: boolean; url?: string; kind?: string };

// ── Internal-app icons for the `+` picker ─────────────────────────────────
// Mirrors the SVGs used on the left-rail launcher buttons in index.html so
// internal apps render with the same icon in both surfaces. Falls back to
// `null` for ids we don't have a custom icon for — caller uses a letter.
const svg = (paths: string) =>
  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;">${paths}</svg>`;
const INTERNAL_APP_ICONS: Record<string, string> = {
  // Rail-aligned (match index.html SVGs):
  dashboard: svg('<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>'),
  apps: svg('<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>'),
  agents: svg('<path d="M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0z"/><path d="M5.5 21a8.5 8.5 0 0 1 13 0"/>'),
  vibes: svg('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'),
  councils: svg('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  schedules: svg('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>'),
  layouts: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>'),
  skills: svg('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'),
  drips: svg('<path d="M12 3l1.9 5.8L19.7 10l-5.8 1.9L12 17.7l-1.9-5.8L4.3 10l5.8-1.9L12 3z"/>'),
  // Singular worker / chrome apps (share icons with their plural where sensible):
  agent: svg('<path d="M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0z"/><path d="M5.5 21a8.5 8.5 0 0 1 13 0"/>'),
  vibe: svg('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'),
  council: svg('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  spec: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/>'),
  term: svg('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  home: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
};
function internalAppIcon(id: string): string | null {
  return INTERNAL_APP_ICONS[id] ?? null;
}

/**
 * Callbacks that the tab bar needs from the rest of renderer.ts
 * to implement auto mode switching when the active tab changes.
 */
export interface TabBarDeps {
  isYoControlsInited: () => boolean;
  getCurrentMode: () => string;
  setModeValue: (mode: string) => void;
  syncAgentMode: () => void;
}

export function initTabBar(deps: TabBarDeps): {
  renderTabs: (tabs: TabInfo[], activeId: string) => void;
  autoSwitchModeForActiveTab: (tabs: TabInfo[], activeId: string) => void;
  refreshEmptyState: () => void;
} {
  const tabBar = document.getElementById("tab-bar")!;
  const tabNewBtn = document.getElementById("tab-new-btn")!;
  const emptyState = document.getElementById("empty-state")!;

  let tabNewMenu: HTMLElement | null = null;
  let tabCtxMenu: HTMLElement | null = null;
  let lastActiveTabId = "";

  function closeTabNewMenu() {
    if (tabNewMenu) {
      tabNewMenu.remove();
      tabNewMenu = null;
      window.yo.panelsShow();
    }
  }

  function closeTabCtxMenu() {
    if (tabCtxMenu) {
      tabCtxMenu.remove();
      tabCtxMenu = null;
      window.yo.panelsShow();
    }
  }

  function openTabContextMenu(x: number, y: number, tabId: string, url: string, tabName: string) {
    closeTabCtxMenu();
    closeTabNewMenu();
    window.yo.panelsHide();

    const menu = document.createElement("div");
    menu.className = "tab-new-menu tab-ctx-menu";

    let host = "";
    try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* noop */ }
    const baseName = (tabName && tabName.trim()) || host || "App";
    const isBrowserUrlTab = !!url && /^https?:\/\//i.test(url);

    // Browser-only options: "Create App" + "Add as app" — only useful on
    // browser tabs with a real URL.
    if (isBrowserUrlTab) {
      const createBtn = document.createElement("button");
      createBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg><span>Create App</span>`;
      createBtn.addEventListener("click", () => {
        closeTabCtxMenu();
        window.yo.createAppFromTab(tabId, url, baseName);
      });
      menu.appendChild(createBtn);

      const addBtn = document.createElement("button");
      addBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M17.5 14v7M14 17.5h7"/></svg><span>Add as app</span>`;
      addBtn.addEventListener("click", async () => {
        closeTabCtxMenu();
        const id = baseName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `app-${Date.now()}`;
        const result = await window.yo.appsAdd(id, baseName, url);
        if (result && typeof result === "object" && "error" in result) {
          void yoConfirm({ title: "Couldn't add app", message: (result as { error: string }).error, confirmText: "OK", cancelText: "" });
        }
      });
      menu.appendChild(addBtn);

      const divider = document.createElement("div");
      divider.className = "tab-new-menu-divider";
      menu.appendChild(divider);
    }

    // New window (universal — every tab/app gets it).
    const yoExtra = window.yo as unknown as { tabNewWindow: (id: string) => void };
    const newWinBtn = document.createElement("button");
    newWinBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 8v8M8 12h8"/></svg><span>New window</span>`;
    newWinBtn.addEventListener("click", () => { closeTabCtxMenu(); yoExtra.tabNewWindow(tabId); });
    menu.appendChild(newWinBtn);

    const divider2 = document.createElement("div");
    divider2.className = "tab-new-menu-divider";
    menu.appendChild(divider2);

    // Close all (universal — every tab gets it).
    const closeAllBtn = document.createElement("button");
    closeAllBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg><span>Close all tabs</span>`;
    closeAllBtn.addEventListener("click", () => {
      closeTabCtxMenu();
      window.yo.tabCloseAll();
    });
    menu.appendChild(closeAllBtn);

    // Position; clamp to viewport
    menu.style.top = `${y}px`;
    menu.style.left = `${x}px`;
    menu.style.visibility = "hidden";
    document.body.appendChild(menu);
    tabCtxMenu = menu;

    const margin = 8;
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    if (x + w + margin > window.innerWidth) menu.style.left = `${Math.max(margin, window.innerWidth - w - margin)}px`;
    if (y + h + margin > window.innerHeight) menu.style.top = `${Math.max(margin, window.innerHeight - h - margin)}px`;
    menu.style.visibility = "";

    const onClickOutside = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node)) {
        closeTabCtxMenu();
        document.removeEventListener("click", onClickOutside);
        document.removeEventListener("contextmenu", onClickOutside);
      }
    };
    setTimeout(() => {
      document.addEventListener("click", onClickOutside);
      document.addEventListener("contextmenu", onClickOutside);
    }, 0);
  }

  function renderTabs(tabs: TabInfo[], activeId: string) {
    tabBar.innerHTML = "";
    for (const tab of tabs) {
      const el = document.createElement("div");
      el.className = "tab" + (tab.id === activeId ? " tab-active" : "") + (tab.pinned ? " tab-pinned" : "");
      el.dataset.id = tab.id;

      // The Settings tab gets a gear icon.
      if (tab.id === "home") {
        const icon = document.createElement("span");
        icon.className = "tab-home-icon";
        icon.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
        el.appendChild(icon);
      } else if (tab.kind === "layout") {
        // Layout tab gets a single grid glyph + the layout's name (handled by
        // the label block below). Stacked panel favicons are gone — the
        // layout's own identity wins.
        const icon = document.createElement("span");
        icon.className = "tab-layout-icon";
        icon.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>';
        el.appendChild(icon);
      } else {
        // For internal yo:// apps (Apps, Layouts, Skills, Dashboard, etc.),
        // there's no favicon — stand the app's icon in instead so the tab
        // gets a recognisable glyph. INTERNAL_APP_ICONS maps app id → SVG.
        const internalIcon = !tab.favicon ? internalAppIcon(tab.id.replace(/-\d+$/, "")) : null;
        if (internalIcon) {
          const span = document.createElement("span");
          span.className = "tab-layout-icon";
          span.innerHTML = internalIcon;
          el.appendChild(span);
        } else {
          const favicon = document.createElement("img");
          favicon.className = "tab-favicon";
          favicon.width = 14;
          favicon.height = 14;
          favicon.src = tab.favicon || "";
          favicon.onerror = () => { favicon.src = ""; };
          el.appendChild(favicon);
        }
      }

      // Label
      {
        const label = document.createElement("span");
        label.className = "tab-label";
        label.textContent = tab.name;
        el.appendChild(label);
      }

      // Click to switch
      el.addEventListener("click", () => {
        window.yo.tabSwitch(tab.id);
      });

      // Close button — not shown on pinned (home) tabs
      if (!tab.pinned) {
        const close = document.createElement("button");
        close.className = "tab-close";
        close.title = "Close tab";
        close.innerHTML = "&times;";
        close.addEventListener("click", (e) => {
          e.stopPropagation();
          window.yo.tabClose(tab.id);
        });
        el.appendChild(close);
      }

      // Right-click → tab context menu. Universal "Close all tabs" item;
      // browser tabs with a real URL also get "Create App" / "Add as app".
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openTabContextMenu(e.clientX, e.clientY, tab.id, tab.url || "", tab.name);
      });

      // Drag-and-drop reordering (not for pinned or layout tabs)
      if (!tab.pinned && tab.id !== "__layout__") {
        el.draggable = true;
        el.addEventListener("dragstart", (e) => {
          el.classList.add("tab-dragging");
          e.dataTransfer?.setData("text/plain", tab.id);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        });
        el.addEventListener("dragend", () => {
          el.classList.remove("tab-dragging");
          tabBar.querySelectorAll(".tab-drop-before,.tab-drop-after")
            .forEach((n) => n.classList.remove("tab-drop-before", "tab-drop-after"));
        });
      }
      el.addEventListener("dragover", (e) => {
        if (tab.pinned) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        const rect = el.getBoundingClientRect();
        const midpoint = rect.left + rect.width / 2;
        el.classList.toggle("tab-drop-before", e.clientX < midpoint);
        el.classList.toggle("tab-drop-after", e.clientX >= midpoint);
      });
      el.addEventListener("dragleave", () => {
        el.classList.remove("tab-drop-before", "tab-drop-after");
      });
      el.addEventListener("drop", (e) => {
        e.preventDefault();
        const draggedId = e.dataTransfer?.getData("text/plain");
        if (!draggedId || draggedId === tab.id) return;
        // Can't drop on pinned tab
        if (tab.pinned) return;
        const rect = el.getBoundingClientRect();
        const dropBefore = e.clientX < rect.left + rect.width / 2;
        // Compute new order from current DOM
        const currentOrder = Array.from(tabBar.querySelectorAll<HTMLElement>(".tab"))
          .map((n) => n.dataset.id!)
          .filter((id) => id && id !== "__layout__");
        const filtered = currentOrder.filter((id) => id !== draggedId);
        const targetIdx = filtered.indexOf(tab.id);
        filtered.splice(dropBefore ? targetIdx : targetIdx + 1, 0, draggedId);
        window.yo.tabReorder(filtered);
        el.classList.remove("tab-drop-before", "tab-drop-after");
      });

      tabBar.appendChild(el);
    }
    // Re-append the + button so it stays after the last tab
    tabBar.appendChild(tabNewBtn);
  }

  /** Shown only when there are no tabs AND the left files rail isn't open —
   *  an open rail is itself "content" for the user, so the placeholder is
   *  redundant. (The right-hand agent panel this also used to check was
   *  removed in the pivot-mcp pass.) */
  let lastTabCount = 0;
  function updateEmptyState(tabs: TabInfo[]) {
    lastTabCount = tabs.length;
    refreshEmptyState();
  }
  function refreshEmptyState() {
    const leftRailOpen = !!document.getElementById("files-rail")?.classList.contains("open");
    const showEmpty = lastTabCount === 0 && !leftRailOpen;
    emptyState.classList.toggle("hidden", !showEmpty);
  }

  // Swarm mode is controlled solely by the .yo mode dropdown — there is no
  // dedicated panel to auto-switch for, and it must persist across tabs.
  function autoSwitchModeForActiveTab(_tabs: TabInfo[], _activeId: string): void {
    /* no-op */
  }

  // -- + button click handler --

  tabNewBtn.addEventListener("click", async (e) => {
    e.stopPropagation();

    // Never open new apps while the account is locked (trial expired/disabled).
    // The button is hidden by CSS then, but guard the handler defensively.
    if (document.body.classList.contains("account-locked")) return;

    if (tabNewMenu) { closeTabNewMenu(); return; }

    // Use appsListAll so system-kind apps (Dashboard, Apps, Agents, …)
    // appear in the panel `+` picker — they're hidden from the Apps
    // registry + Layouts builder but mountable ad-hoc here.
    const apps = await (window.yo as any).appsListAll?.() ?? await window.yo.appsList();
    const appsWithUrl = apps.filter((a: any) => a.url);

    if (appsWithUrl.length === 0) {
      window.yo.tabNew();
      return;
    }

    window.yo.panelsHide();

    const menu = document.createElement("div");
    menu.className = "tab-new-menu";

    // Search input
    const searchInput = document.createElement("input");
    searchInput.className = "tab-new-menu-search";
    searchInput.type = "text";
    searchInput.placeholder = "Search apps...";
    searchInput.spellcheck = false;
    menu.appendChild(searchInput);

    // Scrollable list
    const list = document.createElement("div");
    list.className = "tab-new-menu-list";

    const browserBtn = document.createElement("button");
    browserBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg><span>Browser</span>`;
    browserBtn.addEventListener("click", () => { closeTabNewMenu(); window.yo.tabNew(); });
    list.appendChild(browserBtn);

    const divider = document.createElement("div");
    divider.className = "tab-new-menu-divider";
    list.appendChild(divider);

    // One alpha-sorted list — user apps and former-left-rail "system" apps
    // (Dashboard, Apps, Agents, …) live in the same namespace from the
    // user's perspective, so don't split them.
    const allApps = appsWithUrl.slice().sort((a: any, b: any) => a.name.localeCompare(b.name));

    const renderAppBtn = (app: any) => {
      const btn = document.createElement("button");
      btn.dataset.name = app.name.toLowerCase();
      let iconHtml = "";
      if (app.url!.startsWith("yo://")) {
        iconHtml = internalAppIcon(app.id)
          ?? `<span class="tab-new-menu-initial">${app.name.charAt(0).toUpperCase()}</span>`;
      } else {
        try {
          const domain = new URL(app.url!).hostname;
          iconHtml = `<img src="https://www.google.com/s2/favicons?domain=${domain}&sz=32" width="14" height="14" style="border-radius:2px;" onerror="this.style.display='none'" />`;
        } catch {
          iconHtml = `<span class="tab-new-menu-initial">${app.name.charAt(0).toUpperCase()}</span>`;
        }
      }
      btn.innerHTML = `${iconHtml}<span>${app.name}</span>`;
      btn.addEventListener("click", () => { closeTabNewMenu(); window.yo.tabNewApp(app.id); });
      return btn;
    };

    for (const app of allApps) list.appendChild(renderAppBtn(app));

    menu.appendChild(list);

    // Filter on search input
    searchInput.addEventListener("input", () => {
      const q = searchInput.value.toLowerCase();
      list.querySelectorAll<HTMLButtonElement>("button[data-name]").forEach((btn) => {
        btn.style.display = btn.dataset.name!.includes(q) ? "" : "none";
      });
    });

    const rect = tabNewBtn.getBoundingClientRect();
    // Pre-position off-screen so we can measure without flashing in the wrong spot.
    menu.style.top = "0px";
    menu.style.left = "-9999px";
    menu.style.visibility = "hidden";

    document.body.appendChild(menu);
    tabNewMenu = menu;

    // Measure now that the menu is in the DOM with its real content.
    const menuWidth = menu.offsetWidth;
    const menuHeight = menu.offsetHeight;
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Horizontal: prefer left-anchored to button. Flip to right-anchored
    // when the menu would overflow the right edge.
    let left = rect.left;
    if (left + menuWidth + margin > vw) {
      left = rect.right - menuWidth;
    }
    // Final viewport clamp on both sides.
    left = Math.min(Math.max(margin, left), vw - menuWidth - margin);

    // Vertical: prefer below button. Flip above if it would overflow the bottom
    // and there's more room above.
    let top = rect.bottom + 4;
    if (top + menuHeight + margin > vh && rect.top - menuHeight - 4 >= margin) {
      top = rect.top - menuHeight - 4;
    }
    top = Math.min(Math.max(margin, top), vh - menuHeight - margin);

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = "";

    searchInput.focus();

    const onClickOutside = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node) && ev.target !== tabNewBtn) {
        closeTabNewMenu();
        document.removeEventListener("click", onClickOutside);
      }
    };
    setTimeout(() => document.addEventListener("click", onClickOutside), 0);
  });

  // -- IPC listener: tab state updates --

  window.yo.onTabState((state: { tabs: TabInfo[]; activeId: string; visible: boolean }) => {
    renderTabs(state.tabs, state.activeId);
    tabBar.style.display = state.visible ? "flex" : "none";
    tabNewBtn.style.display = state.visible ? "" : "none";
    updateEmptyState(state.tabs);
    if (state.activeId !== lastActiveTabId) {
      autoSwitchModeForActiveTab(state.tabs, state.activeId);
    }
    lastActiveTabId = state.activeId;
  });

  // Load initial tab state
  window.yo.tabList().then((state) => {
    renderTabs(state.tabs, state.activeId);
    tabBar.style.display = state.visible ? "flex" : "none";
    tabNewBtn.style.display = state.visible ? "" : "none";
    updateEmptyState(state.tabs);
  });

  return { renderTabs, autoSwitchModeForActiveTab, refreshEmptyState };
}
