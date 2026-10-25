/**
 * Pure predicate backing the "hide a controller's canvas cursor" overlay
 * (hideControllerCursor.ts). Imports from webViewerBaton.ts, NOT
 * hideControllerCursor.ts itself — that file pulls in the real 'tldraw'
 * package at runtime (via FadedCollaboratorCursorOverlayUtil), which hangs
 * a bare `bun <file>.test.ts` process on exit even after all assertions
 * pass (an open handle in tldraw's import side effects, unrelated to this
 * predicate). See webViewerBaton.ts's header for the same note.
 * Run with: bun src/web-viewer/webViewerBaton.test.ts
 */
import assert from 'node:assert/strict'
import { hasWebViewerBaton } from './webViewerBaton'

// No baton at all.
assert.equal(hasWebViewerBaton(undefined), false)
assert.equal(hasWebViewerBaton(null), false)
assert.equal(hasWebViewerBaton({}), false)
assert.equal(hasWebViewerBaton({ webViewerPresent: null }), false, 'explicit null token (not presenting)')
assert.equal(hasWebViewerBaton('not an object'), false)

// A live token.
assert.equal(
	hasWebViewerBaton({ webViewerPresent: { shapeId: 'shape:abc', fraction: 0.5, ts: 123 } }),
	true
)

// Malformed/partial shapes must not throw or false-positive.
assert.equal(hasWebViewerBaton({ webViewerPresent: {} }), false, 'token object with no shapeId')
assert.equal(hasWebViewerBaton({ webViewerPresent: { shapeId: 42 } }), false, 'non-string shapeId')
assert.equal(hasWebViewerBaton({ webViewerPresent: 'garbage' }), false, 'non-object token value')

// Other meta fields present but no webViewerPresent key at all.
assert.equal(hasWebViewerBaton({ stamp: {}, presenting: true }), false)

console.log('ok: webViewerBaton — hasWebViewerBaton')
