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

// --- 3) force a NON-HEALABLE divergence: putShape directly on the mirror,
// out-of-band, with every field identical to what reconcile computes EXCEPT
// `kind`. reconcile's shallowEqualShape (by design — a shape's kind is
// immutable per id in real tldraw; you cannot morph a note into a frame
// while keeping its id) does not compare `kind`, so this survives reconcile
// indefinitely — the exact kind of latent gap divergence-detection exists to
// catch. A corruption reconcile itself would silently repair (e.g. mutating
// x/y) would NOT prove this test, since reconcile heals it before the
// post-reconcile comparison in checkDivergence ever sees it. ---
const targetNote = fromTldraw(records).byId.get('shape:n')!
mirror.doc.putShape({ ...targetNote, kind: 'bogus-kind' } as any)
mirror.doc.commit()

mirror.tick() // ticks=5 — the checkEvery boundary
{
	const m = mirror.metrics()
	assert.equal(m.ticks, 5)
	assert.equal(m.divergences, 1)
	assert.ok(m.lastDivergence, 'lastDivergence is a non-null description')
	assert.equal(m.shapeCount, fromTldraw(records).shapes.length)
	assert.ok(m.snapshotBytes > 0, 'snapshotBytes sampled on the check-tick')
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
	assert.ok(m.puts >= 1, 'the healthy tick actually reconciled')
	assert.deepEqual(sortedIds(dumpModel(mirror2.doc).shapes), sortedIds(fromTldraw(goodRecords).shapes))
}

console.log('ok: shadow')
