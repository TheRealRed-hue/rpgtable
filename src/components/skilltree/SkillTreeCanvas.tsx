// Free-form constellation canvas: nodes placed anywhere, connected by hand.
// Deliberately dumb/reusable — this component only renders and reports raw
// interactions (click, drag, double-click on empty space). All business
// logic (what a click *means* — select for editing, try to unlock, start an
// edge — lives in the route that owns edit vs. view mode).
import { useCallback, useEffect, useRef, useState } from "react";
import type { SkillEdge, SkillNode, SkillNodeColor } from "@/lib/board-types";
import { SKILL_NODE_COLORS } from "@/lib/board-types";

interface Props {
  nodes: SkillNode[];
  edges: SkillEdge[];
  /** "edit": master arranges nodes/edges. "view": read-only, lit by progress. */
  mode: "edit" | "view";
  /** Node ids considered unlocked — lit fully, and edges touching them glow. */
  unlockedNodeIds?: Set<string>;
  /** Node ids that could be unlocked right now (prereqs met) — pulses softly. */
  unlockableNodeIds?: Set<string>;
  selectedNodeId?: string | null;
  /** Set while the master is drawing a new edge from this node. */
  pendingEdgeFrom?: string | null;
  onNodeClick?: (id: string) => void;
  onNodeDragMove?: (id: string, x: number, y: number) => void;
  onNodeDragEnd?: (id: string, x: number, y: number) => void;
  onEdgeClick?: (id: string) => void;
  onCanvasDoubleClick?: (x: number, y: number) => void;
}

const NODE_R = 22;

export function SkillTreeCanvas({
  nodes,
  edges,
  mode,
  unlockedNodeIds,
  unlockableNodeIds,
  selectedNodeId,
  pendingEdgeFrom,
  onNodeClick,
  onNodeDragMove,
  onNodeDragEnd,
  onEdgeClick,
  onCanvasDoubleClick,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const draggingNode = useRef<{ id: string; moved: boolean } | null>(null);
  const panning = useRef<{ startClientX: number; startClientY: number; startX: number; startY: number } | null>(
    null,
  );

  const toSvgPoint = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return {
      x: (clientX - rect.left - view.x) / view.scale,
      y: (clientY - rect.top - view.y) / view.scale,
    };
  }, [view]);

  const nodeById = useCallback((id: string) => nodes.find((n) => n.id === id), [nodes]);

  const isLit = (id: string) => !!unlockedNodeIds?.has(id);
  const isPulsing = (id: string) => !!unlockableNodeIds?.has(id) && !isLit(id);

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const delta = -e.deltaY * 0.001;
    setView((v) => {
      const next = Math.min(2.5, Math.max(0.35, v.scale + delta * v.scale));
      return { ...v, scale: next };
    });
  }, []);

  // React 17+ attaches the `wheel` listener at the root as passive by
  // default (for scroll perf), so `e.preventDefault()` inside a synthetic
  // `onWheel` prop is silently ignored and logs "Unable to preventDefault
  // inside passive event listener invocation." Attaching directly to the
  // element with `{ passive: false }` is the only way to actually stop the
  // page from scrolling while zooming the canvas.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    svg.addEventListener("wheel", handleWheel, { passive: false });
    return () => svg.removeEventListener("wheel", handleWheel);
  }, [handleWheel]);

  const handleBackgroundPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    panning.current = { startClientX: e.clientX, startClientY: e.clientY, startX: view.x, startY: view.y };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (draggingNode.current) {
      const { id } = draggingNode.current;
      const p = toSvgPoint(e.clientX, e.clientY);
      draggingNode.current.moved = true;
      onNodeDragMove?.(id, Math.round(p.x), Math.round(p.y));
      return;
    }
    if (panning.current) {
      const { startClientX, startClientY, startX, startY } = panning.current;
      const dx = e.clientX - startClientX;
      const dy = e.clientY - startClientY;
      setView((v) => ({ ...v, x: startX + dx, y: startY + dy }));
    }
  };

  const endInteractions = (e: React.PointerEvent) => {
    if (draggingNode.current) {
      const { id, moved } = draggingNode.current;
      if (moved) {
        const node = nodeById(id);
        if (node) onNodeDragEnd?.(id, node.x, node.y);
      }
      draggingNode.current = null;
    }
    panning.current = null;
  };

  const handleNodePointerDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    if (mode === "edit") {
      draggingNode.current = { id, moved: false };
    }
  };

  const handleNodeClick = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (draggingNode.current?.moved) return; // was a drag, not a click
    onNodeClick?.(id);
  };

  const handleBackgroundDoubleClick = (e: React.MouseEvent) => {
    if (mode !== "edit") return;
    const p = toSvgPoint(e.clientX, e.clientY);
    onCanvasDoubleClick?.(Math.round(p.x), Math.round(p.y));
  };

  const glowColor = (color: string) =>
    SKILL_NODE_COLORS[(color as SkillNodeColor) in SKILL_NODE_COLORS ? (color as SkillNodeColor) : "gold"].glow;

  return (
    <svg
      ref={svgRef}
      className="h-full w-full touch-none select-none"
      style={{ background: "radial-gradient(ellipse at 50% 30%, #1a1712 0%, #0c0a08 70%)", cursor: panning.current ? "grabbing" : "grab" }}
      onPointerDown={handleBackgroundPointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endInteractions}
      onPointerLeave={endInteractions}
      onDoubleClick={handleBackgroundDoubleClick}
    >
      <defs>
        {Object.entries(SKILL_NODE_COLORS).map(([key, { glow }]) => (
          <filter key={key} id={`glow-${key}`} x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feFlood floodColor={glow} result="color" />
            <feComposite in="color" in2="blur" operator="in" result="glow" />
            <feMerge>
              <feMergeNode in="glow" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        ))}
      </defs>

      <g transform={`translate(${view.x}, ${view.y}) scale(${view.scale})`}>
        {/* Edges */}
        {edges.map((edge) => {
          const from = nodeById(edge.from_node_id);
          const to = nodeById(edge.to_node_id);
          if (!from || !to) return null;
          const lit = isLit(edge.from_node_id) && isLit(edge.to_node_id);
          return (
            <line
              key={edge.id}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke={lit ? glowColor(from.color) : "#3a352c"}
              strokeWidth={lit ? 2 : 1.5}
              strokeDasharray="3 5"
              opacity={lit ? 0.9 : 0.5}
              filter={lit ? `url(#glow-${from.color})` : undefined}
              onClick={(e) => {
                e.stopPropagation();
                onEdgeClick?.(edge.id);
              }}
              style={{ cursor: mode === "edit" ? "pointer" : undefined }}
            />
          );
        })}

        {/* Pending edge preview (edit mode, drawing a new connection) */}
        {pendingEdgeFrom && (() => {
          const from = nodeById(pendingEdgeFrom);
          if (!from) return null;
          return (
            <circle cx={from.x} cy={from.y} r={NODE_R + 6} fill="none" stroke="#e8c766" strokeWidth={1} strokeDasharray="2 3" opacity={0.8} />
          );
        })()}

        {/* Nodes */}
        {nodes.map((node) => {
          const lit = isLit(node.id);
          const pulsing = isPulsing(node.id);
          const selected = selectedNodeId === node.id;
          const color = glowColor(node.color);
          return (
            <g
              key={node.id}
              transform={`translate(${node.x}, ${node.y})`}
              onPointerDown={(e) => handleNodePointerDown(e, node.id)}
              onClick={(e) => handleNodeClick(e, node.id)}
              style={{ cursor: mode === "edit" ? "grab" : lit || pulsing ? "pointer" : "default" }}
            >
              {pulsing && (
                <circle r={NODE_R + 4} fill="none" stroke={color} strokeWidth={1.5} opacity={0.6}>
                  <animate attributeName="r" values={`${NODE_R + 2};${NODE_R + 9};${NODE_R + 2}`} dur="2s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.7;0.15;0.7" dur="2s" repeatCount="indefinite" />
                </circle>
              )}
              <circle
                r={NODE_R}
                fill={lit ? color : "#1c1912"}
                stroke={selected ? "#fff" : lit ? color : pendingEdgeFrom === node.id ? "#e8c766" : "#5a5342"}
                strokeWidth={selected ? 2.5 : 1.5}
                filter={lit ? `url(#glow-${node.color})` : undefined}
                opacity={lit ? 1 : 0.85}
              />
              <text
                textAnchor="middle"
                dy={NODE_R + 16}
                fill={lit ? "#f2e9d9" : "#9a927e"}
                fontSize="11"
                className="pointer-events-none select-none"
              >
                {node.title.length > 18 ? node.title.slice(0, 17) + "…" : node.title}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}