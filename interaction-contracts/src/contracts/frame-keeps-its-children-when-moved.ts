// frame-membership task — the guard-rail half of drag-into/drag-out: moving a
// FRAME is not a membership event for the shapes inside it. Dragging a frame
// carries its children along (they are its children; their world position
// follows its transform), and the drop-target pass that runs on pointerup
// must not reconsider them — neither releasing them to the page (they never
// left the frame; the frame moved WITH them) nor, in a nested scene, handing
// them to whatever the frame was dropped on.
//
// The frame is grabbed by its left BORDER band (canvas-model's
// FRAME_EDGE_MARGIN), not its interior: a frame's interior is hollow
// (frame-interior-is-hollow), so an interior grab would start a marquee and
// move nothing at all — this contract would then pass for entirely the wrong
// reason. The explicit frame-displacement assertion below is what keeps that
// honest: it fails loudly if the frame never moved.
//
// RED (unreachable — reported, not forced): against the unfixed tree this
// contract is GREEN by construction, because NO drag ever reparented anything
// there. It is a regression guard on the code this task ADDS, so its teeth
// were verified the other way round, against the FIXED tree: widening
// tools/select.ts's `dropTargetIntents` from the DRAGGED ids to every shape
// on the page (the obvious wrong turn — "re-settle membership for everything"
// instead of "for what was dropped") makes it fail with, verbatim:
//   moving frame "shape:frame" changed its child "shape:child"'s parent to
//   "page:p" -- a frame dragged with its children keeps them
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const FRAME_ID = 'shape:frame'
const CHILD_ID = 'shape:child'

export const frameKeepsItsChildrenWhenMoved: Contract = {
  name: 'frame-keeps-its-children-when-moved',
  level: 'fsm',
  tool: 'select',
  when: 'at-end',
  scene: () => [
    { id: FRAME_ID, kind: 'frame', x: 0, y: 0, w: 400, h: 400 },
    { id: CHILD_ID, kind: 'geo', parentId: FRAME_ID, x: 100, y: 100, w: 100, h: 100 },
  ],
  gesture: (_rng: Rng): GestureOp[] => [
    // (2, 200): inside the frame's left border band, NOT its hollow interior.
    { kind: 'down', at: { ref: 'point', x: 2, y: 200 } },
    { kind: 'move', at: { ref: 'point', x: 302, y: 500 }, steps: 6 },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null => {
    const moved = obs.shapeDisplacement(FRAME_ID)
    if (moved.dx !== 300 || moved.dy !== 300) {
      return `expected the frame ${JSON.stringify(FRAME_ID)} itself to move by (300, 300) when dragged by its border band, got ${JSON.stringify(moved)} -- if it did not move, this contract's membership assertion below proves nothing`
    }
    const parent = obs.shapeParent(CHILD_ID)
    if (parent !== FRAME_ID) {
      return `moving frame ${JSON.stringify(FRAME_ID)} changed its child ${JSON.stringify(CHILD_ID)}'s parent to ${JSON.stringify(parent)} -- a frame dragged with its children keeps them`
    }
    return null
  },
}
