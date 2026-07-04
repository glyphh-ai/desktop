/**
 * CommandParser — parses and executes yo/sup/dip/drip/peace commands.
 *
 *   yo [query]      → open agent side panel (optionally with query)
 *   sup             → capture active panel to clipboard + session
 *   sup . <skill>   → capture + skill process → inject result
 *   dip <panel>     → switch/split/grid
 *   drip <effect>   → visual effect
 *   peace [count]   → particle peace-sign gesture
 */

import { BrowserWindow, WebContents } from "electron";
import { PanelManager } from "./panel-manager";
import { LayoutManager } from "./layout-manager";
import { AppConnector } from "./app-connector";
import { SessionCache } from "./session-cache";
import { executeCommand } from "./dom-bridge";
import { setPreference } from "./preferences";
export class CommandParser {
  private static readonly COMMAND_KEYWORDS = new Set(["sup", "dip", "drip", "peace", "waz"]);

  private onDrip: ((effect: string) => void) | null = null;
  private dripManager: import("./drip-manager").DripManager | null = null;

  // Sup conversation state
  private yoHistory: Array<{ role: string; content: string }> = [];
  private yoContext = ""; // assembled context from initial search
  private mainWindow: BrowserWindow | null = null;
  private grabber: ((activeOnly?: boolean) => Promise<string | null>) | null = null;
  private wcGetter: ((panelId: string) => WebContents | null) | null = null;
  private tabCloser: ((id: string) => void) | null = null;
  private tabLister: (() => string[]) | null = null;
  private tabCreator: ((url: string) => string) | null = null;
  private instanceCreator: ((appId: string) => string | null) | null = null;
  constructor(
    private panels: PanelManager,
    private layouts: LayoutManager,
    private appConnector: AppConnector,
    private session: SessionCache,
  ) {}

  /** Set the main window reference (used by dip commands). */
  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win;
  }

  /** Register callback for drip effects */
  setDripHandler(fn: (effect: string) => void) {
    this.onDrip = fn;
  }

  setDripManager(mgr: import("./drip-manager").DripManager) {
    this.dripManager = mgr;
  }

  /** Set the LLM engine for inline processing. */
  /** Set the grabber callback — grabs content from visible panels. */
  setGrabber(fn: (activeOnly?: boolean) => Promise<string | null>): void {
    this.grabber = fn;
  }

  /** Set the WebContents getter — resolves panel ID to live WebContents. */
  setWebContentsGetter(fn: (panelId: string) => WebContents | null): void {
    this.wcGetter = fn;
  }

  /** Set tab management callbacks for .dip close. */
  setTabManager(closer: (id: string) => void, lister: () => string[], creator?: (url: string) => string): void {
    this.tabCloser = closer;
    this.tabLister = lister;
    if (creator) this.tabCreator = creator;
  }

  /** Set callback that creates a new instance of an app and returns the instance panel ID. */
  setInstanceCreator(fn: (appId: string) => string | null): void {
    this.instanceCreator = fn;
  }

  /** Set the .waz spawner — disposable agent popup that runs a prompt
   *  outside the right-rail .Yo session. Used by `.waz <prompt>` directly
   *  and by `.dip <app> .waz <panel-cmd> <prompt>` chains. */
  private wazSpawner: ((prompt: string) => void) | null = null;
  setWazSpawner(fn: (prompt: string) => void): void { this.wazSpawner = fn; }

  /** Split input at dot-prefixed command keyword boundaries for chaining.
   *  Only .yo / .dip / .drip trigger a split — bare keywords like "yo"
   *  appearing in natural language (e.g. "marketing yo") are left alone. */
  private splitChain(input: string): string[] {
    const tokens = input.split(/\s+/);
    const segments: string[] = [];
    let current: string[] = [];

    for (const token of tokens) {
      const bare = token.replace(/^\./, "").toLowerCase();
      const isDotCommand = token.startsWith(".") && CommandParser.COMMAND_KEYWORDS.has(bare);
      if (isDotCommand && current.length > 0) {
        segments.push(current.join(" "));
        current = [token];
      } else {
        current.push(token);
      }
    }
    if (current.length > 0) segments.push(current.join(" "));
    return segments;
  }

  /** Execute a single command segment. */
  private async executeSingle(segment: string, sourcePanelId?: string): Promise<string> {
    const parts = segment.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case "yo":
        return this.handleYo(args);
      case "sup":
        return this.handleSup(args);
      case "dip":
        return this.handleDip(args, sourcePanelId);
      case "drip":
        return this.handleDrip(args);
      case "peace":
        return this.handlePeace(args);
      case "waz":
        return this.handleWaz(args, sourcePanelId);
      default:
        return `Unknown command: ${cmd}. Try yo, sup, dip, drip, or waz.`;
    }
  }

  /** .waz [<panel-cmd>] <prompt>
   *
   *  Bare form (`.waz <prompt>`) just spawns a disposable agent popup with
   *  the prompt — same as the inline interceptor path.
   *
   *  Chained form (`.dip <app> .waz <panel-cmd> <prompt>`) runs the named
   *  mapped command against the active panel first, then spawns waz with
   *  the remaining prompt. The panel command is whatever the app maps
   *  (`new`, `compose`, `read-latest`, etc). If the first arg doesn't
   *  match a mapped command on the active panel, the whole tail is
   *  treated as the prompt instead.
   */
  private async handleWaz(args: string[], _sourcePanelId?: string): Promise<string> {
    if (!this.wazSpawner) return ".waz is not wired in this surface.";
    if (args.length === 0) return "Usage: .waz [<panel-command>] <prompt>";

    const activeId = this.panels.activePanelId;
    const app = activeId ? this.appConnector.get(activeId) : null;
    const wc = activeId ? this.wcGetter?.(activeId) : null;
    const firstKey = args[0].toLowerCase();
    const mapping = app?.commands[firstKey];
    let prompt: string;
    if (mapping && wc && !wc.isDestroyed()) {
      // Panel command first, then prompt — give the app a beat to settle
      // (the command may open a compose window etc).
      try { await executeCommand(wc, mapping); } catch { /* swallow — waz still runs */ }
      await new Promise((r) => setTimeout(r, 300));
      prompt = args.slice(1).join(" ").trim();
    } else {
      prompt = args.join(" ").trim();
    }
    if (!prompt) return ".waz needs a prompt.";
    this.wazSpawner(prompt);
    return ".waz spawned";
  }

  /** Parse and execute a command string (supports chaining). */
  async execute(input: string, sourcePanelId?: string): Promise<string> {
    const trimmed = input.trim();
    if (!trimmed) return "";

    const clean = (s: string) => s.replace(/\.(yo|sup|dip|drip|peace|waz)\b/gi, "$1");

    // .yo (search/agent) NEVER chains — entire input is one command.
    const yoMatch = trimmed.match(/^\.?yo\b/i);
    if (yoMatch) {
      return this.executeSingle(clean(trimmed), sourcePanelId);
    }
    // .sup (capture) can chain only when using dot modifier (.sup . .dip gmail).
    // Bare .sup never chains.
    const supMatch = trimmed.match(/^\.?sup\b/i);
    const isSupCapture = supMatch && /^\.?sup\s+\./i.test(trimmed);
    if (supMatch && !isSupCapture) {
      return this.executeSingle(clean(trimmed), sourcePanelId);
    }

    // Split on dot-prefixed keywords for chaining (.dip, .drip)
    const segments = this.splitChain(trimmed);

    // Single command — fast path
    if (segments.length === 1) return this.executeSingle(clean(segments[0]), sourcePanelId);

    // Chain: execute sequentially, return last non-empty result
    let lastResult = "";
    for (const segment of segments) {
      const result = await this.executeSingle(clean(segment), sourcePanelId);
      if (result) lastResult = result;
    }
    return lastResult;
  }

  // ── yo: opens the agent side panel, or dispatches a sub-mode ─────

  private async handleYo(args: string[]): Promise<string> {
    const query = args.join(" ").trim();
    return `__YO_PANEL__${query ? `:${query}` : ""}`;
  }


  // ── sup: capture screen ─────────────────────────────────

  private async handleSup(args: string[]): Promise<string> {
    if (!this.grabber) return "No panel grabber available.";

    // Parse dot modifier: everything after "." is the instruction
    // Bare .sup or .sup . = just capture
    // .sup . <skill/prompt> = capture + process
    let instruction = "";
    if (args[0] === ".") {
      instruction = args.slice(1).join(" ").trim();
    } else if (args.length === 0) {
      // Bare .sup → capture active panel
      instruction = "";
    } else {
      // .sup without dot modifier — treat as bare capture
      // (all args are ignored unless after a dot)
      instruction = "";
    }

    const content = await this.grabber(true);
    if (!content) return "Could not grab content from panels.";

    // Bare capture — no processing
    if (!instruction) {
      this.session.capture("command-bar", content, `${this.timestamp()}.md`, this.timestamp());
      this.session.copyToClipboard();
      return "";
    }

    // .sup . <prompt> used to LLM-process the capture; the in-app LLM is
    // gone (agents live in apps), so the raw capture passes through.
    const finalContent = content;

    const label = this.timestamp();
    this.session.capture("command-bar", finalContent, `${label}.md`, label);
    this.session.copyToClipboard();
    return finalContent;
  }

  /** Clear yo conversation state. */
  clearYoHistory(): void {
    this.yoHistory = [];
    this.yoContext = "";
  }

  private timestamp(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}-${String(now.getHours()).padStart(2,"0")}${String(now.getMinutes()).padStart(2,"0")}`;
  }

  private formatAge(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  // ── dip: switch panels + execute app commands ───────────────

  /**
   * Step through the open tabs in their bar order, wrapping around.
   * Forward (`back=false`) slides left→right; back slides right→left.
   */
  private cycleTabs(back: boolean, win: BrowserWindow): string {
    const tabs = this.tabLister?.() ?? [];
    if (tabs.length === 0) return "No open tabs";
    const active = this.panels.activePanelId;
    const idx = active ? tabs.indexOf(active) : -1;
    const len = tabs.length;
    const nextIdx = idx === -1
      ? (back ? len - 1 : 0)
      : (back ? (idx - 1 + len) % len : (idx + 1) % len);
    const target = tabs[nextIdx];
    this.layouts.suspendSplit();
    const ok = this.panels.switchTo(target, win, back ? "left" : "right");
    if (ok) setPreference("lastView", { type: "panel", id: target });
    return ok ? `→ ${target}` : `Unknown panel: ${target}`;
  }

  private async handleDip(args: string[], sourcePanelId?: string): Promise<string> {
    const win = this.mainWindow ?? BrowserWindow.getFocusedWindow();
    if (!win || win.isDestroyed()) return "No active window";

    // Bare `dip` steps forward through the open tabs (left→right slide).
    if (args.length === 0) return this.cycleTabs(false, win);

    const sub = args[0].toLowerCase();

    // `dip back` / `dip .` step backward through the open tabs (right→left slide).
    if (sub === "back" || (sub === "." && args.length === 1)) {
      return this.cycleTabs(true, win);
    }

    // dip . <panel-id> — swap just the calling panel within the current layout
    if (sub === "." && args.length >= 2) {
      const targetId = args[1].toLowerCase();
      const fromId = sourcePanelId ?? this.panels.activePanelId ?? "";
      if (fromId && this.layouts.swapCellAnimated(fromId, targetId, win)) {
        return `→ ${targetId}`;
      }
      // No active grid — fall through to a normal full switch
      this.layouts.suspendSplit();
      const switched = this.panels.switchTo(targetId, win);
      if (switched) setPreference("lastView", { type: "panel", id: targetId });
      return switched ? `Switched to ${targetId}` : `Unknown panel: ${targetId}. Try: dip list`;
    }

    // dip clear — close every open window/tab AND any layout (full reset).
    if (sub === "clear") {
      this.layouts.clearSplit();
      if (this.tabCloser && this.tabLister) {
        for (const id of this.tabLister()) this.tabCloser(id);
      }
      return "Cleared all windows and layouts.";
    }

    if (sub === "close") {
      if (!this.tabCloser || !this.tabLister) return "Tab manager not available.";
      const target = args[1]?.toLowerCase();
      if (target === "all") {
        const tabs = this.tabLister();
        for (const id of tabs) this.tabCloser(id);
        return "Closed all tabs.";
      }
      // Close specific tab or active tab
      const id = target || this.panels.activePanelId;
      if (!id) return "No active tab to close.";
      this.tabCloser(id);
      return `Closed: ${id}`;
    }

    if (sub === "refresh") {
      const target = args[1]?.toLowerCase();
      return this.panels.refresh(target)
        ? `Refreshed ${target || this.panels.activePanelId || "panel"}`
        : "Nothing to refresh";
    }

    if (sub === "clear-session") {
      const target = args[1]?.toLowerCase();
      this.panels.clearSession(target);
      return `Cleared session for ${target || this.panels.activePanelId || "panel"}`;
    }

    if (sub === "zoom") {
      if (!args[1]) return `Zoom: ${Math.round(this.panels.getZoom() * 100)}%`;
      const val = args[1] === "reset" ? 1.0 : parseFloat(args[1]);
      if (isNaN(val)) return "Usage: dip zoom <0.5-2.0 | reset>";
      this.panels.setZoom(val);
      setPreference("zoom", val);
      return `Zoom: ${Math.round(this.panels.getZoom() * 100)}%`;
    }

    if (sub === "list") {
      const apps = this.appConnector
        .list()
        .map((a) => `  ${a.id} — ${a.url}`)
        .join("\n");
      const layouts = this.layouts.listLayouts();
      if (layouts.length > 0) {
        const layoutList = layouts
          .map((l) => `  ${l.name} — ${l.cells.map((c) => c.panelId).join(" | ")}`)
          .join("\n");
        return `Apps:\n${apps}\n\nLayouts:\n${layoutList}`;
      }
      return apps;
    }

    if (sub === "add" && args.length >= 2) {
      const url = args[1];
      const id = url.replace(/https?:\/\//, "").split(/[./]/)[0];
      this.appConnector.add(id, id, url);
      this.panels.addPanel(id, url);
      return `Added: ${id} → ${url}`;
    }

    if (sub === "save") {
      const name = args[1]?.trim();
      if (!name) return "Usage: dip save <name>";
      const grid = this.layouts.getGridInfo();
      if (!grid) return "No active layout to save. Use .dip split first.";
      this.layouts.saveLayout({
        name,
        version: 2,
        cols: grid.cols,
        rows: grid.rows,
        colWidths: grid.colWidths,
        rowHeights: grid.rowHeights,
        cells: grid.cells.map((c) => ({
          panelId: c.panelId,
          col: c.col,
          row: c.row,
          colSpan: c.colSpan,
          rowSpan: c.rowSpan,
        })),
      });
      return `Layout saved: ${name}`;
    }

    // dip split <panel1> <panel2> [<panel3> ...] [/ <row2panels> ...]
    if (sub === "split" && args.length >= 3) {
      return this.handleDipSplit(args.slice(1), win);
    }

    // dip grid — full grid with spans, custom widths/heights
    if (sub === "grid" && args.length >= 2) {
      return this.handleDipGrid(args.slice(1), win);
    }

    // Check for saved layout
    if (this.layouts.isLayout(sub)) {
      const ok = this.layouts.apply(sub, win);
      if (!ok) return `Failed to apply layout: ${sub}`;
      setPreference("lastView", { type: "layout", name: sub });

      // If extra args, run them as commands on every matching panel in the layout
      const commands = args.slice(1);
      if (commands.length > 0) {
        const layout = this.layouts.getLayout(sub);
        if (layout) {
          const allResults: string[] = [`Layout: ${sub}`];
          for (const cell of layout.cells) {
            const app = this.appConnector.get(cell.panelId);
            if (!app) continue;
            const firstCmd = commands[0].toLowerCase();
            if (!(firstCmd in app.commands)) continue;

            const wc = this.wcGetter?.(cell.panelId);
            if (!wc || wc.isDestroyed()) continue;

            const panelResults: string[] = [cell.panelId];
            for (const cmd of commands) {
              const key = cmd.toLowerCase();
              const mapping = app.commands[key];
              if (!mapping) break;
              if (panelResults.length > 1) await new Promise((r) => setTimeout(r, 300));
              await executeCommand(wc, mapping);
              panelResults.push(mapping.description || key);
            }
            allResults.push(panelResults.join(" → "));
          }
          if (allResults.length === 1) return `Layout: ${sub} (no panel has command "${commands[0]}")`;
          return allResults.join("\n");
        }
      }
      return `Layout: ${sub}`;
    }

    // dip <url> — open URL in a new browser tab
    const rawUrl = args[0];
    if (/^https?:\/\//i.test(rawUrl) || /^localhost(:\d+)?(\/|$)/i.test(rawUrl) || /^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/|$)/.test(rawUrl)) {
      let target = rawUrl;
      if (!/^https?:\/\//i.test(target)) target = "http://" + target;
      if (this.tabCreator) {
        const tabId = this.tabCreator(target);
        return `Opened ${target} in new tab (${tabId})`;
      }
      return "Tab manager not available";
    }

    // dip <panel-id> [cmd1 cmd2 ...] — switch + optional app commands. Dipping to
    // anything that isn't a layout closes any open layout.
    this.layouts.clearSplit();
    const switched = this.panels.switchTo(sub, win);
    if (!switched) return `Unknown panel: ${sub}. Try: dip list`;
    setPreference("lastView", { type: "panel", id: sub });

    // No commands to run — just a switch
    const commands = args.slice(1);
    if (commands.length === 0) return `Switched to ${sub}`;

    // Execute commands sequentially on this panel
    const app = this.appConnector.get(sub);
    if (!app) return `Switched to ${sub} (no commands mapped)`;

    const wc = this.wcGetter?.(sub);
    if (!wc || wc.isDestroyed()) return `Switched to ${sub} (panel not loaded)`;

    const results: string[] = [`→ ${sub}`];
    for (const cmd of commands) {
      const key = cmd.toLowerCase();
      const mapping = app.commands[key];
      if (!mapping) {
        const available = Object.keys(app.commands);
        results.push(`Unknown command "${key}"${available.length > 0 ? `. Available: ${available.join(", ")}` : ""}`);
        break;
      }
      // Small delay between commands to let UI settle
      if (results.length > 1) await new Promise((r) => setTimeout(r, 300));
      await executeCommand(wc, mapping);
      results.push(mapping.description || key);
    }
    return results.join(" → ");
  }

  // ── dip split ────────────────────────────────────────────────

  private deduplicatePanelIds(ids: string[]): string[] {
    const seen = new Set<string>();
    return ids.map((id) => {
      if (!seen.has(id)) {
        seen.add(id);
        return id;
      }
      if (this.instanceCreator) {
        const instanceId = this.instanceCreator(id);
        if (instanceId) {
          seen.add(instanceId);
          return instanceId;
        }
      }
      return id;
    });
  }

  private handleDipSplit(splitArgs: string[], win: BrowserWindow): string {
    const ids = this.deduplicatePanelIds(splitArgs.map((a) => a.toLowerCase()));

    // Check for "/" row separator → multi-row grid
    if (ids.includes("/")) {
      const rows: string[][] = [];
      let current: string[] = [];
      for (const a of ids) {
        if (a === "/") {
          if (current.length > 0) rows.push(current);
          current = [];
        } else {
          current.push(a);
        }
      }
      if (current.length > 0) rows.push(current);
      const ok = this.layouts.splitGrid(rows, win);
      if (ok) setPreference("lastView", { type: "grid", rows });
      const label = rows.map((r) => r.join(" ")).join(" / ");
      return ok ? `Grid: ${label}` : "Unknown panel(s). Try: dip list";
    }

    // N panels in a single row
    if (ids.length === 2) {
      const ok = this.layouts.splitTwo(ids[0], ids[1], win);
      if (ok) setPreference("lastView", { type: "split", panels: ids });
      return ok ? `Split: ${ids.join(" | ")}` : "Unknown panel(s). Try: dip list";
    }
    const ok = this.layouts.splitN(ids, win);
    if (ok) setPreference("lastView", { type: "split", panels: ids });
    return ok ? `Split: ${ids.join(" | ")}` : "Unknown panel(s). Try: dip list";
  }

  // ── dip grid ─────────────────────────────────────────────────

  private handleDipGrid(args: string[], win: BrowserWindow): string {
    // Extract bracket groups [n,n,...] for custom widths/heights
    const bracketRe = /^\[([0-9,. ]+)\]$/;
    const brackets: number[][] = [];
    let cellStart = 0;

    for (let i = 0; i < args.length; i++) {
      const m = args[i].match(bracketRe);
      if (m) {
        brackets.push(m[1].split(",").map((v) => parseFloat(v.trim())));
        cellStart = i + 1;
      } else {
        break;
      }
    }

    // Remaining args are the cell definitions, joined and split by "/"
    const cellStr = args.slice(cellStart).join(" ");
    const rowStrs = cellStr.split(/\s*\/\s*/);

    if (rowStrs.length === 0 || (rowStrs.length === 1 && !rowStrs[0].trim())) {
      return "Usage: dip grid panel1,panel2 / panel3,panel4";
    }

    // Parse each row into cells with optional spans
    interface ParsedCell { id: string; colSpan: number; rowSpan: number }
    const parsedRows: ParsedCell[][] = [];
    const cellRe = /^([a-z0-9_-]+)(?::(\d+))?(?:\|(\d+))?$/i;

    for (const rowStr of rowStrs) {
      const items = rowStr.trim().split(/[, ]+/);
      const row: ParsedCell[] = [];
      for (const item of items) {
        if (!item) continue;
        const cm = item.match(cellRe);
        if (!cm) return `Invalid cell: "${item}". Format: panel or panel:colSpan|rowSpan`;
        row.push({
          id: cm[1].toLowerCase(),
          colSpan: cm[2] ? parseInt(cm[2], 10) : 1,
          rowSpan: cm[3] ? parseInt(cm[3], 10) : 1,
        });
      }
      if (row.length > 0) parsedRows.push(row);
    }

    if (parsedRows.length === 0) return "No panels specified.";

    const numRows = parsedRows.length;
    const rowColCounts = parsedRows.map((r) => r.reduce((s, c) => s + c.colSpan, 0));
    const numCols = Math.max(...rowColCounts);

    const seenIds = new Set<string>();
    const cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }> = [];
    for (let r = 0; r < parsedRows.length; r++) {
      let col = 0;
      for (const pc of parsedRows[r]) {
        let panelId = pc.id;
        if (seenIds.has(panelId) && this.instanceCreator) {
          const instanceId = this.instanceCreator(panelId);
          if (instanceId) panelId = instanceId;
        }
        seenIds.add(panelId);
        cells.push({
          panelId,
          col,
          row: r,
          colSpan: pc.colSpan,
          rowSpan: pc.rowSpan,
        });
        col += pc.colSpan;
      }
    }

    let colWidths: number[];
    if (brackets.length >= 1 && brackets[0].length === numCols) {
      const total = brackets[0].reduce((s, v) => s + v, 0);
      colWidths = brackets[0].map((v) => v / total);
    } else {
      colWidths = Array(numCols).fill(1 / numCols);
    }

    let rowHeights: number[];
    if (brackets.length >= 2 && brackets[1].length === numRows) {
      const total = brackets[1].reduce((s, v) => s + v, 0);
      rowHeights = brackets[1].map((v) => v / total);
    } else {
      rowHeights = Array(numRows).fill(1 / numRows);
    }

    const grid = {
      name: "",
      version: 2 as const,
      cols: numCols,
      rows: numRows,
      colWidths,
      rowHeights,
      cells,
    };

    const ok = this.layouts.applyGridLayout(grid, win);
    if (!ok) return "Unknown panel(s). Try: dip list";

    setPreference("lastView", { type: "grid-full", grid });

    const label = parsedRows.map((r) =>
      r.map((c) => {
        let s = c.id;
        if (c.colSpan > 1) s += `:${c.colSpan}`;
        if (c.rowSpan > 1) s += `|${c.rowSpan}`;
        return s;
      }).join(","),
    ).join(" / ");
    return `Grid: ${label}`;
  }

  // ── drip: CSS visual effects ────────────────────────────────

  private handleDrip(args: string[]): string {
    if (this.dripManager) return this.dripManager.execute(args);
    this.onDrip?.(args[0] || "fireworks");
    return "";
  }

  // ── peace: particle peace-sign gesture ──────────────────────

  private handlePeace(args: string[]): string {
    if (this.dripManager) return this.dripManager.execute(["peace", ...args]);
    this.onDrip?.("peace");
    return "";
  }

}

