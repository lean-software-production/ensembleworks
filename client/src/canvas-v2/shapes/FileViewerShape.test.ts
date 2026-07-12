/**
 * Run: bun src/canvas-v2/shapes/FileViewerShape.test.ts
 *
 * Covers `fileViewerContentFrom` (the props->render-input adapter) plus a
 * renderToStaticMarkup smoke render. `FileViewerShape`'s initial
 * `isPresentingThis` state reads `presentStore.get()` (a plain tldraw
 * `atom`, no DOM dependency) during its first render via a `useState`
 * lazy initializer — safe under static rendering. The scroll-follow
 * postMessage bridge, the peer-presenter gap (see the component's own
 * DROPPED note), and the interaction-mode focus/swallow wiring are DOM/
 * effect-dependent and unproven by this file — G2-golden/H2 E2E territory.
 */
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { makeDocument, type CanvasDocument, type Shape } from '@ensembleworks/canvas-model'
import type { EditorState } from '@ensembleworks/canvas-editor'
import { FileViewerShape, fileViewerContentFrom } from './FileViewerShape.js'

function shapeWithProps(props: Record<string, unknown>): Shape {
  return { id: 'shape:f1', kind: 'file-viewer', parentId: 'page:p', index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props } as Shape
}

// --- fileViewerContentFrom ---
{
  const content = fileViewerContentFrom(shapeWithProps({ w: 720, h: 540, path: 'report.html', title: 'Report', rev: 3 }))
  assert.deepEqual(content, { w: 720, h: 540, path: 'report.html', title: 'Report', rev: 3 })
}
{
  // no explicit title -> falls back to the path (matches the legacy
  // component's `shape.props.title || path || 'file viewer'`).
  const content = fileViewerContentFrom(shapeWithProps({ path: 'notes/plan.md' }))
  assert.equal(content.title, 'notes/plan.md')
  assert.equal(content.rev, 0)
}
{
  // no path either -> falls back to the literal 'file viewer'.
  const content = fileViewerContentFrom(shapeWithProps({}))
  assert.equal(content.path, '')
  assert.equal(content.title, 'file viewer')
}

// --- static-render smoke ---
const shape = shapeWithProps({ w: 720, h: 540, path: 'report.html', title: 'Report', rev: 2 })
const doc: CanvasDocument = makeDocument({ pages: [{ id: 'page:p', name: 'P' }], shapes: [shape], bindings: [] })
const editorState: EditorState = { camera: Object.freeze({ x: 0, y: 0, z: 1 }), selection: new Set<string>(), hover: null, editingId: null }

const html = renderToStaticMarkup(createElement(FileViewerShape, { shape, snapshot: doc, editorState }))
assert.ok(html.includes('data-canvas-v2-shape="file-viewer"'), 'renders the canvas-v2 shape marker')
assert.ok(html.includes('data-interaction-mode="idle"'), 'starts in idle interaction mode')
assert.ok(html.includes('Report'), 'renders the title')
assert.ok(html.includes('/files/report.html?rev=2'), 'the iframe src is built from path + rev, per-segment encoded')

// no path -> the "no file" placeholder, not a broken iframe src.
const noPathShape = shapeWithProps({})
const noPathHtml = renderToStaticMarkup(
  createElement(FileViewerShape, { shape: noPathShape, snapshot: makeDocument({ pages: [{ id: 'page:p', name: 'P' }], shapes: [noPathShape], bindings: [] }), editorState })
)
assert.ok(noPathHtml.includes('no file'), 'renders the no-file placeholder when path is empty')

console.log('ok: FileViewerShape — fileViewerContentFrom + static-render smoke')
// House rule (see canvas-react/src/embed/embed-reconciler.test.ts): explicit
// exit for any test whose import graph can hold the event loop open —
// FileViewerShape -> presentStore -> tldraw's `atom` pulls in the tldraw
// package at module scope, and that import keeps bun alive after the last
// assertion (verified: without this the suite hung here indefinitely).
process.exit(0)
