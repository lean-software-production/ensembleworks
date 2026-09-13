/**
 * `ui/dag.tsx` — dagre layout, then an SVG DAG with a live execution
 * overlay, per docs/plans/2026-09-13-attractor-runner-plan.md T5 ("DAG:
 * dagre layout; node shape hints (start/exit/human/command distinct);
 * status colours pending/running/succeeded/failed/skipped; visit badge when
 * > 1; current node highlighted; traversed edges emphasised with the
 * last-selected reason in a title; click on an agent node opens its worker
 * thread").
 *
 * `layoutGraph` is a pure function (no React, no DOM) so it is unit-tested
 * directly under vitest's default "node" environment — see
 * tests/ui/dag.test.ts. `DagView` is the React piece; it and every other
 * `ui/*`/`app.tsx` module must only ever import from `server/contracts.ts`
 * and `engine/types.ts` (pure types), never `server/service.ts` or
 * `server/store.ts` — those pull in `better-sqlite3`, a native module that
 * must never end up in the app's esbuild bundle.
 */

import * as dagre from "@dagrejs/dagre";
import type { GraphEdgeView, GraphNodeView, GraphView } from "../server/contracts";
import type { EdgeSelectedReason, RunEvent } from "../engine/types";

export const NODE_WIDTH = 168;
export const NODE_HEIGHT = 52;
const NODE_SEP = 32;
const RANK_SEP = 56;
const MARGIN = 24;

export interface LaidOutNode extends GraphNodeView {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LaidOutEdge extends GraphEdgeView {
  points: { x: number; y: number }[];
  /** This edge's position in `graph.edges` — disambiguates two DOT edges between the same node pair (a legal, if unusual, graph) as distinct dagre edges and distinct React keys. */
  edgeIndex: number;
}

export interface LaidOutGraph {
  width: number;
  height: number;
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
}

/** Pure dagre layout: deterministic node positions + routed edge points for a GraphView. No DOM. */
export function layoutGraph(graph: GraphView): LaidOutGraph {
  // `multigraph: true` because this dialect allows two DOT edges between the
  // same node pair (e.g. two conditional outcomes both routed to the same
  // next node) — a plain graph collapses those into one dagre edge, losing
  // one path's route entirely. Each edge is named by its index in
  // `graph.edges` so multiple edges for the same pair stay distinct; a
  // *value* of `{}` (not `undefined`) is required here or dagre's named-edge
  // path throws reading `.points` off an unset label.
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: graph.rankdir, nodesep: NODE_SEP, ranksep: RANK_SEP, marginx: MARGIN, marginy: MARGIN });
  g.setDefaultEdgeLabel(() => ({}));
  for (const node of graph.nodes) g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  graph.edges.forEach((edge, edgeIndex) => {
    // A node reachable only through a validation-rejected edge (dangling
    // target) would make dagre throw; skip rather than crash the whole DAG.
    if (g.hasNode(edge.from) && g.hasNode(edge.to)) g.setEdge(edge.from, edge.to, {}, String(edgeIndex));
  });
  dagre.layout(g);

  const nodes: LaidOutNode[] = graph.nodes.map((node) => {
    const laid = g.node(node.id);
    return { ...node, x: laid.x, y: laid.y, width: laid.width, height: laid.height };
  });
  const edges: LaidOutEdge[] = graph.edges.flatMap((edge, edgeIndex) => {
    if (!g.hasNode(edge.from) || !g.hasNode(edge.to)) return [];
    const laid = g.edge(edge.from, edge.to, String(edgeIndex));
    return [{ ...edge, points: laid?.points ?? [], edgeIndex }];
  });

  const graphLabel = g.graph() as { width?: number; height?: number };
  const width = graphLabel.width ?? nodes.reduce((max, n) => Math.max(max, n.x + n.width / 2), 0);
  const height = graphLabel.height ?? nodes.reduce((max, n) => Math.max(max, n.y + n.height / 2), 0);
  return { width, height, nodes, edges };
}

// ---------------------------------------------------------------------------
// Visual mapping
// ---------------------------------------------------------------------------

export type NodeStatus = GraphNodeView["status"];

const STATUS_COLOR: Record<NonNullable<NodeStatus> | "pending", { fill: string; stroke: string }> = {
  pending: { fill: "#f1f5f9", stroke: "#94a3b8" },
  running: { fill: "#dbeafe", stroke: "#2563eb" },
  // T6: a human gate waiting on its answer — distinct from "running" so the
  // DAG visibly flags where a run is stuck on a person, not just busy.
  blocked: { fill: "#fef3c7", stroke: "#d97706" },
  succeeded: { fill: "#dcfce7", stroke: "#16a34a" },
  failed: { fill: "#fee2e2", stroke: "#dc2626" },
  skipped: { fill: "#f5f5f4", stroke: "#a8a29e" },
};

export function statusColor(status: NodeStatus): { fill: string; stroke: string } {
  return STATUS_COLOR[status ?? "pending"];
}

/** SVG polygon points (or null for a plain rounded rect) for a node's shape hint, keyed by handlerKind. */
function shapePoints(handlerKind: string, w: number, h: number): string | null {
  const cx = w / 2;
  const cy = h / 2;
  switch (handlerKind) {
    case "start": {
      // Mdiamond: a diamond with each of its 4 tips clipped diagonally —
      // Graphviz's actual rendering of this shape, and (unlike a plain
      // diamond) an outline distinct from `conditional`'s below.
      const tipX = cx * 0.18;
      const tipY = cy * 0.18;
      return `${cx - tipX},${tipY} ${cx + tipX},${tipY} ${w - tipX},${cy - tipY} ${w - tipX},${cy + tipY} ${cx + tipX},${h - tipY} ${cx - tipX},${h - tipY} ${tipX},${cy + tipY} ${tipX},${cy - tipY}`;
    }
    case "human":
      // Hexagon.
      return `${w * 0.15},0 ${w * 0.85},0 ${w},${cy} ${w * 0.85},${h} ${w * 0.15},${h} 0,${cy}`;
    case "command":
      // Parallelogram.
      return `${w * 0.2},0 ${w},0 ${w * 0.8},${h} 0,${h}`;
    case "conditional":
      // Plain diamond — distinct from `start`'s clipped-tip Mdiamond above.
      return `${cx},0 ${w},${cy} ${cx},${h} 0,${cy}`;
    case "exit": {
      // Msquare: a rectangle with each of its 4 corners clipped diagonally —
      // Graphviz's actual rendering of this shape, and (unlike a plain rect)
      // an outline distinct from `agent`/`prompt`'s below.
      const clip = Math.min(w, h) * 0.22;
      return `${clip},0 ${w - clip},0 ${w},${clip} ${w},${h - clip} ${w - clip},${h} ${clip},${h} 0,${h - clip} 0,${clip}`;
    }
    case "parallel":
    case "parallel.fan_in":
      // Octagon (tripleoctagon simplified to a single cut-corner octagon).
      // Uses proportionally larger corner cuts than `exit`'s Msquare above,
      // so the two octagon-ish shapes stay visually and structurally distinct.
      return `${w * 0.25},0 ${w * 0.75},0 ${w},${h * 0.25} ${w},${h * 0.75} ${w * 0.75},${h} ${w * 0.25},${h} 0,${h * 0.75} 0,${h * 0.25}`;
    default:
      return null; // agent, prompt: rounded rect.
  }
}

/** handlerKind that can spawn a worker thread — the only nodes a DAG click can open. */
function opensWorkerThread(handlerKind: string): boolean {
  return handlerKind === "agent" || handlerKind === "prompt";
}

interface EdgeSelection {
  reason: EdgeSelectedReason;
  edgeLabel?: string;
}

function latestEdgeSelections(events: readonly RunEvent[]): Map<string, EdgeSelection> {
  const byEdge = new Map<string, EdgeSelection>();
  for (const event of events) {
    if (event.type !== "edge.selected") continue;
    byEdge.set(`${event.from} ${event.to}`, { reason: event.reason, edgeLabel: event.edgeLabel });
  }
  return byEdge;
}

function pathFor(points: { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
}

export interface DagViewProps {
  graph: GraphView;
  /** All events recorded for the run so far — used to find traversed edges and their selection reason. */
  events: readonly RunEvent[];
  /** The run's current/most-recently-entered node, per `Run.currentNodeId`; highlighted distinctly. */
  currentNodeId?: string | null;
  /** nodeId -> the worker threadId of its latest stage, when known (from `getRun`'s stages). */
  threadIdByNode?: Record<string, string | null | undefined>;
  /** Called when an agent/prompt node with a known worker thread is clicked. */
  onOpenThread?: (threadId: string) => void;
}

/** dagre-laid-out SVG rendering of a workflow graph with a live execution overlay. */
export function DagView({ graph, events, currentNodeId, threadIdByNode, onOpenThread }: DagViewProps) {
  const laidOut = layoutGraph(graph);
  const selections = latestEdgeSelections(events);
  const viewWidth = Math.max(laidOut.width, NODE_WIDTH);
  const viewHeight = Math.max(laidOut.height, NODE_HEIGHT);

  return (
    <svg
      role="img"
      aria-label="Workflow DAG"
      viewBox={`0 0 ${viewWidth} ${viewHeight}`}
      width="100%"
      style={{ minHeight: 160, background: "#fff" }}
    >
      <defs>
        <marker id="attractor-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8" />
        </marker>
        <marker id="attractor-arrow-traversed" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#2563eb" />
        </marker>
      </defs>
      <g>
        {laidOut.edges.map((edge) => {
          const selection = selections.get(`${edge.from} ${edge.to}`);
          const traversed = Boolean(selection);
          return (
            <path
              key={`${edge.from}->${edge.to}#${edge.edgeIndex}`}
              data-edge={`${edge.from}->${edge.to}`}
              data-traversed={traversed}
              d={pathFor(edge.points)}
              fill="none"
              stroke={traversed ? "#2563eb" : "#cbd5e1"}
              strokeWidth={traversed ? 2 : 1}
              strokeDasharray={traversed ? undefined : "4 3"}
              markerEnd={`url(#${traversed ? "attractor-arrow-traversed" : "attractor-arrow"})`}
            >
              <title>{selection ? `${edge.from} → ${edge.to} (${selection.reason}${selection.edgeLabel ? `: ${selection.edgeLabel}` : ""})` : `${edge.from} → ${edge.to}`}</title>
            </path>
          );
        })}
      </g>
      <g>
        {laidOut.nodes.map((node) => {
          const color = statusColor(node.status);
          const isCurrent = node.id === currentNodeId;
          const threadId = threadIdByNode?.[node.id] ?? null;
          const clickable = opensWorkerThread(node.handlerKind) && Boolean(threadId) && Boolean(onOpenThread);
          const points = shapePoints(node.handlerKind, node.width, node.height);
          const x = node.x - node.width / 2;
          const y = node.y - node.height / 2;
          return (
            <g
              key={node.id}
              data-node-id={node.id}
              data-handler-kind={node.handlerKind}
              data-status={node.status ?? "pending"}
              data-current={isCurrent}
              role={clickable ? "button" : undefined}
              tabIndex={clickable ? 0 : undefined}
              aria-label={clickable ? `Open worker thread for ${node.label ?? node.id}` : undefined}
              onClick={clickable ? () => onOpenThread!(threadId!) : undefined}
              onKeyDown={
                clickable
                  ? (event) => {
                      if (event.key === "Enter" || event.key === " ") onOpenThread!(threadId!);
                    }
                  : undefined
              }
              style={{ cursor: clickable ? "pointer" : "default" }}
              transform={`translate(${x}, ${y})`}
            >
              {points ? (
                <polygon points={points} fill={color.fill} stroke={color.stroke} strokeWidth={isCurrent ? 3 : 1.5} />
              ) : (
                <rect width={node.width} height={node.height} rx={8} fill={color.fill} stroke={color.stroke} strokeWidth={isCurrent ? 3 : 1.5} />
              )}
              {isCurrent ? <rect width={node.width} height={node.height} rx={8} fill="none" stroke="#1d4ed8" strokeWidth={1} strokeDasharray="2 2" /> : null}
              <text x={node.width / 2} y={node.height / 2 + 4} textAnchor="middle" fontSize={12} fill="#0f172a">
                {node.label ?? node.id}
              </text>
              {node.visit > 1 ? (
                <g transform={`translate(${node.width - 12}, -4)`} data-visit-badge={node.visit}>
                  <circle r={9} fill="#1d4ed8" />
                  <text textAnchor="middle" y={4} fontSize={10} fill="#fff">
                    {node.visit}
                  </text>
                </g>
              ) : null}
            </g>
          );
        })}
      </g>
    </svg>
  );
}
