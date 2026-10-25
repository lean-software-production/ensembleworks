// Run: bun src/incremental.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from './loro-canvas-doc.js'

const shape = (id: string, over: any = {}) => ({
  id, kind: 'note', parentId: 'page:p', index: 'a1',
  x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: {}, ...over,
})

// Two peers converge via incremental updates, not full snapshots.
const a = LoroCanvasDoc.create({ peerId: 1n })
const b = LoroCanvasDoc.create({ peerId: 2n })

a.putShape(shape('shape:a1') as any); a.commit()
// b imports a's full history the first time (from = empty).
b.import(a.exportUpdate())
assert.deepEqual(b.listShapes().map((s) => s.id), ['shape:a1'])

// Capture b's version, then a makes a change; a exports ONLY the delta since b.
const bVersion = b.versionBytes()
a.putShape(shape('shape:a2') as any); a.commit()
const delta = a.exportUpdate(bVersion)
const status = b.import(delta)
b.commit()
assert.equal(status.pending, false, 'delta applied cleanly, nothing pending')
assert.equal(status.changed, true, 'a fresh delta reports changed: true')
assert.deepEqual(b.listShapes().map((s) => s.id).sort(), ['shape:a1', 'shape:a2'])

// Re-importing the SAME delta is a no-op: all ops already known.
const repeat = b.import(delta)
assert.equal(repeat.changed, false, 'a repeat import reports changed: false')
assert.equal(repeat.pending, false, 'nothing pending on a no-op import either')
assert.deepEqual(b.listShapes().map((s) => s.id).sort(), ['shape:a1', 'shape:a2'], 'state untouched by the no-op')

// Partial overlap: a full-history export where b already has SOME of the ops
// still reports changed: true (at least one op newly applied).
a.putShape(shape('shape:a3') as any); a.commit()
assert.equal(b.import(a.exportUpdate()).changed, true, 'partial-overlap import reports changed: true')
assert.deepEqual(b.listShapes().map((s) => s.id).sort(), ['shape:a1', 'shape:a2', 'shape:a3'])

// A delta computed against a stale version is smaller than the full history.
assert.ok(delta.byteLength < a.exportUpdate().byteLength, 'incremental delta < full history')

console.log('ok: incremental')
