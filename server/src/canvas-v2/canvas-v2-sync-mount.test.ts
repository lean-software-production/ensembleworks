// Run: bun src/canvas-v2/canvas-v2-sync-mount.test.ts
// End-to-end proof for Task C3's reason to exist: a REAL `ws` client, through
// the REAL `wsTransport` adapter, over a REAL `/sync/v2/:roomId` upgrade,
// converges with a second real client AND durably lands on disk via the
// canvas-v2 DocumentActor registry — not just the unit-level fakes exercised
// by ws-transport.test.ts and actors.test.ts.
//
// Also proves the flag-off case: with EW_CANVAS_SYNC unset, `/sync/v2/*` gets
// exactly the SAME treatment the existing upgrade handler already gives any
// unmatched/malformed sync path (destroy the raw socket) — no canvas-v2
// directory is ever created, so a real deployment pays zero cost.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Shape } from '@ensembleworks/canvas-model'
import { SyncClientPeer } from '@ensembleworks/canvas-sync'
import WebSocket from 'ws'
import { createSyncApp } from '../app.ts'
import { wsTransport } from './ws-transport.ts'
import { CanvasV2Store } from './store.ts'

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
		// `.on`, never `.once`, and never removed: a socket that opens
		// successfully can still emit a later 'error' (e.g. on teardown), and an
		// EventEmitter throws "Unhandled error" if an 'error' event fires with no
		// listener attached — a permanent no-op-after-settle listener avoids
		// that regardless of how many times the underlying ws fires it.
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

async function main() {
	// -------------------------------------------------------------------------
	// Part 1 — flag OFF (default): /sync/v2/* is NOT intercepted. It falls
	// through to the same unmatched-path handling every malformed /sync
	// request already gets (socket.destroy()) — a real ws client sees its
	// handshake fail, and no canvas-v2 directory is ever created.
	// -------------------------------------------------------------------------
	{
		const dataDir = await mkdtemp(path.join(os.tmpdir(), 'canvas-v2-mount-off-data-'))
		const databaseDir = await mkdtemp(path.join(os.tmpdir(), 'canvas-v2-mount-off-db-'))
		assert.equal(process.env.EW_CANVAS_SYNC, undefined, 'precondition: the flag is not set for this process')
		const { server } = createSyncApp({ dataDir, databaseDir })
		await new Promise<void>((r) => server.listen(0, r))
		const port = (server.address() as { port: number }).port

		const failed = await new Promise<boolean>((resolve) => {
			const ws = new WebSocket(`ws://127.0.0.1:${port}/sync/v2/testroom`)
			let settled = false
			const settle = (val: boolean) => {
				if (settled) return
				settled = true
				resolve(val)
			}
			// `.on`, never `.once`: the raw socket.destroy() on a rejected upgrade
			// can surface as more than one 'error'/'close' event on the client
			// side, and an EventEmitter throws "Unhandled error" if 'error' fires
			// with no listener attached — keep a permanent listener throughout.
			ws.on('open', () => settle(false)) // should never fire
			ws.on('error', () => settle(true))
			ws.on('close', () => settle(true))
		})
		assert.ok(failed, 'flag off: the /sync/v2 upgrade is not accepted (same as any unmatched /sync path)')
		assert.ok(!existsSync(path.join(databaseDir, 'canvas-v2')), 'flag off: no canvas-v2 directory is ever created')

		await new Promise<void>((r) => server.close(() => r()))
		await rm(dataDir, { recursive: true, force: true })
		await rm(databaseDir, { recursive: true, force: true })
		console.log('ok: canvas-v2-sync-mount — EW_CANVAS_SYNC unset: /sync/v2 is not intercepted, no dir created')
	}

	// -------------------------------------------------------------------------
	// Part 2 — flag ON: a real ws round trip through wsTransport converges two
	// clients, and the room's canvas-v2 SQLite file holds a non-empty durable
	// log/snapshot on disk.
	// -------------------------------------------------------------------------
	{
		const dataDir = await mkdtemp(path.join(os.tmpdir(), 'canvas-v2-mount-on-data-'))
		const databaseDir = await mkdtemp(path.join(os.tmpdir(), 'canvas-v2-mount-on-db-'))
		process.env.EW_CANVAS_SYNC = '1'
		let server: import('node:http').Server
		try {
			;({ server } = createSyncApp({ dataDir, databaseDir }))
			await new Promise<void>((r) => server.listen(0, r))
			const port = (server.address() as { port: number }).port
			const roomId = 'testroom'
			const wsUrl = `ws://127.0.0.1:${port}/sync/v2/${roomId}`

			const wsA = await openWs(wsUrl)
			const clientA = new SyncClientPeer({ peerId: 2n, transport: wsTransport(wsA) })
			clientA.putShape(shape('shape:a'))

			// Let the write reach the server and get durably appended before the
			// second client joins — proves ordering, not just eventual convergence.
			await waitUntil(() => {
				try {
					return new CanvasV2Store(path.join(databaseDir, 'canvas-v2'), roomId).load().updates.length > 0
				} catch {
					return false
				}
			})

			const wsB = await openWs(wsUrl)
			const clientB = new SyncClientPeer({ peerId: 3n, transport: wsTransport(wsB) })
			await waitUntil(() => clientB.doc.listShapes().some((s) => s.id === 'shape:a'))

			assert.deepEqual(
				clientB.doc.listShapes().map((s) => s.id),
				['shape:a'],
				'a second real ws client converges to the first client\'s edit',
			)

			// Durable-on-disk proof: the room's canvas-v2 SQLite file exists and
			// carries a non-empty log (or a compacted snapshot).
			const dbFile = path.join(databaseDir, 'canvas-v2', `${roomId}.sqlite`)
			assert.ok(existsSync(dbFile), 'the canvas-v2 SQLite file exists on disk')
			const loaded = new CanvasV2Store(path.join(databaseDir, 'canvas-v2'), roomId).load()
			assert.ok(
				loaded.updates.length > 0 || loaded.snapshot !== null,
				'the room durably holds the edit (non-empty log or a snapshot)',
			)

			clientA.close()
			clientB.close()
			console.log('ok: canvas-v2-sync-mount — real ws round trip converges and persists to disk')
		} finally {
			delete process.env.EW_CANVAS_SYNC
			if (server!) await new Promise<void>((r) => server.close(() => r()))
			await rm(dataDir, { recursive: true, force: true })
			await rm(databaseDir, { recursive: true, force: true })
		}
	}

	console.log('canvas-v2-sync-mount.test.ts: all tests passed')
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
