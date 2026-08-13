/**
 * skill-flow.tsx — React Flow island for the "skill as a workflow" view.
 *
 * The renderer is otherwise vanilla TS; this is the one React surface. It is
 * esbuild-bundled separately (build:skill-flow) into skill-flow.js + a
 * sibling skill-flow.css, then lazy-loaded by the Skills explorer, which
 * computes the graph (flow-graph.ts) and calls window.SkillFlow.mount().
 */

import { useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  ReactFlow,
  Controls,
  Handle,
  Position,
  useNodesState,
  useInternalNode,
  getBezierPath,
  type Node,
  type Edge,
  type NodeProps,
  type EdgeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./skill-flow.css";

type Kind = "start" | "trigger" | "input" | "skill" | "tool" | "subskill" | "app" | "output" | "end" | "model" | "connection" | "memory";

const KIND: Record<Kind, { color: string; glyph: string; tag: string }> = {
  start:    { color: "#8c3bf2", glyph: "▶", tag: "Start" },
  trigger:  { color: "#f59e0b", glyph: "▸", tag: "Trigger" },
  input:    { color: "#4a9eff", glyph: "›", tag: "Input" },
  skill:    { color: "#8c3bf2", glyph: "◆", tag: "Skill" },
  tool:     { color: "#a78bfa", glyph: "⚙", tag: "MCP tool" },
  subskill: { color: "#8c3bf2", glyph: "⊂", tag: "Sub-skill" },
  app:      { color: "#f59e0b", glyph: "▦", tag: "Glyphh app" },
  output:   { color: "#4a9eff", glyph: "⤷", tag: "Output" },
  end:      { color: "#e0607e", glyph: "■", tag: "End" },
  // New-model kinds: a loop's model slots, its connections, and memory.
  model:      { color: "#34d399", glyph: "◈", tag: "Model" },
  connection: { color: "#4a9eff", glyph: "⇄", tag: "Connection" },
  memory:     { color: "#f59e0b", glyph: "▤", tag: "Memory" },
};

function safeHost(url?: string): string | null {
  if (!url || url.startsWith("yo://")) return null;
  try { return new URL(url).hostname; } catch { return null; }
}

function FlowNode({ data }: NodeProps) {
  const d = data as { label: string; sub?: string; kind: Kind; appId?: string; url?: string };
  const k = KIND[d.kind] ?? KIND.skill;

  // App tile — clickable (handled via onNodeClick), shows the app's favicon.
  if (d.kind === "app") {
    const host = safeHost(d.url);
    return (
      <div className="sf-node sf-node-app" style={{ ["--sf" as string]: k.color } as React.CSSProperties} title="Open this app's panel">
        <Handle type="target" position={Position.Left} className="sf-handle" />
        {host
          ? <img className="sf-app-icon" src={`https://www.google.com/s2/favicons?domain=${host}&sz=64`} alt="" />
          : <div className="sf-app-icon sf-app-icon-fallback">{(d.label[0] || "?").toUpperCase()}</div>}
        <div className="sf-app-text">
          <div className="sf-tag">{k.glyph}&nbsp;{k.tag}</div>
          <div className="sf-label">{d.label}</div>
          <div className="sf-sub sf-app-open">Open panel →</div>
        </div>
        <Handle type="source" position={Position.Right} className="sf-handle" />
      </div>
    );
  }

  return (
    <div
      className={`sf-node${d.kind === "skill" ? " sf-node-skill" : ""}`}
      style={{ ["--sf" as string]: k.color } as React.CSSProperties}
    >
      <Handle type="target" position={Position.Left} className="sf-handle" />
      <div className="sf-tag">{k.glyph}&nbsp;{k.tag}</div>
      <div className="sf-label">{d.label}</div>
      {d.sub ? <div className="sf-sub">{d.sub}</div> : null}
      <Handle type="source" position={Position.Right} className="sf-handle" />
    </div>
  );
}

const nodeTypes = { flow: FlowNode };

// ── Floating edges ──────────────────────────────────────────
// The edge attaches to the point on each node's border that faces the other
// node, recomputed from live positions — so lines re-anchor dynamically as
// boxes are dragged around, instead of staying pinned to fixed handles.
/* eslint-disable @typescript-eslint/no-explicit-any */
function intersection(node: any, other: any) {
  const w = node.measured.width / 2;
  const h = node.measured.height / 2;
  const x2 = node.internals.positionAbsolute.x + w;
  const y2 = node.internals.positionAbsolute.y + h;
  const x1 = other.internals.positionAbsolute.x + other.measured.width / 2;
  const y1 = other.internals.positionAbsolute.y + other.measured.height / 2;
  const xx1 = (x1 - x2) / (2 * w) - (y1 - y2) / (2 * h);
  const yy1 = (x1 - x2) / (2 * w) + (y1 - y2) / (2 * h);
  const a = 1 / (Math.abs(xx1) + Math.abs(yy1) || 1);
  return { x: w * (a * xx1 + a * yy1) + x2, y: h * (-a * xx1 + a * yy1) + y2 };
}
function borderSide(node: any, p: { x: number; y: number }): Position {
  const nx = node.internals.positionAbsolute.x;
  const ny = node.internals.positionAbsolute.y;
  if (Math.round(p.x) <= nx + 1) return Position.Left;
  if (Math.round(p.x) >= nx + node.measured.width - 1) return Position.Right;
  if (Math.round(p.y) <= ny + 1) return Position.Top;
  return Position.Bottom;
}

function FloatingEdge({ id, source, target, markerEnd, style }: EdgeProps) {
  const s = useInternalNode(source);
  const t = useInternalNode(target);
  if (!s?.measured || !t?.measured) return null;
  const sp = intersection(s, t);
  const tp = intersection(t, s);
  const [path] = getBezierPath({
    sourceX: sp.x, sourceY: sp.y, sourcePosition: borderSide(s, sp),
    targetX: tp.x, targetY: tp.y, targetPosition: borderSide(t, tp),
  });
  return <path id={id} className="react-flow__edge-path" d={path} markerEnd={markerEnd} style={style} />;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const edgeTypes = { floating: FloatingEdge };

interface FlowOpts {
  onPositionsChange?: (positions: Record<string, { x: number; y: number }>) => void;
  onOpenApp?: (appId: string) => void;
}

function SkillFlow({ nodes: initial, edges, onPositionsChange, onOpenApp }: { nodes: Node[]; edges: Edge[] } & FlowOpts) {
  // Controlled nodes so the user can drag them; edges follow automatically.
  const [nodes, setNodes, onNodesChange] = useNodesState(initial);
  // Keep the graph FITTED: the split divider resizes the canvas, and a fit
  // computed at the old size leaves the components off-center or clipped.
  const instRef = useRef<null | { fitView: (o?: { padding?: number; duration?: number }) => void }>(null);
  // `useNodesState(initial)` seeds ONCE — mount() re-renders this same
  // component instance for every object, so switching loop/skill left the
  // previous graph's nodes in state. Adopt each new graph and re-fit.
  useEffect(() => {
    setNodes(initial);
    requestAnimationFrame(() => instRef.current?.fitView({ padding: 0.2 }));
  }, [initial, setNodes]);
  const hostRef = (el: HTMLDivElement | null) => {
    if (!el) return;
    // Fit ONLY at a real size: the pane collapses to 0 when the editor hides,
    // and a fit against zero dimensions computes NaN zoom — which React Flow
    // then writes into the dot-background pattern (the "<pattern> x: NaN"
    // console spam).
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r && r.width > 40 && r.height > 40) instRef.current?.fitView({ padding: 0.2, duration: 150 });
    });
    ro.observe(el);
  };

  // Persist layout when a drag finishes. State is already updated by the time
  // onNodeDragStop fires, so this closure sees the moved positions.
  const persist = () => {
    if (!onPositionsChange) return;
    const out: Record<string, { x: number; y: number }> = {};
    for (const n of nodes) out[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
    onPositionsChange(out);
  };

  return (
    <div ref={hostRef} style={{ width: "100%", height: "100%" }}>
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onInit={(inst) => {
        instRef.current = inst as unknown as { fitView: (o?: { padding?: number }) => void };
        // Same zero-size guard on the first fit.
        requestAnimationFrame(() => instRef.current?.fitView({ padding: 0.2 }));
      }}
      onNodesChange={onNodesChange}
      onNodeDragStop={persist}
      onNodeClick={(_e, node) => {
        const nd = node.data as { kind?: string; appId?: string };
        if (nd.kind === "app" && nd.appId && onOpenApp) onOpenApp(nd.appId);
      }}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      nodesConnectable={false}
      edgesFocusable={false}
      panOnScroll
      panOnDrag
      zoomOnScroll
      zoomOnPinch
      minZoom={0.2}
      maxZoom={1.6}
      proOptions={{ hideAttribution: true }}
      defaultEdgeOptions={{ type: "floating", style: { stroke: "var(--sf-edge)", strokeWidth: 2.5 } }}
    >
      {/* No <Background> — the viewer is a clean surface, no dot grid. */}
      {/* zoom in/out + fit-to-components — the pan/zoom controls the read views need */}
      {/* Top-right per design: zoom ± and the re-center (fit) button. */}
      <Controls position="top-right" showInteractive={false} showZoom showFitView />
    </ReactFlow>
    </div>
  );
}

const roots = new WeakMap<HTMLElement, Root>();

interface Graph { nodes: Node[]; edges: Edge[]; }

const api = {
  mount(container: HTMLElement, graph: Graph, opts?: FlowOpts): void {
    let root = roots.get(container);
    if (!root) { root = createRoot(container); roots.set(container, root); }
    root.render(<SkillFlow nodes={graph.nodes} edges={graph.edges} onPositionsChange={opts?.onPositionsChange} onOpenApp={opts?.onOpenApp} />);
  },
  unmount(container: HTMLElement): void {
    const root = roots.get(container);
    if (root) { root.unmount(); roots.delete(container); }
  },
};

(window as unknown as { SkillFlow: typeof api }).SkillFlow = api;
