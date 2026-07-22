// Run: bun src/canvas-v2/shadow.test.ts
// Locks ShadowMirror's tick contract: continuous fromTldraw→reconcile mirroring
// of a fake live room, periodic divergence detection, and fail-loud-but-counted
// error handling (one bad room's tick must never kill the D3 driver's loop).
import assert from 'node:assert/strict'
import { dumpModel } from '@ensembleworks/canvas-doc'
import { fromTldraw } from './convert.ts'
import { ShadowMirror } from './shadow.ts'

const page = { typeName: 'page', id: 'page:p', name: 'Page 1', index: 'a1', meta: {} }
const frame = () => ({
	typeName: 'shape',
	id: 'shape:f',
	type: 'frame',
	parentId: 'page:p',
	index: 'a1',
	x: 0,
	y: 0,
	rotation: 0,
	isLocked: false,
	opacity: 1,
	meta: {},
	props: { name: 'Planning', w: 400, h: 300, color: 'black' },
})
const note = (over: any = {}) => ({
	typeName: 'shape',
	id: 'shape:n',
	type: 'note',
	parentId: 'shape:f',
	index: 'a1',
	x: 10,
	y: 10,
	rotation: 0,
	isLocked: false,
	opacity: 1,
	meta: {},
	props: { color: 'yellow', richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] } },
	...over,
})
const sortedIds = (arr: readonly { id: string }[]) => [...arr].map((s) => s.id).sort()

// --- getRecords over a MUTABLE array (the fixture reused from
// convert-from-tldraw.test.ts's realistic-record style). ---
let records: any[] = [page, frame(), note()]
const getRecords = () => records

// checkEvery=5 so the test can land exactly on the check boundary.
const mirror = new ShadowMirror('room1', 1n, getRecords, 5)

// --- 1) tick → mirror matches, no divergence ---
mirror.tick() // ticks=1
{
	const m = mirror.metrics()
	assert.equal(m.ticks, 1)
	assert.equal(m.divergences, 0)
	assert.equal(m.lastDivergence, null)
	assert.equal(m.tickErrors, 0)
	assert.deepEqual(sortedIds(dumpModel(mirror.doc).shapes), sortedIds(fromTldraw(records).shapes))
}

// --- 2) mutate the records (move a shape) and tick → still no divergence ---
records = records.map((r) => (r.id === 'shape:n' ? { ...r, x: 99 } : r))
mirror.tick() // ticks=2
{
	const m = mirror.metrics()
	assert.equal(m.divergences, 0)
	assert.equal(dumpModel(mirror.doc).byId.get('shape:n')?.x, 99, 'mirror caught up with the moved shape')
}

// Advance to ticks=4 (one short of the checkEvery=5 boundary) with no further
// content changes.
mirror.tick() // ticks=3
mirror.tick() // ticks=4

// --- 3) divergence tripwire, via FAULT INJECTION: simulate an upstream
// reconcile/converter bug. In a correct pipeline reconcile heals any mirror
// corruption before checkDivergence ever sees it (that is its entire job),
// so a REAL lasting divergence can only come from a bug in that pipeline.
// We inject exactly that: (a) corrupt the mirror out-of-band (shape:n's x
// pushed to 12345), then (b) stub the mirror doc's putShape to a no-op for
// one tick — standing in for a reconcile/apply bug that fails to bring the
// doc in line. The check tick then fires on genuinely-unhealed state.
// Afterwards the stub is removed and a later healthy cycle must heal the
// corruption with NO further divergences. ---
const targetNote = fromTldraw(records).byId.get('shape:n')!
mirror.doc.putShape({ ...targetNote, x: 12345 } as any) // out-of-band corruption
mirror.doc.commit()
// Inject the fault: an instance own-property shadows the prototype method,
// so reconcile's doc.putShape(s) calls hit the no-op.
;(mirror.doc as any).putShape = () => {}

mirror.tick() // ticks=5 — the checkEvery boundary; reconcile tried and "failed" to heal
{
	const m = mirror.metrics()
	assert.equal(m.ticks, 5)
	assert.equal(m.divergences, 1, 'check tick fired on genuinely-unhealed state')
	// Fix-3 pin: the divergence string names the differing element and field,
	// not just a shape-count summary line.
	assert.ok(
		m.lastDivergence?.includes('shape shape:n differs') && m.lastDivergence.includes('(x:'),
		`lastDivergence names the element + field, got: ${m.lastDivergence}`
	)
	assert.equal(m.shapeCount, fromTldraw(records).shapes.length)
	assert.ok(m.snapshotBytes > 0, 'snapshotBytes sampled on the check-tick')
}

// Remove the fault: the next healthy cycle heals, and the next check tick
// (ticks=10) reports NO new divergence.
delete (mirror.doc as any).putShape
for (let i = 0; i < 5; i++) mirror.tick() // ticks 6..10
{
	const m = mirror.metrics()
	assert.equal(m.ticks, 10)
	assert.equal(m.divergences, 1, 'no further divergences once the injected fault is removed')
	assert.equal(dumpModel(mirror.doc).byId.get('shape:n')?.x, 99, 'healthy reconcile healed the corruption')
}

// --- 4) a getRecords that throws → tickErrors 1; a subsequent healthy tick recovers ---
let throwing = true
const goodRecords: any[] = [page, frame(), note()]
const flaky = () => {
	if (throwing) throw new Error('boom: simulated getCurrentSnapshot failure')
	return goodRecords
}
const mirror2 = new ShadowMirror('room2', 2n, flaky, 5)

mirror2.tick() // ticks=1, throws internally
{
	const m = mirror2.metrics()
	assert.equal(m.ticks, 1, 'ticks still increments even on a failed tick')
	assert.equal(m.tickErrors, 1)
	assert.ok(m.lastError?.includes('boom'))
	assert.equal(m.puts, 0, 'no partial reconcile work counted from a failed tick')
}

throwing = false
mirror2.tick() // ticks=2, recovers
{
	const m = mirror2.metrics()
	assert.equal(m.ticks, 2)
	assert.equal(m.tickErrors, 1, 'no new error on the healthy tick')
	assert.ok(m.lastError?.includes('boom'), 'lastError is sticky — forensics survive recovery')
	assert.ok(m.puts >= 1, 'the healthy tick actually reconciled')
	assert.deepEqual(sortedIds(dumpModel(mirror2.doc).shapes), sortedIds(fromTldraw(goodRecords).shapes))
}

// --- 5) ORDER-INDEPENDENT DIVERGENCE CHECK: a completely CLEAN mirror over
// records with multi-key props must report divergences:0 through a full
// checkEvery cycle. Loro does not preserve JS key insertion order in
// tree-node data, so a key-order-sensitive comparator (JSON.stringify)
// false-positives here — the mirror is semantically identical to the source,
// only key order differs. The frame()'s 4-key and note()'s 2-key props are
// enough to trip it. Also pins the reconcile side end-to-end: puts must stay
// at the initial load count (no per-tick key-order churn). ---
const cleanRecords: any[] = [page, frame(), note()]
const mirror3 = new ShadowMirror('room3', 3n, () => cleanRecords, 5)
for (let i = 0; i < 5; i++) mirror3.tick()
{
	const m = mirror3.metrics()
	assert.equal(m.ticks, 5)
	assert.equal(m.divergences, 0, 'clean mirror must NOT false-positive on Loro key reordering')
	assert.equal(m.lastDivergence, null)
	assert.equal(m.tickErrors, 0)
	assert.equal(m.puts, 2, 'initial load puts only (frame+note) — no steady-state churn from key reordering')
}

// --- 6) REFUSED WRITES ARE COUNTED AND EXPOSED. convert.ts passes tldraw
// props through verbatim, so a legacy room can hand the mirror a shape the
// write boundary refuses (here: a frame whose `w` is the string '400'). The
// put is a no-op, so the shape never lands and every later tick retries it —
// reconcile cannot converge. Before `refused` existed those retries were
// counted as `puts`, so /api/canvas/metrics showed a forever-climbing puts
// rate with no way to tell real churn from one known-bad shape. checkEvery is
// 100 so no divergence check fires inside this case — this fixture WOULD trip
// one, legitimately, and that is case 3's subject, not this one. ---
const badFrame = { ...frame(), id: 'shape:bad', props: { name: 'Legacy', w: '400', h: 300, color: 'black' } }
const legacyRecords: any[] = [page, frame(), note(), badFrame]
const mirror4 = new ShadowMirror('room4', 4n, () => legacyRecords, 100)

mirror4.tick()
{
	const m = mirror4.metrics()
	// puts and refused are DIFFERENT numbers here (2 vs 1) deliberately: an
	// implementation that accumulates reconcile's `refused` into `puts`, or
	// vice versa, survives any assertion where the two happen to be equal.
	assert.equal(m.refused, 1, 'the refused write is counted')
	assert.equal(m.puts, 2, 'the two valid shapes are puts; the refused one is not')
	assert.equal(m.shapeCount, 2, 'the refused shape never landed in the mirror')
}

mirror4.tick()
{
	const m = mirror4.metrics()
	// refused is CUMULATIVE, like puts and deletes: it climbs by one per tick
	// for as long as the room carries the bad shape. Two mutants die here that
	// the first tick cannot catch — assigning per-tick (`this.m.refused =
	// refused`) leaves it at 1, and accumulating doc.invalidWriteCount raw
	// rather than reconcile's per-tick delta reaches 3.
	assert.equal(m.refused, 2, 'refused accumulates across ticks, like puts/deletes')
	// The point of the whole task: the retry is no longer disguised as a put,
	// so a steady-state puts rate of ~0 is a readable signal again.
	assert.equal(m.puts, 2, 'the retried refusal did NOT inflate puts')
}

console.log('ok: shadow')
