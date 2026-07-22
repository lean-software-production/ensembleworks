/**
 * Run: bun src/canvas-v2/shapes/IframeShape.test.ts
 *
 * Three layers, cheapest first:
 *   1. `iframeContentFrom` — the pure props->render-input adapter.
 *   2. A `renderToStaticMarkup` smoke render — iframe has no heavy import
 *      (no xterm/livekit/identity), so it renders statically cleanly.
 *   3. THE REAL THING: a happy-dom + react-dom/client + StrictMode
 *      reconciler test (same technique as canvas-react's own
 *      embed/embed-reconciler.test.ts) proving THIS unit's OWN wiring —
 *      `registerCanvasV2Shapes()` actually registers 'iframe' as an embed
 *      kind, the real `IframeShape` component registers/unregisters into
 *      `canvasV2EmbedLifecycles` on mount/unmount, and the shape survives a
 *      suspend/resume cycle (DOM stays mounted, hidden, never torn down) —
 *      end-to-end through canvas-react's real `EmbedLayer`/`EmbedHost`. Per
 *      this unit's test strategy, iframe is the chosen representative body
 *      for this one real-reconciler proof (no heavy deps, unlike its five
 *      siblings) — this does NOT re-prove canvas-react's own D8 lifecycle
 *      state machine (embed-reconciler.test.ts already does that
 *      exhaustively); it proves SEAM E's registration plumbing sits on top
 *      of it correctly.
 *
 * DOM GLOBALS BEFORE REACT-DOM (why the dynamic imports below): same
 * reasoning as embed-reconciler.test.ts's identical header — react-dom/client
 * binds to `document` at `createRoot` time, and static `import` hoists above
 * any statement, so happy-dom's window/document must be installed on
 * globalThis FIRST.
 */
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { makeDocument, type CanvasDocument, type Shape } from '@ensembleworks/canvas-model'
import type { EditorState } from '@ensembleworks/canvas-editor'
import { IframeShape, iframeContentFrom } from './IframeShape.js'

function shapeWithProps(props: Record<string, unknown>): Shape {
  return { id: 'shape:i1', kind: 'iframe', parentId: 'page:p', index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props } as Shape
}

// --- iframeContentFrom ---
{
  const content = iframeContentFrom(shapeWithProps({ w: 800, h: 600, url: 'https://example.com', title: 'web view' }))
  assert.deepEqual(content, { w: 800, h: 600, url: 'https://example.com', title: 'web view' })
}
{
  const content = iframeContentFrom(shapeWithProps({}))
  assert.equal(content.url, 'about:blank')
  assert.equal(content.title, 'web view')
  assert.ok(content.w > 0 && content.h > 0)
}

// --- static-render smoke ---
{
  const shape = shapeWithProps({ w: 800, h: 600, url: 'https://example.com', title: 'docs' })
  const doc: CanvasDocument = makeDocument({ pages: [{ id: 'page:p', name: 'P' }], shapes: [shape], bindings: [] })
  const editorState: EditorState = { camera: Object.freeze({ x: 0, y: 0, z: 1 }), selection: new Set<string>(), hover: null, editingId: null, nextShapeStyle: {}, currentPageId: 'page:p' }
  const html = renderToStaticMarkup(createElement(IframeShape, { shape, snapshot: doc, editorState }))
  assert.ok(html.includes('data-canvas-v2-shape="iframe"'), 'renders the canvas-v2 shape marker')
  assert.ok(html.includes('data-interaction-mode="idle"'), 'starts in idle interaction mode')
  assert.ok(html.includes('src="https://example.com"'), 'the iframe src is the shape\'s url')
  assert.ok(html.includes('docs'), 'renders the title')
  console.log('ok: IframeShape — iframeContentFrom + static-render smoke')
}

// ============================================================================
// THE REAL THING — happy-dom + react-dom/client + StrictMode.
// ============================================================================
const { Window } = await import('happy-dom')
const win = new Window()
;(globalThis as any).window = win
;(globalThis as any).document = win.document
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { createElement: h, StrictMode, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { registerCanvasV2Shapes, canvasV2EmbedLifecycles } = await import('./index.js')
const { isEmbedKind, lookupShapeComponent } = await import('@ensembleworks/canvas-react')
const { EmbedLayer } = await import('@ensembleworks/canvas-react')
type ToolContext = import('@ensembleworks/canvas-editor').ToolContext
type Editor = import('@ensembleworks/canvas-editor').Editor

registerCanvasV2Shapes()
assert.equal(isEmbedKind('iframe'), true, 'registerCanvasV2Shapes must register iframe with { embed: true }')
assert.equal(lookupShapeComponent('iframe'), IframeShape, 'registerCanvasV2Shapes must register the REAL IframeShape component, not a stand-in')
assert.equal(isEmbedKind('roadmap'), false, 'roadmap is registered WITHOUT the embed flag — see index.ts module header')

// Spy on the shared registry's register() — records register/unregister
// calls without altering behavior (delegates to the original).
const calls: string[] = []
const originalRegister = canvasV2EmbedLifecycles.register.bind(canvasV2EmbedLifecycles)
;(canvasV2EmbedLifecycles as { register: typeof canvasV2EmbedLifecycles.register }).register = (id, hooks) => {
  calls.push(`register:${id}`)
  const unregister = originalRegister(id, hooks)
  return () => {
    calls.push(`unregister:${id}`)
    unregister()
  }
}

const embedShape = {
  id: 'shape:iframe-live', kind: 'iframe', parentId: 'page:p', index: 'a1',
  x: 10, y: 10, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { w: 100, h: 100, url: 'about:blank', title: 'live' },
} as Shape
const doc = makeDocument({ pages: [{ id: 'page:p', name: 'P' }], shapes: [embedShape], bindings: [] })
const editorState: EditorState = Object.freeze({ camera: Object.freeze({ x: 0, y: 0, z: 1 }), selection: new Set<string>(), hover: null, editingId: null, nextShapeStyle: {}, currentPageId: 'page:p' })

// FAKE TOOLCONTEXT — same rationale as canvas-react's own shape-layer.test.ts
// and embed-reconciler.test.ts: EmbedLayer only ever touches `.editor`
// (-> useEditorState/useDocSnapshot) and `.snapshot()`; `hitTestTopmost`/
// `queryMarquee`/`dispose` are never called by the renderer, and `.index()`
// must never be called by EmbedLayer at all (its own module header says so).
const toolContext = {
  editor: {
    doc: { subscribe: (_l: () => void) => () => {} },
    get: () => editorState,
    subscribe: (_l: () => void) => () => {},
  } as unknown as Editor,
  snapshot: (): CanvasDocument => doc,
  index: () => {
    throw new Error('EmbedLayer must never call toolContext.index()')
  },
  hitTestTopmost: () => null,
  queryMarquee: () => [],
  dispose: () => {},
} as ToolContext

const container = document.createElement('div')
document.body.appendChild(container)
const root = createRoot(container)
const viewportSize = { width: 800, height: 600 }
const onScreen = { x: 0, y: 0, z: 1 } // shape at (10,10) is inside (0,0)-(800,600)
const offScreen = { x: -100_000, y: -100_000, z: 1 } // shape falls well outside the viewport

function render(camera: { x: number; y: number; z: number }, tick: number): void {
  act(() => {
    root.render(
      h(
        StrictMode,
        null,
        h(EmbedLayer, {
          toolContext,
          camera,
          viewportSize,
          tick,
          suspendAfterTicks: 1,
          lifecycleFor: canvasV2EmbedLifecycles.lifecycleFor,
        }),
      ),
    )
  })
}

// Mount: the real IframeShape registers itself (empty hooks — see its
// module header) through canvasV2EmbedLifecycles in its own mount effect.
// StrictMode's simulated remount (mount -> effects -> cleanup -> effects
// again — see canvas-react's embed-reconciler.test.ts for why that pair is
// CORRECT, not a bug) means the register count after this first render is 2,
// not 1 — captured as the baseline rather than hardcoded, since what this
// test cares about is "does suspend/resume touch it AGAIN", not the exact
// StrictMode-inflated count.
render(onScreen, 0)
assert.ok(calls.includes(`register:${embedShape.id}`), `IframeShape must register itself on mount — got ${JSON.stringify(calls)}`)
assert.ok(container.querySelector(`[data-shape-id="${embedShape.id}"]`), 'the shape wrapper is in the DOM')
assert.ok(container.querySelector('[data-canvas-v2-shape="iframe"]'), 'the real IframeShape body is mounted (not a stand-in)')
const registerCountAfterMount = calls.filter((c) => c.startsWith('register:')).length

// Suspend past the threshold — the DOM must stay mounted (hidden), never
// torn down, and the registration must NOT be touched again (no remount).
render(offScreen, 1) // invisibleTicks=1 — at threshold, not past
render(offScreen, 2) // invisibleTicks=2 > 1 — suspends
render(offScreen, 3) // rendered state catches up (STATE LAG — see EmbedHost.tsx)
const wrapper = container.querySelector('[data-embed-state]')
assert.equal(wrapper?.getAttribute('data-embed-state'), 'suspended', 'the wrapper reflects suspended state')
assert.ok(container.querySelector('[data-canvas-v2-shape="iframe"]'), 'the iframe body DOM survives suspension — hidden, never unmounted')
assert.equal(
  calls.filter((c) => c.startsWith('register:')).length,
  registerCountAfterMount,
  'suspend must NOT re-register the body — same mounted instance throughout',
)

// Resume — no remount either.
render(onScreen, 4)
render(onScreen, 5)
assert.equal(container.querySelector('[data-embed-state]')?.getAttribute('data-embed-state'), 'active', 'the wrapper reflects resumed state')
assert.equal(
  calls.filter((c) => c.startsWith('register:')).length,
  registerCountAfterMount,
  'resume must NOT re-register the body either',
)

// Real unmount — the registration's cleanup (unregister) must fire.
act(() => {
  root.unmount()
})
assert.ok(calls.includes(`unregister:${embedShape.id}`), `a real unmount must unregister the body — got ${JSON.stringify(calls)}`)

console.log(`ok: IframeShape — registerCanvasV2Shapes + real IframeShape survive suspend/resume through canvas-react's EmbedLayer/EmbedHost, register/unregister paired (calls: ${JSON.stringify(calls)})`)
process.exit(0) // happy-dom's window can hold timers open — house rule for any test that boots a DOM/browser-ish environment
