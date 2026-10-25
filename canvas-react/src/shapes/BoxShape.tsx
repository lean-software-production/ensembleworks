// The registry's fallback component (shapeRegistry.ts's FALLBACK POLICY):
// renders ANY shape kind with no registered component of its own as a
// colored rounded box carrying a text label, so an unregistered kind is
// visible-but-plain rather than invisible. Deliberately minimal — no
// selection outline/handles here (that's D4's overlay, a layer ABOVE the
// shape bodies, not something each body draws for itself).
import type { ShapeBodyProps } from '../shapeRegistry.js'
import { labelOf } from './label.js'

export function BoxShape({ shape, getText }: ShapeBodyProps) {
  return (
    <div
      data-shape-body="box"
      style={{
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        padding: 4,
        fontSize: 12,
        lineHeight: 1.2,
        borderRadius: 8,
        border: '1px solid rgba(0, 0, 0, 0.25)',
        background: 'rgba(120, 170, 255, 0.35)',
      }}
    >
      {labelOf(shape, getText)}
    </div>
  )
}
