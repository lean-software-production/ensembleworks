// ConnectorSessionManager (port of session/session.go's Manager) over a fake
// TmuxSession: one pty for two attaches; attached carries the SESSION size not
// the newcomer's; scrollback replay on a late attach; output fan-out; resize
// authority + dedup + fan-out; input gated on attachment; the initial-grid
// clamp (10x3 → 20x5); exit broadcast + delete; detachAll drops viewers but
// leaves the pty. Mirrors gateway-go/session/session_test.go.
// Run with: bun src/connector/session.test.ts
import assert from 'node:assert/strict'
import type { TmuxSession } from '@ensembleworks/contracts/session-manager'
import { ConnectorSessionManager, type ChannelSink } from './session.ts'

// A fake TmuxSession mirroring openTmuxSession's clamp/dedup resize contract.
const COLS_MIN = 20, COLS_MAX = 500, ROWS_MIN = 5, ROWS_MAX = 200
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
interface Fake extends TmuxSession {
	writes: string[]
	emitData(s: string): void
	emitExit(): void
	killed: boolean
}
function makeFake(cols: number, rows: number): Fake {
	let dataCb: ((d: string) => void) | null = null
	let exitCb: (() => void) | null = null
	let curCols = cols
	let curRows = rows
	const f: Fake = {
		writes: [],
		killed: false,
		onData: (cb) => { dataCb = cb },
		onExit: (cb) => { exitCb = cb },
		write: (d) => { f.writes.push(d) },
		kill: () => { f.killed = true },
		resize(c, r) {
			if (!Number.isInteger(c) || !Number.isInteger(r)) return false
			const nc = clamp(c, COLS_MIN, COLS_MAX)
			const nr = clamp(r, ROWS_MIN, ROWS_MAX)
			if (nc === curCols && nr === curRows) return false
			curCols = nc; curRows = nr
			return true
		},
		get cols() { return curCols },
		get rows() { return curRows },
		emitData: (s) => dataCb?.(s),
		emitExit: () => exitCb?.(),
	}
	return f
}

// A recording ChannelSink.
function makeSink() {
	const msgs: unknown[] = []
	const out: Buffer[] = []
	let closed = false
	const sink: ChannelSink = {
		sendMsg: (m) => msgs.push(m),
		sendOutput: (p) => out.push(p),
		close: () => { closed = true },
	}
	return { sink, msgs, out, isClosed: () => closed }
}

// Spawn factory records (id, cols, rows) and hands back a fake.
function makeMgr() {
	const spawns: Array<{ id: string; cols: number; rows: number; fake: Fake }> = []
	const mgr = new ConnectorSessionManager((id, cols, rows) => {
		const fake = makeFake(cols, rows)
		spawns.push({ id, cols, rows, fake })
		return fake
	})
	return { mgr, spawns }
}

// 1. get-or-create spawns ONE pty for two attaches; attached carries session size.
{
	const { mgr, spawns } = makeMgr()
	const a = makeSink()
	const b = makeSink()
	assert.equal(mgr.attach('s', 1, 80, 24, a.sink), true)
	assert.equal(mgr.attach('s', 2, 100, 40, b.sink), true) // newcomer wants 100x40…
	assert.equal(spawns.length, 1, 'one pty for the session')
	assert.deepEqual(a.msgs[0], { type: 'attached', cols: 80, rows: 24 })
	assert.deepEqual(b.msgs[0], { type: 'attached', cols: 80, rows: 24 }, '…but attached carries the SESSION size')
}

// 2. scrollback replay on a late attach + live output fan-out.
{
	const { mgr, spawns } = makeMgr()
	const a = makeSink()
	mgr.attach('s', 1, 80, 24, a.sink)
	spawns[0]!.fake.emitData('early')        // before b attaches
	const b = makeSink()
	mgr.attach('s', 2, 80, 24, b.sink)
	assert.deepEqual(b.out.map((x) => x.toString()), ['early'], 'late attach replays scrollback')
	spawns[0]!.fake.emitData('live')         // fan-out to both
	assert.deepEqual(a.out.map((x) => x.toString()), ['early', 'live'])
	assert.deepEqual(b.out.map((x) => x.toString()), ['early', 'live'])
}

// 3. resize authority + dedup + fan-out.
{
	const { mgr } = makeMgr()
	const a = makeSink()
	const b = makeSink()
	mgr.attach('s', 1, 80, 24, a.sink)
	mgr.attach('s', 2, 80, 24, b.sink)
	a.msgs.length = 0; b.msgs.length = 0
	mgr.resize('s', 120, 50)
	assert.deepEqual(a.msgs, [{ type: 'resize', cols: 120, rows: 50 }])
	assert.deepEqual(b.msgs, [{ type: 'resize', cols: 120, rows: 50 }])
	a.msgs.length = 0; b.msgs.length = 0
	mgr.resize('s', 120, 50) // unchanged → dedup: no fan-out
	assert.deepEqual(a.msgs, [], 'no resize message when the grid is unchanged')
}

// 4. input gated on attachment.
{
	const { mgr, spawns } = makeMgr()
	const a = makeSink()
	mgr.attach('s', 1, 80, 24, a.sink)
	mgr.input('s', 1, 'ls\r')
	assert.deepEqual(spawns[0]!.fake.writes, ['ls\r'])
	mgr.input('s', 99, 'nope')            // channel 99 not attached
	assert.deepEqual(spawns[0]!.fake.writes, ['ls\r'], 'unattached channel cannot write')
	mgr.detach('s', 1)
	mgr.input('s', 1, 'after-detach')
	assert.deepEqual(spawns[0]!.fake.writes, ['ls\r'], 'detached channel cannot write')
}

// 5. THE INITIAL-GRID CLAMP: attach 10x3 → spawn factory receives 20x5 and
//    attached reports 20x5 (session.go's pre-spawn clamp; a raw pass-through
//    would spawn/report 10x3 and diverge from Go).
{
	const { mgr, spawns } = makeMgr()
	const a = makeSink()
	mgr.attach('s', 1, 10, 3, a.sink)
	assert.equal(spawns[0]!.cols, 20, 'cols clamped up to the minimum before spawn')
	assert.equal(spawns[0]!.rows, 5, 'rows clamped up to the minimum before spawn')
	assert.deepEqual(a.msgs[0], { type: 'attached', cols: 20, rows: 5 })
}

// 6. exit broadcasts {type:'exit'} + close + deletes the session (next attach
//    spawns a fresh pty).
{
	const { mgr, spawns } = makeMgr()
	const a = makeSink()
	mgr.attach('s', 1, 80, 24, a.sink)
	spawns[0]!.fake.emitExit()
	assert.deepEqual(a.msgs.at(-1), { type: 'exit' })
	assert.equal(a.isClosed(), true, 'exit closes the sink')
	const b = makeSink()
	mgr.attach('s', 2, 80, 24, b.sink)
	assert.equal(spawns.length, 2, 'a post-exit attach spawns a new pty')
}

// 7. detachAll drops viewers but leaves the pty running (tmux survives).
{
	const { mgr, spawns } = makeMgr()
	const a = makeSink()
	mgr.attach('s', 1, 80, 24, a.sink)
	mgr.detachAll()
	assert.equal(a.isClosed(), true, 'detachAll closes viewers')
	assert.equal(spawns[0]!.fake.killed, false, 'detachAll must NOT kill the pty')
	mgr.input('s', 1, 'x')
	assert.deepEqual(spawns[0]!.fake.writes, [], 'the viewer is gone, but the session/pty remains')
}

console.log('ok: session — one pty/two attaches, session-size attached, scrollback replay, fan-out, resize dedup, input gating, 10x3→20x5 clamp, exit broadcast+delete, detachAll keeps the pty')
