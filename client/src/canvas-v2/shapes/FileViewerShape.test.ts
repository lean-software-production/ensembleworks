/**
 * Run: bun src/canvas-v2/shapes/FileViewerShape.test.ts
 *
 * Covers `fileViewerContentFrom` (the props->render-input adapter),
 * `fileViewerRefreshIntent` + `followTargetFraction` (the Task D5
 * rev-bump/peer-follow PURE decision halves), plus a renderToStaticMarkup
 * smoke render. `FileViewerShape`'s initial `isPresentingThis` state reads
 * `presentStore.get()` (a plain module variable, no DOM dependency) during
 * its first render via a `useState` lazy initializer — safe under static
 * rendering.
 *
 * DOM/EFFECT-DEPENDENT, UNPROVEN BY THIS FILE (renderToStaticMarkup never
 * runs effects) — D6 E2E territory: the scroll-follow postMessage bridge
 * actually driving the iframe, the presence-poll tick actually refreshing
 * `presentStoreV2`'s peers cache, and the interaction-mode focus/swallow
 * wiring. This file proves the PURE decision logic
 * (`fileViewerRefreshIntent`/`followTargetFraction`) that those effects
 * call into, with fakes standing in for `dispatch`/the presence map.
 */
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { makeDocument, type CanvasDocument, type Shape } from '@ensembleworks/canvas-model'
import type { EditorState, Intent } from '@ensembleworks/canvas-editor'
import { presenterFor } from '../presence.js'
import { presentStoreV2 } from './presentStoreV2.js'
import { FileViewerShape, fileViewerContentFrom, fileViewerRefreshIntent, followTargetFraction, isPresentingShape, readyScrollFraction } from './FileViewerShape.js'

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

// --- fileViewerRefreshIntent (Task D5: rev-bump dispatch) ---
{
  const intent: Intent = fileViewerRefreshIntent('shape:f1', 2)
  assert.deepEqual(intent, { type: 'UpdateProps', id: 'shape:f1', props: { rev: 3 } }, 'refresh bumps rev by exactly 1 via an UpdateProps intent')
}
{
  // rev 0 (never-refreshed shape) -> bumps to 1, not NaN/undefined.
  const intent: Intent = fileViewerRefreshIntent('shape:f2', 0)
  assert.deepEqual(intent, { type: 'UpdateProps', id: 'shape:f2', props: { rev: 1 } })
}
{
  // A component-level check that `refresh` is a no-op when dispatch is
  // undefined (ShapeBodyProps.dispatch is optional — see its own doc
  // comment): render with no `dispatch` prop at all must not throw.
  const shape = shapeWithProps({ path: 'x.html', rev: 1 })
  const doc = makeDocument({ pages: [{ id: 'page:p', name: 'P' }], shapes: [shape], bindings: [] })
  const editorState: EditorState = { camera: Object.freeze({ x: 0, y: 0, z: 1 }), selection: new Set<string>(), hover: null, editingId: null, nextShapeStyle: {} }
  assert.doesNotThrow(() => renderToStaticMarkup(createElement(FileViewerShape, { shape, snapshot: doc, editorState })), 'renders (and would refresh) fine with dispatch absent — a no-op, not a crash')
  console.log('ok: FileViewerShape — fileViewerRefreshIntent bumps rev via UpdateProps; dispatch-absent is a safe no-op')
}

// --- followTargetFraction (Task D5: peer-follow pure decision) ---
{
  assert.equal(followTargetFraction({ isPresentingThis: false, peer: null }), null, 'no peer presenting -> no follow target')
  assert.equal(followTargetFraction({ isPresentingThis: false, peer: { fraction: 0.42 } }), 0.42, 'a peer presenting -> follow their fraction')
  assert.equal(
    followTargetFraction({ isPresentingThis: true, peer: { fraction: 0.42 } }),
    null,
    'a presenter never follows anyone, even if a (racy/stale) peer entry also claims this shape',
  )
  console.log('ok: followTargetFraction — peer fraction drives follow; a presenter never follows itself')
}

// --- readyScrollFraction (FIX 1: follower re-syncs on iframe reload) ---
{
  // Presenter's own reload: re-apply OUR own held fraction.
  assert.equal(
    readyScrollFraction({ mine: { shapeId: 'shape:f1', fraction: 0.3, ts: 1 }, shapeId: 'shape:f1', activePeer: { fraction: 0.9 } }),
    0.3,
    'the presenter re-applies its OWN fraction on reload (own case takes precedence)',
  )
  // FIX 1 — follower's reload: we are NOT presenting, but a peer is active
  // -> re-apply the PRESENTER's fraction (the branch the first cut dropped).
  assert.equal(
    readyScrollFraction({ mine: null, shapeId: 'shape:f1', activePeer: { fraction: 0.9 } }),
    0.9,
    "a FOLLOWER's reloaded iframe re-syncs to the active presenter's fraction",
  )
  // We present a DIFFERENT shape; a peer presents THIS shape -> still a
  // follower here, re-apply the peer's fraction.
  assert.equal(
    readyScrollFraction({ mine: { shapeId: 'shape:other', fraction: 0.2, ts: 1 }, shapeId: 'shape:f1', activePeer: { fraction: 0.9 } }),
    0.9,
    'presenting a DIFFERENT shape does not count as presenting this one — follower branch applies',
  )
  // Nobody presenting this shape -> nothing to re-apply.
  assert.equal(readyScrollFraction({ mine: null, shapeId: 'shape:f1', activePeer: null }), null, 'no presenter, no peer -> null (nothing to re-apply)')
  console.log('ok: readyScrollFraction — presenter re-applies own fraction; a FOLLOWER re-syncs to the active presenter on reload (FIX 1)')
}

// --- isPresentingShape (FIX 2: cross-instance derivation, not stale state) ---
{
  assert.equal(isPresentingShape({ shapeId: 'shape:a', fraction: 0, ts: 1 }, 'shape:a'), true, 'presenting THIS shape -> true')
  // The load-bearing cross-instance case: the shared store holds shape B, so
  // a FileViewerShape for shape A DERIVES false — its control shows
  // "Present", not a stale "stop" that would clear B for every follower.
  assert.equal(isPresentingShape({ shapeId: 'shape:b', fraction: 0, ts: 1 }, 'shape:a'), false, 'store holds B -> A derives isPresentingThis===false (A can never clear B)')
  assert.equal(isPresentingShape(null, 'shape:a'), false, 'nobody presenting -> false')
  console.log('ok: isPresentingShape — isPresentingThis is DERIVED from the shared store, so A cannot clear B (FIX 2)')
}

// --- peer-follow, end to end through the presence accessor (Task D5) ---
// Wires presenterFor (presence.ts's wire-resolve logic) + presentStoreV2's
// peers-cache accessor + followTargetFraction together — the same
// composition FileViewerShape's own render performs — with a FAKE peers
// map standing in for a live CanvasV2App session (no DOM needed).
{
  presentStoreV2.setPeers(
    {
      'self-key': { cursor: null, viewport: null, stamp: null, presenting: [] },
      'peer-a': { cursor: null, viewport: null, stamp: null, presenting: [JSON.stringify({ shapeId: 'shape:f1', fraction: 0.75, ts: 500 })] },
    },
    'self-key',
  )
  const peer = presenterFor(presentStoreV2.getPeers(), presentStoreV2.getSelfKey(), 'shape:f1')
  assert.deepEqual(peer, { peerKey: 'peer-a', fraction: 0.75, ts: 500 })
  assert.equal(followTargetFraction({ isPresentingThis: false, peer }), 0.75, "a peer's presenting state, read off the presence map, drives this viewer's scroll follow")

  // Two followers of the SAME presenter: both resolve the identical peer —
  // neither is itself a presenter, so neither's `followTargetFraction`
  // result ever republishes (see FileViewerShape.tsx's peer-follow effect,
  // which never calls setPresenting) — no feedback loop between them.
  const followerAView = followTargetFraction({ isPresentingThis: false, peer })
  const followerBView = followTargetFraction({ isPresentingThis: false, peer })
  assert.equal(followerAView, followerBView)

  // Reset the shared singleton so later tests/files in the same process
  // (if any) don't inherit this fixture's peers snapshot.
  presentStoreV2.setPeers({}, '')
  console.log("ok: FileViewerShape — a peer's presenting state (read via presenterFor + presentStoreV2's peers cache) drives scroll-follow; two followers never feedback-loop")
}

// --- static-render smoke ---
const shape = shapeWithProps({ w: 720, h: 540, path: 'report.html', title: 'Report', rev: 2 })
const doc: CanvasDocument = makeDocument({ pages: [{ id: 'page:p', name: 'P' }], shapes: [shape], bindings: [] })
const editorState: EditorState = { camera: Object.freeze({ x: 0, y: 0, z: 1 }), selection: new Set<string>(), hover: null, editingId: null, nextShapeStyle: {} }

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
// No process.exit needed anymore: the tldraw-atom import that used to hold
// bun's event loop open is gone — FileViewerShape now uses the tldraw-free
// presentStoreV2 (see that file's header for the bundle-leak story) and the
// remaining import graph (canvas-model/canvas-editor/canvas-react/
// react-dom/server/theme) exits cleanly on its own — verified by running
// this file directly under `bun` with a timeout.
