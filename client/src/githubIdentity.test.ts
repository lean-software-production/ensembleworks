/**
 * extractGithubIdentity: pure parsing of a Cloudflare Access
 * `/cdn-cgi/access/get-identity` payload. Run: bun client/src/githubIdentity.test.ts
 *
 * Pure — no fetch/localStorage/tldraw — so it runs under a bare bun script. The
 * network helpers in the same module reference fetch/localStorage only when
 * called, so importing the module here is safe.
 */
import assert from 'node:assert/strict'
import { extractGithubIdentity } from './githubIdentity'

// A valid GitHub payload → namespaced id + numeric id + display name (mirrors
// the probe capture in the identity design doc).
assert.deepEqual(
	extractGithubIdentity({ id: 227505, name: 'David Laing', idp: { type: 'github' } }),
	{ id: 'github:227505', numericId: 227505, name: 'David Laing' },
	'valid GitHub payload extracts id + name'
)

// Missing name → the id stands in as the display name.
assert.deepEqual(
	extractGithubIdentity({ id: 42, idp: { type: 'github' } }),
	{ id: 'github:42', numericId: 42, name: 'github:42' },
	'missing name falls back to the id'
)
assert.deepEqual(
	extractGithubIdentity({ id: 42, name: '   ', idp: { type: 'github' } }),
	{ id: 'github:42', numericId: 42, name: 'github:42' },
	'blank name falls back to the id'
)

// Non-GitHub IdP → null (e.g. a service-token session or a different provider).
assert.equal(
	extractGithubIdentity({ id: 227505, name: 'X', idp: { type: 'onetimepin' } }),
	null,
	'non-github idp → null'
)
assert.equal(extractGithubIdentity({ id: 227505, name: 'X' }), null, 'missing idp → null')

// Bad ids → null (zero, negative, non-integer, non-number, absent).
for (const id of [0, -1, 3.5, '227505', null, undefined, NaN]) {
	assert.equal(
		extractGithubIdentity({ id, name: 'X', idp: { type: 'github' } }),
		null,
		`id=${String(id)} → null`
	)
}

// Malformed payloads → null, never throw.
assert.equal(extractGithubIdentity(null), null, 'null payload → null')
assert.equal(extractGithubIdentity('nope'), null, 'string payload → null')
assert.equal(extractGithubIdentity(42), null, 'number payload → null')

console.log('githubIdentity.test.ts: all tests passed')
