// Run: bun src/page-intents.test.ts
// Task E3 (docs/plans/2026-07-22-canvas-v2-pages.md, D-3): the four page
// MUTATION intents — CreatePage/DeletePage/RenamePage/ReorderPage — plus
// DeletePage's shape-subtree cascade and its undo (the crux: putPage FIRST,
// then shapes parent-before-child).
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import type { Shape } from '@ensembleworks/canvas-model'
import { Editor } from './editor.js'

const FIXED_NOW = () => 1_700_000_000_000
const FIXED_RANDOM = () => 0.5

const shape = (id: string, over: Partial<Shape> = {}): Shape => ({
  id, kind: 'note', parentId: 'page:p', index: 'a1',
  x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: {}, ...over,
} as Shape)

// Seed: page:p carries a frame + a child parented to the frame + a loose
// note parented directly to the page; page:q is empty. Mirrors the plan's
// Step 1 seed exactly.
function makeEditor(): { doc: LoroCanvasDoc; editor: Editor } {
  const doc = LoroCanvasDoc.create({ peerId: 1n })
  doc.putPage({ id: 'page:p', name: 'P' })
  doc.putPage({ id: 'page:q', name: 'Q' })
  doc.commit()
  const editor = new Editor({ doc, now: FIXED_NOW, random: FIXED_RANDOM, pageId: 'page:p' })
  editor.apply({ type: 'CreateShape', shape: shape('shape:frame', { kind: 'frame', parentId: 'page:p' }) })
  editor.apply({ type: 'CreateShape', shape: shape('shape:child', { parentId: 'shape:frame' }) })
  editor.apply({ type: 'CreateShape', shape: shape('shape:note', { parentId: 'page:p' }) })
  return { doc, editor }
}

// ============================================================================
// 1. CreatePage: the page exists after apply, with the given index; undo
//    removes it; redo restores it.
// ============================================================================
{
  const { doc, editor } = makeEditor()
  editor.apply({ type: 'CreatePage', page: { id: 'page:r', name: 'R', index: 'a5' } })
  const pages = doc.listPages()
  const created = pages.find((p) => p.id === 'page:r')
  assert.ok(created, 'CreatePage adds the page to listPages()')
  assert.equal(created!.index, 'a5', 'CreatePage preserves the given index')
  assert.equal(created!.name, 'R', 'CreatePage preserves the given name')

  editor.undo()
  assert.equal(doc.listPages().find((p) => p.id === 'page:r'), undefined, 'undo removes the created page')

  editor.redo()
  const redone = doc.listPages().find((p) => p.id === 'page:r')
  assert.ok(redone, 'redo restores the created page')
  assert.equal(redone!.index, 'a5', 'redo restores the page verbatim (index intact)')

  console.log('ok: CreatePage + undo/redo round-trip')
}

// ============================================================================
// 2. DeletePage cascade: deleting page:p removes the page AND every shape on
//    it (frame, child, note); page:q's shapes (none) are untouched.
// ============================================================================
{
  const { doc, editor } = makeEditor()
  editor.apply({ type: 'DeletePage', id: 'page:p' })

  assert.equal(doc.listPages().find((p) => p.id === 'page:p'), undefined, 'DeletePage removes the page record')
  assert.equal(doc.getShape('shape:frame'), undefined, 'DeletePage cascades: frame gone')
  assert.equal(doc.getShape('shape:child'), undefined, 'DeletePage cascades: child gone')
  assert.equal(doc.getShape('shape:note'), undefined, 'DeletePage cascades: loose note gone')
  assert.ok(doc.listPages().find((p) => p.id === 'page:q'), 'page:q survives')

  console.log('ok: DeletePage cascades the whole shape subtree')
}

// ============================================================================
// 3. DeletePage undo restores page + shapes, parent-before-child (the crux).
//    redo re-deletes both.
// ============================================================================
{
  const { doc, editor } = makeEditor()
  editor.apply({ type: 'DeletePage', id: 'page:p' })
  assert.equal(doc.getShape('shape:child'), undefined, 'precondition: cascaded away')

  editor.undo()
  const restoredPage = doc.listPages().find((p) => p.id === 'page:p')
  assert.ok(restoredPage, 'undo restores the page record')
  assert.equal(restoredPage!.name, 'P', 'restored page has its original name')

  const frame = doc.getShape('shape:frame')
  const child = doc.getShape('shape:child')
  const note = doc.getShape('shape:note')
  assert.ok(frame, 'undo restores the frame')
  assert.ok(child, 'undo restores the child')
  assert.ok(note, 'undo restores the loose note')
  assert.equal(frame!.parentId, 'page:p', 'frame is restored parented to the page')
  assert.equal(child!.parentId, 'shape:frame', 'child is restored PHYSICALLY under the frame, not detached to root')
  assert.equal(note!.parentId, 'page:p', 'note is restored parented to the page')

  editor.redo()
  assert.equal(doc.listPages().find((p) => p.id === 'page:p'), undefined, 'redo re-deletes the page')
  assert.equal(doc.getShape('shape:frame'), undefined, 'redo re-deletes the frame')
  assert.equal(doc.getShape('shape:child'), undefined, 'redo re-deletes the child (cascade again)')
  assert.equal(doc.getShape('shape:note'), undefined, 'redo re-deletes the note')

  console.log('ok: DeletePage undo restores page + shapes parent-before-child; redo re-deletes both')
}

// ============================================================================
// 4. DeletePage refuses the last page: with only ONE page, DeletePage is a
//    total no-op — page + shapes untouched, canUndo() unchanged.
// ============================================================================
{
  const doc = LoroCanvasDoc.create({ peerId: 1n })
  doc.putPage({ id: 'page:only', name: 'Only' })
  // Seed the shape directly through the doc (bypassing the editor), so the
  // editor's undo stack starts genuinely EMPTY — canUndo() === false is
  // then a discriminating check below (an editor.apply(CreateShape) here
  // would already leave canUndo() true, making the post-DeletePage
  // comparison trivially pass no matter what DeletePage does).
  doc.putShape(shape('shape:s', { parentId: 'page:only' }))
  doc.commit()
  const editor = new Editor({ doc, now: FIXED_NOW, random: FIXED_RANDOM, pageId: 'page:only' })
  assert.equal(editor.canUndo(), false, 'precondition: nothing to undo yet')

  editor.apply({ type: 'DeletePage', id: 'page:only' })

  assert.ok(doc.listPages().find((p) => p.id === 'page:only'), 'the last page survives DeletePage')
  assert.ok(doc.getShape('shape:s'), 'the last page\'s shape survives DeletePage')
  assert.equal(editor.canUndo(), false, 'refusing the last page pushes no undo entry')

  console.log('ok: DeletePage refuses to delete the last page')
}

// ============================================================================
// 5. RenamePage: name changes; index and passthrough fields survive; undo
//    restores the old name.
// ============================================================================
{
  const { doc, editor } = makeEditor()
  doc.putPage({ id: 'page:p', name: 'P', index: 'a1', extra: 'keep-me' } as any)
  doc.commit()

  editor.apply({ type: 'RenamePage', id: 'page:p', name: 'Renamed' })
  const renamed = doc.listPages().find((p) => p.id === 'page:p') as any
  assert.equal(renamed.name, 'Renamed', 'RenamePage changes the name')
  assert.equal(renamed.index, 'a1', 'RenamePage preserves index')
  assert.equal(renamed.extra, 'keep-me', 'RenamePage preserves passthrough fields')

  editor.undo()
  const restored = doc.listPages().find((p) => p.id === 'page:p') as any
  assert.equal(restored.name, 'P', 'undo restores the old name')

  console.log('ok: RenamePage preserves other fields; undo restores old name')
}

// ============================================================================
// 6. ReorderPage: index changes; no-op when the new index equals the
//    current one (no undo entry emitted); undo restores the old index.
// ============================================================================
// Own scratch doc/editor (not makeEditor()'s, whose three CreateShape calls
// already leave canUndo() true) — the no-op check below needs a genuinely
// EMPTY undo stack to be discriminating (see the last-page-refusal test's
// comment for why comparing against an already-true canUndo() is a no-op
// assertion).
{
  const doc = LoroCanvasDoc.create({ peerId: 1n })
  doc.putPage({ id: 'page:p', name: 'P', index: 'a1' })
  doc.commit()
  const editor = new Editor({ doc, now: FIXED_NOW, random: FIXED_RANDOM, pageId: 'page:p' })

  assert.equal(editor.canUndo(), false, 'precondition: nothing to undo yet')
  editor.apply({ type: 'ReorderPage', id: 'page:p', index: 'a1' })
  assert.equal(editor.canUndo(), false, 'ReorderPage to the SAME index is a no-op, pushes no undo entry')
  assert.equal(doc.listPages().find((p) => p.id === 'page:p')!.index, 'a1', 'no-op leaves the index untouched')

  editor.apply({ type: 'ReorderPage', id: 'page:p', index: 'a9' })
  assert.equal(doc.listPages().find((p) => p.id === 'page:p')!.index, 'a9', 'ReorderPage changes the index')

  editor.undo()
  assert.equal(doc.listPages().find((p) => p.id === 'page:p')!.index, 'a1', 'undo restores the old index')

  console.log('ok: ReorderPage changes index, no-ops on unchanged index (canUndo() stays false — discriminating), undo restores old index')
}

// ============================================================================
// 7. Unknown id: DeletePage/RenamePage/ReorderPage on an absent id are
//    silent no-ops, never throw.
// ============================================================================
{
  const { doc, editor } = makeEditor()
  const pagesBefore = doc.listPages().length
  const shapesBefore = doc.listShapes().length

  assert.doesNotThrow(() => editor.apply({ type: 'DeletePage', id: 'page:ghost' }))
  assert.doesNotThrow(() => editor.apply({ type: 'RenamePage', id: 'page:ghost', name: 'X' }))
  assert.doesNotThrow(() => editor.apply({ type: 'ReorderPage', id: 'page:ghost', index: 'a1' }))

  assert.equal(doc.listPages().length, pagesBefore, 'unknown-id ops never change page count')
  assert.equal(doc.listShapes().length, shapesBefore, 'unknown-id ops never touch shapes')

  console.log('ok: DeletePage/RenamePage/ReorderPage on an unknown id are silent no-ops')
}

console.log('\nall page-intents assertions passed')
