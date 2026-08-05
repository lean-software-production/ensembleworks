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

// sandboxFor: exact strings (Global Constraints).
assert.equal(sandboxFor('file'), 'allow-scripts allow-forms allow-downloads')
assert.equal(sandboxFor('dev'), 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads')

// srcFor: file uses /files with per-segment encoding; dev uses /dev/{port}{path}.
assert.equal(srcFor({ kind: 'file', path: 'a/b c.html', rev: 2 }), '/files/a/b%20c.html?rev=2')
assert.equal(srcFor({ kind: 'dev', port: 3000, path: '/', rev: 0 }), '/dev/3000/?rev=0')
assert.equal(srcFor({ kind: 'dev', port: 3000, path: '/admin?x=1', rev: 1 }), '/dev/3000/admin?x=1&rev=1')
assert.equal(srcFor({ path: 'a.html', rev: 0 }), '/files/a.html?rev=0', 'missing kind = file (pre-migration records)')
console.log('devSource.test.ts OK')
