// Run with: bun src/terminal/webgl.test.ts   (from client/)
import assert from 'node:assert/strict'
import { WEBGL_PREF_KEY, webglEnabled } from './webgl'

const store = (val: string | null): Pick<Storage, 'getItem'> => ({
	getItem: (k: string) => (k === WEBGL_PREF_KEY ? val : null),
})

// Default: no key set → WebGL on.
assert.equal(webglEnabled(() => store(null)), true)

// Explicit opt-out for machines with silent atlas corruption.
assert.equal(webglEnabled(() => store('off')), false)

// Any other value → on (typos fail safe: WebGL is the default experience).
assert.equal(webglEnabled(() => store('on')), true)
assert.equal(webglEnabled(() => store('')), true)

// Accessing storage ITSELF throws (Firefox/Safari with storage fully
// blocked: window.localStorage access raises SecurityError) → on.
assert.equal(
	webglEnabled(() => {
		throw new Error('denied')
	}),
	true
)

// getItem throws after access succeeds (privacy mode variants) → on.
assert.equal(
	webglEnabled(() => ({
		getItem: () => {
			throw new Error('denied')
		},
	})),
	true
)

console.log('webgl.test.ts: all assertions passed')
