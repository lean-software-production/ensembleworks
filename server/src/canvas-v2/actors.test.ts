// Run: bun src/canvas-v2/actors.test.ts
// Locks createCanvasActors's registry semantics (Unit 6 review carried
// forward into C3): getOrCreate memoizes a live actor; a TAINTED actor is
// evicted (close() is safe/idempotent) and replaced with a fresh one that
// serves the durable prefix still on disk; close() tears down every
// registered actor.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { makePair, SyncClientPeer } from '@ensembleworks/canvas-sync'
import { CanvasV2Store } from './store.ts'
import { createCanvasActors } from './actors.ts'

const shape = (id: string) =>
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

// ---------------------------------------------------------------------------
// Test 1 — getOrCreate memoizes: the same room id returns the same instance.
// ---------------------------------------------------------------------------
{
	const dir = mkdtempSync(path.join(tmpdir(), 'canvas-actors-memo-'))
	const actors = createCanvasActors(dir)
	const a1 = actors.getOrCreate('room-a')
	const a2 = actors.getOrCreate('room-a')
	assert.equal(a1, a2, 'getOrCreate returns the same live actor for a repeat call')
	actors.close()
	rmSync(dir, { recursive: true, force: true })
	console.log('ok: actors — getOrCreate memoizes a live actor')
}

// ---------------------------------------------------------------------------
// Test 2 — a tainted actor is evicted; the fresh replacement serves the last
// durable state from disk, and subsequent calls reuse THAT fresh instance.
// ---------------------------------------------------------------------------
{
	const dir = mkdtempSync(path.join(tmpdir(), 'canvas-actors-taint-'))
	const actors = createCanvasActors(dir)
	const actor = actors.getOrCreate('room-b')
	const [serverTransport, clientTransport] = makePair()
	actor.connect(serverTransport)
	const client = new SyncClientPeer({ peerId: 2n, transport: clientTransport })
	client.putShape(shape('shape:durable'))

	// Inject a genuinely sick storage layer (mirrors actor.test.ts's taint
	// test): appendUpdate fails, tainting the actor. compact() must ALSO fail
	// here — otherwise the eviction path's close() (which always attempts one
	// final compact, per DocumentActor's class doc) would snapshot the full
	// in-memory doc, including the never-durably-logged poisoned shape, and
	// "heal" the taint by writing it to disk anyway. A real disk failure would
	// sink both paths, so both must be patched to get a faithful test of "the
	// durable prefix on disk excludes the poisoned edit."
	const store = (actor as unknown as { store: CanvasV2Store }).store
	store.appendUpdate = () => {
		throw new Error('disk hiccup (injected)')
	}
	store.compact = () => {
		throw new Error('disk hiccup (injected, compact)')
	}
	client.putShape(shape('shape:poisoned'))
	assert.ok(actor.tainted, 'precondition: the actor is now tainted')

	const fresh = actors.getOrCreate('room-b')
	assert.notEqual(fresh, actor, 'a tainted actor is evicted, not reused')
	assert.equal(fresh.tainted, null, 'the fresh actor is healthy')
	assert.deepEqual(
		fresh.peer.doc.listShapes().map((s) => s.id),
		['shape:durable'],
		'the fresh actor serves the last durable state on disk (the poisoned edit was never appended)',
	)
	assert.equal(actors.getOrCreate('room-b'), fresh, 'subsequent calls reuse the fresh actor, not construct another')

	actors.close()
	rmSync(dir, { recursive: true, force: true })
	console.log('ok: actors — tainted actor evicted; fresh actor serves the durable prefix')
}

// ---------------------------------------------------------------------------
// Test 3 — close() tears down every registered actor (server shutdown path).
// ---------------------------------------------------------------------------
{
	const dir = mkdtempSync(path.join(tmpdir(), 'canvas-actors-closeall-'))
	const actors = createCanvasActors(dir)
	const a = actors.getOrCreate('room-x')
	const b = actors.getOrCreate('room-y')
	actors.close()
	assert.throws(() => a.connect(makePair()[0]), /closed/i, "close() closed room-x's actor")
	assert.throws(() => b.connect(makePair()[0]), /closed/i, "close() closed room-y's actor")
	rmSync(dir, { recursive: true, force: true })
	console.log('ok: actors — close() tears down every registered actor')
}

// ---------------------------------------------------------------------------
// Test 4 — a tainted-actor eviction is recorded (D3's metrics gap-fix): the
// fresh replacement actor reports healthy, so taint visibility would
// otherwise vanish the instant getOrCreate replaces it. evictions() must
// surface a per-room {count, lastReason} that survives the replacement.
// ---------------------------------------------------------------------------
{
	const dir = mkdtempSync(path.join(tmpdir(), 'canvas-actors-evictions-'))
	const actors = createCanvasActors(dir)
	assert.deepEqual([...actors.evictions().entries()], [], 'no evictions recorded before any taint')

	const actor = actors.getOrCreate('room-e')
	const [serverTransport, clientTransport] = makePair()
	actor.connect(serverTransport)
	const client = new SyncClientPeer({ peerId: 2n, transport: clientTransport })

	const store = (actor as unknown as { store: CanvasV2Store }).store
	store.appendUpdate = () => {
		throw new Error('disk hiccup (injected, evictions test)')
	}
	store.compact = () => {
		throw new Error('disk hiccup (injected, compact, evictions test)')
	}
	client.putShape(shape('shape:poisoned-e'))
	assert.ok(actor.tainted, 'precondition: the actor is now tainted')

	// Nothing recorded yet — the record is written on the NEXT getOrCreate,
	// which is where eviction actually happens.
	assert.equal(actors.evictions().get('room-e'), undefined, 'no eviction recorded until getOrCreate evicts')

	const fresh = actors.getOrCreate('room-e')
	assert.notEqual(fresh, actor, 'sanity: eviction really happened')
	const record = actors.evictions().get('room-e')
	assert.ok(record, 'an eviction record exists for room-e after the tainted actor was replaced')
	assert.equal(record!.count, 1, 'first eviction for this room counts as 1')
	assert.match(record!.lastReason, /disk hiccup \(injected, evictions test\)/, 'lastReason carries the taint message')

	// A second taint+eviction cycle on the SAME room increments the count.
	const store2 = (fresh as unknown as { store: CanvasV2Store }).store
	store2.appendUpdate = () => {
		throw new Error('disk hiccup (injected, second taint)')
	}
	store2.compact = () => {
		throw new Error('disk hiccup (injected, second taint, compact)')
	}
	const [serverTransport2, clientTransport2] = makePair()
	fresh.connect(serverTransport2)
	const client2 = new SyncClientPeer({ peerId: 3n, transport: clientTransport2 })
	client2.putShape(shape('shape:poisoned-e2'))
	assert.ok(fresh.tainted, 'precondition: the fresh actor is now ALSO tainted')
	actors.getOrCreate('room-e')
	const record2 = actors.evictions().get('room-e')
	assert.equal(record2!.count, 2, 'a second eviction on the same room increments the count')
	assert.match(record2!.lastReason, /second taint/, 'lastReason reflects the MOST RECENT eviction')

	// entries() surfaces the live (post-eviction) actor set for introspection.
	assert.ok(actors.entries().has('room-e'), 'entries() lists the live actor for room-e')
	assert.notEqual(actors.entries().get('room-e'), actor, 'entries() reflects the current live actor, not the evicted one')

	actors.close()
	rmSync(dir, { recursive: true, force: true })
	console.log('ok: actors — evictions() records per-room {count, lastReason} across replacements')
}

// ---------------------------------------------------------------------------
// Test 5 (F1) — an idle actor is evicted by sweepIdle() past idleTtlMs; a
// subsequent getOrCreate constructs a FRESH actor that reloads the durable
// state from disk (full round trip: create, mutate, persist, evict,
// getOrCreate again, content survives via the store).
// ---------------------------------------------------------------------------
{
	const dir = mkdtempSync(path.join(tmpdir(), 'canvas-actors-idle-'))
	let clock = 1_000_000
	const actors = createCanvasActors(dir, { now: () => clock })

	const actor = actors.getOrCreate('room-idle')
	const [serverTransport, clientTransport] = makePair()
	actor.connect(serverTransport)
	const client = new SyncClientPeer({ peerId: 2n, transport: clientTransport })
	client.putShape(shape('shape:survives-idle'))
	// Disconnect: the client transport closing must clear connectionCount to 0
	// (a live socket is never evicted regardless of idleness).
	clientTransport.close()
	assert.equal(actor.connectionCount, 0, 'precondition: no connected transports after the client disconnects')

	const idleTtlMs = 60_000
	clock += idleTtlMs - 1
	actors.sweepIdle(idleTtlMs)
	// entries(), NOT getOrCreate(), for this check — getOrCreate() itself
	// counts as activity (by design: see actors.ts) and would reset the very
	// clock this assertion is trying to observe.
	assert.ok(actors.entries().has('room-idle'), 'just under the TTL: the actor is not yet evicted')

	clock += 2 // now >= idleTtlMs past last activity
	actors.sweepIdle(idleTtlMs)
	assert.ok(!actors.entries().has('room-idle'), 'past the TTL with zero connections: the actor is evicted from the registry')

	const fresh = actors.getOrCreate('room-idle')
	assert.notEqual(fresh, actor, 'getOrCreate after an idle eviction constructs a fresh actor')
	assert.deepEqual(
		fresh.peer.doc.listShapes().map((s) => s.id),
		['shape:survives-idle'],
		'the fresh actor reloads the durably-persisted shape from disk',
	)

	actors.close()
	rmSync(dir, { recursive: true, force: true })
	console.log('ok: actors — sweepIdle() evicts a disconnected, idle-past-TTL actor; data survives via the store')
}

// ---------------------------------------------------------------------------
// Test 6 (F1) — an actor with a connected transport is NEVER evicted by
// sweepIdle(), no matter how idle (how far past idleTtlMs).
// ---------------------------------------------------------------------------
{
	const dir = mkdtempSync(path.join(tmpdir(), 'canvas-actors-idle-connected-'))
	let clock = 0
	const actors = createCanvasActors(dir, { now: () => clock })

	const actor = actors.getOrCreate('room-connected')
	const [serverTransport] = makePair()
	actor.connect(serverTransport)
	assert.equal(actor.connectionCount, 1, 'precondition: one live transport')

	clock += 10 * 60_000 // wildly past any reasonable TTL
	actors.sweepIdle(1000)
	assert.equal(actors.getOrCreate('room-connected'), actor, 'a connected actor is never evicted for idleness')
	assert.ok(actors.entries().has('room-connected'), 'entries() still lists the connected actor')

	actors.close()
	rmSync(dir, { recursive: true, force: true })
	console.log('ok: actors — a connected actor is never evicted by sweepIdle(), regardless of idleness')
}

// ---------------------------------------------------------------------------
// Test 7 (F1) — activity (a persisted update, or a getOrCreate hit) resets
// the idle clock: an actor that was about to go idle is spared by fresh
// activity, and only goes idle idleTtlMs after THAT activity.
// ---------------------------------------------------------------------------
{
	const dir = mkdtempSync(path.join(tmpdir(), 'canvas-actors-idle-reset-'))
	let clock = 0
	const actors = createCanvasActors(dir, { now: () => clock })
	const idleTtlMs = 1000

	const actor = actors.getOrCreate('room-reset')
	const [serverTransport, clientTransport] = makePair()
	actor.connect(serverTransport)
	const client = new SyncClientPeer({ peerId: 2n, transport: clientTransport })
	client.putShape(shape('shape:one')) // activity at clock=0, bumps via onActivity

	clock += idleTtlMs - 1 // just shy of eviction
	client.putShape(shape('shape:two')) // fresh activity resets the clock
	clientTransport.close()
	assert.equal(actor.connectionCount, 0, 'disconnected before the sweep')

	clock += idleTtlMs - 1 // would be stale relative to clock=0, but not relative to the reset
	actors.sweepIdle(idleTtlMs)
	// entries(), not getOrCreate() — a getOrCreate hit is itself activity and
	// would reset the very clock this assertion observes.
	assert.ok(actors.entries().has('room-reset'), 'activity reset the clock: not yet evicted')

	clock += 2
	actors.sweepIdle(idleTtlMs)
	assert.ok(!actors.entries().has('room-reset'), 'idleTtlMs after the LAST activity, the actor is now evicted')

	actors.close()
	rmSync(dir, { recursive: true, force: true })
	console.log('ok: actors — activity (a persisted update) resets the idle clock')
}

// ---------------------------------------------------------------------------
// Test 8 (F1) — taint evictions and idle evictions share one per-room
// eviction counter but are distinguishable via lastKind; neither regresses
// the other's visibility.
// ---------------------------------------------------------------------------
{
	const dir = mkdtempSync(path.join(tmpdir(), 'canvas-actors-idle-taint-mix-'))
	let clock = 0
	const actors = createCanvasActors(dir, { now: () => clock })
	const idleTtlMs = 1000

	// First: a taint eviction.
	const actor = actors.getOrCreate('room-mix')
	const [serverTransport, clientTransport] = makePair()
	actor.connect(serverTransport)
	const client = new SyncClientPeer({ peerId: 2n, transport: clientTransport })
	const store = (actor as unknown as { store: CanvasV2Store }).store
	store.appendUpdate = () => {
		throw new Error('disk hiccup (injected, mix test)')
	}
	store.compact = () => {
		throw new Error('disk hiccup (injected, mix test, compact)')
	}
	client.putShape(shape('shape:poisoned-mix'))
	assert.ok(actor.tainted, 'precondition: tainted')
	const fresh = actors.getOrCreate('room-mix')
	let record = actors.evictions().get('room-mix')
	assert.equal(record!.count, 1, 'first eviction (taint) counts as 1')
	assert.equal(record!.lastKind, 'taint', 'taint eviction is recorded with lastKind "taint"')

	// Then: idle-evict the fresh replacement (it has zero live connections —
	// `fresh` was constructed by getOrCreate above and nothing has connected
	// to it yet).
	assert.equal(fresh.connectionCount, 0, 'precondition: the fresh replacement has no connections')
	clock += idleTtlMs + 1
	actors.sweepIdle(idleTtlMs)
	assert.ok(!actors.entries().has('room-mix'), 'the fresh replacement is idle-evicted in turn')
	record = actors.evictions().get('room-mix')
	assert.equal(record!.count, 2, 'the idle eviction increments the SAME per-room counter the taint eviction started')
	assert.equal(record!.lastKind, 'idle', 'lastKind now reflects the most recent (idle) eviction')
	assert.match(record!.lastReason, /idle/, 'lastReason describes the idle cause, not the stale taint message')

	actors.close()
	rmSync(dir, { recursive: true, force: true })
	console.log('ok: actors — taint and idle evictions share one counter, distinguished by lastKind; taint visibility unregressed')
}

// ---------------------------------------------------------------------------
// Test 9 (F1) — sweep exception-safety: one actor's close() throwing during
// sweepIdle() must not skip evicting the other idle actors in the same sweep.
// ---------------------------------------------------------------------------
{
	const dir = mkdtempSync(path.join(tmpdir(), 'canvas-actors-idle-sweep-safety-'))
	let clock = 0
	const actors = createCanvasActors(dir, { now: () => clock })
	const idleTtlMs = 1000

	const poisoned = actors.getOrCreate('room-poisoned')
	const healthy = actors.getOrCreate('room-healthy')
	const originalClose = poisoned.close.bind(poisoned)
	poisoned.close = () => {
		throw new Error('close() blew up (injected)')
	}

	clock += idleTtlMs + 1
	actors.sweepIdle(idleTtlMs)

	assert.ok(actors.entries().has('room-poisoned'), 'the poisoned actor whose close() threw is left registered (not half-evicted)')
	assert.ok(!actors.entries().has('room-healthy'), "the healthy actor's eviction is NOT skipped by the poisoned one's throw")
	poisoned.close = originalClose // restore the real close() for the suite's own teardown below
	assert.equal(actors.getOrCreate('room-healthy').tainted, null, 'the healthy room reconstructs cleanly')

	actors.close()
	rmSync(dir, { recursive: true, force: true })
	console.log('ok: actors — sweepIdle() is per-actor exception-safe: one close() throwing does not skip the rest')
}

console.log('actors.test.ts: all tests passed')
