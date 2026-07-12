// Run: bun src/canvas-v2/ws-transport.test.ts
// Locks the ws<->Transport bridging contract (canvas-sync/src/protocol.ts's
// JSDoc): close() idempotent, onClose at-most-once regardless of trigger (ws
// 'close', ws 'error', or local close()), post-close send() a silent no-op,
// onMessage/onClose single-listener last-writer-wins, and ws message-payload
// normalization (Buffer/ArrayBuffer/Buffer[] -> Uint8Array). Exercised against
// a fake ws-like EventEmitter — no real socket needed for these unit-level
// assertions; the real end-to-end round trip lives in
// canvas-v2-sync-mount.test.ts.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { wsTransport } from './ws-transport.ts'

const OPEN = 1
const CLOSING = 2
const CLOSED = 3

class FakeWs extends EventEmitter {
	readyState = OPEN
	readonly OPEN = OPEN
	sent: unknown[] = []
	closeCalls = 0

	send(data: unknown): void {
		this.sent.push(data)
	}

	// Simulates ws's real close(): readyState flips synchronously to CLOSING;
	// the 'close' event fires asynchronously once the handshake "completes".
	close(): void {
		this.closeCalls++
		this.readyState = CLOSING
		queueMicrotask(() => {
			this.readyState = CLOSED
			this.emit('close', 1000)
		})
	}
}

function microtask(): Promise<void> {
	return new Promise((r) => queueMicrotask(r))
}

async function main() {
	// Test 1 — send forwards while OPEN.
	{
		const ws = new FakeWs()
		const t = wsTransport(ws as any)
		t.send(new Uint8Array([1, 2, 3]))
		assert.deepEqual(ws.sent, [new Uint8Array([1, 2, 3])])
		console.log('ok: ws-transport — send forwards while OPEN')
	}

	// Test 2 — send no-ops when the underlying ws is not OPEN (e.g. CLOSING),
	// even though our own close() has not been called.
	{
		const ws = new FakeWs()
		const t = wsTransport(ws as any)
		ws.readyState = CLOSING
		t.send(new Uint8Array([9]))
		assert.deepEqual(ws.sent, [], 'no send while the socket is not OPEN')
		console.log('ok: ws-transport — send no-ops when ws is not OPEN')
	}

	// Test 3 — message normalization: Buffer, ArrayBuffer, and Buffer[] (the
	// 'fragments' binaryType shape) all normalize to Uint8Array.
	{
		const ws = new FakeWs()
		const t = wsTransport(ws as any)
		const received: Uint8Array[] = []
		t.onMessage((bytes) => received.push(bytes))

		ws.emit('message', Buffer.from([1, 2, 3]))
		ws.emit('message', new Uint8Array([4, 5]).buffer)
		ws.emit('message', [Buffer.from([6]), Buffer.from([7, 8])])

		assert.equal(received.length, 3)
		for (const bytes of received) assert.ok(bytes instanceof Uint8Array)
		assert.deepEqual([...received[0]!], [1, 2, 3])
		assert.deepEqual([...received[1]!], [4, 5])
		assert.deepEqual([...received[2]!], [6, 7, 8], 'a fragmented Buffer[] is concatenated before normalizing')
		console.log('ok: ws-transport — Buffer/ArrayBuffer/Buffer[] all normalize to Uint8Array')
	}

	// Test 4 — onMessage is single-listener, last-writer-wins (mirrors the
	// memory transport): a second onMessage() call REPLACES the first rather
	// than adding a second delivery.
	{
		const ws = new FakeWs()
		const t = wsTransport(ws as any)
		const first: Uint8Array[] = []
		const second: Uint8Array[] = []
		t.onMessage(() => first.push(new Uint8Array()))
		t.onMessage((bytes) => second.push(bytes))
		ws.emit('message', Buffer.from([1]))
		assert.equal(first.length, 0, 'the first onMessage callback was replaced, not additionally invoked')
		assert.equal(second.length, 1, 'the second (current) onMessage callback fired exactly once')
		console.log('ok: ws-transport — onMessage is single-listener, last-writer-wins')
	}

	// Test 5 — onClose fires at most once across a double 'close' emission.
	{
		const ws = new FakeWs()
		const t = wsTransport(ws as any)
		let fired = 0
		t.onClose(() => fired++)
		ws.emit('close', 1000)
		ws.emit('close', 1000)
		assert.equal(fired, 1, 'onClose fires exactly once even if the ws close event fires twice')
		console.log("ok: ws-transport — onClose fires at most once across a double 'close' emission")
	}

	// Test 6 — onClose fires at most once when close() is called locally and
	// the real ws 'close' event follows later (the async handshake).
	{
		const ws = new FakeWs()
		const t = wsTransport(ws as any)
		let fired = 0
		t.onClose(() => fired++)
		t.close()
		assert.equal(fired, 1, 'local close() fires onClose synchronously')
		assert.equal(ws.closeCalls, 1)
		await microtask()
		await microtask()
		assert.equal(fired, 1, 'the later real close event does not fire onClose a second time')
		console.log('ok: ws-transport — onClose fires at most once across close()-then-event')
	}

	// Test 7 — close() is idempotent.
	{
		const ws = new FakeWs()
		const t = wsTransport(ws as any)
		let fired = 0
		t.onClose(() => fired++)
		t.close()
		t.close()
		assert.equal(fired, 1, 'onClose still fired only once')
		assert.equal(ws.closeCalls, 1, 'ws.close() itself was only invoked once (idempotent)')
		console.log('ok: ws-transport — close() is idempotent')
	}

	// Test 8 — post-close send() is a silent no-op, even though ws.readyState
	// may still report CLOSING (the async handshake has not completed yet)
	// rather than CLOSED — the guard is OUR flag, not ws.readyState alone.
	{
		const ws = new FakeWs()
		const t = wsTransport(ws as any)
		t.close()
		assert.equal(ws.readyState, CLOSING, 'precondition: the underlying ws has not finished its async close yet')
		t.send(new Uint8Array([1]))
		assert.deepEqual(ws.sent, [], 'send after close() is a silent no-op')
		console.log('ok: ws-transport — post-close send is a silent no-op')
	}

	// Test 9 — an 'error' event is treated as close: onClose fires, and a
	// later 'close' event (ws commonly emits both) does not fire it again.
	{
		const ws = new FakeWs()
		const t = wsTransport(ws as any)
		let fired = 0
		t.onClose(() => fired++)
		ws.emit('error', new Error('boom'))
		assert.equal(fired, 1, 'an error event is treated as a close')
		ws.emit('close', 1006)
		assert.equal(fired, 1, 'a close event following an error does not fire onClose again')
		console.log('ok: ws-transport — error event is treated as close, at most once')
	}

	console.log('ws-transport.test.ts: all tests passed')
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
