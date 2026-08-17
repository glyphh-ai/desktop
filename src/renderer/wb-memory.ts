/**
 * wb-memory.ts — the GLYPHH MEMORY workbench panel: a window onto the org's
 * one memory plane (the stator), from plainest to deepest:
 *
 *   Facts      — the stored facts, tier-badged, editable, deletable
 *   Semantic   — the similarity corpus (mid-term): every chunk + its metadata
 *   Short-term — the session recency window + short-tier facts, pure
 *   adaL       — the context graph: entities ↔ fillers over role edges (SVG)
 *   Glyphh     — the full semantic space in three.js: cortex glyphs as cubes,
 *                orbit/zoom/pan, search-to-highlight, similarity edges in two
 *                bands (semantic ≥ .85 bright, neural .25–.45 faint)
 *
 * Curation is the point: delete removes from the org's stator for real, edit
 * supersedes the fact's version chain. three.js loads lazily from the shipped
 * app-lib the first time the Glyphh tab opens.
 */

import { officePager, officePage } from "./wb-office-ui.js";

// ── wire shapes (structural mirrors of the SDK contract) ─────────────────────
interface MemFact {
  entity: string; role: string; filler: string;
  key?: string; is_current: boolean; speaker?: string;
  tick: number; tier?: "short" | "mid" | "long"; session?: string;
}
interface GraphNode { id: number; kind: "turn" | "fact"; text: string; tier?: string; entity?: string; role?: string }
interface GraphEdge { a: number; b: number; sim: number; kind: string }

export interface MemorySlotState {
  id: number;
  tab?: number;
  showHistory?: boolean;
  /** Per-section page cursors ("facts:long", "sem", …) — survive re-renders. */
  pages?: Record<string, number>;
}

export interface MemoryHost {
  confirm: (opts: { title: string; body?: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>;
  icon: string;
}

const api = () => (window as unknown as { glyphh?: {
  memoryBrowse?: (threadId?: string) => Promise<{ ok: boolean; facts: MemFact[]; turns: string[]; window: Array<{ speaker: string; text: string }>; error?: string }>;
  memoryGraph?: (opts?: unknown) => Promise<{ ok: boolean; nodes: GraphNode[]; coords: Array<[number, number, number]>; edges: GraphEdge[]; error?: string }>;
  memorySearch?: (query: string, topK?: number) => Promise<{ ok: boolean; recalled: Array<{ text: string; score: number }>; directives: string[]; error?: string }>;
  memoryForget?: (input: unknown) => Promise<{ ok: boolean; deleted?: number; error?: string }>;
  memoryAmend?: (input: unknown) => Promise<{ ok: boolean; written?: number; error?: string }>;
} }).glyphh ?? {};

const TABS = ["Facts", "Semantic", "Short-term", "adaL", "Glyphh"] as const;

const TIER_COLOR: Record<string, string> = { long: "#f5f5f7", mid: "#ec4899", short: "#2dd4bf" };
const TURN_COLOR = "#8c3bf2";

/** "[2026-08-17] user: text" → its parts; missing prefixes degrade gracefully. */
function parseTurn(t: string): { date: string; speaker: string; text: string } {
  const m = /^(?:\[([^\]]+)\]\s*)?(?:([\w.-]{1,24}):\s*)?([\s\S]*)$/.exec(t);
  return { date: m?.[1] ?? "", speaker: m?.[2] ?? "", text: m?.[3] ?? t };
}

// ── three.js lazy loader (the shipped app-lib; window.THREE global) ──────────
/* eslint-disable @typescript-eslint/no-explicit-any */
let threePromise: Promise<any> | null = null;
function loadThree(): Promise<any> {
  const w = window as any;
  if (w.THREE) return Promise.resolve(w.THREE);
  threePromise ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "app-libs/three.js";
    s.onload = () => (w.THREE ? resolve(w.THREE) : reject(new Error("three.js loaded but exposed no global")));
    s.onerror = () => { threePromise = null; reject(new Error("three.js failed to load")); };
    document.head.appendChild(s);
  });
  return threePromise;
}

export interface MemoryPanel {
  renderIntoSlot: (body: HTMLElement, slot: MemorySlotState, wrap: HTMLElement) => Promise<void>;
  invalidate: () => void;
}

export function initMemory(host: MemoryHost): MemoryPanel {
  // One browse per open (all list tabs share it); graph fetched on first 3D view.
  let browseCache: { facts: MemFact[]; turns: string[]; window: Array<{ speaker: string; text: string }> } | null = null;
  let graphCache: { nodes: GraphNode[]; coords: Array<[number, number, number]>; edges: GraphEdge[] } | null = null;
  /** Live three.js teardown for the CURRENT mount — re-renders must not leak a RAF. */
  let disposeScene: (() => void) | null = null;

  async function renderIntoSlot(body: HTMLElement, slot: MemorySlotState, wrap: HTMLElement): Promise<void> {
    try {
      await renderInner(body, slot, wrap);
    } catch (err) {
      console.warn("[gmemory] render failed:", err);
      if (body.isConnected) {
        body.innerHTML = `<div class="gdoc-empty">Memory hit an error rendering.<br><code class="gpoint-err"></code></div>`;
        const code = body.querySelector(".gpoint-err");
        if (code) code.textContent = err instanceof Error ? err.message : String(err);
      }
    }
  }

  async function renderInner(body: HTMLElement, slot: MemorySlotState, wrap: HTMLElement): Promise<void> {
    disposeScene?.();
    disposeScene = null;
    body.classList.add("ws-gmemory-body");
    const titleEl = wrap.querySelector(".ws-rail-slot-header .title");
    if (titleEl) titleEl.textContent = "Memory";
    const refresh = (): void => { if (body.isConnected) void renderIntoSlot(body, slot, wrap); };
    const hardRefresh = (): void => { browseCache = null; graphCache = null; refresh(); };

    body.innerHTML = `
      <div class="gmem">
        <div class="gmem-bar">
          <div class="gmem-tabs"></div>
          <input class="gmem-search" type="text" placeholder="Search this memory…" spellcheck="false" autocomplete="off" />
          <button class="ws-icon-btn gmem-refresh" title="Refresh">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.3"/><polyline points="21 3 21 9 15 9"/></svg>
          </button>
        </div>
        <div class="gmem-body"></div>
      </div>`;
    body.querySelector(".gmem-refresh")?.addEventListener("click", hardRefresh);

    const tabsEl = body.querySelector<HTMLElement>(".gmem-tabs")!;
    const tab = slot.tab ?? 0;
    TABS.forEach((name, i) => {
      const b = document.createElement("button");
      b.className = "gmem-tab" + (i === tab ? " on" : "");
      b.textContent = name;
      b.addEventListener("click", () => { slot.tab = i; refresh(); });
      tabsEl.appendChild(b);
    });

    const pane = body.querySelector<HTMLElement>(".gmem-body")!;
    const search = body.querySelector<HTMLInputElement>(".gmem-search")!;

    if (!browseCache) {
      pane.innerHTML = `<div class="gdoc-empty">Reading the stator…</div>`;
      const res = await api().memoryBrowse?.();
      if (!body.isConnected) return;
      if (!res?.ok) {
        pane.innerHTML = `<div class="gdoc-empty">Couldn't reach your memory.<br><code class="gpoint-err"></code></div>`;
        const code = pane.querySelector(".gpoint-err");
        if (code) code.textContent = res?.error ?? "no memory surface here";
        return;
      }
      browseCache = { facts: res.facts, turns: res.turns, window: res.window };
    }
    const data = browseCache;

    if (tab === 0) renderFacts(pane, slot, data, search, refresh);
    else if (tab === 1) renderSemantic(pane, slot, data, search, refresh);
    else if (tab === 2) renderShortTerm(pane, slot, data);
    else if (tab === 3) await renderAdal(pane, data, search);
    else await renderGlyphh(pane, search, refresh);
  }

  // ── collapsible, paginated list sections (every list tab rides this) ───────

  const PER_PAGE = 25;
  function listSection<T>(
    parent: HTMLElement,
    slot: MemorySlotState,
    key: string,
    title: string,
    hint: string,
    items: T[],
    rowOf: (item: T) => HTMLElement,
    open = true,
  ): void {
    const sec = document.createElement("details");
    sec.className = "gmem-sec";
    sec.open = open;
    sec.innerHTML = `<summary>${title} <em class="gmem-sec-count">${items.length}</em><span class="gmem-hint">${hint}</span></summary><div class="gmem-list"></div>`;
    const list = sec.querySelector<HTMLElement>(".gmem-list")!;
    const paint = (): void => {
      list.textContent = "";
      sec.querySelector(".office-pager")?.remove();
      slot.pages ??= {};
      const paged = officePage(items, slot.pages[key] ?? 0, PER_PAGE);
      slot.pages[key] = paged.page;
      for (const item of paged.items) list.appendChild(rowOf(item));
      const pager = officePager(items.length, paged.page, PER_PAGE, (pg) => { slot.pages![key] = pg; paint(); });
      if (pager) sec.appendChild(pager);
    };
    paint();
    parent.appendChild(sec);
  }

  // ── Facts — the stored facts, plainly ──────────────────────────────────────

  function tierBadge(tier?: string): string {
    const t = tier ?? "long";
    return `<span class="gmem-tier gmem-tier-${t}">${t}</span>`;
  }

  function renderFacts(
    pane: HTMLElement,
    slot: MemorySlotState,
    data: { facts: MemFact[] },
    search: HTMLInputElement,
    refresh: () => void,
  ): void {
    pane.innerHTML = `
      <div class="gmem-facts">
        <div class="gmem-facts-head">
          <span class="gmem-count"></span>
          <label class="gmem-history"><input type="checkbox" ${slot.showHistory ? "checked" : ""}/> show superseded versions</label>
        </div>
        <div class="gmem-secs"></div>
        <div class="gdoc-empty hidden">No stored facts yet — they accumulate as you work.</div>
      </div>`;
    pane.querySelector<HTMLInputElement>(".gmem-history input")?.addEventListener("change", (ev) => {
      slot.showHistory = (ev.target as HTMLInputElement).checked;
      refresh();
    });
    const secs = pane.querySelector<HTMLElement>(".gmem-secs")!;
    const empty = pane.querySelector<HTMLElement>(".gdoc-empty")!;
    const count = pane.querySelector<HTMLElement>(".gmem-count")!;

    const factRow = (f: MemFact): HTMLElement => {
      const row = document.createElement("div");
      row.className = "gmem-fact" + (f.is_current ? "" : " superseded");
      row.innerHTML = `
        ${tierBadge(f.tier)}
        <span class="gmem-fact-entity"></span>
        <span class="gmem-fact-role"></span>
        <span class="gmem-fact-filler" title="Click to edit"></span>
        <span class="gmem-fact-meta"></span>
        <button class="ws-icon-btn gmem-del" title="Forget this fact">✕</button>`;
      (row.querySelector(".gmem-fact-entity") as HTMLElement).textContent = f.entity;
      (row.querySelector(".gmem-fact-role") as HTMLElement).textContent = f.role;
      (row.querySelector(".gmem-fact-filler") as HTMLElement).textContent = f.filler;
      (row.querySelector(".gmem-fact-meta") as HTMLElement).textContent =
        [f.speaker, f.session ? `session ${f.session.slice(0, 8)}` : ""].filter(Boolean).join(" · ");
      const fillerEl = row.querySelector<HTMLElement>(".gmem-fact-filler")!;
      fillerEl.addEventListener("click", () => {
        if (!f.is_current || fillerEl.querySelector("input")) return;
        const input = document.createElement("input");
        input.className = "gmem-edit";
        input.value = f.filler;
        fillerEl.textContent = "";
        fillerEl.appendChild(input);
        input.focus();
        input.select();
        const done = (commit: boolean): void => {
          const v = input.value.trim();
          if (!commit || !v || v === f.filler) { fillerEl.textContent = f.filler; return; }
          void (async () => {
            const r = await api().memoryAmend?.({ entity: f.entity, role: f.role, filler: v, ...(f.key ? { key: f.key } : {}), ...(f.tier ? { tier: f.tier } : {}) });
            if (!r?.ok) { void host.confirm({ title: "Couldn't amend", body: r?.error ?? "Unknown error.", confirmLabel: "OK" }); fillerEl.textContent = f.filler; return; }
            browseCache = null; graphCache = null;
            refresh();
          })();
        };
        input.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") done(true);
          if (ev.key === "Escape") done(false);
        });
        input.addEventListener("blur", () => done(true));
      });
      row.querySelector(".gmem-del")?.addEventListener("click", () => {
        void (async () => {
          const yes = await host.confirm({
            title: "Forget this fact?",
            body: `${f.entity} · ${f.role} · ${f.filler}\n\nRemoved from the org's memory for real${f.key ? " (the whole version chain)" : ""}.`,
            confirmLabel: "Forget", danger: true,
          });
          if (!yes) return;
          await api().memoryForget?.({ fact: f.key ? { key: f.key } : { entity: f.entity, role: f.role, filler: f.filler } });
          browseCache = null; graphCache = null;
          refresh();
        })();
      });
      return row;
    };

    const paint = (q: string): void => {
      secs.textContent = "";
      const ql = q.toLowerCase();
      const rows = data.facts
        .filter((f) => slot.showHistory || f.is_current)
        .filter((f) => !ql || `${f.entity} ${f.role} ${f.filler}`.toLowerCase().includes(ql))
        .slice()
        .reverse();
      count.textContent = `${rows.length} fact${rows.length === 1 ? "" : "s"}`;
      empty.classList.toggle("hidden", rows.length > 0);
      const byTier: Record<string, MemFact[]> = { long: [], mid: [], short: [] };
      for (const f of rows) (byTier[f.tier ?? "long"] ?? byTier.long!).push(f);
      listSection(secs, slot, "facts:long", "Long-term", "lifelong facts + standing directives", byTier.long!, factRow);
      listSection(secs, slot, "facts:mid", "Mid-term", "decay after ~5 sessions", byTier.mid!, factRow, byTier.mid!.length > 0);
      listSection(secs, slot, "facts:short", "Short-term", "this session only", byTier.short!, factRow, byTier.short!.length > 0);
    };
    paint(search.value.trim());
    search.oninput = () => paint(search.value.trim());
  }

  // ── Semantic  // ── Semantic — the similarity corpus, chunk by chunk ───────────────────────

  function renderSemantic(
    pane: HTMLElement,
    slot: MemorySlotState,
    data: { turns: string[] },
    search: HTMLInputElement,
    refresh: () => void,
  ): void {
    pane.innerHTML = `<div class="gmem-sem"><div class="gmem-secs"></div><div class="gdoc-empty hidden">Nothing in the corpus yet.</div></div>`;
    const secs = pane.querySelector<HTMLElement>(".gmem-secs")!;
    const empty = pane.querySelector<HTMLElement>(".gdoc-empty")!;

    const row = (text: string, score: number | null): HTMLElement => {
      const meta = parseTurn(text);
      const el = document.createElement("div");
      el.className = "gmem-chunk collapsed";
      el.innerHTML = `
        ${score !== null ? `<span class="gmem-score" style="--s:${Math.round(score * 100)}%">${score.toFixed(2)}</span>` : ""}
        <div class="gmem-chunk-main">
          <div class="gmem-chunk-text" title="Click to expand"></div>
          <div class="gmem-chunk-meta"></div>
        </div>
        <button class="ws-icon-btn gmem-del" title="Forget this chunk">✕</button>`;
      const textEl = el.querySelector<HTMLElement>(".gmem-chunk-text")!;
      textEl.textContent = meta.text;
      textEl.addEventListener("click", () => el.classList.toggle("collapsed"));
      (el.querySelector(".gmem-chunk-meta") as HTMLElement).textContent =
        [meta.date, meta.speaker, `${text.length} chars`].filter(Boolean).join(" · ");
      el.querySelector(".gmem-del")?.addEventListener("click", () => {
        void (async () => {
          const yes = await host.confirm({ title: "Forget this chunk?", body: meta.text.slice(0, 200), confirmLabel: "Forget", danger: true });
          if (!yes) return;
          await api().memoryForget?.({ turnText: text });
          browseCache = null; graphCache = null;
          refresh();
        })();
      });
      return el;
    };

    const paintAll = (): void => {
      secs.textContent = "";
      const turns = data.turns.slice().reverse();
      empty.classList.toggle("hidden", turns.length > 0);
      listSection(secs, slot, "sem", "Similarity corpus", "the mid-term chunks — search ranks by cosine", turns, (t) => row(t, null));
    };
    let seq = 0;
    const paintSearch = async (q: string): Promise<void> => {
      const mine = ++seq;
      const res = await api().memorySearch?.(q, 40);
      if (mine !== seq || !secs.isConnected) return;
      secs.textContent = "";
      const hits = res?.ok ? res.recalled : [];
      empty.classList.toggle("hidden", hits.length > 0);
      listSection(secs, slot, "sem:hits", "Semantic hits", "cosine-ranked against your query", hits, (h) => row(h.text, h.score));
    };
    paintAll();
    search.oninput = () => {
      const q = search.value.trim();
      if (!q) { seq++; paintAll(); return; }
      void paintSearch(q);
    };
  }

  // ── Short-term  // ── Short-term — the recency window, pure ──────────────────────────────────

  function renderShortTerm(pane: HTMLElement, slot: MemorySlotState, data: { facts: MemFact[]; window: Array<{ speaker: string; text: string }> }): void {
    const shortFacts = data.facts.filter((f) => f.is_current && f.tier === "short");
    pane.innerHTML = `<div class="gmem-short"><div class="gmem-secs"></div></div>`;
    const secs = pane.querySelector<HTMLElement>(".gmem-secs")!;

    listSection(secs, slot, "st:window", "Recency window",
      "the last exchanges the session carries verbatim — pure order, no embeddings",
      data.window.slice().reverse(),
      (w) => {
        const el = document.createElement("div");
        el.className = "gmem-turn" + (w.speaker === "user" ? " user" : "");
        el.innerHTML = `<span class="gmem-turn-speaker"></span><span class="gmem-turn-text"></span>`;
        (el.querySelector(".gmem-turn-speaker") as HTMLElement).textContent = w.speaker;
        (el.querySelector(".gmem-turn-text") as HTMLElement).textContent = w.text;
        return el;
      });

    listSection(secs, slot, "st:facts", "Short-tier facts", "visible to this session only", shortFacts, (f) => {
      const el = document.createElement("div");
      el.className = "gmem-fact";
      el.innerHTML = `${tierBadge("short")}<span class="gmem-fact-entity"></span><span class="gmem-fact-role"></span><span class="gmem-fact-filler"></span>`;
      (el.querySelector(".gmem-fact-entity") as HTMLElement).textContent = f.entity;
      (el.querySelector(".gmem-fact-role") as HTMLElement).textContent = f.role;
      (el.querySelector(".gmem-fact-filler") as HTMLElement).textContent = f.filler;
      return el;
    }, shortFacts.length > 0);

    if (!data.window.length && !shortFacts.length) {
      const emptyEl = document.createElement("div");
      emptyEl.className = "gdoc-empty";
      emptyEl.textContent = "Nothing short-term right now — it fills as the session talks.";
      secs.appendChild(emptyEl);
    }
  }

  // ── adaL  // ── adaL — the context graph (entities ↔ fillers over role edges) ──────────

  async function renderAdal(pane: HTMLElement, data: { facts: MemFact[] }, search: HTMLInputElement): Promise<void> {
    const facts = data.facts.filter((f) => f.is_current);
    pane.innerHTML = `
      <div class="gmem-3d">
        <canvas class="gmem-3d-canvas"></canvas>
        <div class="gmem-3d-legend">
          <span><i style="background:#8c3bf2"></i> entity</span>
          <span><i style="background:#f5f5f7"></i> filler</span>
          <span class="gmem-hint">drag orbits · wheel zooms · shift-drag pans · click a node</span>
        </div>
        <div class="gmem-3d-info hidden"></div>
        <div class="gdoc-empty hidden">No facts to graph yet.</div>
      </div>`;
    const canvas = pane.querySelector<HTMLCanvasElement>(".gmem-3d-canvas")!;
    const info = pane.querySelector<HTMLElement>(".gmem-3d-info")!;
    if (!facts.length) {
      pane.querySelector(".gdoc-empty")?.classList.remove("hidden");
      return;
    }
    const THREE: any = await loadThree();
    if (!pane.isConnected) return;

    // Entities on a wide XZ ring (a lone entity sits center); each entity's
    // fillers on a GENEROUS Fibonacci sphere around it — even spread in 3D,
    // no two labels fighting for the same pixel. Shared fillers are one node
    // homed to their first entity; every edge still lands on them.
    const entities = [...new Set(facts.map((f) => f.entity))];
    const byEntity = new Map<string, MemFact[]>();
    for (const f of facts) {
      const l = byEntity.get(f.entity) ?? [];
      l.push(f);
      byEntity.set(f.entity, l);
    }
    const biggest = Math.max(...[...byEntity.values()].map((l) => l.length));
    const sphereR = Math.max(18, Math.sqrt(biggest) * 6.5);
    const ringR = entities.length === 1 ? 0 : sphereR * 2.6;
    const epos = new Map<string, [number, number, number]>();
    entities.forEach((e, i) => {
      const a = (i / entities.length) * Math.PI * 2;
      epos.set(e, [Math.cos(a) * ringR, 0, Math.sin(a) * ringR]);
    });
    const fpos = new Map<string, [number, number, number]>();
    const GOLD = Math.PI * (3 - Math.sqrt(5));
    for (const [e, list] of byEntity) {
      const origin = epos.get(e)!;
      const fresh = list.filter((f) => !fpos.has(f.filler));
      fresh.forEach((f, i) => {
        const n = fresh.length;
        const y = n === 1 ? 0 : 1 - (2 * (i + 0.5)) / n;
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        const a = GOLD * i;
        fpos.set(f.filler, [origin[0] + Math.cos(a) * r * sphereR, origin[1] + y * sphereR, origin[2] + Math.sin(a) * r * sphereR]);
      });
    }

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 3000);
    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const keyLight = new THREE.DirectionalLight(0xffffff, 1);
    keyLight.position.set(1, 1.4, 0.8);
    scene.add(keyLight);

    // A text label that always reads: canvas-texture sprite, depth-free.
    const label = (text: string, at: [number, number, number], scalePx: number, color: string): any => {
      const c = document.createElement("canvas");
      const ctx = c.getContext("2d")!;
      const font = `600 28px -apple-system, system-ui, sans-serif`;
      ctx.font = font;
      const w = Math.min(560, Math.ceil(ctx.measureText(text).width) + 16);
      c.width = w; c.height = 40;
      ctx.font = font;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(0, 0, w, 40);
      ctx.fillStyle = color;
      ctx.textBaseline = "middle";
      ctx.fillText(text, 8, 21, w - 16);
      const tex = new THREE.CanvasTexture(c);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
      sp.scale.set((w / 40) * scalePx, scalePx, 1);
      sp.position.set(at[0], at[1] + scalePx * 0.9, at[2]);
      return sp;
    };

    interface Pick { mesh: any; name: string; kind: "entity" | "filler" }
    const picks: Pick[] = [];
    const entityMat = new THREE.MeshStandardMaterial({ color: 0x8c3bf2, roughness: 0.3, metalness: 0.3 });
    const fillerGeo = new THREE.SphereGeometry(0.65, 14, 14);
    const entityGeo = new THREE.BoxGeometry(2.1, 2.1, 2.1);
    for (const [name, at] of epos) {
      const mesh = new THREE.Mesh(entityGeo, entityMat.clone());
      mesh.position.set(at[0], at[1], at[2]);
      scene.add(mesh);
      scene.add(label(name, at, 3.4, "#ffffff"));
      picks.push({ mesh, name, kind: "entity" });
    }
    for (const [name, at] of fpos) {
      const mesh = new THREE.Mesh(fillerGeo, new THREE.MeshStandardMaterial({ color: 0xe8e8ee, roughness: 0.5, metalness: 0.1 }));
      mesh.position.set(at[0], at[1], at[2]);
      scene.add(mesh);
      scene.add(label(name.length > 30 ? name.slice(0, 29) + "…" : name, at, 2.1, "#d9d9e2"));
      picks.push({ mesh, name, kind: "filler" });
    }
    const edgePos = new Float32Array(facts.length * 6);
    facts.forEach((f, i) => {
      edgePos.set(epos.get(f.entity)!, i * 6);
      edgePos.set(fpos.get(f.filler)!, i * 6 + 3);
    });
    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute("position", new THREE.BufferAttribute(edgePos, 3));
    scene.add(new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: 0x8c3bf2, transparent: true, opacity: 0.3 })));

    // Same hand-rolled controls as the Glyphh space.
    const target = new THREE.Vector3(0, 0, 0);
    let theta = 0.8, phi = 1.15, radius = (ringR + sphereR) * 2.6 + 24;
    const applyCam = (): void => {
      camera.position.set(
        target.x + radius * Math.sin(phi) * Math.cos(theta),
        target.y + radius * Math.cos(phi),
        target.z + radius * Math.sin(phi) * Math.sin(theta),
      );
      camera.lookAt(target);
    };
    let mode: "rotate" | "pan" | null = null;
    let last = { x: 0, y: 0 };
    canvas.addEventListener("mousedown", (ev) => {
      mode = ev.button === 2 || ev.shiftKey ? "pan" : "rotate";
      last = { x: ev.clientX, y: ev.clientY };
    });
    canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());
    const onMove = (ev: MouseEvent): void => {
      if (!mode) return;
      const dx = ev.clientX - last.x, dy = ev.clientY - last.y;
      last = { x: ev.clientX, y: ev.clientY };
      if (mode === "rotate") {
        theta += dx * 0.005;
        phi = Math.min(Math.PI - 0.05, Math.max(0.05, phi - dy * 0.005));
      } else {
        const scale = radius * 0.0016;
        const right = new THREE.Vector3().subVectors(camera.position, target).cross(camera.up).normalize();
        target.addScaledVector(right, dx * scale);
        target.addScaledVector(camera.up, dy * scale);
      }
      applyCam();
    };
    const onUp = (): void => { mode = null; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    canvas.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      radius = Math.min(2000, Math.max(12, radius * (ev.deltaY > 0 ? 1.1 : 1 / 1.1)));
      applyCam();
    }, { passive: false });

    // Click a node → its facts in the info card.
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    canvas.addEventListener("click", (ev) => {
      const rect = canvas.getBoundingClientRect();
      pointer.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(picks.map((p2) => p2.mesh))[0];
      if (!hit) { info.classList.add("hidden"); return; }
      const pick = picks.find((p2) => p2.mesh === hit.object)!;
      const related = pick.kind === "entity"
        ? facts.filter((f) => f.entity === pick.name)
        : facts.filter((f) => f.filler === pick.name);
      info.classList.remove("hidden");
      info.innerHTML = `
        <div class="gmem-3d-info-kind" style="color:${pick.kind === "entity" ? "#8c3bf2" : "#d9d9e2"}">${pick.kind}</div>
        <div class="gmem-3d-info-text"></div>
        <div class="gmem-3d-info-meta gmem-3d-info-lines"></div>`;
      (info.querySelector(".gmem-3d-info-text") as HTMLElement).textContent = pick.name;
      (info.querySelector(".gmem-3d-info-meta") as HTMLElement).textContent =
        related.slice(0, 8).map((f) => `${f.entity} —${f.role}→ ${f.filler}`).join("\n") + (related.length > 8 ? `\n… ${related.length - 8} more` : "");
    });

    // Search: matching nodes (name or role) grow; the rest recede.
    search.oninput = () => {
      const q = search.value.trim().toLowerCase();
      const roleHit = new Set(facts.filter((f) => q && f.role.toLowerCase().includes(q)).map((f) => f.filler));
      for (const p2 of picks) {
        const hit = !!q && (p2.name.toLowerCase().includes(q) || roleHit.has(p2.name));
        const sc = hit ? 2 : q ? 0.55 : 1;
        p2.mesh.scale.set(sc, sc, sc);
        (p2.mesh.material as { opacity: number; transparent: boolean }).transparent = true;
        (p2.mesh.material as { opacity: number }).opacity = q && !hit ? 0.3 : 1;
      }
    };

    const size = (): void => {
      const r = pane.getBoundingClientRect();
      const w = Math.max(80, r.width), h = Math.max(80, r.height);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(size);
    ro.observe(pane);
    size();
    applyCam();
    let raf = 0;
    const loop = (): void => {
      if (!mode) theta += 0.0006;
      applyCam();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    loop();
    disposeScene = () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      renderer.dispose();
      fillerGeo.dispose();
      entityGeo.dispose();
    };
  }

  // ── Glyphh  // ── Glyphh  // ── Glyphh — the full semantic space, three.js ─────────────────────────────

  async function renderGlyphh(pane: HTMLElement, search: HTMLInputElement, refresh: () => void): Promise<void> {
    pane.innerHTML = `
      <div class="gmem-3d">
        <canvas class="gmem-3d-canvas"></canvas>
        <div class="gmem-3d-legend">
          <span><i style="background:${TURN_COLOR}"></i> chunk</span>
          <span><i style="background:${TIER_COLOR.long}"></i> fact · long</span>
          <span><i style="background:${TIER_COLOR.mid}"></i> mid</span>
          <span><i style="background:${TIER_COLOR.short}"></i> short</span>
          <span class="gmem-3d-edges"><i class="sem"></i> semantic ≥ .85</span>
          <span class="gmem-3d-edges"><i class="neu"></i> neural .25–.45</span>
        </div>
        <div class="gmem-3d-info hidden"></div>
        <div class="gdoc-empty hidden"></div>
      </div>`;
    const canvas = pane.querySelector<HTMLCanvasElement>(".gmem-3d-canvas")!;
    const info = pane.querySelector<HTMLElement>(".gmem-3d-info")!;
    const empty = pane.querySelector<HTMLElement>(".gdoc-empty")!;

    if (!graphCache) {
      empty.textContent = "Mapping the space…";
      empty.classList.remove("hidden");
      const res = await api().memoryGraph?.({ max: 700 });
      if (!pane.isConnected) return;
      if (!res?.ok) {
        empty.textContent = `Couldn't map the space — ${res?.error ?? "no memory surface here"}`;
        return;
      }
      graphCache = { nodes: res.nodes, coords: res.coords, edges: res.edges };
      empty.classList.add("hidden");
    }
    const g = graphCache;
    if (!g.nodes.length) {
      empty.textContent = "Nothing to see yet — memory fills as you work.";
      empty.classList.remove("hidden");
      return;
    }

    const THREE: any = await loadThree();
    if (!pane.isConnected) return;

    // Spread the PCA cloud to a stable radius regardless of raw variance.
    let maxMag = 0;
    for (const c of g.coords) maxMag = Math.max(maxMag, Math.hypot(c[0], c[1], c[2]));
    const SPREAD = 60 / (maxMag || 1);
    const pts = g.coords.map((c) => [c[0] * SPREAD, c[1] * SPREAD, c[2] * SPREAD] as [number, number, number]);

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 2000);
    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(1, 1.4, 0.8);
    scene.add(key);

    // The cortex glyphs — one instanced cube per node.
    // TINY — the space reads as a starfield of glyphs, not a pile of boxes.
    const cube = new THREE.BoxGeometry(0.45, 0.45, 0.45);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.25 });
    const mesh = new THREE.InstancedMesh(cube, mat, g.nodes.length);
    const m4 = new THREE.Matrix4();
    const color = new THREE.Color();
    const colorOf = (n: GraphNode): string => (n.kind === "turn" ? TURN_COLOR : (TIER_COLOR[n.tier ?? "long"] ?? TIER_COLOR.long!));
    g.nodes.forEach((n, i) => {
      m4.makeTranslation(pts[i]![0], pts[i]![1], pts[i]![2]);
      mesh.setMatrixAt(i, m4);
      mesh.setColorAt(i, color.set(colorOf(n)));
    });
    mesh.instanceColor.needsUpdate = true;
    scene.add(mesh);

    // Similarity edges, two bands, two draw calls.
    const band = (kind: string, colorHex: number, opacity: number): void => {
      const pairs = g.edges.filter((e) => e.kind === kind);
      if (!pairs.length) return;
      const pos = new Float32Array(pairs.length * 6);
      pairs.forEach((e, i) => {
        pos.set(pts[e.a]!, i * 6);
        pos.set(pts[e.b]!, i * 6 + 3);
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      scene.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: colorHex, transparent: true, opacity })));
    };
    band("semantic", 0x8c3bf2, 0.65);
    band("neural", 0x6b7280, 0.14);

    // Orbit / zoom / pan — hand-rolled, no helper gizmos, no preview windows.
    const target = new THREE.Vector3(0, 0, 0);
    let theta = 0.9, phi = 1.1, radius = 170;
    const applyCam = (): void => {
      camera.position.set(
        target.x + radius * Math.sin(phi) * Math.cos(theta),
        target.y + radius * Math.cos(phi),
        target.z + radius * Math.sin(phi) * Math.sin(theta),
      );
      camera.lookAt(target);
    };
    let mode: "rotate" | "pan" | null = null;
    let last = { x: 0, y: 0 };
    canvas.addEventListener("mousedown", (ev) => {
      mode = ev.button === 2 || ev.shiftKey ? "pan" : "rotate";
      last = { x: ev.clientX, y: ev.clientY };
    });
    canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());
    const onMove = (ev: MouseEvent): void => {
      if (!mode) return;
      const dx = ev.clientX - last.x, dy = ev.clientY - last.y;
      last = { x: ev.clientX, y: ev.clientY };
      if (mode === "rotate") {
        theta += dx * 0.005;
        phi = Math.min(Math.PI - 0.05, Math.max(0.05, phi - dy * 0.005));
      } else {
        const scale = radius * 0.0016;
        const right = new THREE.Vector3().subVectors(camera.position, target).cross(camera.up).normalize();
        target.addScaledVector(right, dx * scale);
        target.addScaledVector(camera.up, dy * scale);
      }
      applyCam();
    };
    const onUp = (): void => { mode = null; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    canvas.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      radius = Math.min(600, Math.max(25, radius * (ev.deltaY > 0 ? 1.1 : 1 / 1.1)));
      applyCam();
    }, { passive: false });

    // Click → raycast → the glyph's card (an HTML overlay, deletable from here).
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    canvas.addEventListener("click", (ev) => {
      const rect = canvas.getBoundingClientRect();
      pointer.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(mesh)[0];
      if (!hit || hit.instanceId === undefined) { info.classList.add("hidden"); return; }
      const n = g.nodes[hit.instanceId]!;
      const meta = parseTurn(n.text);
      info.classList.remove("hidden");
      info.innerHTML = `
        <div class="gmem-3d-info-kind" style="color:${colorOf(n)}">${n.kind === "turn" ? "chunk" : `fact · ${n.tier ?? "long"}`}</div>
        <div class="gmem-3d-info-text"></div>
        <div class="gmem-3d-info-meta"></div>
        <button class="action-btn gmem-3d-forget">Forget</button>`;
      (info.querySelector(".gmem-3d-info-text") as HTMLElement).textContent = meta.text;
      (info.querySelector(".gmem-3d-info-meta") as HTMLElement).textContent = [meta.date, meta.speaker].filter(Boolean).join(" · ");
      info.querySelector(".gmem-3d-forget")?.addEventListener("click", () => {
        void (async () => {
          const yes = await host.confirm({ title: "Forget this?", body: meta.text.slice(0, 200), confirmLabel: "Forget", danger: true });
          if (!yes) return;
          await api().memoryForget?.(
            n.kind === "turn"
              ? { turnText: n.text }
              : { fact: { entity: n.entity ?? "", role: n.role ?? "" } },
          );
          browseCache = null; graphCache = null;
          refresh();
        })();
      });
    });

    // Search-to-highlight: recall scores the space; matches grow + brighten,
    // the rest recede. Lexical fallback keeps it working offline.
    const baseScale = new Map<number, number>();
    const restyle = (hitIdx: Map<number, number>): void => {
      g.nodes.forEach((n, i) => {
        const s = hitIdx.has(i) ? 2.6 + (hitIdx.get(i) ?? 0) * 2 : (hitIdx.size ? 0.5 : 1);
        if (baseScale.get(i) === s) return;
        baseScale.set(i, s);
        m4.makeTranslation(pts[i]![0], pts[i]![1], pts[i]![2]);
        m4.scale(new THREE.Vector3(s, s, s));
        mesh.setMatrixAt(i, m4);
        mesh.setColorAt(i, color.set(colorOf(n)).multiplyScalar(hitIdx.size && !hitIdx.has(i) ? 0.35 : 1));
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
    };
    let searchSeq = 0;
    search.oninput = () => {
      const q = search.value.trim();
      const mine = ++searchSeq;
      if (!q) { restyle(new Map()); return; }
      void (async () => {
        const res = await api().memorySearch?.(q, 30);
        if (mine !== searchSeq) return;
        const hits = new Map<number, number>();
        const scored = new Map((res?.ok ? res.recalled : []).map((h) => [h.text, h.score] as const));
        const ql = q.toLowerCase();
        g.nodes.forEach((n, i) => {
          const sc = scored.get(n.text);
          if (sc !== undefined) hits.set(i, sc);
          else if (n.text.toLowerCase().includes(ql)) hits.set(i, 0.3);
        });
        restyle(hits);
      })();
    };

    // Size to the pane, keep sized, render on demand + a slow idle drift.
    const size = (): void => {
      const r = pane.getBoundingClientRect();
      const w = Math.max(80, r.width), h = Math.max(80, r.height);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(size);
    ro.observe(pane);
    size();
    applyCam();
    let raf = 0;
    const loop = (): void => {
      if (!mode) theta += 0.0007; // the space breathes when untouched
      applyCam();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    loop();
    disposeScene = () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      renderer.dispose();
      cube.dispose();
      mat.dispose();
    };
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return {
    renderIntoSlot,
    invalidate: () => { browseCache = null; graphCache = null; },
  };
}
