// supervise (decision #5): fast-crashing runOnce walks the 1s→2s→4s parity
// backoff (rng=0.5 neutralises jitter); a run outliving the 30s
// healthy-duration resets the curve; abort during backoff stops the loop.
// Fake clock throughout. Run with: bun src/codespace/supervise.test.ts
import assert from 'node:assert/strict'
import type { Timers } from '../connector/relay-client.ts'
import { supervise } from './supervise.ts'

class FakeTimers implements Timers {
	clock = 0
	nextId = 1
	pending: { at: number; fn: () => void; id: number }[] = []
	scheduled: number[] = [] // every setTimeout delay, in order
	now() { return this.clock }
	setTimeout(fn: () => void, ms: number) {
		this.scheduled.push(ms)
		const id = this.nextId++
		this.pending.push({ at: this.clock + ms, fn, id })
		return id as unknown as ReturnType<typeof setTimeout>
	}
	clearTimeout(h: ReturnType<typeof setTimeout>) {
		this.pending = this.pending.filter((p) => p.id !== (h as unknown as number))
	}
	setInterval(): ReturnType<typeof setInterval> { throw new Error('unused') }
	clearInterval(): void { throw new Error('unused') }
	async advance(ms: number) {
		this.clock += ms
		const due = this.pending.filter((p) => p.at <= this.clock)
		this.pending = this.pending.filter((p) => p.at > this.clock)
		for (const d of due) d.fn()
	}
}

const tick = () => new Promise<void>((r) => setImmediate(r))

const timers = new FakeTimers()
const ac = new AbortController()
let runs = 0
let healthyOnRun = -1
const done = supervise(async () => {
	runs++
	if (runs === healthyOnRun) timers.clock += 31_000 // this run "lived" 31s
}, { timers, rng: () => 0.5 }, ac.signal)

await tick()
assert.equal(runs, 1, 'first run starts immediately')
assert.deepEqual(timers.scheduled, [1_000], 'attempt 1 → 1s')

await timers.advance(1_000); await tick()
assert.equal(runs, 2)
assert.deepEqual(timers.scheduled, [1_000, 2_000], 'attempt 2 → 2s')

await timers.advance(2_000); await tick()
assert.equal(runs, 3)
assert.deepEqual(timers.scheduled, [1_000, 2_000, 4_000], 'attempt 3 → 4s')

// Run 4 lives >30s on the fake clock → the attempt counter resets to 1s.
healthyOnRun = 4
await timers.advance(4_000); await tick()
assert.equal(runs, 4)
assert.deepEqual(timers.scheduled, [1_000, 2_000, 4_000, 1_000], 'healthy run resets the curve')

// Abort during the pending backoff → the loop resolves, no run 5.
ac.abort()
await done
assert.equal(runs, 4, 'no run after abort')

// A pre-aborted signal never runs at all.
{
	const ac2 = new AbortController()
	ac2.abort()
	let ran = false
	await supervise(async () => { ran = true }, { timers: new FakeTimers(), rng: () => 0.5 }, ac2.signal)
	assert.equal(ran, false, 'pre-aborted signal short-circuits')
}

console.log('ok: supervise — backoff curve, healthy-duration reset, abort semantics')
