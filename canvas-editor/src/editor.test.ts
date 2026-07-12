// Run: bun src/editor.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc, dumpModel, type CanvasDoc } from '@ensembleworks/canvas-doc'
import type { CanvasDocument, Shape } from '@ensembleworks/canvas-model'
import { Editor } from './editor.js'

// Injected clock/PRNG — fixed, non-advancing: proves the editor never
// reaches for a real one (the boundary test proves it structurally; this
// proves it behaviorally — every test below gets IDENTICAL now()/random()
// no matter how many intents run).
const FIXED_NOW = () => 1_700_000_000_000
const FIXED_RANDOM = () => 0.5

function makeEditor(peerId: bigint): { doc: LoroCanvasDoc; editor: Editor } {
  const doc = LoroCanvasDoc.create({ peerId })
  doc.putPage({ id: 'page:p', name: 'P' })
  doc.commit()
  const editor = new Editor({ doc, now: FIXED_NOW, random: FIXED_RANDOM, pageId: 'page:p' })
  return { doc, editor }
}

const shape = (id: string, over: Partial<Shape> = {}): Shape => ({
  id, kind: 'note', parentId: 'page:p', index: 'a1',
  x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: {}, ...over,
} as Shape)

// Cross-engine comparison, copied verbatim from canvas-doc/src/repair.test.ts's
// convention: Loro's own traversal/map-key order need not match another
// peer's, so sort by id before comparing (byId is a derived Map — dropped
// here rather than deep-compared, same reasoning as that file's `normalize`).
const byIdAsc = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id)
const normalize = (m: CanvasDocument) => ({
  pages: [...m.pages].sort(byIdAsc),
  shapes: [...m.shapes].sort(byIdAsc),
  bindings: [...m.bindings].sort(byIdAsc),
})

// ============================================================================
// 1. Round-trip: CreateShape then TranslateShapes, applied through the
//    editor as two separate apply() calls (two commits — see the
//    commit-granularity test below for why that's the documented default).
//    Covers the Phase-2 stableStringify cross-representation risk: the
//    editor's Intent-derived state must survive BOTH a dumpModel() read of
//    the SAME doc and a full Loro export/import into a SECOND doc.
// ============================================================================
{
  const { doc, editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:a', { x: 10, y: 20 }) })
  editor.apply({ type: 'TranslateShapes', ids: ['shape:a'], dx: 5, dy: -5 })

  const live = editor.doc.getShape('shape:a')!
  assert.equal(live.x, 15, 'TranslateShapes moved x by dx')
  assert.equal(live.y, 15, 'TranslateShapes moved y by dy')

  const model1 = dumpModel(doc)
  assert.equal(model1.byId.get('shape:a')!.x, 15, 'dumpModel agrees with the live doc read')
  assert.equal(model1.byId.get('shape:a')!.y, 15)

  // A second peer importing the first's exported update bytes converges to
  // the IDENTICAL model — the editor never wrote anything a fresh Loro doc
  // can't reconstruct from the wire bytes alone.
  const doc2 = LoroCanvasDoc.create({ peerId: 2n })
  doc2.import(doc.exportUpdate())
  doc2.commit()
  assert.deepEqual(normalize(dumpModel(doc2)), normalize(model1), 'editor-written state survives the Loro export/import round trip')

  console.log('ok: editor round-trip (CreateShape -> TranslateShapes survives Loro re-import)')
}

// ============================================================================
// 2. TranslateShapes dedupe: a selection containing BOTH a parent and its
//    child must move the child only ONCE (via the parent), not twice.
// ============================================================================
{
  const { editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:parent', { x: 0, y: 0 }) })
  editor.apply({ type: 'CreateShape', shape: shape('shape:child', { x: 5, y: 5, parentId: 'shape:parent' }) })

  // Selection includes BOTH parent and child. If the child were translated
  // independently as well as implicitly via its parent, its LOCAL x/y (which
  // is relative to the parent) would end up shifted by 2x the intended delta
  // relative to the parent — this assertion is exactly the guard against
  // that double-move.
  editor.apply({ type: 'TranslateShapes', ids: ['shape:parent', 'shape:child'], dx: 10, dy: 10 })

  const parent = editor.doc.getShape('shape:parent')!
  const child = editor.doc.getShape('shape:child')!
  assert.equal(parent.x, 10, 'parent moved by the full delta')
  assert.equal(parent.y, 10)
  assert.equal(child.x, 5, 'child LOCAL x/y is untouched — it moves with the parent implicitly, not via its own doc write')
  assert.equal(child.y, 5)

  // Symmetric check: selecting the CHILD alone still moves just the child.
  editor.apply({ type: 'TranslateShapes', ids: ['shape:child'], dx: 1, dy: 1 })
  assert.equal(editor.doc.getShape('shape:child')!.x, 6)
  assert.equal(editor.doc.getShape('shape:parent')!.x, 10, 'unrelated translate of the child alone leaves the parent alone')

  console.log('ok: TranslateShapes dedupes parent+child overlap (no double-move)')
}

// ============================================================================
// 3. Literal duplicate ids in one TranslateShapes call collapse too (a Set,
//    not just an ancestor filter) — the same shape must not move twice just
//    because its id was repeated in the intent's `ids` array.
// ============================================================================
{
  const { editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:a', { x: 0, y: 0 }) })
  editor.apply({ type: 'TranslateShapes', ids: ['shape:a', 'shape:a'], dx: 3, dy: 3 })
  const s = editor.doc.getShape('shape:a')!
  assert.equal(s.x, 3, 'a duplicated id in the same intent still moves the shape only once')
  assert.equal(s.y, 3)
  console.log('ok: TranslateShapes dedupes literal duplicate ids')
}

// ============================================================================
// 4. Commit granularity: apply() commits once per call; applyAll() commits
//    once for the WHOLE batch, not once per intent inside it. Proven by
//    counting doc.subscribeLocalUpdates() emissions — LoroCanvasDoc emits
//    exactly one such event per commit() that actually changed something.
// ============================================================================
{
  const { doc, editor } = makeEditor(1n)
  let commits = 0
  doc.subscribeLocalUpdates(() => { commits += 1 })

  editor.apply({ type: 'CreateShape', shape: shape('shape:a') })
  assert.equal(commits, 1, 'a single apply() is exactly one commit')

  editor.applyAll([
    { type: 'CreateShape', shape: shape('shape:b') },
    { type: 'CreateShape', shape: shape('shape:c') },
    { type: 'TranslateShapes', ids: ['shape:b', 'shape:c'], dx: 1, dy: 1 },
  ])
  assert.equal(commits, 2, 'a 3-intent applyAll() batch is still exactly ONE commit, not three')

  // A batch of ONLY view intents (no doc mutation) must not commit at all.
  editor.applyAll([{ type: 'SetHover', id: 'shape:a' }, { type: 'SetSelection', ids: ['shape:a'] }])
  assert.equal(commits, 2, 'a view-only batch never touches doc.commit()')

  console.log('ok: commit granularity — one commit per apply()/applyAll() call, never per intent')
}

// ============================================================================
// 5. View intents update EditorState and notify subscribers exactly ONCE per
//    batch (not once per intent), and never call doc.commit(). Notification
//    is synchronous: the listener observes the NEW state immediately.
// ============================================================================
{
  const { editor } = makeEditor(1n)
  let notifications = 0
  let seenDuringNotify: ReturnType<Editor['get']> | null = null
  editor.subscribe(() => { notifications += 1; seenDuringNotify = editor.get() })

  editor.applyAll([
    { type: 'SetCamera', x: 5, y: 6, z: 2 },
    { type: 'SetSelection', ids: ['shape:a'] },
    { type: 'SetHover', id: 'shape:a' },
  ])
  assert.equal(notifications, 1, 'a 3-intent view-only batch notifies subscribers exactly once')
  assert.deepEqual(editor.get().camera, { x: 5, y: 6, z: 2 })
  assert.deepEqual([...editor.get().selection], ['shape:a'])
  assert.equal(editor.get().hover, 'shape:a')
  // The subscriber observed the fully-applied state (all 3 intents' effects),
  // not an intermediate one — proves notification fires once, after the
  // whole batch, not mid-batch.
  assert.deepEqual(seenDuringNotify, editor.get())

  const before = notifications
  editor.apply({ type: 'CreateShape', shape: shape('shape:z') }) // doc-only, no view change
  assert.equal(notifications, before, 'a pure doc mutation does not notify EditorState subscribers')

  editor.apply({ type: 'BeginEdit', id: 'shape:z' })
  assert.equal(editor.get().editingId, 'shape:z')
  editor.apply({ type: 'EndEdit' })
  assert.equal(editor.get().editingId, null)

  console.log('ok: view intents batch into one notification; doc-only intents notify zero times')
}

// ============================================================================
// 6. ResizeSelection: scales x/y about a fixed anchor and props.w/h by the
//    same per-axis factor.
// ============================================================================
{
  const { editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:box', { x: 20, y: 20, kind: 'geo', props: { w: 100, h: 50 } }) })
  // Anchor at the box's own origin (20,20): scaling by (2, 3) should leave
  // the anchor fixed and double/triple the box's size, x/y unchanged (the
  // anchor coincides with x/y here, so (x - anchor) is 0 on both axes).
  editor.apply({ type: 'ResizeSelection', ids: ['shape:box'], anchor: { x: 20, y: 20 }, scaleX: 2, scaleY: 3 })
  const s = editor.doc.getShape('shape:box')!
  assert.equal(s.x, 20)
  assert.equal(s.y, 20)
  assert.equal((s.props as any).w, 200)
  assert.equal((s.props as any).h, 150)

  // Anchor away from x/y: the origin itself must move too (scale about a
  // fixed point, not the shape's own corner).
  editor.apply({ type: 'ResizeSelection', ids: ['shape:box'], anchor: { x: 0, y: 0 }, scaleX: 2, scaleY: 2 })
  const s2 = editor.doc.getShape('shape:box')!
  assert.equal(s2.x, 40, 'x scaled about the anchor: 0 + (20-0)*2')
  assert.equal(s2.y, 40)

  console.log('ok: ResizeSelection scales x/y about the anchor and props.w/h per axis')
}

// ============================================================================
// 7. RotateSelection: orbits the shape's origin around `center` and spins
//    its own rotation field by the same delta.
// ============================================================================
{
  const { editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:r', { x: 10, y: 0 }) })
  // Rotate 90 degrees (pi/2) about the origin (0,0): (10,0) -> (0,10) under
  // the package's rotation convention (x' = x cosθ - y sinθ, y' = x sinθ + y cosθ).
  editor.apply({ type: 'RotateSelection', ids: ['shape:r'], center: { x: 0, y: 0 }, dRadians: Math.PI / 2 })
  const s = editor.doc.getShape('shape:r')!
  const EPS = 1e-9
  assert.ok(Math.abs(s.x - 0) < EPS, `x ~= 0, got ${s.x}`)
  assert.ok(Math.abs(s.y - 10) < EPS, `y ~= 10, got ${s.y}`)
  assert.ok(Math.abs(s.rotation - Math.PI / 2) < EPS, 'rotation field accumulates the delta')

  console.log('ok: RotateSelection orbits the origin about center and spins rotation')
}

// ============================================================================
// 8. StartArrow / CompleteArrow: creates the arrow shape, sets a local `end`
//    offset relative to the arrow's own x/y, and puts bindings for BOTH
//    endpoints when supplied, using the binding:<id>-start/-end convention.
// ============================================================================
{
  const { editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:target', { x: 100, y: 100, kind: 'geo', props: { w: 50, h: 50 } }) })

  editor.apply({
    type: 'StartArrow',
    shape: shape('shape:arrow', { kind: 'arrow', x: 0, y: 0 }),
    fromBinding: { targetId: 'shape:target', anchor: { nx: 0, ny: 0 } },
  })
  editor.apply({
    type: 'CompleteArrow',
    id: 'shape:arrow',
    end: { x: 10, y: 20 }, // world point; arrow's x/y is (0,0), so local end offset is (10,20)
    toBinding: { targetId: 'shape:target', anchor: { nx: 1, ny: 1 } },
  })

  const arrow = editor.doc.getShape('shape:arrow')!
  assert.equal(arrow.kind, 'arrow')
  assert.deepEqual((arrow.props as any).end, { x: 10, y: 20 })

  const bindings = editor.doc.listBindings()
  const startBinding = bindings.find((b) => b.id === 'binding:shape:arrow-start')
  const endBinding = bindings.find((b) => b.id === 'binding:shape:arrow-end')
  assert.ok(startBinding, 'StartArrow puts the start-endpoint binding')
  assert.equal(startBinding!.toId, 'shape:target')
  assert.deepEqual((startBinding!.props as any).anchor, { nx: 0, ny: 0 })
  assert.ok(endBinding, 'CompleteArrow puts the end-endpoint binding')
  assert.equal(endBinding!.toId, 'shape:target')
  assert.deepEqual((endBinding!.props as any).anchor, { nx: 1, ny: 1 })

  console.log('ok: StartArrow/CompleteArrow create the arrow shape + both endpoint bindings')
}

// ============================================================================
// 9. Injected clock/PRNG are stored and reachable verbatim — proves the
//    Editor never substitutes a default that reaches for a real one.
// ============================================================================
{
  const { editor } = makeEditor(1n)
  assert.equal(editor.now, FIXED_NOW, 'editor.now is the exact injected function, not a wrapper/default')
  assert.equal(editor.random, FIXED_RANDOM)
  assert.equal(editor.now(), 1_700_000_000_000)
  assert.equal(editor.random(), 0.5)
  assert.equal(editor.pageId, 'page:p')
  console.log('ok: now/random/pageId are stored verbatim from the constructor')
}

// ============================================================================
// 10. Snapshot immutability is RUNTIME, not TypeScript-only: mutating every
//     part of a returned snapshot (camera fields, hover/editingId
//     reassignment, selection Set.add) must never corrupt internal editor
//     state — verified both via a fresh get() after a subsequent state
//     change AND via behavior (a translate driven by a fresh snapshot's
//     selection). Frozen objects THROW on write in strict mode (all ES
//     modules are strict), so each write attempt is wrapped: throwing is a
//     legitimate way to "not corrupt", silent-ignore is too — what's
//     asserted is only that the canonical state never moves.
// ============================================================================
{
  const { editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:a', { x: 0, y: 0 }) })
  editor.apply({ type: 'CreateShape', shape: shape('shape:evil', { x: 100, y: 100 }) })
  editor.applyAll([
    { type: 'SetCamera', x: 1, y: 2, z: 3 },
    { type: 'SetSelection', ids: ['shape:a'] },
    { type: 'SetHover', id: 'shape:a' },
    { type: 'BeginEdit', id: 'shape:a' },
  ])

  const snap = editor.get()
  const attempt = (fn: () => void) => { try { fn() } catch { /* frozen-object throw is fine */ } }
  attempt(() => { (snap.camera as { x: number }).x = 999 })
  attempt(() => { (snap as { hover: string | null }).hover = 'shape:evil' })
  attempt(() => { (snap as { editingId: string | null }).editingId = 'shape:evil' })
  attempt(() => { (snap.selection as Set<string>).add('shape:evil') })
  attempt(() => { (snap.selection as Set<string>).delete('shape:a') })
  attempt(() => { (snap as { camera: unknown }).camera = { x: 0, y: 0, z: 0 } })

  // A subsequent UNRELATED state change, then a fresh get(): every field the
  // probes attacked must still hold its canonical value.
  editor.apply({ type: 'SetHover', id: null })
  const fresh = editor.get()
  assert.deepEqual(fresh.camera, { x: 1, y: 2, z: 3 }, 'camera survived snapshot mutation attempts')
  assert.deepEqual([...fresh.selection], ['shape:a'], 'selection survived Set.add/.delete on a returned snapshot')
  assert.equal(fresh.editingId, 'shape:a', 'editingId survived reassignment attempts')
  assert.equal(fresh.hover, null, 'the legitimate SetHover still went through')

  // Behavior check: drive a translate off a FRESH snapshot's selection — if
  // Set.add('shape:evil') had leaked into canonical state, shape:evil would
  // move here too.
  editor.apply({ type: 'TranslateShapes', ids: [...editor.get().selection], dx: 7, dy: 7 })
  assert.equal(editor.doc.getShape('shape:a')!.x, 7, 'selected shape moved')
  assert.equal(editor.doc.getShape('shape:evil')!.x, 100, 'shape:evil did NOT move — the poisoned Set never reached canonical state')

  console.log('ok: snapshot mutation (camera/hover/editingId/selection Set) can never corrupt internal state')
}

// A minimal typed-doc sanity check: an Editor constructed against the
// abstract CanvasDoc interface (not the concrete LoroCanvasDoc class)
// typechecks and runs identically — the engine-swappability rule holds at
// this layer too, not just canvas-doc's own.
{
  const { doc } = makeEditor(1n)
  const asInterface: CanvasDoc = doc
  const editor = new Editor({ doc: asInterface, now: FIXED_NOW, random: FIXED_RANDOM, pageId: 'page:p' })
  editor.apply({ type: 'CreateShape', shape: shape('shape:iface') })
  assert.ok(editor.doc.getShape('shape:iface'))
  console.log('ok: Editor works against the CanvasDoc interface, not just LoroCanvasDoc')
}

console.log('ok: canvas-editor editor + intents')
