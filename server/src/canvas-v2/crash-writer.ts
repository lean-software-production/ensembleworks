/**
 * crash-writer — a standalone helper process for the E3/H5 crash-recovery rig
 * (crash-recovery.test.ts). NOT a test file itself: it's `Bun.spawn`'d by the
 * test, which then `proc.kill(9)`s it to simulate a real crash.
 *
 * DETERMINISTIC CRASH POINT (H5 hardening — see crash-recovery.test.ts's file
 * header for the full before/after account of the flake this replaces): this
 * process runs ONE homogeneous kind of op — `put`, `delete`, or `updateProps`
 * (the embed-write path; the `crashAfter` argument) — in a tight loop,
 * printing exactly one line per op (`op=<type> id=<id> n=<count>
 * [value=<n>]`) IMMEDIATELY after that op's `doc.commit()` returns. By that
 * point the op is ALREADY durable: commit() synchronously drives persist()
 * -> CanvasV2Store.appendUpdate(), a single blocking SQLite INSERT (see
 * actor.ts / store.ts) — nothing async sits between "committed" and
 * "printed". Once enough ops of the target type have landed, this process
 * prints a bare `HALT` line and then awaits a promise THAT NEVER RESOLVES —
 * it performs no further doc mutation, ever, for the rest of its life. The
 * parent test only sends SIGKILL after IT has itself read that `HALT` line
 * off the pipe, so by construction:
 *   (a) the last durable op this round is unambiguously of the requested
 *       type (a real `delete`, or a real `updateProps` — "mid-embed-write"),
 *       and
 *   (b) no further op can have happened between the HALT line and the actual
 *       kill, because the process is providably idle from that point on.
 * This is what makes the crash point deterministic BY CONSTRUCTION rather
 * than a race the test wins often enough: there is no "did the kill land
 * early or late relative to the Nth op" question left to ask, and no
 * observation-granularity blind spot (the prior design printed progress once
 * per BATCH of 5 ops, leaving up to 4 durably-committed-but-unreported ops
 * between what the test could observe and what could actually be on disk —
 * see the test file's header for why that's the real shape of the flake).
 *
 * Not scanned by any boundary rule — only canvas-sync/src is boundary-scanned
 * (Date.now/Math.random forbidden there); server has no such restriction, and
 * this file has no need for either anyway (everything here is either an
 * incrementing counter or fixed data).
 *
 * Usage: `bun crash-writer.ts <dir> <roomId> <clientPeerId> [startId] [crashAfter]`
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
 *   startId       — first FRESH numeric shape id this process may assign via
 *                   `put` (default 0). Ids are NEVER reused once assigned,
 *                   not even after a `delete` — so the caller tracks the
 *                   high-water mark across rounds itself. Ignored entirely by
 *                   `delete`/`updateProps` rounds (they assign no ids; they
 *                   only operate on shapes already durable from prior rounds
 *                   on the same directory).
 *   crashAfter    — 'put' | 'delete' | 'updateProps' (default 'put'): which
 *                   op type this round exercises exclusively, and which type
 *                   the HALT line is guaranteed to follow. `delete` and
 *                   `updateProps` rounds require the directory to already
 *                   hold enough shapes from an earlier `put` round (see
 *                   MIN_OPS_BEFORE_HALT below) — they throw loudly rather
 *                   than silently under-running if it doesn't.
 *
 * Protocol with the parent test: opens a DocumentActor + in-process client
 * over a memory transport pair, ensures the room's single page exists (a real
 * `page:p` Page record — without one, every shape's `parentId: 'page:p'`
 * would be a `noOrphans` violation forever, since canvas-model's invariant
 * checker only recognizes an existing page or shape id as a valid parent),
 * prints `READY` once wired, then runs the requested op loop, printing one
 * `op=` line per op and finally `HALT` right before freezing forever.
 */
import { SyncClientPeer, makePair } from '@ensembleworks/canvas-sync'
import { DocumentActor } from './actor.ts'

const [dir, roomId, clientPeerIdArg, startIdArg, crashAfterArg] = process.argv.slice(2)
if (!dir || !roomId || !clientPeerIdArg) {
	console.error('usage: crash-writer.ts <dir> <roomId> <clientPeerId> [startId] [crashAfter=put|delete|updateProps]')
	process.exit(1)
}
const clientPeerId = BigInt(clientPeerIdArg)
const startId = startIdArg ? Number(startIdArg) : 0
const crashAfter = (crashAfterArg || 'put') as 'put' | 'delete' | 'updateProps'
if (crashAfter !== 'put' && crashAfter !== 'delete' && crashAfter !== 'updateProps') {
	console.error(`usage: crashAfter must be one of 'put' | 'delete' | 'updateProps', got ${JSON.stringify(crashAfterArg)}`)
	process.exit(1)
}

// Halt only after STRICTLY MORE than this many ops of the target type have
// landed this round ("after N>50 appends observed" — the task's floor). The
// `put` round gets a much bigger floor than `delete`/`updateProps`: it needs
// to leave enough surviving shapes behind for LATER rounds on the same
// directory (a delete round, then an updateProps round) to each have >50
// shapes of their own to work with without running out.
const MIN_OPS_BEFORE_HALT: Record<typeof crashAfter, number> = { put: 150, delete: 51, updateProps: 51 }
const haltThreshold = MIN_OPS_BEFORE_HALT[crashAfter]

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
const actor = new DocumentActor({ dir, roomId, peerId: 1n, compactEvery: 1_000_000 })
const [serverTransport, clientTransport] = makePair()
actor.connect(serverTransport)
const client = new SyncClientPeer({ peerId: clientPeerId, transport: clientTransport })

// The client's constructor already ran its sync handshake synchronously (the
// memory transport delivers in-line, same tick) — so on a second-or-later
// round invocation against a dir that already has state, client.doc already
// reflects every prior round's durable survivors by the time we reach here.
if (client.doc.listPages().length === 0) {
	client.doc.putPage({ id: 'page:p', name: 'P' })
	client.doc.commit()
}

console.log('READY')

// Shapes already alive when THIS process attached — i.e. survivors from
// earlier rounds on the same directory (empty on round 1). `delete` and
// `updateProps` rounds work exclusively over THIS set, oldest numeric id
// first, and never touch `startId`'s future-put range.
function numericId(id: string): number {
	return Number(id.replace('shape:', ''))
}
const aliveIds = client.doc
	.listShapes()
	.map((s) => s.id)
	.filter((id) => /^shape:\d+$/.test(id))
	.sort((a, b) => numericId(a) - numericId(b))

let opCount = 0
function printOp(type: 'put' | 'delete' | 'updateProps', id: string, value?: number): void {
	opCount++
	console.log(value === undefined ? `op=${type} id=${id} n=${opCount}` : `op=${type} id=${id} n=${opCount} value=${value}`)
}

/** Prints the HALT sentinel, then blocks FOREVER — no further doc mutation
 * ever happens after this call returns. This is the deterministic crash
 * point: the parent only kills once it has read this line off the pipe, and
 * nothing races it because nothing else runs.
 *
 * A bare `await new Promise(() => {})` does NOT actually achieve this in
 * Bun/Node: an unresolved promise with no associated timer/socket/handle
 * does not keep the event loop alive — once the synchronous work (this
 * function's own body) finishes and nothing else is pending, the process
 * exits NORMALLY on its own (probed directly: `kill -9` against the pid a
 * moment later reported "no such process" — the writer had already exited
 * cleanly, so the parent's `proc.exited` resolved with `signalCode: null`,
 * not `'SIGKILL'`). A dangling no-op `setInterval` is a real libuv timer
 * handle, so it genuinely keeps the process alive indefinitely while doing
 * nothing — the process is truly idle (no CPU spin, no further mutation)
 * until an external signal actually arrives. */
function haltForever(): void {
	console.log('HALT')
	setInterval(() => {}, 0x7fffffff)
}

async function loop(): Promise<void> {
	let nextFreshId = startId
	let deleteCursor = 0
	let updateCursor = 0
	let updateValue = 0
	for (;;) {
		switch (crashAfter) {
			case 'put': {
				const id = `shape:${nextFreshId++}`
				client.putShape(shapeFixture(id))
				printOp('put', id)
				break
			}
			case 'delete': {
				if (deleteCursor >= aliveIds.length) {
					throw new Error(
						`crash-writer: 'delete' round ran out of alive shapes (had ${aliveIds.length}, need >${haltThreshold}) — widen the prior 'put' round's floor`,
					)
				}
				const id = aliveIds[deleteCursor++]!
				client.doc.deleteShape(id)
				client.doc.commit()
				printOp('delete', id)
				break
			}
			case 'updateProps': {
				if (aliveIds.length === 0) {
					throw new Error("crash-writer: 'updateProps' round has no alive shapes to update")
				}
				const id = aliveIds[updateCursor % aliveIds.length]!
				updateCursor++
				updateValue++
				client.doc.updateProps(id, { touched: updateValue })
				client.doc.commit()
				printOp('updateProps', id, updateValue)
				break
			}
		}
		if (opCount > haltThreshold) {
			haltForever()
			return
		}
		// Yield so stdout actually flushes down the pipe and the process stays
		// responsive — not required for SIGKILL to land (the OS doesn't need our
		// cooperation), but required for the PARENT to observe each line.
		await new Promise((resolve) => setImmediate(resolve))
	}
}

void loop()
