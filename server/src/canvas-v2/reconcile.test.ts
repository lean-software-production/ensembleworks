// Run: bun src/canvas-v2/reconcile.test.ts
// Locks reconcile()'s diff-apply contract: bring a LoroCanvasDoc into line
// with a freshly-converted CanvasDocument, touching only what changed.
//
// The load-bearing case here is the CASCADE-DELETE SURVIVOR scenario: the
// plan's original sketch diffed the put loop against `current` captured
// BEFORE the delete loop ran. If a parent is deleted (cascading away its
// real-tree descendants in Loro) while a child of that parent survives in
// `target` with an UNCHANGED envelope relative to its pre-delete self (only
// its ancestor moved), the stale `current` snapshot says "no change" and the
// put loop would skip it — even though the child's Loro node was just
// tombstoned by the cascade. That is silent data loss. This suite proves the
// fix: the put loop's baseline must be recomputed from the doc AFTER deletes.
import assert from 'node:assert/strict'
import { LoroCanvasDoc, dumpModel } from '@ensembleworks/canvas-doc'
import { makeDocument, plainText } from '@ensembleworks/canvas-model'
import { reconcile } from './reconcile.ts'

const base = () => ({ index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {} })
const byId = (d: ReturnType<typeof makeDocument>, id: string) => d.byId.get(id)!
const sortedIds = (arr: readonly { id: string }[]) => [...arr].map((s) => s.id).sort()

// --- 1) empty doc + 3-shape/1-page model → matches, {puts:3, deletes:0} ---
const model1 = makeDocument({
	pages: [{ id: 'page:p', name: 'Page' }],
	shapes: [
		{ id: 'shape:a', kind: 'frame', parentId: 'page:p', props: { name: 'F' }, ...base() } as any,
		{ id: 'shape:b', kind: 'note', parentId: 'shape:a', props: { color: 'yellow' }, ...base() } as any,
		{ id: 'shape:c', kind: 'arrow', parentId: 'page:p', props: {}, ...base() } as any,
	],
	bindings: [{ id: 'binding:1', fromId: 'shape:c', toId: 'shape:a', props: {}, meta: {} }],
})

const doc = LoroCanvasDoc.create({ peerId: 1n })
const r1 = reconcile(doc, model1)
assert.deepEqual(r1, { puts: 3, deletes: 0, refused: 0 })
{
	const out = dumpModel(doc)
	assert.deepEqual(sortedIds(out.shapes), sortedIds(model1.shapes))
	assert.deepEqual(sortedIds(out.pages), ['page:p'])
	assert.deepEqual(sortedIds(out.bindings), ['binding:1'])
	assert.equal(byId(out, 'shape:b').parentId, 'shape:a')
}

// --- 2) reconcile the same model again → idempotent {0,0} ---
const r2 = reconcile(doc, model1)
assert.deepEqual(r2, { puts: 0, deletes: 0, refused: 0 }, 'steady state: nothing to do')

// --- 3) move one shape + add one new shape → {puts:2, deletes:0} ---
const model2 = makeDocument({
	pages: [{ id: 'page:p', name: 'Page' }],
	shapes: [
		{ id: 'shape:a', kind: 'frame', parentId: 'page:p', props: { name: 'F' }, ...base(), x: 50 } as any, // moved
		{ id: 'shape:b', kind: 'note', parentId: 'shape:a', props: { color: 'yellow' }, ...base() } as any, // unchanged
		{ id: 'shape:c', kind: 'arrow', parentId: 'page:p', props: {}, ...base() } as any, // unchanged
		{ id: 'shape:d', kind: 'note', parentId: 'page:p', props: {}, ...base() } as any, // new
	],
	bindings: [{ id: 'binding:1', fromId: 'shape:c', toId: 'shape:a', props: {}, meta: {} }],
})
const r3 = reconcile(doc, model2)
assert.deepEqual(r3, { puts: 2, deletes: 0, refused: 0 })
assert.deepEqual(sortedIds(dumpModel(doc).shapes), sortedIds(model2.shapes))

// --- 4) THE SUSPECTED-BUG SCENARIO: delete a parent while keeping a
// reparented (grand)child whose own envelope is otherwise unchanged. ---
const doc2 = LoroCanvasDoc.create({ peerId: 2n })
const before = makeDocument({
	pages: [{ id: 'page:p', name: 'Page' }],
	shapes: [
		{ id: 'shape:parent', kind: 'frame', parentId: 'page:p', props: {}, ...base() } as any,
		{ id: 'shape:mid', kind: 'group', parentId: 'shape:parent', props: {}, ...base() } as any,
		{ id: 'shape:child', kind: 'note', parentId: 'shape:mid', props: { color: 'blue' }, ...base() } as any,
	],
	bindings: [],
})
reconcile(doc2, before)

// shape:parent is gone in `after`; shape:mid is reparented straight to
// page:p; shape:child's envelope (incl. its parentId string 'shape:mid') is
// BYTE-IDENTICAL to its pre-delete self — only its ancestor moved. Cascading
// deleteShape('shape:parent') tombstones shape:mid AND shape:child's real
// Loro nodes. A put loop that diffs against the pre-delete snapshot would see
// shape:child as "unchanged" and skip it — losing it for real.
const after = makeDocument({
	pages: [{ id: 'page:p', name: 'Page' }],
	shapes: [
		{ id: 'shape:mid', kind: 'group', parentId: 'page:p', props: {}, ...base() } as any,
		{ id: 'shape:child', kind: 'note', parentId: 'shape:mid', props: { color: 'blue' }, ...base() } as any,
	],
	bindings: [],
})
const r4 = reconcile(doc2, after)
assert.equal(r4.deletes, 1, 'exactly one explicit delete (shape:parent); cascade is not separately counted')
assert.equal(r4.puts, 2, 'both shape:mid (parent changed) AND shape:child (cascade-orphaned survivor) must be re-put')
{
	const out = dumpModel(doc2)
	assert.deepEqual(sortedIds(out.shapes), ['shape:child', 'shape:mid'], 'shape:parent gone, shape:mid + shape:child SURVIVE')
	assert.equal(byId(out, 'shape:mid').parentId, 'page:p')
	assert.equal(byId(out, 'shape:child').parentId, 'shape:mid', 'child kept its correct (reparented-via-ancestor) parent')
	assert.equal((byId(out, 'shape:child').props as any).color, 'blue', 'child envelope intact after resurrection')
}
// Idempotent on the very next tick.
assert.deepEqual(reconcile(doc2, after), { puts: 0, deletes: 0, refused: 0 }, 'converged state needs no further touch')

// --- 5) text: richText lives in props, not a separate LoroText channel —
// reconcile's props JSON-diff (shallowEqualShape) is what carries it. ---
const doc3 = LoroCanvasDoc.create({ peerId: 3n })
const withText = makeDocument({
	pages: [{ id: 'page:p', name: 'Page' }],
	shapes: [
		{
			id: 'shape:note',
			kind: 'note',
			parentId: 'page:p',
			props: { color: 'yellow', richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }] } },
			...base(),
		} as any,
	],
	bindings: [],
})
reconcile(doc3, withText)
{
	const out = dumpModel(doc3)
	assert.equal(plainText(byId(out, 'shape:note')), 'hello')
	assert.deepEqual((byId(out, 'shape:note').props as any).richText, (byId(withText, 'shape:note').props as any).richText)
	// getText()/setText() (the per-shape LoroText container) is a separate,
	// dormant Phase-3 rich-text-editing channel: dumpModel/reconcile never
	// touch it, so it stays empty even though props.richText round-trips.
	assert.equal(doc3.getText('shape:note'), '')
}

const withTextEdited = makeDocument({
	pages: [{ id: 'page:p', name: 'Page' }],
	shapes: [
		{
			id: 'shape:note',
			kind: 'note',
			parentId: 'page:p',
			props: { color: 'yellow', richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'updated' }] }] } },
			...base(),
		} as any,
	],
	bindings: [],
})
const r5 = reconcile(doc3, withTextEdited)
assert.deepEqual(r5, { puts: 1, deletes: 0, refused: 0 })
assert.equal(plainText(byId(dumpModel(doc3), 'shape:note')), 'updated')

// --- 6) ORDER-INDEPENDENT COMPARISON: Loro's tree-node data map does NOT
// round-trip JS object key insertion order (probe: set {n,color,z,b} → get
// {n,z,b,color}). A key-order-sensitive comparison (JSON.stringify) against
// the dumped mirror therefore reports "changed" forever for any shape with
// 2+ prop keys — permanent {puts:1} churn on an unchanged target, the exact
// failure reconcile exists to prevent. Every earlier case in this file used
// single-key (or intentionally-changed) props, which MASKED this. ---
const doc4 = LoroCanvasDoc.create({ peerId: 4n })
const multiKey = makeDocument({
	pages: [{ id: 'page:p', name: 'Page' }],
	shapes: [
		{
			id: 'shape:m',
			kind: 'geo',
			parentId: 'page:p',
			props: { n: 1, color: 'red', z: true, b: 'x' },
			...base(),
			meta: { alpha: 1, beta: 2 },
		} as any,
	],
	bindings: [],
})
const r6a = reconcile(doc4, multiKey)
assert.deepEqual(r6a, { puts: 1, deletes: 0, refused: 0 })
const r6b = reconcile(doc4, multiKey)
assert.deepEqual(r6b, { puts: 0, deletes: 0, refused: 0 }, 'multi-key props: steady state must be {0,0}, not key-order churn')

// --- 7) kind joins the comparator (ratified ruling: reconcile's contract is
// bring-in-line, no principled carve-out for kind): a kind-only change on an
// otherwise identical shape must be re-put. ---
const kindChanged = makeDocument({
	pages: [{ id: 'page:p', name: 'Page' }],
	shapes: [
		{
			id: 'shape:m',
			kind: 'note', // was 'geo'
			parentId: 'page:p',
			props: { n: 1, color: 'red', z: true, b: 'x' },
			...base(),
			meta: { alpha: 1, beta: 2 },
		} as any,
	],
	bindings: [],
})
const r7 = reconcile(doc4, kindChanged)
assert.deepEqual(r7, { puts: 1, deletes: 0, refused: 0 }, 'kind-only change is a real change')
assert.equal(byId(dumpModel(doc4), 'shape:m').kind, 'note')

// --- 8) A target carrying a shape the write boundary REFUSES. convert.ts
// passes tldraw props through verbatim, so a legacy room can hand reconcile a
// shape validateShape rejects. The put is a NO-OP, so the shape stays absent
// and the next tick tries again — forever. reconcile must therefore report
// the refusal separately: folded into `puts` it is indistinguishable from a
// genuine pending write, and the shadow divergence signal reads as permanent
// unexplained churn. ---
const doc5 = LoroCanvasDoc.create({ peerId: 5n })
const withInvalid = makeDocument({
	pages: [{ id: 'page:p', name: 'Page' }],
	shapes: [
		{ id: 'shape:ok', kind: 'note', parentId: 'page:p', props: { color: 'yellow' }, ...base() } as any,
		{ id: 'shape:bad', kind: 'frame', parentId: 'page:p', props: { w: '100' }, ...base() } as any,
	],
	bindings: [],
})
// A: one valid shape ALONGSIDE the invalid one, so `puts` is a discriminating
// nonzero — an implementation that reports `refused` but forgets to subtract
// it from `puts` returns {puts:2} here.
const r8a = reconcile(doc5, withInvalid)
assert.deepEqual(r8a, { puts: 1, deletes: 0, refused: 1 }, 'the refused write is reported as refused, NOT counted as a put')
// The counts are not accounting fiction: the valid shape really landed and the
// refused one really did not. This is also what kills a "make it converge" fix
// that swaps in putShapeUnchecked — that writes both ids and refuses nothing.
assert.deepEqual(sortedIds(dumpModel(doc5).shapes), ['shape:ok'], 'the valid shape landed; the refused one did not')
// B: `refused` must be a PER-TICK delta, not doc.invalidWriteCount itself.
// That counter is a monotonic lifetime total (loro-canvas-doc.ts:141-144,
// "Never reset") and grows by one on every tick this target is reconciled —
// measured 1, 2, 3 over three ticks. An implementation that returns it raw
// passes A and then reports refused:2 here.
const r8b = reconcile(doc5, withInvalid)
assert.deepEqual(r8b, { puts: 0, deletes: 0, refused: 1 }, 'stable across ticks: refused is a per-tick delta, not the doc lifetime total')

console.log('ok: reconcile')
