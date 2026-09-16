// frame-membership task, second half (reported from live dogfooding of the
// first half) — drawing a NEW shape inside an existing frame makes it that
// frame's child. Creation-time capture used to run in one direction only: a
// frame drawn AROUND existing shapes adopted them (create.ts's
// `frameCaptureIntents`), but a shape drawn INSIDE an existing frame was
// parented to the page, so it sat visually inside the frame while belonging to
// nothing — move the frame and it stayed behind.
//
// Same membership rule as the drop path (drag-into-frame-reparents): the
// DEEPEST frame-like shape whose membership region contains the new shape's
// world-bounds centre. Both callers read it from the one shared module,
// tools/frame-membership.ts, so creation and dropping can never drift apart —
// which is also why this contract does not re-pin the bbthread
// workspace/pane split (bbthread-pane-region-does-not-capture already pins
// that rule, for the same code).
//
// Drives the CREATE tool, via the `create:<kind>` seam this task added to the
// FSM runner. Every create-tool contract before it is level:'browser' purely
// because that seam did not exist — not because creation is unobservable here.
//
// RED (recorded verbatim in the PR body, run against the unfixed tree):
//   contract 'shape-created-inside-a-frame-joins-it' violated at seed 1: a geo
//   drawn entirely inside frame "shape:frame" was parented to "page:p" -- a
//   shape created inside a frame must join it
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const FRAME_ID = 'shape:frame'

export const shapeCreatedInsideAFrameJoinsIt: Contract = {
  name: 'shape-created-inside-a-frame-joins-it',
  level: 'fsm',
  tool: 'create:geo',
  when: 'at-end',
  scene: () => [{ id: FRAME_ID, kind: 'frame', x: 0, y: 0, w: 400, h: 400 }],
  gesture: (_rng: Rng): GestureOp[] => [
    // Drag-to-size a geo from (100,100) to (300,300) — a box drawn wholly
    // within the frame, centre (200,200), i.e. the frame's own centre.
    { kind: 'down', at: { ref: 'point', x: 100, y: 100 } },
    { kind: 'move', at: { ref: 'point', x: 300, y: 300 }, steps: 4 },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null => {
    // The created shape's id is minted at gesture time (create.ts's `makeId`),
    // so it cannot be named up front — it is discovered through the create
    // tool's own auto-selection, the same route
    // armed-style-applies-to-created-shape takes.
    const selected = obs.selectedShapeIds()
    if (selected.length !== 1) {
      return `expected the create tool to auto-select exactly the shape it just created, got ${JSON.stringify(selected)}`
    }
    const created = selected[0]!
    const parent = obs.shapeParent(created)
    if (parent !== FRAME_ID) {
      return `a geo drawn entirely inside frame ${JSON.stringify(FRAME_ID)} was parented to ${JSON.stringify(parent)} -- a shape created inside a frame must join it`
    }
    return null
  },
}
