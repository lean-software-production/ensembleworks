// Run: bun src/frame-name-editor.test.ts
// Same renderToStaticMarkup + pure-handler-invocation posture as
// text-editor.test.ts (see that file's header for the full rationale: no
// DOM emulator in this house rig, so onChange/onKeyDown are exercised as
// PURE functions with fabricated event-shaped values).
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { makeDocument, type CanvasDocument, type Shape } from '@ensembleworks/canvas-model'
import type { Editor, EditorState, ToolContext } from '@ensembleworks/canvas-editor'
import { FrameNameEditor, frameNameValue, handleFrameNameKeyDown } from './FrameNameEditor.js'
import { HEADER_HEIGHT } from './shapes/FrameShape.js'

const frameShape = (id: string, name: string | undefined, x = 0, y = 0, w = 300, h = 300): Shape =>
  ({ id, kind: 'frame', parentId: 'page:p', index: 'a1', x, y, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { w, h, name } }) as Shape

const editingFrame = frameShape('shape:frame', 'My Frame', 10, 20)
const unnamedFrame = frameShape('shape:unnamed', undefined)
const otherShape = { ...frameShape('shape:geo', undefined), kind: 'geo' } as Shape

const doc: CanvasDocument = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [editingFrame, unnamedFrame, otherShape],
  bindings: [],
})

function fakeToolContext(editingId: string | null): ToolContext {
  const state: EditorState = Object.freeze({
    camera: Object.freeze({ x: 0, y: 0, z: 1 }),
    selection: new Set<string>(),
    hover: null,
    editingId,
    nextShapeStyle: {},
    currentPageId: 'page:p',
  })
  const editor = {
    doc: { subscribe: (_l: () => void) => () => {}, getText: () => '' },
    get: (): EditorState => state,
    subscribe: (_l: () => void) => () => {},
  } as unknown as Editor
  return {
    editor,
    snapshot: () => doc,
    index: () => { throw new Error('FrameNameEditor must never call toolContext.index()') },
    hitTestTopmost: () => null,
    queryMarquee: () => [],
    dispose: () => {},
  }
}

// ============================================================================
// 1. No editingId -> mounts nothing.
// ============================================================================
{
  const html = renderToStaticMarkup(createElement(FrameNameEditor, { toolContext: fakeToolContext(null), onNameChange: () => {}, onEndEdit: () => {} }))
  assert.equal(html, '', 'FrameNameEditor renders nothing when editingId is null')
  console.log('ok: no mount when editingId is null')
}

// ============================================================================
// 2. editingId points at a vanished shape -> mounts nothing.
// ============================================================================
{
  const html = renderToStaticMarkup(createElement(FrameNameEditor, { toolContext: fakeToolContext('shape:vanished'), onNameChange: () => {}, onEndEdit: () => {} }))
  assert.equal(html, '', 'FrameNameEditor renders nothing when the editing id no longer resolves')
  console.log('ok: no mount when the editing shape vanished')
}

// ============================================================================
// 3. editingId points at a NON-frame shape -> mounts nothing (TextEditor
//    owns every other kind -- this component is frame-only).
// ============================================================================
{
  const html = renderToStaticMarkup(createElement(FrameNameEditor, { toolContext: fakeToolContext('shape:geo'), onNameChange: () => {}, onEndEdit: () => {} }))
  assert.equal(html, '', 'FrameNameEditor renders nothing when the editing shape is not a frame')
  console.log('ok: no mount for a non-frame editing target')
}

// ============================================================================
// 4. editingId points at a frame -> renders an input carrying the frame's
//    real stored name and the header band height.
// ============================================================================
{
  const html = renderToStaticMarkup(createElement(FrameNameEditor, { toolContext: fakeToolContext('shape:frame'), onNameChange: () => {}, onEndEdit: () => {} }))
  assert.match(html, /data-frame-name-editor-id="shape:frame"/, 'renders the editor wrapper for the editing frame')
  assert.match(html, /data-frame-name-editor-input="shape:frame"/, 'renders the name input')
  assert.match(html, /value="My Frame"/, "the input's value is the frame's real stored name")
  assert.match(html, new RegExp(`height:\\s*${HEADER_HEIGHT}px`), 'the input is sized to the header band height')
  console.log('ok: renders a name input for an editing frame, matching its real stored name')
}

// ============================================================================
// 5. An UNNAMED frame's editor value is the EMPTY STRING, not the "Frame"
//    display placeholder FrameShape.tsx's frameLabel shows -- clearing a
//    name must stay possible.
// ============================================================================
{
  const html = renderToStaticMarkup(createElement(FrameNameEditor, { toolContext: fakeToolContext('shape:unnamed'), onNameChange: () => {}, onEndEdit: () => {} }))
  assert.match(html, /value=""/, 'an unnamed frame edits as an empty string, never the "Frame" placeholder')
  assert.equal(frameNameValue({}), '', 'frameNameValue on a props object with no name is empty')
  assert.equal(frameNameValue({ name: 'Kickoff' }), 'Kickoff', 'frameNameValue reads a real stored name verbatim')
  console.log('ok: an unnamed frame edits as an empty string')
}

// ============================================================================
// 6. handleFrameNameKeyDown: Escape and Enter both end the edit (an <input>,
//    unlike TextEditor's <textarea>, has no newline to preserve); every
//    other key is a no-op here (native input handles the keystroke itself).
// ============================================================================
{
  let ended = 0
  handleFrameNameKeyDown('Escape', () => ended++)
  assert.equal(ended, 1, 'Escape ends the edit')
  handleFrameNameKeyDown('Enter', () => ended++)
  assert.equal(ended, 2, 'Enter ends the edit')
  handleFrameNameKeyDown('a', () => ended++)
  assert.equal(ended, 2, 'an ordinary character key is a no-op')
  console.log('ok: handleFrameNameKeyDown ends the edit on Escape/Enter only')
}

console.log('ok: frame-name-editor')
