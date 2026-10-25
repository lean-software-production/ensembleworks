// frame-membership task — for a `bbthread`, membership is by the WORKSPACE
// region (canvas-model's bbthreadWorkspaceLocalBounds, the left
// `1 - paneFraction` of the body), NOT the whole shape. The right-hand thread
// pane is a solid, host-rendered timeline that a canvas shape can never live
// "inside": a shape dropped over it is sitting ON the pane, not IN the
// workspace, so it must stay where it was rather than silently becoming a
// child whose body the pane then paints over.
//
// The complementary half (a drop into the WORKSPACE does capture) is covered
// by drag-into-frame-reparents' frame case plus this shape's own
// bbthread-workspace-is-hollow; what only this contract can catch is a
// membership test written against `localBounds` (the whole box) instead of
// the workspace rect — the single most likely way to get bbthread wrong,
// since every other frame-like branch in the model keys off `isFrameLike`
// alone.
//
// RED (unreachable against the UNFIXED tree — reported, not forced: nothing
// reparented there at all, so this passed vacuously). Teeth verified against
// the FIXED tree instead, with a deliberately pane-blind membership test —
// `localBounds` in place of `bbthreadWorkspaceLocalBounds` in
// tools/select.ts's `membershipLocalBounds`, i.e. exactly the mistake of
// treating a bbthread like any other frame — which fails with, verbatim:
//   dropping "shape:loose" over the bbthread's THREAD PANE reparented it to
//   "shape:bbthread" -- only the bbthread's WORKSPACE region captures
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const BBTHREAD_ID = 'shape:bbthread'
const LOOSE_ID = 'shape:loose'

export const bbthreadPaneRegionDoesNotCapture: Contract = {
  name: 'bbthread-pane-region-does-not-capture',
  level: 'fsm',
  tool: 'select',
  when: 'at-end',
  scene: () => [
    // 900 wide at the default 1/3 pane fraction: workspace x in [0, 600),
    // pane x in [600, 900].
    { id: BBTHREAD_ID, kind: 'bbthread', x: 0, y: 0, w: 900, h: 600 },
    { id: LOOSE_ID, kind: 'geo', x: 1200, y: 100, w: 100, h: 100 },
  ],
  gesture: (_rng: Rng): GestureOp[] => [
    { kind: 'down', at: { ref: 'shape', id: LOOSE_ID } },
    // Centre lands at world (750, 300): deep inside the PANE (150 world units
    // clear of its left edge at x=600), nowhere near the workspace.
    { kind: 'move', at: { ref: 'shape', id: LOOSE_ID, dx: -500, dy: 150 }, steps: 6 },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null => {
    const parent = obs.shapeParent(LOOSE_ID)
    if (parent === BBTHREAD_ID) {
      return `dropping ${JSON.stringify(LOOSE_ID)} over the bbthread's THREAD PANE reparented it to ${JSON.stringify(parent)} -- only the bbthread's WORKSPACE region captures`
    }
    if (parent === null || !parent.startsWith('page:')) {
      return `dropping ${JSON.stringify(LOOSE_ID)} over the bbthread's THREAD PANE left it parented to ${JSON.stringify(parent)}, expected the page`
    }
    return null
  },
}
