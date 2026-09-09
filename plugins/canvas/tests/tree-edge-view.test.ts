// Run: npx vitest run tests/tree-edge-view.test.ts
//
// W2's gate. Two claims, and they are different in kind.
//
// 1. THE FALLBACK BOX IS REAL AND IS SUPPRESSED. `arrow` is not in
//    `registerCoreShapes`'s list, so canvas-react's shapeRegistry resolves it
//    to `BoxShape` — a 100x100 labelled blue box (canvas-model's geometry
//    DEFAULTS give a w/h-less arrow 100x100) drawn at the arrow's OWN x/y,
//    which is where the arrow was CREATED, not where its routed path is now.
//    Both halves are asserted against the real registry, not restated.
//
// 2. A QUARANTINED EDGE IS DRAWN DISTINCTLY FROM A LIVE ONE. This is C2's
//    obligation 1. The whole hazard is that quarantine moves `meta.tree` to
//    `meta.treeQuarantine`, so every tree reader goes blind to the edge while
//    the arrow stays drawn — two humans agree with each other and both
//    disagree with the tree. The assertions are therefore about the DIFFERENCE
//    between the two renderings, not about pixel values.
//
// Geometry is checked against canvas-model's own `routeArrow` output through a
// real `makeDocument`, the same posture tree-encoding.test.ts takes: a
// fixture-shaped test here would pass while the drawn path pointed somewhere
// else entirely.
import { describe, expect, it } from "vitest";
import { BoxShape, lookupShapeComponent } from "@ensembleworks/canvas-react";
import {
  localBounds,
  makeDocument,
  routeArrow,
  type CanvasDocument,
  type Page,
  type Shape,
} from "@ensembleworks/canvas-model";
import { worldToScreen, type Camera } from "@ensembleworks/canvas-editor";
import {
  TREE_EDGE_KIND,
  buildTreeEdge,
  buildTreeNode,
  markTreePage,
  quarantineTreeShape,
} from "../canvas/tree/encoding.js";
import { REPARENT_REASON } from "../canvas/tree/writes.js";
import {
  QUARANTINE_LABEL_PREFIX,
  QUARANTINE_STROKE,
  QUARANTINE_STROKE_DASHARRAY,
  QUARANTINE_STROKE_WIDTH,
  quarantinedEdgeViews,
} from "../canvas/tree/edge-view.js";
import {
  TreeArrowBody,
  registerTreeArrowShape,
} from "../canvas/tree/arrow-shape.js";

const TREE_ID = "page:tree-view";
const OTHER_PAGE = "page:elsewhere";
const GOAL = "shape:goal";
const BLOCKER = "shape:blocker";
const EDGE = "shape:edge";

const CAMERA: Camera = { x: 0, y: 0, z: 1 };
const VIEWPORT = { width: 1000, height: 800 };

function page(): Page {
  return markTreePage({ id: TREE_ID, name: "Tree" });
}

function goal(): Shape {
  return buildTreeNode({
    id: GOAL,
    treeId: TREE_ID,
    parentId: TREE_ID,
    index: "a1",
    x: 0,
    y: 0,
  });
}

function blocker(): Shape {
  return buildTreeNode({
    id: BLOCKER,
    treeId: TREE_ID,
    parentId: TREE_ID,
    index: "a2",
    x: 0,
    y: 400,
  });
}

function edge(id = EDGE) {
  return buildTreeEdge({
    id,
    treeId: TREE_ID,
    parentId: TREE_ID,
    index: "a3",
    blockerId: BLOCKER,
    blockedId: GOAL,
    from: { x: 100, y: 400 },
    to: { x: 100, y: 100 },
  });
}

/** The document as the room holds it: two nodes and one edge, live. */
function liveDoc(): CanvasDocument {
  const built = edge();
  return makeDocument({
    pages: [page()],
    shapes: [goal(), blocker(), built.shape],
    bindings: [...built.bindings],
  });
}

/** The same document after W11/W10c parked the edge. */
function quarantinedDoc(reason = REPARENT_REASON): CanvasDocument {
  const built = edge();
  const parked = quarantineTreeShape(built.shape, {
    reason,
    detail: "shape:blocker was moved to block shape:other instead of shape:goal",
  });
  if (parked.status !== "ok") throw new Error(`fixture: ${JSON.stringify(parked)}`);
  return makeDocument({
    pages: [page()],
    shapes: [goal(), blocker(), parked.value],
    bindings: [...built.bindings],
  });
}

// ORDER MATTERS INSIDE THIS BLOCK, once: the registry is module-global, so the
// "still BoxShape" assertion has to run before anything registers over it.
// Vitest keeps one module registry per FILE, and this is the only file that
// registers, so nothing outside can perturb it.
describe("the redundant fallback body (outcome 1)", () => {
  it("resolves an unregistered arrow kind to BoxShape — the box W2 removes", () => {
    // The premise, asserted rather than believed: before this plugin
    // registers anything, canvas-react's registry hands an arrow the generic
    // labelled box (shapeRegistry.ts's FALLBACK POLICY).
    expect(lookupShapeComponent(TREE_EDGE_KIND)).toBe(BoxShape);
  });

  it("would draw that box 100x100 at the arrow's stale creation point", () => {
    // WHY THE BOX IS WRONG, not merely redundant: ShapeBody sizes a body by
    // `localBounds` and positions it by the shape's own transform, but a bound
    // arrow's VISIBLE path comes from `routeArrow` reading the two bound
    // shapes' CURRENT positions. Move a node and the box stays behind.
    const built = edge();
    expect(localBounds(built.shape)).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
    expect({ x: built.shape.x, y: built.shape.y }).toEqual({ x: 100, y: 400 });
    // And it STAYS there: move the blocker and the routed path moves while the
    // arrow shape's own x/y — the only thing ShapeBody positions the box by —
    // does not. That gap is the box's whole defect.
    const before = routeArrow(liveDoc(), built.shape, built.bindings);
    const moved = makeDocument({
      pages: [page()],
      shapes: [goal(), { ...blocker(), x: 900 } as Shape, built.shape],
      bindings: [...built.bindings],
    });
    const after = routeArrow(moved, built.shape, built.bindings);
    expect(after.start).not.toEqual(before.start);
    expect({ x: built.shape.x, y: built.shape.y }).toEqual({ x: 100, y: 400 });
  });

  it("registers an arrow body that draws nothing, so the box is gone", () => {
    registerTreeArrowShape();
    expect(lookupShapeComponent(TREE_EDGE_KIND)).not.toBe(BoxShape);
    expect(lookupShapeComponent(TREE_EDGE_KIND)).toBe(TreeArrowBody);
    // Called as a plain function — this project has no jsdom, and a body that
    // returns null needs no renderer to be checked.
    expect(TreeArrowBody()).toBe(null);
  });

  it("is idempotent, like registerCoreShapes", () => {
    registerTreeArrowShape();
    registerTreeArrowShape();
    expect(lookupShapeComponent(TREE_EDGE_KIND)).toBe(TreeArrowBody);
  });
});

describe("quarantined edges render distinctly (outcome 2, C2 obligation 1)", () => {
  it("draws nothing for a live edge", () => {
    // The layer is quarantine-only: canvas-react's Overlay already draws every
    // bound arrow, and drawing a second live-looking line over it would be the
    // bug this node exists to remove.
    expect(quarantinedEdgeViews(liveDoc(), CAMERA, VIEWPORT, TREE_ID)).toEqual([]);
  });

  it("draws the quarantined edge, naming it", () => {
    const views = quarantinedEdgeViews(quarantinedDoc(), CAMERA, VIEWPORT, TREE_ID);
    expect(views).toHaveLength(1);
    expect(views[0]!.edgeId).toBe(EDGE);
  });

  it("carries the reason in its label, so a move and a repair read differently", () => {
    const moved = quarantinedEdgeViews(quarantinedDoc(REPARENT_REASON), CAMERA, VIEWPORT, TREE_ID);
    const broken = quarantinedEdgeViews(quarantinedDoc("cycle"), CAMERA, VIEWPORT, TREE_ID);
    expect(moved[0]!.label).toBe(`${QUARANTINE_LABEL_PREFIX}reparented`);
    expect(broken[0]!.label).toBe(`${QUARANTINE_LABEL_PREFIX}cycle`);
    expect(moved[0]!.label).not.toBe(broken[0]!.label);
  });

  it("differs from a live arrow on three independent axes", () => {
    // TRANSCRIBED FROM canvas-react/src/overlay/Arrows.tsx, which is what
    // draws the live one: ARROW_STROKE '#1a1a1a', DEFAULT_STROKE_WIDTH_PX
    // 1.5, and NO strokeDasharray unless the shape's own `dash` prop says so.
    // Three axes rather than one because a single axis is one theme change
    // away from colliding.
    expect(QUARANTINE_STROKE).not.toBe("#1a1a1a");
    expect(QUARANTINE_STROKE_WIDTH).not.toBe(1.5);
    expect(QUARANTINE_STROKE_DASHARRAY.length).toBeGreaterThan(0);
  });

  it("draws the path canvas-model routes, in screen space", () => {
    // Not a restatement of the drawing code: the expected numbers come from
    // routeArrow + worldToScreen run here, independently.
    const doc = quarantinedDoc();
    const arrow = doc.byId.get(EDGE)!;
    const routed = routeArrow(doc, arrow, doc.bindings);
    const start = worldToScreen(CAMERA, routed.start);
    const end = worldToScreen(CAMERA, routed.end);
    const views = quarantinedEdgeViews(doc, CAMERA, VIEWPORT, TREE_ID);
    expect(views[0]!.path).toBe(`M ${start.x} ${start.y} L ${end.x} ${end.y}`);
  });

  it("follows a node that moved, because it routes rather than remembers", () => {
    const doc = quarantinedDoc();
    const before = quarantinedEdgeViews(doc, CAMERA, VIEWPORT, TREE_ID)[0]!;
    const movedBlocker = { ...doc.byId.get(BLOCKER)!, x: 600 } as Shape;
    const after = quarantinedEdgeViews(
      makeDocument({
        pages: [page()],
        shapes: [doc.byId.get(GOAL)!, movedBlocker, doc.byId.get(EDGE)!],
        bindings: [...doc.bindings],
      }),
      CAMERA,
      VIEWPORT,
      TREE_ID,
    )[0]!;
    expect(after.path).not.toBe(before.path);
  });

  it("puts the label on the drawn path, not at the arrow's stale origin", () => {
    const doc = quarantinedDoc();
    const arrow = doc.byId.get(EDGE)!;
    const routed = routeArrow(doc, arrow, doc.bindings);
    const start = worldToScreen(CAMERA, routed.start);
    const end = worldToScreen(CAMERA, routed.end);
    const view = quarantinedEdgeViews(doc, CAMERA, VIEWPORT, TREE_ID)[0]!;
    expect(view.labelAt).toEqual({ x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 });
  });

  it("draws a BENT edge as the same quadratic the overlay draws, labelled on the curve", () => {
    // The straight case cannot see this branch at all: `routeArrow` only
    // returns a `mid` when the arrow carries a non-zero `bend`, and a
    // midpoint-of-the-endpoints label sits OFF a curve that bulges away from
    // it. B(0.5) of a quadratic is ¼start + ½mid + ¼end, which is on the ink.
    const built = edge();
    const bent = { ...built.shape, props: { ...built.shape.props, bend: 80 } } as Shape;
    const parked = quarantineTreeShape(bent, { reason: "cycle", detail: "d" });
    if (parked.status !== "ok") throw new Error("fixture");
    const doc = makeDocument({
      pages: [page()],
      shapes: [goal(), blocker(), parked.value],
      bindings: [...built.bindings],
    });
    const routed = routeArrow(doc, parked.value, doc.bindings);
    expect(routed.mid).toBeDefined();
    const start = worldToScreen(CAMERA, routed.start);
    const mid = worldToScreen(CAMERA, routed.mid!);
    const end = worldToScreen(CAMERA, routed.end);
    const view = quarantinedEdgeViews(doc, CAMERA, VIEWPORT, TREE_ID)[0]!;
    expect(view.path).toBe(`M ${start.x} ${start.y} Q ${mid.x} ${mid.y} ${end.x} ${end.y}`);
    expect(view.labelAt).toEqual({
      x: 0.25 * start.x + 0.5 * mid.x + 0.25 * end.x,
      y: 0.25 * start.y + 0.5 * mid.y + 0.25 * end.y,
    });
    // And it is genuinely a different point from the straight midpoint — this
    // assertion is what makes the one above more than a restatement.
    expect(view.labelAt).not.toEqual({ x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 });
  });

  it("tracks the camera", () => {
    const doc = quarantinedDoc();
    const zoomed = quarantinedEdgeViews(doc, { x: 10, y: 20, z: 2 }, VIEWPORT, TREE_ID)[0]!;
    const plain = quarantinedEdgeViews(doc, CAMERA, VIEWPORT, TREE_ID)[0]!;
    expect(zoomed.path).not.toBe(plain.path);
  });

  it("ignores a quarantined edge on a page nobody is looking at", () => {
    // Same bug the agent badges had (agents-view.ts's currentPageId note):
    // every page's shapes live in ONE document, so world coordinates from
    // another page land wherever the camera happens to be.
    const doc = quarantinedDoc();
    expect(quarantinedEdgeViews(doc, CAMERA, VIEWPORT, OTHER_PAGE)).toEqual([]);
  });

  it("ignores a shape that merely carries a malformed quarantine record", () => {
    // `absent` and `invalid` are different answers (encoding.ts's decision 1).
    // Drawing a "quarantined" marker from an unreadable record would state a
    // provenance the document does not have.
    const built = edge();
    const bogus = { ...built.shape, meta: { treeQuarantine: { v: 1 } } } as Shape;
    const doc = makeDocument({
      pages: [page()],
      shapes: [goal(), blocker(), bogus],
      bindings: [...built.bindings],
    });
    expect(quarantinedEdgeViews(doc, CAMERA, VIEWPORT, TREE_ID)).toEqual([]);
  });

  it("culls an edge whose whole path is far off screen", () => {
    const doc = quarantinedDoc();
    const far: Camera = { x: -100000, y: -100000, z: 1 };
    expect(quarantinedEdgeViews(doc, far, VIEWPORT, TREE_ID)).toEqual([]);
  });

  it("keeps an edge that spans the viewport with both endpoints off screen", () => {
    // The one failure mode a cull is not allowed to have (canvas-react's
    // Arrows.tsx SOUNDNESS note): under-inclusion. Both nodes sit outside the
    // viewport, above and below it, and the segment crosses it.
    const built = edge();
    const parked = quarantineTreeShape(built.shape, { reason: "cycle", detail: "d" });
    if (parked.status !== "ok") throw new Error("fixture");
    const high = { ...goal(), y: -3000 } as Shape;
    const low = { ...blocker(), y: 3000 } as Shape;
    const doc = makeDocument({
      pages: [page()],
      shapes: [high, low, parked.value],
      bindings: [...built.bindings],
    });
    expect(quarantinedEdgeViews(doc, CAMERA, VIEWPORT, TREE_ID)).toHaveLength(1);
  });

  it("draws every quarantined edge, so accumulation is visible rather than silent", () => {
    // C2's disposal finding, made observable: three moves leave three parked
    // arrows, and this layer refuses to hide that.
    const shapes: Shape[] = [goal(), blocker()];
    const bindings = [];
    for (const id of ["shape:e1", "shape:e2", "shape:e3"]) {
      const built = edge(id);
      const parked = quarantineTreeShape(built.shape, {
        reason: REPARENT_REASON,
        detail: "moved",
      });
      if (parked.status !== "ok") throw new Error("fixture");
      shapes.push(parked.value);
      bindings.push(...built.bindings);
    }
    const doc = makeDocument({ pages: [page()], shapes, bindings });
    expect(quarantinedEdgeViews(doc, CAMERA, VIEWPORT, TREE_ID)).toHaveLength(3);
  });
});
