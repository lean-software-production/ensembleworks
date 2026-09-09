// WHAT A QUARANTINED EDGE LOOKS LIKE, decided here rather than in a component.
//
// WHY THIS LAYER EXISTS AT ALL (the premise W2 was given was half wrong, and
// the correct half is the expensive one). `@ensembleworks/canvas-react` DOES
// draw bound arrows: `overlay/Arrows.tsx` routes every arrow-kind shape with
// canvas-model's own `routeArrow` and paints it as an SVG path with
// arrowheads, and `canvas/panel/session-view.tsx` already mounts that
// `<Overlay>`. So a tree edge is drawn today, and nothing here re-draws a live
// one. What is NOT drawn is the DIFFERENCE between an edge that is part of a
// tree and one that has been taken out of it.
//
// THE HAZARD, in C2's words (obligation 1, 2026-09-09): quarantine moves
// `meta.tree` to `meta.treeQuarantine`, so the digest, all six read tools and
// W1's invariants go structurally blind to the edge — while the arrow and both
// of its `Binding` rows stay exactly where the human drew them. Now that
// arrows are known to render, "two humans agree with each other and both
// disagree with the tree" is the failure. This module is the fix: it keys on
// `meta.treeQuarantine` — the same key the write path stamps, not a copy of
// its reasoning — and produces the geometry for a distinct marker over the
// path canvas-react is already drawing.
//
// ADDITIVE, NOT SUPPRESSIVE, and that is a decision worth stating. Fully
// hiding canvas-react's own stroke for a quarantined arrow needs one of two
// things, and both were rejected:
//   - hand `<Overlay>` a FILTERED document with the quarantined arrows
//     removed. Cheap, but `Overlay` also draws Selection/Handles off that same
//     `snapshot`, so a selected quarantined arrow would lose its selection
//     outline — a legibility regression inside the node that exists to add
//     legibility;
//   - CSS-hide canvas-react's `g[data-overlay="arrow"][data-shape-id=...]`.
//     That couples this plugin to a DOM detail of a package it only consumes.
// So the live stroke stays visible UNDER a red dashed overstroke and a labelled
// chip. That is also the honest reading of quarantine itself: the relationship
// is not deleted, it is marked as no longer counting — and the human can still
// see where it ran. A renderer-side "draw nothing" would need canvas-react to
// grow a real "which arrows do I draw" prop, which is an operator call about
// the extraction boundary (plan risk 3), not this node's to make.
//
// DOM-FREE AND REACT-FREE, the same split `agents-view.ts` makes for the agent
// badges and for the same reason: this project has no jsdom, so a rule written
// inside a component is a rule no test can reach.
import { worldToScreen, type Camera } from "@ensembleworks/canvas-editor";
import {
  pageIdOf,
  routeArrow,
  type CanvasDocument,
  type Point,
} from "@ensembleworks/canvas-model";
import type { ViewportSize } from "@ensembleworks/canvas-react";
import { CULL_MARGIN } from "../agents-view.js";
import { TREE_EDGE_KIND, readTreeQuarantine } from "./encoding.js";

/**
 * The marker's appearance, as three constants a test can compare against the
 * live arrow's.
 *
 * DISTINCT ON THREE AXES, not one. canvas-react's `Arrows.tsx` draws an
 * unstyled arrow with `ARROW_STROKE` (#1a1a1a), `DEFAULT_STROKE_WIDTH_PX`
 * (1.5) and no dash array. Colour alone would be one theme change away from
 * colliding, and colour alone is also the axis a colour-blind reader is least
 * likely to get: the dash pattern and the weight carry the same message
 * independently, and the chip below carries it in words.
 */
export const QUARANTINE_STROKE = "#c81e1e";
export const QUARANTINE_STROKE_WIDTH = 3;
export const QUARANTINE_STROKE_DASHARRAY = "7 5";

/** The chip's opening words. The rest is the quarantine record's own `reason`
 * — `reparented` for a routine move (writes.ts's `REPARENT_REASON`), a
 * `TreeProblemKind` (`cycle`, `multiple-parents`, …) when W11's repair took
 * the edge out. A human should not have to guess which of those happened. */
export const QUARANTINE_LABEL_PREFIX = "quarantined: ";

/** One quarantined edge, ready to draw: everything in VIEWPORT-RELATIVE
 * SCREEN pixels, so the component that consumes it holds no geometry. */
export interface QuarantinedEdgeView {
  readonly edgeId: string;
  /** The routed path as an SVG `d`, in the same two forms Arrows.tsx uses:
   * `M start L end`, or `M start Q mid end` for a bent arrow. */
  readonly path: string;
  readonly label: string;
  /** Where the chip goes: the MIDPOINT OF THE DRAWN CURVE, not of the raw
   * endpoints — for a quadratic that is B(0.5) = ¼start + ½mid + ¼end, which
   * is genuinely on the ink. */
  readonly labelAt: Point;
}

/**
 * Every quarantined tree edge currently worth drawing, in document order.
 *
 * A pure function of the same `snapshot` and `camera` the shapes render from,
 * so a marker tracks its nodes through pan, zoom, drag and remote edits
 * without subscribing to anything of its own — the property `agents-view.ts`'s
 * `screenBoxFor` establishes for badges, and the reason routing rather than
 * remembering matters: `routeArrow` reads both bound shapes' CURRENT
 * positions.
 *
 * `currentPageId` is required, not optional, for the reason `screenBoxFor`
 * states: every page's shapes live in one document, so an edge from another
 * page would otherwise be drawn at world coordinates that mean nothing here.
 *
 * A shape whose quarantine record does not PARSE is skipped, not drawn as a
 * generic marker: `absent` and `invalid` are different answers (encoding.ts's
 * decision 1), and a marker built from an unreadable record would state a
 * provenance the document does not have. It is `checkTreeInvariants`' job to
 * report it, not this layer's to invent a rendering for it.
 */
export function quarantinedEdgeViews(
  doc: CanvasDocument,
  camera: Camera,
  viewportSize: ViewportSize,
  currentPageId: string,
): readonly QuarantinedEdgeView[] {
  const views: QuarantinedEdgeView[] = [];
  for (const shape of doc.shapes) {
    if (shape.kind !== TREE_EDGE_KIND) continue;
    const record = readTreeQuarantine(shape);
    if (record.status !== "ok") continue;
    if (pageIdOf(doc, shape) !== currentPageId) continue;

    // DUPLICATE TERMINAL BINDINGS, the gap W5 carried here deliberately:
    // `routeArrow`'s `resolveEndpoint` takes the FIRST binding row matching a
    // terminal, while W5's reader requires exactly one and reports ambiguity
    // instead of picking. It does not matter for THIS layer's honesty — the
    // marker is drawn by the same call, over the same array, that
    // canvas-react's `Arrows.tsx` uses, so the marker and the arrow it marks
    // can never land on different paths. It can still make two PEERS draw the
    // same ambiguous edge differently (nothing orders `doc.bindings` across
    // clients), and closing that would mean changing canvas-model, which this
    // plugin only consumes. Reported, not fixed.
    const routed = routeArrow(doc, shape, doc.bindings);
    const start = worldToScreen(camera, routed.start);
    const end = worldToScreen(camera, routed.end);
    const mid = routed.mid ? worldToScreen(camera, routed.mid) : undefined;
    if (!onScreen(start, end, mid, viewportSize)) continue;

    views.push({
      edgeId: shape.id,
      path: mid
        ? `M ${start.x} ${start.y} Q ${mid.x} ${mid.y} ${end.x} ${end.y}`
        : `M ${start.x} ${start.y} L ${end.x} ${end.y}`,
      label: `${QUARANTINE_LABEL_PREFIX}${record.value.reason}`,
      labelAt: mid
        ? { x: 0.25 * start.x + 0.5 * mid.x + 0.25 * end.x, y: 0.25 * start.y + 0.5 * mid.y + 0.25 * end.y }
        : { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
    });
  }
  return views;
}

/**
 * Whether any of this path could be on screen.
 *
 * OVER-INCLUSION ONLY, the same one-sided posture Arrows.tsx's cull takes: the
 * test is the path's own bounding box against the viewport, so a long edge
 * with BOTH endpoints off screen and its middle crossing it is kept (a bbox is
 * convex and contains every point of the segment, and for a quadratic the
 * curve stays inside the hull of {start, mid, end}). Dropping that case is the
 * one failure mode a cull is not allowed to have — the marker would vanish
 * exactly when the human is looking at the part of the canvas it crosses.
 */
function onScreen(start: Point, end: Point, mid: Point | undefined, viewportSize: ViewportSize): boolean {
  const xs = mid ? [start.x, mid.x, end.x] : [start.x, end.x];
  const ys = mid ? [start.y, mid.y, end.y] : [start.y, end.y];
  if (Math.max(...xs) < -CULL_MARGIN || Math.min(...xs) > viewportSize.width + CULL_MARGIN) return false;
  if (Math.max(...ys) < -CULL_MARGIN || Math.min(...ys) > viewportSize.height + CULL_MARGIN) return false;
  return true;
}
