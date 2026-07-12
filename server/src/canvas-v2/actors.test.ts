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

console.log('actors.test.ts: all tests passed')
