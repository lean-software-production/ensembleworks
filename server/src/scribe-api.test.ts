// Contract tests for the transcription + diagram plane:
//   /api/scribe/transcript (POST/GET)  – utterances in, tail out, cursor stamping
//   /api/canvas/shape                  – geo/text/note/arrow create, update, delete
//   /api/av/token?role=    – subscribe-only scribe tokens
// Boots the express app in-process via createSyncApp, same style as
// canvas-api.test.ts. Run with: bun src/scribe-api.test.ts
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { schema } from './schema.ts'
import { makeTestClient } from './test-helpers.ts'

const FRAME_ID = 'shape:frame-drafting'

async function main() {
	// LiveKit config is captured when createSyncApp() constructs the
	// MediaService (kernel/media.ts), so the env just needs setting before
	// createSyncApp — the dynamic import below is vestigial (kept to avoid
	// churn). The keys are fakes — we only decode the JWT locally, nothing
	// talks to a real LiveKit server.
	process.env.LIVEKIT_API_KEY = 'testkey'
	process.env.LIVEKIT_API_SECRET = 'testsecret-testsecret-testsecret'
	process.env.LIVEKIT_URL = 'wss://example.test/livekit'
	const { createSyncApp } = await import('./app.ts')
	const { parseStamp } = await import('@ensembleworks/contracts')

	// 0. parseStamp is the server's trust boundary for client-asserted presence
	// meta — it must reject garbage and non-finite numbers without throwing.
	{
		assert.equal(parseStamp(undefined), null, 'undefined ⇒ null')
		assert.equal(parseStamp(null), null, 'null ⇒ null')
		assert.equal(parseStamp({}), null, 'no at ⇒ null')
		assert.equal(parseStamp({ at: { x: 'a', y: 2 } }), null, 'non-numeric at ⇒ null')
		assert.equal(parseStamp({ at: { x: 1e400, y: 2 } }), null, 'Infinity at ⇒ null')
		assert.deepEqual(
			parseStamp({ at: { x: 1200.6, y: 300.4 }, frame: null }),
			{ at: { x: 1201, y: 300 }, frame: null },
			'rounds at, null frame passes'
		)
		assert.deepEqual(
			parseStamp({ at: { x: 10, y: 20 }, frame: { name: 'F', dist: -5 } }),
			{ at: { x: 10, y: 20 }, frame: { name: 'F', dist: 0 } },
			'negative dist floored to 0'
		)
		assert.equal(
			parseStamp({ at: { x: 1, y: 2 }, frame: { name: 5, dist: 3 } })!.frame,
			null,
			'non-string frame.name ⇒ frame null'
		)
		console.log('ok: parseStamp rejects garbage and non-finite input')
	}

	const dataDir = await mkdtemp(path.join(os.tmpdir(), 'scribe-api-test-'))
	const { server, getOrCreateRoom } = createSyncApp({ dataDir })
	await new Promise<void>((resolve) => server.listen(0, resolve))
	const address = server.address()
	assert.ok(address && typeof address === 'object', 'server.listen(0) should yield a port')
	const base = `http://127.0.0.1:${address.port}`

	const { postJson, getJson } = makeTestClient(base)

	// Seed: one frame at a known spot so cursor stamping has a target.
	const room = getOrCreateRoom('test')
	await room.updateStore((store) => {
		store.put({
			id: FRAME_ID,
			typeName: 'shape',
			type: 'frame',
			x: 1000,
			y: 0,
			rotation: 0,
			isLocked: false,
			opacity: 1,
			meta: {},
			props: { w: 800, h: 600, name: 'Drafting — crew-a', color: 'black' },
			parentId: 'page:page',
			index: 'a1',
		} as any)
	})
	const documents = () => room.getCurrentSnapshot().documents.map((d) => d.state as any)

	// 1. Transcript append without presence: no cursor, no frame, t stamped.
	{
		const res = await postJson('/api/scribe/transcript', {
			room: 'test',
			identity: 'alice',
			name: 'Alice',
			text: 'let us start with the retry bug',
		})
		assert.equal(res.status, 200, 'transcript append should be 200')
		assert.equal(res.body.ok, true)
		assert.equal(res.body.entry.name, 'Alice')
		assert.equal(res.body.entry.cursor, null, 'no tab open ⇒ no cursor stamp')
		assert.equal(res.body.entry.frame, null, 'no cursor ⇒ no frame stamp')
		assert.ok(typeof res.body.entry.t === 'number' && res.body.entry.t > 0, 't is server-stamped')
		console.log('ok: transcript append without presence')
	}

	// 2. Transcript edge cases.
	{
		const noIdentity = await postJson('/api/scribe/transcript', { room: 'test', text: 'hi' })
		assert.equal(noIdentity.status, 400, 'missing identity is 400')
		const emptyText = await postJson('/api/scribe/transcript', { room: 'test', identity: 'a', text: '  ' })
		assert.equal(emptyText.status, 400, 'empty text is 400')
		console.log('ok: transcript edge cases (missing identity, empty text)')
	}

	// 3. since/limit windowing with explicit timestamps.
	{
		await postJson('/api/scribe/transcript', { room: 'win', identity: 'a', text: 'first', t: 100 })
		await postJson('/api/scribe/transcript', { room: 'win', identity: 'a', text: 'second', t: 200 })
		await postJson('/api/scribe/transcript', { room: 'win', identity: 'a', text: 'third', t: 300 })

		const all = await getJson('/api/scribe/transcript?room=win')
		assert.equal(all.status, 200)
		assert.deepEqual(
			all.body.entries.map((e: any) => e.text),
			['first', 'second', 'third'],
			'entries come back oldest-first'
		)
		assert.ok(typeof all.body.now === 'number', 'response carries the server clock')

		const since = await getJson('/api/scribe/transcript?room=win&since=150')
		assert.deepEqual(
			since.body.entries.map((e: any) => e.text),
			['second', 'third'],
			'since filters strictly t > since'
		)

		const limited = await getJson('/api/scribe/transcript?room=win&limit=1')
		assert.deepEqual(
			limited.body.entries.map((e: any) => e.text),
			['third'],
			'limit keeps the most recent entries'
		)
		console.log('ok: transcript since/limit windowing')
	}

	// 4. Spatial stamping: the speaker's browser computes {at, frame} from its
	// own CRDT replica and publishes it as presence.meta.stamp; the server
	// echoes it onto the transcript entry verbatim. The stamp's `at` is
	// deliberately offset from the raw cursor to prove no server geometry runs.
	// The scribe posts the raw LiveKit identity ("speaker-1") while tldraw
	// presence stores the prefixed userId ("user:speaker-1"); the stamp must
	// match across that prefix.
	{
		const ws = await new Promise<WebSocket>((resolve, reject) => {
			const s = new WebSocket(
				`ws://127.0.0.1:${address.port}/sync/test?sessionId=tab1&storeId=s1&userId=speaker-1`
			)
			s.once('open', () => resolve(s))
			s.once('error', reject)
		})
		const connected = new Promise<void>((resolve) =>
			ws.on('message', (d) => {
				if (JSON.parse(d.toString()).type === 'connect') resolve()
			})
		)
		ws.send(
			JSON.stringify({
				type: 'connect', connectRequestId: 'r1', lastServerClock: 0, protocolVersion: 8,
				schema: schema.serialize(),
			})
		)
		await connected
		ws.send(
			JSON.stringify({
				type: 'push', clock: 1,
				presence: ['put', {
					userId: 'user:speaker-1', userName: 'Speaker One', color: '#FF0000', currentPageId: 'page:page',
					cursor: { x: 1200, y: 300, type: 'default', rotation: 0 },
					camera: { x: 0, y: 0, z: 1 }, selectedShapeIds: [], screenBounds: { x: 0, y: 0, w: 1, h: 1 },
					lastActivityTimestamp: 10, followingUserId: null, brush: null, scribbles: [], chatMessage: '',
					meta: { stamp: { at: { x: 1201, y: 301 }, frame: { name: 'Drafting — crew-a', dist: 0 } } },
				}],
			})
		)
		await new Promise((r) => setTimeout(r, 300))

		const res = await postJson('/api/scribe/transcript', {
			room: 'test',
			identity: 'speaker-1',
			name: 'Speaker One',
			text: 'I think the spec is too loose here',
		})
		assert.equal(res.status, 200)
		assert.deepEqual(res.body.entry.cursor, { x: 1201, y: 301 }, 'stamp.at echoed, not the raw cursor')
		assert.equal(res.body.entry.page, 'page:page')
		assert.equal(res.body.entry.frame.name, 'Drafting — crew-a', 'stamp.frame echoed')
		assert.equal(res.body.entry.frame.dist, 0)
		ws.close()
		await new Promise((r) => setTimeout(r, 100))
		console.log('ok: transcript echoes the client-computed presence stamp')
	}

	// 4b. Stampless presence (a tab still on a pre-stamp bundle): page is
	// stamped from presence, but cursor/frame are null — same as no tab open.
	// No server-side geometry fallback by design (spec decision 2).
	{
		const ws = await new Promise<WebSocket>((resolve, reject) => {
			const s = new WebSocket(
				`ws://127.0.0.1:${address.port}/sync/test?sessionId=tab2&storeId=s1&userId=speaker-2`
			)
			s.once('open', () => resolve(s))
			s.once('error', reject)
		})
		const connected = new Promise<void>((resolve) =>
			ws.on('message', (d) => {
				if (JSON.parse(d.toString()).type === 'connect') resolve()
			})
		)
		ws.send(
			JSON.stringify({
				type: 'connect', connectRequestId: 'r2', lastServerClock: 0, protocolVersion: 8,
				schema: schema.serialize(),
			})
		)
		await connected
		ws.send(
			JSON.stringify({
				type: 'push', clock: 1,
				presence: ['put', {
					userId: 'user:speaker-2', userName: 'Speaker Two', color: '#00FF00', currentPageId: 'page:page',
					cursor: { x: 1200, y: 300, type: 'default', rotation: 0 },
					camera: { x: 0, y: 0, z: 1 }, selectedShapeIds: [], screenBounds: { x: 0, y: 0, w: 800, h: 200 },
					lastActivityTimestamp: 20, followingUserId: null, brush: null, scribbles: [], chatMessage: '', meta: {},
				}],
			})
		)
		await new Promise((r) => setTimeout(r, 300))

		const res = await postJson('/api/scribe/transcript', {
			room: 'test',
			identity: 'speaker-2',
			name: 'Speaker Two',
			text: 'I reckon we cut this scope',
		})
		assert.equal(res.status, 200)
		assert.equal(res.body.entry.page, 'page:page', 'page still stamped from presence')
		assert.equal(res.body.entry.cursor, null, 'no stamp ⇒ no cursor (no server geometry fallback)')
		assert.equal(res.body.entry.frame, null, 'no stamp ⇒ no frame')
		ws.close()
		await new Promise((r) => setTimeout(r, 100))
		console.log('ok: stampless presence yields page-only stamp')
	}

	// 5. Shape create: a geo node inside the frame.
	let nodeA = ''
	let nodeB = ''
	{
		const res = await postJson('/api/canvas/shape', {
			room: 'test',
			type: 'geo',
			frame: 'drafting',
			x: 40,
			y: 40,
			text: 'retry bug',
			color: 'blue',
		})
		assert.equal(res.status, 200, 'geo create should be 200')
		nodeA = res.body.id
		const geo = documents().find((r) => r.id === nodeA)
		assert.ok(geo, 'geo shape exists in the snapshot')
		assert.equal(geo.type, 'geo')
		assert.equal(geo.parentId, FRAME_ID, 'geo is parented to the fuzzy-matched frame')
		assert.equal(geo.props.geo, 'rectangle', 'geo defaults to rectangle')
		assert.ok(JSON.stringify(geo.props.richText).includes('retry bug'), 'label text lands')

		const res2 = await postJson('/api/canvas/shape', {
			room: 'test',
			type: 'geo',
			geo: 'ellipse',
			x: 400,
			y: 200,
			text: 'add backoff',
		})
		assert.equal(res2.status, 200)
		nodeB = res2.body.id
		const ellipse = documents().find((r) => r.id === nodeB)
		assert.equal(ellipse.parentId, 'page:page', 'no frame ⇒ parented to the page')
		assert.equal(ellipse.props.geo, 'ellipse')
		console.log('ok: shape create (geo in frame, ellipse on page)')
	}

	// 6. Arrow create binds both terminals so the connector follows the nodes.
	let arrowId = ''
	{
		const res = await postJson('/api/canvas/shape', {
			room: 'test',
			type: 'arrow',
			fromId: nodeA,
			toId: nodeB,
			text: 'because',
		})
		assert.equal(res.status, 200, 'arrow create should be 200')
		arrowId = res.body.id
		const arrow = documents().find((r) => r.id === arrowId)
		assert.ok(arrow, 'arrow shape exists')
		assert.equal(arrow.type, 'arrow')
		const bindings = documents().filter((r) => r.typeName === 'binding' && r.fromId === arrowId)
		assert.equal(bindings.length, 2, 'arrow gets start + end bindings')
		assert.deepEqual(
			bindings.map((b: any) => b.props.terminal).sort(),
			['end', 'start'],
			'one binding per terminal'
		)
		assert.deepEqual(
			bindings.map((b: any) => b.toId).sort(),
			[nodeA, nodeB].sort(),
			'bindings point at the two nodes'
		)

		const dangling = await postJson('/api/canvas/shape', {
			room: 'test',
			type: 'arrow',
			fromId: nodeA,
			toId: 'shape:does-not-exist',
		})
		assert.equal(dangling.status, 404, 'arrow to a missing shape is 404')
		console.log('ok: arrow create with real tldraw bindings')
	}

	// 7. Shape update: move a node and change its label.
	{
		const res = await postJson('/api/canvas/shape', {
			room: 'test',
			op: 'update',
			id: nodeB,
			x: 500,
			text: 'add backoff + jitter',
			color: 'green',
		})
		assert.equal(res.status, 200, 'update should be 200')
		const ellipse = documents().find((r) => r.id === nodeB)
		assert.equal(ellipse.x, 500, 'x moved')
		assert.equal(ellipse.props.color, 'green', 'color updated')
		assert.ok(JSON.stringify(ellipse.props.richText).includes('jitter'), 'label updated')

		const missing = await postJson('/api/canvas/shape', { room: 'test', op: 'update', id: 'shape:nope', text: 'x' })
		assert.equal(missing.status, 404, 'updating a missing shape is 404')
		console.log('ok: shape update (position, colour, label)')
	}

	// 8. Create edge cases.
	{
		const badType = await postJson('/api/canvas/shape', { room: 'test', type: 'star-chart' })
		assert.equal(badType.status, 400, 'unknown type is 400')
		const badGeo = await postJson('/api/canvas/shape', { room: 'test', type: 'geo', geo: 'dodecahedron' })
		assert.equal(badGeo.status, 400, 'unknown geo is 400')
		const badColor = await postJson('/api/canvas/shape', { room: 'test', type: 'note', text: 'x', color: 'mauve' })
		assert.equal(badColor.status, 400, 'unknown colour is 400')
		const noFrame = await postJson('/api/canvas/shape', { room: 'test', type: 'geo', frame: 'no-such-frame' })
		assert.equal(noFrame.status, 404, 'unknown frame is 404')
		const noText = await postJson('/api/canvas/shape', { room: 'test', type: 'text' })
		assert.equal(noText.status, 400, 'text shape without text is 400')
		console.log('ok: shape create edge cases')
	}

	// 9. Delete cascades bindings that touch the deleted shape.
	{
		const res = await postJson('/api/canvas/shape', { room: 'test', op: 'delete', id: nodeA })
		assert.equal(res.status, 200, 'delete should be 200')
		assert.ok(res.body.deleted >= 2, 'node + its binding are deleted')
		assert.ok(!documents().some((r) => r.id === nodeA), 'node is gone')
		assert.ok(
			!documents().some(
				(r) => r.typeName === 'binding' && (r.fromId === nodeA || r.toId === nodeA)
			),
			'no binding still references the deleted node'
		)
		assert.ok(documents().some((r) => r.id === arrowId), 'the arrow shape itself survives')

		const missing = await postJson('/api/canvas/shape', { room: 'test', op: 'delete', id: 'shape:nope' })
		assert.equal(missing.status, 404, 'deleting a missing shape is 404')
		console.log('ok: shape delete cascades bindings')
	}

	// 10. role=scribe mints a subscribe-only token.
	{
		const res = await getJson('/api/av/token?room=test&identity=scribe-bot&name=Scribe&role=scribe')
		assert.equal(res.status, 200)
		assert.equal(res.body.enabled, true)
		const payload = JSON.parse(
			Buffer.from(res.body.token.split('.')[1], 'base64url').toString()
		)
		assert.equal(payload.video.roomJoin, true)
		assert.equal(payload.video.canPublish, false, 'scribe tokens cannot publish')
		assert.equal(payload.video.canSubscribe, true, 'scribe tokens can subscribe')

		const member = await getJson('/api/av/token?room=test&identity=alice')
		const memberPayload = JSON.parse(
			Buffer.from(member.body.token.split('.')[1], 'base64url').toString()
		)
		assert.equal(memberPayload.video.canPublish, true, 'default role still publishes')

		const badRole = await getJson('/api/av/token?room=test&identity=x&role=admin')
		assert.equal(badRole.status, 400, 'unknown role is 400')
		console.log('ok: scribe tokens are subscribe-only')
	}

	room.close()
	await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
}

main().then(
	() => {
		console.log('scribe-api.test.ts: all tests passed')
		process.exit(0)
	},
	(err) => {
		console.error(err)
		process.exit(1)
	}
)
