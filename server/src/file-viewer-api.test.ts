// Contract tests for the file-viewer HTTP API. Boots the express app
// in-process via createSyncApp (files-route.test.ts pattern: env vars must be
// set before app.ts is imported, so the import is dynamic), then exercises
// POST /api/canvas/file-viewer open/refresh end to end.
// Run with: bun src/file-viewer-api.test.ts
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

async function main() {
	const agentHome = await mkdtemp(path.join(os.tmpdir(), 'file-viewer-home-'))
	process.env.ENSEMBLEWORKS_AGENT_HOME = agentHome

	const { createSyncApp } = await import('./app.ts')
	const { makeTestClient } = await import('./test-helpers.ts')

	const dataDir = await mkdtemp(path.join(os.tmpdir(), 'file-viewer-api-test-'))
	const { server, getOrCreateRoom } = createSyncApp({ dataDir })
	await new Promise<void>((resolve) => server.listen(0, resolve))
	const address = server.address()
	assert.ok(address && typeof address === 'object')
	const base = `http://127.0.0.1:${address.port}`

	const { postJson } = makeTestClient(base)
	const room = getOrCreateRoom('test')
	const documents = () => room.getCurrentSnapshot().documents.map((d) => d.state as any)
	const fileViewers = () => documents().filter((r) => r.typeName === 'shape' && r.type === 'file-viewer')

	// 1. open creates a file-viewer shape with sensible defaults.
	let createdId = ''
	{
		const res = await postJson('/api/canvas/file-viewer', {
			room: 'test',
			op: 'open',
			path: 'docs/r.html',
		})
		assert.equal(res.status, 200, `open should be 200, got ${JSON.stringify(res.body)}`)
		assert.equal(res.body.ok, true)
		assert.equal(typeof res.body.id, 'string')
		createdId = res.body.id

		const shape = fileViewers().find((r) => r.id === createdId)
		assert.ok(shape, 'a file-viewer shape exists in the room')
		assert.equal(shape.props.path, 'docs/r.html')
		assert.equal(shape.props.rev, 0)
		assert.equal(shape.props.title, 'r.html')
		assert.equal(shape.props.w, 720)
		assert.equal(shape.props.h, 540)
		console.log('ok: open creates a file-viewer shape with defaults')
	}

	// 2. tilde-relative path is stripped and stored home-relative.
	{
		const res = await postJson('/api/canvas/file-viewer', {
			room: 'test',
			op: 'open',
			path: '~/docs/r2.html',
		})
		assert.equal(res.status, 200, `open ~/ should be 200, got ${JSON.stringify(res.body)}`)
		const shape = fileViewers().find((r) => r.id === res.body.id)
		assert.equal(shape.props.path, 'docs/r2.html')
		console.log('ok: tilde-relative path stripped to home-relative')
	}

	// 3. traversal / absolute-outside-home rejected; absolute-inside-home (via
	//    ENSEMBLEWORKS_AGENT_HOME) accepted and stored relative.
	{
		const traversal = await postJson('/api/canvas/file-viewer', {
			room: 'test',
			op: 'open',
			path: '../../etc/passwd',
		})
		assert.equal(traversal.status, 400, 'traversal path must be 400')

		const absoluteOutside = await postJson('/api/canvas/file-viewer', {
			room: 'test',
			op: 'open',
			path: '/etc/passwd',
		})
		assert.equal(absoluteOutside.status, 400, 'absolute path outside agent home must be 400')

		const absoluteInside = await postJson('/api/canvas/file-viewer', {
			room: 'test',
			op: 'open',
			path: `${agentHome}/x.html`,
		})
		assert.equal(absoluteInside.status, 200, `absolute path inside agent home should be 200, got ${JSON.stringify(absoluteInside.body)}`)
		const shape = fileViewers().find((r) => r.id === absoluteInside.body.id)
		assert.equal(shape.props.path, 'x.html')
		console.log('ok: traversal/absolute-outside 400, absolute-inside-home stored relative')
	}

	// 4. gateway is rejected with 501 (v1 has no remote seam).
	{
		const res = await postJson('/api/canvas/file-viewer', {
			room: 'test',
			op: 'open',
			path: 'docs/r.html',
			gateway: 'vm-1',
		})
		assert.equal(res.status, 501, `gateway should be 501, got ${res.status}`)
		console.log('ok: gateway rejected with 501')
	}

	// 5. refresh bumps rev on every matching shape; repeat bumps again; a path
	//    with no matches updates 0.
	{
		const r1 = await postJson('/api/canvas/file-viewer', {
			room: 'test',
			op: 'refresh',
			path: 'docs/r.html',
		})
		assert.equal(r1.status, 200)
		assert.equal(r1.body.ok, true)
		assert.equal(r1.body.updated, 1)
		let shape = fileViewers().find((r) => r.id === createdId)
		assert.equal(shape.props.rev, 1, 'rev bumped to 1')

		const r2 = await postJson('/api/canvas/file-viewer', {
			room: 'test',
			op: 'refresh',
			path: 'docs/r.html',
		})
		assert.equal(r2.body.updated, 1)
		shape = fileViewers().find((r) => r.id === createdId)
		assert.equal(shape.props.rev, 2, 'rev bumped to 2 on second refresh')

		const rAbsent = await postJson('/api/canvas/file-viewer', {
			room: 'test',
			op: 'refresh',
			path: 'docs/absent.html',
		})
		assert.equal(rAbsent.status, 200)
		assert.equal(rAbsent.body.updated, 0, 'no matching shape means 0 updated')
		console.log('ok: refresh fans out rev bumps, repeatable, 0 on no match')
	}

	// 6. unknown op is 400.
	{
		const res = await postJson('/api/canvas/file-viewer', {
			room: 'test',
			op: 'nonsense',
			path: 'docs/r.html',
		})
		assert.equal(res.status, 400, `unknown op should be 400, got ${res.status}`)
		console.log('ok: unknown op is 400')
	}

	room.close()
	console.log('ok: file-viewer api')
	server.close()
	process.exit(0)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
