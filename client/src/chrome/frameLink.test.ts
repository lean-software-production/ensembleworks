// client/src/chrome/frameLink.test.ts
import assert from 'node:assert/strict'
import { parseFrameId, buildFrameLink, buildRoomLink, readFrameId } from './frameLink'

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

// buildRoomLink composes an absolute URL from origin + room.
assert.equal(buildRoomLink('https://x.test', 'team'), 'https://x.test/?room=team')
assert.equal(
	buildRoomLink('https://ew.example', 'design-review'),
	'https://ew.example/?room=design-review',
)
// a room id needing encoding round-trips through URLSearchParams
{
	const raw = 'odd room/&?='
	const roomLink = buildRoomLink('https://ew.example', raw)
	assert.equal(
		new URLSearchParams(roomLink.slice(roomLink.indexOf('?'))).get('room'),
		raw,
		'encoded room id round-trips',
	)
}

console.log('ok: buildRoomLink')

// readFrameId parses the `frame` param out of a raw location.search string.
assert.equal(readFrameId('?room=team&frame=shape:abc123'), 'shape:abc123')
assert.equal(readFrameId('?room=team'), null, 'no frame param ⇒ null')
assert.equal(readFrameId('?frame=garbage'), null, 'invalid ⇒ null')
// round-trips the encoded form buildFrameLink actually emits
assert.equal(readFrameId('?frame=shape%3Aabc123'), 'shape:abc123')
const link = buildFrameLink('https://ew.example', 'team', 'shape:abc123')
assert.equal(readFrameId(link.slice(link.indexOf('?'))), 'shape:abc123')
console.log('ok: readFrameId')
