// Headless room seeding over the REAL /sync/v2 WebSocket, for the canvas-v2
// load harness (perf/canvas-v2-load.spec.ts).
//
// WHY NOT lib/canvas-v2.ts's seedGrid: that seeds through `window.__ew.doc`
// AFTER the browser session has already booted, which bypasses the entire
// wire/sync path. The load harness's whole subject is how long the browser
// takes to paint shapes that were ALREADY in the room when it arrived — so the
// shapes must be in the room BEFORE the browser navigates, and must have got
// there the same way a real teammate's shapes would.
//
// LIVES IN e2e/ ON PURPOSE: canvas-sync/src is clean-room (its boundary.test.ts
// text-scans for `ws` imports and fails the build). e2e/ may import freely, and
// already imports from server/src (see scripts/start-server.ts).
import { WebSocket } from 'ws'
import { SyncClientPeer } from '@ensembleworks/canvas-sync'
import { wsTransport } from '../../server/src/canvas-v2/ws-transport.ts'

export const PAGE_ID = 'page:p'

/** How the seeded shapes are committed. Visible content is IDENTICAL between
 * the two; only the oplog differs — `bulk` produces one change, `per-shape`
 * produces `count` changes for the same shapes. Distinguishing them is what
 * separates "the backfill ships too much data" from "the backfill ships too
 * many ops". */
export type SeedMode = 'bulk' | 'per-shape'

export interface SeedOpts {
	/** e.g. `ws://127.0.0.1:8788` — no trailing slash, no path. */
	readonly base: string
	readonly room: string
	readonly count: number
	readonly mode: SeedMode
	/** Grid pitch in world units. 260 matches the existing perf specs' spacing. */
	readonly pitch?: number
}

export interface SeedResult {
	readonly count: number
	readonly commits: number
	readonly seedMs: number
}

function openWs(url: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url)
		let settled = false
		ws.on('open', () => { if (!settled) { settled = true; resolve(ws) } })
		ws.on('error', (err) => { if (!settled) { settled = true; reject(err) } })
	})
}

/** Opens a connected, sync-requested peer. The socket is opened FIRST and only
 * then handed to SyncClientPeer — the constructor sends its SyncRequest
 * synchronously, and a not-yet-open socket drops it silently. */
export async function openPeer(base: string, room: string, peerId: bigint): Promise<SyncClientPeer> {
	if (peerId === 0n || peerId === 1n) throw new Error(`peerId ${peerId} is reserved (1n is SERVER_PEER_ID)`)
	const ws = await openWs(`${base}/sync/v2/${room}`)
	return new SyncClientPeer({ peerId, transport: wsTransport(ws) })
}

let nextPeerId = 1000n
/** A fresh, never-reserved peer id per seeder. Monotonic rather than random so
 * a failing run's logs are reproducible. */
export const freshPeerId = (): bigint => ++nextPeerId

function note(i: number, pitch: number, cols: number) {
	return {
		id: `shape:wire-${i}`,
		kind: 'note',
		parentId: PAGE_ID,
		index: 'a1',
		x: (i % cols) * pitch,
		y: Math.floor(i / cols) * pitch,
		rotation: 0,
		isLocked: false,
		opacity: 1,
		meta: {},
		props: {},
	}
}

/** Seeds `count` notes into `room` over a real WebSocket, then waits for the
 * server to have acknowledged them (a fresh verification peer reads them back)
 * before resolving — so a caller can navigate a browser immediately after with
 * no race. Closes both peers. */
export async function seedRoomOverWire(opts: SeedOpts): Promise<SeedResult> {
	const { base, room, count, mode } = opts
	const pitch = opts.pitch ?? 260
	const cols = Math.ceil(Math.sqrt(count))
	const t0 = Date.now()

	const peer = await openPeer(base, room, freshPeerId())
	await peer.ready()

	peer.doc.putPage({ id: PAGE_ID, name: 'P' })
	peer.doc.commit()
	let commits = 0

	if (mode === 'bulk') {
		for (let i = 0; i < count; i++) peer.doc.putShape(note(i, pitch, cols) as never)
		peer.doc.commit()
		commits = 1
	} else {
		for (let i = 0; i < count; i++) {
			peer.doc.putShape(note(i, pitch, cols) as never)
			peer.doc.commit()
			commits++
		}
	}

	// Read-back barrier: a SECOND peer proves the server actor has the shapes,
	// not merely that we sent them. Without this the browser can arrive before
	// the server has applied the last frame and measure a phantom-fast load.
	const verify = await openPeer(base, room, freshPeerId())
	await verify.ready()
	const deadline = Date.now() + 30_000
	while (verify.doc.listShapes().length < count) {
		if (Date.now() > deadline) throw new Error(`wire-seed: server never reached ${count} shapes in ${room} (saw ${verify.doc.listShapes().length})`)
		await new Promise((r) => setTimeout(r, 25))
	}
	verify.close()
	peer.close()

	return { count, commits, seedMs: Date.now() - t0 }
}
