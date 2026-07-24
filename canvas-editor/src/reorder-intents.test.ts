// Run: bun src/reorder-intents.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import { generateNKeysBetween, orderForPaint, type Shape } from '@ensembleworks/canvas-model'
import { Editor } from './editor.js'
import { reorderSelectionIntents } from './reorder-intents.js'

// Injected clock/PRNG — fixed, non-advancing (mirrors editor.test.ts /
// clipboard-intents.test.ts's convention). reorderSelectionIntents never
// consumes either (it derives every new index from A1's deterministic
// generateKeyBetween/generateNKeysBetween), but the Editor constructor still
// requires them.
const FIXED_NOW = () => 1_700_000_000_000
const FIXED_RANDOM = () => 0.5

function makeEditor(): { doc: LoroCanvasDoc; editor: Editor } {
  const doc = LoroCanvasDoc.create({ peerId: 1n })
  doc.putPage({ id: 'page:p', name: 'P' })
  doc.commit()
  const editor = new Editor({ doc, now: FIXED_NOW, random: FIXED_RANDOM, pageId: 'page:p' })
  return { doc, editor }
}

const shape = (id: string, index: string, over: Partial<Shape> = {}): Shape =>
  ({
    id, kind: 'geo', parentId: 'page:p', index,
    x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: {}, ...over,
  }) as Shape

// A clean i0<i1<i2<i3 run minted via A1 itself (not the 'a1' legacy
// corpus) so assertions are about ORDER, not a specific literal string —
// exactly what the plan's Step 1 asks for.
const [i0, i1, i2, i3] = generateNKeysBetween(null, null, 4)

// Apply a batch of SetIndex intents to a scratch doc and read back the
// resulting (index,id) paint order for a given parent — this is what every
// case below asserts against, per the plan's "assert against the RESULTING
// ordering, not the raw index strings" instruction (robust to A1's exact
// midpoints).
function paintOrderIds(doc: LoroCanvasDoc, parentId: string): string[] {
  const all = doc.listShapes()
  const inParent = all.filter((s) => s.parentId === parentId)
  const byId = new Map(all.map((s) => [s.id, s]))
  return orderForPaint(inParent, byId).map((s) => s.id)
}

// ============================================================================
// 1. toFront on the BOTTOM shape (shape:a, i0) among four siblings -> its
//    new index sorts strictly after all three others; no other SetIndex is
//    emitted (only the mover changes).
// ============================================================================
{
  const { doc, editor } = makeEditor()
  doc.putShape(shape('shape:a', i0))
  doc.putShape(shape('shape:b', i1))
  doc.putShape(shape('shape:c', i2))
  doc.putShape(shape('shape:d', i3))
  doc.commit()
  editor.apply({ type: 'SetSelection', ids: ['shape:a'] })

  const intents = reorderSelectionIntents(editor, 'toFront')
  assert.equal(intents.length, 1, 'toFront on a single shape emits exactly one SetIndex')
  assert.equal(intents[0]!.type, 'SetIndex', 'the emitted intent is a SetIndex')
  assert.equal((intents[0] as { id: string }).id, 'shape:a', 'the moved shape is the one selected')

  editor.applyAll(intents)
  assert.deepEqual(
    paintOrderIds(doc, 'page:p'),
    ['shape:b', 'shape:c', 'shape:d', 'shape:a'],
    'shape:a now paints LAST (on top) — strictly after b, c, and d',
  )
  console.log('ok: reorder-intents — toFront moves the bottom shape above all siblings')
}

// ============================================================================
// 2. toBack on the TOP shape (shape:d, i3) -> new index sorts strictly
//    before all others.
// ============================================================================
{
  const { doc, editor } = makeEditor()
  doc.putShape(shape('shape:a', i0))
  doc.putShape(shape('shape:b', i1))
  doc.putShape(shape('shape:c', i2))
  doc.putShape(shape('shape:d', i3))
  doc.commit()
  editor.apply({ type: 'SetSelection', ids: ['shape:d'] })

  const intents = reorderSelectionIntents(editor, 'toBack')
  assert.equal(intents.length, 1, 'toBack on a single shape emits exactly one SetIndex')

  editor.applyAll(intents)
  assert.deepEqual(
    paintOrderIds(doc, 'page:p'),
    ['shape:d', 'shape:a', 'shape:b', 'shape:c'],
    'shape:d now paints FIRST (bottom) — strictly before a, b, and c',
  )
  console.log('ok: reorder-intents — toBack moves the top shape below all siblings')
}

// ============================================================================
// 3. forward on a MIDDLE shape (shape:b, i1) -> swaps with its immediate
//    upper neighbor (shape:c) only; shape:a and shape:d (two-or-more away)
//    are untouched. Mutant killed: "forward === toFront" would instead put
//    shape:b at the very top, above shape:d too.
// ============================================================================
{
  const { doc, editor } = makeEditor()
  doc.putShape(shape('shape:a', i0))
  doc.putShape(shape('shape:b', i1))
  doc.putShape(shape('shape:c', i2))
  doc.putShape(shape('shape:d', i3))
  doc.commit()
  editor.apply({ type: 'SetSelection', ids: ['shape:b'] })

  const intents = reorderSelectionIntents(editor, 'forward')
  assert.equal(intents.length, 1, 'forward on a single non-blocked shape emits exactly one SetIndex')
  assert.equal((intents[0] as { id: string }).id, 'shape:b', 'the moved shape is the one selected')

  editor.applyAll(intents)
  assert.deepEqual(
    paintOrderIds(doc, 'page:p'),
    ['shape:a', 'shape:c', 'shape:b', 'shape:d'],
    'shape:b moved exactly ONE step up — swapped with shape:c only, shape:d untouched above it',
  )
  console.log('ok: reorder-intents — forward moves a shape exactly one step, not to front')
}

// ============================================================================
// 4. backward on a MIDDLE shape (shape:c, i2) -> symmetric: swaps with its
//    immediate lower neighbor (shape:b) only.
// ============================================================================
{
  const { doc, editor } = makeEditor()
  doc.putShape(shape('shape:a', i0))
  doc.putShape(shape('shape:b', i1))
  doc.putShape(shape('shape:c', i2))
  doc.putShape(shape('shape:d', i3))
  doc.commit()
  editor.apply({ type: 'SetSelection', ids: ['shape:c'] })

  const intents = reorderSelectionIntents(editor, 'backward')
  assert.equal(intents.length, 1, 'backward on a single non-blocked shape emits exactly one SetIndex')

  editor.applyAll(intents)
  assert.deepEqual(
    paintOrderIds(doc, 'page:p'),
    ['shape:a', 'shape:c', 'shape:b', 'shape:d'],
    'shape:c moved exactly ONE step down — swapped with shape:b only, shape:a untouched below it',
  )
  console.log('ok: reorder-intents — backward moves a shape exactly one step, not to back')
}

// ============================================================================
// 5. Multi-select toFront (shape:a and shape:c, the two LOWER-of-their-pair
//    movers among four) -> both land above the two unselected siblings, and
//    their RELATIVE order is preserved (shape:a, which sorted below shape:c
//    before the move, still sorts below shape:c after it). Mutant killed:
//    assigning generateNKeysBetween's keys in the wrong order (or sorting
//    movers by selection-array order instead of current (index,id) order)
//    would flip or scramble that relative order.
// ============================================================================
{
  const { doc, editor } = makeEditor()
  doc.putShape(shape('shape:a', i0))
  doc.putShape(shape('shape:b', i1))
  doc.putShape(shape('shape:c', i2))
  doc.putShape(shape('shape:d', i3))
  doc.commit()
  // Selection array deliberately lists them out of (index,id) order (c then
  // a) to prove the emitter re-sorts movers by their CURRENT doc order, not
  // selection-array order.
  editor.apply({ type: 'SetSelection', ids: ['shape:c', 'shape:a'] })

  const intents = reorderSelectionIntents(editor, 'toFront')
  assert.equal(intents.length, 2, 'toFront on two selected shapes emits exactly two SetIndex intents')
  const movedIds = new Set(intents.map((i) => (i as { id: string }).id))
  assert.deepEqual(movedIds, new Set(['shape:a', 'shape:c']), 'only the selected shapes move')

  editor.applyAll(intents)
  const order = paintOrderIds(doc, 'page:p')
  assert.deepEqual(order.slice(0, 2), ['shape:b', 'shape:d'], 'the two unselected siblings stay at the bottom, in their own order')
  assert.deepEqual(order.slice(2), ['shape:a', 'shape:c'], 'the movers land on top, shape:a still below shape:c (relative order preserved)')
  console.log('ok: reorder-intents — multi-select toFront preserves the movers’ relative order')
}

// ============================================================================
// 5b. Multi-select FORWARD with two ADJACENT selected siblings (shape:b,
//     shape:c out of a, b, c, d) — the block hops together over its single
//     unselected upper neighbor (shape:d), relative order preserved.
//     Regression coverage: an earlier implementation reused the moved
//     shape's STALE original index when splicing it back into the local
//     array, so the second mover's "beyond" bound read an inverted (a >= b)
//     pair and generateKeyBetween threw. This case reproduces that exact
//     topology and must complete without throwing.
// ============================================================================
{
  const { doc, editor } = makeEditor()
  doc.putShape(shape('shape:a', i0))
  doc.putShape(shape('shape:b', i1))
  doc.putShape(shape('shape:c', i2))
  doc.putShape(shape('shape:d', i3))
  doc.commit()
  editor.apply({ type: 'SetSelection', ids: ['shape:b', 'shape:c'] })

  const intents = reorderSelectionIntents(editor, 'forward')
  assert.equal(intents.length, 2, 'both adjacent movers get a new index (neither is blocked by the OTHER mover)')

  editor.applyAll(intents)
  assert.deepEqual(
    paintOrderIds(doc, 'page:p'),
    ['shape:a', 'shape:d', 'shape:b', 'shape:c'],
    'the selected block (b,c) hops over its one unselected neighbor (d) together, relative order (b below c) preserved',
  )
  console.log('ok: reorder-intents — multi-select forward with adjacent movers hops the block over its blocker without throwing')
}

// ============================================================================
// 5c. Symmetric backward case: shape:b and shape:c adjacent-selected among
//     a, b, c, d — the block hops DOWN together over its one unselected
//     lower neighbor (shape:a).
// ============================================================================
{
  const { doc, editor } = makeEditor()
  doc.putShape(shape('shape:a', i0))
  doc.putShape(shape('shape:b', i1))
  doc.putShape(shape('shape:c', i2))
  doc.putShape(shape('shape:d', i3))
  doc.commit()
  editor.apply({ type: 'SetSelection', ids: ['shape:b', 'shape:c'] })

  const intents = reorderSelectionIntents(editor, 'backward')
  assert.equal(intents.length, 2, 'both adjacent movers get a new index')

  editor.applyAll(intents)
  assert.deepEqual(
    paintOrderIds(doc, 'page:p'),
    ['shape:b', 'shape:c', 'shape:a', 'shape:d'],
    'the selected block (b,c) hops below its one unselected neighbor (a) together, relative order (b below c) preserved',
  )
  console.log('ok: reorder-intents — multi-select backward with adjacent movers hops the block over its blocker without throwing')
}

// ============================================================================
// 5d. Forward is blocked by a STUCK selected neighbor: shape:b and shape:c
//     are both selected and shape:c is already the topmost sibling (nothing
//     above it). c is blocked (no room above). b's immediate upper neighbor
//     is c — still selected and unmoved — so b must ALSO be blocked (no
//     leapfrogging a selected sibling that didn't move). Mutant killed:
//     "forward moves past a SELECTED neighbor" would let b hop over the
//     stuck c, emitting a spurious SetIndex for b.
// ============================================================================
{
  const { doc, editor } = makeEditor()
  doc.putShape(shape('shape:a', i0))
  doc.putShape(shape('shape:b', i1))
  doc.putShape(shape('shape:c', i2))
  doc.commit()
  editor.apply({ type: 'SetSelection', ids: ['shape:b', 'shape:c'] })

  assert.deepEqual(
    reorderSelectionIntents(editor, 'forward'),
    [],
    'both b (blocked by stuck-selected c) and c (topmost, nothing above) stay put',
  )
  console.log('ok: reorder-intents — forward never leapfrogs a selected sibling that is itself blocked')
}

// ============================================================================
// 5e. Symmetric backward case: shape:a and shape:b selected, shape:a is
//     already the bottommost sibling (nothing below it).
// ============================================================================
{
  const { doc, editor } = makeEditor()
  doc.putShape(shape('shape:a', i0))
  doc.putShape(shape('shape:b', i1))
  doc.putShape(shape('shape:c', i2))
  doc.commit()
  editor.apply({ type: 'SetSelection', ids: ['shape:a', 'shape:b'] })

  assert.deepEqual(
    reorderSelectionIntents(editor, 'backward'),
    [],
    'both b (blocked by stuck-selected a) and a (bottommost, nothing below) stay put',
  )
  console.log('ok: reorder-intents — backward never leapfrogs a selected sibling that is itself blocked')
}

// ============================================================================
// 6. Siblings-only: a selection spanning TWO parents reorders each parent's
//    siblings independently — it never cross-compares indices between the
//    two groups. Mutant killed: treating the whole selection as one flat
//    sibling group would compute bogus cross-parent bounds.
// ============================================================================
{
  const { doc, editor } = makeEditor()
  // Parent group 1: the page, two children.
  doc.putShape(shape('shape:p1', i0))
  doc.putShape(shape('shape:p2', i1))
  // Parent group 2: a frame, with its own two children (indices reset —
  // fractional indices are only ever compared within a parent).
  const [j0, j1] = generateNKeysBetween(null, null, 2)
  doc.putShape(shape('shape:frame', i2, { kind: 'frame' }))
  doc.putShape(shape('shape:f1', j0, { parentId: 'shape:frame' }))
  doc.putShape(shape('shape:f2', j1, { parentId: 'shape:frame' }))
  doc.commit()
  // Select the BOTTOM shape of each group and bring both to front.
  editor.apply({ type: 'SetSelection', ids: ['shape:p1', 'shape:f1'] })

  const intents = reorderSelectionIntents(editor, 'toFront')
  assert.equal(intents.length, 2, 'one SetIndex per parent group')

  editor.applyAll(intents)
  assert.deepEqual(
    paintOrderIds(doc, 'page:p'),
    ['shape:p2', 'shape:frame', 'shape:p1'],
    'within the page group, shape:p1 moved above shape:p2 (and above the frame, an unrelated sibling)',
  )
  assert.deepEqual(
    paintOrderIds(doc, 'shape:frame'),
    ['shape:f2', 'shape:f1'],
    'within the frame group, shape:f1 moved above shape:f2 — entirely independent of the page group',
  )
  console.log('ok: reorder-intents — a selection spanning two parents reorders each parent’s siblings independently')
}

// ============================================================================
// 6b. A NESTED only-child (no siblings sharing its OWN parentId) stays a
//     no-op even when unrelated shapes with different parentIds exist
//     elsewhere in the doc. Mutant killed: "reorders across parents as one
//     flat group" would pool those unrelated shapes in as bogus siblings and
//     emit a spurious SetIndex.
// ============================================================================
{
  const { doc, editor } = makeEditor()
  const [k0, k1, k2] = generateNKeysBetween(null, null, 3)
  doc.putShape(shape('shape:frame2', k1, { kind: 'frame' })) // page-level, unrelated to the target group
  doc.putShape(shape('shape:solo', k0, { parentId: 'shape:frame2' })) // frame2's ONLY child
  doc.putShape(shape('shape:x', k2)) // another unrelated page-level shape
  doc.commit()
  editor.apply({ type: 'SetSelection', ids: ['shape:solo'] })

  assert.deepEqual(
    reorderSelectionIntents(editor, 'toFront'),
    [],
    'shape:solo has no siblings under its OWN parent (shape:frame2) — unrelated page-level shapes must not count as siblings',
  )
  console.log('ok: reorder-intents — a nested only-child is a no-op regardless of unrelated shapes elsewhere in the doc')
}

// ============================================================================
// 7. Empty selection -> [].
// ============================================================================
{
  const { editor } = makeEditor()
  for (const op of ['toFront', 'toBack', 'forward', 'backward'] as const) {
    assert.deepEqual(reorderSelectionIntents(editor, op), [], `empty selection yields no intents for ${op}`)
  }
  console.log('ok: reorder-intents — empty selection is a no-op for all four ops')
}

// ============================================================================
// 8. A single only-child (no other siblings to move past) -> [] for every
//    op, no spurious SetIndex.
// ============================================================================
{
  const { doc, editor } = makeEditor()
  doc.putShape(shape('shape:only', i0))
  doc.commit()
  editor.apply({ type: 'SetSelection', ids: ['shape:only'] })

  for (const op of ['toFront', 'toBack', 'forward', 'backward'] as const) {
    assert.deepEqual(reorderSelectionIntents(editor, op), [], `an only-child selection yields no intents for ${op} (nothing to move past)`)
  }
  console.log('ok: reorder-intents — a selection with no other siblings is a no-op for all four ops')
}

// ============================================================================
// 9. Blocked forward/backward: the TOP shape can't go forward, the BOTTOM
//    shape can't go backward -> [].
// ============================================================================
{
  const { doc, editor } = makeEditor()
  doc.putShape(shape('shape:a', i0))
  doc.putShape(shape('shape:b', i1))
  doc.commit()

  editor.apply({ type: 'SetSelection', ids: ['shape:b'] })
  assert.deepEqual(reorderSelectionIntents(editor, 'forward'), [], 'the topmost shape has nothing above it to move past')

  editor.apply({ type: 'SetSelection', ids: ['shape:a'] })
  assert.deepEqual(reorderSelectionIntents(editor, 'backward'), [], 'the bottommost shape has nothing below it to move past')
  console.log('ok: reorder-intents — forward/backward at the boundary is a no-op, not a wraparound')
}

// ============================================================================
// 10. Determinism: identical input state -> identical emitted intents
//     (byte-for-byte), across two independently-constructed editors. This is
//     what A1's determinism buys the reorder emitter (no Math.random/Date.now
//     anywhere in the index math).
// ============================================================================
{
  function run(): unknown {
    const { doc, editor } = makeEditor()
    doc.putShape(shape('shape:a', i0))
    doc.putShape(shape('shape:b', i1))
    doc.putShape(shape('shape:c', i2))
    doc.commit()
    editor.apply({ type: 'SetSelection', ids: ['shape:a', 'shape:c'] })
    return reorderSelectionIntents(editor, 'toFront')
  }
  assert.deepEqual(run(), run(), 'the same input state emits byte-identical intents on every run')
  console.log('ok: reorder-intents — deterministic emission across independent runs')
}
