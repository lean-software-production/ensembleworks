// Run: bun src/clipboard-intents.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import { encodeClipboard, serializeSelection, type Binding, type Shape } from '@ensembleworks/canvas-model'
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

console.log('\nall clipboard-intents assertions passed')
