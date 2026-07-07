// file-server core: path safety (traversal/symlink), content-type, dir 404, headers.
// Run with: bun src/file-server-core.test.ts
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { serveFile } from './file-server-core.ts'

async function main() {
	const home = await mkdtemp(path.join(os.tmpdir(), 'fshome-'))
	const outside = await mkdtemp(path.join(os.tmpdir(), 'fsout-'))
	await mkdir(path.join(home, 'docs'))
	await writeFile(path.join(home, 'docs', 'r.html'), '<h1>hi</h1>')
	await writeFile(path.join(home, 'docs', 's.css'), 'body{}')
	await writeFile(path.join(outside, 'secret.txt'), 'no')
	await symlink(path.join(outside, 'secret.txt'), path.join(home, 'docs', 'leak.txt'))

	// happy path + content-type + headers
	const ok = await serveFile(home, 'docs/r.html')
	assert.equal(ok.status, 200)
	assert.equal(ok.headers['content-type'], 'text/html; charset=utf-8')
	assert.equal(ok.headers['access-control-allow-origin'], '*')
	assert.equal(ok.headers['cache-control'], 'no-store')
	assert.equal(new TextDecoder().decode(ok.body!), '<h1>hi</h1>')
	assert.equal((await serveFile(home, 'docs/s.css')).headers['content-type'], 'text/css; charset=utf-8')

	// traversal (plain and encoded) → 403
	assert.equal((await serveFile(home, '../etc/passwd')).status, 403)
	assert.equal((await serveFile(home, 'docs/%2e%2e/%2e%2e/etc/passwd')).status, 403)
	// symlink escaping home → 403
	assert.equal((await serveFile(home, 'docs/leak.txt')).status, 403)
	// directory → 404 (no listings in v1)
	assert.equal((await serveFile(home, 'docs')).status, 404)
	// missing → 404
	assert.equal((await serveFile(home, 'docs/nope.html')).status, 404)

	console.log('ok: file-server-core')
}

main()
