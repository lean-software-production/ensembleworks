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
import { TextEditor, createCompositionState, handleCompositionStart, handleCompositionEnd, handleTextChange, handleEditorKeyDown } from './TextEditor.js'
import { registerShape, type ShapeBodyProps } from './shapeRegistry.js'
import { noteStyle } from './shapes/NoteShape.js'
import { textStyle } from './shapes/TextShape.js'
import { geoStyle } from './shapes/GeoShape.js'

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
const embedShape = { ...geoShape('shape:embed', 100, 100), kind: 'terminal' } as Shape

// ============================================================================
// Task C6 fixtures: one shape per text-capable kind (canvas-model's
// isTextCapableKind: note/text/geo), each with NON-DEFAULT styling props so
// a test asserting "the editor matches the body" can't pass by coincidentally
// matching a shared default (props.color/font/size/textAlign all set to
// something other than the DEFAULT_* constants each shape module falls back
// to — see NoteShape.tsx/TextShape.tsx/GeoShape.tsx's own DEFAULT_COLOR/
// DEFAULT_FONT/DEFAULT_SIZE/DEFAULT_ALIGN).
// ============================================================================
function noteShapeFixture(id: string, x: number, y: number): Shape {
  return {
    id, kind: 'note', parentId: 'page:p', index: 'a1', x, y, rotation: 0,
    isLocked: false, opacity: 1, meta: {}, props: { color: 'blue' },
  } as Shape
}
function textShapeFixture(id: string, x: number, y: number): Shape {
  return {
    id, kind: 'text', parentId: 'page:p', index: 'a1', x, y, rotation: 0,
    isLocked: false, opacity: 1, meta: {}, props: { font: 'sans', size: 'xl', color: 'red', textAlign: 'end' },
  } as Shape
}
const editingNoteShape = noteShapeFixture('shape:editing-note', 10, 10)
const editingTextShape = textShapeFixture('shape:editing-text', 20, 20)
const editingGeoShape = geoShape('shape:editing-geo', 30, 30, 0, 150, 90)

const doc: CanvasDocument = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [editingShape, otherShape, embedShape, editingNoteShape, editingTextShape, editingGeoShape],
  bindings: [],
})

const texts = new Map<string, string>([
  ['shape:editing', 'hello world'],
  ['shape:editing-note', 'note text'],
  ['shape:editing-text', 'text shape text'],
  ['shape:editing-geo', 'geo label text'],
])

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
    nextShapeStyle: {},
    currentPageId: 'page:p',
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
  const composition = createCompositionState()
  let changed: [string, string] | null = null
  handleTextChange(composition, 'shape:editing', 'new text', (id, text) => { changed = [id, text] })
  assert.deepEqual(changed, ['shape:editing', 'new text'], 'handleTextChange forwards (id, text) to onTextChange verbatim (outside composition)')

  let ended = false
  handleEditorKeyDown('Escape', () => { ended = true })
  assert.equal(ended, true, 'Escape should fire onEndEdit')

  ended = false
  handleEditorKeyDown('a', () => { ended = true })
  assert.equal(ended, false, 'a non-Escape key should NOT fire onEndEdit')
  console.log('ok: callback props fire via direct handler invocation')
}

// ============================================================================
// 5. IME COMPOSITION (see TextEditor.tsx's header IME section): while a
//    composition session is open, intermediate onChange events must NOT
//    dispatch onTextChange (each dispatch is a whole-string CRDT
//    delete+insert commit — see the LWW section — so per-composition-
//    keystroke commits are pure waste AND ship half-composed text to
//    peers); compositionEnd flushes the FINAL value exactly once.
// ============================================================================
{
  const composition = createCompositionState()
  const dispatched: string[] = []
  const onTextChange = (_id: string, text: string) => { dispatched.push(text) }

  handleCompositionStart(composition)
  handleTextChange(composition, 'shape:editing', 'ｎ', onTextChange) // intermediate — skipped
  handleTextChange(composition, 'shape:editing', 'ｎｉ', onTextChange) // intermediate — skipped
  assert.deepEqual(dispatched, [], 'onChange during composition must not dispatch')

  handleCompositionEnd(composition, 'shape:editing', '日本語', onTextChange)
  assert.deepEqual(dispatched, ['日本語'], 'compositionEnd flushes the final value exactly once')

  handleTextChange(composition, 'shape:editing', '日本語!', onTextChange)
  assert.deepEqual(dispatched, ['日本語', '日本語!'], 'after composition ends, plain changes dispatch again')
  console.log('ok: IME composition — intermediate changes skipped, final value flushed once')
}

// ============================================================================
// 6. EMBED-KIND GUARD: an editingId pointing at an embed-kind shape mounts
//    NOTHING — a future generic BeginEdit trigger must never float a
//    textarea over a live terminal/iframe (see TextEditor.tsx's header).
// ============================================================================
{
  function FakeTerminal(_props: ShapeBodyProps) { return null }
  registerShape('terminal', FakeTerminal, { embed: true })
  const html = renderToStaticMarkup(
    createElement(TextEditor, { toolContext: fakeToolContext('shape:embed'), onTextChange: () => {}, onEndEdit: () => {} }),
  )
  assert.equal(html, '', 'TextEditor must render nothing for an embed-kind editing target')
  console.log('ok: no mount for an embed-kind editingId')
}

// react-dom/server HTML-escapes attribute values, so a `font-family` string
// like "'tldraw_draw', sans-serif" lands in the markup with its quotes
// entity-escaped (`&#x27;`) rather than literal `'` characters — pull out
// just the bare family NAME token for substring checks below so assertions
// aren't sensitive to that escaping.
function fontToken(fontFamily: string): string {
  return fontFamily.match(/'([^']+)'/)?.[1] ?? fontFamily
}

// ============================================================================
// 7. STYLING PARITY (Task C6): editing a note/text/geo shows the SAME font-
//    family/size/color/align its rendered body (NoteShape/TextShape/
//    GeoShape) uses — the editing mount must not "jump" visually vs the rich
//    bodies. Each fixture above uses NON-DEFAULT props so this can't pass by
//    coincidence. Asserted against the body's OWN pure style helper (not
//    hand-copied hex/px values) so this test can't drift from the body it's
//    supposed to match.
// ============================================================================
{
  const noteExpected = noteStyle(editingNoteShape)
  const html = renderToStaticMarkup(
    createElement(TextEditor, { toolContext: fakeToolContext('shape:editing-note'), onTextChange: () => {}, onEndEdit: () => {} }),
  )
  assert.ok(html.includes(fontToken(noteExpected.fontFamily)), `note editor should use the sticky's handwriting font-family: ${html}`)
  assert.ok(html.includes(noteExpected.color), `note editor should use the sticky's label color: ${html}`)
  assert.ok(html.includes('font-size:16px'), 'note editor should match NoteShape\'s fixed 16px label size')
  assert.ok(html.includes('text-align:center'), 'note editor should center like NoteShape\'s label')
  console.log('ok: editing a note matches NoteShape\'s font-family/size/color/align')
}
{
  const textExpected = textStyle(editingTextShape)
  const html = renderToStaticMarkup(
    createElement(TextEditor, { toolContext: fakeToolContext('shape:editing-text'), onTextChange: () => {}, onEndEdit: () => {} }),
  )
  assert.ok(html.includes(fontToken(textExpected.fontFamily)), `text editor should use props.font's family: ${html}`)
  assert.ok(html.includes(textExpected.color), `text editor should use props.color's solid hex: ${html}`)
  assert.ok(html.includes(`font-size:${textExpected.fontSize}px`), `text editor should use props.size's px value: ${html}`)
  assert.ok(html.includes(`text-align:${textExpected.textAlign}`), `text editor should use props.textAlign: ${html}`)
  // Task C6 follow-up (FIX 1): TextShape's body has padding:0, so the text-
  // kind editor must too — a default padding:4 caused a ~4px enter-edit shift.
  assert.ok(html.includes('padding:0'), `text editor should use padding:0 to match TextShape's body (no ~4px shift): ${html}`)
  assert.ok(!html.includes('padding:4px'), `text editor must NOT carry the default padding:4 for a text kind: ${html}`)
  console.log('ok: editing a text shape matches TextShape\'s font-family/size/color/align + padding:0 (no ~4px shift)')
}
{
  const geoExpected = geoStyle(editingGeoShape)
  const html = renderToStaticMarkup(
    createElement(TextEditor, { toolContext: fakeToolContext('shape:editing-geo'), onTextChange: () => {}, onEndEdit: () => {} }),
  )
  assert.ok(html.includes(fontToken(geoExpected.fontFamily)), `geo editor should use the label's font-family: ${html}`)
  assert.ok(html.includes(geoExpected.labelColor), `geo editor should use the label's color (independent labelColor, not stroke color): ${html}`)
  assert.ok(html.includes(`font-size:${geoExpected.fontSize}px`), `geo editor should use the label's size scale: ${html}`)
  assert.ok(html.includes('text-align:center'), 'geo editor should center like GeoShape\'s label')
  console.log('ok: editing a geo shape matches GeoShape\'s label font-family/size/color/align')
}

// ============================================================================
// 8. ENTER INSERTS A NEWLINE, NOT A COMMIT (note/text multi-line editing):
//    handleEditorKeyDown only special-cases Escape — Enter must NOT fire
//    onEndEdit, leaving the browser's native <textarea> newline-insertion
//    behavior to happen unobstructed. A regression here (treating Enter like
//    Escape, or swapping to an <input>) would end editing on every line
//    break instead of inserting one.
// ============================================================================
{
  let ended = false
  handleEditorKeyDown('Enter', () => { ended = true })
  assert.equal(ended, false, 'Enter must NOT fire onEndEdit — it inserts a newline in the underlying <textarea> instead')
  console.log('ok: Enter does not end editing (newline, not commit)')
}

// ============================================================================
// 9. DOUBLE-CLICK-TO-EDIT COVERS ALL THREE TEXT-CAPABLE KINDS: the actual
//    double-click -> BeginEdit trigger lives in canvas-editor's select tool
//    (tools/select.ts), gated generically on canvas-model's isTextCapableKind
//    with NO per-kind branching (proven there, and by its own
//    select.test.ts). What THIS file can prove is the renderer's half of that
//    contract: once editingId names a note/text/geo shape (exactly what a
//    completed BeginEdit produces for any of the three), TextEditor mounts a
//    real editing surface for EVERY one of them, not just the geo kind the
//    rest of this file's fixtures use.
// ============================================================================
{
  for (const id of ['shape:editing-note', 'shape:editing-text', 'shape:editing-geo']) {
    const html = renderToStaticMarkup(
      createElement(TextEditor, { toolContext: fakeToolContext(id), onTextChange: () => {}, onEndEdit: () => {} }),
    )
    assert.ok(html.includes(`data-text-editor-input="${id}"`), `TextEditor should mount an editing surface for ${id}`)
  }
  console.log('ok: TextEditor mounts an editing surface for note/text/geo alike (double-click-to-edit\'s isTextCapableKind gate covers all three)')
}

console.log('ok: text-editor (mount gating, controlled value, world-space positioning, callback props, IME composition, embed guard, per-kind styling parity, Enter-newline, note/text/geo coverage)')
