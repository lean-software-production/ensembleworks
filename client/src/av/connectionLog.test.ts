/**
 * connectionLog buffer: batches events, flushes once per debounce, never throws.
 * Run: bun src/av/connectionLog.test.ts
 */
import assert from 'node:assert/strict'
import { createConnectionLog } from './connectionLog'

const sent: unknown[][] = []
const scheduledFns: Array<() => void> = []
const log = createConnectionLog({
	send: (events) => sent.push(events),
	now: () => 1000,
	schedule: (fn) => {
		scheduledFns.push(fn)
		return 1
	},
	cancel: () => {
		scheduledFns.length = 0
	},
})

log.log({ roomId: 'team', userId: 'u1', plane: 'livekit', event: 'reconnecting' })
log.log({ roomId: 'team', userId: 'u1', plane: 'sync', event: 'offline' })
assert.equal(sent.length, 0, 'nothing sent before the debounce fires')
assert.equal(scheduledFns.length, 1, 'exactly one flush scheduled for the batch')

scheduledFns[0]!() // fire the debounce
assert.equal(sent.length, 1, 'one batched send')
assert.equal((sent[0] as unknown[]).length, 2, 'both events in the batch')
assert.equal((sent[0] as { ts: number }[])[0]!.ts, 1000, 'stamped from now()')

// A send that throws must not propagate (fire-and-forget).
const boom = createConnectionLog({
	send: () => {
		throw new Error('beacon failed')
	},
	schedule: (fn) => {
		fn()
		return 0
	},
	cancel: () => {},
})
boom.log({ roomId: 'team', userId: 'u1', plane: 'sync', event: 'online' }) // must not throw

console.log('ok: connectionLog')
