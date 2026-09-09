// THE ARROW BODY THAT DRAWS NOTHING, and why that is the whole of W2's first
// outcome.
//
// canvas-react keeps two rendering paths, and an arrow is on both of them:
//
//   1. `overlay/Arrows.tsx` routes the arrow with canvas-model's `routeArrow`
//      and paints its real path — deliberately in the Overlay rather than as a
//      shape body, because routing is a CROSS-SHAPE read (the path depends on
//      where the two bound shapes are NOW) and ShapeBody's per-shape memo
//      model is not built for that. This is the drawing we want, and this
//      plugin already mounts that Overlay.
//   2. `ShapeLayer` -> `ShapeBody` -> `lookupShapeComponent('arrow')`, which
//      finds nothing (`registerCoreShapes` registers note/frame/text/geo/
//      draw/line/image, no arrow) and falls back to `BoxShape`. That paints a
//      100x100 labelled blue box — 100x100 because canvas-model's `size()`
//      gives a w/h-less kind the 100 default — positioned by the arrow's OWN
//      x/y, which is where it was CREATED. Move either endpoint and the box
//      stays behind, so it is not merely redundant with the routed line, it
//      actively contradicts it.
//
// Registering a body for the kind is the registry's own documented way to
// replace that fallback ("a second call for the same kind overwrites the
// first"), and the smallest one that says "this kind is drawn elsewhere" is a
// body that renders nothing. ShapeBody still emits its positioned wrapper div
// — transparent, no background, inside an already-existing DOM node — so this
// removes paint, not structure, and touches no hit-testing (selection is
// computed from the document's geometry, not from this div).
//
// SCOPE: every arrow, not just tree edges. The fallback box is redundant for
// any bound arrow in the room, tree or not — there is one `arrow` kind and one
// registry. KNOWN CONSEQUENCE, stated rather than discovered later: an arrow
// carrying TEXT loses the only place that text was being drawn, because the
// Overlay paints the path and the arrowheads but no label. No tree edge has
// text (encoding.ts's `buildTreeEdge` writes none), and a floating box of text
// pinned to a stale point was a poor rendering of an arrow label anyway; a
// real arrow label belongs in the overlay next to the path, which is
// canvas-react's to add, not this plugin's.
import { registerShape, type ShapeBodyProps } from "@ensembleworks/canvas-react";
import { TREE_EDGE_KIND } from "./encoding.js";

/** Draws nothing. See the module header — an arrow's ink comes from the
 * Overlay's routed path, and its quarantine marker from
 * `canvas/panel/quarantine-layer.tsx`. */
export function TreeArrowBody(_props?: ShapeBodyProps): null {
  return null;
}

let registered = false;

/** Replace canvas-react's `BoxShape` fallback for the `arrow` kind. Idempotent
 * for the same reason `registerCoreShapes` is: a second call — strict mode's
 * double mount, a room switch, HMR — must not have to be reasoned about. */
export function registerTreeArrowShape(): void {
  if (registered) return;
  registered = true;
  registerShape(TREE_EDGE_KIND, TreeArrowBody);
}
