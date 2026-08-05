/**
 * Pure predicate backing the "hide a controller's canvas cursor" overlay
 * (hideControllerCursor.ts). Imports from fileViewerBaton.ts, NOT
 * hideControllerCursor.ts itself — that file pulls in the real 'tldraw'
 * package at runtime (via FadedCollaboratorCursorOverlayUtil), which hangs
 * a bare `bun <file>.test.ts` process on exit even after all assertions
 * pass (an open handle in tldraw's import side effects, unrelated to this
 * predicate). See fileViewerBaton.ts's header for the same note.
 * Run with: bun src/file-viewer/fileViewerBaton.test.ts
 */
import assert from 'node:assert/strict'
import { hasFileViewerBaton } from './fileViewerBaton'

// No baton at all.
assert.equal(hasFileViewerBaton(undefined), false)
assert.equal(hasFileViewerBaton(null), false)
assert.equal(hasFileViewerBaton({}), false)
assert.equal(hasFileViewerBaton({ fileViewerPresent: null }), false, 'explicit null token (not presenting)')
assert.equal(hasFileViewerBaton('not an object'), false)

// A live token.
assert.equal(
	hasFileViewerBaton({ fileViewerPresent: { shapeId: 'shape:abc', fraction: 0.5, ts: 123 } }),
	true
)

// Malformed/partial shapes must not throw or false-positive.
assert.equal(hasFileViewerBaton({ fileViewerPresent: {} }), false, 'token object with no shapeId')
assert.equal(hasFileViewerBaton({ fileViewerPresent: { shapeId: 42 } }), false, 'non-string shapeId')
assert.equal(hasFileViewerBaton({ fileViewerPresent: 'garbage' }), false, 'non-object token value')

// Other meta fields present but no fileViewerPresent key at all.
assert.equal(hasFileViewerBaton({ stamp: {}, presenting: true }), false)

console.log('ok: fileViewerBaton — hasFileViewerBaton')
