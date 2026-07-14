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
//   E. sweep isolation — one room whose getCurrentDocumentClock() throws (a
//      realistic SQLite failure: sync-core's SQLiteSyncStorage.getClock runs a
//      live prepared-statement query) must NOT kill the process or starve the
//      other rooms' mirrors; the driver counts it in the top-level sweepErrors.
// Scenarios B and C double as the flag-matrix corner pins: B is SHADOW-only
// (sync must stay {}), C is SYNC-only (shadow must stay {}).
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
		assert.deepEqual(
			body,
			{ ok: true, shadow: {}, sync: {}, evictions: {}, sweepErrors: 0 },
			'flags off: empty envelope, ok:true'
		)

		await new Promise<void>((r) => server.close(() => r()))
		await rm(dataDir, { recursive: true, force: true })
		console.log('ok: canvas-metrics — both flags off returns the empty envelope (ok, {}, {}, {}, sweepErrors 0)')
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

			// Flag-matrix corner (SHADOW-only): the sync/evictions sections stay
			// empty — no canvas-v2 registry exists without EW_CANVAS_SYNC.
			assert.deepEqual(afterMutate.sync, {}, 'SHADOW-only: sync section stays empty')
			assert.deepEqual(afterMutate.evictions, {}, 'SHADOW-only: evictions section stays empty')

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

			// Flag-matrix corner (SYNC-only): the shadow section stays empty — no
			// shadow driver exists without EW_CANVAS_SHADOW.
			assert.deepEqual(metrics.shadow, {}, 'SYNC-only: shadow section stays empty')

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
			assert.equal(metrics.evictions[roomId].taintCount, 1, 'one taint eviction recorded')
			assert.match(
				metrics.evictions[roomId].lastTaintReason,
				/disk hiccup \(injected, metrics eviction test\)/,
				'lastTaintReason carries the taint message'
			)
			assert.equal(metrics.evictions[roomId].idleCount, 0, 'no idle eviction yet')
			assert.equal(metrics.evictions[roomId].lastIdleReason, null, 'no idle reason yet')
			// The replacement actor is healthy — sync.<room>.tainted must read null,
			// which is exactly why the eviction record above is load-bearing.
			assert.equal(metrics.sync[roomId].tainted, null, 'the fresh replacement actor reports healthy')

			console.log('ok: canvas-metrics — evictions.<room> survives a tainted-actor replacement')

			// The 3am-operator sequence, through the HTTP payload: the healthy
			// replacement idle-evicts some time later (routine F1 housekeeping —
			// zero connections; TTL 0 makes this very sweep evict it). The taint
			// side of the record must survive UNCHANGED: an alarm keyed on
			// taintCount > 0 / lastTaintReason must be immune to idle churn, or
			// the durability-loss incident becomes indistinguishable from
			// ordinary idle patterns the moment the replacement ages out.
			canvasActors.sweepIdle(0)
			const after = await getMetrics(base)
			assert.equal(after.evictions[roomId].taintCount, 1, 'STICKY: the idle eviction did not touch taintCount')
			assert.match(
				after.evictions[roomId].lastTaintReason,
				/disk hiccup \(injected, metrics eviction test\)/,
				'STICKY: lastTaintReason still names the incident after the idle eviction'
			)
			assert.equal(after.evictions[roomId].idleCount, 1, 'the idle eviction counts on its own idleCount')
			assert.match(after.evictions[roomId].lastIdleReason, /idle/, 'lastIdleReason describes the idle cause')
			// The actor itself is gone from the live registry — its sync-section
			// entry disappears with it, which is exactly why the eviction record
			// must carry the history.
			assert.equal(after.sync[roomId], undefined, 'the idle-evicted actor no longer appears in the sync section')

			console.log('ok: canvas-metrics — taint history is sticky through a later idle eviction of the replacement')
		} finally {
			delete process.env.EW_CANVAS_SYNC
			if (server!) await new Promise<void>((r) => server.close(() => r()))
			await rm(dataDir, { recursive: true, force: true })
		}
	}

	// -------------------------------------------------------------------------
	// E — sweep isolation: one room whose clock read throws must not kill the
	// process (an unguarded throw inside the driver's setInterval is an
	// uncaught exception — fatal to HTTP/WS/AV and every other room's mirror).
	// The healthy room's mirror must keep advancing, and the driver counts the
	// failure in the top-level sweepErrors.
	// -------------------------------------------------------------------------
	{
		const dataDir = await mkdtemp(path.join(os.tmpdir(), 'canvas-metrics-sweeperr-'))
		process.env.EW_CANVAS_SHADOW = '1'
		let server: import('node:http').Server
		try {
			let getOrCreateRoom: ReturnType<typeof createSyncApp>['getOrCreateRoom']
			;({ server, getOrCreateRoom } = createSyncApp({ dataDir, shadowIntervalMs: 25 }))
			await new Promise<void>((r) => server.listen(0, r))
			const base = `http://127.0.0.1:${(server.address() as any).port}`

			const post = (room: string, text: string): Promise<any> =>
				fetch(`${base}/api/canvas/shape`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ room, type: 'note', text }),
				}).then((r) => r.json())

			// Seed two rooms (opens both in roomHost), then poison ONE room's clock
			// getter on the memoized TLSocketRoom instance — the same instance the
			// driver reads every sweep. Realistic failure mode: the real getter runs
			// a live SQLite prepared-statement query (SQLiteSyncStorage.getClock),
			// so a disk error throws exactly here.
			assert.ok((await post('goodroom', 'g1')).ok, 'seeded goodroom')
			assert.ok((await post('badroom', 'b1')).ok, 'seeded badroom')
			getOrCreateRoom('badroom').getCurrentDocumentClock = () => {
				throw new Error('sqlite disk error (injected clock read)')
			}

			// The poisoned room now throws on EVERY sweep. The process must survive
			// it, and the healthy room's mirror must still track a fresh mutation.
			const before = await pollUntil(async () => {
				const m = await getMetrics(base)
				return m.shadow.goodroom && m.shadow.goodroom.ticks >= 1 ? m : null
			})
			assert.ok((await post('goodroom', 'g2')).ok, 'mutated goodroom while badroom is poisoned')
			const after = await pollUntil(async () => {
				const m = await getMetrics(base)
				return m.shadow.goodroom.shapeCount === 2 ? m : null
			})
			assert.ok(
				after.shadow.goodroom.ticks > before.shadow.goodroom.ticks,
				'the healthy room keeps ticking while another room throws each sweep'
			)
			assert.ok(after.sweepErrors > 0, 'sweepErrors counts the poisoned room\'s failed sweeps')

			console.log('ok: canvas-metrics — one room\'s clock-read failure is isolated; sweepErrors counts it')
		} finally {
			delete process.env.EW_CANVAS_SHADOW
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
