// frame-membership task (docs/plans/2026-09-15-bb-thread-frame.md's
// "Membership", which deferred exactly this) — dragging a page-level shape
// with the select tool so that it comes to rest inside a frame makes it that
// frame's CHILD, not merely a shape that overlaps it. tldraw parity: a drop
// onto a frame reparents.
//
// Why `shapeParent` and not `shapeDisplacement`: membership is a change to
// the shape TREE, which no pre-existing observation can see — and
// shapeDisplacement actively LIES here, because it reads raw LOCAL x/y and a
// reparent rewrites the shape's frame of reference (see Obs.shapeParent's own
// doc comment in types.ts).
//
// FSM-level: the drop-target decision lives entirely inside the select tool's
// own FSM (tools/select.ts's `onDragging` pointerup branch) plus the editor's
// ReparentShapes handler — no renderer or DOM plumbing is exercised.
//
// RED (recorded verbatim in the PR body, run against the unfixed tree):
//   contract 'drag-into-frame-reparents' violated at seed 1: dropping
//   "shape:loose" with its centre inside frame "shape:frame" left it parented
//   to "page:p" -- a drag INTO a frame must reparent the dropped shape to
//   that frame
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const FRAME_ID = 'shape:frame'
const LOOSE_ID = 'shape:loose'

export const dragIntoFrameReparents: Contract = {
  name: 'drag-into-frame-reparents',
  level: 'fsm',
  tool: 'select',
  when: 'at-end',
  scene: () => [
    { id: FRAME_ID, kind: 'frame', x: 0, y: 0, w: 400, h: 400 },
    // Parked well clear of the frame so the gesture's START is unambiguously
    // a page-level grab (and its pointerdown can only hit the geo).
    { id: LOOSE_ID, kind: 'geo', x: 600, y: 100, w: 100, h: 100 },
  ],
  gesture: (_rng: Rng): GestureOp[] => [
    // Grab the loose shape dead-centre (world (650, 150) — the camera is
    // identity in both runners' seeded scenes, so world == screen here) and
    // drop it so its centre lands at the frame's centre (200, 200), deep
    // inside the frame's own bounds however a snap nudges the final delta.
    { kind: 'down', at: { ref: 'shape', id: LOOSE_ID } },
    { kind: 'move', at: { ref: 'shape', id: LOOSE_ID, dx: -450, dy: 50 }, steps: 6 },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null => {
    const parent = obs.shapeParent(LOOSE_ID)
    if (parent !== FRAME_ID) {
      return `dropping ${JSON.stringify(LOOSE_ID)} with its centre inside frame ${JSON.stringify(FRAME_ID)} left it parented to ${JSON.stringify(parent)} -- a drag INTO a frame must reparent the dropped shape to that frame`
    }
    return null
  },
}
