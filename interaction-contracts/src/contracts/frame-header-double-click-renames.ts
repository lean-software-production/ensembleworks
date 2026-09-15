// frame-interaction task, gaps 1/2 — tldraw parity: double-clicking a
// frame's HEADER label opens an inline rename input (FrameLabelInput.tsx).
// canvas-model's isPointInFrameHeaderBand + shapeHitIndexBounds make the
// header a real hit target, and select.ts's double-click gate now fires
// BeginEdit for a header hit even though a frame is never TEXT-CAPABLE.
// This contract proves the TRIGGER: double-clicking the header begins
// editing the frame.
//
// RED (recorded verbatim in the task report before the fix landed): the
// header sat entirely outside the frame's indexed bounds AND outside
// hitTestPoint's hit region, so the first click's pointerdown resolved to
// `hit === null` (empty canvas) -- the gesture never even reached the
// double-click bookkeeping, and editingShape() stayed null throughout.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const FRAME_ID = 'shape:frame'

export const frameHeaderDoubleClickRenames: Contract = {
  name: 'frame-header-double-click-renames',
  level: 'fsm',
  when: 'at-end',
  scene: () => [
    { id: FRAME_ID, kind: 'frame', x: 0, y: 0, w: 300, h: 300 },
  ],
  gesture: (_rng: Rng): GestureOp[] => [
    // Header band: local y in [-24,0), local x in [0,300] -- world (150,-12).
    { kind: 'down', at: { ref: 'point', x: 150, y: -12 } },
    { kind: 'up' },
    { kind: 'down', at: { ref: 'point', x: 150, y: -12 } },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null => {
    if (obs.editingShape() !== FRAME_ID) {
      return `double-clicking the frame's header band did not begin editing it (editingShape: ${JSON.stringify(obs.editingShape())}, expected ${JSON.stringify(FRAME_ID)})`
    }
    return null
  },
}
