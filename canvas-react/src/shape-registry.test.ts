// Run: bun src/shape-registry.test.ts
// Proves the C5 integration (note/frame/text/geo) plus Task R1's draw
// addition, plus the LINE sub-cycle's own R1 addition: after
// registerCoreShapes(), each of the six core kinds
// (note/frame/text/geo/draw/line) resolves to its own dedicated body — NOT
// the generic BoxShape fallback (shapeRegistry.ts's FALLBACK POLICY) —
// while kinds this unit does NOT register (group/arrow — arrows are drawn
// by the SVG overlay, not a shape body) still correctly fall back to
// BoxShape, unchanged.
import assert from 'node:assert/strict'
import { lookupShapeComponent } from './shapeRegistry.js'
import { BoxShape } from './shapes/BoxShape.js'
import { NoteShape } from './shapes/NoteShape.js'
import { FrameShape } from './shapes/FrameShape.js'
import { TextShape } from './shapes/TextShape.js'
import { GeoShape } from './shapes/GeoShape.js'
import { DrawShape } from './shapes/DrawShape.js'
import { LineShape } from './shapes/LineShape.js'
import { registerCoreShapes } from './shapes/registerCoreShapes.js'

// Before registerCoreShapes() runs, the six core kinds are unregistered —
// same FALLBACK POLICY as any other kind — so they resolve to BoxShape.
for (const kind of ['note', 'frame', 'text', 'geo', 'draw', 'line']) {
  assert.equal(lookupShapeComponent(kind), BoxShape, `${kind} should fall back to BoxShape before registerCoreShapes()`)
}
console.log('ok: shape-registry — note/frame/text/geo/draw/line fall back to BoxShape before registerCoreShapes()')

registerCoreShapes()

const expected: Record<string, unknown> = { note: NoteShape, frame: FrameShape, text: TextShape, geo: GeoShape, draw: DrawShape, line: LineShape }
for (const [kind, component] of Object.entries(expected)) {
  const resolved = lookupShapeComponent(kind)
  assert.equal(resolved, component, `${kind} should resolve to its dedicated body after registerCoreShapes()`)
  assert.notEqual(resolved, BoxShape, `${kind} must NOT fall back to BoxShape after registerCoreShapes()`)
}
console.log('ok: shape-registry — registerCoreShapes() resolves note/frame/text/geo/draw/line to their own dedicated bodies (no core kind hits BoxShape)')

// Idempotent — a second call is a no-op, same components still resolve.
registerCoreShapes()
for (const [kind, component] of Object.entries(expected)) {
  assert.equal(lookupShapeComponent(kind), component, `${kind} should still resolve correctly after a second registerCoreShapes() call`)
}
console.log('ok: shape-registry — registerCoreShapes() is idempotent')

// Kinds this unit does NOT register (group/arrow — arrows are drawn by the
// SVG overlay, not a shape body) still correctly fall back to BoxShape —
// proving registerCoreShapes() doesn't accidentally widen the registry
// beyond the six core kinds it owns.
for (const kind of ['group', 'arrow']) {
  assert.equal(lookupShapeComponent(kind), BoxShape, `unregistered kind ${kind} should still fall back to BoxShape`)
}
console.log('ok: shape-registry — unregistered kinds (group/arrow) still fall back to BoxShape, unchanged')

console.log('ok: shape-registry (registerCoreShapes wires note/frame/text/geo/draw/line to their dedicated bodies; everything else still falls back to BoxShape)')
