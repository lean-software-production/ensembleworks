/**
 * Run: bun src/canvas-v2/shapes/NekoShape.test.ts
 *
 * NekoShape.tsx calls `peekIdentity()` (client/src/identity.ts) at RENDER
 * time (not module scope), which reads `localStorage` — the in-memory shim
 * below must exist before the component renders (installed before any
 * import here, same pattern as panelLayout.test.ts, so it's in place
 * regardless of import order).
 *
 * Covers: `buildNekoSrc` (pure URL composition) and `nekoContentFrom` (the
 * props->render-input adapter), plus a renderToStaticMarkup smoke render —
 * neko's iframe body has no heavy import (no xterm/livekit, unlike its
 * terminal/screenshare siblings), so it CAN render statically; this proves
 * the component doesn't throw and produces the expected static markup
 * (iframe src, header). It does NOT prove the live WebRTC stream, the
 * mute-enforcement polling, or the embed suspend/resume wiring — those need
 * a real DOM + timers (G2-golden/H2 E2E territory, per this unit's plan).
 */
class MemoryStorage {
  private store = new Map<string, string>()
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value))
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
  clear(): void {
    this.store.clear()
  }
  get length(): number {
    return this.store.size
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null
  }
}
;(globalThis as { localStorage?: Storage }).localStorage ??= new MemoryStorage() as unknown as Storage

import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { makeDocument, type CanvasDocument, type Shape } from '@ensembleworks/canvas-model'
import type { EditorState } from '@ensembleworks/canvas-editor'
import { NEKO_NUDGE_DELAYS_MS, NekoShape, buildNekoSrc, nekoContentFrom } from './NekoShape.js'

// --- buildNekoSrc: pure URL composition ---
assert.equal(
  buildNekoSrc('/shared-browser/', 'Ada Lovelace'),
  '/shared-browser/?usr=Ada%20Lovelace&pwd=neko&embed=1',
  'composes usr/pwd/embed query params onto a base with no existing query'
)
assert.equal(
  buildNekoSrc('/shared-browser/?foo=1', 'bob'),
  '/shared-browser/?foo=1&usr=bob&pwd=neko&embed=1',
  'appends onto an existing query string with & rather than overwriting it'
)

// --- nekoContentFrom: props->render-input adapter ---
function shapeWithProps(props: Record<string, unknown>): Shape {
  return { id: 'shape:n1', kind: 'neko', parentId: 'page:p', index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props } as Shape
}

{
  const content = nekoContentFrom(shapeWithProps({ w: 1200, h: 700, base: '/custom/', title: 'browser' }))
  assert.deepEqual(content, { w: 1200, h: 700, base: '/custom/', title: 'browser' })
}
{
  const content = nekoContentFrom(shapeWithProps({}))
  assert.equal(content.base, '/shared-browser/')
  assert.equal(content.title, 'shared browser')
  assert.ok(content.w > 0 && content.h > 0)
}

// --- layout-nudge schedule (the PURE part of the restored nudge loop) ---
// The nudge itself (dispatching synthetic 'resize' events into the iframe on
// this schedule after load, so neko's player re-measures its container
// across its async mount + a cold WebRTC connect) needs a live iframe —
// that half is coverage-limited to G2-golden/H2 E2E; the schedule values
// are what keeps this port honest against the legacy loop's.
assert.deepEqual([...NEKO_NUDGE_DELAYS_MS], [0, 250, 750, 1500, 3000], 'nudge schedule matches the legacy onFrameLoad loop')

// --- static-render smoke ---
const shape = shapeWithProps({ w: 900, h: 600, base: '/shared-browser/', title: 'shared browser' })
const doc: CanvasDocument = makeDocument({ pages: [{ id: 'page:p', name: 'P' }], shapes: [shape], bindings: [] })
const editorState: EditorState = { camera: Object.freeze({ x: 0, y: 0, z: 1 }), selection: new Set<string>(), hover: null, editingId: null, nextShapeStyle: {}, currentPageId: 'page:p' }

const html = renderToStaticMarkup(createElement(NekoShape, { shape, snapshot: doc, editorState }))
assert.ok(html.includes('data-canvas-v2-shape="neko"'), 'renders the canvas-v2 shape marker')
assert.ok(html.includes('data-interaction-mode="idle"'), 'starts in idle interaction mode (no controller/effects under static render)')
assert.ok(html.includes('shared browser'), 'renders the title')
assert.ok(html.includes('usr=') && html.includes('pwd=neko') && html.includes('embed=1'), 'the iframe src carries the composed neko query params')

console.log('ok: NekoShape — buildNekoSrc + nekoContentFrom + static-render smoke')
