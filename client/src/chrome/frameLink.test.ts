// client/src/chrome/frameLink.test.ts
import assert from 'node:assert/strict'
import { parseFrameId, buildFrameLink } from './frameLink'

// parseFrameId validates a tldraw shape id from a raw query value.
assert.equal(parseFrameId(null), null, 'absent ⇒ null')
assert.equal(parseFrameId(''), null, 'empty ⇒ null')
assert.equal(parseFrameId('not-a-shape'), null, 'missing shape: prefix ⇒ null')
assert.equal(parseFrameId('shape:abc123'), 'shape:abc123', 'valid passes through')
assert.equal(parseFrameId('shape:bad id!'), null, 'illegal chars ⇒ null')
assert.equal(parseFrameId('shape:' + 'x'.repeat(200)), null, 'over-long ⇒ null')

// buildFrameLink composes an absolute URL from origin + room + frame id.
assert.equal(
	buildFrameLink('https://ew.example', 'planning', 'shape:abc123'),
	'https://ew.example/?room=planning&frame=shape%3Aabc123',
)

console.log('ok: frameLink helpers')
