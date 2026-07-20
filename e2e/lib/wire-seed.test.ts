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
import { Frame, SyncClientPeer, type Transport } from '@ensembleworks/canvas-sync'
import { wsTransport } from '../../server/src/canvas-v2/ws-transport.ts'
import { createSyncApp } from '../../server/src/app.ts'
import { seedRoomOverWire, openPeer, freshPeerId, PAGE_ID } from './wire-seed.ts'

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

// Mirrors wire-seed.ts's private openWs — needed here only for FIX 3's
// hand-rolled "racer" peer, which is built directly against SyncClientPeer +
// wsTransport (bypassing openPeer/seedRoomOverWire entirely) so the race
// demonstration below does not itself depend on the wrapTransport plumbing
// under test.
function openRawWs(url: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url)
		ws.on('open', () => resolve(ws))
		ws.on('error', reject)
	})
}

function noteLiteral(i: number) {
	return {
		id: `shape:race-${i}`,
		kind: 'note',
		parentId: PAGE_ID,
		index: 'a1',
		x: i * 10,
		y: 0,
		rotation: 0,
		isLocked: false,
		opacity: 1,
		meta: {},
		props: {},
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
{
	// FIX 2: rooms persist per roomId and shape ids are deterministic
	// (`shape:wire-${i}`), so re-seeding a SMALLER count into an
	// already-larger-seeded room must NOT silently report success — the
	// barrier's `< count` loop condition is already false, so without an
	// exact-equality check this returns immediately while the room still
	// holds the larger set. Must throw loudly, naming both counts.
	const room = 'wire-seed-shrink'
	const first = await seedRoomOverWire({ base, room, count: 100, mode: 'bulk' })
	assert.equal(first.count, 100)

	await assert.rejects(
		() => seedRoomOverWire({ base, room, count: 10, mode: 'bulk' }),
		(err: Error) => {
			assert.match(err.message, /100/, 'error must name the ACTUAL (larger, stale) count')
			assert.match(err.message, /10/, 'error must name the EXPECTED count')
			return true
		},
		'seeding a smaller count into an already-larger-seeded room must throw, not silently succeed',
	)
	console.log('ok: wire-seed throws loudly on a shrinking re-seed of an already-seeded room')
}
{
	// FIX 1: `SeedResult.commits` is SELF-REPORTED — bulk mode writes the
	// literal `commits = 1`, per-shape mode writes `commits++` beside the
	// commit call. A mutation that swaps either loop's BODY while leaving that
	// self-report untouched still passes an assertion against `res.commits`
	// (verified: both such mutations pass the ORIGINAL test — see the fix
	// commit message). Assert the property where it actually lives instead —
	// on the wire — by tallying real Frame.Update frames sent by the SEEDING
	// peer (the first peer seedRoomOverWire opens via wrapTransport; its
	// second internal openPeer call is the read-back verify peer, excluded
	// here by call ordinal so its own traffic — none expected, but not
	// guaranteed by contract — can't pollute the count).
	function tallySeedingPeerUpdateFrames() {
		let updateFrames = 0
		let calls = 0
		const wrap = (t: Transport): Transport => {
			calls++
			if (calls > 1) return t // 2nd+ open = the verify peer; not the subject of this tally
			return {
				send(bytes: Uint8Array) {
					if (bytes[0] === Frame.Update) updateFrames++
					t.send(bytes)
				},
				onMessage: (cb) => t.onMessage(cb),
				onClose: (cb) => t.onClose(cb),
				close: () => t.close(),
			}
		}
		return { wrap, count: () => updateFrames }
	}

	const bulkTally = tallySeedingPeerUpdateFrames()
	const bulkRes = await seedRoomOverWire({ base, room: 'wire-seed-frametally-bulk', count: 25, mode: 'bulk', wrapTransport: bulkTally.wrap })
	assert.equal(bulkRes.count, 25)
	assert.equal(bulkTally.count(), 2, 'bulk mode: exactly 2 Frame.Update frames on the wire (1 page commit + 1 bulk shapes commit)')

	const perShapeTally = tallySeedingPeerUpdateFrames()
	const perShapeRes = await seedRoomOverWire({ base, room: 'wire-seed-frametally-percommit', count: 25, mode: 'per-shape', wrapTransport: perShapeTally.wrap })
	assert.equal(perShapeRes.count, 25)
	assert.equal(perShapeTally.count(), 26, 'per-shape mode: exactly 26 Frame.Update frames on the wire (1 page commit + 25 per-shape commits)')

	console.log('ok: wire-seed bulk vs per-shape is distinguished by actual wire frames, not the self-reported counter')
}
{
	// FIX 3: prove the read-back barrier is genuinely load-bearing, via real
	// transport injection — not by trusting "SyncServerPeer.handleFrame is
	// synchronous" as an unverified claim. The only genuine race window is
	// bytes in flight, so we manufacture one with an artificial macrotask
	// delay on send().
	const deferMs = 60
	function deferringTransport(t: Transport): Transport {
		return {
			send(bytes) { setTimeout(() => t.send(bytes), deferMs) },
			onMessage: (cb) => t.onMessage(cb),
			onClose: (cb) => t.onClose(cb),
			close: () => t.close(),
		}
	}

	// --- Part A: the race is real, UNBARRIERED. ---
	// A "racer" peer whose outbound sends are deferred by a macrotask commits
	// shapes, then a SEPARATE reader checks back IMMEDIATELY — no polling
	// wait, i.e. exactly what a caller without a read-back barrier would do.
	// The commit frames have not reached the wire yet, so the immediate read
	// must NOT observe them. This part doesn't touch wire-seed.ts's exported
	// API at all (SyncClientPeer + wsTransport directly), so it is not itself
	// a RED/GREEN case for the fix below — it's the premise the fix defends.
	const raceRoom = 'wire-seed-race'
	const rawWs = await openRawWs(`${base}/sync/v2/${raceRoom}`)
	const racer = new SyncClientPeer({ peerId: freshPeerId(), transport: deferringTransport(wsTransport(rawWs)) })
	await racer.ready()
	racer.doc.putPage({ id: PAGE_ID, name: 'P' })
	racer.doc.commit()
	for (let i = 0; i < 5; i++) racer.doc.putShape(noteLiteral(i) as never)
	racer.doc.commit()
	const immediate = await openPeer(base, raceRoom, freshPeerId())
	await immediate.ready()
	assert.notEqual(
		immediate.doc.listShapes().length,
		5,
		'sanity check: an UNBARRIERED immediate read must observe the bytes-in-flight race — this is exactly what seedRoomOverWire\'s read-back barrier exists to prevent',
	)
	immediate.close()
	racer.close()

	// --- Part B: seedRoomOverWire, GIVEN THE SAME KIND OF INDUCED DELAY on
	// the frames it itself sends (via SeedOpts.wrapTransport), must still
	// resolve to the EXACT count — because its own barrier (a genuine reader
	// polling loop, not a fixed sleep) waits the delay out.
	let wraps = 0
	const res = await seedRoomOverWire({
		base,
		room: `${raceRoom}-barriered`,
		count: 5,
		mode: 'bulk',
		wrapTransport: (t) => {
			wraps++
			return deferringTransport(t)
		},
	})
	assert.ok(wraps > 0, 'seedRoomOverWire/openPeer must actually apply wrapTransport to an opened peer')
	assert.equal(res.count, 5)
	const verify = await openPeer(base, `${raceRoom}-barriered`, freshPeerId())
	await verify.ready()
	await waitUntil(() => verify.doc.listShapes().length === 5)
	assert.equal(verify.doc.listShapes().length, 5, 'the barriered seed, despite induced wire delay, lands the exact count')
	verify.close()
	console.log('ok: wire-seed read-back barrier survives an induced bytes-in-flight delay that an unbarriered read does not')
}

server.close()
rmSync(dataDir, { recursive: true, force: true })
console.log('ok: wire-seed — all cases')
process.exit(0)
