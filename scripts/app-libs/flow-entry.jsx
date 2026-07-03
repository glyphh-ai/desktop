// Glyphh app-lib: workflow/canvas UI (React Flow, the same library Glyphh's
// own workflow surfaces use), wrapped in a vanilla facade so apps don't need
// React or a bundler:
//
//   <script src="../_libs/flow.js"></script>
//   const flow = GlyphhFlow.renderFlow(el, {
//     nodes, edges,                        // React Flow node/edge shapes
//     onChange({ nodes, edges }) {…},      // fires after any user edit
//     minimap: true, colorMode: "dark",
//   });
//   flow.setNodes(next); flow.getState(); flow.destroy();
//
// GlyphhFlow.React / GlyphhFlow.ReactFlow are exported too for apps that
// want full custom node types.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ReactFlow, Background, Controls, MiniMap,
  applyNodeChanges, applyEdgeChanges, addEdge,
} from "@xyflow/react";
import flowCss from "@xyflow/react/dist/style.css";

let styleInjected = false;
function ensureStyle() {
  if (styleInjected) return;
  const style = document.createElement("style");
  style.textContent = flowCss;
  document.head.appendChild(style);
  styleInjected = true;
}

function FlowApp({ initial, options, bindApi }) {
  const [nodes, setNodes] = useState(initial.nodes);
  const [edges, setEdges] = useState(initial.edges);
  const stateRef = useRef({ nodes, edges });
  stateRef.current = { nodes, edges };

  useEffect(() => {
    bindApi({ setNodes, setEdges, get: () => stateRef.current });
  }, [bindApi]);

  useEffect(() => {
    options.onChange?.({ nodes, edges });
  }, [nodes, edges]); // eslint-disable-line react-hooks/exhaustive-deps

  const onNodesChange = useCallback((changes) => setNodes((ns) => applyNodeChanges(changes, ns)), []);
  const onEdgesChange = useCallback((changes) => setEdges((es) => applyEdgeChanges(changes, es)), []);
  const onConnect = useCallback((conn) => setEdges((es) => addEdge(conn, es)), []);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      fitView={options.fitView !== false}
      colorMode={options.colorMode || "dark"}
      nodeTypes={options.nodeTypes}
      {...(options.props || {})}
    >
      {options.background !== false && <Background />}
      {options.controls !== false && <Controls />}
      {options.minimap ? <MiniMap /> : null}
    </ReactFlow>
  );
}

function renderFlow(container, options = {}) {
  ensureStyle();
  let api = null;
  const bindApi = (a) => { api = a; };
  const root = createRoot(container);
  root.render(
    <FlowApp
      initial={{ nodes: options.nodes || [], edges: options.edges || [] }}
      options={options}
      bindApi={bindApi}
    />
  );
  return {
    setNodes: (nodes) => api?.setNodes(typeof nodes === "function" ? nodes : () => nodes),
    setEdges: (edges) => api?.setEdges(typeof edges === "function" ? edges : () => edges),
    getState: () => (api ? api.get() : { nodes: options.nodes || [], edges: options.edges || [] }),
    destroy: () => root.unmount(),
  };
}

globalThis.GlyphhFlow = {
  renderFlow,
  React,
  createRoot,
  ReactFlow, Background, Controls, MiniMap,
  applyNodeChanges, applyEdgeChanges, addEdge,
};
