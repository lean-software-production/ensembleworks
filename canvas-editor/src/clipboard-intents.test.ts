// Run: bun src/clipboard-intents.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import { encodeClipboard, generateKeyBetween, serializeSelection, type Binding, type Shape } from '@ensembleworks/canvas-model'
import { Editor } from './editor.js'
import { DUP_OFFSET, duplicateSelectionIntents, pasteIntents } from './clipboard-intents.js'

// Injected clock/PRNG — FIXED_RANDOM is a CONSTANT stream (mirrors
// editor.test.ts's convention): this is the "constant-PRNG killer" the plan
// calls out — a mint scheme that forgets the per-node index salt (D-3) mints
// the SAME id for every node under a constant random() and the test below
// catches it via the distinct-ids assertion.
const FIXED_NOW = () => 1_700_000_000_000
const FIXED_RANDOM = () => 0.5

function makeEditor(): { doc: LoroCanvasDoc; editor: Editor } {
  const doc = LoroCanvasDoc.create({ peerId: 1n })
  doc.putPage({ id: 'page:p', name: 'P' })
  doc.commit()
  const editor = new Editor({ doc, now: FIXED_NOW, random: FIXED_RANDOM, pageId: 'page:p' })
  return { doc, editor }
}

const shape = (id: string, over: Partial<Shape> = {}): Shape =>
  ({
    id, kind: 'note', parentId: 'page:p', index: 'a1',
    x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: {}, ...over,
  }) as Shape

const binding = (id: string, fromId: string, toId: string): Binding =>
  ({ id, fromId, toId, props: {}, meta: {} }) as Binding

// ============================================================================
// 1. duplicateSelectionIntents: N shapes + an internal binding, selection is
//    the frame root. Assert distinct new ids, root offset by DUP_OFFSET,
//    child NOT offset, PutBinding present with remapped 'shape:'-endpoints,
//    SetSelection targets ONLY the new root, and the ORIGINALS are untouched.
// ============================================================================
{
  const { doc, editor } = makeEditor()
  doc.putShape(shape('shape:frame', { kind: 'frame', x: 10, y: 10 }))
  doc.putShape(shape('shape:child', { parentId: 'shape:frame', x: 1, y: 2 }))
  doc.putBinding(binding('binding:b1', 'shape:child', 'shape:frame'))
  doc.commit()
  editor.apply({ type: 'SetSelection', ids: ['shape:frame'] })

  const intents = duplicateSelectionIntents(editor)

  const creates = intents.filter((i) => i.type === 'CreateShape')
  const puts = intents.filter((i) => i.type === 'PutBinding')
  const sel = intents.find((i) => i.type === 'SetSelection')

  assert.equal(creates.length, 2, 'duplicate emits one CreateShape per cloned shape (frame + child)')
  const newIds = creates.map((c) => (c as { shape: Shape }).shape.id)
  assert.equal(new Set(newIds).size, 2, 'new ids are distinct even under a CONSTANT random()')
  for (const id of newIds) assert.notEqual(['shape:frame', 'shape:child'].includes(id), true, 'new ids are not the old ids')

  const newFrame = creates.map((c) => (c as { shape: Shape }).shape).find((s) => s.parentId === 'page:p')!
  assert.ok(newFrame, 'the cloned frame is re-rooted to the page')
  assert.equal(newFrame.x, 10 + DUP_OFFSET, 'root shape is offset on x')
  assert.equal(newFrame.y, 10 + DUP_OFFSET, 'root shape is offset on y')

  const newChild = creates.map((c) => (c as { shape: Shape }).shape).find((s) => s.parentId === newFrame.id)!
  assert.ok(newChild, 'the cloned child is re-parented under the cloned frame')
  assert.equal(newChild.x, 1, 'child keeps its LOCAL x (no offset — it rides the parent)')
  assert.equal(newChild.y, 2, 'child keeps its LOCAL y')

  assert.equal(puts.length, 1, 'the internal binding is cloned via PutBinding')
  const clonedBinding = (puts[0] as { binding: Binding }).binding
  assert.ok(clonedBinding.id.startsWith('binding:'), 'cloned binding id carries the binding: prefix (C3 mintBinding fix)')
  assert.equal(clonedBinding.fromId, newChild.id, 'binding fromId remapped to the NEW child')
  assert.equal(clonedBinding.toId, newFrame.id, 'binding toId remapped to the NEW frame')

  assert.ok(sel, 'a SetSelection intent is emitted')
  assert.deepEqual([...(sel as { ids: readonly string[] }).ids], [newFrame.id], 'selection targets ONLY the new ROOT, not the child')

  // Originals untouched: apply the batch and check the old ids still resolve
  // to their original geometry/parent.
  editor.applyAll(intents)
  const origFrame = editor.doc.getShape('shape:frame')!
  const origChild = editor.doc.getShape('shape:child')!
  assert.equal(origFrame.x, 10, 'original frame x untouched')
  assert.equal(origFrame.y, 10, 'original frame y untouched')
  assert.equal(origChild.parentId, 'shape:frame', 'original child still parented to original frame')
  assert.ok(editor.doc.listBindings().some((b) => b.id === 'binding:b1'), 'original binding untouched')
  console.log('ok: duplicateSelectionIntents — reids, offsets, clones binding, selects new root, leaves originals alone')
}

// ============================================================================
// 2. empty selection -> no-op
// ============================================================================
{
  const { editor } = makeEditor()
  const intents = duplicateSelectionIntents(editor)
  assert.deepEqual(intents, [], 'empty selection duplicates to nothing')
  console.log('ok: duplicateSelectionIntents — empty selection is a no-op')
}

// ============================================================================
// 3. pasteIntents: round-trip through encodeClipboard(serializeSelection(...))
//    yields the analogous creates+selection batch.
// ============================================================================
{
  const { doc, editor } = makeEditor()
  doc.putShape(shape('shape:a', { x: 100, y: 200 }))
  doc.commit()

  const payload = serializeSelection(doc.listShapes(), doc.listBindings(), ['shape:a'])
  const text = encodeClipboard(payload)

  const intents = pasteIntents(editor, text)
  const creates = intents.filter((i) => i.type === 'CreateShape')
  const sel = intents.find((i) => i.type === 'SetSelection')

  assert.equal(creates.length, 1, 'paste emits one CreateShape for the single copied shape')
  const pasted = (creates[0] as { shape: Shape }).shape
  assert.notEqual(pasted.id, 'shape:a', 'pasted shape gets a NEW id')
  assert.equal(pasted.x, 100 + DUP_OFFSET, 'pasted shape is offset from its source position')
  assert.equal(pasted.y, 200 + DUP_OFFSET)
  assert.ok(sel)
  assert.deepEqual([...(sel as { ids: readonly string[] }).ids], [pasted.id], 'paste selects the new shape')
  console.log('ok: pasteIntents — decodes+clones+selects a valid clipboard payload')
}

// ============================================================================
// 4. pasteIntents on malformed clipboard text -> [] (C2 gate), never a throw.
// ============================================================================
{
  const { editor } = makeEditor()
  assert.deepEqual(pasteIntents(editor, 'garbage'), [], 'malformed clipboard text yields no intents, not a crash')
  console.log('ok: pasteIntents — malformed text is a safe no-op')
}

// ============================================================================
// 5. Determinism: a fixed random gives stable emitted ids across two
//    independently-constructed editors seeded identically.
// ============================================================================
{
  const run = () => {
    const { doc, editor } = makeEditor()
    doc.putShape(shape('shape:frame', { kind: 'frame', x: 10, y: 10 }))
    doc.putShape(shape('shape:child', { parentId: 'shape:frame', x: 1, y: 2 }))
    doc.commit()
    editor.apply({ type: 'SetSelection', ids: ['shape:frame'] })
    return duplicateSelectionIntents(editor)
      .filter((i) => i.type === 'CreateShape')
      .map((i) => (i as { shape: Shape }).shape.id)
  }
  assert.deepEqual(run(), run(), 'identical seeded random -> identical minted ids across independent runs')
  console.log('ok: duplicateSelectionIntents — deterministic under a fixed random')
}

// ============================================================================
// 6. E3 — duplicate: a duplicated ROOT's index lands STRICTLY ABOVE an
//    existing higher-indexed sibling, not merely tied with the source.
//    `cloneWithNewIds` PRESERVES the source index verbatim (Correction 1 in
//    the plan) — left alone, the duplicate would tie with its source ('a1')
//    and sort BELOW 'shape:existing' entirely, only ever winning a tie via
//    the (index,id) id tie-break, never reliably on top.
// ============================================================================
{
  const { doc, editor } = makeEditor()
  doc.putShape(shape('shape:existing', { index: generateKeyBetween('a1', null) }))
  doc.putShape(shape('shape:source', { index: 'a1' }))
  doc.commit()
  editor.apply({ type: 'SetSelection', ids: ['shape:source'] })

  const intents = duplicateSelectionIntents(editor)
  const created = (intents.find((i) => i.type === 'CreateShape') as { shape: Shape }).shape

  const existingIndex = doc.getShape('shape:existing')!.index
  assert.ok(created.index > existingIndex, `duplicated root (${created.index}) lands strictly above the existing higher sibling (${existingIndex}), not tied with the source`)
  console.log('ok: duplicateSelectionIntents — E3: duplicated root lands on top of existing content')
}

// ============================================================================
// 7. E3 — multi-root duplicate preserves relative order: the topmost
//    original stays topmost among the copies, regardless of the order the
//    shapes were SELECTED in (mirrors E2's scrambled-selection precedent —
//    D-4: movers are ordered by sorted doc order, never selection order).
// ============================================================================
{
  const { doc, editor } = makeEditor()
  doc.putShape(shape('shape:low', { index: 'a1', x: 0, y: 0 }))
  doc.putShape(shape('shape:high', { index: 'a2', x: 100, y: 100 }))
  doc.commit()
  editor.apply({ type: 'SetSelection', ids: ['shape:high', 'shape:low'] }) // reversed order on purpose

  const intents = duplicateSelectionIntents(editor)
  const creates = intents.filter((i) => i.type === 'CreateShape').map((i) => (i as { shape: Shape }).shape)
  const dupLow = creates.find((s) => s.x === 0 + DUP_OFFSET)!
  const dupHigh = creates.find((s) => s.x === 100 + DUP_OFFSET)!
  assert.ok(dupLow, 'the low original was duplicated')
  assert.ok(dupHigh, 'the high original was duplicated')
  assert.ok(dupLow.index < dupHigh.index, `the topmost original (shape:high, dup index ${dupHigh.index}) stays topmost among the duplicates over the bottom one (shape:low, dup index ${dupLow.index}), regardless of selection-array order`)
  console.log('ok: duplicateSelectionIntents — E3: multi-root relative order preserved (selection-order-independent)')
}

// ============================================================================
// 8. E3 — children keep their cloned (unchanged) relative indices; only the
//    ROOT (the frame) is reindexed to top-of-stack. A duplicated frame's
//    internal child z-order must not be scrambled by the root reindex.
// ============================================================================
{
  const { doc, editor } = makeEditor()
  doc.putShape(shape('shape:frame', { kind: 'frame', index: 'a1' }))
  doc.putShape(shape('shape:child1', { parentId: 'shape:frame', index: 'a1' }))
  doc.putShape(shape('shape:child2', { parentId: 'shape:frame', index: 'a2' }))
  doc.commit()
  editor.apply({ type: 'SetSelection', ids: ['shape:frame'] })

  const intents = duplicateSelectionIntents(editor)
  const creates = intents.filter((i) => i.type === 'CreateShape').map((i) => (i as { shape: Shape }).shape)
  const newFrame = creates.find((s) => s.parentId === 'page:p')!
  assert.ok(newFrame, 'the cloned frame is re-rooted to the page')
  assert.notEqual(newFrame.index, 'a1', 'the frame (root) got a NEW top-of-stack index, not its cloned-verbatim source index')

  const kids = creates.filter((s) => s.parentId === newFrame.id)
  assert.equal(kids.length, 2, 'both children were cloned')
  const kid1 = kids.find((s) => s.index === 'a1')
  const kid2 = kids.find((s) => s.index === 'a2')
  assert.ok(kid1, 'child1 keeps its cloned index a1 unchanged — only roots are reindexed')
  assert.ok(kid2, 'child2 keeps its cloned index a2 unchanged — only roots are reindexed')
  console.log('ok: duplicateSelectionIntents — E3: children keep subtree order, only the root is reindexed')
}

// ============================================================================
// 9. E3 — paste gets the same on-top treatment as duplicate.
// ============================================================================
{
  const { doc, editor } = makeEditor()
  doc.putShape(shape('shape:existing', { index: generateKeyBetween('a1', null) }))
  doc.putShape(shape('shape:a', { index: 'a1', x: 100, y: 200 }))
  doc.commit()

  const payload = serializeSelection(doc.listShapes(), doc.listBindings(), ['shape:a'])
  const text = encodeClipboard(payload)

  const intents = pasteIntents(editor, text)
  const pasted = (intents.find((i) => i.type === 'CreateShape') as { shape: Shape }).shape

  const existingIndex = doc.getShape('shape:existing')!.index
  assert.ok(pasted.index > existingIndex, `pasted root (${pasted.index}) lands strictly above the existing higher sibling (${existingIndex})`)
  console.log('ok: pasteIntents — E3: pasted root lands on top of existing content')
}

// ============================================================================
// 10. E3 — determinism: A1's generateNKeysBetween is deterministic, so
//     duplicating the same doc/selection twice (independent editors, same
//     fixed random) assigns identical top-of-stack indices, not just
//     identical ids.
// ============================================================================
{
  const run = () => {
    const { doc, editor } = makeEditor()
    doc.putShape(shape('shape:existing', { index: generateKeyBetween('a1', null) }))
    doc.putShape(shape('shape:source', { index: 'a1' }))
    doc.commit()
    editor.apply({ type: 'SetSelection', ids: ['shape:source'] })
    const created = (duplicateSelectionIntents(editor).find((i) => i.type === 'CreateShape') as { shape: Shape }).shape
    return created.index
  }
  assert.equal(run(), run(), 'identical seeded doc/selection -> identical top-of-stack index across independent runs')
  console.log('ok: duplicateSelectionIntents — E3: deterministic top-of-stack index')
}

// ============================================================================
// 11. E2b — duplicateSelectionIntents targets the CURRENT page. With a
//     selection on page:p and currentPageId switched to page:q, the
//     duplicated root's parentId is page:q, not editor.pageId ('page:p').
//     Mutant killed: "clones onto editor.pageId" -- that mutant would
//     re-root the duplicate onto 'page:p' regardless of the switch.
// ============================================================================
{
  const { doc, editor } = makeEditor()
  doc.putPage({ id: 'page:q', name: 'Q' })
  doc.putShape(shape('shape:source', { x: 10, y: 10 }))
  doc.commit()
  editor.apply({ type: 'SetSelection', ids: ['shape:source'] })
  editor.apply({ type: 'SetCurrentPage', pageId: 'page:q' })

  const intents = duplicateSelectionIntents(editor)
  const created = (intents.find((i) => i.type === 'CreateShape') as { shape: Shape }).shape
  assert.equal(created.parentId, 'page:q', 'duplicated root lands on the CURRENT page, not editor.pageId')
  console.log('ok: E2b — duplicateSelectionIntents targets the current page after SetCurrentPage')
}

// ============================================================================
// 12. E2b — pasteIntents targets the CURRENT page, same guard as duplicate.
// ============================================================================
{
  const { doc, editor } = makeEditor()
  doc.putPage({ id: 'page:q', name: 'Q' })
  doc.putShape(shape('shape:a', { x: 100, y: 200 }))
  doc.commit()
  const payload = serializeSelection(doc.listShapes(), doc.listBindings(), ['shape:a'])
  const text = encodeClipboard(payload)
  editor.apply({ type: 'SetCurrentPage', pageId: 'page:q' })

  const intents = pasteIntents(editor, text)
  const pasted = (intents.find((i) => i.type === 'CreateShape') as { shape: Shape }).shape
  assert.equal(pasted.parentId, 'page:q', 'pasted root lands on the CURRENT page, not editor.pageId')
  console.log('ok: E2b — pasteIntents targets the current page after SetCurrentPage')
}

// ============================================================================
// 13. E2b — migration safety: with currentPageId at its boot default
//     ('page:p', never switched), duplicate/paste are UNCHANGED.
// ============================================================================
{
  const { doc, editor } = makeEditor()
  doc.putShape(shape('shape:source', { x: 10, y: 10 }))
  doc.commit()
  editor.apply({ type: 'SetSelection', ids: ['shape:source'] })
  const intents = duplicateSelectionIntents(editor)
  const created = (intents.find((i) => i.type === 'CreateShape') as { shape: Shape }).shape
  assert.equal(created.parentId, 'page:p', 'with currentPageId at its boot default, duplicate still parents to page:p')
  console.log('ok: E2b — single-page default (no SetCurrentPage) still parents a duplicate to page:p')
}

// ============================================================================
// 14. E2b — the max-sibling scan (reindexRootsToTop) reads the CURRENT
//     page's siblings, not editor.pageId's. A high-indexed sibling that
//     lives on page:p must NOT push the duplicate's (page:q) top-of-stack
//     index above where it belongs among page:q's own (empty) siblings.
// ============================================================================
{
  const { doc, editor } = makeEditor()
  doc.putPage({ id: 'page:q', name: 'Q' })
  doc.putShape(shape('shape:page-p-high', { index: generateKeyBetween('a5', null) })) // on page:p, high index
  doc.putShape(shape('shape:source', { index: 'a1' }))
  doc.commit()
  editor.apply({ type: 'SetSelection', ids: ['shape:source'] })
  editor.apply({ type: 'SetCurrentPage', pageId: 'page:q' })

  const intents = duplicateSelectionIntents(editor)
  const created = (intents.find((i) => i.type === 'CreateShape') as { shape: Shape }).shape
  assert.equal(created.parentId, 'page:q', 'duplicate lands on page:q')
  assert.ok(created.index < 'a5', `top-of-stack index (${created.index}) is computed against page:q's (empty) siblings, not page:p's unrelated high index`)
  console.log('ok: E2b — max-sibling scan reads the CURRENT page, not editor.pageId')
}

console.log('\nall clipboard-intents assertions passed')
