// Run: bun src/canvas-v2/shutdown.test.ts
//
// F2: createSyncApp's graceful-shutdown hook. Boots the app in-process
// (canvas-v2-sync-mount.test.ts's real-ws pattern), connects a REAL ws client
// to /sync/v2 (and, separately, a REAL legacy /sync client — the two share one
// `wss`, and close() must force-close both), mutates so the actor holds
// unpersisted-but-durable data, then calls close() and asserts:
//   - every ws client (legacy AND v2) actually got closed
//   - the canvas-v2 actors registry is emptied (close() tore every actor down)
//   - close() resolves within a bound (never hangs — the documented Phase 2
//     http.Server.close() race is exactly what the bounded fallback guards)
//   - the data survives: a FRESH registry opened over the same databaseDir
//     reloads the mutated content (close-path compact persisted it)
// A second, smaller scenario proves the sweep/interval teardown doesn't throw
// when EW_CANVAS_SHADOW is also on (both intervals get cleared).
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Shape } from '@ensembleworks/canvas-model'
import { SyncClientPeer } from '@ensembleworks/canvas-sync'
import WebSocket from 'ws'
import { createSyncApp } from '../app.ts'
import { createCanvasActors } from './actors.ts'
import { wsTransport } from './ws-transport.ts'

const shape = (id: string): Shape =>
	({
		id,
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
	}) as any

function openWs(url: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url)
		let settled = false
		ws.on('open', () => {
			if (settled) return
			settled = true
			resolve(ws)
		})
		// `.on`, never `.once`/removed: teardown can fire more than one error
		// event, and an EventEmitter throws "Unhandled error" with no listener.
		ws.on('error', (err) => {
			if (settled) return
			settled = true
			reject(err)
		})
	})
}

function waitUntil(pred: () => boolean, timeoutMs = 5000): Promise<void> {
	const start = Date.now()
	return new Promise((resolve, reject) => {
		const tick = () => {
			if (pred()) return resolve()
			if (Date.now() - start > timeoutMs) return reject(new Error('waitUntil: timed out'))
			setTimeout(tick, 20)
		}
		tick()
	})
}

/** Races `p` against `timeoutMs`; throws loudly on timeout rather than hanging
 * the suite (house convention, cf. crash-recovery.test.ts's withDeadline). */
function withDeadline<T>(p: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)), timeoutMs)
	})
	return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>
}

/** Awaits the ws 'close' event (attaching AFTER a call to close() is still
 * safe here — a permanent no-op-after-settle listener catches a same-tick
 * close just as well as a later one, so there is no register/fire race). */
function waitClosed(ws: WebSocket, timeoutMs = 3000): Promise<void> {
	return withDeadline(
		new Promise<void>((resolve) => {
			if (ws.readyState === ws.CLOSED) return resolve()
			ws.once('close', () => resolve())
		}),
		timeoutMs,
		'a ws client to close',
	)
}

async function main() {
	// -------------------------------------------------------------------------
	// A — the full round trip: v2 client mutates, close() tears everything
	// down within its bound, the ws client is closed, the registry is emptied,
	// and the mutated data survives on a fresh registry over the same dir.
	// -------------------------------------------------------------------------
	{
		const dataDir = await mkdtemp(path.join(os.tmpdir(), 'canvas-shutdown-data-'))
		const databaseDir = await mkdtemp(path.join(os.tmpdir(), 'canvas-shutdown-db-'))
		process.env.EW_CANVAS_SYNC = '1'
		try {
			const { server, canvasActors, close } = createSyncApp({ dataDir, databaseDir, shutdownTimeoutMs: 2000 })
			assert.ok(canvasActors, 'flag on: createSyncApp exposes the live canvasActors registry')
			await new Promise<void>((r) => server.listen(0, r))
			const port = (server.address() as { port: number }).port
			const roomId = 'shutdown-room'

			const ws = await openWs(`ws://127.0.0.1:${port}/sync/v2/${roomId}`)
			const client = new SyncClientPeer({ peerId: 2n, transport: wsTransport(ws) })
			client.putShape(shape('shape:survives-shutdown'))

			// Let the write reach and durably persist on the server before we tear
			// it down — proves close-path compaction, not a lucky race.
			await waitUntil(() => canvasActors.getOrCreate(roomId).peer.doc.listShapes().some((s) => s.id === 'shape:survives-shutdown'))
			assert.equal(canvasActors.entries().size, 1, 'precondition: one live actor before shutdown')

			const start = Date.now()
			await withDeadline(close(), 3000, 'close() to resolve')
			const elapsed = Date.now() - start
			assert.ok(elapsed < 3000, `close() resolved within its bound (took ${elapsed}ms)`)

			await waitClosed(ws)
			assert.notEqual(ws.readyState, ws.OPEN, 'the v2 ws client was force-closed by close()')

			assert.equal(canvasActors.entries().size, 0, 'close() emptied the canvas-v2 actors registry')

			// Data survives: a FRESH registry over the SAME databaseDir reloads the
			// mutated content — proof close()'s canvasActors?.close() actually
			// persisted (close-path compact) rather than just dropping state.
			const reopened = createCanvasActors(databaseDir)
			const reloaded = reopened.getOrCreate(roomId)
			assert.deepEqual(
				reloaded.peer.doc.listShapes().map((s) => s.id),
				['shape:survives-shutdown'],
				'a fresh registry over the same dir reloads the durably-persisted shape after shutdown',
			)
			reopened.close()

			console.log('ok: shutdown — close() force-closes the v2 ws client, empties the registry, resolves in-bound, and persists data')
		} finally {
			delete process.env.EW_CANVAS_SYNC
			await rm(dataDir, { recursive: true, force: true })
			await rm(databaseDir, { recursive: true, force: true })
		}
	}

	// -------------------------------------------------------------------------
	// B — the shared `wss`: a LEGACY /sync client is force-closed by the same
	// close() call, not just /sync/v2 clients.
	// -------------------------------------------------------------------------
	{
		const dataDir = await mkdtemp(path.join(os.tmpdir(), 'canvas-shutdown-legacy-data-'))
		const { server, close } = createSyncApp({ dataDir })
		await new Promise<void>((r) => server.listen(0, r))
		const port = (server.address() as { port: number }).port

		const ws = await openWs(`ws://127.0.0.1:${port}/sync/legacy-room?sessionId=s1&userId=u1`)
		await new Promise((r) => setTimeout(r, 50)) // let attachSyncSocket finish wiring the handshake

		await withDeadline(close(), 3000, 'close() to resolve (legacy-only app)')
		await waitClosed(ws)
		assert.notEqual(ws.readyState, ws.OPEN, 'the legacy /sync ws client was force-closed by the same close()')

		console.log('ok: shutdown — close() force-closes legacy /sync clients too (shared wss)')
		await rm(dataDir, { recursive: true, force: true })
	}

	// -------------------------------------------------------------------------
	// C — close() doesn't throw when EW_CANVAS_SHADOW is also on (both the
	// shadow-driver interval and the idle-sweep interval get cleared cleanly).
	// -------------------------------------------------------------------------
	{
		const dataDir = await mkdtemp(path.join(os.tmpdir(), 'canvas-shutdown-shadow-data-'))
		process.env.EW_CANVAS_SYNC = '1'
		process.env.EW_CANVAS_SHADOW = '1'
		try {
			const { server, close } = createSyncApp({ dataDir, shadowIntervalMs: 20, idleSweepIntervalMs: 20 })
			await new Promise<void>((r) => server.listen(0, r))
			await new Promise((r) => setTimeout(r, 60)) // let both intervals fire at least once
			await withDeadline(close(), 3000, 'close() to resolve (both flags on)')
			console.log('ok: shutdown — close() tears down cleanly with both EW_CANVAS_SYNC and EW_CANVAS_SHADOW on')
		} finally {
			delete process.env.EW_CANVAS_SYNC
			delete process.env.EW_CANVAS_SHADOW
			await rm(dataDir, { recursive: true, force: true })
		}
	}

	console.log('shutdown.test.ts: all tests passed')
	process.exit(0)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
