// client/src/file-viewer/presentBroadcast.test.ts
// Run with: bun src/file-viewer/presentBroadcast.test.ts
import assert from 'node:assert/strict'
import { createPresentBroadcaster } from './presentBroadcast'

// Batching: events pushed between ticks go out as one POST with seq order.
const posts: { url: string; body: any }[] = []
let tick: () => Promise<void> = async () => {}
const b = createPresentBroadcaster({
	roomId: 'r1',
	shapeId: 'shape:a',
	presentId: 'p1',
	postJson: async (url, body) => {
		posts.push({ url, body })
		return { ok: true }
	},
	setIntervalFn: ((fn: () => void) => {
		tick = async () => fn()
		return 1 as any
	}) as any,
	clearIntervalFn: (() => {}) as any,
})
b.push({ type: 4 })
b.push({ type: 2 })
await tick()
assert.equal(posts.length, 1)
assert.equal(posts[0].url, '/api/canvas/file-viewer/present-events')
assert.deepEqual(posts[0].body.entries.map((e: any) => e.seq), [0, 1])
assert.equal(posts[0].body.presentId, 'p1')

// Nothing pending → no POST.
await tick()
assert.equal(posts.length, 1)

// Failures accumulate events, then degrade after failAfterMs.
let degraded = 0
let t = 0
const failPosts: any[] = []
let tick2: () => Promise<void> = async () => {}
const b2 = createPresentBroadcaster({
	roomId: 'r1',
	shapeId: 'shape:b',
	presentId: 'p2',
	now: () => t,
	failAfterMs: 5000,
	onDegrade: () => degraded++,
	postJson: async (url, body) => {
		failPosts.push(body)
		throw new Error('network down')
	},
	setIntervalFn: ((fn: () => void) => {
		tick2 = async () => fn()
		return 1 as any
	}) as any,
	clearIntervalFn: (() => {}) as any,
})
b2.push({ type: 4 })
t = 0
await tick2()
b2.push({ type: 3 })
t = 6000
await tick2()
assert.equal(degraded, 1, 'degrades once after sustained failure')
// Retry batches kept accumulating (same events retried, not dropped).
assert.ok(failPosts[failPosts.length - 1].entries.length >= 2)

// stop(): flushes tail then posts present-stop.
const stopPosts: { url: string; body: any }[] = []
const b3 = createPresentBroadcaster({
	roomId: 'r1',
	shapeId: 'shape:c',
	presentId: 'p3',
	postJson: async (url, body) => {
		stopPosts.push({ url, body })
		return { ok: true }
	},
	setIntervalFn: (() => 1) as any,
	clearIntervalFn: (() => {}) as any,
})
b3.push({ type: 4 })
await b3.stop()
assert.deepEqual(stopPosts.map((p) => p.url), [
	'/api/canvas/file-viewer/present-events',
	'/api/canvas/file-viewer/present-stop',
])

// Concurrency: stop waits for in-flight flushes before proceeding.
// Events pushed during a deferred flush go into the next batch, and
// stop() waits for the in-flight flush promise before running a final
// flush and posting present-stop. This catches the bugs where:
// (1) stop() races present-stop ahead of in-flight present-events, and
// (2) events pushed during postJson await are lost by reference-sharing.
let tick3: () => Promise<void> = async () => {}
let flushResolveFunc: ((value?: void) => void) | null = null
let deferredCount = 0
const deferredPosts: { url: string; body: any }[] = []

function deferredFlush(resolve: (value?: void) => void): void {
	flushResolveFunc = resolve
}

const b4 = createPresentBroadcaster({
	roomId: 'r1',
	shapeId: 'shape:d',
	presentId: 'p4',
	postJson: async (url, body) => {
		deferredPosts.push({ url, body })
		if (url === '/api/canvas/file-viewer/present-events' && deferredCount === 0) {
			// Defer only the first present-events POST to test concurrency
			deferredCount++
			await new Promise<void>(deferredFlush)
		}
		return { ok: true }
	},
	setIntervalFn: ((fn: () => void) => {
		tick3 = async () => fn()
		return 1 as any
	}) as any,
	clearIntervalFn: (() => {}) as any,
})
b4.push({ type: 5 })
const tickPromise = tick3() // start a flush, it will defer
// Now push while flush is in flight
b4.push({ type: 6 })
// And call stop while flush is still pending
const stopPromise = b4.stop()
// Now resolve the deferred flush so stop can proceed
const resolve = flushResolveFunc as ((value?: void) => void) | null
if (resolve) {
	resolve()
}
await tickPromise
await stopPromise

// Assert: event 0 in first flush (snapshotted before event 1 was pushed)
const firstFlushSeqs = deferredPosts[0].body.entries.map((e: any) => e.seq)
assert.deepEqual(firstFlushSeqs, [0], 'event 0 sent in first flush')
// Assert: event 1 in second flush (pushed during first flush, sent by stop)
const secondFlushSeqs = deferredPosts[1].body.entries.map((e: any) => e.seq)
assert.deepEqual(secondFlushSeqs, [1], 'event 1 sent in second flush after stop waits for in-flight')
// Assert: present-stop is final POST
assert.equal(deferredPosts[deferredPosts.length - 1].url, '/api/canvas/file-viewer/present-stop', 'present-stop is final')

process.stdout.write('presentBroadcast tests passed\n')
