// ============================================================================
// FRAME MEMBERSHIP — the ONE rule deciding which frame-like shape a shape
// belongs to, shared by the two moments that can change membership:
//
//   * DROPPING  — select.ts's `dropTargetIntents`, on the pointerup that ends
//     a translate (drag a shape into a frame, or out of one);
//   * CREATING  — create.ts's `finalizeIntents`, on the pointerup that ends a
//     create gesture (draw a new shape inside a frame).
//
// Both read this module rather than each re-deriving the test. That is
// load-bearing, not tidiness: the two were separately plausible places to
// write "is it inside the frame?", and a bbthread whose pane captured on
// creation but not on drop (or vice versa) would be a genuinely confusing
// canvas. The frame-membership task's contracts pin the rule once, for both
// callers, for the same reason.
//
// CENTRE, NOT FULL CONTAINMENT (a deliberate choice, argued rather than
// inherited): a shape belongs to the frame whose membership region contains
// that shape's world-bounds CENTRE. Full containment reads stricter but
// behaves worse in the two cases users actually hit — a shape LARGER than the
// frame (or one deliberately hung off a frame's edge) can never be dropped in
// at all, and the failure mode is silent. tldraw itself resolves the drop
// target from a POINT too (its DragAndDropManager tests the pointer's page
// point); the centre is that same point-shaped rule, made per-shape so a
// multi-shape selection straddling two frames lands each shape where it
// visibly sits rather than sending all of them wherever the cursor happened
// to be.
//
// DEEPEST WINS: frames nest, so the target is the deepest candidate
// containing the centre — dropping into a frame inside a frame means the
// inner one. Ties (two overlapping SIBLING frames) break on the fractional
// `index`, i.e. the one painted on top, which is the one the user sees
// themselves dropping onto.
// ============================================================================
import {
  bbthreadWorkspaceLocalBounds,
  centroid,
  isFrameLike,
  localBounds,
  pageIdOf,
  toLocalPoint,
  worldBounds,
  type Bounds,
  type CanvasDocument,
  type Point,
  type Shape,
} from '@ensembleworks/canvas-model'

/** The region of a frame-like shape that CAPTURES a shape, in that shape's own
 * local frame. For an ordinary frame that is its whole body; for a `bbthread`
 * it is only the hollow WORKSPACE (`bbthreadWorkspaceLocalBounds`) — the
 * right-hand thread pane is a solid, host-rendered timeline, and a shape
 * sitting over it is ON the pane, not IN the workspace, so capturing it there
 * would produce a child the pane immediately paints over. Keyed off the kind
 * the same way hitTestPoint's own bbthread branch is, so the two can't
 * disagree about where the pane starts. */
export function membershipLocalBounds(frame: Shape): Bounds {
  return frame.kind === 'bbthread' ? bbthreadWorkspaceLocalBounds(frame) : localBounds(frame)
}

/** Inclusive point-in-rect, matching the rest of the tools' hit tests. */
function boundsContain(b: Bounds, p: Point): boolean {
  return p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY
}

/** How many ancestors `shape` has — the "deepest wins" ordering key.
 * Visited-set-guarded so a malformed pre-existing cycle terminates instead of
 * hanging, the same discipline as geometry.ts's worldTransform and editor.ts's
 * canReparent. */
export function treeDepth(doc: CanvasDocument, shape: Shape): number {
  const visited = new Set<string>([shape.id])
  let depth = 0
  let parent = doc.byId.get(shape.parentId)
  while (parent && !visited.has(parent.id)) {
    visited.add(parent.id)
    depth++
    parent = doc.byId.get(parent.parentId)
  }
  return depth
}

/** Every frame-like shape on `pageId` that is eligible to capture, minus
 * `excluded`. For a DROP that exclusion set is the drag's own `excludedIds`
 * (the moving shapes, their descendants, and everything off-page), which is
 * what keeps a dragged frame from being offered itself or its own children.
 * For a CREATE it is the just-made shape itself — a new frame must not adopt
 * itself. */
export function frameCandidates(doc: CanvasDocument, excluded: ReadonlySet<string>, pageId: string): Shape[] {
  return doc.shapes.filter((s) => isFrameLike(s.kind) && !excluded.has(s.id) && pageIdOf(doc, s) === pageId)
}

/** The frame-like shape `subject` belongs in, or null for "the page". */
export function frameFor(doc: CanvasDocument, subject: Shape, candidates: readonly Shape[]): Shape | null {
  const centre = centroid(worldBounds(doc, subject))
  return frameAtPoint(doc, centre, candidates)
}

/** The frame-like shape a WORLD point falls in, or null — `frameFor`'s
 * point-taking half, for a caller that has the point but not (yet) a shape:
 * create.ts resolves a to-be-created shape's home from the centre of the box
 * it is about to mint, BEFORE minting it, so the shape can be born with the
 * right parent and a z-index computed among the right siblings. */
export function frameAtPoint(doc: CanvasDocument, centre: Point, candidates: readonly Shape[]): Shape | null {
  let best: Shape | null = null
  let bestDepth = -1
  for (const frame of candidates) {
    if (!boundsContain(membershipLocalBounds(frame), toLocalPoint(doc, frame, centre))) continue
    const depth = treeDepth(doc, frame)
    if (depth > bestDepth || (best !== null && depth === bestDepth && frame.index > best.index)) {
      best = frame
      bestDepth = depth
    }
  }
  return best
}
