// Run: bun src/local-updates.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from './loro-canvas-doc.js'

const shape = (id: string) => ({ id, kind: 'note', parentId: 'page:p', index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: {} })

const a = LoroCanvasDoc.create({ peerId: 1n })
const b = LoroCanvasDoc.create({ peerId: 2n })

// Forward a's local updates straight into b.
const unsub = a.subscribeLocalUpdates((bytes) => { b.import(bytes) })
a.putShape(shape('shape:x') as any); a.commit()
assert.deepEqual(b.listShapes().map((s) => s.id), ['shape:x'], 'local update forwarded to b')

// b's own imports must NOT echo back as a's local updates (no loop).
let aLocalFires = 0
a.subscribeLocalUpdates(() => { aLocalFires++ })
b.putShape(shape('shape:y') as any); b.commit()
assert.equal(aLocalFires, 0, 'a sees no local update from b activity')

unsub()
a.putShape(shape('shape:z') as any); a.commit()
// b is not wired to forward its own changes back to a, and forwarding from a
// to b stopped at unsub() — so b's shapes are exactly what it had before:
// 'shape:x' (forwarded from a) plus 'shape:y' (its own local put). It must NOT
// have gained 'shape:z'.
assert.deepEqual(b.listShapes().map((s) => s.id).sort(), ['shape:x', 'shape:y'], 'no forwarding after unsub')

console.log('ok: local-updates')
