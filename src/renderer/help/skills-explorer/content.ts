/**
 * content.ts — the explorer's right pane (read-only).
 *   • showSkill(name) — overview: name + description + rendered SKILL.md +
 *     actions (Run, Export, Delete) + enabled toggle.
 *   • showFile(name, rel) — markdown renders by default (toggle to source);
 *     code → read-only Monaco; media → player. Copy.
 *   • showCreate() — minimal new-skill form that hands off to the .Yo agent.
 */

import { el } from "./dom.js";
import { formatMarkdown } from "../../format-markdown.js";
import { RunConsole } from "./run-console.js";
import { buildSkillGraph } from "./flow-graph.js";

const renderMarkdown = (src: string | null | undefined): string => formatMarkdown(src || "");

// ── React Flow island (lazy) ────────────────────────────────
// skill-flow.js + skill-flow.css are esbuild-bundled separately and only
// pulled in the first time a user opens the workflow view.
interface SkillFlowApi {
  mount: (
    container: HTMLElement,
    graph: unknown,
    opts?: {
      onPositionsChange?: (positions: Record<string, { x: number; y: number }>) => void;
      onOpenApp?: (appId: string) => void;
    },
  ) => void;
  unmount: (container: HTMLElement) => void;
}
const skillFlowApi = (): SkillFlowApi | undefined =>
  (window as unknown as { SkillFlow?: SkillFlowApi }).SkillFlow;

let skillFlowReady: Promise<void> | null = null;
function ensureSkillFlow(): Promise<void> {
  if (skillFlowApi()) return Promise.resolve();
  if (skillFlowReady) return skillFlowReady;
  skillFlowReady = new Promise<void>((resolve, reject) => {
    if (!document.querySelector("link[data-skill-flow]")) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "skill-flow.css";
      link.setAttribute("data-skill-flow", "");
      document.head.appendChild(link);
    }
    const s = document.createElement("script");
    s.src = "skill-flow.js";
    s.onload = () => resolve();
    s.onerror = () => { skillFlowReady = null; reject(new Error("skill-flow bundle failed to load")); };
    document.body.appendChild(s);
  });
  return skillFlowReady;
}

// ── Monaco (read-only) ──────────────────────────────────────
let monacoReady: Promise<void> | null = null;
function ensureMonaco(): Promise<void> {
  if (monacoReady) return monacoReady;
  monacoReady = new Promise<void>((resolve) => {
    const w = window as unknown as { monaco?: unknown; require: any };
    if (w.monaco) { resolve(); return; }
    w.require.config({ paths: { vs: "monaco" } });
    w.require(["vs/editor/editor.main"], () => resolve());
  });
  return monacoReady;
}
function languageForFile(rel: string): string {
  const ext = rel.toLowerCase().split(".").pop() || "";
  const map: Record<string, string> = {
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
    ts: "typescript", tsx: "typescript", json: "json", md: "markdown", mdx: "markdown",
    markdown: "markdown", yaml: "yaml", yml: "yaml", html: "html", htm: "html",
    css: "css", scss: "scss", less: "less", sh: "shell", bash: "shell", py: "python",
    rb: "ruby", go: "go", rs: "rust", toml: "ini", ini: "ini", xml: "xml", svg: "xml",
  };
  return map[ext] || "plaintext";
}
const monacoTheme = () =>
  (document.documentElement.dataset.theme || document.body.dataset.theme) === "dark" ? "vs-dark" : "vs";
const isMarkdown = (f: string) => /\.(md|mdx|markdown)$/i.test(f);

function mediaKind(rel: string): "image" | "audio" | "video" | null {
  const ext = rel.toLowerCase().split(".").pop() || "";
  if (/^(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/.test(ext)) return "image";
  if (/^(wav|mp3|ogg|m4a|aac|flac|opus)$/.test(ext)) return "audio";
  if (/^(mp4|webm|mov|m4v|ogv|mkv)$/.test(ext)) return "video";
  return null;
}

// ── Icons ───────────────────────────────────────────────────
const EYE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`;
const CODE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`;
const COPY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const PLAY = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 4 20 12 6 20 6 4"/></svg>`;
const KEBAB = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>`;
const EXPORT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
const INFO = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
const FLOW = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><path d="M9 6h6M9 6v9a3 3 0 0 0 3 3h3"/></svg>`;

const iconBtn = (icon: string, title: string) =>
  el("button", { class: "skill-icon-btn", html: icon, attrs: { title } });

export interface SkillContentDeps {
  confirm: (msg: string) => Promise<boolean>;
  onChanged: () => void;
  onSelectSkill: (name: string) => void;
  /** Hand a composed build-prompt to the yo agent. */
  buildWithAgent: (prompt: string) => void;
}

export class SkillContent {
  readonly root: HTMLElement;
  private bar: HTMLElement;
  private body: HTMLElement;
  private monaco: any = null;
  private monacoHost: HTMLElement;
  private mdHost: HTMLElement;
  private flowHost: HTMLElement;
  private flowMounted = false;
  private runConsole = new RunConsole();
  private fileCache = new Map<string, string>();
  private mdMode = new Map<string, "rendered" | "code">();

  constructor(private deps: SkillContentDeps) {
    this.bar = el("div", { class: "skill-content-bar" });
    this.monacoHost = el("div", { class: "skill-monaco hidden" });
    this.mdHost = el("div", { class: "skill-md-render yo-md hidden" });
    this.runConsole.root.classList.add("hidden");
    this.flowHost = el("div", { class: "skill-flow-host hidden" });
    this.body = el("div", { class: "skill-content-body" }, [this.mdHost, this.monacoHost, this.runConsole.root, this.flowHost]);
    this.root = el("div", { class: "skill-content" }, [this.bar, this.body]);
    this.showEmpty();
  }

  showEmpty(): void {
    this.bar.innerHTML = "";
    this.hideAll();
    this.mdHost.classList.remove("hidden");
    this.mdHost.innerHTML = `<div class="skill-content-empty">Select a skill or a file.</div>`;
  }

  private hideAll(): void {
    this.mdHost.classList.add("hidden");
    this.monacoHost.classList.add("hidden");
    this.runConsole.root.classList.add("hidden");
    if (this.flowMounted) { skillFlowApi()?.unmount(this.flowHost); this.flowMounted = false; }
    this.flowHost.classList.add("hidden");
  }

  // ── Skill overview ──
  async showSkill(name: string): Promise<void> {
    this.hideAll();
    this.mdHost.classList.remove("hidden");
    this.bar.innerHTML = "";
    this.bar.append(el("span", { class: "skill-content-title", text: name }));

    const disabled = (await window.yo.getPreference("skillsDisabled", [])) as string[] || [];
    const cb = el("input", { attrs: { type: "checkbox" } }) as HTMLInputElement;
    cb.checked = !disabled.includes(name);
    cb.addEventListener("change", () => void this.setEnabled(name, cb.checked));
    const toggle = el("label", { class: "skill-toggle", attrs: { title: "Enabled" } }, [
      cb, el("span", { class: "skill-toggle-track" }, [el("span", { class: "skill-toggle-thumb" })]),
    ]);
    const flowBtn = iconBtn(FLOW, "View as workflow");
    flowBtn.addEventListener("click", () => void this.showFlow(name));
    const kebab = iconBtn(KEBAB, "More");
    kebab.addEventListener("click", (e) => { e.stopPropagation(); this.openSkillMenu(name, kebab); });
    this.bar.append(el("div", { class: "skill-content-actions" }, [flowBtn, toggle, kebab]));

    const full = await window.yo.skillsGet(name).catch(() => null);
    const desc = (full?.manifest?.description as string) || "";
    const sched = full?.manifest?.schedule as string | undefined;
    const trigger = sched ? `Scheduled · ${escapeHtml(sched)}` : "Manual";
    const body = full?.prompt || "";

    this.mdHost.innerHTML =
      `<div class="skill-meta-grid">` +
        `<div class="skill-meta-col"><div class="skill-meta-h">Added by</div><div class="skill-meta-v">You</div></div>` +
        `<div class="skill-meta-col"><div class="skill-meta-h">Trigger</div><div class="skill-meta-v">${trigger}</div></div>` +
      `</div>` +
      `<div class="skill-desc-block"><div class="skill-desc-label">Description` +
        `<button class="skill-desc-help" type="button" aria-label="About description">${INFO}</button>` +
        `<span class="skill-desc-tip hidden">Glyphh uses this to help pick the right tool during chat</span>` +
      `</div>` +
      `<p class="skill-desc-text">${desc ? escapeHtml(desc) : "<em>No description.</em>"}</p></div>` +
      `<hr class="skill-divider"/>` +
      renderMarkdown(body);

    const help = this.mdHost.querySelector<HTMLElement>(".skill-desc-help");
    const tip = this.mdHost.querySelector<HTMLElement>(".skill-desc-tip");
    help?.addEventListener("click", (e) => { e.stopPropagation(); tip?.classList.toggle("hidden"); });
  }

  // ── Workflow (React Flow) view ──
  async showFlow(name: string): Promise<void> {
    this.hideAll();
    this.flowHost.classList.remove("hidden");

    this.bar.innerHTML = "";
    this.bar.append(el("span", { class: "skill-content-title", text: name }));
    const back = iconBtn(INFO, "Back to overview");
    back.addEventListener("click", () => void this.showSkill(name));
    this.bar.append(el("div", { class: "skill-content-actions" }, [back]));

    this.flowHost.replaceChildren(el("div", { class: "skill-flow-loading", text: "Loading workflow…" }));
    try {
      await ensureSkillFlow();
      const data = await window.yo.skillsGet(name).catch(() => null);
      // Apps the skill is wired to (allowed-tools namespaced by app id) become
      // clickable tiles that open that app's panel.
      const apps = await window.yo.appsList().catch(() => []);
      const graph = buildSkillGraph(name, data, apps);
      // Apply the user's saved layout (dragged node positions), then persist
      // any further drags — keyed per skill so it survives edits/reopens.
      const prefKey = `skillFlow:${name}`;
      const saved = (await window.yo.getPreference(prefKey, {})) as Record<string, { x: number; y: number }>;
      for (const n of graph.nodes) { const p = saved?.[n.id]; if (p) n.position = p; }
      this.flowHost.replaceChildren();
      skillFlowApi()?.mount(this.flowHost, graph, {
        onPositionsChange: (positions) => { void window.yo.setPreference(prefKey, positions); },
        onOpenApp: (appId) => { void window.yo.execCommand(`dip ${appId}`); },
      });
      this.flowMounted = true;
    } catch {
      this.flowHost.replaceChildren(el("div", { class: "skill-flow-loading", text: "Could not load the workflow view." }));
    }
  }

  private async setEnabled(name: string, on: boolean): Promise<void> {
    const cur = (await window.yo.getPreference("skillsDisabled", [])) as string[] || [];
    const next = on ? cur.filter((n) => n !== name) : Array.from(new Set([...cur, name]));
    window.yo.setPreference("skillsDisabled", next);
  }

  private openSkillMenu(name: string, anchor: HTMLElement): void {
    document.querySelector(".skill-kebab-menu")?.remove();
    const item = (icon: string, label: string, danger: boolean, onClick: () => void) => {
      const b = el("button", { class: `ws-popover-item${danger ? " danger" : ""}` }, [
        el("span", { class: "skill-menu-icon", html: icon }), el("span", { text: label }),
      ]);
      b.addEventListener("click", () => { menu.remove(); onClick(); });
      return b;
    };
    // View/run-only: skills are authored by the assistant, so no Delete here —
    // just Run and Export.
    const menu = el("div", { class: "ws-popover skill-kebab-menu open" }, [
      item(PLAY, "Run", false, () => { this.hideAll(); this.runConsole.root.classList.remove("hidden"); void this.runConsole.run(name); }),
      item(EXPORT, "Export", false, () => void this.exportSkill(name)),
    ]);
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${r.bottom + 4}px`;
    menu.style.left = `${Math.min(r.left, window.innerWidth - 200)}px`;
    const close = () => { menu.remove(); document.removeEventListener("click", close); };
    setTimeout(() => document.addEventListener("click", close), 0);
  }

  private async exportSkill(name: string): Promise<void> {
    const b64 = await window.yo.skillsExport(name).catch(() => null);
    if (!b64) return;
    const a = document.createElement("a");
    a.href = `data:application/octet-stream;base64,${b64}`;
    a.download = `${name}.yo`;
    a.click();
  }

  // ── File view ──
  async showFile(name: string, rel: string): Promise<void> {
    const key = `${name}/${rel}`;
    const md = isMarkdown(rel);
    const copy = iconBtn(COPY, "Copy");
    copy.addEventListener("click", () => {
      window.yo.copyToClipboard(this.fileCache.get(key) || "");
      copy.innerHTML = CHECK; setTimeout(() => { copy.innerHTML = COPY; }, 1200);
    });

    const toggleBtn = el("button", { class: "skill-icon-btn skill-md-toggle", html: CODE, attrs: { title: "View source" } });
    toggleBtn.addEventListener("click", () => {
      const cur = this.mdMode.get(key) || "rendered";
      this.mdMode.set(key, cur === "rendered" ? "code" : "rendered");
      void this.renderFile(name, rel);
    });

    this.bar.innerHTML = "";
    this.bar.append(el("span", { class: "skill-content-filename", text: rel }));
    const actions = el("div", { class: "skill-content-actions" }, [copy]);
    if (md) actions.prepend(toggleBtn);
    this.bar.append(actions);

    await this.renderFile(name, rel);
  }

  private async renderFile(name: string, rel: string): Promise<void> {
    const media = mediaKind(rel);
    if (media) {
      this.hideAll();
      this.mdHost.classList.remove("hidden");
      this.mdHost.innerHTML = "";
      const src = await window.yo.skillsFileUrl(name, rel).catch(() => "");
      if (!src) { this.mdHost.innerHTML = `<div class="skill-content-empty">Preview unavailable.</div>`; return; }
      const node = media === "image" ? el("img", { class: "skill-media skill-media-img", attrs: { src } })
        : media === "audio" ? el("audio", { class: "skill-media skill-media-audio", attrs: { src, controls: "" } })
        : el("video", { class: "skill-media skill-media-video", attrs: { src, controls: "" } });
      this.mdHost.append(el("div", { class: "skill-media-wrap" }, [node]));
      return;
    }
    const key = `${name}/${rel}`;
    if (!this.fileCache.has(key)) this.fileCache.set(key, (await window.yo.skillsReadFile(name, rel)) || "");
    const text = this.fileCache.get(key) || "";
    const md = isMarkdown(rel);
    const mode = md ? (this.mdMode.get(key) || "rendered") : "code";
    const tbtn = this.bar.querySelector<HTMLElement>(".skill-md-toggle");
    if (tbtn) {
      const rendered = mode === "rendered";
      tbtn.innerHTML = rendered ? CODE : EYE;
      tbtn.title = rendered ? "View source" : "View rendered";
      tbtn.classList.toggle("active", !rendered);
    }
    this.hideAll();
    if (mode === "rendered") {
      this.mdHost.classList.remove("hidden");
      this.mdHost.innerHTML = renderMarkdown(text);
    } else {
      this.monacoHost.classList.remove("hidden");
      await this.showSource(text, languageForFile(rel));
    }
  }

  private async showSource(text: string, lang: string): Promise<void> {
    await ensureMonaco();
    const w = window as unknown as { monaco: any };
    if (this.monaco) {
      this.monaco.setModel(w.monaco.editor.createModel(text, lang));
    } else {
      this.monaco = w.monaco.editor.create(this.monacoHost, {
        value: text, language: lang, theme: monacoTheme(), readOnly: true,
        fontSize: 12, fontFamily: "'SF Mono', 'Fira Code', 'JetBrains Mono', Menlo, monospace",
        minimap: { enabled: false }, wordWrap: "on", automaticLayout: true,
        padding: { top: 8 }, scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
      });
    }
    setTimeout(() => this.monaco?.layout?.(), 0);
  }

  relayout(): void { this.monaco?.layout?.(); }

  // ── Create mode ──
  showCreate(): void {
    const nameInput = el("input", { class: "settings-input", attrs: { type: "text", placeholder: "skill-name", spellcheck: "false" } }) as HTMLInputElement;
    const descInput = el("input", { class: "settings-input", attrs: { type: "text", placeholder: "Short description", spellcheck: "false" } }) as HTMLInputElement;
    const instrInput = el("textarea", { class: "settings-input skill-create-instr", attrs: { rows: "8", placeholder: "Describe what the skill should do — steps, tools/apps it uses, inputs, outputs. The Glyphh agent turns this into a working skill." } }) as HTMLTextAreaElement;
    const err = el("div", { class: "skill-form-error hidden" });
    const build = el("button", { class: "action-btn primary", text: "Build with Glyphh" });
    build.addEventListener("click", () => {
      const name = nameInput.value.trim();
      const instr = instrInput.value.trim();
      if (!name) { err.textContent = "Name is required."; err.classList.remove("hidden"); return; }
      if (!instr) { err.textContent = "Instructions are required."; err.classList.remove("hidden"); return; }
      const desc = descInput.value.trim();
      const prompt =
        `Build a new Glyphh skill (not a plain Claude skill) named "${name}".\n` +
        (desc ? `Description: ${desc}\n` : "") +
        `\nInstructions:\n${instr}\n\n` +
        `Create the skill folder under ~/.claude/skills with a SKILL.md, and add a SKILL.js runner if it needs to execute code or call tools. Wire any tools/apps it needs.`;
      this.deps.buildWithAgent(prompt);
      // Close the form — the prompt is now in the .Yo agent panel, and the
      // skill itself will materialize in the tree via the skills-changed
      // watcher as the agent writes files. Drop back to the empty state so
      // the user can watch the agent work.
      this.showEmpty();
    });
    this.bar.innerHTML = "";
    this.bar.append(el("span", { class: "skill-content-title", text: "New skill" }));
    this.hideAll();
    this.mdHost.classList.remove("hidden");
    this.mdHost.innerHTML = "";
    this.mdHost.append(el("div", { class: "skill-create-form" }, [
      el("label", { class: "skill-create-label", text: "Name" }), nameInput,
      el("label", { class: "skill-create-label", text: "Description" }), descInput,
      el("label", { class: "skill-create-label", text: "Instructions" }), instrInput,
      err, el("div", { class: "skill-create-actions" }, [build]),
      el("p", { class: "skill-create-hint", text: "Your instructions go through the Glyphh agent loop, which builds the skill for you. You can refine the prompt before sending." }),
    ]));
    nameInput.focus();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}
