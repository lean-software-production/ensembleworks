// Pilot 2 — the cursor-lock contract. While dragging, the shape stays locked
// to the cursor: its total world displacement equals the cursor's total world
// displacement (exactly when nothing snaps; within the snap radius when it
// does). The seeded generator is the point — one declaration is a fixed CI
// case at low seeds AND a fuzz campaign when run wide.
//
// NOTE: the plan's sketch imported a `snapCandidatesThreshold` constant from
// this module "if exposed; else compute in-runner". canvas-model's
// snapping.ts does not export its threshold constant (SNAP_THRESHOLD_K is
// module-private) — per the implementer note below the sketch, that import
// is dropped and the contract relies solely on `obs.snapRadius()` (Task C1,
// implemented by the FSM runner as `medianSize(doc.shapes) * 0.05`, matching
// snapping.ts's actual un-exported threshold — see fsm-runner.ts's
// snapRadius() comment for why this is 0.05, not the plan's literal "/5").
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const SHAPE_ID = 'shape:drag'

export const cursorLock: Contract = {
  name: 'drag-cursor-lock',
  level: 'fsm',
  when: 'every-event',
  scene: () => [
    // A 100x100 shape at the origin, plus a second shape whose left edge lands
    // near a snap line so the drag repeatedly enters/exits the snap band (the
    // audit's edge-at-0 / target-line / radius-5 repro).
    { id: SHAPE_ID, kind: 'geo', x: 0, y: 0, w: 100, h: 100 },
    { id: 'shape:snap-target', kind: 'geo', x: 3, y: 400, w: 100, h: 100 },
  ],
  gesture: (rng: Rng): GestureOp[] => {
    const ops: GestureOp[] = [{ kind: 'down', at: { ref: 'shape', id: SHAPE_ID } }]
    // A seeded walk of 8 pointer jumps, each a few px past the drag threshold,
    // wandering across the snap band so accumulated snap offsets (old bug) show.
    let x = 50, y = 50
    for (let i = 0; i < 8; i++) {
      x += Math.round((rng.next() - 0.5) * 40)
      y += Math.round((rng.next() - 0.5) * 40)
      ops.push({ kind: 'move', at: { ref: 'point', x: 50 + x, y: 50 + y }, steps: 2 })
    }
    ops.push({ kind: 'up' })
    return ops
  },
  check: (obs: Obs): string | null => {
    const s = obs.shapeDisplacement(SHAPE_ID)
    const c = obs.cursorWorldDisplacement()
    const err = Math.hypot(s.dx - c.dx, s.dy - c.dy)
    const tol = obs.snapRadius() + 1e-6 // snapped: within one snap radius
    return err <= tol
      ? null
      : `shape drifted from cursor by ${err.toFixed(3)} world units (> snap radius ${obs.snapRadius()}): shapeΔ=${JSON.stringify(s)} cursorΔ=${JSON.stringify(c)}`
  },
}
