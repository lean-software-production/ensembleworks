// relay-client transport (port of relay.go Run/serveOnce) on a fake clock +
// fake WS: the dial config (headers incl. the CF-Access pair vs none, plus the
// 1 MiB maxPayload) is passed to the WS ctor; a missed pong at 20s forces
// serveOnce to resolve (redial); runTransport backs off by computeBackoff
// between attempts, resets the counter after a >30s healthy connection, and an
// abort ends the loop promptly with no dangling timer.
// Run with: bun src/connector/reconnect.test.ts
import assert from 'node:assert/strict'
import {
	computeBackoff,
	RELAY_PING_INTERVAL_MS,
	RELAY_READ_LIMIT_BYTES,
} from '@ensembleworks/contracts/relay-parity'
import { runTransport, serveOnce, type Timers, type TransportDeps } from './relay-client.ts'

// A controllable clock: records the last scheduled timeout, fires timeouts on
// demand, and advances interval ticks. Injected only into relay-client; the
// test's own awaits use real microtasks (flush()).
class FakeClock implements Timers {
	private t = 0
	private timeouts = new Map<number, { fn: () => void; at: number }>()
	private intervals = new Map<number, { fn: () => void; every: number; next: number }>()
	private seq = 1
	lastTimeoutMs = -1
	now() { return this.t }
	setTimeout(fn: () => void, ms: number) {
		const h = this.seq++
		this.timeouts.set(h, { fn, at: this.t + ms })
		this.lastTimeoutMs = ms
		return h as unknown as ReturnType<typeof setTimeout>
	}
	clearTimeout(h: ReturnType<typeof setTimeout>) { this.timeouts.delete(h as unknown as number) }
	setInterval(fn: () => void, ms: number) {
		const h = this.seq++
		this.intervals.set(h, { fn, every: ms, next: this.t + ms })
		return h as unknown as ReturnType<typeof setInterval>
	}
	clearInterval(h: ReturnType<typeof setInterval>) { this.intervals.delete(h as unknown as number) }
	/** Fire the single pending backoff timeout (the loop has at most one). */
	fireTimeout() {
		const [h, entry] = [...this.timeouts.entries()][0] ?? []
		if (!entry || h === undefined) throw new Error('no pending timeout')
		this.timeouts.delete(h)
		this.t = entry.at
		entry.fn()
	}
	/** Advance `ms`, firing every interval tick that comes due. */
	advance(ms: number) {
		const target = this.t + ms
		while (true) {
			let next: { fn: () => void; key: number; at: number } | null = null
			for (const [k, v] of this.intervals) if (v.next <= target && (!next || v.next < next.at)) next = { fn: v.fn, key: k, at: v.next }
			if (!next) break
			this.t = next.at
			const iv = this.intervals.get(next.key)!
			iv.next += iv.every
			next.fn()
		}
		this.t = target
	}
	pendingTimeouts() { return this.timeouts.size }
}

// Fake WS: captures ctor args, exposes emit() + ping/terminate counters.
class FakeWs {
	static all: FakeWs[] = []
	url: string
	opts: { headers: Record<string, string>; maxPayload: number }
	pings = 0
	terminated = false
	private handlers = new Map<string, (...a: unknown[]) => void>()
	constructor(url: string, opts: FakeWs['opts']) {
		this.url = url
		this.opts = opts
		FakeWs.all.push(this)
	}
	on(ev: string, fn: (...a: unknown[]) => void) { this.handlers.set(ev, fn) }
	emit(ev: string, ...a: unknown[]) { this.handlers.get(ev)?.(...a) }
	ping() { this.pings++ }
	terminate() { this.terminated = true }
	send() {}
}
const makeDeps = (clock: FakeClock): TransportDeps => ({
	timers: clock,
	rng: () => 0.5, // jitter factor 1.0 → computeBackoff returns the exact base
	WebSocketCtor: FakeWs as unknown as TransportDeps['WebSocketCtor'],
})
const flush = () => new Promise((r) => setTimeout(r, 0)) // real microtask drain
const stubMgr = { detachAll() {} } as unknown as Parameters<typeof serveOnce>[2]

// 1. Dial config: the CF-Access pair + maxPayload reach the WS ctor; a none
//    instance sends no auth headers.
{
	FakeWs.all = []
	const clock = new FakeClock()
	const headers = { 'CF-Access-Client-Id': 'i', 'CF-Access-Client-Secret': 's' }
	const ac = new AbortController()
	const p = serveOnce('wss://h/api/terminal/connect', headers, stubMgr, makeDeps(clock), ac.signal)
	await flush()
	assert.equal(FakeWs.all[0]!.url, 'wss://h/api/terminal/connect')
	assert.deepEqual(FakeWs.all[0]!.opts.headers, headers, 'CF-Access pair on the dial')
	assert.equal(FakeWs.all[0]!.opts.maxPayload, RELAY_READ_LIMIT_BYTES, '1 MiB read limit')
	ac.abort()
	await p
}
{
	FakeWs.all = []
	const clock = new FakeClock()
	const ac = new AbortController()
	const p = serveOnce('ws://h/api/terminal/connect', {}, stubMgr, makeDeps(clock), ac.signal)
	await flush()
	assert.deepEqual(FakeWs.all[0]!.opts.headers, {}, 'a none instance dials with no auth headers')
	ac.abort()
	await p
}

// 2. Missed pong → serveOnce resolves (forces a redial).
{
	FakeWs.all = []
	const clock = new FakeClock()
	const p = serveOnce('ws://h', {}, stubMgr, makeDeps(clock), new AbortController().signal)
	await flush()
	const ws = FakeWs.all[0]!
	ws.emit('open')                       // starts the heartbeat interval
	clock.advance(RELAY_PING_INTERVAL_MS) // 1st tick: alive → ping, alive=false
	assert.equal(ws.pings, 1, 'a ping is sent on the first tick')
	clock.advance(RELAY_PING_INTERVAL_MS) // 2nd tick: still !alive → done()
	await p                               // resolves → the loop would redial
	assert.equal(ws.terminated, true, 'the half-open socket is terminated')
}

// 3. The reconnect loop: backoff between attempts, then a healthy reset.
{
	FakeWs.all = []
	const clock = new FakeClock()
	const ac = new AbortController()
	const loop = runTransport('ws://h', {}, stubMgr, makeDeps(clock), ac.signal)
	await flush()
	assert.equal(FakeWs.all.length, 1, 'first dial')
	FakeWs.all[0]!.emit('close')          // connection 1 ends
	await flush()
	assert.equal(clock.lastTimeoutMs, computeBackoff(1, () => 0.5), 'attempt 1 → 1s')
	clock.fireTimeout()
	await flush()
	assert.equal(FakeWs.all.length, 2, 'redial after the backoff')
	FakeWs.all[1]!.emit('close')          // connection 2 ends
	await flush()
	assert.equal(clock.lastTimeoutMs, computeBackoff(2, () => 0.5), 'attempt 2 → 2s')
	clock.fireTimeout()
	await flush()
	// connection 3 stays up longer than the healthy threshold, then drops → reset.
	clock.advance(31_000)
	FakeWs.all[2]!.emit('close')
	await flush()
	assert.equal(clock.lastTimeoutMs, computeBackoff(1, () => 0.5), 'a >30s healthy connection resets the counter to attempt 1')
	// 4. abort ends the loop promptly with no dangling timer.
	ac.abort()
	await loop
	assert.equal(clock.pendingTimeouts(), 0, 'abort clears the pending backoff timer')
}

console.log('ok: reconnect — dial config (CF-Access pair vs none + 1 MiB maxPayload), missed-pong redial, backoff curve between attempts, healthy-duration reset, prompt abort')
