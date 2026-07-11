// Run: bun src/text.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from './loro-canvas-doc.js'

const doc = LoroCanvasDoc.create({ peerId: 1n })
doc.putShape({ id: 'shape:n', kind: 'note', parentId: 'page:p', index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: {} } as any)
doc.setText('shape:n', 'hello')
doc.commit()
assert.equal(doc.getText('shape:n'), 'hello')
doc.setText('shape:n', 'hello world')
assert.equal(doc.getText('shape:n'), 'hello world')

// --- contract: setText no-ops on a missing shape id ---
assert.doesNotThrow(() => doc.setText('shape:missing', 'nope'))

// --- contract: getText on a missing shape returns '' ---
assert.equal(doc.getText('shape:missing'), '')

// --- lifecycle: deleteShape clears the text; re-put of the id does not resurrect it ---
doc.deleteShape('shape:n')
doc.commit()
assert.equal(doc.getText('shape:n'), '', 'text gone after deleteShape')
doc.putShape({ id: 'shape:n', kind: 'note', parentId: 'page:p', index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: {} } as any)
doc.commit()
assert.equal(doc.getText('shape:n'), '', 'no text resurrection when the id is reused')

// --- lifecycle: cascade delete clears descendants' text too ---
const casc = LoroCanvasDoc.create({ peerId: 2n })
casc.putShape({ id: 'shape:fr', kind: 'frame', parentId: 'page:p', index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { w: 10, h: 10 } } as any)
casc.putShape({ id: 'shape:kid', kind: 'note', parentId: 'shape:fr', index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: {} } as any)
casc.setText('shape:kid', 'inside the frame')
casc.commit()
casc.deleteShape('shape:fr') // cascades to shape:kid
casc.commit()
casc.putShape({ id: 'shape:kid', kind: 'note', parentId: 'page:p', index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: {} } as any)
casc.commit()
assert.equal(casc.getText('shape:kid'), '', 'descendant text cleared by cascade delete; no resurrection on id reuse')

console.log('ok: text')
