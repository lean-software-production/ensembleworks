// Run: bun e2e/lib/wire-seed.test.ts
// Proves the headless wire seeder actually lands shapes in a REAL room actor
// over a REAL WebSocket — the property the whole load harness depends on. A
// second, independent peer reads them back, so this cannot pass by the seeder
// merely mutating its own local doc.
//
// Boots its own server on an ephemeral port with its own temp data dir, so it
// runs under `bun run test` with no Playwright rig present.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { SyncClientPeer } from '@ensembleworks/canvas-sync'
import { wsTransport } from '../../server/src/canvas-v2/ws-transport.ts'
import { createSyncApp } from '../../server/src/app.ts'
import { seedRoomOverWire, openPeer } from './wire-seed.ts'

process.env.EW_CANVAS_SYNC = '1'
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ew-wire-seed-'))
const { server } = createSyncApp({ dataDir })
await new Promise<void>((r) => server.listen(0, r))
const port = (server.address() as { port: number }).port
const base = `ws://127.0.0.1:${port}`

async function waitUntil(pred: () => boolean, ms = 10_000) {
	const t0 = Date.now()
	while (!pred()) {
		if (Date.now() - t0 > ms) throw new Error('waitUntil timed out')
		await new Promise((r) => setTimeout(r, 20))
	}
}

{
	// Bulk mode: N shapes, ONE commit.
	const room = 'wire-seed-bulk'
	const res = await seedRoomOverWire({ base, room, count: 25, mode: 'bulk' })
	assert.equal(res.count, 25)
	assert.equal(res.commits, 1, 'bulk mode issues exactly one commit')

	const reader = await openPeer(base, room, 7n)
	await reader.ready()
	await waitUntil(() => reader.doc.listShapes().length === 25)
	assert.equal(reader.doc.listShapes().length, 25, 'an independent peer reads back all 25 seeded shapes')
	reader.close()
	console.log('ok: wire-seed bulk mode lands 25 shapes readable by an independent peer')
}
{
	// Per-shape mode: N shapes, N commits — a materially longer oplog for the
	// same visible content. This is the axis that separates "too much data"
	// from "too many ops".
	const room = 'wire-seed-percommit'
	const res = await seedRoomOverWire({ base, room, count: 25, mode: 'per-shape' })
	assert.equal(res.commits, 25, 'per-shape mode issues one commit per shape')

	const reader = await openPeer(base, room, 8n)
	await reader.ready()
	await waitUntil(() => reader.doc.listShapes().length === 25)
	assert.equal(reader.doc.listShapes().length, 25)
	reader.close()
	console.log('ok: wire-seed per-shape mode lands 25 shapes with 25 commits')
}
{
	// The seeded page must be the one the browser will adopt (bootstrap-page.ts's
	// resolvePageId adopts an existing page rather than bootstrapping its own).
	const reader = await openPeer(base, 'wire-seed-bulk', 9n)
	await reader.ready()
	await waitUntil(() => reader.doc.listPages().length > 0)
	assert.deepEqual(reader.doc.listPages().map((p) => p.id), ['page:p'], 'exactly one page, the page:p convention')
	reader.close()
	console.log('ok: wire-seed creates exactly the page:p the client will adopt')
}

server.close()
rmSync(dataDir, { recursive: true, force: true })
console.log('ok: wire-seed — all cases')
process.exit(0)
