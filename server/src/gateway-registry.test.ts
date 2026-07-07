// Unit tests for the relay framing + registry core (spike spec §1/§2/§5).
// Pure fakes — no sockets, no HTTP. Run with: bun src/gateway-registry.test.ts
import assert from 'node:assert/strict'
import {
	BROWSER_BUFFER_LIMIT,
	GatewayRegistry,
	WS_OPEN,
	closeChannel,
	decodeBinaryFrame,
	encodeBinaryFrame,
	onBrowserMessage,
	onGatewayFrame,
	openChannel,
	type RelaySocket,
} from './gateway-registry.ts'

function fakeSocket() {
	const sent: Array<{ data: string | Buffer; binary: boolean }> = []
	const sock = {
		readyState: WS_OPEN,
		bufferedAmount: 0,
		closed: false,
		sent,
		send(data: string | Buffer, opts?: { binary?: boolean }) {
			sent.push({ data, binary: opts?.binary ?? false })
		},
		close() {
			this.closed = true
		},
	}
	return sock as typeof sock & RelaySocket
}

function lastJson(sock: ReturnType<typeof fakeSocket>) {
	return JSON.parse(String(sock.sent.at(-1)!.data))
}

async function main() {
	// --- binary framing round-trip ---
	const frame = encodeBinaryFrame(7, Buffer.from('hello'))
	assert.equal(frame.readUInt32BE(0), 7)
	const decoded = decodeBinaryFrame(frame)
	assert.ok(decoded)
	assert.equal(decoded.channelId, 7)
	assert.equal(decoded.payload.toString(), 'hello')
	assert.equal(decodeBinaryFrame(Buffer.from([0, 1])), null) // too short

	// --- connect / list ---
	const reg = new GatewayRegistry()
	const gw1 = fakeSocket()
	const entry1 = reg.connect('gw-a', 'Box A', gw1, 'token:a')
	assert.ok(entry1, 'first connect registers')
	assert.equal(reg.list()[0]!.gatewayId, 'gw-a')
	assert.equal(reg.list()[0]!.label, 'Box A')
	assert.equal(reg.list()[0]!.relayOnly, true)

	// --- openChannel sends relay-open with monotonic uint32 ids ---
	const browser1 = fakeSocket()
	const ch1 = openChannel(entry1, browser1, 'sess1', 80, 24)
	assert.equal(ch1, 1)
	assert.deepEqual(lastJson(gw1), {
		type: 'relay-open',
		channelId: 1,
		sessionId: 'sess1',
		cols: 80,
		rows: 24,
	})
	const ch2 = openChannel(entry1, fakeSocket(), 'sess1', 80, 24)
	assert.equal(ch2, 2)

	// --- browser → gateway wraps as relay-msg ---
	onBrowserMessage(entry1, ch1, JSON.stringify({ type: 'input', data: 'ls\r' }))
	assert.deepEqual(lastJson(gw1), {
		type: 'relay-msg',
		channelId: 1,
		msg: { type: 'input', data: 'ls\r' },
	})

	// --- gateway binary → browser binary, prefix stripped ---
	onGatewayFrame(entry1, encodeBinaryFrame(ch1, Buffer.from('out')), true)
	const bin = browser1.sent.at(-1)!
	assert.equal(bin.binary, true)
	assert.equal(bin.data.toString(), 'out')

	// --- gateway relay-msg → browser text, unwrapped ---
	onGatewayFrame(
		entry1,
		Buffer.from(JSON.stringify({ type: 'relay-msg', channelId: ch1, msg: { type: 'attached', cols: 80, rows: 24 } })),
		false
	)
	assert.deepEqual(lastJson(browser1), { type: 'attached', cols: 80, rows: 24 })

	// --- relay-closed closes the browser and forgets the channel ---
	onGatewayFrame(
		entry1,
		Buffer.from(JSON.stringify({ type: 'relay-closed', channelId: ch1 })),
		false
	)
	assert.equal(browser1.closed, true)
	assert.equal(entry1.channels.has(ch1), false)

	// --- backpressure: over-limit browser is closed, not written ---
	const slow = fakeSocket()
	const ch3 = openChannel(entry1, slow, 'sess1', 80, 24)
	slow.bufferedAmount = BROWSER_BUFFER_LIMIT + 1
	const sentBefore = slow.sent.length
	onGatewayFrame(entry1, encodeBinaryFrame(ch3, Buffer.from('x')), true)
	assert.equal(slow.closed, true)
	assert.equal(slow.sent.length, sentBefore)

	// --- closeChannel notifies the gateway ---
	const browser4 = fakeSocket()
	const ch4 = openChannel(entry1, browser4, 'sess1', 80, 24)
	closeChannel(entry1, ch4)
	assert.deepEqual(lastJson(gw1), { type: 'relay-close', channelId: ch4 })
	assert.equal(entry1.channels.has(ch4), false)

	// --- replace-on-reconnect: old ws closed, riding browsers closed ---
	const browser5 = fakeSocket()
	openChannel(entry1, browser5, 'sess1', 80, 24)
	const gw2 = fakeSocket()
	const entry2 = reg.connect('gw-a', 'Box A again', gw2, 'token:a')
	assert.ok(entry2, 'same-owner reconnect replaces')
	assert.equal(gw1.closed, true)
	assert.equal(browser5.closed, true)
	assert.equal(reg.get('gw-a'), entry2)

	// --- the replaced socket's async close must NOT deregister the new one ---
	reg.disconnect('gw-a', gw1) // stale close event arrives late
	assert.equal(reg.get('gw-a'), entry2, 'socket-identity check must protect the new entry')
	reg.disconnect('gw-a', gw2) // genuine close
	assert.equal(reg.get('gw-a'), undefined)
	assert.equal(reg.list().length, 0)

	// --- owner binding: reject a different identity, allow same-identity replace ---
	{
		const reg2 = new GatewayRegistry()
		const wsA = fakeSocket()
		const a = reg2.connect('g', 'A', wsA, 'token:a')
		assert.ok(a, 'first connect registers')
		const browser = fakeSocket()
		openChannel(a, browser, 's1', 80, 24)
		// A different identity is rejected; A + its browser survive.
		const wsB = fakeSocket()
		assert.equal(reg2.connect('g', 'B', wsB, 'token:b'), null, 'different owner → rejected')
		assert.equal(wsA.closed, false, 'existing gateway untouched')
		assert.equal(browser.closed, false, 'riding browser untouched')
		assert.equal(reg2.list()[0]!.label, 'A', 'still A')
		// Same identity reconnects → replaces (old socket + browser closed).
		const wsA2 = fakeSocket()
		const a2 = reg2.connect('g', 'A2', wsA2, 'token:a')
		assert.ok(a2, 'same owner reconnect replaces')
		assert.equal(wsA.closed, true, 'old gateway socket closed on replace')
		assert.equal(browser.closed, true, 'old riding browser closed on replace')
		assert.equal(reg2.list()[0]!.label, 'A2', 'now A2')
		console.log('ok: gateway owner binding')
	}

	console.log('gateway-registry.test.ts: all assertions passed')
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
