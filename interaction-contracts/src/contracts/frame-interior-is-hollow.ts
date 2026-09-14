// frame-interaction task, gaps 3/5 — tldraw parity: a frame's interior is
// HOLLOW (FrameShapeUtil.tsx marks the body `isFilled: false`, so a
// pointerdown deep inside an empty frame hits nothing and starts a marquee
// instead of dragging the whole frame). canvas-model's hitTestPoint now
// special-cases 'frame' the same way (header band + border margin hit,
// hollow interior miss) — this contract proves the SELECT TOOL actually
// routes a deep-interior drag to marquee, not translate: the frame itself
// must not move.
//
// RED (recorded verbatim in the task report before the fix landed):
// "shape drifted" is the WRONG failure shape here — the pre-fix hit test
// treated the frame's interior as solid, so hitTestTopmost returned the
// frame id at (150,150), select.ts's Pointing->Dragging transition fired a
// TranslateShapes, and the frame's displacement equalled the drag delta
// instead of staying zero.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const FRAME_ID = 'shape:frame'

export const frameInteriorIsHollow: Contract = {
  name: 'frame-interior-is-hollow',
  level: 'fsm',
  when: 'at-end',
  scene: () => [
    // A 300x300 frame at the origin -- (150,150) is its dead center, well
    // clear of FRAME_EDGE_MARGIN (8) from every border.
    { id: FRAME_ID, kind: 'frame', x: 0, y: 0, w: 300, h: 300 },
  ],
  gesture: (_rng: Rng): GestureOp[] => [
    { kind: 'down', at: { ref: 'point', x: 150, y: 150 } },
    { kind: 'move', at: { ref: 'point', x: 250, y: 250 }, steps: 4 },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null => {
    const d = obs.shapeDisplacement(FRAME_ID)
    if (d.dx !== 0 || d.dy !== 0) {
      return `a drag started deep inside the frame's empty interior moved the frame itself (Δ=${JSON.stringify(d)}) -- the interior must be hollow, routing this gesture to a marquee instead of a translate`
    }
    return null
  },
}
