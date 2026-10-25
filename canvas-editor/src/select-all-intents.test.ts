// Run: bun src/select-all-intents.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import type { Shape } from '@ensembleworks/canvas-model'
import { Editor } from './editor.js'
import { selectAllIntents } from './select-all-intents.js'

const FIXED_NOW = () => 1_700_000_000_000
const FIXED_RANDOM = () => 0.5

const shape = (id: string, parentId: string): Shape =>
  ({
    id, kind: 'geo', parentId, index: 'a1',
    x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: {},
  }) as Shape

function makeEditor(): { doc: LoroCanvasDoc; editor: Editor } {
  const doc = LoroCanvasDoc.create({ peerId: 1n })
  doc.putPage({ id: 'page:p', name: 'P' })
  doc.putPage({ id: 'page:q', name: 'Q' })
  doc.commit()
  const editor = new Editor({ doc, now: FIXED_NOW, random: FIXED_RANDOM, pageId: 'page:p' })
  return { doc, editor }
}

// 1. Selects every TOP-LEVEL shape whose parentId is the CURRENT page --
//    never a shape on a different page.
{
  const { doc, editor } = makeEditor()
  doc.putShape(shape('shape:a', 'page:p'))
  doc.putShape(shape('shape:b', 'page:p'))
  doc.putShape(shape('shape:other-page', 'page:q'))
  doc.commit()
  const intents = selectAllIntents(editor)
  assert.deepEqual(intents, [{ type: 'SetSelection', ids: ['shape:a', 'shape:b'] }])
  console.log('ok: selectAllIntents selects every top-level shape on the CURRENT page only')
}

// 2. A shape nested inside a frame (parentId = the frame's id, not the page)
//    is NOT included -- v2's documented simplification (top-level only).
{
  const { doc, editor } = makeEditor()
  doc.putShape(shape('shape:frame', 'page:p'))
  doc.putShape(shape('shape:child', 'shape:frame'))
  doc.commit()
  const intents = selectAllIntents(editor)
  assert.deepEqual(intents, [{ type: 'SetSelection', ids: ['shape:frame'] }])
  console.log('ok: selectAllIntents selects top-level shapes only, not frame children')
}

// 3. No shapes on the current page -> a SetSelection([]) intent (still
//    emitted, not skipped -- harmless: SetSelection is docMutated:false, so
//    it never touches the undo stack either way).
{
  const { editor } = makeEditor()
  const intents = selectAllIntents(editor)
  assert.deepEqual(intents, [{ type: 'SetSelection', ids: [] }])
  console.log('ok: selectAllIntents on an empty page emits SetSelection([])')
}

console.log('ok: select-all-intents')
