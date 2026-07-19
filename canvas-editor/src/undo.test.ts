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

// ============================================================================
// 10. REGRESSION (Critical 1): undo()'s replay must be TOLERANT — an inverse
//     that has become un-appliable due to concurrent remote churn is SKIPPED,
//     never thrown. Repro: local reparents X from A->B (its undo op is
//     putShape(X, parentId:A)); a remote peer then reparents A UNDER X and
//     ships it back; now replaying X-back-under-A would close a cycle
//     (A under X, X under A), which Loro's native cycle guard throws on
//     inside putShape. Pre-fix, that throw escaped undo() uncaught.
// ============================================================================
{
  const { doc: localDoc, editor: local } = makeEditor(1n)
  local.apply({ type: 'CreateShape', shape: shape('shape:A', { kind: 'frame' }) })
  local.apply({ type: 'CreateShape', shape: shape('shape:B', { kind: 'frame' }) })
  local.apply({ type: 'CreateShape', shape: shape('shape:X', { parentId: 'shape:A' }) })

  // A second peer is synced to this exact initial state.
  const remoteDoc = LoroCanvasDoc.create({ peerId: 2n })
  remoteDoc.import(localDoc.exportSnapshot())

  // Local reparents X from A to B (undo op captured = putShape(X, parentId:A)).
  local.apply({ type: 'ReparentShapes', ids: ['shape:X'], parentId: 'shape:B' })
  assert.equal(localDoc.getShape('shape:X')!.parentId, 'shape:B')

  // Remote sees the local reparent (A now empty, X under B), THEN reparents A
  // under X — legal in remote's converged view (A is not an ancestor of X
  // there) — and ships it back to local.
  remoteDoc.import(localDoc.exportUpdate())
  remoteDoc.commit()
  remoteDoc.reparent('shape:A', 'shape:X')
  remoteDoc.commit()
  const imported = localDoc.import(remoteDoc.exportUpdate())
  localDoc.commit()
  assert.ok(imported.changed, 'sanity: remote reparent applied to the local doc')
  assert.equal(localDoc.getShape('shape:A')!.parentId, 'shape:X', 'sanity: A is now under X (the cycle-inducing setup)')

  // Undoing the local reparent would set X.parentId=A, but A is now a
  // descendant of X → un-appliable. Tolerant replay must skip it, not throw.
  assert.doesNotThrow(() => local.undo(), 'undo() tolerates an un-appliable inverse (cycle from concurrent remote churn) instead of throwing')
  // The un-appliable op was skipped: X stays where it was (under B), and A is
  // untouched — no partial/corrupt application.
  assert.equal(localDoc.getShape('shape:X')!.parentId, 'shape:B', 'the skipped inverse left X unchanged')
  assert.equal(localDoc.getShape('shape:A')!.parentId, 'shape:X', 'A untouched by the skipped inverse')

  console.log('ok: undo() replay is tolerant — an un-appliable inverse is skipped, never thrown (Critical 1)')
}

// ============================================================================
// 11. REGRESSION (Critical 2): multi-id cascade-delete undo must recreate
//     PARENTS BEFORE CHILDREN across ids, even when ids arrive child-first
//     (user multi-select order is not depth-sorted). The teeth: after undo,
//     re-deleting the frame must CASCADE the child away — proving the child
//     came back PHYSICALLY parented to the frame, not merely data-parented
//     but detached to root (the split-brain the bug produced).
// ============================================================================
{
  const { editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:frame', { kind: 'frame', x: 0, y: 0 }) })
  editor.apply({ type: 'CreateShape', shape: shape('shape:child', { parentId: 'shape:frame', x: 5, y: 5 }) })

  // Child listed BEFORE the frame — the exact ordering that broke pre-fix.
  editor.apply({ type: 'DeleteShapes', ids: ['shape:child', 'shape:frame'] })
  assert.equal(editor.doc.getShape('shape:frame'), undefined, 'frame deleted')
  assert.equal(editor.doc.getShape('shape:child'), undefined, 'child cascaded away')

  editor.undo()
  const frame = editor.doc.getShape('shape:frame')
  const child = editor.doc.getShape('shape:child')
  assert.ok(frame, 'undo restores the frame')
  assert.ok(child, 'undo restores the child')
  assert.equal(child!.parentId, 'shape:frame', 'child parentId DATA restored')

  // THE TEETH: delete the frame alone. If the child were physically detached
  // to root (data-parented only), this cascade would NOT touch it. It must.
  editor.apply({ type: 'DeleteShapes', ids: ['shape:frame'] })
  assert.equal(editor.doc.getShape('shape:frame'), undefined, 're-delete removes the frame')
  assert.equal(
    editor.doc.getShape('shape:child'),
    undefined,
    'child CASCADES away on re-delete → it was PHYSICALLY parented to the frame, not orphaned to root',
  )

  console.log('ok: multi-id cascade-delete undo restores child PHYSICALLY under frame, child-before-frame order (Critical 2)')
}

// ============================================================================
// 12. Inverse coverage: RotateShapes undo/redo round-trip (orbit + spin).
// ============================================================================
{
  const { editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:a', { x: 10, y: 0, rotation: 0 }) })
  editor.apply({ type: 'RotateShapes', ids: ['shape:a'], center: { x: 0, y: 0 }, dRadians: Math.PI / 2 })
  const rotated = editor.doc.getShape('shape:a')!
  // Orbit (10,0) about the origin by +90° -> (0,10); rotation field spins to π/2.
  assert.ok(Math.abs(rotated.x - 0) < 1e-9, 'rotate orbits x')
  assert.ok(Math.abs(rotated.y - 10) < 1e-9, 'rotate orbits y')
  assert.ok(Math.abs(rotated.rotation - Math.PI / 2) < 1e-9, 'rotate spins the rotation field')

  editor.undo()
  const u = editor.doc.getShape('shape:a')!
  assert.ok(Math.abs(u.x - 10) < 1e-9, 'undo restores x')
  assert.ok(Math.abs(u.y - 0) < 1e-9, 'undo restores y')
  assert.equal(u.rotation, 0, 'undo restores the rotation field exactly')

  editor.redo()
  const r = editor.doc.getShape('shape:a')!
  assert.ok(Math.abs(r.y - 10) < 1e-9, 'redo re-orbits')
  assert.ok(Math.abs(r.rotation - Math.PI / 2) < 1e-9, 'redo re-spins')

  console.log('ok: undo/redo RotateShapes')
}

// ============================================================================
// 13. Inverse coverage: ReparentShapes undo/redo round-trip — and the undo
//     restores the PHYSICAL parent (putShape's placeInTree), proven by cascade.
// ============================================================================
{
  const { editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:f1', { kind: 'frame' }) })
  editor.apply({ type: 'CreateShape', shape: shape('shape:f2', { kind: 'frame' }) })
  editor.apply({ type: 'CreateShape', shape: shape('shape:x', { parentId: 'shape:f1' }) })

  editor.apply({ type: 'ReparentShapes', ids: ['shape:x'], parentId: 'shape:f2' })
  assert.equal(editor.doc.getShape('shape:x')!.parentId, 'shape:f2', 'reparent moved x under f2')

  editor.undo()
  assert.equal(editor.doc.getShape('shape:x')!.parentId, 'shape:f1', 'undo restores x under f1')

  editor.redo()
  assert.equal(editor.doc.getShape('shape:x')!.parentId, 'shape:f2', 'redo re-applies the reparent')

  // Undo once more, then prove the restore is PHYSICAL: deleting f2 must NOT
  // take x (x is under f1), but deleting f1 must cascade it away.
  editor.undo()
  assert.equal(editor.doc.getShape('shape:x')!.parentId, 'shape:f1')
  editor.apply({ type: 'DeleteShapes', ids: ['shape:f2'] })
  assert.ok(editor.doc.getShape('shape:x'), 'deleting f2 leaves x alone — x is physically under f1, not f2')
  editor.apply({ type: 'DeleteShapes', ids: ['shape:f1'] })
  assert.equal(editor.doc.getShape('shape:x'), undefined, 'deleting f1 cascades x away — undo restored the PHYSICAL parent')

  console.log('ok: undo/redo ReparentShapes (physical parent restored)')
}

// ============================================================================
// 14. Inverse coverage: StartArrow undo/redo round-trip — the arrow shape AND
//     its start-endpoint binding are removed on undo, recreated on redo.
// ============================================================================
{
  const { editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:target', { x: 100, y: 100, kind: 'geo', props: { w: 50, h: 50 } }) })
  editor.apply({
    type: 'StartArrow',
    shape: shape('shape:arrow', { kind: 'arrow', x: 0, y: 0 }),
    fromBinding: { targetId: 'shape:target', anchor: { nx: 0, ny: 0 } },
  })
  const hasStartBinding = () => editor.doc.listBindings().some((b) => b.id === 'binding:shape:arrow-start')
  assert.ok(editor.doc.getShape('shape:arrow'), 'arrow created')
  assert.ok(hasStartBinding(), 'start binding created')

  editor.undo()
  assert.equal(editor.doc.getShape('shape:arrow'), undefined, 'undo removes the arrow shape')
  assert.equal(hasStartBinding(), false, 'undo removes the start binding')

  editor.redo()
  assert.ok(editor.doc.getShape('shape:arrow'), 'redo recreates the arrow shape')
  assert.ok(hasStartBinding(), 'redo recreates the start binding')

  console.log('ok: undo/redo StartArrow (arrow shape + start binding)')
}

// ============================================================================
// 15. Inverse coverage: CompleteArrow undo/redo round-trip — the end prop AND
//     the end-endpoint binding are reverted on undo, reapplied on redo.
// ============================================================================
{
  const { editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:target', { x: 100, y: 100, kind: 'geo', props: { w: 50, h: 50 } }) })
  editor.apply({ type: 'StartArrow', shape: shape('shape:arrow', { kind: 'arrow', x: 0, y: 0 }) })
  editor.apply({
    type: 'CompleteArrow',
    id: 'shape:arrow',
    end: { x: 10, y: 20 }, // world; arrow x/y=(0,0) so local end offset is (10,20)
    toBinding: { targetId: 'shape:target', anchor: { nx: 1, ny: 1 } },
  })
  const hasEndBinding = () => editor.doc.listBindings().some((b) => b.id === 'binding:shape:arrow-end')
  assert.deepEqual((editor.doc.getShape('shape:arrow')!.props as any).end, { x: 10, y: 20 }, 'end prop set')
  assert.ok(hasEndBinding(), 'end binding created')

  editor.undo()
  assert.equal((editor.doc.getShape('shape:arrow')!.props as any).end, undefined, 'undo reverts the end prop (arrow was created with empty props)')
  assert.equal(hasEndBinding(), false, 'undo removes the end binding')
  assert.ok(editor.doc.getShape('shape:arrow'), 'the arrow shape itself survives — CompleteArrow only added end/binding, StartArrow made the shape')

  editor.redo()
  assert.deepEqual((editor.doc.getShape('shape:arrow')!.props as any).end, { x: 10, y: 20 }, 'redo re-applies the end prop')
  assert.ok(hasEndBinding(), 'redo re-applies the end binding')

  console.log('ok: undo/redo CompleteArrow (end prop + end binding)')
}

// ============================================================================
// 16. Inverse coverage (Task D1): UpdateProps undo/redo round-trip — undo
//     restores the FULL pre-mutation props map (the shallow-merge is only
//     forward; the inverse is the documented full-shape-inverse convention,
//     same as Resize/Rotate/Reparent/CompleteArrow above — putShape(shape)
//     restores everything, not just the touched keys), redo re-applies the
//     merged result. A no-op UpdateProps (unknown id, docMutated:false) must
//     NOT push an undo-stack entry — proven via canUndo()/stack-depth: if it
//     pushed a no-op {undo:[],redo:[]} entry, undo() would silently consume
//     a stack slot without restoring anything (the B1 corruption class this
//     unit's plan calls out).
// ============================================================================
{
  const { editor } = makeEditor(1n)
  editor.apply({ type: 'CreateShape', shape: shape('shape:a', { props: { title: 'orig', kept: 'stays' } }) })
  editor.apply({ type: 'UpdateProps', id: 'shape:a', props: { title: 'new' } })
  assert.deepEqual(editor.doc.getShape('shape:a')!.props, { title: 'new', kept: 'stays' }, 'UpdateProps applied the shallow merge')

  editor.undo()
  assert.deepEqual(editor.doc.getShape('shape:a')!.props, { title: 'orig', kept: 'stays' }, 'undo of UpdateProps restores the full prior props map')

  editor.redo()
  assert.deepEqual(editor.doc.getShape('shape:a')!.props, { title: 'new', kept: 'stays' }, 'redo of UpdateProps re-applies the merge')

  // A no-op UpdateProps (unknown id) must not occupy an undo-stack slot: the
  // stack depth right after it must be UNCHANGED from right before it, and
  // the next undo() must still unwind the LAST real mutation (the redo above),
  // not silently consume a phantom {undo:[],redo:[]} entry.
  const undoableBefore = editor.canUndo()
  editor.apply({ type: 'UpdateProps', id: 'shape:missing', props: { title: 'z' } })
  assert.equal(editor.canUndo(), undoableBefore, 'a no-op UpdateProps (unknown id) does not push an undo entry')

  editor.undo() // must unwind the UpdateProps('new') above, not a phantom no-op entry
  assert.deepEqual(editor.doc.getShape('shape:a')!.props, { title: 'orig', kept: 'stays' }, 'the next undo still unwinds the real UpdateProps, proving no phantom entry was pushed')

  console.log('ok: undo/redo UpdateProps (full props map restored; no-op does not occupy an undo-stack slot)')
}
