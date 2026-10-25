// Pilot 4 extension — no TRANSFORM while typing. Sibling of no-drag-while-
// typing: same modality invariant (editingShape() !== null => that shape is
// never transformed), different gesture — double-click to edit, then grab a
// resize HANDLE and drag it. tool: 'select+transform' so the runner builds the
// SAME composite the client ships (createSelectAndTransformTool), which gives
// transform.ts first crack at the handle-grab pointerdown. See the plan's
// Phase E extension for the handle-addressing derivation (SE corner of a
// 200x200 geo at world (0,0) is screen (200,200) at the identity camera).
// SCENE KIND: 'geo', not 'note' (ratified 2026-07-16) — a note's rendered
// size comes from geometry.ts's fixed 200*scale formula, which IGNORES
// props.w/h, while ResizeShapes mutates ONLY props.w/h, so a note scene can
// never observe a size delta; geo reads props.w/h directly. geo is equally
// text-capable (isTextCapableKind), so the double-click-to-edit leg is
// unchanged.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const ID = 'shape:edit-transform'

export const noTransformWhileTyping: Contract = {
  name: 'no-transform-while-typing',
  level: 'fsm',
  tool: 'select+transform',
  when: 'every-event',
  scene: () => [{ id: ID, kind: 'geo', x: 0, y: 0, w: 200, h: 200 }],
  gesture: (_rng: Rng): GestureOp[] => [
    // seed-invariant by construction (ignores rng): a fixed double-click-then-
    // grab-SE-handle sequence; running it across library.test.ts's seed set is
    // redundant but harmless. Two clicks at the shape centre -> BeginEdit (the
    // shape is now selected AND editingId). Then grab the SE corner handle
    // (centre + half-extent = screen (200,200), within HIT_TOLERANCE_PX) and
    // drag it outward to resize.
    { kind: 'down', at: { ref: 'shape', id: ID } }, { kind: 'up' },
    { kind: 'down', at: { ref: 'shape', id: ID } }, { kind: 'up' },
    { kind: 'down', at: { ref: 'shape', id: ID, dx: 100, dy: 100 } },
    { kind: 'move', at: { ref: 'shape', id: ID, dx: 160, dy: 160 }, steps: 4 },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null => {
    if (obs.editingShape() !== ID) return null
    const d = obs.shapeDisplacement(ID)
    const s = obs.shapeSizeDelta(ID)
    return d.dx === 0 && d.dy === 0 && s.dw === 0 && s.dh === 0
      ? null
      : `shape transformed while being edited (displacement ${JSON.stringify(d)}, size delta ${JSON.stringify(s)}); editing must be modal`
  },
}
