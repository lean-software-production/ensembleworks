// frame-membership task — the mirror of drag-into-frame-reparents: dragging a
// frame's CHILD out of that frame releases it back to the page. Without this
// half, membership would be a one-way trapdoor — a shape could enter a frame
// and then follow it around the canvas forever, however far away the user
// dragged it.
//
// Seeded via SceneShape.parentId (this task's vocabulary extension): the
// starting state — a shape that is ALREADY a frame's child — is not reachable
// from any gesture this runner can play (creation-time capture needs a frame
// DRAWN around existing shapes, a different gesture at different
// coordinates), so the scene has to express it directly.
//
// The page assertion is by `page:` PREFIX, not a literal id: the two runners
// name their page differently (see Obs.shapeParent's doc comment).
//
// RED (recorded verbatim in the PR body, run against the unfixed tree):
//   contract 'drag-out-of-frame-releases-to-page' violated at seed 1:
//   dragging "shape:child" far outside its frame left it parented to
//   "shape:frame" -- a shape dragged OUT of a frame must be released to the
//   page
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const FRAME_ID = 'shape:frame'
const CHILD_ID = 'shape:child'

export const dragOutOfFrameReleasesToPage: Contract = {
  name: 'drag-out-of-frame-releases-to-page',
  level: 'fsm',
  tool: 'select',
  when: 'at-end',
  scene: () => [
    { id: FRAME_ID, kind: 'frame', x: 0, y: 0, w: 400, h: 400 },
    // parentId => x/y are the FRAME's local coordinates: world centre (150, 150).
    { id: CHILD_ID, kind: 'geo', parentId: FRAME_ID, x: 100, y: 100, w: 100, h: 100 },
  ],
  gesture: (_rng: Rng): GestureOp[] => [
    { kind: 'down', at: { ref: 'shape', id: CHILD_ID } },
    // Land the child's centre at world (800, 600) — clear of the frame's
    // 400x400 box by a margin no snap adjustment can close.
    { kind: 'move', at: { ref: 'shape', id: CHILD_ID, dx: 650, dy: 450 }, steps: 6 },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null => {
    const parent = obs.shapeParent(CHILD_ID)
    if (parent === null || !parent.startsWith('page:')) {
      return `dragging ${JSON.stringify(CHILD_ID)} far outside its frame left it parented to ${JSON.stringify(parent)} -- a shape dragged OUT of a frame must be released to the page`
    }
    return null
  },
}
