// Contract tests for the roadmap HTTP API. Boots the express app in-process
// via createSyncApp, seeds a roadmap shape for the rev fan-out check, then
// exercises GET/POST /api/roadmap end to end.
// Run with: npx tsx src/roadmap-api.test.ts
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSyncApp } from './app.ts'
import { ROADMAP_FIXTURE } from './roadmap-fixture.ts'
import { makeTestClient } from './test-helpers.ts'

const SHAPE_ID = 'shape:roadmap-1'

async function main() {
	const dataDir = await mkdtemp(path.join(os.tmpdir(), 'roadmap-api-test-'))
	const { server, getOrCreateRoom } = createSyncApp({ dataDir })
	await new Promise<void>((resolve) => server.listen(0, resolve))
	const address = server.address()
	assert.ok(address && typeof address === 'object')
	const base = `http://127.0.0.1:${address.port}`

	const { postJson, getJson } = makeTestClient(base)

	// Seed a roadmap shape bound to the id "Product Roadmap" will slug to, so
	// the fan-out check has a target. A fresh room contains page:page already.
	const room = getOrCreateRoom('test')
	await room.updateStore((store) => {
		store.put({
			id: SHAPE_ID,
			typeName: 'shape',
			type: 'roadmap',
			x: 0,
			y: 0,
			rotation: 0,
			isLocked: false,
			opacity: 1,
			meta: {},
			props: { w: 1280, h: 720, roadmapId: 'product-roadmap' },
			parentId: 'page:page',
			index: 'a1',
		} as any)
	})
	const documents = () => room.getCurrentSnapshot().documents.map((d) => d.state as any)

	// 1. Create via replace: rev 1, id slugged from the name, shape stamped.
	{
		const res = await postJson('/api/roadmap', {
			room: 'test',
			name: 'Product Roadmap',
			ops: [{ op: 'replace', data: ROADMAP_FIXTURE }],
		})
		assert.equal(res.status, 200, `create should be 200, got ${JSON.stringify(res.body)}`)
		assert.equal(res.body.ok, true)
		assert.equal(res.body.id, 'product-roadmap')
		assert.equal(res.body.rev, 1)
		assert.equal(res.body.shapesUpdated, 1, 'the seeded shape is stamped')
		const shape = documents().find((r) => r.id === SHAPE_ID)
		assert.equal(shape.props.rev, 1, 'rev fan-out lands on props.rev')
		console.log('ok: create via replace, rev fan-out stamps the bound shape')
	}

	// 2. List and read (fuzzy name + exact id).
	{
		const list = await getJson('/api/roadmap?room=test')
		assert.equal(list.status, 200)
		assert.equal(list.body.roadmaps.length, 1)
		assert.equal(list.body.roadmaps[0].id, 'product-roadmap')
		assert.equal(list.body.roadmaps[0].rev, 1)

		const read = await getJson('/api/roadmap?room=test&name=product')
		assert.equal(read.status, 200)
		assert.equal(read.body.name, 'Product Roadmap')
		assert.equal(read.body.rev, 1)
		assert.equal(read.body.data.outcomes.length, 3)
		assert.ok(read.body.updated, 'read carries the server-stamped updated date')

		const missing = await getJson('/api/roadmap?room=test&name=definitely-not-here')
		assert.equal(missing.status, 404)
		console.log('ok: list + read (fuzzy match), 404 on unknown name')
	}

	// 3. Patch ops bump rev, persist, and re-stamp the shape.
	{
		const res = await postJson('/api/roadmap', {
			room: 'test',
			name: 'product-roadmap',
			ops: [
				{ op: 'set', key: 'O3.I1.F1', fields: { status: 'done' } },
				{ op: 'move', key: 'O4', zone: 'now' },
			],
		})
		assert.equal(res.status, 200)
		assert.equal(res.body.rev, 2)
		const read = await getJson('/api/roadmap?room=test&name=product-roadmap')
		assert.equal(read.body.data.outcomes[1].initiatives[0].features[0].status, 'done')
		assert.equal(read.body.data.outcomes.find((o: any) => o.key === 'O4').zone, 'now')
		const shape = documents().find((r) => r.id === SHAPE_ID)
		assert.equal(shape.props.rev, 2)
		console.log('ok: patch ops apply, rev 2 fanned out')
	}

	// 4. Concurrency guard: stale ifRev is 409 and carries the current rev.
	{
		const res = await postJson('/api/roadmap', {
			room: 'test',
			name: 'product-roadmap',
			ifRev: 1,
			ops: [{ op: 'set', key: 'O1', fields: { status: 'parked' } }],
		})
		assert.equal(res.status, 409)
		assert.equal(res.body.rev, 2, '409 carries the current rev')
		const read = await getJson('/api/roadmap?room=test&name=product-roadmap')
		assert.equal(read.body.data.outcomes[0].status, 'done', 'stale write did not apply')
		console.log('ok: stale ifRev is 409, nothing applied')
	}

	// 5. Atomicity: a batch with one bad op leaves the document untouched.
	{
		const res = await postJson('/api/roadmap', {
			room: 'test',
			name: 'product-roadmap',
			ops: [
				{ op: 'set', key: 'O1', fields: { status: 'parked' } },
				{ op: 'set', key: 'NO-SUCH-KEY', fields: { status: 'done' } },
			],
		})
		assert.equal(res.status, 404, 'unknown key is 404')
		const read = await getJson('/api/roadmap?room=test&name=product-roadmap')
		assert.equal(read.body.data.outcomes[0].status, 'done', 'first op rolled back with the batch')
		assert.equal(read.body.rev, 2, 'rev unchanged')
		console.log('ok: failing batch is all-or-nothing')
	}

	// 6. Edges: ops on a missing roadmap 404; bad op 400; bad names 400.
	{
		const missing = await postJson('/api/roadmap', {
			room: 'test',
			name: 'no-such-roadmap',
			ops: [{ op: 'set', key: 'O1', fields: { status: 'done' } }],
		})
		assert.equal(missing.status, 404)

		const badOp = await postJson('/api/roadmap', {
			room: 'test',
			name: 'product-roadmap',
			ops: [{ op: 'destroy', key: 'O1' }],
		})
		assert.equal(badOp.status, 400)

		const noName = await postJson('/api/roadmap', {
			room: 'test',
			ops: [{ op: 'replace', data: ROADMAP_FIXTURE }],
		})
		assert.equal(noName.status, 400)

		const badSlug = await postJson('/api/roadmap', {
			room: 'test',
			name: '***',
			ops: [{ op: 'replace', data: ROADMAP_FIXTURE }],
		})
		assert.equal(badSlug.status, 400)
		console.log('ok: edges (missing roadmap 404, bad op 400, bad name 400)')
	}

	// 7. Race regression: two concurrent POSTs targeting different features must
	//    both land (distinct revs, both edits visible in the final GET).
	{
		const [r1, r2] = await Promise.all([
			postJson('/api/roadmap', {
				room: 'test',
				name: 'product-roadmap',
				ops: [{ op: 'set', key: 'O1.I1.F1', fields: { status: 'in-progress' } }],
			}),
			postJson('/api/roadmap', {
				room: 'test',
				name: 'product-roadmap',
				ops: [{ op: 'set', key: 'O1.I1.F2', fields: { status: 'in-progress' } }],
			}),
		])
		assert.equal(r1.status, 200, `race writer A: ${JSON.stringify(r1.body)}`)
		assert.equal(r2.status, 200, `race writer B: ${JSON.stringify(r2.body)}`)
		assert.notEqual(r1.body.rev, r2.body.rev, 'concurrent writes must produce distinct revs')
		const read = await getJson('/api/roadmap?room=test&name=product-roadmap')
		const features = read.body.data.outcomes[0].initiatives[0].features
		assert.equal(features[0].status, 'in-progress', 'writer A edit (F1) survived')
		assert.equal(features[1].status, 'in-progress', 'writer B edit (F2) survived')
		console.log('ok: concurrent POSTs serialized — both edits applied, distinct revs')
	}

	// 8. ifRev on a missing roadmap is 409, nothing created.
	{
		const res = await postJson('/api/roadmap', {
			room: 'test',
			name: 'never-created-roadmap',
			ifRev: 5,
			ops: [{ op: 'replace', data: ROADMAP_FIXTURE }],
		})
		assert.equal(res.status, 409, `ifRev on missing should be 409, got ${res.status}`)
		assert.match(res.body.error, /ifRev 5 given but no roadmap matches/)
		const list = await getJson('/api/roadmap?room=test')
		const names = list.body.roadmaps.map((r: any) => r.name)
		assert.ok(!names.includes('never-created-roadmap'), 'no new roadmap created')
		console.log('ok: ifRev on missing roadmap is 409, nothing created')
	}

	room.close()
	await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
}

main().then(
	() => {
		console.log('roadmap-api.test.ts: all tests passed')
		process.exit(0)
	},
	(err) => {
		console.error(err)
		process.exit(1)
	}
)
