/**
 * Run: npx tsx src/kernel/scheduler.test.ts
 */
import assert from 'node:assert/strict'
import { createScheduler } from './scheduler'

// Fake interval host: capture registrations, fire ticks by hand.
function fakeIntervals() {
	let nextId = 1
	const live = new Map<number, { fn: () => void; ms: number }>()
	return {
		set(fn: () => void, ms: number) {
			const id = nextId++
			live.set(id, { fn, ms })
			return id as unknown as ReturnType<typeof setInterval>
		},
		clear(handle: ReturnType<typeof setInterval>) {
			live.delete(handle as unknown as number)
		},
		live,
	}
}

{
	// every() registers one interval at the requested cadence.
	const host = fakeIntervals()
	const scheduler = createScheduler(host.set, host.clear)
	let ticks = 0
	scheduler.every(150, () => ticks++)
	assert.equal(host.live.size, 1)
	assert.equal([...host.live.values()][0]!.ms, 150)
	for (const { fn } of host.live.values()) fn()
	for (const { fn } of host.live.values()) fn()
	assert.equal(ticks, 2)
}

{
	// cancel clears the interval; double-cancel is safe and never clears twice.
	const host = fakeIntervals()
	const scheduler = createScheduler(host.set, host.clear)
	const cancel = scheduler.every(1000, () => {})
	assert.equal(host.live.size, 1)
	cancel()
	assert.equal(host.live.size, 0)
	cancel() // must not throw or clear another subscription's handle
	assert.equal(host.live.size, 0)
}

{
	// Subscriptions are independent: cancelling one leaves the other ticking.
	const host = fakeIntervals()
	const scheduler = createScheduler(host.set, host.clear)
	let a = 0
	let b = 0
	const cancelA = scheduler.every(150, () => a++)
	scheduler.every(4000, () => b++)
	assert.equal(host.live.size, 2)
	cancelA()
	assert.equal(host.live.size, 1)
	for (const { fn } of host.live.values()) fn()
	assert.equal(a, 0)
	assert.equal(b, 1)
}

console.log('scheduler.test.ts: all assertions passed')
