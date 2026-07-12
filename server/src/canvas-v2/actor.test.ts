// Run: bun src/canvas-v2/actor.test.ts
// Locks DocumentActor's crash-recovery contract — the corrected, durable-first
// design (see docs/plans/2026-07-11-canvas-phase2-sync-shadow.md, "Amendments
// (2026-07-11, post-review)"). The ORIGINAL plan text persisted only via
// peer.doc.subscribeLocalUpdates, which never fires for imported (client)
// ops — a proven hole that loses every client edit on crash. Test 1 below is
// the test that catches exactly that hole; it drove the corrected design.
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { checkInvariants } from '@ensembleworks/canvas-model'
import { dumpModel } from '@ensembleworks/canvas-doc'
import { SyncClientPeer, makePair } from '@ensembleworks/canvas-sync'
import { DocumentActor } from './actor.ts'
import { CanvasV2Store } from './store.ts'

const shape = (id: string, over: any = {}) =>
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
		...over,
	}) as any

// ---------------------------------------------------------------------------
// Test 1 — THE HOLE-CATCHER. This is the exact scenario that would have
// caught the original plan's bug: a client-sourced edit (arrives at the
// server as an IMPORT, never a local commit) must survive a crash + restart.
// ---------------------------------------------------------------------------
{
	const dir = mkdtempSync(path.join(tmpdir(), 'canvas-v2-actor-holecatcher-'))
	const roomId = 'room-hole'

	const actor = new DocumentActor({ dir, roomId, peerId: 1n })
	const [serverTransport, clientTransport] = makePair()
	actor.connect(serverTransport)
	const client = new SyncClientPeer({ peerId: 2n, transport: clientTransport })

	client.putShape(shape('shape:a'))

	// Prove the append-log actually captured the client's edit BEFORE we ever
	// drop the actor — a fresh store handle on the same file must see it.
	const logAfterEdit = new CanvasV2Store(dir, roomId).load()
	assert.ok(
		logAfterEdit.updates.length > 0,
		'client-sourced edit must be durably appended to the log (this is what the original design got wrong)',
	)

	// "Crash": drop every reference to the actor and its client, without any
	// graceful close/flush.
	client.close()

	// Fresh actor on the same dir/room — this is what a process restart does.
	const recovered = new DocumentActor({ dir, roomId, peerId: 1n })
	const [serverTransport2, clientTransport2] = makePair()
	recovered.connect(serverTransport2)
	const freshClient = new SyncClientPeer({ peerId: 3n, transport: clientTransport2 })
	freshClient.requestSync()

	assert.deepEqual(
		freshClient.doc.listShapes().map((s) => s.id),
		['shape:a'],
		'a client-sourced edit must survive an actor crash + restart',
	)

	rmSync(dir, { recursive: true, force: true })
	console.log('ok: actor — hole-catcher (client-sourced edits survive crash)')
}

// ---------------------------------------------------------------------------
// Test 2 — repair-triggering client edit (dangling binding) recovers clean.
// ---------------------------------------------------------------------------
{
	const dir = mkdtempSync(path.join(tmpdir(), 'canvas-v2-actor-repair-'))
	const roomId = 'room-repair'

	const actor = new DocumentActor({ dir, roomId, peerId: 1n })
	const [serverTransport, clientTransport] = makePair()
	actor.connect(serverTransport)
	const client = new SyncClientPeer({ peerId: 2n, transport: clientTransport })

	client.doc.putPage({ id: 'page:p', name: 'P' })
	client.doc.putShape(shape('shape:ar', { kind: 'arrow' }))
	client.doc.putBinding({ id: 'binding:d', fromId: 'shape:ar', toId: 'shape:gone', props: {}, meta: {} })
	client.doc.commit()
	client.close()

	const recovered = new DocumentActor({ dir, roomId, peerId: 1n })
	const model = dumpModel(recovered.peer.doc)
	assert.deepEqual(
		model.shapes.map((s) => s.id),
		['shape:ar'],
		'the shape survives',
	)
	assert.deepEqual(recovered.peer.doc.listBindings(), [], 'the dangling binding was repaired away')
	assert.deepEqual(checkInvariants(model), [], 'recovered doc is invariant-clean')

	rmSync(dir, { recursive: true, force: true })
	console.log('ok: actor — repair-triggering client edit recovers clean')
}

// ---------------------------------------------------------------------------
// Test 3 — agent-write path: a direct mutation of actor.peer.doc (no client,
// no import — the subscribeLocalUpdates leg) also survives a crash.
// ---------------------------------------------------------------------------
{
	const dir = mkdtempSync(path.join(tmpdir(), 'canvas-v2-actor-agent-'))
	const roomId = 'room-agent'

	const actor = new DocumentActor({ dir, roomId, peerId: 1n })
	actor.peer.doc.putShape(shape('shape:agent'))
	actor.peer.doc.commit()

	const recovered = new DocumentActor({ dir, roomId, peerId: 1n })
	assert.deepEqual(
		recovered.peer.doc.listShapes().map((s) => s.id),
		['shape:agent'],
		'a direct server-local write (e.g. an agent tool) survives crash + restart',
	)

	rmSync(dir, { recursive: true, force: true })
	console.log('ok: actor — agent-write path (subscribeLocalUpdates leg) recovers')
}

// ---------------------------------------------------------------------------
// Test 4 — compaction keeps the log small; recovered state equals live state.
// ---------------------------------------------------------------------------
{
	const dir = mkdtempSync(path.join(tmpdir(), 'canvas-v2-actor-compact-'))
	const roomId = 'room-compact'

	const actor = new DocumentActor({ dir, roomId, peerId: 1n, compactEvery: 3 })
	const [serverTransport, clientTransport] = makePair()
	actor.connect(serverTransport)
	const client = new SyncClientPeer({ peerId: 2n, transport: clientTransport })

	for (let i = 0; i < 5; i++) client.putShape(shape(`shape:${i}`))

	const store = new CanvasV2Store(dir, roomId)
	const { snapshot, updates } = store.load()
	assert.ok(snapshot !== null, 'compaction produced a snapshot')
	assert.ok(updates.length < 5, `log stays small after compaction (got ${updates.length} rows)`)

	const liveIds = actor.peer.doc.listShapes().map((s) => s.id).sort()
	client.close()
	const recovered = new DocumentActor({ dir, roomId, peerId: 1n })
	const recoveredIds = recovered.peer.doc.listShapes().map((s) => s.id).sort()
	assert.deepEqual(recoveredIds, liveIds, 'recovered state equals live state across a compaction boundary')
	assert.deepEqual(recoveredIds, ['shape:0', 'shape:1', 'shape:2', 'shape:3', 'shape:4'])

	rmSync(dir, { recursive: true, force: true })
	console.log('ok: actor — compaction keeps the log small and recovers correctly')
}

// ---------------------------------------------------------------------------
// Test 5 — double-replay idempotence: building a second actor from the same
// files, twice, yields identical state both times.
// ---------------------------------------------------------------------------
{
	const dir = mkdtempSync(path.join(tmpdir(), 'canvas-v2-actor-idempotent-'))
	const roomId = 'room-idempotent'

	const actor = new DocumentActor({ dir, roomId, peerId: 1n })
	const [serverTransport, clientTransport] = makePair()
	actor.connect(serverTransport)
	const client = new SyncClientPeer({ peerId: 2n, transport: clientTransport })
	client.doc.putPage({ id: 'page:p', name: 'P' })
	client.doc.putShape(shape('shape:ar', { kind: 'arrow' }))
	client.doc.putBinding({ id: 'binding:d', fromId: 'shape:ar', toId: 'shape:gone', props: {}, meta: {} })
	client.doc.commit()
	client.close()

	const first = new DocumentActor({ dir, roomId, peerId: 1n })
	const firstModel = dumpModel(first.peer.doc)

	const second = new DocumentActor({ dir, roomId, peerId: 1n })
	const secondModel = dumpModel(second.peer.doc)

	assert.deepEqual(firstModel, secondModel, 'rebuilding the actor twice from the same files yields identical state')
	assert.deepEqual(checkInvariants(secondModel), [], 'second rebuild is still invariant-clean')

	rmSync(dir, { recursive: true, force: true })
	console.log('ok: actor — double-replay idempotence')
}

// ---------------------------------------------------------------------------
// Test 6 — close() semantics: compacts one last time (fast next-restart load),
// is idempotent, and a connect() after close throws (peer's real close
// semantics per Unit 4) rather than silently accepting a dead actor.
// ---------------------------------------------------------------------------
{
	const dir = mkdtempSync(path.join(tmpdir(), 'canvas-v2-actor-close-'))
	const roomId = 'room-close'

	const actor = new DocumentActor({ dir, roomId, peerId: 1n, compactEvery: 500 })
	const [serverTransport, clientTransport] = makePair()
	actor.connect(serverTransport)
	const client = new SyncClientPeer({ peerId: 2n, transport: clientTransport })
	client.putShape(shape('shape:a'))

	// Below the compaction threshold — compact() would not have fired on its own.
	assert.equal(new CanvasV2Store(dir, roomId).load().snapshot, null, 'no snapshot yet — compactEvery not reached')

	actor.close()
	const { snapshot, updates } = new CanvasV2Store(dir, roomId).load()
	assert.ok(snapshot !== null, 'close() compacts once more, so a snapshot exists even under the compaction threshold')
	assert.deepEqual(updates, [], 'the compacted snapshot folds in everything — no dangling log rows')

	// Idempotent.
	actor.close()

	// The peer really is closed: connecting a new transport throws.
	assert.throws(() => actor.connect(makePair()[0]), /closed/i, 'connect() after close throws (peer close semantics)')

	// close() also closed the SQLite handle: appending through the actor's own
	// (now-closed) store instance errors — pinned to bun:sqlite's actual
	// closed-handle behavior (the store re-prepares per call, so it hits
	// prepare()'s "Cannot use a closed database"; pre-close statements refuse
	// writes with "Database has closed" — see kernel/sqlite.test.ts). A FRESH
	// store on the same file still works (nothing corrupt).
	const closedStore = (actor as unknown as { store: CanvasV2Store }).store
	assert.throws(
		() => closedStore.appendUpdate(new Uint8Array([1])),
		/closed database|Database has closed/,
		'the actor closed its SQLite handle',
	)
	const reopened = new CanvasV2Store(dir, roomId)
	assert.ok(reopened.load().snapshot !== null, 'a fresh store on the same file still reads the compacted snapshot')
	reopened.close()

	rmSync(dir, { recursive: true, force: true })
	console.log('ok: actor — close() compacts, is idempotent, and really closes the peer')
}

// ---------------------------------------------------------------------------
// Test 7 — persist failure is loud and terminal (taint), never silent poison.
// Why this matters: persist() runs inside a Loro callback boundary on the
// sending peer, and loro's wasm-bindgen handleError shim SWALLOWS exceptions
// thrown there — without an explicit taint, a single failed appendUpdate
// would leave the doc mutating and relaying while the log silently rotted,
// and (Loro ops being causally chained per peer) every later op from that
// client session would recover as pending-forever: one transient disk
// hiccup = a room that restarts with ZERO shapes.
// ---------------------------------------------------------------------------
{
	const dir = mkdtempSync(path.join(tmpdir(), 'canvas-v2-actor-taint-'))
	const roomId = 'room-taint'

	const actor = new DocumentActor({ dir, roomId, peerId: 1n })
	const [serverTransport, clientTransport] = makePair()
	actor.connect(serverTransport)
	const client = new SyncClientPeer({ peerId: 2n, transport: clientTransport })

	// One durable edit first, so recovery has a known last-durable state.
	client.putShape(shape('shape:durable'))
	const durableRows = new CanvasV2Store(dir, roomId).load().updates.length
	assert.ok(durableRows > 0, 'precondition: the first edit is durably logged')
	// Read through a local: assert/strict's equal() has an `asserts actual is T`
	// signature that would otherwise narrow the PROPERTY to null for the scope.
	const preTaint: Error | null = actor.tainted
	assert.equal(preTaint, null, 'precondition: a healthy actor is not tainted')

	// Make the NEXT append fail once (a transient disk hiccup), then restore.
	const store = (actor as unknown as { store: CanvasV2Store }).store
	const realAppend = store.appendUpdate.bind(store)
	let injected = 0
	store.appendUpdate = () => {
		store.appendUpdate = realAppend
		injected++
		throw new Error('disk hiccup (injected)')
	}

	client.putShape(shape('shape:poisoned'))
	assert.equal(injected, 1, 'the poisoned edit hit the failing append')

	// Taint is set and loud-refusal wired.
	const taint: Error | null = actor.tainted
	assert.ok(taint instanceof Error, 'persist failure taints the actor')
	assert.match(taint.message, /disk hiccup/)
	assert.throws(
		() => actor.connect(makePair()[0]),
		/tainted: durability lost/,
		'connect() on a tainted actor is refused',
	)

	// The durability property: NO row was appended for the poisoned edit (and,
	// via the tainted guard in persist, none will be for any later causally-
	// chained op — a partial suffix would recover as pending-forever).
	assert.equal(
		new CanvasV2Store(dir, roomId).load().updates.length,
		durableRows,
		'the log still holds exactly the durable prefix — no poisoned row',
	)

	// The taint path closed every client transport: subsequent edits no longer
	// reach the server doc (the client keeps them in its own replica only).
	client.putShape(shape('shape:after'))
	assert.ok(
		!actor.peer.doc.listShapes().some((s) => s.id === 'shape:after'),
		'a disconnected client cannot keep editing a tainted room',
	)

	// Fresh actor on the same dir recovers cleanly to the last durable state.
	const recovered = new DocumentActor({ dir, roomId, peerId: 1n })
	const [serverTransport2, clientTransport2] = makePair()
	recovered.connect(serverTransport2)
	const freshClient = new SyncClientPeer({ peerId: 3n, transport: clientTransport2 })
	freshClient.requestSync()
	assert.deepEqual(
		freshClient.doc.listShapes().map((s) => s.id),
		['shape:durable'],
		'recovery lands on the last durable state — no pending-forever ops',
	)

	// The poisoning client's local replica is intact, and its full-history
	// reconnect backfill carries the lost edits into a HEALTHY actor.
	const dir2 = mkdtempSync(path.join(tmpdir(), 'canvas-v2-actor-taint-healthy-'))
	const healthy = new DocumentActor({ dir: dir2, roomId, peerId: 1n })
	const [serverTransport3, clientTransport3] = makePair()
	healthy.connect(serverTransport3)
	client.reconnect(clientTransport3)
	assert.deepEqual(
		healthy.peer.doc.listShapes().map((s) => s.id).sort(),
		['shape:after', 'shape:durable', 'shape:poisoned'],
		'the client backfills its full history into a healthy actor',
	)
	assert.ok(
		new CanvasV2Store(dir2, roomId).load().updates.length > 0,
		'the healthy actor durably logged the backfill',
	)

	rmSync(dir, { recursive: true, force: true })
	rmSync(dir2, { recursive: true, force: true })
	console.log('ok: actor — persist failure taints loudly (no silent poison)')
}

// ---------------------------------------------------------------------------
// Test 8 — close() exception safety: a throwing final compact() must not
// abort teardown. Before the fix, closed=true was set BEFORE the fallible
// compact, so a throw skipped peer.close() and the idempotency guard made
// every retry a silent no-op — peer + transports leaked forever.
// ---------------------------------------------------------------------------
{
	const dir = mkdtempSync(path.join(tmpdir(), 'canvas-v2-actor-close-throws-'))
	const roomId = 'room-close-throws'

	const actor = new DocumentActor({ dir, roomId, peerId: 1n })
	const [serverTransport, clientTransport] = makePair()
	actor.connect(serverTransport)
	const client = new SyncClientPeer({ peerId: 2n, transport: clientTransport })
	client.putShape(shape('shape:a'))

	const store = (actor as unknown as { store: CanvasV2Store }).store
	store.compact = () => {
		throw new Error('compact failed (injected)')
	}

	actor.close() // must complete teardown despite the compaction throw

	// The peer is really closed…
	assert.throws(() => actor.connect(makePair()[0]), /closed/i, 'teardown completed: connect() refuses')
	// …and a second close() is a clean no-op.
	actor.close()

	// Nothing durable was lost: the append-log rows are intact (only the final
	// snapshot is missing), so a fresh actor recovers the edit fully.
	const recovered = new DocumentActor({ dir, roomId, peerId: 1n })
	assert.deepEqual(
		recovered.peer.doc.listShapes().map((s) => s.id),
		['shape:a'],
		'append-log intact — a failed final compaction loses nothing durable',
	)

	rmSync(dir, { recursive: true, force: true })
	console.log('ok: actor — close() completes teardown even when the final compact throws')
}

// ---------------------------------------------------------------------------
// Test 9 — constructor hardening: a load-path throw (e.g. a corrupt log) must
// close the store's SQLite handle before rethrowing, not leak the fd. The
// registry (C3) treats "construction threw" as retryable — every leaked fd on
// a retried construction would accumulate forever. Probed via /proc/self/fd's
// entry count (Linux): unchanged across a failed construction proves the
// store handle it opened was released, not merely that no NEW error occurred.
// ---------------------------------------------------------------------------
{
	const dir = mkdtempSync(path.join(tmpdir(), 'canvas-v2-actor-ctor-throw-'))
	const roomId = 'room-ctor-throw'

	const realLoad = CanvasV2Store.prototype.load
	CanvasV2Store.prototype.load = function () {
		throw new Error('corrupt log (injected)')
	}
	try {
		const before = readdirSync('/proc/self/fd').length
		assert.throws(
			() => new DocumentActor({ dir, roomId, peerId: 1n }),
			/corrupt log/,
			'a load-path throw propagates out of the constructor',
		)
		const after = readdirSync('/proc/self/fd').length
		assert.equal(after, before, 'the store fd was released — /proc/self/fd count unchanged across the failed construction')
	} finally {
		CanvasV2Store.prototype.load = realLoad
	}

	// A fresh, un-patched construction on the same dir/room proves nothing else
	// was left wedged either (no stray lock, no half-open handle blocking it).
	const recovered = new DocumentActor({ dir, roomId, peerId: 1n })
	assert.deepEqual(recovered.peer.doc.listShapes(), [], 'a normal construction still works after the failed one')

	rmSync(dir, { recursive: true, force: true })
	console.log('ok: actor — constructor releases the store fd when the load path throws')
}
