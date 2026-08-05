// Refcounted shared poller of GET /api/terminal/list (SP3, decision log item
// 2: ~5s while mounted). Factory-injected fetch + interval so this tests with
// a stub and real (short) timers — no DOM, no network.
// Run with: bun src/codespace/gatewayPoll.test.ts
import assert from 'node:assert/strict'
import { createGatewayPoller } from './gatewayPoll'
import type { GatewayListEntry } from './gatewayView'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Subscribe → immediate cached value (null before first fetch), then data;
// interval refreshes; last unsubscribe stops polling; errors keep last value.
{
	let calls = 0
	let fail = false
	const entry: GatewayListEntry = { gatewayId: 'cs1', label: 'CS', connectedAt: 1 }
	const poller = createGatewayPoller(async () => {
		calls++
		if (fail) throw new Error('boom')
		return [entry]
	}, 20)

	const seen: Array<GatewayListEntry[] | null> = []
	const unsub = poller.subscribe((list) => seen.push(list))
	assert.equal(seen[0], null, 'subscriber gets the cache immediately (null pre-fetch)')
	await poller.refresh()
	assert.ok(calls >= 1, 'first fetch fired on subscribe')
	assert.deepEqual(seen.at(-1), [entry], 'data delivered')

	await sleep(70)
	assert.ok(calls >= 3, `interval keeps polling while subscribed (got ${calls})`)

	// A failing fetch keeps the last good value (no flicker to offline).
	fail = true
	await poller.refresh()
	assert.deepEqual(seen.at(-1), [entry], 'error keeps last good value')
	fail = false

	// Second subscriber shares the one interval and gets the cache at once.
	const seen2: Array<GatewayListEntry[] | null> = []
	const unsub2 = poller.subscribe((list) => seen2.push(list))
	assert.deepEqual(seen2[0], [entry], 'late subscriber gets cached data immediately')

	unsub()
	unsub2()
	const callsAtStop = calls
	await sleep(70)
	assert.equal(calls, callsAtStop, 'no fetches after the last unsubscribe')
}

console.log('ok: createGatewayPoller — cache, interval, refcount, error resilience')
