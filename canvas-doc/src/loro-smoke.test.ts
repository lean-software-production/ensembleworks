// Run: bun src/loro-smoke.test.ts
import assert from 'node:assert/strict'
import { LoroDoc } from 'loro-crdt'

const doc = new LoroDoc()
doc.setPeerId(1n)
const tree = doc.getTree('shapes')
const a = tree.createNode()
a.data.set('type', 'note')
const b = tree.createNode()
tree.move(a.id, b.id) // reparent a under b
doc.commit()
assert.equal(tree.roots().length, 1, 'only b is a root after reparent')
assert.equal(tree.getNodeByID(a.id)!.parent()!.id, b.id)
assert.equal(a.data.get('type'), 'note')

// Loro enforces no-cycles natively.
assert.throws(() => tree.move(b.id, a.id), /cycle|ancestor|parent/i)

// snapshot round-trip
const snap = doc.export({ mode: 'snapshot' })
const doc2 = new LoroDoc()
doc2.import(snap)
assert.equal(doc2.getTree('shapes').roots().length, 1)

console.log('ok: loro-crdt 1.13.6 smoke')
