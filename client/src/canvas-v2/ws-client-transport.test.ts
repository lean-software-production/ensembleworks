// Run: bun src/canvas-v2/ws-client-transport.test.ts
// Locks the browser-WebSocket<->Transport bridging contract (canvas-sync/src/
// protocol.ts's JSDoc), mirroring server/src/canvas-v2/ws-transport.test.ts's
// coverage for the server-side adapter: close() idempotent, onClose
// at-most-once regardless of trigger (close, error, or local close()),
// post-close send() a silent no-op, onMessage/onClose single-listener
// last-writer-wins, binaryType forced to 'arraybuffer', and ArrayBuffer/
// Uint8Array message-payload normalization. Exercised against a fake
// WebSocketLike object — no jsdom/real socket needed for these unit-level
// assertions; the real end-to-end round trip (a real browser WebSocket
// against a real server) is CanvasV2App's integration test's job, per this
// unit's task text ("the real-socket path is covered by the integration
// test + H2").
import assert from 'node:assert/strict'
import { wsClientTransport, type WebSocketLike } from './ws-client-transport'

const CONNECTING = 0
const OPEN = 1
const CLOSING = 2
const CLOSED = 3

class FakeWs implements WebSocketLike {
	readyState = OPEN
	readonly OPEN = OPEN
	binaryType = 'blob' // deliberately the DOM default — the adapter must override it
	sent: Uint8Array[] = []
	closeCalls = 0
	onopen: (() => void) | null = null
	onmessage: ((ev: { readonly data: unknown }) => void) | null = null
	onclose: (() => void) | null = null
	onerror: (() => void) | null = null

	send(data: Uint8Array): void {
		this.sent.push(data)
	}

	// Simulates a real browser socket's close(): readyState flips
	// synchronously to CLOSING; the close callback fires asynchronously once
	// the handshake "completes" — same shape as the server test's FakeWs.
	close(): void {
		this.closeCalls++
		this.readyState = CLOSING
		queueMicrotask(() => {
			this.readyState = CLOSED
			this.onclose?.()
		})
	}
}

function microtask(): Promise<void> {
	return new Promise((r) => queueMicrotask(r))
}

async function main() {
	// Test 1 — binaryType is forced to 'arraybuffer' at construction, overriding
	// whatever the caller's socket happened to default to.
	{
		const ws = new FakeWs()
		wsClientTransport(ws)
		assert.equal(ws.binaryType, 'arraybuffer', "the adapter forces binaryType to 'arraybuffer'")
		console.log("ok: ws-client-transport — forces binaryType to 'arraybuffer'")
	}

	// Test 2 — send forwards while OPEN.
	{
		const ws = new FakeWs()
		const t = wsClientTransport(ws)
		t.send(new Uint8Array([1, 2, 3]))
		assert.deepEqual(ws.sent, [new Uint8Array([1, 2, 3])])
		console.log('ok: ws-client-transport — send forwards while OPEN')
	}

	// Test 3 — send no-ops when the underlying ws is not OPEN (e.g. CONNECTING
	// or CLOSING), even though our own close() has not been called.
	{
		const ws = new FakeWs()
		const t = wsClientTransport(ws)
		ws.readyState = CONNECTING
		t.send(new Uint8Array([9]))
		assert.deepEqual(ws.sent, [], 'no send while the socket is still CONNECTING')
		console.log('ok: ws-client-transport — send no-ops when ws is not OPEN')
	}

	// Test 4 — message normalization: ArrayBuffer and Uint8Array both normalize
	// to Uint8Array; anything else is dropped rather than delivered/thrown.
	{
		const ws = new FakeWs()
		const t = wsClientTransport(ws)
		const received: Uint8Array[] = []
		t.onMessage((bytes) => received.push(bytes))

		ws.onmessage?.({ data: new Uint8Array([1, 2, 3]).buffer })
		ws.onmessage?.({ data: new Uint8Array([4, 5]) })
		ws.onmessage?.({ data: 'not-binary' }) // dropped, not delivered

		assert.equal(received.length, 2, "a non-binary payload is dropped, never delivered")
		for (const bytes of received) assert.ok(bytes instanceof Uint8Array)
		assert.deepEqual([...received[0]!], [1, 2, 3], 'ArrayBuffer normalizes to Uint8Array')
		assert.deepEqual([...received[1]!], [4, 5], 'Uint8Array passes through unchanged')
		console.log('ok: ws-client-transport — ArrayBuffer/Uint8Array normalize; non-binary payloads are dropped')
	}

	// Test 5 — onMessage is single-listener, last-writer-wins.
	{
		const ws = new FakeWs()
		const t = wsClientTransport(ws)
		const first: Uint8Array[] = []
		const second: Uint8Array[] = []
		t.onMessage(() => first.push(new Uint8Array()))
		t.onMessage((bytes) => second.push(bytes))
		ws.onmessage?.({ data: new Uint8Array([1]) })
		assert.equal(first.length, 0, 'the first onMessage callback was replaced, not additionally invoked')
		assert.equal(second.length, 1, 'the second (current) onMessage callback fired exactly once')
		console.log('ok: ws-client-transport — onMessage is single-listener, last-writer-wins')
	}

	// Test 6 — onClose fires at most once across a double close callback.
	{
		const ws = new FakeWs()
		const t = wsClientTransport(ws)
		let fired = 0
		t.onClose(() => fired++)
		ws.onclose?.()
		ws.onclose?.()
		assert.equal(fired, 1, 'onClose fires exactly once even if the underlying close callback fires twice')
		console.log('ok: ws-client-transport — onClose fires at most once across a double close callback')
	}

	// Test 7 — onClose fires at most once when close() is called locally and
	// the real close callback follows later (the async handshake).
	{
		const ws = new FakeWs()
		const t = wsClientTransport(ws)
		let fired = 0
		t.onClose(() => fired++)
		t.close()
		assert.equal(fired, 1, 'local close() fires onClose synchronously')
		assert.equal(ws.closeCalls, 1)
		await microtask()
		await microtask()
		assert.equal(fired, 1, 'the later real close event does not fire onClose a second time')
		console.log('ok: ws-client-transport — onClose fires at most once across close()-then-event')
	}

	// Test 8 — close() is idempotent.
	{
		const ws = new FakeWs()
		const t = wsClientTransport(ws)
		let fired = 0
		t.onClose(() => fired++)
		t.close()
		t.close()
		assert.equal(fired, 1, 'onClose still fired only once')
		assert.equal(ws.closeCalls, 1, 'ws.close() itself was only invoked once (idempotent)')
		console.log('ok: ws-client-transport — close() is idempotent')
	}

	// Test 9 — post-close send() is a silent no-op, even though ws.readyState
	// may still report CLOSING (the async handshake has not completed yet).
	{
		const ws = new FakeWs()
		const t = wsClientTransport(ws)
		t.close()
		assert.equal(ws.readyState, CLOSING, "precondition: the underlying ws hasn't finished its async close yet")
		t.send(new Uint8Array([1]))
		assert.deepEqual(ws.sent, [], 'send after close() is a silent no-op')
		console.log('ok: ws-client-transport — post-close send is a silent no-op')
	}

	// Test 10 — an error callback is treated as close: onClose fires, and a
	// later close callback (a real socket commonly fires both) does not fire
	// it again.
	{
		const ws = new FakeWs()
		const t = wsClientTransport(ws)
		let fired = 0
		t.onClose(() => fired++)
		ws.onerror?.()
		assert.equal(fired, 1, 'an error callback is treated as a close')
		ws.onclose?.()
		assert.equal(fired, 1, 'a close callback following an error does not fire onClose again')
		console.log('ok: ws-client-transport — error callback is treated as close, at most once')
	}

	// Test 11 — Task E1: initial state is 'connecting', and transitions to
	// 'open' once the underlying socket's onopen fires.
	{
		const ws = new FakeWs()
		const t = wsClientTransport(ws)
		assert.equal(t.getConnectionState(), 'connecting', "initial state is 'connecting' before the socket opens")
		const seen: string[] = []
		t.onConnectionStateChange((s) => seen.push(s))
		ws.onopen?.()
		assert.equal(t.getConnectionState(), 'open', "getConnectionState() reports 'open' once onopen fires")
		assert.deepEqual(seen, ['open'], 'onConnectionStateChange fired exactly once, with the new state')
		console.log("ok: ws-client-transport — connection state starts 'connecting', transitions to 'open' on onopen")
	}

	// Test 12 — Task E1: the "dead dogfood" case. The socket errors/closes
	// BEFORE ever opening (e.g. wrong port, route absent, EW_CANVAS_SYNC unset
	// server-side) — state lands on 'failed', not 'reconnecting'.
	{
		const ws = new FakeWs()
		const t = wsClientTransport(ws)
		const seen: string[] = []
		t.onConnectionStateChange((s) => seen.push(s))
		ws.onerror?.() // never opened first
		assert.equal(t.getConnectionState(), 'failed', 'an error before ever opening lands on failed, not reconnecting')
		assert.deepEqual(seen, ['failed'], 'onConnectionStateChange fired with failed')
		console.log("ok: ws-client-transport — errors/closes before ever opening report 'failed' (the dead-dogfood case)")
	}

	// Test 13 — Task E1: closing AFTER having been open lands on
	// 'reconnecting' (inferred from close-after-open — see the module
	// header's note on why this is not a real retry-in-progress signal).
	{
		const ws = new FakeWs()
		const t = wsClientTransport(ws)
		ws.onopen?.()
		assert.equal(t.getConnectionState(), 'open', 'precondition: the socket opened')
		const seen: string[] = []
		t.onConnectionStateChange((s) => seen.push(s))
		ws.onclose?.()
		assert.equal(t.getConnectionState(), 'reconnecting', 'a close after having been open lands on reconnecting, not failed')
		assert.deepEqual(seen, ['reconnecting'], 'onConnectionStateChange fired with reconnecting')
		console.log("ok: ws-client-transport — a close after having been open reports 'reconnecting' (inferred from close-after-open)")
	}

	// Test 14 — Task E1: onConnectionStateChange is single-listener,
	// last-writer-wins, mirroring onMessage/onClose's own contract.
	{
		const ws = new FakeWs()
		const t = wsClientTransport(ws)
		const first: string[] = []
		const second: string[] = []
		t.onConnectionStateChange((s) => first.push(s))
		t.onConnectionStateChange((s) => second.push(s))
		ws.onopen?.()
		assert.equal(first.length, 0, 'the first onConnectionStateChange callback was replaced, not additionally invoked')
		assert.deepEqual(second, ['open'], 'the second (current) callback fired exactly once, with the new state')
		console.log('ok: ws-client-transport — onConnectionStateChange is single-listener, last-writer-wins')
	}

	// Test 15 — Task E1 (additive, re-proving the existing contract): the
	// connection-state signal layers on top of the SAME fireClose funnel —
	// close()/onClose's at-most-once and idempotent guarantees are unchanged.
	// A double local close() still invokes ws.close() once and onClose once,
	// and the state settles to a single terminal value.
	{
		const ws = new FakeWs()
		const t = wsClientTransport(ws)
		let closeFired = 0
		t.onClose(() => closeFired++)
		const states: string[] = []
		t.onConnectionStateChange((s) => states.push(s))
		t.close()
		t.close()
		assert.equal(closeFired, 1, 'onClose still fires exactly once (additive change did not alter the at-most-once contract)')
		assert.equal(ws.closeCalls, 1, 'ws.close() is still only invoked once (close() is still idempotent)')
		assert.deepEqual(states, ['failed'], 'the connection state settled once, to failed (never having opened)')
		console.log('ok: ws-client-transport — connection-state signal is additive: close()/onClose contracts unchanged')
	}

	console.log('ws-client-transport.test.ts: all tests passed')
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
