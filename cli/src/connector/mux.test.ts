// RelayMux (port of relay.go serveOnce/runChannel) over a fake WS + fake
// manager: relay-open→attach with an attached reply; per-channel FIFO ordering
// (open before a same-turn resize); the shed DATA STRUCTURE under forced
// reentrancy (depth-64 cap + shed-on-full + shed-close) — unreachable in the
// real synchronous-drain path (spec §6.2), so driven directly; input/resize
// dispatch; attach failure → relay-closed; binary + non-JSON ignored; output
// framing via the 4-byte BE encodeBinaryFrame prefix.
// Run with: bun src/connector/mux.test.ts
import assert from 'node:assert/strict'
import { encodeBinaryFrame } from './frame.ts'
import { ChannelQueue, RelayMux, type WsLike } from './mux.ts'
import type { ChannelSink, ConnectorSessionManager } from './session.ts'

// Fake WS: record every send with its binary flag.
function makeWs() {
	const sent: Array<{ data: string | Buffer; binary: boolean }> = []
	const ws: WsLike = { send: (data, opts) => sent.push({ data, binary: opts?.binary === true }) }
	return { ws, sent }
}
const texts = (sent: Array<{ data: string | Buffer; binary: boolean }>) =>
	sent.filter((s) => !s.binary).map((s) => JSON.parse(String(s.data)))

// Fake manager: records calls; attach can be steered to succeed/fail and can
// simulate the session manager pushing down an attached message + one output.
function makeMgr(opts: { attachOk?: boolean } = {}) {
	const calls: string[] = []
	const mgr = {
		attach(id: string, ch: number, cols: number, rows: number, sink: ChannelSink): boolean {
			calls.push(`attach ${id} ${ch} ${cols}x${rows}`)
			if (opts.attachOk === false) return false
			sink.sendMsg({ type: 'attached', cols, rows })
			sink.sendOutput(Buffer.from('X'))
			return true
		},
		input(id: string, ch: number, data: string) { calls.push(`input ${id} ${ch} ${data}`) },
		resize(id: string, cols: number, rows: number) { calls.push(`resize ${id} ${cols}x${rows}`) },
		detach(id: string, ch: number) { calls.push(`detach ${id} ${ch}`) },
	} as unknown as ConnectorSessionManager
	return { mgr, calls }
}

// 1. relay-open → attach + attached reply + binary output frame.
{
	const { ws, sent } = makeWs()
	const { mgr, calls } = makeMgr()
	const mux = new RelayMux(ws, mgr)
	mux.handle(JSON.stringify({ type: 'relay-open', channelId: 7, sessionId: 's', cols: 80, rows: 24 }), false)
	assert.deepEqual(calls, ['attach s 7 80x24'])
	const t = texts(sent)
	assert.deepEqual(t[0], { type: 'relay-msg', channelId: 7, msg: { type: 'attached', cols: 80, rows: 24 } })
	const bin = sent.find((s) => s.binary)!
	assert.deepEqual(bin.data, encodeBinaryFrame(7, Buffer.from('X')), 'output uses the 4-byte BE frame')
	assert.equal((bin.data as Buffer).readUInt32BE(0), 7, 'channel id in the BE prefix')
}

// 2. per-channel FIFO ordering: open, then a same-turn resize → attach BEFORE resize.
{
	const { ws } = makeWs()
	const { mgr, calls } = makeMgr()
	const mux = new RelayMux(ws, mgr)
	mux.handle(JSON.stringify({ type: 'relay-open', channelId: 1, sessionId: 's', cols: 80, rows: 24 }), false)
	mux.handle(JSON.stringify({ type: 'relay-msg', channelId: 1, msg: { type: 'resize', cols: 120, rows: 50 } }), false)
	assert.deepEqual(calls, ['attach s 1 80x24', 'resize s 120x50'])
}

// 3. input/resize dispatch through relay-msg.
{
	const { ws } = makeWs()
	const { mgr, calls } = makeMgr()
	const mux = new RelayMux(ws, mgr)
	mux.handle(JSON.stringify({ type: 'relay-open', channelId: 1, sessionId: 's', cols: 80, rows: 24 }), false)
	mux.handle(JSON.stringify({ type: 'relay-msg', channelId: 1, msg: { type: 'input', data: 'hi' } }), false)
	mux.handle(JSON.stringify({ type: 'relay-close', channelId: 1 }), false)
	assert.deepEqual(calls, ['attach s 1 80x24', 'input s 1 hi', 'detach s 1'])
}

// 4. attach failure → relay-closed; binary + non-JSON ignored.
{
	const { ws, sent } = makeWs()
	const { mgr } = makeMgr({ attachOk: false })
	const mux = new RelayMux(ws, mgr)
	mux.handle(JSON.stringify({ type: 'relay-open', channelId: 3, sessionId: 's', cols: 80, rows: 24 }), false)
	assert.deepEqual(texts(sent).at(-1), { type: 'relay-closed', channelId: 3 })
	const before = sent.length
	mux.handle(Buffer.from([0, 0, 0, 1]), true) // binary → ignored
	mux.handle('not json', false)               // non-JSON → ignored
	assert.equal(sent.length, before, 'binary + non-JSON frames produce no output')
}

// 5. THE SHED DATA STRUCTURE (guard rail; unreachable in real dispatch — §6.2).
//    Force reentrancy so the synchronous drain cannot empty the queue, fill it
//    to 64, and assert the 65th enqueue sheds; then shed-close clears it.
{
	const results: boolean[] = []
	let filled = false
	const q = new ChannelQueue(() => {
		if (filled) return
		filled = true
		// Re-enter from inside onItem while drain holds `draining` true: pushes
		// accumulate instead of pumping, so the depth cap becomes observable.
		for (let i = 0; i < 100; i++) results.push(q.enqueue({ type: 'relay-msg', channelId: 1 }))
	})
	q.enqueue({ type: 'relay-open', channelId: 1 })
	assert.equal(results.slice(0, 64).every(Boolean), true, 'the first 64 enqueue')
	assert.equal(results[64], false, 'the 65th sheds (depth-64 cap)')
	assert.equal(results.filter((r) => !r).length, 100 - 64, 'everything past 64 sheds')
	// shed-close: after close(), the queue is inert (drops further work) — this is
	// what unblocks a queue nothing will drain when a relay-close is shed. The
	// outer drain() unwinds fully once onItem's reentrant burst returns (each
	// deferred item is a now-no-op callback), so the queue is empty again by
	// this point — close() must be invoked explicitly here (as RelayMux's own
	// dispatcher does when a relay-close is shed) to observe shed-on-closed.
	q.close()
	assert.equal(q.enqueue({ type: 'relay-close', channelId: 1 }), false, 'closed queue sheds')
}

console.log('ok: mux — open→attach+attached, BE output framing, FIFO ordering, input/resize/close dispatch, attach-fail→relay-closed, binary/non-JSON ignored, depth-64 shed + shed-close')
