import assert from 'node:assert/strict'
import { formatPayload } from './formatters.ts'

const dec = formatPayload({ kind: 'decision', room: 'planning', data: { text: 'use bun' } })
assert.match(dec.title!, /decision/i)
assert.match(dec.title!, /planning/)
assert.equal(dec.description, 'use bun')

const sum = formatPayload({ kind: 'summary', room: 'planning', data: { text: 'we met and talked' } })
assert.match(sum.title!, /summary/i)
assert.equal(sum.description, 'we met and talked')

const ai = formatPayload({ kind: 'action-items', room: 'r', data: { items: [{ text: 'do x', owner: 'al' }, { text: 'do y' }] } })
assert.match(ai.title!, /action items/i)
assert.match(ai.description!, /do x/)
assert.match(ai.description!, /@al/)
assert.match(ai.description!, /do y/)
assert.ok(ai.description!.includes('\n'), 'items are newline-separated')

const fl = formatPayload({ kind: 'frame-link', room: 'planning', data: { title: 'Sketch', url: 'https://ew.example/?room=planning&frame=shape:abc' } })
assert.equal(fl.url, 'https://ew.example/?room=planning&frame=shape:abc')
assert.equal(fl.title, 'Sketch')

console.log('ok: formatters')
