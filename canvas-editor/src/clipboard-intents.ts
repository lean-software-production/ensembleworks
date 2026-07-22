// Pure emitter helpers over the clipboard model (canvas-model/src/
// clipboard.ts's serializeSelection/decodeClipboard/cloneWithNewIds) — one
// batch of EXISTING intents each, mirroring the landed
// `deleteSelectionIntents` precedent (client/src/canvas-v2/tool-loop.ts):
// no new mutation machinery, just CreateShape x N + PutBinding x M (E2,
// validated by bindingSchema) + one SetSelection(newRootIds). The caller
// (client's Ctrl+D/Ctrl+V wiring, Task D1) applies the returned array through
// a single `editor.applyAll(...)` call, which is what makes the whole
// duplicate/paste ONE commit / ONE undo entry (see editor.ts's applyAll doc
// comment) — this module never calls applyAll itself.
//
// D-3's id-mint scheme, implemented here (not in canvas-model, which never
// touches a PRNG): `editor.random()` is drawn ONCE per node, folded with
// that node's batch index `i`/`j` as a hard uniqueness salt. The salt is
// what keeps N minted ids distinct within a single call even when the
// injected `random` is a CONSTANT stream (paste/duplicate have no pointer
// event to salt from, unlike the create tool's `makeId` — see D-3 and
// cloneWithNewIds's own doc comment for why a shared mint/mintBinding
// stream would be wrong). Cross-session uniqueness under colliding entropy
// is UNGUARANTEED — the same documented precondition create.ts's makeId
// carries, deferred to the same real-entropy follow-up (G3).
import { cloneWithNewIds, decodeClipboard, serializeSelection, type Binding, type Shape } from '@ensembleworks/canvas-model'
import type { Editor } from './editor.js'
import type { Intent } from './intents.js'

export const DUP_OFFSET = 20

function mintShapeId(editor: Editor, i: number): string {
  return `shape:${Math.floor(editor.random() * 1e9).toString(36)}-${i}`
}

function mintBindingId(editor: Editor, j: number): string {
  return `binding:${Math.floor(editor.random() * 1e9).toString(36)}-${j}`
}

// Turns a {shapes,bindings,rootIds} clone (cloneWithNewIds's output) into
// the actual Intent batch: one CreateShape per shape, one PutBinding per
// (already-remapped, already-validated-endpoints) binding, and a single
// trailing SetSelection over the clone's ROOT ids only — never the full new
// id set, which would select re-parented children too (D-6: "selection
// after paste/duplicate = the new ROOT ids").
function assembleIntents(clone: { shapes: Shape[]; bindings: Binding[]; rootIds: readonly string[] }): Intent[] {
  return [
    ...clone.shapes.map((shape): Intent => ({ type: 'CreateShape', shape })),
    ...clone.bindings.map((binding): Intent => ({ type: 'PutBinding', binding })),
    { type: 'SetSelection', ids: clone.rootIds },
  ]
}

/** Duplicate (Ctrl+D) the current selection: read editor.get().selection,
 * serialize its full subtree (C1) + internal bindings, clone with fresh ids
 * offset by +DUP_OFFSET (D-5), emit the resulting CreateShape/PutBinding
 * batch plus a SetSelection over the new roots. Empty selection -> []
 * (no-op — nothing to duplicate, no pointless empty commit). */
export function duplicateSelectionIntents(editor: Editor): Intent[] {
  const selection = [...editor.get().selection]
  if (selection.length === 0) return []

  const allShapes = editor.doc.listShapes()
  const allBindings = editor.doc.listBindings()
  const payload = serializeSelection(allShapes, allBindings, selection)

  const clone = cloneWithNewIds(
    { shapes: [...payload.shapes], bindings: [...payload.bindings] },
    (i) => mintShapeId(editor, i),
    (j) => mintBindingId(editor, j),
    editor.pageId,
    { x: DUP_OFFSET, y: DUP_OFFSET },
  )
  return assembleIntents(clone)
}

/** Paste (Ctrl+V) clipboard `text` (untrusted — decodeClipboard, C2, is the
 * security gate): decode -> empty on anything malformed/foreign, never a
 * throw -> clone with fresh ids offset by +DUP_OFFSET from the copied
 * position (D-5's 2b default) -> emit the same CreateShape/PutBinding/
 * SetSelection batch as duplicate. `opts.at` is the cursor-paste seam (D-5)
 * — reserved, unused in 2b (no toggle UI yet; see the plan's judgment call
 * #1). Malformed/foreign text yields [] via decodeClipboard's total-function
 * contract, so a hostile clipboard can never crash or partially-write. */
export function pasteIntents(editor: Editor, text: string, _opts?: { at?: { x: number; y: number } }): Intent[] {
  const decoded = decodeClipboard(text)
  if (decoded.shapes.length === 0) return []

  const clone = cloneWithNewIds(
    decoded,
    (i) => mintShapeId(editor, i),
    (j) => mintBindingId(editor, j),
    editor.pageId,
    { x: DUP_OFFSET, y: DUP_OFFSET },
  )
  return assembleIntents(clone)
}
