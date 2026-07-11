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
assert.equal(status.pending, null, 'delta applied cleanly, nothing pending')
assert.deepEqual(b.listShapes().map((s) => s.id).sort(), ['shape:a1', 'shape:a2'])

// A delta computed against a stale version is smaller than the full history.
assert.ok(delta.byteLength < a.exportUpdate().byteLength, 'incremental delta < full history')

console.log('ok: incremental')
