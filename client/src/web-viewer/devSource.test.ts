/** Dev-source helpers: input parsing, sandbox profile, iframe src. Run: bun client/src/web-viewer/devSource.test.ts */
import assert from 'node:assert/strict'
import { parseDevInput, sandboxFor, srcFor } from './devSource'

// parseDevInput: URL forms, bare port, rejection of non-local.
assert.deepEqual(parseDevInput('http://localhost:3000'), { port: 3000, path: '/' })
assert.deepEqual(parseDevInput('http://localhost:3000/admin?x=1'), { port: 3000, path: '/admin?x=1' })
assert.deepEqual(parseDevInput('http://127.0.0.1:5173/'), { port: 5173, path: '/' })
assert.deepEqual(parseDevInput('3000'), { port: 3000, path: '/' })
assert.deepEqual(parseDevInput(':8080'), { port: 8080, path: '/' })
assert.equal(parseDevInput('https://example.com'), null, 'external URL rejected')
assert.equal(parseDevInput('http://localhost/'), null, 'no port rejected')
assert.equal(parseDevInput('not a url'), null)

// parseDevInput: schemeless host:port — the creation prompt's own example.
assert.deepEqual(parseDevInput('localhost:3000'), { port: 3000, path: '/' })
assert.deepEqual(parseDevInput('127.0.0.1:5173'), { port: 5173, path: '/' })
assert.deepEqual(parseDevInput('[::1]:3000'), { port: 3000, path: '/' })
assert.equal(parseDevInput('example.com:3000'), null, 'schemeless non-local host:port rejected')

// sandboxFor: exact strings (Global Constraints); dev-ness matches srcFor's
// isDevSource predicate exactly — a 'dev' record missing its port falls back
// to the FILE profile rather than granting allow-same-origin to file bytes.
assert.equal(sandboxFor({ kind: 'file' }), 'allow-scripts allow-forms allow-downloads')
assert.equal(
	sandboxFor({ kind: 'dev', port: 3000 }),
	'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads'
)
assert.equal(
	sandboxFor({ kind: 'dev' }),
	'allow-scripts allow-forms allow-downloads',
	'dev without port falls back to the file profile'
)

// srcFor: file uses /files with per-segment encoding; dev uses /dev/{port}{path}.
assert.equal(srcFor({ kind: 'file', path: 'a/b c.html', rev: 2 }), '/files/a/b%20c.html?rev=2')
assert.equal(srcFor({ kind: 'dev', port: 3000, path: '/', rev: 0 }), '/dev/3000/?rev=0')
assert.equal(srcFor({ kind: 'dev', port: 3000, path: '/admin?x=1', rev: 1 }), '/dev/3000/admin?x=1&rev=1')
assert.equal(srcFor({ path: 'a.html', rev: 0 }), '/files/a.html?rev=0', 'missing kind = file (pre-migration records)')

// srcFor: dot-segment path traversal is neutralized (a browser RFC-3986-
// normalizes '../' out of an iframe src before the request leaves, which
// would otherwise escape the /dev/{port}/ prefix into /files/*).
assert.equal(
	srcFor({ kind: 'dev', port: 3000, path: '/../../files/x', rev: 0 }),
	'/dev/3000/?rev=0',
	'leading ../ escape neutralized'
)
assert.equal(
	srcFor({ kind: 'dev', port: 3000, path: '/a/../../files/x', rev: 0 }),
	'/dev/3000/?rev=0',
	'nested ../ escape neutralized'
)
assert.equal(
	srcFor({ kind: 'dev', port: 3000, path: '/a/./b', rev: 0 }),
	'/dev/3000/?rev=0',
	'./ segment neutralized too'
)
assert.equal(
	srcFor({ kind: 'dev', port: 3000, path: '/%2e%2e/files/x', rev: 0 }),
	'/dev/3000/%2e%2e/files/x?rev=0',
	'percent-encoded dots are NOT browser-normalized — not an escape, left as-is'
)

console.log('devSource.test.ts OK')
