/**
 * `ui/dag.tsx` — dagre layout, then a Graphviz-like SVG DAG with a live
 * execution overlay, per docs/plans/2026-09-13-attractor-runner-plan.md T5
 * and the vertical Fabro-style restyle: dagre layout laid out top-to-bottom
 * by default (see `direction` below — the DOT graph's own `rankdir` stays
 * parsed and available on `GraphView` but is not consulted by this layout);
 * node shape hints per `handlerKind` (ellipse for agent/prompt,
 * parallelogram for command, hexagon for human, diamond for conditional,
 * octagon for parallel/fan_in, Mdiamond/Msquare for start/exit); status
 * colours pending/running/succeeded/failed/skipped/blocked; visit badge
 * when > 1; current node highlighted; traversed edges emphasised with the
 * last-selected reason in a title; click on an agent node opens its worker
 * thread.
 *
 * `layoutGraph` is a pure function (no React, no DOM) so it is unit-tested
 * directly under vitest's default "node" environment — see
 * tests/ui/dag.test.ts. `DagView` is the React piece; it and every other
 * `ui/*`/`app.tsx` module must only ever import from `server/contracts.ts`
 * and `engine/types.ts` (pure types), never `server/service.ts` or
 * `server/store.ts` — those pull in `better-sqlite3`, a native module that
 * must never end up in the app's esbuild bundle.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { TOKENS } from "./primitives";
import type * as React from "react";
import * as dagre from "@dagrejs/dagre";
import type { GraphEdgeView, GraphNodeView, GraphView } from "../server/contracts";
import type { EdgeSelectedReason, RunEvent } from "../engine/types";

/** A nominal node size, used only as a viewBox floor — real node sizes follow their label (see `nodeSizeFor`). */
export const NODE_WIDTH = 168;
export const NODE_HEIGHT = 40;
// Tuned per docs/plans/2026-09-13-attractor-runner-plan.md's dogfood-polish
// findings: the previous, smaller nodesep produced a wobbly rankdir=LR
// layout (Check pushed down off the main row, short stub edges) once real
// loops (see BACK_EDGE_WEIGHT below) entered the graph.
const NODE_SEP = 32;
const RANK_SEP = 56;
const MARGIN = 24;
// A back edge (one that loops to an already-visited rank — see
// `isBackEdge`) gets zero weight so dagre's rank-assignment pass optimizes
// for the main forward path's edges only; a loop edge pulling on ranks is
// exactly what produced the T5 "Check pushed down" layout wobble.
const BACK_EDGE_WEIGHT = 0;
/** DagView's rank direction, independent of the DOT graph's own `rankdir` (parsed but not consulted here — see the module doc). */
export type LayoutDirection = "TB" | "LR";
const DEFAULT_DIRECTION: LayoutDirection = "TB";

// Zoom/pan: a scale/translate applied to the whole rendered graph via one
// wrapping `<g>` (`dag-zoom-group` below), independent of dagre's own
// coordinates. `DEFAULT_ZOOM` is the fit-to-width rendering the DAG box
// already shows today — "fit" resets to exactly this, never anything derived.
interface ZoomState {
  scale: number;
  tx: number;
  ty: number;
}
const DEFAULT_ZOOM: ZoomState = { scale: 1, tx: 0, ty: 0 };
const MIN_SCALE = 0.5;
const MAX_SCALE = 4;
const ZOOM_STEP = 1.2;
// How far a pointer must travel before a press counts as a pan rather than a click.
const DRAG_THRESHOLD_PX = 4;

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * The scale to multiply a screen-pixel delta/offset by to get the
 * equivalent in the `<svg>`'s own viewBox user units — 1 unless the svg is
 * rendered at a different size than its viewBox (e.g. scaled to fit its
 * container). Prefers `getScreenCTM()` (unavailable in jsdom); falls back
 * to the viewBox/rendered-size ratio, treating a zero/undefined rendered
 * size as no scaling.
 */
function svgClientScale(svg: SVGSVGElement, viewWidth: number, viewHeight: number): { x: number; y: number } {
  const ctm = svg.getScreenCTM?.();
  if (ctm && ctm.a && ctm.d) {
    return { x: 1 / ctm.a, y: 1 / ctm.d };
  }
  const rect = svg.getBoundingClientRect();
  return {
    x: rect.width ? viewWidth / rect.width : 1,
    y: rect.height ? viewHeight / rect.height : 1,
  };
}

/**
 * Converts a pointer event's client (screen) coordinates into the `<svg>`'s
 * own viewBox user units — the coordinate space `zoomAround`'s `pivot` and
 * the zoom group's `translate` live in. Prefers `getScreenCTM()` (its
 * inverse maps screen px straight to viewBox units; unavailable in jsdom);
 * falls back to the bounding rect's origin plus the viewBox/rendered-size
 * ratio, treating a zero/undefined rendered size as no scaling.
 */
function clientPointToViewBox(svg: SVGSVGElement, clientX: number, clientY: number, viewWidth: number, viewHeight: number, viewY = 0, viewX = 0): { x: number; y: number } {
  const ctm = svg.getScreenCTM?.();
  if (ctm) {
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const transformed = point.matrixTransform(ctm.inverse());
    return { x: transformed.x, y: transformed.y };
  }
  const rect = svg.getBoundingClientRect();
  const scaleX = rect.width ? viewWidth / rect.width : 1;
  const scaleY = rect.height ? viewHeight / rect.height : 1;
  return { x: viewX + (clientX - rect.left) * scaleX, y: viewY + (clientY - rect.top) * scaleY };
}

/** Zooms `state` by `factor` around the viewBox point `pivot`, keeping that point stationary on screen. */
function zoomAround(state: ZoomState, factor: number, pivot: { x: number; y: number }): ZoomState {
  const nextScale = clampScale(state.scale * factor);
  if (nextScale === state.scale) return state;
  const appliedFactor = nextScale / state.scale;
  return {
    scale: nextScale,
    tx: pivot.x - (pivot.x - state.tx) * appliedFactor,
    ty: pivot.y - (pivot.y - state.ty) * appliedFactor,
  };
}

// Graphviz-like node sizing: width follows the label, height is fixed.
const CHAR_WIDTH = 7.5;
const LABEL_PADDING = 28;
const MIN_NODE_WIDTH = 88;
const MAX_NODE_WIDTH = 240;

function nodeSizeFor(label: string): { width: number; height: number } {
  const raw = label.length * CHAR_WIDTH + LABEL_PADDING;
  const width = Math.min(MAX_NODE_WIDTH, Math.max(MIN_NODE_WIDTH, Math.round(raw)));
  return { width, height: NODE_HEIGHT };
}

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
  /** True when this edge's target rank is <= its source rank in the final layout — a loop (e.g. `approve -> plan`, `check -> implement`), not part of the graph's forward flow. */
  isBackEdge: boolean;
}

export interface LaidOutGraph {
  width: number;
  height: number;
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
}

interface BuiltGraph {
  g: dagre.graphlib.Graph;
  validEdges: { edge: GraphEdgeView; edgeIndex: number }[];
}

/** Builds the dagre graph for one layout pass, applying `edgeWeight` per edge (by its index in `graph.edges`) when given. */
function buildDagreGraph(graph: GraphView, direction: LayoutDirection, edgeWeight?: (edgeIndex: number) => number): BuiltGraph {
  // `multigraph: true` because this dialect allows two DOT edges between the
  // same node pair (e.g. two conditional outcomes both routed to the same
  // next node) — a plain graph collapses those into one dagre edge, losing
  // one path's route entirely. Each edge is named by its index in
  // `graph.edges` so multiple edges for the same pair stay distinct; a
  // *value* of `{}` (not `undefined`) is required here or dagre's named-edge
  // path throws reading `.points` off an unset label.
  const g = new dagre.graphlib.Graph({ multigraph: true });
  // `direction` (this function's own parameter, defaulted by `layoutGraph`)
  // drives dagre's rankdir — never `graph.rankdir`, which stays parsed and
  // exposed on `GraphView` but is not consulted for layout (see the module
  // doc: the card always renders top-to-bottom by default).
  g.setGraph({ rankdir: direction, nodesep: NODE_SEP, ranksep: RANK_SEP, marginx: MARGIN, marginy: MARGIN });
  g.setDefaultEdgeLabel(() => ({}));
  for (const node of graph.nodes) g.setNode(node.id, nodeSizeFor(node.label ?? node.id));
  const validEdges: { edge: GraphEdgeView; edgeIndex: number }[] = [];
  graph.edges.forEach((edge, edgeIndex) => {
    // A node reachable only through a validation-rejected edge (dangling
    // target) would make dagre throw; skip rather than crash the whole DAG.
    if (!g.hasNode(edge.from) || !g.hasNode(edge.to)) return;
    validEdges.push({ edge, edgeIndex });
    const weight = edgeWeight ? edgeWeight(edgeIndex) : 1;
    g.setEdge(edge.from, edge.to, { weight }, String(edgeIndex));
  });
  return { g, validEdges };
}

/**
 * Pure dagre layout: deterministic node positions + routed edge points for a
 * GraphView. No DOM. `direction` defaults to "TB" (vertical, Fabro-style)
 * regardless of the graph's own declared `rankdir` — pass "LR" explicitly
 * for a left-to-right layout.
 */
export function layoutGraph(graph: GraphView, direction: LayoutDirection = DEFAULT_DIRECTION): LaidOutGraph {
  // First pass, uniform edge weight: establishes a rank per node so back
  // edges (loops like `approve -> plan`) can be told apart from the graph's
  // forward flow purely from the resulting layout, per the plan's own
  // definition ("target rank <= source rank").
  const first = buildDagreGraph(graph, direction);
  dagre.layout(first.g);
  const isBackEdgeFirstPass = new Map<number, boolean>();
  for (const { edge, edgeIndex } of first.validEdges) {
    const fromRank = (first.g.node(edge.from) as { rank?: number }).rank ?? 0;
    const toRank = (first.g.node(edge.to) as { rank?: number }).rank ?? 0;
    isBackEdgeFirstPass.set(edgeIndex, toRank <= fromRank);
  }

  // Second pass: zero-weight the back edges found above so a loop no longer
  // pulls on the main path's rank assignment (the "Check pushed down" T5
  // finding), then lay out again from a clean graph.
  const second = buildDagreGraph(graph, direction, (edgeIndex) => (isBackEdgeFirstPass.get(edgeIndex) ? BACK_EDGE_WEIGHT : 1));
  dagre.layout(second.g);

  const nodes: LaidOutNode[] = graph.nodes.map((node) => {
    const laid = second.g.node(node.id);
    return { ...node, x: laid.x, y: laid.y, width: laid.width, height: laid.height };
  });
  const edges: LaidOutEdge[] = second.validEdges.map(({ edge, edgeIndex }) => {
    const laid = second.g.edge(edge.from, edge.to, String(edgeIndex));
    const fromRank = (second.g.node(edge.from) as { rank?: number }).rank ?? 0;
    const toRank = (second.g.node(edge.to) as { rank?: number }).rank ?? 0;
    return { ...edge, points: laid?.points ?? [], edgeIndex, isBackEdge: toRank <= fromRank };
  });

  const graphLabel = second.g.graph() as { width?: number; height?: number };
  const width = graphLabel.width ?? nodes.reduce((max, n) => Math.max(max, n.x + n.width / 2), 0);
  const height = graphLabel.height ?? nodes.reduce((max, n) => Math.max(max, n.y + n.height / 2), 0);
  return { width, height, nodes, edges };
}


// ---------------------------------------------------------------------------
// Visual mapping
// ---------------------------------------------------------------------------

export type NodeStatus = GraphNodeView["status"];

// Run-panel redesign: theme colours, no fixed light palette. Every node has
// the card's own fill; its outline carries the status. Pending (not yet
// reached) is the faint border colour so untaken parts of the graph recede.
const STATUS_STROKE: Record<NonNullable<NodeStatus> | "pending", string> = {
  pending: TOKENS.border,
  running: TOKENS.brand,
  // A human gate or a worker waiting on something — distinct from "running"
  // so the graph visibly flags where a run is stuck.
  blocked: TOKENS.warning,
  succeeded: TOKENS.success,
  failed: TOKENS.destructive,
  skipped: TOKENS.mutedFg,
  // The stage a run was stopped in: settled by the finish path rather than
  // by a stage event, so it reads as "abandoned" rather than failed.
  cancelled: TOKENS.mutedFg,
};

const STATUS_WORD: Record<NonNullable<NodeStatus>, string> = {
  running: "running",
  blocked: "waiting",
  succeeded: "done",
  failed: "failed",
  skipped: "skipped",
  cancelled: "stopped",
};

/** A node's fill and outline colour (CSS colour values, theme variables with fallbacks). */
export function statusColor(status: NodeStatus): { fill: string; stroke: string } {
  return { fill: TOKENS.card, stroke: STATUS_STROKE[status ?? "pending"] };
}

/** Node outline stroke width by status, before any current-node emphasis is applied. */
function statusStrokeWidth(status: NodeStatus): number {
  return status === "running" || status === "blocked" ? 2 : 1.5;
}

type ShapeKind = "polygon" | "ellipse" | "rect";

/** The primary outline element kind for a node's shape hint, keyed by handlerKind — a Graphviz-like reading (ellipse for agent/prompt) rather than a uniform box for every kind. */
function shapeKindFor(handlerKind: string): ShapeKind {
  switch (handlerKind) {
    case "start":
    case "human":
    case "command":
    case "conditional":
    case "exit":
    case "parallel":
    case "parallel.fan_in":
      return "polygon";
    case "agent":
    case "prompt":
      return "ellipse";
    default:
      return "rect";
  }
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
      // Msquare: a rectangle with each of its 4 corners clipped diagonally.
      const clip = Math.min(w, h) * 0.22;
      return `${clip},0 ${w - clip},0 ${w},${clip} ${w},${h - clip} ${w - clip},${h} ${clip},${h} 0,${h - clip} 0,${clip}`;
    }
    case "parallel":
    case "parallel.fan_in":
      // Octagon, with proportionally larger corner cuts than `exit`'s Msquare.
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

/**
 * A smoothed SVG path through dagre's routed points — a "Q" (quadratic)
 * command per intermediate point, midpoint-smoothed between consecutive
 * points, then a final "L" into the last point.
 */
function pathFor(points: { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  if (points.length <= 2) return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  let d = `M${points[0]!.x},${points[0]!.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const current = points[i]!;
    const next = points[i + 1]!;
    d += ` Q${current.x},${current.y} ${(current.x + next.x) / 2},${(current.y + next.y) / 2}`;
  }
  const last = points[points.length - 1]!;
  d += ` L${last.x},${last.y}`;
  return d;
}

/** The point at (approximately) half the polyline's total length — used to place an edge's label. */
function midpointOf(points: { x: number; y: number }[]): { x: number; y: number } | null {
  if (points.length === 0) return null;
  if (points.length === 1) return points[0]!;
  const segmentLengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y));
  const total = segmentLengths.reduce((sum, len) => sum + len, 0);
  if (total === 0) return points[0]!;
  let travelled = 0;
  const half = total / 2;
  for (let i = 0; i < segmentLengths.length; i++) {
    const segment = segmentLengths[i]!;
    if (travelled + segment >= half) {
      const t = segment === 0 ? 0 : (half - travelled) / segment;
      const from = points[i]!;
      const to = points[i + 1]!;
      return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
    }
    travelled += segment;
  }
  return points[points.length - 1]!;
}

const MAX_CONDITION_LABEL_LENGTH = 30;

/** The DOT-declared edge label if present, else a shortened form of its routing condition, else null. */
function edgeDisplayLabel(edge: Pick<GraphEdgeView, "label" | "condition">): string | null {
  if (edge.label) return edge.label;
  if (edge.condition) return edge.condition.length > MAX_CONDITION_LABEL_LENGTH ? `${edge.condition.slice(0, MAX_CONDITION_LABEL_LENGTH - 1)}…` : edge.condition;
  return null;
}

/** Follow mode shows a window this many times the graph's width tall, centred on the followed node. */
const FOLLOW_WINDOW_ASPECT = 0.8;
/**
 * Follow mode's window is at least this wide (viewBox units). The window
 * fills the panel's width, so a window only as wide as a narrow
 * top-to-bottom graph magnified it several times over; a floor keeps a
 * followed graph near its natural size, centred horizontally.
 */
export const FOLLOW_MIN_WIDTH = 480;

export interface DagViewProps {
  graph: GraphView;
  /** All events recorded for the run so far — used to find traversed edges and their selection reason. */
  events: readonly RunEvent[];
  /** The run's current/most-recently-entered node, per `Run.currentNodeId`; emphasised with a heavier outline. */
  currentNodeId?: string | null;
  /** nodeId -> the worker threadId of its latest stage, when known (from `getRun`'s stages). */
  threadIdByNode?: Record<string, string | null | undefined>;
  /** Called when an agent/prompt node with a known worker thread is clicked — only when `onSelectNode` is not given. */
  onOpenThread?: (threadId: string) => void;
  /** Rank direction for `layoutGraph` — defaults to "TB" (vertical), regardless of the graph's own declared `rankdir`. */
  direction?: LayoutDirection;
  /** Selection mode (run panel): every node is clickable and selects itself instead of opening a thread. */
  selectedNodeId?: string | null;
  onSelectNode?: (nodeId: string) => void;
  /**
   * Follow mode (run panel): when set and `following` is true, the view is a
   * window onto the graph centred on this node, moving as it changes. Any
   * pan or zoom by the user calls `onFollowingChange(false)`; "Fit" shows the
   * whole graph and stops following too.
   */
  followNodeId?: string | null;
  following?: boolean;
  onFollowingChange?: (following: boolean) => void;
  /** Caps the rendered height (px). Defaults to 520; the large view passes more. */
  maxHeight?: number;
}

/** dagre-laid-out SVG rendering of a workflow graph with a live execution overlay. */
export function DagView({
  graph,
  events,
  currentNodeId,
  threadIdByNode,
  onOpenThread,
  direction = DEFAULT_DIRECTION,
  selectedNodeId,
  onSelectNode,
  followNodeId,
  following = false,
  onFollowingChange,
  maxHeight = 520,
}: DagViewProps) {
  const laidOut = layoutGraph(graph, direction);
  const selections = latestEdgeSelections(events);
  const fullWidth = Math.max(laidOut.width, NODE_WIDTH);
  const fullHeight = Math.max(laidOut.height, NODE_HEIGHT);

  // The viewBox: the whole graph, or (follow mode) a window onto it. Once
  // following stops the window stays where it was, so a pan is relative to
  // what the user was looking at; "Fit" switches back to the whole graph.
  const followCapable = followNodeId !== undefined;
  const windowWidth = Math.max(fullWidth, FOLLOW_MIN_WIDTH);
  const windowHeight = Math.max(NODE_HEIGHT * 3, Math.round(windowWidth * FOLLOW_WINDOW_ASPECT));
  const [wholeGraph, setWholeGraph] = useState(!following);
  const lastWindowY = useRef(0);
  const followed = followNodeId ? laidOut.nodes.find((n) => n.id === followNodeId) : undefined;
  let viewX = 0;
  let viewY = 0;
  let viewWidth = fullWidth;
  let viewHeight = fullHeight;
  if (followCapable && !wholeGraph && fullHeight > windowHeight) {
    if (following && followed) lastWindowY.current = Math.min(Math.max(0, followed.y - windowHeight / 2), fullHeight - windowHeight);
    viewX = -(windowWidth - fullWidth) / 2;
    viewY = lastWindowY.current;
    viewWidth = windowWidth;
    viewHeight = windowHeight;
  }

  const [zoom, setZoom] = useState<ZoomState>(DEFAULT_ZOOM);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragState = useRef<{ pointerId: number; lastX: number; lastY: number; startX: number; startY: number; panning: boolean } | null>(null);
  // Set when a drag actually panned, so the `click` the browser synthesises
  // at the end of that drag does not also act on the node it started on.
  const suppressNextClick = useRef(false);

  // Starting to follow (again) recentres: no leftover pan/zoom, windowed view.
  useEffect(() => {
    if (!following) return;
    setZoom(DEFAULT_ZOOM);
    setWholeGraph(false);
  }, [following]);

  const userMoved = useCallback(() => {
    if (following) onFollowingChange?.(false);
  }, [following, onFollowingChange]);

  const center = { x: viewX + viewWidth / 2, y: viewY + viewHeight / 2 };
  const zoomIn = () => {
    userMoved();
    setZoom((z) => zoomAround(z, ZOOM_STEP, center));
  };
  const zoomOut = () => {
    userMoved();
    setZoom((z) => zoomAround(z, 1 / ZOOM_STEP, center));
  };
  const fit = () => {
    if (following) onFollowingChange?.(false);
    setWholeGraph(true);
    setZoom(DEFAULT_ZOOM);
  };

  // A plain wheel must reach the host untouched (the thread/panel scroll
  // container underneath) — only ctrl/meta+wheel (pinch-zoom or an explicit
  // zoom gesture) is ours to intercept. React attaches its synthetic wheel
  // listener passively, so a manual non-passive listener is required to
  // actually stop the page from also scrolling/zooming.
  const userMovedRef = useRef(userMoved);
  userMovedRef.current = userMoved;
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const handler = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return; // let the host scroll normally
      event.preventDefault();
      userMovedRef.current();
      const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      const pivot = clientPointToViewBox(svg, event.clientX, event.clientY, viewWidth, viewHeight, viewY, viewX);
      setZoom((z) => zoomAround(z, factor, pivot));
    };
    svg.addEventListener("wheel", handler, { passive: false });
    return () => svg.removeEventListener("wheel", handler);
  }, [viewWidth, viewHeight, viewY, viewX]);

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    // Only a plain primary-button drag pans. No `setPointerCapture` here: a
    // press that turns out to be an ordinary node click must stay one, and
    // capturing up front re-targets the synthesised `click` to the <svg>.
    // Capture is taken in onPointerMove, once the press has become a pan.
    if (event.button !== 0) return;
    suppressNextClick.current = false;
    dragState.current = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY, startX: event.clientX, startY: event.clientY, panning: false };
  };
  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.panning) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD_PX) return;
      drag.panning = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      userMoved();
    }
    const dx = event.clientX - drag.lastX;
    const dy = event.clientY - drag.lastY;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    const svg = svgRef.current;
    const clientScale = svg ? svgClientScale(svg, viewWidth, viewHeight) : { x: 1, y: 1 };
    setZoom((z) => ({ ...z, tx: z.tx + dx * clientScale.x, ty: z.ty + dy * clientScale.y }));
  };
  const endDrag = (event: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragState.current;
    if (drag?.pointerId !== event.pointerId) return;
    if (drag.panning) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      suppressNextClick.current = true;
    }
    dragState.current = null;
  };

  return (
    <div data-testid="dag-viewport" data-following={followCapable ? String(following) : undefined} style={{ position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", top: 4, right: 4, zIndex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
        <ZoomButton label="Zoom in" onClick={zoomIn}>
          +
        </ZoomButton>
        <ZoomButton label="Zoom out" onClick={zoomOut}>
          −
        </ZoomButton>
        <ZoomButton label="Fit" onClick={fit}>
          ⤢
        </ZoomButton>
      </div>
      <svg
        ref={svgRef}
        role="img"
        aria-label="Workflow DAG"
        viewBox={`${viewX} ${viewY} ${viewWidth} ${viewHeight}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ width: "100%", height: "auto", maxHeight, display: "block", touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <defs>
          <marker id="attractor-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" style={{ fill: TOKENS.border }} />
          </marker>
          <marker id="attractor-arrow-traversed" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" style={{ fill: TOKENS.mutedFg }} />
          </marker>
          {/* A clickable node's hover/focus highlight, driven by CSS
              `:hover`/`:focus` on the node's own `<g>` — no JS hover state. */}
          <style>{`
            .attractor-node--clickable:hover polygon,
            .attractor-node--clickable:hover ellipse,
            .attractor-node--clickable:hover rect,
            .attractor-node--clickable:focus polygon,
            .attractor-node--clickable:focus ellipse,
            .attractor-node--clickable:focus rect {
              stroke-width: 3;
            }
            .attractor-node--clickable:focus { outline: none; }
          `}</style>
        </defs>
        <g data-testid="dag-zoom-group" transform={`translate(${zoom.tx}, ${zoom.ty}) scale(${zoom.scale})`}>
          <g>
            {laidOut.edges.map((edge) => {
              const selection = selections.get(`${edge.from} ${edge.to}`);
              const traversed = Boolean(selection);
              const label = edgeDisplayLabel(edge);
              const midpoint = label ? midpointOf(edge.points) : null;
              // Untaken routes are faint (the border colour); a taken route
              // is the stronger muted-foreground. An untaken back edge (a
              // loop) also dashes, to read as "not the forward path".
              const stroke = traversed ? TOKENS.mutedFg : TOKENS.border;
              const strokeWidth = traversed ? 1.6 : 1.2;
              const strokeDasharray = !traversed && edge.isBackEdge ? "4 3" : undefined;
              return (
                <g key={`${edge.from}->${edge.to}#${edge.edgeIndex}`}>
                  <path
                    data-edge={`${edge.from}->${edge.to}`}
                    data-traversed={traversed}
                    data-back-edge={edge.isBackEdge}
                    d={pathFor(edge.points)}
                    fill="none"
                    style={{ stroke, strokeWidth }}
                    strokeDasharray={strokeDasharray}
                    markerEnd={`url(#${traversed ? "attractor-arrow-traversed" : "attractor-arrow"})`}
                  >
                    <title>{selection ? `${edge.from} → ${edge.to} (${selection.reason}${selection.edgeLabel ? `: ${selection.edgeLabel}` : ""})` : `${edge.from} → ${edge.to}`}</title>
                  </path>
                  {label && midpoint ? (
                    <g data-edge-label={`${edge.from}->${edge.to}`} transform={`translate(${midpoint.x}, ${midpoint.y})`}>
                      {/* A card-coloured text-stroke halo (paint-order="stroke")
                          keeps the label legible over a crossing edge/node. */}
                      <text textAnchor="middle" y={4} fontSize={11} paintOrder="stroke" style={{ fill: TOKENS.mutedFg, stroke: TOKENS.card, strokeWidth: 3 }}>
                        {label}
                      </text>
                    </g>
                  ) : null}
                </g>
              );
            })}
          </g>
          <g>
            {laidOut.nodes.map((node) => {
              const color = statusColor(node.status);
              const isCurrent = node.id === currentNodeId;
              const isSelected = onSelectNode !== undefined && node.id === selectedNodeId;
              const threadId = threadIdByNode?.[node.id] ?? null;
              const selectable = onSelectNode !== undefined;
              const opensThread = !selectable && opensWorkerThread(node.handlerKind) && Boolean(threadId) && Boolean(onOpenThread);
              const clickable = selectable || opensThread;
              const shapeKind = shapeKindFor(node.handlerKind);
              const points = shapeKind === "polygon" ? shapePoints(node.handlerKind, node.width, node.height) : null;
              const strokeWidth = isCurrent ? 2.75 : statusStrokeWidth(node.status);
              const outlineStyle = { fill: color.fill, stroke: color.stroke, strokeWidth, strokeDasharray: node.status === "skipped" || node.status === "cancelled" ? "3 2" : undefined };
              const x = node.x - node.width / 2;
              const y = node.y - node.height / 2;
              const activate = () => {
                if (suppressNextClick.current) {
                  suppressNextClick.current = false;
                  return;
                }
                if (selectable) onSelectNode!(node.id);
                else onOpenThread!(threadId!);
              };
              // A second line under the label: where the run is on the
              // current node ("waiting · pass 9"), or how many times a loop
              // body has run ("9 passes") instead of a badge on every node.
              const sub = isCurrent && node.status ? `${STATUS_WORD[node.status]}${node.visit > 1 ? ` · pass ${node.visit}` : ""}` : node.visit > 1 ? `${node.visit} passes` : null;
              const subColor = isCurrent && node.status === "blocked" ? TOKENS.warningText : isCurrent && node.status === "failed" ? TOKENS.destructiveText : TOKENS.mutedFg;
              const label = node.label ?? node.id;
              return (
                <g
                  key={node.id}
                  data-node-id={node.id}
                  data-handler-kind={node.handlerKind}
                  data-status={node.status ?? "pending"}
                  data-current={isCurrent}
                  data-selected={selectable ? isSelected : undefined}
                  data-clickable={clickable}
                  className={clickable ? "attractor-node--clickable" : undefined}
                  role={clickable ? "button" : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  aria-pressed={selectable ? isSelected : undefined}
                  aria-label={selectable ? `Select ${label}` : opensThread ? `Open worker thread for ${label}` : undefined}
                  onClick={clickable ? activate : undefined}
                  onKeyDown={
                    clickable
                      ? (event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            if (selectable) onSelectNode!(node.id);
                            else onOpenThread!(threadId!);
                          }
                        }
                      : undefined
                  }
                  style={{ cursor: clickable ? "pointer" : "default" }}
                  transform={`translate(${x}, ${y})`}
                >
                  {node.status === "blocked" && node.waitingReason ? (
                    <title>{`Waiting: ${node.waitingReason} in worker thread`}</title>
                  ) : opensThread ? (
                    <title>{`Open worker thread ${threadId}`}</title>
                  ) : null}
                  {isSelected ? <rect x={-4} y={-4} width={node.width + 8} height={node.height + 8} rx={10} fill="none" style={{ stroke: TOKENS.ring, strokeWidth: 1.5 }} strokeDasharray="3 2" data-selection-ring /> : null}
                  {shapeKind === "polygon" && points ? (
                    <polygon points={points} style={outlineStyle} />
                  ) : shapeKind === "ellipse" ? (
                    <ellipse cx={node.width / 2} cy={node.height / 2} rx={node.width / 2} ry={node.height / 2} style={outlineStyle} />
                  ) : (
                    <rect width={node.width} height={node.height} rx={8} style={outlineStyle} />
                  )}
                  <text
                    x={node.width / 2}
                    y={sub ? node.height / 2 - 1 : node.height / 2 + 4}
                    textAnchor="middle"
                    fontSize={12}
                    fontWeight={isCurrent ? 600 : undefined}
                    textDecoration={opensThread ? "underline" : undefined}
                    style={{ fill: node.status === null ? TOKENS.mutedFg : TOKENS.cardFg }}
                  >
                    {label}
                  </text>
                  {sub ? (
                    <text data-visit-badge={node.visit} x={node.width / 2} y={node.height / 2 + 11} textAnchor="middle" fontSize={9} style={{ fill: subColor }}>
                      {sub}
                    </text>
                  ) : null}
                  {opensThread ? (
                    <text data-open-thread-glyph x={4} y={12} fontSize={10} style={{ fill: TOKENS.brand }}>
                      ↗
                    </text>
                  ) : null}
                </g>
              );
            })}
          </g>
        </g>
      </svg>
    </div>
  );
}

interface ZoomButtonProps {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}

/** One button in the DAG's overlaid zoom-control cluster. */
function ZoomButton({ label, onClick, children }: ZoomButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      style={{
        width: 22,
        height: 22,
        lineHeight: "20px",
        padding: 0,
        borderRadius: 4,
        border: `1px solid ${TOKENS.border}`,
        background: TOKENS.card,
        color: TOKENS.mutedFg,
        cursor: "pointer",
        fontSize: 13,
      }}
    >
      {children}
    </button>
  );
}
