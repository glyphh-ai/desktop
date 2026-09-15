/**
 * CommandParser — parses and executes sup/dip/drip/peace commands.
 *
 *   sup             → capture (retired with legacy panels — friendly no-op)
 *   dip <ref>       → open an app/layout as a workbench panel
 *   drip <effect>   → visual effect
 *   peace [count]   → particle peace-sign gesture
 *
 * The legacy BrowserView panel registry is gone: every `dip` routes through
 * the modern resolver (app-resolver → wb:app-cmd), which opens renderer-owned
 * webview panels in the home workbench.
 */

import { fetchOrgApps } from "./org-apps";
import {
  openAppByRef,
  openLayoutByName,
  openBrowserAt,
  clearWbPanels,
  gridWbPanels,
  closeOpenApp,
  listOpenAppWindows,
} from "./app-resolver";
import { fetchServerLayouts } from "./layout-manager";
import { showThinking, hideThinking } from "./thinking-overlay";

export class CommandParser {
  private static readonly COMMAND_KEYWORDS = new Set(["sup", "dip", "drip", "peace", "waz"]);

  private onDrip: ((effect: string) => void) | null = null;
  private dripManager: import("./drip-manager").DripManager | null = null;

  constructor() {}

  /** Register callback for drip effects */
  setDripHandler(fn: (effect: string) => void) {
    this.onDrip = fn;
  }

  setDripManager(mgr: import("./drip-manager").DripManager) {
    this.dripManager = mgr;
  }

  /** Split input at dot-prefixed command keyword boundaries for chaining.
   *  Only dot-prefixed keywords trigger a split — bare keywords appearing in
   *  natural language (e.g. "marketing yo") are left alone. */
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
  private async executeSingle(segment: string): Promise<string> {
    const parts = segment.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case "sup":
        return this.handleSup();
      case "dip":
        return this.handleDip(args);
      case "drip":
        return this.handleDrip(args);
      case "peace":
        return this.handlePeace(args);
      default:
        return `Unknown command: ${cmd}. Try sup, dip, or drip.`;
    }
  }

  /** Parse and execute a command string (supports chaining). */
  async execute(input: string): Promise<string> {
    const trimmed = input.trim();
    if (!trimmed) return "";

    const clean = (s: string) => s.replace(/\.(sup|dip|drip|peace|waz)\b/gi, "$1");

    // Split on dot-prefixed keywords for chaining (.dip, .drip)
    const segments = this.splitChain(trimmed);

    // Single command — fast path
    if (segments.length === 1) return this.executeSingle(clean(segments[0]));

    // Chain: execute sequentially, return last non-empty result
    let lastResult = "";
    for (const segment of segments) {
      const result = await this.executeSingle(clean(segment));
      if (result) lastResult = result;
    }
    return lastResult;
  }

  // ── sup: capture screen ─────────────────────────────────

  private handleSup(): string {
    // Panel content capture rode the legacy BrowserView registry; workspace
    // panels are renderer-owned webviews now, so there is nothing to grab
    // from the main process.
    return "sup capture was retired with legacy panels.";
  }

  // ── dip: open apps / layouts as workbench panels ─────────────

  private async handleDip(args: string[]): Promise<string> {
    // Bare `dip` lists the open workspace panels.
    if (args.length === 0) {
      const open = await listOpenAppWindows();
      if (open.length === 0) return "No workspace panels open. Try: dip <app>";
      return `Open panels:\n${open.map((a) => `  ${a.slug} — ${a.name}`).join("\n")}`;
    }

    const sub = args[0].toLowerCase();

    // `dip a | b | c` — open several apps, each per its own config.
    if (args.join(" ").includes("|")) {
      const names = args.join(" ").split("|").map((s) => s.trim()).filter(Boolean);
      const opened: string[] = [];
      for (const n of names) {
        const r = await openAppByRef(n).catch(() => null);
        if (r) opened.push(r.name);
      }
      return opened.length ? `Opened ${opened.join(", ")}` : "No apps matched";
    }

    // dip clear — close all WORKSPACE PANELS. Panels only: sessions and
    // everything else stay untouched.
    if (sub === "clear") {
      try { clearWbPanels(); } catch (err) { return err instanceof Error ? err.message : String(err); }
      return "Closed all workspace panels.";
    }

    if (sub === "close") {
      const target = args[1]?.toLowerCase();
      if (!target || target === "all") {
        try { clearWbPanels(); } catch (err) { return err instanceof Error ? err.message : String(err); }
        return "Closed all workspace panels.";
      }
      closeOpenApp(target);
      return `Closed: ${target}`;
    }

    if (sub === "list") {
      const [apps, layouts] = await Promise.all([
        fetchOrgApps().catch(() => []),
        fetchServerLayouts().catch(() => []),
      ]);
      const appLines = apps.map((a) => `  ${a.slug} — ${a.name}`).join("\n") || "  (none)";
      if (layouts.length > 0) {
        const layoutLines = layouts
          .map((l) => `  ${l.name} — ${l.cells.map((c) => c.panelId).join(" | ")}`)
          .join("\n");
        return `Apps:\n${appLines}\n\nLayouts:\n${layoutLines}`;
      }
      return `Apps:\n${appLines}`;
    }

    // dip grid — re-flow the open workspace panels into an even grid.
    if (sub === "grid") {
      try { gridWbPanels(); } catch (err) { return err instanceof Error ? err.message : String(err); }
      return "Arranged panels in a grid.";
    }

    // dip <url> — open the URL in the workbench Browser panel. Checked BEFORE
    // layouts so a url is never offered to the layout resolver.
    const rawUrl = args[0];
    if (/^https?:\/\//i.test(rawUrl) || /^localhost(:\d+)?(\/|$)/i.test(rawUrl) || /^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/|$)/.test(rawUrl)) {
      let target = rawUrl;
      if (!/^https?:\/\//i.test(target)) target = "http://" + target;
      openBrowserAt(target);
      return `Opened ${target} in the Browser panel`;
    }

    // Saved layout — EXACTLY the palette button's mechanism (layouts-open →
    // openLayoutByName): same resolver, same thinking overlay, nothing else.
    showThinking();
    try {
      const opened = await openLayoutByName(sub);
      return `Workspace: ${opened.layout}`;
    } catch {
      // Not a saved layout — fall through to app resolution.
    } finally {
      hideThinking();
    }

    // ONE path — the modern resolver (app library, nav sections, workbench
    // builtins). No legacy panel registry, no fallbacks: a ref either
    // resolves here or it isn't a thing.
    const opened = await openAppByRef(sub).catch(() => null);
    if (opened) return `Opened ${opened.name}`;
    return `Unknown app or layout: ${sub}. Try: dip list`;
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
