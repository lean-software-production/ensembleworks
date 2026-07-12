/**
 * crash-writer — a standalone helper process for the E3 crash-recovery rig
 * (crash-recovery.test.ts). NOT a test file itself: it's `Bun.spawn`'d by the
 * test, which then `proc.kill(9)`s it mid-write to simulate a real crash.
 *
 * Not scanned by any boundary rule — only canvas-sync/src is boundary-scanned
 * (Date.now/Math.random forbidden there); server has no such restriction, and
 * this file has no need for either anyway (everything here is either an
 * incrementing counter or fixed data).
 *
 * Usage: `bun crash-writer.ts <dir> <roomId> <clientPeerId> [startId]`
 *   dir           — directory for the room's CanvasV2Store SQLite file
 *   roomId        — room id (also the SQLite filename stem)
 *   clientPeerId  — the in-process client's Loro peerId (as a decimal string,
 *                   BigInt-parsed). Must differ across successive rounds on
 *                   the SAME dir (a fresh LoroDoc restarting a peerId's
 *                   oplog counter from 0 while the actor already holds ops
 *                   from an earlier round under that SAME peerId collides
 *                   counter ranges — a real bug, not a recovery property).
 *                   The actor's OWN peerId is fixed at 1n regardless (see
 *                   actor.ts's PEER-ID PROBE — safe by construction there).
 *   startId       — first numeric shape id to write (default 0); pass the
 *                   previous round's final shape count to continue a
 *                   contiguous id range across kill-9 rounds.
 *
 * Protocol with the parent test: opens a DocumentActor + in-process client
 * over a memory transport pair, ensures the room's single page exists (a real
 * `page:p` Page record — without one, every shape's `parentId: 'page:p'`
 * would be a `noOrphans` violation forever, since canvas-model's invariant
 * checker only recognizes an existing page or shape id as a valid parent),
 * prints `READY` once wired, then writes shapes in a tight (but yielding)
 * loop forever, printing `count=<n>` every batch so the parent can observe
 * durable progress without polling the SQLite file. Never exits on its own —
 * the parent's `proc.kill(9)` is the only way this process ends.
 */
import { SyncClientPeer, makePair } from '@ensembleworks/canvas-sync'
import { DocumentActor } from './actor.ts'

const [dir, roomId, clientPeerIdArg, startIdArg] = process.argv.slice(2)
if (!dir || !roomId || !clientPeerIdArg) {
	console.error('usage: crash-writer.ts <dir> <roomId> <clientPeerId> [startId]')
	process.exit(1)
}
const clientPeerId = BigInt(clientPeerIdArg)
const startId = startIdArg ? Number(startIdArg) : 0

const BATCH_SIZE = 5
// High enough that compaction never fires within this rig's modest write
// volume (a few hundred ops) — the test's row-count/shape-count
// cross-check assumes an uncompacted log (one append row per op, 1:1 with
// the shapes eventually materialized).
const COMPACT_EVERY = 1_000_000

const shapeFixture = (id: string) =>
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

// --- wire the actor + in-process client ---
const actor = new DocumentActor({ dir, roomId, peerId: 1n, compactEvery: COMPACT_EVERY })
const [serverTransport, clientTransport] = makePair()
actor.connect(serverTransport)
const client = new SyncClientPeer({ peerId: clientPeerId, transport: clientTransport })

// The client's constructor already ran its sync handshake synchronously (the
// memory transport delivers in-line, same tick) — so on a second-round
// invocation against a dir that already has the page, listPages() here
// already reflects it. Guard so we never append a second, redundant
// page-put row (Loro's LoroMap.set is not value-deduplicated — a repeat
// putPage with identical content still produces a new op on the wire).
if (client.doc.listPages().length === 0) {
	client.doc.putPage({ id: 'page:p', name: 'P' })
	client.doc.commit()
}

// By the time this prints, the page-put (if any) has already been
// synchronously imported, persisted (DocumentActor.onUpdatePayload →
// appendUpdate), and returned — the memory transport and every hook in the
// chain are synchronous callbacks, no timers involved.
console.log('READY')

let i = startId

async function loop(): Promise<never> {
	for (;;) {
		for (let b = 0; b < BATCH_SIZE; b++) {
			client.putShape(shapeFixture(`shape:${i}`))
			i++
		}
		// Occasional progress line (stdout, line-buffered by console.log) — the
		// parent watches for `count=<n>` to know how many appends have landed
		// durably before it sends SIGKILL.
		console.log(`count=${i}`)
		// Yield so stdout actually flushes down the pipe and the process stays
		// responsive — not required for SIGKILL to land (the OS doesn't need our
		// cooperation), but required for the PARENT to observe progress at all.
		await new Promise((resolve) => setImmediate(resolve))
	}
}

void loop()
