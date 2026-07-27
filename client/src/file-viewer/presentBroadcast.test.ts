// client/src/file-viewer/presentBroadcast.test.ts
// Run with: bun src/file-viewer/presentBroadcast.test.ts
import assert from 'node:assert/strict'
import { createPresentBroadcaster } from './presentBroadcast.ts'

async function main() {
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
	t = 0; await tick2()
	b2.push({ type: 3 })
	t = 6000; await tick2()
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

	console.log('presentBroadcast tests passed')
}

main()
