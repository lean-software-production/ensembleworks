// Run: bun src/text-editor.test.ts
// Component tests use renderToStaticMarkup (no DOM emulator in this house
// rig — see viewport.test.ts's header) with React.createElement, not JSX,
// so this file stays `.test.ts`. ACKNOWLEDGED LIMITATION (same posture as
// viewport.test.ts's and shape-layer.test.ts's own): renderToStaticMarkup
// performs a ONE-SHOT string render and never runs React's event system, so
// no house test can literally "type into" or "press Escape in" the
// rendered textarea. TextEditor.tsx exports its onChange/onKeyDown handlers
// as PURE, callback-invoking functions (`handleTextChange`,
// `handleEditorKeyDown`) for exactly this reason — this file invokes them
// directly with fabricated event-shaped values and a spy callback, proving
// the DECISION logic (which key ends the edit, what gets forwarded) without
// needing a real DOM event to flow through.
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { makeDocument, worldTransform, type CanvasDocument, type Shape } from '@ensembleworks/canvas-model'
import type { Editor, EditorState, ToolContext } from '@ensembleworks/canvas-editor'
import { TextEditor, handleTextChange, handleEditorKeyDown } from './TextEditor.js'

// 'geo' (not 'note') is deliberate: geometry.ts's size() hard-codes note to
// a fixed 200x200 (scale-adjusted) regardless of props.w/h, so a note
// fixture can't pin an asymmetric w/h — 'geo' respects props.w/h directly
// (same choice shape-layer.test.ts's fixtures make, for the same reason).
function geoShape(id: string, x: number, y: number, rotation = 0, w = 200, h = 100): Shape {
  return {
    id, kind: 'geo', parentId: 'page:p', index: 'a1', x, y, rotation,
    isLocked: false, opacity: 1, meta: {}, props: { w, h },
  } as Shape
}

const editingShape = geoShape('shape:editing', 30, 40, Math.PI / 8)
const otherShape = geoShape('shape:other', 500, 500)

const doc: CanvasDocument = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [editingShape, otherShape],
  bindings: [],
})

const texts = new Map<string, string>([['shape:editing', 'hello world']])

// ============================================================================
// FAKE TOOLCONTEXT: same rationale as shape-layer.test.ts's — TextEditor's
// only actual uses of `toolContext` are `.editor` (useEditorState),
// `.snapshot()` (useDocSnapshot), and `.editor.doc.getText` (the doc
// READ-THROUGH — see TextEditor.tsx's module header for why this is not a
// canvas-doc IMPORT). A hand-built fake avoids pulling in
// @ensembleworks/canvas-doc as an undeclared test-only dependency, exactly
// like shape-layer.test.ts's fakeToolContext.
// ============================================================================
function fakeToolContext(editingId: string | null): ToolContext {
  const state: EditorState = Object.freeze({
    camera: Object.freeze({ x: 0, y: 0, z: 1 }),
    selection: new Set<string>(),
    hover: null,
    editingId,
  })
  const editorDoc = {
    subscribe: (_listener: () => void) => () => {},
    getText: (id: string) => texts.get(id) ?? '',
  }
  const editor = {
    doc: editorDoc,
    get: (): EditorState => state,
    subscribe: (_listener: () => void) => () => {},
  } as unknown as Editor
  return {
    editor,
    snapshot: () => doc,
    index: () => { throw new Error('TextEditor must never call toolContext.index()') },
    hitTestTopmost: () => null,
    queryMarquee: () => [],
    dispose: () => {},
  }
}

// ============================================================================
// 1. No editingId -> mounts nothing.
// ============================================================================
{
  const html = renderToStaticMarkup(
    createElement(TextEditor, { toolContext: fakeToolContext(null), onTextChange: () => {}, onEndEdit: () => {} }),
  )
  assert.equal(html, '', 'TextEditor renders nothing when editingId is null')
  console.log('ok: no mount when editingId is null')
}

// ============================================================================
// 2. editingId set but the shape no longer resolves (vanished) -> mounts
//    nothing — same "omit, don't throw" posture as ShapeLayer's staleness
//    handling.
// ============================================================================
{
  const html = renderToStaticMarkup(
    createElement(TextEditor, { toolContext: fakeToolContext('shape:vanished'), onTextChange: () => {}, onEndEdit: () => {} }),
  )
  assert.equal(html, '', 'TextEditor renders nothing when the editing id no longer resolves in the snapshot')
  console.log('ok: no mount for a vanished editingId')
}

// ============================================================================
// 3. Mounts for the editing shape: value reflects doc.getText, positioned
//    and sized by the shape's rigid world transform (hand-computed/cross-
//    checked against worldTransform, reusing the SAME math ShapeBody uses —
//    not re-derived).
// ============================================================================
{
  const toolContext = fakeToolContext('shape:editing')
  const html = renderToStaticMarkup(
    createElement(TextEditor, { toolContext, onTextChange: () => {}, onEndEdit: () => {} }),
  )
  assert.ok(html.includes('hello world'), `textarea value should reflect doc.getText: ${html}`)

  const t = worldTransform(doc, editingShape)
  const expectedTransform = `translate(${t.x}px, ${t.y}px) rotate(${t.rotation}rad)`
  assert.ok(html.includes(expectedTransform), `should be positioned by the shape's rigid world transform: ${html}`)
  assert.ok(html.includes('width:200px') && html.includes('height:100px'), `should be world-sized from localBounds (w=200,h=100): ${html}`)
  console.log('ok: mounts for editingId — value reflects doc text, transform + size match the shape')
}

// ============================================================================
// 4. Callback props: the exported PURE handlers fire onTextChange/onEndEdit
//    correctly when invoked directly — see the file header's ACKNOWLEDGED
//    LIMITATION for why this, not a simulated DOM event, is the exercised
//    path.
// ============================================================================
{
  let changed: [string, string] | null = null
  handleTextChange('shape:editing', 'new text', (id, text) => { changed = [id, text] })
  assert.deepEqual(changed, ['shape:editing', 'new text'], 'handleTextChange forwards (id, text) to onTextChange verbatim')

  let ended = false
  handleEditorKeyDown('Escape', () => { ended = true })
  assert.equal(ended, true, 'Escape should fire onEndEdit')

  ended = false
  handleEditorKeyDown('a', () => { ended = true })
  assert.equal(ended, false, 'a non-Escape key should NOT fire onEndEdit')
  console.log('ok: callback props fire via direct handler invocation')
}

console.log('ok: text-editor (mount gating, controlled value, world-space positioning, callback props)')
