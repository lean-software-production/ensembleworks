// file-server core: path safety (traversal/symlink), content-type, dir 404,
// headers, and byte ranges (206 / 416 / accept-ranges) for video seeking.
// Run with: bun src/file-server-core.test.ts
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buffer } from 'node:stream/consumers'
import { serveFile } from './file-server-core.ts'

const bodyOf = async (served: { body: import('node:stream').Readable | null }) =>
	served.body ? new Uint8Array(await buffer(served.body)) : new Uint8Array()

async function main() {
	const home = await mkdtemp(path.join(os.tmpdir(), 'fshome-'))
	const outside = await mkdtemp(path.join(os.tmpdir(), 'fsout-'))
	await mkdir(path.join(home, 'docs'))
	await writeFile(path.join(home, 'docs', 'r.html'), '<h1>hi</h1>')
	await writeFile(path.join(home, 'docs', 's.css'), 'body{}')
	await writeFile(path.join(home, 'docs', 'clip.mp4'), 'ABCDEFGHIJ') // 10 bytes
	await writeFile(path.join(outside, 'secret.txt'), 'no')
	await symlink(path.join(outside, 'secret.txt'), path.join(home, 'docs', 'leak.txt'))

	// happy path + content-type + headers
	const ok = await serveFile(home, 'docs/r.html')
	assert.equal(ok.status, 200)
	assert.equal(ok.headers['content-type'], 'text/html; charset=utf-8')
	assert.equal(ok.headers['access-control-allow-origin'], '*')
	assert.equal(ok.headers['cache-control'], 'no-store')
	assert.equal(ok.headers['accept-ranges'], 'bytes')
	assert.equal(ok.headers['content-length'], '11')
	assert.equal(new TextDecoder().decode(await bodyOf(ok)), '<h1>hi</h1>')
	assert.equal((await serveFile(home, 'docs/s.css')).headers['content-type'], 'text/css; charset=utf-8')

	// video content-type + range support
	const mp4 = await serveFile(home, 'docs/clip.mp4')
	assert.equal(mp4.headers['content-type'], 'video/mp4')
	assert.equal(mp4.headers['accept-ranges'], 'bytes')
	mp4.body!.destroy()

	// a byte range → 206 with content-range/content-length and just those bytes
	const part = await serveFile(home, 'docs/clip.mp4', { range: 'bytes=2-4' })
	assert.equal(part.status, 206)
	assert.equal(part.headers['content-range'], 'bytes 2-4/10')
	assert.equal(part.headers['content-length'], '3')
	assert.equal(new TextDecoder().decode(await bodyOf(part)), 'CDE')

	// open-ended and suffix ranges
	const open = await serveFile(home, 'docs/clip.mp4', { range: 'bytes=7-' })
	assert.equal(open.headers['content-range'], 'bytes 7-9/10')
	assert.equal(new TextDecoder().decode(await bodyOf(open)), 'HIJ')
	const suffix = await serveFile(home, 'docs/clip.mp4', { range: 'bytes=-3' })
	assert.equal(suffix.headers['content-range'], 'bytes 7-9/10')
	assert.equal(new TextDecoder().decode(await bodyOf(suffix)), 'HIJ')

	// end past EOF is clamped, not an error
	const clamped = await serveFile(home, 'docs/clip.mp4', { range: 'bytes=8-999' })
	assert.equal(clamped.status, 206)
	assert.equal(clamped.headers['content-range'], 'bytes 8-9/10')
	assert.equal(new TextDecoder().decode(await bodyOf(clamped)), 'IJ')

	// start past EOF → 416 with the size, per RFC 9110
	const bad = await serveFile(home, 'docs/clip.mp4', { range: 'bytes=99-200' })
	assert.equal(bad.status, 416)
	assert.equal(bad.headers['content-range'], 'bytes */10')
	assert.equal(bad.body, null)

	// unparseable / multi-range headers are ignored → whole file, 200
	for (const header of ['bytes=1-2,5-6', 'items=0-1', 'garbage']) {
		const whole = await serveFile(home, 'docs/clip.mp4', { range: header })
		assert.equal(whole.status, 200, `"${header}" should fall back to the whole file`)
		assert.equal(new TextDecoder().decode(await bodyOf(whole)), 'ABCDEFGHIJ')
	}

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
