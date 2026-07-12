// Contract tests for Task D3's internal metrics endpoint: GET
// /api/canvas/metrics. Boots the express app in-process via createSyncApp
// (canvas-v2-api.test.ts's pattern) across four scenarios:
//   A. both Phase 2 flags OFF — the route still answers 200 with empty
//      sections (never 404, never gated).
//   B. EW_CANVAS_SHADOW=1 — the clock-polled driver ticks a seeded legacy
//      tldraw room, reflects a live mutation, and does NOT re-tick an idle
//      room (the clock-gate). Uses createSyncApp's shadowIntervalMs test knob
//      (see app.ts) instead of sleeping out a real ~1000ms cadence.
//   C. EW_CANVAS_SYNC=1 — a real ws round trip populates sync.<room> counters;
//      a poisoned frame bumps malformedFrames.
//   D. an evicted, tainted canvas-v2 actor's history survives in
//      evictions.<room> (reusing actors.test.ts's taint-injection pattern).
// Run with: bun src/features/canvas-metrics.test.ts
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { makePair, SyncClientPeer } from '@ensembleworks/canvas-sync'
import WebSocket from 'ws'
import { createSyncApp } from '../app.ts'

function openWs(url: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url)
		let settled = false
		ws.on('open', () => {
			if (settled) return
			settled = true
			resolve(ws)
		})
		ws.on('error', (err) => {
			if (settled) return
			settled = true
			reject(err)
		})
	})
}

async function getMetrics(base: string): Promise<any> {
	const r = await fetch(`${base}/api/canvas/metrics`)
	assert.equal(r.status, 200, 'GET /api/canvas/metrics is always 200')
	return r.json()
}

async function main() {
	// -------------------------------------------------------------------------
	// A — both flags OFF: empty sections, not a 404, not gated on either flag.
	// -------------------------------------------------------------------------
	{
		const dataDir = await mkdtemp(path.join(os.tmpdir(), 'canvas-metrics-off-'))
		assert.equal(process.env.EW_CANVAS_SHADOW, undefined, 'precondition: shadow flag unset')
		assert.equal(process.env.EW_CANVAS_SYNC, undefined, 'precondition: sync flag unset')
		const { server } = createSyncApp({ dataDir })
		await new Promise<void>((r) => server.listen(0, r))
		const base = `http://127.0.0.1:${(server.address() as any).port}`

		const body = await getMetrics(base)
		assert.deepEqual(body, { ok: true, shadow: {}, sync: {}, evictions: {} }, 'flags off: empty envelope, ok:true')

		await new Promise<void>((r) => server.close(() => r()))
		await rm(dataDir, { recursive: true, force: true })
		console.log('ok: canvas-metrics — both flags off returns { ok: true, shadow: {}, sync: {}, evictions: {} }')
	}

	// -------------------------------------------------------------------------
	// B — EW_CANVAS_SHADOW=1: driver ticks a seeded room, reflects a mutation,
	// and leaves an idle room's tick count stable across sweeps.
	// -------------------------------------------------------------------------
	{
		const dataDir = await mkdtemp(path.join(os.tmpdir(), 'canvas-metrics-shadow-'))
		process.env.EW_CANVAS_SHADOW = '1'
		let server: import('node:http').Server
		try {
			;({ server } = createSyncApp({ dataDir, shadowIntervalMs: 25 }))
			await new Promise<void>((r) => server.listen(0, r))
			const base = `http://127.0.0.1:${(server.address() as any).port}`
			const roomId = 'sroom'

			const post = (b: any): Promise<any> =>
				fetch(`${base}/api/canvas/shape`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ room: roomId, ...b }),
				}).then((r) => r.json())

			const created = await post({ type: 'note', text: 'one' })
			assert.ok(created.ok, 'seeded shape one')

			// Wait for the driver to tick this room at least once and reflect it.
			let metrics: any = await pollUntil(async () => {
				const m = await getMetrics(base)
				return m.shadow[roomId] && m.shadow[roomId].ticks >= 1 ? m : null
			})

			assert.equal(metrics.shadow[roomId].shapeCount, 1, 'mirror shapeCount matches the one seeded shape')
			const ticksAfterFirst = metrics.shadow[roomId].ticks

			// Idle stability: no mutation, wait a few sweep intervals, ticks unchanged.
			await new Promise((r) => setTimeout(r, 25 * 6))
			const idleMetrics = await getMetrics(base)
			assert.equal(idleMetrics.shadow[roomId].ticks, ticksAfterFirst, 'an idle room (unchanged clock) does not re-tick')

			// Mutate: seed a second shape, expect the next tick to reflect it.
			const created2 = await post({ type: 'note', text: 'two' })
			assert.ok(created2.ok, 'seeded shape two')
			const afterMutate = await pollUntil(async () => {
				const m = await getMetrics(base)
				return m.shadow[roomId].shapeCount === 2 ? m : null
			})
			assert.ok(afterMutate.shadow[roomId].ticks > ticksAfterFirst, 'a mutation triggers a fresh tick')
			assert.equal(afterMutate.shadow[roomId].shapeCount, 2, 'mirror shapeCount reflects the mutation')

			console.log('ok: canvas-metrics — shadow driver ticks on clock change, reflects mutations, idles cleanly')
		} finally {
			delete process.env.EW_CANVAS_SHADOW
			if (server!) await new Promise<void>((r) => server.close(() => r()))
			await rm(dataDir, { recursive: true, force: true })
		}
	}

	// -------------------------------------------------------------------------
	// C — EW_CANVAS_SYNC=1: a real ws round trip populates sync.<room>; a
	// poisoned frame bumps malformedFrames (canvas-v2-sync-mount.test.ts's
	// poison pattern).
	// -------------------------------------------------------------------------
	{
		const dataDir = await mkdtemp(path.join(os.tmpdir(), 'canvas-metrics-sync-'))
		process.env.EW_CANVAS_SYNC = '1'
		let server: import('node:http').Server
		try {
			;({ server } = createSyncApp({ dataDir }))
			await new Promise<void>((r) => server.listen(0, r))
			const port = (server.address() as any).port
			const base = `http://127.0.0.1:${port}`
			const roomId = 'vroom'

			const ws = await openWs(`ws://127.0.0.1:${port}/sync/v2/${roomId}`)
			// Wait for the actor to actually register (connect is async over the
			// upgrade callback) by polling metrics until sync.<room> appears.
			let metrics = await pollUntil(async () => {
				const m = await getMetrics(base)
				return m.sync[roomId] ? m : null
			})
			assert.deepEqual(
				metrics.sync[roomId],
				{ pendingImports: 0, malformedFrames: 0, tainted: null },
				'a healthy v2 room reports zeroed counters and no taint'
			)

			ws.send(new Uint8Array(0)) // zero-byte binary frame: decode() throws 'empty frame'
			metrics = await pollUntil(async () => {
				const m = await getMetrics(base)
				return m.sync[roomId].malformedFrames === 1 ? m : null
			})
			assert.equal(metrics.sync[roomId].malformedFrames, 1, 'a poisoned frame is counted via the metrics endpoint')

			ws.close()
			console.log('ok: canvas-metrics — sync section reports live v2-actor counters, incl. malformed frames')
		} finally {
			delete process.env.EW_CANVAS_SYNC
			if (server!) await new Promise<void>((r) => server.close(() => r()))
			await rm(dataDir, { recursive: true, force: true })
		}
	}

	// -------------------------------------------------------------------------
	// D — an evicted, tainted actor's history survives in evictions.<room>
	// (actors.test.ts's taint-injection pattern, driven through the app's
	// exposed canvasActors so the metrics endpoint serves the same registry).
	// -------------------------------------------------------------------------
	{
		const dataDir = await mkdtemp(path.join(os.tmpdir(), 'canvas-metrics-evict-'))
		process.env.EW_CANVAS_SYNC = '1'
		let server: import('node:http').Server
		try {
			let canvasActors: ReturnType<typeof createSyncApp>['canvasActors']
			;({ server, canvasActors } = createSyncApp({ dataDir }))
			assert.ok(canvasActors, 'flag on: createSyncApp exposes the live canvasActors registry')
			await new Promise<void>((r) => server.listen(0, r))
			const base = `http://127.0.0.1:${(server.address() as any).port}`
			const roomId = 'eroom'

			const actor = canvasActors.getOrCreate(roomId)
			const [serverTransport, clientTransport] = makePair()
			actor.connect(serverTransport)
			const client = new SyncClientPeer({ peerId: 2n, transport: clientTransport })

			const store = (actor as unknown as { store: { appendUpdate: () => void; compact: () => void } }).store
			store.appendUpdate = () => {
				throw new Error('disk hiccup (injected, metrics eviction test)')
			}
			store.compact = () => {
				throw new Error('disk hiccup (injected, compact, metrics eviction test)')
			}
			client.putShape({
				id: 'shape:poisoned',
				kind: 'note',
				parentId: 'page:p',
				index: 'a1',
				x: 0,
				y: 0,
				rotation: 0,
				isLocked: false,
				opacity: 1,
				meta: {},
				props: {},
			} as any)
			assert.ok(actor.tainted, 'precondition: the actor is tainted')

			// getOrCreate evicts the tainted actor and records the eviction.
			canvasActors.getOrCreate(roomId)

			const metrics = await getMetrics(base)
			assert.ok(metrics.evictions[roomId], 'the metrics endpoint surfaces the eviction record')
			assert.equal(metrics.evictions[roomId].count, 1, 'one eviction recorded')
			assert.match(
				metrics.evictions[roomId].lastReason,
				/disk hiccup \(injected, metrics eviction test\)/,
				'lastReason carries the taint message'
			)
			// The replacement actor is healthy — sync.<room>.tainted must read null,
			// which is exactly why the eviction record above is load-bearing.
			assert.equal(metrics.sync[roomId].tainted, null, 'the fresh replacement actor reports healthy')

			console.log('ok: canvas-metrics — evictions.<room> survives a tainted-actor replacement')
		} finally {
			delete process.env.EW_CANVAS_SYNC
			if (server!) await new Promise<void>((r) => server.close(() => r()))
			await rm(dataDir, { recursive: true, force: true })
		}
	}

	console.log('canvas-metrics.test.ts: all tests passed')
	process.exit(0) // createSyncApp's intervals keep the loop alive (house pattern: whoami-api, canvas-api)
}

async function pollUntil<T>(fn: () => Promise<T | null>, timeoutMs = 3000): Promise<T> {
	const start = Date.now()
	for (;;) {
		const v = await fn()
		if (v) return v
		if (Date.now() - start > timeoutMs) throw new Error('pollUntil: timed out')
		await new Promise((r) => setTimeout(r, 15))
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
