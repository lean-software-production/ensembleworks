// Run: bun src/undo.test.ts
// Task B1: local undo/redo stack. Proves the inverse-intent design (see
// editor.ts's InverseOp/UndoEntry doc comments and the BINDING MECHANISM
// DECISION in the B1 plan): undo/redo replay ONLY through CanvasDoc's public
// mutators (putShape/deleteShape/setText/putBinding/deleteBinding) — never a
// raw Loro tree op, never loro-crdt's UndoManager — so LoroCanvasDoc's
// private id→node index stays exactly as correct as it is after any live
// intent. Per bounds DoD #4: undo AND redo of create/move/resize/delete/
// text-edit, the cascade-delete-with-children correctness trap, and the
// local-only proof (a remote peer's shapes are never captured onto this
// peer's undo stack, so undo() can never touch them).
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import type { Shape } from '@ensembleworks/canvas-model'
import { Editor } from './editor.js'

const FIXED_NOW = () => 1_700_000_000_000
const FIXED_RANDOM = () => 0.5

function makeEditor(peerId: bigint): { doc: LoroCanvasDoc; editor: Editor } {
  const doc = LoroCanvasDoc.create({ peerId })
  doc.putPage({ id: 'page:p', name: 'P' })
  doc.commit()
  const editor = new Editor({ doc, now: FIXED_NOW, random: FIXED_RANDOM, pageId: 'page:p' })
  return { doc, editor }
}

// NB: this trailing semicolon is REQUIRED, unlike editor.test.ts's identical
// helper — a bare `{ ... }` test block directly below with no separator is
// an ASI hazard TS's parser resolves by treating the block as a continuation
// of this statement (probe-confirmed: reproduces standalone, fixed by this
// semicolon or by an intervening non-block statement — editor.test.ts's
// copy of this helper happens to have one before its first bare block).
const shape = (id: string, over: Partial<Shape> = {}): Shape => ({
  id, kind: 'note', parentId: 'page:p', index: 'a1',
  x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: {}, ...over,
} as Shape);

// ============================================================================
// 1. Create: undo removes the shape, redo brings it back verbatim.
// ============================================================================
{
  const { editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:a', { x: 10, y: 20 }) })
  assert.ok(editor.doc.getShape('shape:a'), 'shape exists right after create')

  editor.undo()
  assert.equal(editor.doc.getShape('shape:a'), undefined, 'undo of CreateShape deletes the shape')

  editor.redo()
  const s = editor.doc.getShape('shape:a')
  assert.ok(s, 'redo of CreateShape recreates the shape')
  assert.equal(s!.x, 10)
  assert.equal(s!.y, 20)

  console.log('ok: undo/redo CreateShape')
}

// ============================================================================
// 2. Move (TranslateShapes): undo restores the prior position, redo re-moves it.
// ============================================================================
{
  const { editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:a', { x: 10, y: 20 }) })
  editor.apply({ type: 'TranslateShapes', ids: ['shape:a'], dx: 5, dy: -5 })
  assert.equal(editor.doc.getShape('shape:a')!.x, 15)
  assert.equal(editor.doc.getShape('shape:a')!.y, 15)

  editor.undo()
  assert.equal(editor.doc.getShape('shape:a')!.x, 10, 'undo of TranslateShapes restores prior x')
  assert.equal(editor.doc.getShape('shape:a')!.y, 20, 'undo of TranslateShapes restores prior y')

  editor.redo()
  assert.equal(editor.doc.getShape('shape:a')!.x, 15, 'redo of TranslateShapes re-applies the move')
  assert.equal(editor.doc.getShape('shape:a')!.y, 15)

  console.log('ok: undo/redo TranslateShapes')
}

// ============================================================================
// 3. Resize (ResizeShapes): undo restores prior x/y/w/h, redo re-scales.
// ============================================================================
{
  const { editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:box', { x: 20, y: 20, kind: 'geo', props: { w: 100, h: 50 } }) })
  editor.apply({ type: 'ResizeShapes', ids: ['shape:box'], anchor: { x: 20, y: 20 }, scaleX: 2, scaleY: 3 })
  const resized = editor.doc.getShape('shape:box')!
  assert.equal((resized.props as any).w, 200)
  assert.equal((resized.props as any).h, 150)

  editor.undo()
  const undone = editor.doc.getShape('shape:box')!
  assert.equal(undone.x, 20, 'undo of ResizeShapes restores prior x')
  assert.equal(undone.y, 20, 'undo of ResizeShapes restores prior y')
  assert.equal((undone.props as any).w, 100, 'undo of ResizeShapes restores prior w')
  assert.equal((undone.props as any).h, 50, 'undo of ResizeShapes restores prior h')

  editor.redo()
  const redone = editor.doc.getShape('shape:box')!
  assert.equal((redone.props as any).w, 200, 'redo of ResizeShapes re-applies the scale')
  assert.equal((redone.props as any).h, 150)

  console.log('ok: undo/redo ResizeShapes')
}

// ============================================================================
// 4. Delete (DeleteShapes), no children: undo recreates the shape verbatim,
//    redo deletes it again.
// ============================================================================
{
  const { editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:a', { x: 1, y: 2, props: { note: 'hi' } }) })
  editor.apply({ type: 'DeleteShapes', ids: ['shape:a'] })
  assert.equal(editor.doc.getShape('shape:a'), undefined)

  editor.undo()
  const restored = editor.doc.getShape('shape:a')
  assert.ok(restored, 'undo of DeleteShapes recreates the shape')
  assert.equal(restored!.x, 1)
  assert.equal(restored!.y, 2)
  assert.deepEqual(restored!.props, { note: 'hi' })

  editor.redo()
  assert.equal(editor.doc.getShape('shape:a'), undefined, 'redo of DeleteShapes deletes it again')

  console.log('ok: undo/redo DeleteShapes (no children)')
}

// ============================================================================
// 5. Text edit (SetText): undo restores prior text, redo re-applies the new text.
// ============================================================================
{
  const { editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:a') })
  editor.apply({ type: 'SetText', id: 'shape:a', text: 'first' })
  assert.equal(editor.doc.getText('shape:a'), 'first')

  editor.apply({ type: 'SetText', id: 'shape:a', text: 'second' })
  assert.equal(editor.doc.getText('shape:a'), 'second')

  editor.undo()
  assert.equal(editor.doc.getText('shape:a'), 'first', 'undo of SetText restores the prior text')

  editor.redo()
  assert.equal(editor.doc.getText('shape:a'), 'second', 'redo of SetText re-applies the new text')

  // Undo past both SetText edits (3 undoable steps total: CreateShape,
  // SetText('first'), SetText('second')) reaches all the way back to the
  // shape not existing at all.
  editor.undo() // back to 'first'
  assert.equal(editor.doc.getText('shape:a'), 'first')
  editor.undo() // back to '' (the pre-image captured before SetText('first'))
  assert.equal(editor.doc.getText('shape:a'), '')
  editor.undo() // undoes CreateShape itself
  assert.equal(editor.doc.getShape('shape:a'), undefined, 'undoing three steps back removes the shape entirely')

  console.log('ok: undo/redo SetText')
}

// ============================================================================
// 6. CORRECTNESS TRAP: DeleteShapes cascades to the whole subtree (see
//    CanvasDoc.deleteShape's contract) — deleting a frame with a child must
//    undo back to BOTH shapes present, with the child still parented to the
//    frame (not resurrected as a root-level orphan).
// ============================================================================
{
  const { editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:frame', { kind: 'frame', x: 0, y: 0 }) })
  editor.apply({ type: 'CreateShape', shape: shape('shape:child', { parentId: 'shape:frame', x: 5, y: 5 }) })
  assert.equal(editor.doc.getShape('shape:child')!.parentId, 'shape:frame')

  editor.apply({ type: 'DeleteShapes', ids: ['shape:frame'] })
  assert.equal(editor.doc.getShape('shape:frame'), undefined, 'frame gone')
  assert.equal(editor.doc.getShape('shape:child'), undefined, 'cascade: child gone too')

  editor.undo()
  const frame = editor.doc.getShape('shape:frame')
  const child = editor.doc.getShape('shape:child')
  assert.ok(frame, 'undo of a cascading delete restores the frame')
  assert.ok(child, 'undo of a cascading delete restores the child')
  assert.equal(child!.parentId, 'shape:frame', 'the child is restored PARENTED TO THE FRAME, not orphaned to root')
  assert.equal(child!.x, 5)
  assert.equal(child!.y, 5)

  // Redo re-deletes the whole subtree again.
  editor.redo()
  assert.equal(editor.doc.getShape('shape:frame'), undefined, 'redo re-deletes the frame')
  assert.equal(editor.doc.getShape('shape:child'), undefined, 'redo re-deletes the child too (cascade again)')

  console.log('ok: undo/redo DeleteShapes cascade (frame + child subtree restored intact)')
}

// ============================================================================
// 7. LOCAL-ONLY PROOF: a local create, then a REMOTE peer's update creating a
//    second shape (imported via doc.import — never through this editor's own
//    apply/applyAll), then undo() — must remove ONLY the local shape. This is
//    the scope guarantee the whole design buys "for free": entries are only
//    ever pushed by THIS editor's own applyAll calls, never by import().
// ============================================================================
{
  const { doc: localDoc, editor: local } = makeEditor(1n)
  local.apply({ type: 'CreateShape', shape: shape('shape:local', { x: 1, y: 1 }) })

  // A second peer creates an independent shape and ships it to the local doc
  // via import() — the exact path a real sync transport uses, and NOT
  // through `local`'s apply()/applyAll(), so it must never touch `local`'s
  // undo stack.
  const remoteDoc = LoroCanvasDoc.create({ peerId: 2n })
  remoteDoc.import(localDoc.exportSnapshot())
  remoteDoc.putShape(shape('shape:remote', { x: 9, y: 9 }))
  remoteDoc.commit()
  const importResult = localDoc.import(remoteDoc.exportUpdate())
  localDoc.commit()
  assert.ok(importResult.changed, 'sanity: the remote update actually applied')

  assert.ok(localDoc.getShape('shape:local'), 'sanity: local shape present before undo')
  assert.ok(localDoc.getShape('shape:remote'), 'sanity: remote shape present before undo')

  local.undo()

  assert.equal(localDoc.getShape('shape:local'), undefined, 'undo() removes ONLY the local peer\'s own create')
  assert.ok(localDoc.getShape('shape:remote'), 'the remote peer\'s shape is UNTOUCHED by local undo — never on this peer\'s stack')

  console.log('ok: undo() is local-peer-only — a remote import is never captured onto this editor\'s undo stack')
}

// ============================================================================
// 8. Housekeeping: undo()/redo() are no-ops on empty stacks; a new user
//    mutation after an undo clears the redo stack (standard semantics).
// ============================================================================
{
  const { editor } = makeEditor(1n)
  assert.equal(editor.canUndo(), false, 'nothing to undo yet')
  assert.equal(editor.canRedo(), false, 'nothing to redo yet')
  editor.undo() // no-op, must not throw
  editor.redo() // no-op, must not throw

  editor.apply({ type: 'CreateShape', shape: shape('shape:a') })
  assert.equal(editor.canUndo(), true)
  editor.undo()
  assert.equal(editor.canRedo(), true, 'redo is available right after an undo')

  editor.apply({ type: 'CreateShape', shape: shape('shape:b') })
  assert.equal(editor.canRedo(), false, 'a new mutation after undo() clears the redo stack')
  assert.ok(editor.doc.getShape('shape:b'), 'the new mutation itself did apply')
  assert.equal(editor.doc.getShape('shape:a'), undefined, 'the undone shape:a stays undone (was not resurrected by the redo-stack clear)')

  console.log('ok: undo/redo housekeeping (empty-stack no-ops, redo stack cleared by a new mutation)')
}

// ============================================================================
// 9. View-only intents never land on the undo stack — undo()/redo() are
//    unaffected by camera/selection/hover/edit changes interleaved with
//    doc mutations.
// ============================================================================
{
  const { editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:a', { x: 0, y: 0 }) })
  editor.apply({ type: 'SetCamera', x: 100, y: 100, z: 2 })
  editor.apply({ type: 'SetSelection', ids: ['shape:a'] })
  editor.apply({ type: 'TranslateShapes', ids: ['shape:a'], dx: 3, dy: 3 })

  // Two doc mutations happened (create, translate); the two view intents in
  // between must not have produced their own undo entries.
  editor.undo() // undoes the translate
  assert.equal(editor.doc.getShape('shape:a')!.x, 0, 'first undo unwinds the translate, skipping past the view intents entirely')
  editor.undo() // undoes the create
  assert.equal(editor.doc.getShape('shape:a'), undefined, 'second undo unwinds the create — exactly 2 undoable steps for 4 applied intents')
  assert.equal(editor.canUndo(), false, 'no further undo steps: the 2 view intents never pushed entries of their own')

  // Camera/selection state is untouched by undo() (it only replays doc ops).
  assert.deepEqual(editor.get().camera, { x: 100, y: 100, z: 2 })
  assert.deepEqual([...editor.get().selection], ['shape:a'])

  console.log('ok: view-only intents never occupy an undo-stack slot')
}
