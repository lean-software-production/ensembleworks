// Boots the app, opens a real sync socket, POSTs present events and asserts
// (a) the relay round-trips via GET backlog, (b) the connected socket
// receives the ew-rrweb custom message. Run with: bun src/present-relay-api.test.ts
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as syncCore from '@tldraw/sync-core'
import WebSocket from 'ws'
import { createSyncApp } from './app.ts'
import { schema } from './schema.ts'
import { makeTestClient } from './test-helpers.ts'

async function main() {
	const dataDir = await mkdtemp(path.join(os.tmpdir(), 'present-relay-api-'))
	const { server, getOrCreateRoom } = createSyncApp({ dataDir })
	await new Promise<void>((resolve) => server.listen(0, resolve))
	const address = server.address()
	assert.ok(address && typeof address === 'object')
	const base = `http://127.0.0.1:${address.port}`
	const { postJson, getJson } = makeTestClient(base)

	getOrCreateRoom('relaytest')

	// Connect one sync session; collect raw frames to spot the custom message.
	const frames: string[] = []
	const ws = new WebSocket(`ws://127.0.0.1:${address.port}/sync/relaytest?userId=u1&sessionId=s1`)
	ws.on('message', (data) => frames.push(String(data)))
	await new Promise<void>((resolve, reject) => {
		ws.once('open', () => resolve())
		ws.once('error', reject)
	})
	// sendCustomMessage only reaches sessions in the sync protocol's Connected
	// state, which requires a real "connect" handshake (not just an open
	// socket) — mirror the client side of TLSyncRoom.handleConnectRequest.
	ws.send(
		JSON.stringify({
			type: 'connect',
			connectRequestId: 'test-connect-1',
			lastServerClock: 0,
			// getTlsyncProtocolVersion is deliberately excluded from the package's
			// public .d.ts (internal API) — reach it at runtime via the namespace
			// import rather than a typed named import.
			protocolVersion: (syncCore as any).getTlsyncProtocolVersion(),
			schema: schema.serialize(),
		})
	)
	await new Promise((r) => setTimeout(r, 300)) // let the session register

	// POST a batch → accepted, fanned out
	const post = await postJson('/api/canvas/file-viewer/present-events', {
		room: 'relaytest',
		shapeId: 'shape:fv1',
		presentId: 'p1',
		entries: [{ seq: 0, event: { type: 4, data: { width: 720, height: 500 } } }],
	})
	assert.equal(post.status, 200)
	assert.equal(post.body.ok, true)

	// Backlog round-trips
	const backlog = await getJson('/api/canvas/file-viewer/present-events?room=relaytest&shapeId=shape%3Afv1')
	assert.equal(backlog.status, 200)
	assert.equal(backlog.body.presentId, 'p1')
	assert.equal(backlog.body.entries.length, 1)

	// The sync socket saw the custom message
	await new Promise((r) => setTimeout(r, 300))
	assert.ok(
		frames.some((f) => f.includes('ew-rrweb') && f.includes('shape:fv1')),
		`expected an ew-rrweb frame, got: ${frames.slice(-3).join('\n')}`
	)

	// Stop is now a no-op — log survives as the frozen last view
	const stop = await postJson('/api/canvas/file-viewer/present-stop', {
		room: 'relaytest',
		shapeId: 'shape:fv1',
		presentId: 'p1',
	})
	assert.equal(stop.status, 200)
	assert.equal(stop.body.ok, true)
	const after = await getJson('/api/canvas/file-viewer/present-events?room=relaytest&shapeId=shape%3Afv1')
	assert.equal(after.body.presentId, 'p1', 'log survives present-stop as frozen view')
	assert.equal(after.body.entries.length, 1)

	// Malformed body → 400
	const bad = await postJson('/api/canvas/file-viewer/present-events', { room: 'relaytest' })
	assert.equal(bad.status, 400)

	// Unknown room → 404, no append attempted.
	const unknownRoom = await postJson('/api/canvas/file-viewer/present-events', {
		room: 'no-such-room',
		shapeId: 'shape:fv1',
		presentId: 'p1',
		entries: [{ seq: 0, event: { type: 4 } }],
	})
	assert.equal(unknownRoom.status, 404)

	// A batch well over the app-wide express.json 100kb default is still
	// accepted — present-events gets its own larger-limit parser.
	const bigEvent = { seq: 0, event: { type: 2, data: 'x'.repeat(500_000) } }
	const bigBatch = await postJson('/api/canvas/file-viewer/present-events', {
		room: 'relaytest',
		shapeId: 'shape:fv2',
		presentId: 'pbig',
		entries: [bigEvent],
	})
	assert.equal(bigBatch.status, 200)
	assert.equal(bigBatch.body.ok, true)
	assert.equal(bigBatch.body.truncated, false)

	// Overflowing the relay's per-log byte cap (5MB) in one POST trips
	// truncation immediately, and fans out ONE final message with no entries
	// so a connected follower can degrade instead of stalling.
	frames.length = 0
	const hugeEvent = { seq: 0, event: { type: 2, data: 'z'.repeat(5_500_000) } }
	const overflow = await postJson('/api/canvas/file-viewer/present-events', {
		room: 'relaytest',
		shapeId: 'shape:fv3',
		presentId: 'pover',
		entries: [hugeEvent],
	})
	assert.equal(overflow.status, 200)
	assert.equal(overflow.body.truncated, true)
	await new Promise((r) => setTimeout(r, 300))
	const truncatedFrame = frames.find((f) => f.includes('ew-rrweb') && f.includes('shape:fv3'))
	assert.ok(truncatedFrame, `expected a truncated ew-rrweb frame, got: ${frames.slice(-3).join('\n')}`)
	assert.ok(truncatedFrame!.includes('"truncated":true'))
	assert.ok(truncatedFrame!.includes('"entries":[]'))

	ws.close()
	await new Promise<void>((resolve, reject) =>
		server.close((err) => (err ? reject(err) : resolve()))
	)
	console.log('present-relay-api tests passed')
}

main().then(
	() => process.exit(0),
	(err) => {
		console.error(err)
		process.exit(1)
	}
)
