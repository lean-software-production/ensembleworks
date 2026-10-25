// Stage 1b rework: floor/reversal and Shift semantics are part of the same
// resize gesture, not merely a monotonic lower-bound check.
import type { Contract, GestureModifiers, GestureOp, Obs, Rng } from '../types.js'

type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
type Modifier = 'plain' | 'shift' | 'alt' | 'shift-alt'
type Route = 'minimum' | 'reverse' | 'ordinary'
const ID = 'shape:resize-gesture', X = 120, Y = 80, W = 720, H = 540
const handles: Record<ResizeHandle, { x: number; y: number; ax: number; ay: number; sx: boolean; sy: boolean }> = {
  nw: { x: X, y: Y, ax: X + W, ay: Y + H, sx: true, sy: true },
  n: { x: X + W / 2, y: Y, ax: X + W / 2, ay: Y + H, sx: false, sy: true },
  ne: { x: X + W, y: Y, ax: X, ay: Y + H, sx: true, sy: true },
  e: { x: X + W, y: Y + H / 2, ax: X, ay: Y + H / 2, sx: true, sy: false },
  se: { x: X + W, y: Y + H, ax: X, ay: Y, sx: true, sy: true },
  s: { x: X + W / 2, y: Y + H, ax: X + W / 2, ay: Y, sx: false, sy: true },
  sw: { x: X, y: Y + H, ax: X + W, ay: Y, sx: true, sy: true },
  w: { x: X, y: Y + H / 2, ax: X + W, ay: Y + H / 2, sx: true, sy: false },
}
const near = (actual: unknown, expected: number) => typeof actual === 'number' && Math.abs(actual - expected) < 1e-6

function resizeContract(name: string, kind: 'artifact' | 'bbthread' | 'geo' | 'text' | 'image', handle: ResizeHandle, modifier: Modifier, route: Route): Contract {
  const h = handles[handle]
  const uniform = h.sx && h.sy && (modifier === 'shift' || modifier === 'shift-alt')
  const modifiers: GestureModifiers = { shift: modifier === 'shift' || modifier === 'shift-alt', alt: modifier === 'alt' || modifier === 'shift-alt' }
  const requested = route === 'minimum' ? 0.1 : 0.5
  const minW = kind === 'artifact' ? 320 : 1, minH = kind === 'artifact' ? 200 : 1
  const factorX = h.sx ? Math.max(requested, minW / W) : 1
  const factorY = h.sy ? Math.max(requested, minH / H) : 1
  const sx = uniform ? Math.max(factorX, factorY) : factorX
  const sy = uniform ? sx : factorY
  const expected = { w: W * sx, h: H * sy, x: h.ax + (X - h.ax) * sx, y: h.ay + (Y - h.ay) * sy }
  return {
    name, level: 'fsm', tool: 'select+transform', when: 'at-end',
    scene: () => [{ id: ID, kind, x: X, y: Y, w: W, h: H,
      props: kind === 'artifact' ? { schemaVersion: 1, source: 'thread-storage', threadId: 'thr_fixture', path: 'reports/fixture.html', title: '' } : {},
    }],
    gesture: (rng: Rng): GestureOp[] => {
      const at = (ratio: number) => ({ ref: 'point' as const, x: h.ax + (h.x - h.ax) * ratio, y: h.ay + (h.y - h.ay) * ratio })
      // Plain / Alt keep the existing opposite-anchor policy. Shift is
      // captured at pointerdown and affects corners only, not edge handles.
      const ratios = route === 'minimum' ? [0.1]
        : route === 'ordinary' ? [0.8, 0.65, 0.5]
        // Repeated floor crossings, reversal, zero and through-anchor return.
        : [0.1, 0.5, 0.05, 0, -0.1, 0.1, 0.5]
      return [
        // This point also selects bbthread's solid pane (not its workspace).
        { kind: 'down', at: { ref: 'point', x: 800, y: 300 } }, { kind: 'up' },
        { kind: 'down', at: { ref: 'point', x: h.x, y: h.y }, modifiers },
        ...ratios.map(ratio => ({ kind: 'move' as const, at: at(ratio), steps: 1 + Math.floor(rng.next() * 3), modifiers })),
        { kind: 'up', modifiers },
      ]
    },
    check: (obs: Obs) => {
      const w = obs.shapeProp(ID, 'w'), ht = obs.shapeProp(ID, 'h')
      if (!near(w, expected.w) || !near(ht, expected.h)) {
        return `${name}: stored size ${w}x${ht}; expected ${expected.w}x${expected.h}`
      }
      const pos = obs.shapePosition(ID)
      return pos && near(pos.x, expected.x) && near(pos.y, expected.y) ? null
        : `${name}: position ${JSON.stringify(pos)}; expected fixed-anchor origin ${expected.x},${expected.y}`
    },
  }
}

// Exact review reproductions, including the original no-anchor-crossing path.
export const artifactResizeFloorThenReturn: Contract = {
  ...resizeContract('artifact-resize-floor-then-return', 'artifact', 'se', 'plain', 'reverse'),
  gesture: () => [
    { kind: 'down', at: { ref: 'point', x: 800, y: 300 } }, { kind: 'up' },
    { kind: 'down', at: { ref: 'point', x: 840, y: 620 } },
    { kind: 'move', at: { ref: 'point', x: 192, y: 134 }, steps: 1 },
    { kind: 'move', at: { ref: 'point', x: 480, y: 350 }, steps: 1 }, { kind: 'up' },
  ],
}
export const artifactShiftResizePreservesRatio = resizeContract('artifact-shift-resize-preserves-ratio', 'artifact', 'se', 'shift', 'minimum')
export const artifactShiftMixedSelectionPreservesRatio: Contract = {
  name: 'artifact-shift-mixed-selection-preserves-ratio', level: 'fsm', tool: 'select+transform', when: 'at-end',
  scene: () => [
    { id: ID, kind: 'artifact', x: X, y: Y, w: W, h: H, props: { schemaVersion: 1, source: 'thread-storage', threadId: 'thr_fixture', path: 'reports/fixture.html', title: '' } },
    { id: 'shape:resize-peer', kind: 'geo', x: 900, y: Y, w: 200, h: 100 },
  ],
  gesture: () => [
    { kind: 'down', at: { ref: 'point', x: 400, y: 300 } }, { kind: 'up' },
    { kind: 'down', at: { ref: 'point', x: 1000, y: 130 }, modifiers: { shift: true } }, { kind: 'up', modifiers: { shift: true } },
    { kind: 'down', at: { ref: 'point', x: 1100, y: 620 }, modifiers: { shift: true } },
    { kind: 'move', at: { ref: 'point', x: 218, y: 134 }, steps: 1, modifiers: { shift: true } },
    { kind: 'up', modifiers: { shift: true } },
  ],
  check: obs => {
    const factor = 320 / W
    for (const [id, w, h, x] of [[ID, W, H, X], ['shape:resize-peer', 200, 100, 900]] as const) {
      const actualW = obs.shapeProp(id, 'w'), actualH = obs.shapeProp(id, 'h'), pos = obs.shapePosition(id)
      if (!near(actualW, w * factor) || !near(actualH, h * factor) || !pos || !near(pos.x, X + (x - X) * factor) || !near(pos.y, Y)) {
        return `Shift mixed selection must use one floor-constrained factor: ${id} is ${actualW}x${actualH} at ${JSON.stringify(pos)}, expected ${w * factor}x${h * factor} at ${X + (x - X) * factor},${Y}`
      }
    }
    return null
  },
}
export const ARTIFACT_RESIZE_REWORK_CONTRACTS: readonly Contract[] = [artifactResizeFloorThenReturn, artifactShiftResizePreservesRatio, artifactShiftMixedSelectionPreservesRatio]

// All eight handles × all Shift/Alt combinations × minimum and repeated
// crossing/reversal paths. Registered shared declarations, not ad-hoc probes.
export const ARTIFACT_RESIZE_AUDIT_CONTRACTS: readonly Contract[] = (Object.keys(handles) as ResizeHandle[]).flatMap(handle =>
  (['plain', 'shift', 'alt', 'shift-alt'] as const).flatMap(modifier =>
    (['minimum', 'reverse'] as const).map(route => resizeContract(`artifact-resize-audit-${handle}-${modifier}-${route}`, 'artifact', handle, modifier, route)),
  ),
)
// Other kinds retain ordinary handle/modifier/anchor behavior. Their 1-unit
// floor/crossing semantics are audited in additional unit cases, not changed
// by giving them artifact's minimum.
export const RESIZE_KIND_PARITY_CONTRACTS: readonly Contract[] = (['bbthread', 'geo', 'text', 'image'] as const).flatMap(kind =>
  (Object.keys(handles) as ResizeHandle[]).flatMap(handle =>
    (['plain', 'shift', 'alt', 'shift-alt'] as const).map(modifier => resizeContract(`resize-parity-${kind}-${handle}-${modifier}`, kind, handle, modifier, 'ordinary')),
  ),
)
