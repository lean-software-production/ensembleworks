// Run: bun src/editor.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc, dumpModel, type CanvasDoc } from '@ensembleworks/canvas-doc'
import { worldTransform, type Binding, type CanvasDocument, type Shape } from '@ensembleworks/canvas-model'
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
// 6. ResizeShapes: scales x/y about a fixed anchor and props.w/h by the
//    same per-axis factor.
// ============================================================================
{
  const { editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:box', { x: 20, y: 20, kind: 'geo', props: { w: 100, h: 50 } }) })
  // Anchor at the box's own origin (20,20): scaling by (2, 3) should leave
  // the anchor fixed and double/triple the box's size, x/y unchanged (the
  // anchor coincides with x/y here, so (x - anchor) is 0 on both axes).
  editor.apply({ type: 'ResizeShapes', ids: ['shape:box'], anchor: { x: 20, y: 20 }, scaleX: 2, scaleY: 3 })
  const s = editor.doc.getShape('shape:box')!
  assert.equal(s.x, 20)
  assert.equal(s.y, 20)
  assert.equal((s.props as any).w, 200)
  assert.equal((s.props as any).h, 150)

  // Anchor away from x/y: the origin itself must move too (scale about a
  // fixed point, not the shape's own corner).
  editor.apply({ type: 'ResizeShapes', ids: ['shape:box'], anchor: { x: 0, y: 0 }, scaleX: 2, scaleY: 2 })
  const s2 = editor.doc.getShape('shape:box')!
  assert.equal(s2.x, 40, 'x scaled about the anchor: 0 + (20-0)*2')
  assert.equal(s2.y, 40)

  console.log('ok: ResizeShapes scales x/y about the anchor and props.w/h per axis')
}

// ============================================================================
// 7. RotateShapes: orbits the shape's origin around `center` and spins
//    its own rotation field by the same delta.
// ============================================================================
{
  const { editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:r', { x: 10, y: 0 }) })
  // Rotate 90 degrees (pi/2) about the origin (0,0): (10,0) -> (0,10) under
  // the package's rotation convention (x' = x cosθ - y sinθ, y' = x sinθ + y cosθ).
  editor.apply({ type: 'RotateShapes', ids: ['shape:r'], center: { x: 0, y: 0 }, dRadians: Math.PI / 2 })
  const s = editor.doc.getShape('shape:r')!
  const EPS = 1e-9
  assert.ok(Math.abs(s.x - 0) < EPS, `x ~= 0, got ${s.x}`)
  assert.ok(Math.abs(s.y - 10) < EPS, `y ~= 10, got ${s.y}`)
  assert.ok(Math.abs(s.rotation - Math.PI / 2) < EPS, 'rotation field accumulates the delta')

  console.log('ok: RotateShapes orbits the origin about center and spins rotation')
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
    { type: 'SetNextStyle', props: { color: 'blue' } },
  ])

  const snap = editor.get()
  const attempt = (fn: () => void) => { try { fn() } catch { /* frozen-object throw is fine */ } }
  attempt(() => { (snap.camera as { x: number }).x = 999 })
  attempt(() => { (snap as { hover: string | null }).hover = 'shape:evil' })
  attempt(() => { (snap as { editingId: string | null }).editingId = 'shape:evil' })
  attempt(() => { (snap.selection as Set<string>).add('shape:evil') })
  attempt(() => { (snap.selection as Set<string>).delete('shape:a') })
  attempt(() => { (snap as { camera: unknown }).camera = { x: 0, y: 0, z: 0 } })
  attempt(() => { (snap.nextShapeStyle as Record<string, unknown>).color = 'evil' })

  // A subsequent UNRELATED state change, then a fresh get(): every field the
  // probes attacked must still hold its canonical value.
  editor.apply({ type: 'SetHover', id: null })
  const fresh = editor.get()
  assert.deepEqual(fresh.camera, { x: 1, y: 2, z: 3 }, 'camera survived snapshot mutation attempts')
  assert.deepEqual([...fresh.selection], ['shape:a'], 'selection survived Set.add/.delete on a returned snapshot')
  assert.equal(fresh.editingId, 'shape:a', 'editingId survived reassignment attempts')
  assert.equal(fresh.hover, null, 'the legitimate SetHover still went through')
  assert.equal(fresh.nextShapeStyle.color, 'blue', 'nextShapeStyle survived a mutation attempt on a returned snapshot — kills the "return the live object, not a copy" mutant')

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

// ============================================================================
// 11. ReparentShapes tolerant-skip: a vanished parent target must NOT throw
//     mid-batch. The failure mode being pinned (reviewer-reproduced): Loro
//     mutations apply BEFORE commit(), so a throw between an earlier
//     intent's mutation and the batch's single commit() leaves that
//     mutation uncommitted — it then leaks into the NEXT unrelated commit
//     and ships to peers attributed to the wrong batch. So: no throw, the
//     translate commits EXACTLY once, the reparent is skipped, and a second
//     peer importing the update sees the translate only.
// ============================================================================
{
  const { doc, editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:a', { x: 0, y: 0 }) })
  let commits = 0
  doc.subscribeLocalUpdates(() => { commits += 1 })

  editor.applyAll([
    { type: 'TranslateShapes', ids: ['shape:a'], dx: 5, dy: 5 },
    { type: 'ReparentShapes', ids: ['shape:a'], parentId: 'shape:vanished' },
  ]) // must not throw

  assert.equal(commits, 1, 'the batch committed exactly once — the translate did not leak uncommitted')
  assert.equal(editor.doc.getShape('shape:a')!.x, 5, 'translate applied')
  assert.equal(editor.doc.getShape('shape:a')!.parentId, 'page:p', 'reparent to a vanished target skipped')

  const doc2 = LoroCanvasDoc.create({ peerId: 2n })
  doc2.import(doc.exportUpdate())
  doc2.commit()
  assert.equal(doc2.getShape('shape:a')!.x, 5, 'second peer sees the translate')
  assert.equal(doc2.getShape('shape:a')!.parentId, 'page:p', 'second peer sees no reparent')

  console.log('ok: ReparentShapes skips a vanished target — no throw, no uncommitted-mutation leak')
}

// ============================================================================
// 12. ReparentShapes per-id atomicity: in one intent, an id whose move would
//     CYCLE is skipped while the valid ids still apply — never "first id
//     applied, then throw" partial application.
// ============================================================================
{
  const { editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:parent') })
  editor.apply({ type: 'CreateShape', shape: shape('shape:child', { parentId: 'shape:parent' }) })
  editor.apply({ type: 'CreateShape', shape: shape('shape:free') })

  // Reparent both a free shape and shape:child's own ANCESTOR under
  // shape:child: the free shape must move; the ancestor move (a cycle) must
  // be skipped, not thrown.
  editor.apply({ type: 'ReparentShapes', ids: ['shape:free', 'shape:parent'], parentId: 'shape:child' })

  assert.equal(editor.doc.getShape('shape:free')!.parentId, 'shape:child', 'valid id applied')
  assert.equal(editor.doc.getShape('shape:parent')!.parentId, 'page:p', 'cycling id skipped, not thrown')
  // Self-parenting is the degenerate cycle — also skipped.
  editor.apply({ type: 'ReparentShapes', ids: ['shape:free'], parentId: 'shape:free' })
  assert.equal(editor.doc.getShape('shape:free')!.parentId, 'shape:child', 'self-parent skipped')

  console.log('ok: ReparentShapes skips per id — valid ids apply, cycling ids are dropped')
}

// ============================================================================
// 13. CompleteArrow on a vanished arrow must not write a DANGLING binding:
//     both the props update AND the putBinding are gated on the arrow shape
//     still resolving.
// ============================================================================
{
  const { editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:target', { kind: 'geo', props: { w: 50, h: 50 } }) })
  editor.apply({ type: 'StartArrow', shape: shape('shape:arrow', { kind: 'arrow' }) })
  editor.apply({ type: 'DeleteShapes', ids: ['shape:arrow'] }) // arrow vanishes (e.g. a remote delete)

  editor.apply({
    type: 'CompleteArrow',
    id: 'shape:arrow',
    end: { x: 10, y: 10 },
    toBinding: { targetId: 'shape:target', anchor: { nx: 0.5, ny: 0.5 } },
  }) // must not throw AND must not write the binding

  assert.equal(editor.doc.listBindings().length, 0, 'no dangling binding for a vanished arrow')
  console.log('ok: CompleteArrow on a vanished arrow writes neither props nor a dangling binding')
}

// ============================================================================
// 14. Housekeeping (Unit 5 review item): SetText's mutated flag must be
//     REAL — gated on the id resolving — like every other mutation intent's,
//     not unconditionally true. Proven via commit-counting (the same
//     technique test 4 uses): a SetText on a vanished id must commit ZERO
//     times, not one.
// ============================================================================
{
  const { doc, editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:a') })
  editor.apply({ type: 'DeleteShapes', ids: ['shape:a'] }) // shape:a vanishes

  let commits = 0
  doc.subscribeLocalUpdates(() => { commits += 1 })
  editor.apply({ type: 'SetText', id: 'shape:a', text: 'hello' })
  assert.equal(commits, 0, 'SetText on a vanished id must not commit — docMutated must be false, not unconditionally true')

  editor.apply({ type: 'CreateShape', shape: shape('shape:b') })
  editor.apply({ type: 'SetText', id: 'shape:b', text: 'hi' })
  assert.equal(editor.doc.getText('shape:b'), 'hi', 'SetText on a resolving id still writes the text and commits')

  console.log('ok: SetText reports a real mutated flag (skip on vanished id), consistent with its siblings')
}

// ============================================================================
// 15. C8 DEFERRAL CLOSURE — RotateShapes under a ROTATED PARENT: the exact
//     probe from Unit 4's review. Parent rotated 90° (pi/2) at world
//     (100,100); child at LOCAL (10,0), rotation 0. Rotating the child about
//     a WORLD center (100,100) — coinciding with the parent's own world
//     position, for simplicity — by another pi/2 must orbit/spin the CHILD's
//     WORLD position/rotation correctly, not just its raw x/y in whatever
//     frame the old SCOPE LIMIT silently assumed.
//
//     HAND-COMPUTED expected (independent of this file's implementation,
//     via canvas-model's own worldTransform/rotation convention — see
//     geometry.ts's ROTATION CONVENTION block): the child's world position
//     BEFORE this rotate is parent.xy + rotate(local, parent.rotation) =
//     (100,100) + rotate((10,0), pi/2) = (100,100) + (0,10) = (100,110).
//     Orbiting (100,110) around the world center (100,100) by pi/2:
//     relative = (0,10); rotate((0,10), pi/2) = (0*cos90-10*sin90,
//     0*sin90+10*cos90) = (-10, 0); new world = (100,100) + (-10,0) =
//     (90,100). World rotation: parent.rotation is UNCHANGED (rotating the
//     child does not touch the parent), so child.rotation must become
//     dRadians (0 + pi/2) for the child's WORLD rotation (parent.rotation +
//     child.rotation) to increase by exactly dRadians, per composeTransform.
// ============================================================================
{
  const { doc, editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:parent', { x: 100, y: 100, rotation: Math.PI / 2 }) })
  editor.apply({ type: 'CreateShape', shape: shape('shape:child', { x: 10, y: 0, parentId: 'shape:parent' }) })

  editor.apply({ type: 'RotateShapes', ids: ['shape:child'], center: { x: 100, y: 100 }, dRadians: Math.PI / 2 })

  const EPS = 1e-9
  const model = dumpModel(doc)
  const childWorld = worldTransform(model, model.byId.get('shape:child')!)
  assert.ok(Math.abs(childWorld.x - 90) < EPS, `child world x ~= 90 (hand-computed), got ${childWorld.x}`)
  assert.ok(Math.abs(childWorld.y - 100) < EPS, `child world y ~= 100 (hand-computed), got ${childWorld.y}`)
  assert.ok(Math.abs(childWorld.rotation - Math.PI) < EPS, `child world rotation ~= pi (parent pi/2 + child pi/2), got ${childWorld.rotation}`)

  // The parent itself must be untouched by rotating just the child.
  const parentAfter = editor.doc.getShape('shape:parent')!
  assert.equal(parentAfter.x, 100)
  assert.equal(parentAfter.y, 100)
  assert.equal(parentAfter.rotation, Math.PI / 2)

  console.log('ok: RotateShapes is world-correct under a ROTATED parent (deferral closure, hand-verified via worldTransform)')
}

// ============================================================================
// 16. C8 DEFERRAL CLOSURE — ResizeShapes under a ROTATED PARENT: same parent
//     setup as test 15. Scaling the child about a WORLD anchor coinciding
//     with the parent's own world position by (scaleX:2, scaleY:3).
//
//     HAND-COMPUTED expected: the world anchor (100,100) converts into the
//     parent's LOCAL frame as (0,0) — the parent's own world position IS
//     its local frame's origin, so a world point coinciding with it maps to
//     local (0,0) regardless of the parent's rotation. Scaling the child's
//     LOCAL x/y (10,0) about local anchor (0,0) by (2,3) gives local (20,0)
//     — scaling happens along the PARENT's local axes (rotated 90° from
//     world), which is why this does NOT equal naively scaling the world
//     offset by (2,3) (that would give local (10,0) unchanged on x, since
//     the world offset from anchor to the child was entirely on world y).
//     props.w/h scale independently of any frame: 20*2=40, 10*3=30.
// ============================================================================
{
  const { doc, editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:parent2', { x: 100, y: 100, rotation: Math.PI / 2 }) })
  editor.apply({ type: 'CreateShape', shape: shape('shape:child2', { x: 10, y: 0, parentId: 'shape:parent2', kind: 'geo', props: { w: 20, h: 10 } }) })

  editor.apply({ type: 'ResizeShapes', ids: ['shape:child2'], anchor: { x: 100, y: 100 }, scaleX: 2, scaleY: 3 })

  const child2 = editor.doc.getShape('shape:child2')!
  assert.equal(child2.x, 20, 'child LOCAL x scaled about the FRAME-CONVERTED anchor, not the raw world anchor')
  assert.equal(child2.y, 0)
  assert.equal((child2.props as any).w, 40)
  assert.equal((child2.props as any).h, 30)

  // World cross-check (independent of this file's own math): child world
  // position must equal parent.xy + rotate(childLocal, parent.rotation) =
  // (100,100) + rotate((20,0), pi/2) = (100,100) + (0,20) = (100,120).
  const EPS = 1e-9
  const model = dumpModel(doc)
  const childWorld = worldTransform(model, model.byId.get('shape:child2')!)
  assert.ok(Math.abs(childWorld.x - 100) < EPS, `child2 world x ~= 100, got ${childWorld.x}`)
  assert.ok(Math.abs(childWorld.y - 120) < EPS, `child2 world y ~= 120, got ${childWorld.y}`)

  console.log('ok: ResizeShapes is world-correct under a ROTATED parent (deferral closure, hand-verified via worldTransform)')
}

// ============================================================================
// 17. Mixed selection (parented under a rotated parent + root-parented) in
//     ONE RotateShapes intent: both must resolve correctly, proving the fix
//     applies PER-SHAPE (each against its own parent's frame), not globally.
// ============================================================================
{
  const { editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:parent3', { x: 50, y: 50, rotation: Math.PI / 2 }) })
  editor.apply({ type: 'CreateShape', shape: shape('shape:nested', { x: 10, y: 0, parentId: 'shape:parent3' }) })
  editor.apply({ type: 'CreateShape', shape: shape('shape:root', { x: 20, y: 0 }) }) // parentId: page:p (root)

  editor.apply({ type: 'RotateShapes', ids: ['shape:nested', 'shape:root'], center: { x: 0, y: 0 }, dRadians: Math.PI / 2 })

  const EPS = 1e-9
  // Root shape: its parent is the page (identity frame) -- the ORIGINAL
  // (pre-fix) math already handled this case, and must still: (20,0)
  // orbited pi/2 about (0,0) -> (0,20).
  const root = editor.doc.getShape('shape:root')!
  assert.ok(Math.abs(root.x - 0) < EPS, `root x ~= 0, got ${root.x}`)
  assert.ok(Math.abs(root.y - 20) < EPS, `root y ~= 20, got ${root.y}`)
  assert.ok(Math.abs(root.rotation - Math.PI / 2) < EPS)

  // Nested shape: world cross-check only (simplest independent hand-check —
  // orbit the shape's KNOWN pre-rotate world point, computed the same way
  // as test 15's, around the world center). Original world point:
  // parent3.xy + rotate((10,0), pi/2) = (50,50) + (0,10) = (50,60).
  // Orbiting (50,60) around (0,0) by pi/2: x' = 50*cos90-60*sin90 = -60;
  // y' = 50*sin90+60*cos90 = 50.
  const model = dumpModel(editor.doc)
  const nestedWorld = worldTransform(model, model.byId.get('shape:nested')!)
  assert.ok(Math.abs(nestedWorld.x - -60) < EPS, `nested world x ~= -60, got ${nestedWorld.x}`)
  assert.ok(Math.abs(nestedWorld.y - 50) < EPS, `nested world y ~= 50, got ${nestedWorld.y}`)

  console.log('ok: RotateShapes mixed selection (rotated-parent-nested + root) both compute correctly in one intent')
}

// ============================================================================
// 18. Parent + descendant in ONE RotateShapes intent must transform the
//     parent ONLY (ancestor dedupe — the same rule TranslateShapes has
//     always had): the parent's own rotation already carries the child via
//     composition (a child's world transform is parentWorld ∘ local, so
//     rotating the parent rotates the child's world frame for free);
//     rotating the child TOO double-transforms it. Reviewer probe: parent
//     at (100,100) rotation 0, child at LOCAL (10,0); rotate BOTH about
//     world (100,100) by pi/2.
//
//     HAND-COMPUTED expected (rigid-body orbit, independent of the
//     implementation): the whole parent+child assembly is one rigid body
//     rotating pi/2 about (100,100). Child's world position BEFORE:
//     (100,100) + (10,0) = (110,100). Orbit about (100,100) by pi/2:
//     relative (10,0) -> (0,10) -> world (100,110). Child's world rotation:
//     exactly pi/2 (the parent's new rotation; the child's own field must
//     stay 0). The BUG this pins (red-first, reviewer-reproduced): without
//     dedupe the child's own rotation field ALSO got +pi/2 (world rotation
//     pi, double) and its position was orbited a second time against the
//     already-rotated parent read live mid-batch.
// ============================================================================
{
  const { doc, editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:rp', { x: 100, y: 100 }) })
  editor.apply({ type: 'CreateShape', shape: shape('shape:rc', { x: 10, y: 0, parentId: 'shape:rp' }) })

  editor.apply({ type: 'RotateShapes', ids: ['shape:rp', 'shape:rc'], center: { x: 100, y: 100 }, dRadians: Math.PI / 2 })

  const EPS = 1e-9
  const model = dumpModel(doc)
  const childWorld = worldTransform(model, model.byId.get('shape:rc')!)
  assert.ok(Math.abs(childWorld.rotation - Math.PI / 2) < EPS, `child world rotation EXACTLY pi/2 (parent's rotation only), got ${childWorld.rotation}`)
  assert.ok(Math.abs(childWorld.x - 100) < EPS, `child world x ~= 100 (rigid-body orbit), got ${childWorld.x}`)
  assert.ok(Math.abs(childWorld.y - 110) < EPS, `child world y ~= 110 (rigid-body orbit), got ${childWorld.y}`)

  // The child's OWN local fields are untouched — it moved only via the parent.
  const childRaw = editor.doc.getShape('shape:rc')!
  assert.equal(childRaw.x, 10, 'child local x untouched')
  assert.equal(childRaw.y, 0, 'child local y untouched')
  assert.equal(childRaw.rotation, 0, 'child own rotation field untouched')

  console.log('ok: RotateShapes dedupes parent+descendant overlap (child transforms exactly once, via the parent)')
}

// ============================================================================
// 19. Parent + descendant in ONE ResizeShapes intent: same ancestor-dedupe
//     rule — only the parent is scaled; the child's local fields (position
//     within the parent AND its own w/h) are untouched, riding along via
//     the parent's frame rather than being scaled a second time.
// ============================================================================
{
  const { editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:sp', { x: 100, y: 100, kind: 'geo', props: { w: 40, h: 20 } }) })
  editor.apply({ type: 'CreateShape', shape: shape('shape:sc', { x: 10, y: 0, parentId: 'shape:sp', kind: 'geo', props: { w: 20, h: 10 } }) })

  editor.apply({ type: 'ResizeShapes', ids: ['shape:sp', 'shape:sc'], anchor: { x: 100, y: 100 }, scaleX: 2, scaleY: 2 })

  const parent = editor.doc.getShape('shape:sp')!
  assert.equal(parent.x, 100, 'parent at the anchor: position fixed')
  assert.equal(parent.y, 100)
  assert.equal((parent.props as any).w, 80, 'parent w scaled once')
  assert.equal((parent.props as any).h, 40)

  const child = editor.doc.getShape('shape:sc')!
  assert.equal(child.x, 10, 'child local x untouched — it rides the parent, not its own scale')
  assert.equal(child.y, 0)
  assert.equal((child.props as any).w, 20, 'child w NOT scaled a second time')
  assert.equal((child.props as any).h, 10)

  console.log('ok: ResizeShapes dedupes parent+descendant overlap (child scales exactly once, via the parent)')
}

// ============================================================================
// 20. Minimum-size clamp: a resize whose scale would drive stored props.w/h
//     negative (corner dragged THROUGH the opposite anchor) or below 1
//     world unit is clamped per shape/axis — stored geometry can never go
//     negative (tldraw FLIPS instead; flip semantics are a documented
//     Phase-4 parity item, see intents.ts's ResizeShapes doc).
// ============================================================================
{
  const { editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:clamp', { x: 20, y: 20, kind: 'geo', props: { w: 100, h: 50 } }) })

  // Through-anchor: negative scale on both axes.
  editor.apply({ type: 'ResizeShapes', ids: ['shape:clamp'], anchor: { x: 20, y: 20 }, scaleX: -0.5, scaleY: -0.5 })

  const s = editor.doc.getShape('shape:clamp')!
  const w = (s.props as any).w as number, h = (s.props as any).h as number
  assert.ok(w > 0, `stored w must never go negative, got ${w}`)
  assert.ok(h > 0, `stored h must never go negative, got ${h}`)
  assert.ok(Math.abs(w - 1) < 1e-9, `w clamps at the 1-world-unit floor, got ${w}`)
  assert.ok(Math.abs(h - 1) < 1e-9, `h clamps at the 1-world-unit floor, got ${h}`)
  assert.equal(s.x, 20, 'position math uses the SAME clamped scale (shape at the anchor: fixed)')
  assert.equal(s.y, 20)

  // A legitimate resize above the floor is untouched by the clamp.
  editor.apply({ type: 'ResizeShapes', ids: ['shape:clamp'], anchor: { x: 20, y: 20 }, scaleX: 3, scaleY: 4 })
  const s2 = editor.doc.getShape('shape:clamp')!
  assert.ok(Math.abs((s2.props as any).w - 3) < 1e-9, 'scale above the floor applies exactly')
  assert.ok(Math.abs((s2.props as any).h - 4) < 1e-9)

  console.log('ok: ResizeShapes clamps stored w/h at a 1-world-unit floor — never negative')
}

// ============================================================================
// 21. UpdateProps (Task D1): SHALLOW-merges `props` into the shape's current
//     props map — a pre-existing key not named in this call survives
//     untouched, and a named key is overwritten — matching
//     CanvasDoc.updateProps's own `{...current, ...props}` contract exactly
//     (loro-canvas-doc.ts). An unknown id is a silent no-op: no throw, and
//     docMutated:false — proven via commit-counting, the same technique test
//     14 uses for SetText's identical tolerance contract.
// ============================================================================
{
  const { doc, editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:a', { props: { title: 'orig', kept: 'stays' } }) })

  editor.apply({ type: 'UpdateProps', id: 'shape:a', props: { title: 'x' } })
  assert.deepEqual(
    editor.doc.getShape('shape:a')!.props,
    { title: 'x', kept: 'stays' },
    'UpdateProps shallow-merges — an unnamed pre-existing key survives, a named key is overwritten',
  )

  let commits = 0
  doc.subscribeLocalUpdates(() => { commits += 1 })
  editor.apply({ type: 'UpdateProps', id: 'shape:missing', props: { title: 'y' } })
  assert.equal(commits, 0, 'UpdateProps on an unknown id must not commit — docMutated must be false')

  console.log('ok: UpdateProps shallow-merges props and silently no-ops on an unknown id')
}

// ============================================================================
// 22. SetStyle (Task E1): batch style-patch across the WHOLE selection —
//     shallow-merges `props` into EACH id's props map (like UpdateProps, but
//     multi-id) AND sets each id's ENVELOPE `opacity` (which UpdateProps
//     cannot reach — canvas-doc's updateProps only ever merges the props
//     map, see canvas-doc/src/canvas-doc.ts's updateProps contract comment).
//     Full-shape-inverse convention (same as UpdateProps): undo restores the
//     COMPLETE pre-mutation shape (props AND opacity) for every id, in ONE
//     UndoEntry per batch (one doc.commit()). An unresolved id is SKIPPED,
//     never thrown (applyAll TOLERANCE CONTRACT).
// ============================================================================
{
  const { doc, editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:a', { props: { color: 'red', kept: 'a-stays' }, opacity: 1 }) })
  editor.apply({ type: 'CreateShape', shape: shape('shape:b', { props: { color: 'red', kept: 'b-stays' }, opacity: 1 }) })

  let commits = 0
  doc.subscribeLocalUpdates(() => { commits += 1 })

  editor.applyAll([{ type: 'SetStyle', ids: ['shape:a', 'shape:b'], props: { color: 'blue' }, opacity: 0.5 }])

  assert.equal(commits, 1, 'SetStyle over a two-id batch is ONE doc.commit(), not one per id')
  assert.equal(doc.getShape('shape:a')!.props.color, 'blue', 'shape a got the prop patch')
  assert.equal(doc.getShape('shape:b')!.props.color, 'blue', 'shape b got the SAME prop patch — batch, not single-id (kills the ids[0]-only mutant)')
  assert.equal((doc.getShape('shape:a')!.props as any).kept, 'a-stays', 'shallow merge: an unnamed pre-existing prop key survives (not an overwrite)')
  assert.equal((doc.getShape('shape:b')!.props as any).kept, 'b-stays')
  assert.equal(doc.getShape('shape:a')!.opacity, 0.5, 'shape a got the ENVELOPE opacity write — UpdateProps cannot reach this field')
  assert.equal(doc.getShape('shape:b')!.opacity, 0.5, 'shape b got the envelope opacity write too')

  // Unresolved id: skipped, never thrown -- and since nothing resolved,
  // docMutated is false, so it must not occupy a commit either.
  const commitsBeforeGhost = commits
  assert.doesNotThrow(
    () => editor.applyAll([{ type: 'SetStyle', ids: ['shape:ghost'], props: { color: 'red' } }]),
    'SetStyle over an unresolved id does not throw',
  )
  assert.equal(commits, commitsBeforeGhost, 'an all-unresolved SetStyle batch does not commit')

  // Undo/redo round trip: ONE undo step restores BOTH shapes' full
  // pre-image (props AND opacity) -- kills a no-undo mutant (handler
  // returns undo:[]) and an opacity-dropped mutant (handler merges props
  // but never captures/restores the envelope field).
  editor.undo()
  assert.equal(doc.getShape('shape:a')!.props.color, 'red', "undo restores shape a's prior color")
  assert.equal(doc.getShape('shape:a')!.opacity, 1, "undo restores shape a's prior opacity")
  assert.equal(doc.getShape('shape:b')!.props.color, 'red', "undo restores shape b's prior color in the SAME step")
  assert.equal(doc.getShape('shape:b')!.opacity, 1, "undo restores shape b's prior opacity in the same step")

  editor.redo()
  assert.equal(doc.getShape('shape:a')!.props.color, 'blue', 're-applies the prop patch')
  assert.equal(doc.getShape('shape:a')!.opacity, 0.5, 're-applies the opacity write')
  assert.equal(doc.getShape('shape:b')!.props.color, 'blue')
  assert.equal(doc.getShape('shape:b')!.opacity, 0.5)

  console.log('ok: SetStyle batch-patches props + envelope opacity across a selection, with tolerant unresolved ids and full-batch undo/redo')
}

// ============================================================================
// 23. SetNextStyle (Task AS1): editor-LOCAL "armed" style a newly-created
//     shape will inherit — parity with tldraw arming a color on the tool
//     before drawing. A VIEW intent (like SetCamera/SetSelection/SetHover):
//     touches ONLY nextShapeStyle in EditorState, never the doc, never the
//     undo stack. Shallow-MERGES `props` into the existing nextShapeStyle
//     (arming color then arming size accumulates both), it does not replace.
// ============================================================================
{
  const { doc, editor } = makeEditor(1n)

  // View-intent purity baselines captured BEFORE any SetNextStyle call — a
  // mutant that treats SetNextStyle as a mutation would already corrupt
  // these on the FIRST call below, so the baseline must predate all of them,
  // not just the last.
  let commits = 0
  doc.subscribeLocalUpdates(() => { commits += 1 })
  const canUndoBefore = editor.canUndo()

  assert.deepEqual(editor.get().nextShapeStyle, {}, 'nextShapeStyle starts empty')

  editor.apply({ type: 'SetNextStyle', props: { color: 'blue' } })
  assert.equal(editor.get().nextShapeStyle.color, 'blue', 'SetNextStyle sets the given key')

  // Shallow-merge, not replace: arming a second axis must not drop the first.
  editor.apply({ type: 'SetNextStyle', props: { size: 'l' } })
  assert.equal(editor.get().nextShapeStyle.color, 'blue', 'a later SetNextStyle for a DIFFERENT key does not drop an earlier one — kills the replace-instead-of-merge mutant')
  assert.equal(editor.get().nextShapeStyle.size, 'l')

  editor.apply({ type: 'SetNextStyle', props: { color: 'red' } })
  assert.equal(commits, 0, 'SetNextStyle never calls doc.commit(), across all three calls above — kills a mutant that routes it through the doc')
  assert.equal(editor.canUndo(), canUndoBefore, 'SetNextStyle never pushes an undo entry, across all three calls above — kills a mutant that treats it as a mutation')
  assert.equal(editor.get().nextShapeStyle.color, 'red', 'the merge did take effect')

  console.log('ok: SetNextStyle shallow-merges the armed style, view-only (no commit, no undo)')
}

// ============================================================================
// 24. PutBinding (Task E2): a binding write intent, validated via
//     bindingSchema before it ever reaches doc.putBinding — closing the gap
//     that raw CanvasDoc.putBinding performs NO validation (D-2 correction
//     2). Valid binding lands and undoes/redoes like any other doc mutation;
//     a junk binding (fails bindingSchema) is a silent no-op — never reaches
//     the doc, never throws, never pushes an undo entry.
// ============================================================================
{
  const { doc, editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:a') })
  editor.apply({ type: 'CreateShape', shape: shape('shape:b') })

  const binding: Binding = {
    id: 'binding:x' as any,
    fromId: 'shape:a' as any,
    toId: 'shape:b' as any,
    props: {},
    meta: {},
  }
  editor.apply({ type: 'PutBinding', binding })
  assert.deepEqual(doc.listBindings().map((b) => b.id), ['binding:x'], 'PutBinding with a valid binding lands in the doc')

  editor.undo()
  assert.deepEqual(doc.listBindings(), [], 'undo of PutBinding removes the binding')

  editor.redo()
  assert.deepEqual(doc.listBindings().map((b) => b.id), ['binding:x'], 'redo of PutBinding re-adds the binding')

  console.log('ok: undo/redo PutBinding')
}

{
  const { doc, editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:a') })
  editor.apply({ type: 'CreateShape', shape: shape('shape:b') })
  const canUndoBefore = editor.canUndo()

  const junk = { id: 'binding:y', fromId: 42, toId: 'shape:b', props: {}, meta: {} }
  assert.doesNotThrow(() => editor.apply({ type: 'PutBinding', binding: junk as any }), 'a junk binding is refused, never thrown')
  assert.deepEqual(doc.listBindings(), [], 'a junk binding (fromId: 42, fails bindingSchema) never reaches doc.putBinding')
  assert.equal(editor.canUndo(), canUndoBefore, 'a refused PutBinding pushes no undo entry')

  console.log('ok: PutBinding refuses a binding that fails bindingSchema, no-op, no throw')
}

console.log('ok: canvas-editor editor + intents')
