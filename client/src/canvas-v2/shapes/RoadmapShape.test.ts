/**
 * Run: bun src/canvas-v2/shapes/RoadmapShape.test.ts
 *
 * Covers `roadmapContentFrom` (the props->render-input adapter) plus a
 * renderToStaticMarkup smoke render of the empty state (no `fetch` call
 * fires synchronously during render — it's in a `useEffect`, which never
 * runs under a static render — so this is safe without a `fetch` stub).
 * The drag/filter/status-click interactivity, the live fetch/postOp
 * round-trip, and the interaction-mode focus/swallow wiring are DOM/effect-
 * dependent and unproven by this file — G2-golden/H2 E2E territory, per this
 * unit's plan.
 */
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { makeDocument, type CanvasDocument, type Shape } from '@ensembleworks/canvas-model'
import type { EditorState } from '@ensembleworks/canvas-editor'
import { RoadmapShape, roadmapContentFrom } from './RoadmapShape.js'

function shapeWithProps(props: Record<string, unknown>): Shape {
  return { id: 'shape:r1', kind: 'roadmap', parentId: 'page:p', index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props } as Shape
}

// --- roadmapContentFrom ---
{
  const content = roadmapContentFrom(shapeWithProps({ w: 1400, h: 800, roadmapId: 'q3-plan', rev: 7 }))
  assert.deepEqual(content, { w: 1400, h: 800, roadmapId: 'q3-plan', rev: 7 })
}
{
  const content = roadmapContentFrom(shapeWithProps({}))
  assert.equal(content.roadmapId, 'roadmap')
  assert.equal(content.rev, undefined)
  assert.ok(content.w > 0 && content.h > 0)
}

// --- static-render smoke: empty state (doc still loading — no fetch fires
// under static render, so `doc` stays null and the empty-state branch
// renders) ---
const shape = shapeWithProps({ w: 1280, h: 720, roadmapId: 'q3-plan' })
const doc: CanvasDocument = makeDocument({ pages: [{ id: 'page:p', name: 'P' }], shapes: [shape], bindings: [] })
const editorState: EditorState = { camera: Object.freeze({ x: 0, y: 0, z: 1 }), selection: new Set<string>(), hover: null, editingId: null, nextShapeStyle: {}, currentPageId: 'page:p' }

const html = renderToStaticMarkup(createElement(RoadmapShape, { shape, snapshot: doc, editorState }))
assert.ok(html.includes('data-canvas-v2-shape="roadmap"'), 'renders the canvas-v2 shape marker')
assert.ok(html.includes('data-interaction-mode="idle"'), 'starts in idle interaction mode')
assert.ok(html.includes('q3-plan'), 'falls back to the roadmapId as the header title before the doc loads')
assert.ok(html.includes('No roadmap data yet') || html.includes('loading'), 'renders the empty/loading state (no fetch under static render)')

console.log('ok: RoadmapShape — roadmapContentFrom + static-render smoke (empty state)')
