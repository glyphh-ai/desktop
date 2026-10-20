/**
 * lib-flow.ts — the React-Flow view of a skill or loop, fed LIVE from the edit
 * form's state. The island (skill-flow.tsx, restored from 974471b^) is the
 * app's one React surface, lazy-loaded on first use; re-mounting re-renders,
 * which is what makes "type in the form, watch the graph move" work.
 */

import type { LoopManifest, SkillManifest } from "./library-types.js";

interface FlowNode { id: string; type: "flow"; position: { x: number; y: number }; data: { label: string; sub?: string; kind: string } }
interface FlowEdge { id: string; source: string; target: string }
interface Graph { nodes: FlowNode[]; edges: FlowEdge[] }
interface SkillFlowApi {
  mount(container: HTMLElement, graph: Graph, opts?: Record<string, unknown>): void;
  unmount(container: HTMLElement): void;
}

const api = (): SkillFlowApi | undefined => (window as unknown as { SkillFlow?: SkillFlowApi }).SkillFlow;

let loading: Promise<void> | null = null;
function ensureFlow(): Promise<void> {
  if (api()) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
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
    s.onerror = () => { loading = null; reject(new Error("skill-flow bundle failed to load")); };
    document.body.appendChild(s);
  });
  return loading;
}

// ── Graph builders ──────────────────────────────────────────────────────────

const node = (id: string, kind: string, label: string, x: number, y: number, sub?: string): FlowNode =>
  ({ id, type: "flow", position: { x, y }, data: { label, kind, ...(sub ? { sub } : {}) } });
const edge = (a: string, b: string): FlowEdge => ({ id: `${a}->${b}`, source: a, target: b });

/** A column of nodes fanned out vertically from a center. */
function fan(count: number, centerY: number, gap = 86): number[] {
  const top = centerY - ((count - 1) * gap) / 2;
  return Array.from({ length: count }, (_, i) => top + i * gap);
}

/** A skill as a flow: trigger → the skill → what it may reach. */
export function skillGraph(name: string, manifest: SkillManifest): Graph {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const CY = 220;

  const trigger = manifest.schedule ? `Scheduled · ${manifest.schedule}` : "On demand";
  nodes.push(node("trigger", "trigger", trigger, 0, CY, manifest.schedule ? "cron" : "an agent or loop calls it"));
  nodes.push(node("skill", "skill", name || "Skill", 260, CY, manifest.whenToUse ? manifest.whenToUse.slice(0, 60) : undefined));
  edges.push(edge("trigger", "skill"));

  if (manifest.model) {
    nodes.push(node("model", "model", manifest.model, 260, CY - 130, "preferred model"));
    edges.push(edge("model", "skill"));
  }

  const tools = manifest.allowedTools ?? [];
  const conns = manifest.requires ?? [];
  const rightCount = tools.length + conns.length;
  if (rightCount) {
    const ys = fan(rightCount, CY);
    tools.forEach((t, i) => { nodes.push(node(`tool-${i}`, "tool", t, 560, ys[i]!)); edges.push(edge("skill", `tool-${i}`)); });
    conns.forEach((c, i) => { const y = ys[tools.length + i]!; nodes.push(node(`conn-${i}`, "connection", c, 560, y)); edges.push(edge("skill", `conn-${i}`)); });
  } else {
    nodes.push(node("out", "output", "Result", 560, CY, "returned to the caller"));
    edges.push(edge("skill", "out"));
  }
  return { nodes, edges };
}

/** A loop as a flow: start → model slots in sequence → what the loop reaches.
 *  `models` (role name → display name) subs the RESOLVED model onto each slot. */
export function loopGraph(name: string, manifest: LoopManifest, models: Record<string, string> = {}): Graph {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const CY = 240;

  nodes.push(node("start", "start", name || "Loop", 0, CY));

  // Model slots run left→right as the loop's spine; the implicit single slot
  // renders when none are declared, because the program still runs somewhere.
  const roles = manifest.roles?.length ? manifest.roles : [{ name: "default", label: "Model" }];
  let x = 250;
  let prev = "start";
  for (const [i, role] of roles.entries()) {
    const id = `role-${i}`;
    nodes.push(node(id, "model", role.label || role.name, x, CY,
      models[role.name] ?? role.description?.slice(0, 60) ?? (role.default ? `default: ${role.default}` : undefined)));
    edges.push(edge(prev, id));
    prev = id;
    x += 250;
  }
  nodes.push(node("end", "end", "Done", x, CY));
  edges.push(edge(prev, "end"));

  // What the loop may reach hangs off the spine's center.
  const spineMid = roles.length > 1 ? `role-${Math.floor((roles.length - 1) / 2)}` : "role-0";
  const skills = manifest.skills ?? [];
  const conns = manifest.connections ?? [];
  const below = skills.length + conns.length + (manifest.memory?.read || manifest.memory?.write ? 1 : 0);
  if (below) {
    const xs = fan(below, Math.max(250, x / 2), 230);
    let idx = 0;
    for (const [i, s] of skills.entries()) { nodes.push(node(`skill-${i}`, "subskill", s, xs[idx++]!, CY + 170)); edges.push(edge(spineMid, `skill-${i}`)); }
    for (const [i, c] of conns.entries()) { nodes.push(node(`conn-${i}`, "connection", c, xs[idx++]!, CY + 170)); edges.push(edge(spineMid, `conn-${i}`)); }
    if (manifest.memory?.read || manifest.memory?.write) {
      const mode = [manifest.memory.read ? "read" : "", manifest.memory.write ? "write" : ""].filter(Boolean).join(" + ");
      nodes.push(node("memory", "memory", "Memory", xs[idx]!, CY + 170, mode));
      edges.push(edge(spineMid, "memory"));
    }
  }
  return { nodes, edges };
}

/** A TASK as a flow (2026-09-17). The program is code, so this reads it the
 *  only honest way: a lexical scan for the seams it can only reach through ctx
 *  — agent turns, connection calls, app data, checkpoints — laid out in source
 *  order between the trigger and the result. It is a map of what the program
 *  touches, not a claim about its control flow. */
export function taskGraph(
  name: string,
  manifest: { schedule?: string | null; result?: unknown; slots?: Record<string, unknown> },
  program: string,
): Graph {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const CY = 220;
  const STEP_X = 250;

  interface Hit { at: number; kind: string; label: string; sub?: string }
  const hits: Hit[] = [];
  const add = (re: RegExp, make: (m: RegExpExecArray) => Hit | null): void => {
    for (let m = re.exec(program); m; m = re.exec(program)) {
      const h = make(m);
      if (h) hits.push(h);
    }
  };
  add(/ctx\s*\.\s*agents\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*["'`]([^"'`]+)["'`]\s*\])\s*\.\s*run\s*\(/g,
    (m) => ({ at: m.index, kind: "agent", label: m[1] || m[2] || "agent", sub: "an agent turn" }));
  add(/ctx\s*\.\s*connections\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*["'`]([^"'`]+)["'`]\s*\])\s*\.\s*call\s*\(\s*["'`]([^"'`]+)["'`]/g,
    (m) => ({ at: m.index, kind: "connection", label: m[1] || m[2] || "connection", sub: m[3] }));
  add(/ctx\s*\.\s*data\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    (m) => ({ at: m.index, kind: "memory", label: m[1]!, sub: "app data" }));
  const marks: Array<{ at: number; key: string }> = [];
  add(/ctx\s*\.\s*checkpoint\s*\(\s*["'`]([^"'`]+)["'`]/g,
    (m) => { marks.push({ at: m.index, key: m[1]! }); return null; });
  hits.sort((a, b) => a.at - b.at);

  // A checkpoint wraps the call it guards, so it reads as a note ON that step
  // rather than a step of its own; one that guards nothing stands alone.
  for (const mk of marks) {
    const owner = hits.find((h) => h.at > mk.at && h.at - mk.at < 200);
    if (owner) owner.sub = `${owner.sub ?? ""}${owner.sub ? " · " : ""}checkpoint "${mk.key}"`;
    else hits.push({ at: mk.at, kind: "memory", label: `checkpoint "${mk.key}"`, sub: "journaled" });
  }
  hits.sort((a, b) => a.at - b.at);

  nodes.push(node("trigger", "trigger", manifest.schedule ? `Scheduled · ${manifest.schedule}` : "On demand",
    0, CY, manifest.schedule ? "cron" : "Run now, or a schedule you add"));
  let prev = "trigger";
  if (!hits.length) {
    nodes.push(node("program", "skill", name || "Program", STEP_X, CY, "the program drives this on its own"));
    edges.push(edge(prev, "program"));
    prev = "program";
  }
  hits.forEach((h, i) => {
    const id = `step-${i}`;
    nodes.push(node(id, h.kind, h.label, STEP_X * (i + 1), CY, h.sub));
    edges.push(edge(prev, id));
    prev = id;
  });
  const shape = manifest.result && typeof manifest.result === "object" ? Object.keys(manifest.result as object).join(", ") : "";
  nodes.push(node("result", "output", "Result", STEP_X * ((hits.length || 1) + 1), CY, shape || undefined));
  edges.push(edge(prev, "result"));
  return { nodes, edges };
}

// ── Mount ────────────────────────────────────────────────────────────────────

/** Render (or re-render) a graph into `host`. Safe to call on every form edit. */
export async function renderFlow(host: HTMLElement, graph: Graph): Promise<void> {
  try {
    await ensureFlow();
    api()?.mount(host, graph);
  } catch {
    host.innerHTML = `<div class="crud-empty">Couldn't load the workflow view.</div>`;
  }
}

export function unmountFlow(host: HTMLElement): void {
  api()?.unmount(host);
}
