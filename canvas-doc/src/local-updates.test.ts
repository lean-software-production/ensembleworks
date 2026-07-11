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

// Remotely-imported changes must NOT fire a's local-updates listeners (no
// echo loop): b commits its own change and a imports it — a experiences a
// real remote event here, so the zero count below is meaningful, not vacuous.
let aLocalFires = 0
a.subscribeLocalUpdates(() => { aLocalFires++ })
b.putShape(shape('shape:y') as any); b.commit()
a.import(b.exportUpdate()) // a receives a remote change
assert.equal(aLocalFires, 0, "a's local-updates listener doesn't fire for remotely-imported changes")
assert.deepEqual(a.listShapes().map((s) => s.id).sort(), ['shape:x', 'shape:y'], 'a converged on the remote change')

unsub()
a.putShape(shape('shape:z') as any); a.commit()
// Positive control: the still-subscribed counter listener fires for a's own
// commit — proving it was live when it read 0 above.
assert.equal(aLocalFires, 1, 'still-subscribed listener fires once for a genuinely local commit')
// The unsubscribed forwarder is dead: b keeps 'shape:x' (forwarded earlier)
// plus its own 'shape:y', and must NOT gain 'shape:z'.
assert.deepEqual(b.listShapes().map((s) => s.id).sort(), ['shape:x', 'shape:y'], 'no forwarding after unsub')

console.log('ok: local-updates')
