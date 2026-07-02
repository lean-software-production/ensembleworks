// Contract tests for the /uploads asset routes. Regression guard for the
// asset-id rules: the client assetStore keeps dots from the original filename
// ("<uniqueId>-photo.png"), so ids with extensions must be accepted, while
// path-traversal shapes (".", "..", dotfiles, separators) stay rejected.
// Run with: npx tsx src/uploads-api.test.ts
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSyncApp } from './app.ts'

async function main() {
	const dataDir = await mkdtemp(path.join(os.tmpdir(), 'uploads-api-test-'))
	const { server } = createSyncApp({ dataDir })
	await new Promise<void>((resolve) => server.listen(0, resolve))
	const address = server.address()
	assert.ok(address && typeof address === 'object', 'server.listen(0) should yield a port')
	const base = `http://127.0.0.1:${address.port}`

	const put = (id: string, body: string) =>
		fetch(`${base}/uploads/${id}`, { method: 'PUT', body })

	// The assetStore's real id shape — uniqueId prefix + sanitized filename
	// with its extension dot — must round-trip.
	{
		const res = await put('u1a2b3c4-team-photo.png', 'png-bytes')
		assert.equal(res.status, 200, 'id with extension dot is accepted')
		const back = await fetch(`${base}/uploads/u1a2b3c4-team-photo.png`)
		assert.equal(back.status, 200)
		assert.equal(await back.text(), 'png-bytes', 'stored bytes round-trip')
	}

	// Extension-less ids (screenshare stills) keep working.
	{
		const res = await put('screenstill-abc123', 'jpeg-bytes')
		assert.equal(res.status, 200, 'extension-less id is accepted')
	}

	// Multiple interior dots are fine — they cannot escape uploadsDir.
	{
		const res = await put('archive.tar.gz', 'bytes')
		assert.equal(res.status, 200, 'interior dots are accepted')
	}

	// Traversal and dotfile shapes stay rejected — either by sanitizeAssetId
	// (400) or by URL path normalization never reaching the route (404 for
	// "." / ".." / separator segments).
	for (const bad of ['..', '.hidden', '.', 'a b', 'a/b', 'x'.repeat(65)]) {
		const res = await put(encodeURIComponent(bad), 'evil')
		assert.ok([400, 404].includes(res.status), `"${bad}" is rejected (got ${res.status})`)
	}

	server.close()
	console.log('ALL UPLOADS API TESTS PASSED')
	process.exit(0)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
