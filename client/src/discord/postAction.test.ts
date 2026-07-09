import assert from 'node:assert/strict'
import { buildFrameLinkPost } from './postAction'

const body = buildFrameLinkPost('https://ew.example', 'planning', 'shape:abc', 'Sketch')
assert.equal(body.kind, 'frame-link')
assert.equal(body.room, 'planning')
assert.equal(body.data.title, 'Sketch')
assert.equal(body.data.url, 'https://ew.example/?room=planning&frame=shape%3Aabc')
console.log('ok: discord postAction builder')
